// hacksgiving-265 gate — spend-intent → vendored mmf-255 envelope →
// verdict; ALLOW → custom-connector → receipt.
// Arc R1 fixes: server-side pricing from trusted catalog (C1/C2),
// never release on unknown outcome — reconcile instead (H1/M6),
// inflight guard (M1), receipt schema validation (M3), bodyLimit
// (M5), timing-safe auth (nit), audit non-fatal (M7).
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { appendFileSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { timingSafeEqual, createHash, createHash as hash } from "node:crypto";

import {
  checkEnvelope,
  insertReserved,
  settleEntry,
  failEntry,
  validateCaps,
} from "./vendor/src/server/lib/agent-wallet/envelope";
import {
  createJsonSpendLedger,
  newSpendId,
  type SpendKind,
} from "./vendor/src/server/lib/agent-wallet/ledger";
import type { EnvelopeDeny } from "./vendor/src/server/lib/agent-wallet/envelope";

// Structurally identical to vendored SpendCaps (registry.ts) —
// re-declared here so server.ts pulls zero runtime imports beyond
// envelope/ledger (registry.ts needs viem at import time).
type SpendCaps = {
  perTxUsd?: number;
  dailyUsd?: number;
  weeklyUsd?: number;
  monthlyUsd?: number;
  maxTxPerHour?: number;
  maxAmountPerHour?: number;
  allowedKinds?: SpendKind[];
};

/* --------------------------------- config --------------------------------- */

const GATE_TOKEN = process.env.GATE_TOKEN ?? "";
const CONN_ID = process.env.CONNECTOR_ID ?? "hS_fQRynTjwAfTNAt5z4lg";
const GATEWAY = `https://api.sprites.dev/v1/gateway/custom_api/${CONN_ID}`;
const SHOP_PATH = process.env.SHOP_PATH ?? "/demo/shop/purchase";
const DATA_DIR = process.env.GATE_DATA_DIR ?? join(process.cwd(), ".data");
const BODY_CAP = 16 * 1024;
const EXEC_TIMEOUT_MS = 15_000;
const MAX_ITEMS = 50;
const MAX_QTY = 10;
const INTENTS_CAP = 500;

interface Mandate {
  mandateId: string;
  subject: string;
  caps: SpendCaps;
  allowedVendors: string[];
}
const mandate: Mandate = JSON.parse(
  readFileSync(join(process.cwd(), "mandate.json"), "utf8"),
);

// trusted catalog — the ONLY price source (arc C2). Shared with shop.ts
// (same trust domain, same process): no client-declared totals anywhere.
interface CatalogItem { sku: string; name: string; priceUsd: number }
const catalog = JSON.parse(
  readFileSync(join(process.cwd(), "catalog.json"), "utf8"),
) as { items: CatalogItem[] };
const priceCents = new Map(
  catalog.items.map((i) => [i.sku, Math.round(i.priceUsd * 100)]),
);

// R2#13: validate the mandate at boot — a mis-edited mandate must fail loud,
// not pick a surprising deny reason at runtime.
try {
  mandate.caps = validateCaps(mandate.caps); // throws on invalid — fail loud at boot
} catch (e) {
  console.error(`FATAL: mandate.caps invalid: ${(e as Error).message}`);
  process.exit(1);
}

const ledger = createJsonSpendLedger(join(DATA_DIR, "spend-ledger.json"));
const auditFile = join(DATA_DIR, "intents.jsonl");
mkdirSync(DATA_DIR, { recursive: true });

/* --------------------------------- helpers -------------------------------- */

// timing-safe bearer compare: hash both sides to fixed length first
const sha = (s: string) => hash("sha256").update(s).digest();
const tokenOk = (header: string | undefined, secret: string) => {
  if (!secret || !header) return false;
  const a = sha(header), b = sha(`Bearer ${secret}`);
  return timingSafeEqual(a, b);
};

interface IntentRec {
  intentId: string;
  wallet: string;
  vendor: string;
  amountUsd: number;
  items?: unknown[];
  verdict: "ALLOW" | "DENY";
  reason?: string;
  deny?: EnvelopeDeny;
  entryId?: string;
  receipt?: unknown;
  inflight?: boolean;
  state: "AUTHORIZED" | "DENIED" | "EXECUTED" | "FAILED";
  ts: number;
}
const intents = new Map<string, IntentRec>();
// audit trail is diagnostic only — never let it break the money path (M7)
const audit = (r: IntentRec) => {
  try { appendFileSync(auditFile, JSON.stringify(r) + "\n"); } catch {}
};
const record = (rec: IntentRec) => {
  intents.set(rec.intentId, rec);
  // M4: evict oldest terminal-state records beyond cap
  if (intents.size > INTENTS_CAP) {
    for (const [id, r] of intents) {
      if (r.state === "DENIED" || r.receipt) intents.delete(id);
      if (intents.size <= INTENTS_CAP) break;
    }
  }
  audit(rec);
};

const DENY_REASON: Record<EnvelopeDeny["cap"], string> = {
  perTx: "PER_TX_CAP_EXCEEDED",
  velocity_tx: "VELOCITY_TX_PER_HOUR_EXCEEDED",
  velocity_amount: "VELOCITY_AMOUNT_PER_HOUR_EXCEEDED",
  daily: "DAILY_CAP_EXCEEDED",
  weekly: "WEEKLY_CAP_EXCEEDED",
  monthly: "MONTHLY_CAP_EXCEEDED",
};

const denyEval = (
  vendor: string, amountUsd: number, reason: string, deny?: EnvelopeDeny,
) => {
  const rec: IntentRec = {
    intentId: `int_${newSpendId().slice(3)}`,
    wallet: mandate.subject, vendor, amountUsd,
    verdict: "DENY", reason, deny, state: "DENIED", ts: Date.now(),
  };
  record(rec);
  return rec;
};

// server-side cart pricing (arc C2): reject anything not in the catalog.
// Returns integer cents or an error string.
function priceCart(items: unknown): { cents: number; lines: { sku: string; qty: number; cents: number }[] } | { error: string } {
  if (!Array.isArray(items) || items.length === 0) return { error: "ITEMS_REQUIRED" };
  if (items.length > MAX_ITEMS) return { error: "TOO_MANY_ITEMS" };
  const lines: { sku: string; qty: number; cents: number }[] = [];
  let cents = 0;
  for (const it of items) {
    const sku = typeof it === "object" && it !== null ? String((it as any).sku ?? "") : "";
    const qty = Number((it as any)?.qty ?? 1);
    const pc = priceCents.get(sku);
    if (!pc) return { error: "UNKNOWN_SKU" };
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) return { error: "BAD_QTY" };
    lines.push({ sku, qty, cents: pc * qty });
    cents += pc * qty;
  }
  if (cents <= 0) return { error: "EMPTY_CART" };
  return { cents, lines };
}

