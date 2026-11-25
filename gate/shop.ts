// demo shop — same process/URL as the gate (topology: one public endpoint,
// /demo/shop/*). Auth = connector-injected Bearer api_key. Arc R1 fixes:
// server-side pricing (C2/M2), balance check (M2), by-intent reconciliation
// endpoint (H1), atomic writes (H2), proto-safe maps (nit).
import { Hono } from "hono";
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { timingSafeEqual, createHash, createHash as hash } from "node:crypto";

const SHOP_KEY = process.env.SHOP_API_KEY ?? "";
const DATA_DIR = process.env.GATE_DATA_DIR ?? join(process.cwd(), ".data");
const DB = join(DATA_DIR, "shop.json");
const MAX_PURCHASE_CENTS = 5000; // $50 defense-in-depth ceiling per purchase

// canonical catalog — same file the gate prices from
const catalog = JSON.parse(
  readFileSync(join(process.cwd(), "catalog.json"), "utf8"),
) as { items: { sku: string; name: string; priceUsd: number }[] };
const priceCents = new Map(
  catalog.items.map((i) => [i.sku, Math.round(i.priceUsd * 100)]),
);

interface Receipt {
  txId: string;
  intentId: string;
  vendor: string;
  amountUsd: number;
  items: unknown[];
  balanceAfterUsd: number;
  ts: number;
}
interface ShopState {
  balanceUsd: number;
  receipts: Record<string, Receipt>;
  byIntent: Record<string, string>;
  spentTotalUsd: number;
}

// H2: corrupt state fails CLOSED (throw → 500s), never silently resets.
function load(): ShopState {
  if (!existsSync(DB))
    return { balanceUsd: 500, receipts: Object.create(null), byIntent: Object.create(null), spentTotalUsd: 0 };
  const raw = readFileSync(DB, "utf8");
  try {
    const s = JSON.parse(raw);
    if (typeof s.balanceUsd !== "number") throw new Error("bad shape");
    s.receipts ??= Object.create(null);
    s.byIntent ??= Object.create(null);
    return s;
  } catch (e) {
    throw new Error(`shop state corrupt (${(e as Error).message}) — refusing to serve with reset budget`);
  }
}

// H2: atomic write — tmp + rename, never a torn truncate-write.
function save(s: ShopState) {
  mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${DB}.tmp`;
  writeFileSync(tmp, JSON.stringify(s));
  renameSync(tmp, DB);
}

const sha = (s: string) => hash("sha256").update(s).digest();
const keyOk = (header: string | undefined) => {
  if (!SHOP_KEY || !header) return false;
  return timingSafeEqual(sha(header), sha(`Bearer ${SHOP_KEY}`));
};

export const shop = new Hono();

shop.use("*", async (c, next) => {
  if (!keyOk(c.req.header("authorization")))
    return c.json({ error: "UNAUTHORIZED" }, 401);
  return next();
});

shop.get("/catalog", (c) => c.json(catalog));
shop.get("/balance", (c) => {
  const s = load();
  return c.json({ balanceUsd: s.balanceUsd, spentTotalUsd: s.spentTotalUsd, currency: "demo-credit" });
});

// arc H1: reconciliation oracle — definitive answer about whether an
// intent's purchase landed. Used by the gate instead of guessing.
shop.get("/receipt/by-intent/:intentId", (c) => {
  const s = load();
  const txId = s.byIntent[c.req.param("intentId")];
  if (!txId) return c.json({ error: "NO_SUCH_INTENT" }, 404);
  return c.json(s.receipts[txId]);
});
shop.get("/receipt/:txId", (c) => {
  const r = load().receipts[c.req.param("txId")];
  return r ? c.json(r) : c.json({ error: "UNKNOWN_TX" }, 404);
});

shop.post("/purchase", async (c) => {
  let body: { intentId?: string; vendor?: string; amountUsd?: number; items?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "MALFORMED" }, 400);
  }
  if (!body.intentId || typeof body.intentId !== "string" || body.intentId.length > 128)
    return c.json({ error: "INTENT_ID_REQUIRED" }, 400);

  const state = load();
  // settlement-level dedup: same intentId → same receipt, no double debit
  const existingTx = Object.prototype.hasOwnProperty.call(state.byIntent, body.intentId)
    ? state.byIntent[body.intentId] : undefined;
  if (existingTx)
    return c.json({ ...state.receipts[existingTx], duplicateSettlement: true });

  // C2/M2: the shop prices the cart itself from the trusted catalog and
  // requires it to match the claimed amount. The gate is trusted, but
  // defense in depth means the shop never takes a total on faith.
  if (!Array.isArray(body.items) || body.items.length === 0 || body.items.length > 50)
    return c.json({ error: "ITEMS_REQUIRED" }, 400);
  let cents = 0;
  const lines: { sku: string; qty: number; cents: number }[] = [];
  for (const it of body.items as any[]) {
    const sku = String(it?.sku ?? "");
    const qty = Number(it?.qty ?? 1);
    const pc = priceCents.get(sku);
    if (!pc) return c.json({ error: "UNKNOWN_SKU" }, 400);
    if (!Number.isInteger(qty) || qty < 1 || qty > 10) return c.json({ error: "BAD_QTY" }, 400);
    lines.push({ sku, qty, cents: pc * qty });
    cents += pc * qty;
  }
  const claimedCents = Math.round(Number(body.amountUsd) * 100);
  if (claimedCents !== cents)
    return c.json({ error: "PRICE_MISMATCH", computedUsd: cents / 100 }, 400);
  if (cents <= 0 || cents > MAX_PURCHASE_CENTS)
    return c.json({ error: "AMOUNT_OUT_OF_RANGE" }, 400);

  const amountUsd = cents / 100;
  // M2: balance check — never debit into negative
  if (state.balanceUsd < amountUsd)
    return c.json({ error: "INSUFFICIENT_BALANCE", balanceUsd: state.balanceUsd }, 409);

  state.balanceUsd = Math.round((state.balanceUsd - amountUsd) * 100) / 100;
  state.spentTotalUsd = Math.round((state.spentTotalUsd + amountUsd) * 100) / 100;
  const receipt: Receipt = {
    txId: `tx_${createHash("sha256").update(body.intentId).digest("hex").slice(0, 16)}`,
    intentId: body.intentId,
    vendor: String(body.vendor ?? "agentbadge-shop"),
    amountUsd,
    items: lines,
    balanceAfterUsd: state.balanceUsd,
    ts: Date.now(),
  };
  state.receipts[receipt.txId] = receipt;
  state.byIntent[body.intentId] = receipt.txId;
  save(state);
  return c.json(receipt);
});
