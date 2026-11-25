# hacksgiving-265 — the agent that can't overspend

Fly.io Hacksgiving submission: a spend-capable AI agent on a Sprite whose
every purchase must pass a **mandate gate** running byte-identical
production spend-enforcement code (vendored `mmf-255`, see
[gate/PROVENANCE.md](gate/PROVENANCE.md)).

```
agent (Sprite, label:agent)
  → POST /eval {vendor, items:[{sku,qty}]}  → ALLOW | DENY + reason
  → POST /execute {intentId}                → connector gateway → shop → receipt
gate+shop (Sprite, label:gate)
  → connector `custom_api` (access_policy: sprite_labels:["gate"])
  → /demo/shop/* requires the connector-held api_key (agent→shop = 401)
```

Why the agent cannot overspend: it holds no shop credential (401), and it
cannot call the connector itself (deny-by-default label policy → 403).
The only spend path is `eval → execute` inside the gate. The gate prices
the cart **server-side from a trusted catalog** (client-declared amounts
are ignored — arc R1 C1/C2), reserves cap space in the persisted ledger
before touching the shop, never releases a reservation on an unknown
outcome (it reconciles against shop receipts instead — arc R1 H1), and
fails closed on a corrupt or missing ledger (atomic writes — arc R1 H2).
Cap: **$10 per rolling 24h window**, not calendar day.

Single-tenant demo: one GATE_TOKEN, one subject wallet, one shared budget.

## Layout

- `gate/server.ts` — Hono service: `/eval`, `/execute`, `/audit`, `/mandate`, `/healthz`
- `gate/shop.ts` — `/demo/shop/*`: catalog, purchase (server-priced,
  intentId-deduped, balance-checked), receipts, by-intent reconciliation
- `gate/catalog.json` — canonical trusted price list shared by gate+shop
- `gate/mandate.json` — the demo mandate: `dailyUsd: 10` per rolling 24h
  (equals the real funds at risk when wired to real money; the demo shop
  itself denominates in demo-credit), vendor allowlist
- `gate/vendor/` — snapshot of `agentbadge@40eb49c` (mmf-255);
  `vendor-shasum.txt` pins all 68 upstream files — **67/68 byte-identical
  + 1 disclosed delta** (`ledger.ts` arc-audit H2 fix, see PROVENANCE.md)
- `gate/shims/` — build-time shims for workspace-package imports

## Run

```sh
cd gate && bun install
GATE_TOKEN=… SHOP_API_KEY=… bun server.ts   # :8080
bunx vitest run vendor/tests/conformance/mmf/   # 43 vectors
```

## Verify it yourself

```sh
git clone <this repo> && cd hacksgiving-265/gate && bun install
bash ../scripts/verify.sh     # 20 checks, ~1 min, no sprite account needed
```

`verify.sh` checks vendored-code byte integrity (59/62 byte-identical to
`agentbadge@40eb49c` + exactly the 3 disclosed arc-audit-H2 delta files),
runs the conformance suite (43/43), boots the gate locally and probes the
behavioral claims: server-side pricing, spoofing resistance, auth
boundaries, body limits, corrupt-ledger fail-closed. The live execute path
(gate → connector → real receipt) is verified in
[evidence/demo-results.json](evidence/demo-results.json) — it cannot run
offline *by construction*, because needing the sprite identity to spend
is the security claim.

## Honest semantics (what the cap does and does not promise)

- `eval` is not idempotent: asking twice creates two intents. Both draw
  from the **same rolling-24h budget** — the cap is the invariant.
- `execute` of one intentId is deduplicated: replay returns the same
  receipt, the shop debits once.
- While the gate process is down, **no purchase is possible at all**
  (fail-closed). The ledger survives restarts; corrupt ledger state
  fails closed (500s) instead of silently resetting the budget.
- adversarial probe results (spoofing, bypass attempts, replay, kill
  test): [evidence/demo-results.json](evidence/demo-results.json) —
  11/11 adversarial cases resisted.