// receipt validation (arc M3): schema + binding to the intent
const validReceipt = (r: any, rec: IntentRec, expectCents: number) =>
  r && typeof r === "object" &&
  typeof r.txId === "string" && /^tx_[a-f0-9]{8,32}$/.test(r.txId) &&
  r.intentId === rec.intentId &&
  r.vendor === rec.vendor &&
  Math.round(Number(r.amountUsd) * 100) === expectCents;

/* ------------------------------- connector -------------------------------- */

async function callShop(path: string, body?: unknown, timeoutMs = EXEC_TIMEOUT_MS) {
  return fetch(`${GATEWAY}${path}`, {
    method: body ? "POST" : "GET",
    headers: { "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
}

// arc H1: outcome unknown → reconcile against the shop instead of guessing.
// Returns the receipt if the purchase actually landed, else null.
async function reconcile(rec: IntentRec, retries = 3): Promise<any | null> {
  for (let i = 0; i < retries; i++) {
    try {
      const r = await callShop(`/demo/shop/receipt/by-intent/${rec.intentId}`, undefined, 8000);
      if (r.ok) {
        const j = await r.json().catch(() => null);
        if (j?.txId) return j;
      }
    } catch {}
    if (i < retries - 1) await new Promise((s) => setTimeout(s, 1500 * (i + 1)));
  }
  return null;
}

/* --------------------------------- service -------------------------------- */

const app = new Hono();

app.get("/healthz", (c) => {
  // provenance: hash of the pinned-shasum file itself, computed at runtime
  // (nit fix: evidence, not assertion)
  let vendorHash = "unavailable";
  try {
    vendorHash = createHash("sha256")
      .update(readFileSync(join(process.cwd(), "vendor-shasum.txt")))
      .digest("hex").slice(0, 16);
  } catch {}
  return c.json({ ok: true, gate: "mmf-255", provenance: "40eb49c1037fb974c2a61dc49153be8278b0020f", vendorShasumFileHash: vendorHash });
});

app.use("*", async (c, next) => {
  if (c.req.path === "/healthz" || c.req.path.startsWith("/demo/shop"))
    return next();
  if (!tokenOk(c.req.header("authorization"), GATE_TOKEN))
    return c.json({ error: "UNAUTHORIZED" }, 401);
  return next();
});

// M5: reject oversized bodies before buffering (both endpoints)
app.use("/eval", bodyLimit({ maxSize: BODY_CAP, onError: (c) => c.json({ error: "REQUEST_TOO_LARGE" }, 413) }));
app.use("/execute", bodyLimit({ maxSize: BODY_CAP, onError: (c) => c.json({ error: "REQUEST_TOO_LARGE" }, 413) }));

app.get("/mandate", (c) => c.json(mandate));
app.get("/audit", async (c) =>
  c.json({ intents: [...intents.values()].slice(-100), ledger: await ledger.listByWallet(mandate.subject) }));

app.post("/eval", async (c) => {
  let body: { intent?: { vendor?: unknown; amountUsd?: unknown; items?: unknown } };
  try {
    body = await c.req.json();
  } catch {
    return c.json(denyEval("?", 0, "MALFORMED_REQUEST"), 400);
  }
  const intent = body?.intent;
  const vendor = typeof intent?.vendor === "string" ? intent.vendor : "";
  if (!vendor) return c.json(denyEval("", 0, "MALFORMED_REQUEST"), 400);
  if (!mandate.allowedVendors.includes(vendor))
    return c.json(denyEval(vendor, 0, "UNKNOWN_VENDOR"), 400);

  // C2: price the cart server-side; client amountUsd is never accepted.
  const priced = priceCart(intent?.items);
  if ("error" in priced)
    return c.json(denyEval(vendor, 0, priced.error === "UNKNOWN_SKU" ? "UNKNOWN_SKU" : "MALFORMED_REQUEST"), 400);
  const amountUsd = priced.cents / 100;

  // REAL gate eval — vendored mmf-255 checkEnvelope, byte-identical.
  const v = await checkEnvelope(ledger, mandate.caps, mandate.subject as `0x${string}`, amountUsd);
  if (!v.allow)
    return c.json(denyEval(vendor, amountUsd, DENY_REASON[v.deny.cap], v.deny));

  const rec: IntentRec = {
    intentId: `int_${newSpendId().slice(3)}`,
    wallet: mandate.subject, vendor, amountUsd, items: priced.lines,
    verdict: "ALLOW", state: "AUTHORIZED", ts: Date.now(),
  };
  record(rec);
  return c.json(rec);
});

app.post("/execute", async (c) => {
  let body: { intentId?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ executed: false, error: "MALFORMED_REQUEST" }, 400);
  }
  const rec = body.intentId ? intents.get(body.intentId) : undefined;
  if (!rec) return c.json({ executed: false, error: "UNKNOWN_INTENT" }, 404);
  if (rec.verdict !== "ALLOW" || rec.state === "DENIED")
    return c.json({ executed: false, error: "INTENT_NOT_AUTHORIZED", verdict: rec.verdict }, 403);
  if (rec.receipt) // settlement-level dedup: one intent executes once
    return c.json({ executed: true, duplicate: true, receipt: rec.receipt, state: rec.state });
  // M1: in-flight guard — concurrent execute of the same intent → 409
  if (rec.inflight)
    return c.json({ executed: false, error: "EXECUTION_IN_FLIGHT" }, 409);
  rec.inflight = true;

  const finish = (payload: object, status = 200) => {
    rec.inflight = false;
    return c.json(payload, status as any);
  };

  // reserve cap space (check-then-hold, real envelope.reserve path)
  const res = await checkEnvelope(ledger, mandate.caps, rec.wallet as `0x${string}`, rec.amountUsd);
  if (!res.allow) {
    // M1: never downgrade a record that already produced a receipt
    if (!rec.receipt) {
      rec.verdict = "DENY"; rec.reason = DENY_REASON[res.deny.cap]; rec.deny = res.deny;
      rec.state = "DENIED"; audit(rec);
    }
    return finish({ executed: false, verdict: "DENY", reason: DENY_REASON[res.deny.cap], deny: res.deny });
  }
  // R2#1: on retry after OUTCOME_UNKNOWN, reuse the existing open reservation
  // instead of stacking a duplicate (phantom cap-lock). The first attempt's
  // outcome is what needs reconciling.
  let entry: { id: string };
  if (rec.entryId) {
    const existing = (await ledger.listByWallet(rec.wallet as `0x${string}`)).find((x) => x.id === rec.entryId);
    if (existing && existing.state === "reserved") {
      entry = { id: existing.id };
    } else {
      return finish({ executed: false, error: "OUTCOME_UNKNOWN",
        detail: "prior reservation resolved unexpectedly; reconcile via /audit",
        entryId: rec.entryId }, 502);
    }
  } else {
    entry = await insertReserved(ledger, rec.wallet as `0x${string}`, rec.amountUsd, "buy-gateway", rec.intentId);
    rec.entryId = entry.id;
  }
  rec.state = "EXECUTED"; audit(rec); // AUTHORIZED → EXECUTED (pre-settlement)

  const expectCents = Math.round(rec.amountUsd * 100);
  let rawReceipt: any = null;
  let indeterminate = false;
  try {
    const resp = await callShop(SHOP_PATH, {
      intentId: rec.intentId, vendor: rec.vendor,
      amountUsd: rec.amountUsd, items: rec.items ?? [],
    });
    rawReceipt = await resp.json().catch(() => null);
    if (!resp.ok) indeterminate = true; // non-2xx: shop may still have committed
    else if (!validReceipt(rawReceipt, rec, expectCents)) {
      // definitive fail only if the receipt is absent entirely; a malformed
      // or mismatched one is indeterminate — money may have moved (H1/M3)
      indeterminate = true;
    }
  } catch {
    indeterminate = true; // timeout/network: outcome unknown
  }

  if (!indeterminate && validReceipt(rawReceipt, rec, expectCents)) {
    await settleEntry(ledger, entry.id, rawReceipt.txId as `0x${string}`);
    // M3: whitelist response fields
    rec.receipt = {
      txId: rawReceipt.txId, intentId: rec.intentId, vendor: rec.vendor,
      amountUsd: rec.amountUsd, balanceAfterUsd: rawReceipt.balanceAfterUsd, ts: rawReceipt.ts,
    };
    rec.state = "EXECUTED"; audit(rec); // → RECEIPTED
    return finish({ executed: true, receipt: rec.receipt, state: "RECEIPTED", entryId: entry.id });
  }

  // H1: indeterminate → reconcile, never release on a guess
  const found = await reconcile(rec);
  if (found && validReceipt(found, rec, expectCents)) {
    await settleEntry(ledger, entry.id, found.txId as `0x${string}`);
    rec.receipt = {
      txId: found.txId, intentId: rec.intentId, vendor: rec.vendor,
      amountUsd: rec.amountUsd, balanceAfterUsd: found.balanceAfterUsd, ts: found.ts,
    };
    rec.state = "EXECUTED"; audit(rec);
    return finish({ executed: true, receipt: rec.receipt, state: "RECEIPTED", entryId: entry.id, reconciled: true });
  }

  // stays `reserved` — cap space held until a definitive answer exists.
  // startup reconcile (M6) retries on the next boot.
  rec.state = "FAILED"; audit(rec);
  return finish({
    executed: false, error: "OUTCOME_UNKNOWN",
    detail: "connector outcome indeterminate; reservation held pending reconciliation",
    entryId: entry.id,
  }, 502);
});

// M6: startup reconciliation — any stranded `reserved` entries get probed
// against the shop before we start serving.
async function startupReconcile() {
  try {
    const entries = await ledger.listByWallet(mandate.subject as `0x${string}`);
    for (const e of entries.filter((x) => x.state === "reserved")) {
      const probe = { intentId: e.refId, vendor: "agentbadge-shop", amountUsd: e.amountUsd } as IntentRec;
      const found = await reconcile(probe, 1);
      // R2#4: same validation as the execute path — the whole point of
      // validReceipt is not trusting the connector/shop blindly.
      const expectCents = Math.round(e.amountUsd * 100);
      if (found && validReceipt(found, probe, expectCents))
        await settleEntry(ledger, e.id, found.txId as `0x${string}`);
    }
  } catch {}
}

import { shop } from "./shop";
app.route("/demo/shop", shop); // own Bearer-key auth (connector api_key)

// R2#2: re-probe stranded reservations periodically — a shop that is briefly
// down at boot no longer strands them for the whole window. Release policy is
// unchanged: never on a guess (H1); only a validated receipt settles.
startupReconcile().then(() =>
  console.log(`gate ready; mandate ${JSON.stringify(mandate.caps)}`));
setInterval(() => startupReconcile().catch(() => {}), 5 * 60 * 1000).unref();

export default { port: Number(process.env.PORT ?? 8080), fetch: app.fetch };
