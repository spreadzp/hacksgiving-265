#!/usr/bin/env bun
// agent — the Thanksgiving shopper loop. The brain is pluggable:
//   AGENT_BRAIN=ollama (default; local model inside the sprite)
//   AGENT_BRAIN=claude|codex (stock CLI, if a key is present)
// Deterministic parts (arithmetic, gate calls, retries) live here;
// the LLM only picks carts and replans — real choices, real DENY.
import { readFileSync } from "node:fs";
import { execFileSync, execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const CLIENT = `${HERE}gate-client.sh`;
const MODEL = process.env.OLLAMA_MODEL ?? "llama3.2:3b";
const BRAIN = process.env.AGENT_BRAIN ?? "ollama";
const MAX_ROUNDS = 5;

/* ------------------------------- brain -------------------------------- */

async function brain(prompt: string, json = true): Promise<string> {
  if (BRAIN === "ollama") {
    const r = await fetch("http://localhost:11434/api/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: MODEL, prompt, stream: false,
        ...(json ? { format: "json" } : {}),
        options: { temperature: 0.2, num_predict: 300 },
      }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!r.ok) throw new Error(`ollama ${r.status}`);
    return ((await r.json()) as { response: string }).response;
  }
  // stock-CLI path — used only when a key is present (AGENT_BRAIN env)
  const cmd = BRAIN === "claude" ? `claude -p` : `codex exec -`;
  const out = execSync(cmd, {
    input: prompt, encoding: "utf8", timeout: 180_000,
    env: { ...process.env }, stdio: ["pipe", "pipe", "pipe"],
  });
  return out;
}

const extractJson = (s: string): any => {
  const m = s.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("brain: no JSON in reply");
  return JSON.parse(m[0]);
};

/* ------------------------------- gate --------------------------------- */

const sh = (...args: string[]) =>
  execFileSync("bash", [CLIENT, ...args], { encoding: "utf8" });
const shMaybe = (...args: string[]) => {
  try { return { ok: true, out: sh(...args) }; }
  catch (e: any) { return { ok: false, out: e.stdout ?? String(e) }; }
};

/* -------------------------------- task --------------------------------- */

const task = readFileSync(`${HERE}task.md`, "utf8");
const mandate = JSON.parse(sh("mandate"));
const catalog = JSON.parse(readFileSync(`${HERE}catalog.json`, "utf8"));
const budget: number = mandate.caps.dailyUsd;
// 1B models emit "Turkey" / "Pumpkin Pie" — normalize name or sku → sku
const norm = (s: string) => String(s).toLowerCase().replace(/[^a-z0-9]/g, "");
const skuOf = (k: string) =>
  catalog.items.find((i: any) => norm(i.sku) === norm(k) || norm(i.name) === norm(k))?.sku;
const price = (sku: string) => catalog.items.find((i: any) => i.sku === sku)?.priceUsd;
const cartTotal = (skus: string[]) =>
  Math.round(skus.reduce((s, k) => s + (price(k) ?? 0), 0) * 100) / 100;
const itemsJson = (skus: string[]) =>
  JSON.stringify(skus.map((k) => ({ sku: k, qty: 1 })));

console.log(`== agent start ==  brain=${BRAIN} model=${MODEL} budget=$${budget}`);
console.log(`mandate: ${JSON.stringify(mandate.caps)} vendors=${mandate.allowedVendors}`);

let denied: { reason: string; used?: number; limit?: number } | null = null;
let lastCart: string[] = [];

for (let round = 1; round <= MAX_ROUNDS; round++) {
  const remaining = denied ? (denied.limit ?? budget) - (denied.used ?? 0) : budget;
  const over = Math.round((cartTotal(lastCart) - remaining) * 100) / 100;
  const prompt = denied
    ? `${task}\nCatalog: ${JSON.stringify(catalog.items)}\nYour cart ${JSON.stringify(lastCart)} costs $${cartTotal(lastCart)} but only $${remaining} remains of the $${denied.limit} daily budget — it is $${over} OVER budget and was DENIED (${denied.reason}). You MUST remove items until the sum of priceUsd is at most $${remaining}. Example: if remaining is $${remaining}, a valid cart sums to $${remaining} or less. Reply JSON only, lowercase skus, with the sum in "total": {"items":["sku",...],"total":${Math.max(1, Math.floor(remaining))}}`
    : `${task}\nCatalog: ${JSON.stringify(catalog.items)}\nDaily budget: $${budget}. Pick the items to buy. Reply JSON only, using the lowercase sku values, with the sum of priceUsd in "total": {"items":["turkey","gravy"],"total":9}`;

  console.log(`\n-- round ${round} -- brain thinking…`);
  let reply: string;
  try {
    reply = await brain(prompt);
  } catch (e) {
    console.log(`brain error (timeout/unreachable): ${String(e).slice(0, 120)} — retrying`);
    continue;
  }
  let skus: string[];
  try {
    const j = extractJson(reply);
    const rawItems: any[] = j.items ?? j.cart ?? [];
    // model may emit ["turkey",...] or [{"sku":"turkey",...}] — take both
    skus = [...new Set(rawItems
      .map((it) => skuOf(typeof it === "string" ? it : it?.sku ?? it?.name ?? ""))
      .filter(Boolean) as string[])];
  } catch (e) {
    console.log(`brain returned unparseable: ${reply.slice(0, 160)}`);
    continue;
  }
  if (!skus.length) {
    if (denied) {
      console.log(`brain: nothing affordable within remaining $${remaining} — stopping (honest outcome: budget exhausted)`);
      break;
    }
    console.log("empty cart, retrying");
    continue;
  }
  lastCart = skus;
  const total = cartTotal(skus);
  console.log(`cart: ${skus.join(", ")} = $${total}`);

  const res = shMaybe("buy", String(total), itemsJson(skus));
  console.log(res.out.trim());
  const parsed = (() => { try { return JSON.parse(res.out); } catch { return null; } })();

  if (parsed?.verdict === "DENY") {
    denied = { reason: parsed.reason, used: parsed.deny?.used, limit: parsed.deny?.limit };
    console.log(`gate: DENY ${parsed.reason} (used=$${denied.used}/limit=$${denied.limit}) — replanning…`);
    continue;
  }
  if (parsed?.executed && parsed?.receipt) {
    console.log(`\n== PURCHASED == tx=${parsed.receipt.txId} amount=$${parsed.receipt.amountUsd} shopBalance=$${parsed.receipt.balanceAfterUsd}`);
    break;
  }
  console.log("unexpected gate reply — aborting");
  process.exit(2);
}

console.log("\n== audit trail ==");
console.log(sh("audit"));
