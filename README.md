# hacksgiving-265 — the agent that can't overspend

> Fly.io Hacksgiving submission: a spend-capable AI agent on a Sprite whose
> every purchase must pass a **mandate gate** running byte-verified
> production spend-enforcement code. The budget is enforced by
> infrastructure, not by prompts.

**[▶ Demo video (1:44)](https://youtu.be/B0BtgH6Lvko)** — full DENY→replan→ALLOW arc, adversarial probes, kill-test

**Live demo artifacts:** [evidence/demo-results.json](evidence/demo-results.json) ·
[gate/PROVENANCE.md](gate/PROVENANCE.md) · adversarial probe **11/11 resisted** ·
conformance **43/43** · independent arc-audit: 2C/2H/8M found → **all fixed before recording**

---

## Contents

- [Why this exists](#why-this-exists)
- [Architecture](#architecture)
- [The spend path](#the-spend-path)
- [What happens when the agent cheats](#what-happens-when-the-agent-cheats)
- [Verify it yourself](#verify-it-yourself)
- [Honest semantics](#honest-semantics-what-the-cap-does-and-does-not-promise)
- [The audit story](#the-audit-story)
- [Repository layout](#repository-layout)
- [Development](#development)

## Why this exists

LLM agents can call APIs — which means they can spend money. The standard
answer is "prompt the agent to be careful." That is not a control: prompts
are suggestions, models hallucinate, and a sufficiently confused or
adversarial agent will eventually try the thing you asked it not to.

This demo shows the other answer: **make overspending physically impossible**.
The agent never holds a spend credential. The shop's API key lives inside a
Fly connector that only accepts calls from the gate sprite (enforced by Fly's
own label policy). The gate prices every cart itself, from its own catalog,
and decides from a persisted ledger that survives restarts, crashes, and
the agent's best ideas.

The enforcement code is not a toy written for the hackathon: it is a
byte-verified vendored snapshot of the production `mmf-255` spend-enforcement
module, pinned by sha256 (see [gate/PROVENANCE.md](gate/PROVENANCE.md)).

## Architecture

```mermaid
flowchart TB
    subgraph AGENT["Sprite: hack-agent — label: agent"]
        brain["LLM brain<br/>ollama llama3.2:3b"]
        harness["agent.ts loop<br/>cart → eval → replan"]
        client["gate-client.sh<br/>the ONLY spend path"]
        brain --> harness --> client
    end

    subgraph GATE["Sprite: hack-gate — label: gate"]
        direction TB
        gw["gate server.ts<br/>/eval /execute /audit"]
        envchk["vendored mmf-255<br/>checkEnvelope · reserve · settle"]
        ledger[("spend ledger<br/>.data/spend-ledger.json<br/>atomic writes")]
        shop["demo shop /demo/shop/*<br/>server-side pricing · dedup"]
        gw --> envchk --> ledger
        gw --> shop
    end

    subgraph FLY["Fly.io infrastructure"]
        conn["connector custom_api<br/>access_policy: sprite_labels = [gate]<br/>injects shop api_key as Bearer"]
    end

    client -->|"POST /eval · /execute<br/>Bearer GATE_TOKEN"| gw
    client -.->|"direct shop call"| shop
    client -.->|"direct connector call"| conn
    gw -->|"execute: purchase"| conn
    conn -->|"api_key attached here,<br/>never before"| shop

    style AGENT fill:#1a1a2e,stroke:#e94560,color:#eee
    style GATE fill:#16213e,stroke:#0f9b58,color:#eee
    style FLY fill:#0f3460,stroke:#533483,color:#eee
```

Three independent facts make the boundary hold:

1. **The shop demands a key the agent has never seen.** It is stored only
   in the connector config, injected at the gateway hop.
2. **The connector refuses the agent's sprite.** Fly evaluates
   `sprite_labels: ["gate"]` on the caller's identity — not something our
   code controls, not something the agent can negotiate with.
3. **The gate trusts nothing the agent says.** It prices carts from its
   own catalog, counts spend from its own ledger, and reserves budget
   before touching money.

## The spend path

```mermaid
sequenceDiagram
    autonumber
    actor LLM as LLM brain
    participant AG as agent.ts
    participant GT as gate /eval+/execute
    participant LD as spend ledger
    participant CN as Fly connector
    participant SH as demo shop

    LLM->>AG: cart choice (skus)
    AG->>GT: POST /eval {vendor, items}
    GT->>GT: price cart server-side<br/>from trusted catalog
    GT->>LD: checkEnvelope: used + cart ≤ cap?
    alt over budget
        LD-->>GT: DENY daily cap
        GT-->>AG: 403 + {used, limit, resetAt}
        AG->>LLM: replan with exact deficit arithmetic
        Note over LLM,AG: loop until the cart fits<br/>or the agent gives up honestly
    else fits
        LD-->>GT: ALLOW
        GT-->>AG: intentId
        AG->>GT: POST /execute {intentId}
        GT->>LD: reserve cap space (before money moves)
        GT->>CN: purchase — no key attached
        CN->>SH: purchase + Bearer api_key
        SH->>SH: re-price cart, check balance,<br/>dedup by intentId, debit
        SH-->>GT: receipt {txId, amountUsd}
        GT->>GT: validate receipt schema,<br/>bind to intentId + amount
        GT->>LD: settle reservation
        GT-->>AG: receipt txId
    end
    Note over GT,LD: timeout or 5xx? reservation is NEVER released on a guess —<br/>the gate reconciles against shop receipts first
```

## What happens when the agent cheats

Every row below is a live-verified probe result, not a design claim
(full machine-readable log: [evidence/demo-results.json](evidence/demo-results.json)):

| Attack | Result |
|---|---|
| `approved: true` / forged `verdict` / foreign `wallet` in the eval body | ignored — verdict is computed gate-side |
| vendor outside the allowlist | `DENY UNKNOWN_VENDOR` |
| `amountUsd: 0.005` rounding games (arc-audit C1 repro) | ignored — server prices the cart |
| `qty: 100` inflation, unknown skus, negative qty | `DENY` — items validated against catalog |
| execute a forged or never-allowed intentId | `UNKNOWN_INTENT` / `INTENT_NOT_AUTHORIZED` |
| replay the same intentId twice | same receipt, **one** debit (settlement dedup) |
| 3 parallel executes of one intent | 1 receipt + 2× `409 EXECUTION_IN_FLIGHT` |
| 5 parallel carts racing the cap | cap holds exactly — no overspend |
| direct call agent → shop | `401` — no credential exists agent-side |
| direct call agent → connector | `403 sprite is missing required labels: gate` |
| kill / freeze the gate mid-operation | `HTTP 000` — **no purchase is possible at all**; ledger survives restart |
| corrupt the ledger file | fail-closed `500` — never a silent budget reset |

## Verify it yourself

You need only `bun` and `jq`. No sprite account, no cloud access, no trust:

```sh
git clone https://github.com/spreadzp/hacksgiving-265
cd hacksgiving-265/gate && bun install
bash ../scripts/verify.sh        # ~1 minute, 20 checks
```

`verify.sh` proves, on your machine:

- **vendored-code integrity** — sha256 of every vendored file against the
  upstream pin: 59/62 byte-identical to `agentbadge@40eb49c`, and the 3
  differing files are exactly the disclosed arc-audit-H2 delta
  (anything else fails the check)
- **conformance** — the vendored mmf-255 suite: 43/43 vectors green,
  including the reserve-race and fail-closed invariants
- **behavioral claims** — boots the real gate+shop locally and probes:
  server-side pricing, spoofing resistance, auth boundaries, body limits,
  `PRICE_MISMATCH` at the shop, corrupt-ledger fail-closed

One thing cannot be verified offline *by construction*: the live
`execute` path through the real Fly connector. That is not a gap in the
proof — it **is** the security claim. The receipt chain is published in
[evidence/demo-results.json](evidence/demo-results.json) instead, captured
from the live deployment.

## Honest semantics (what the cap does and does not promise)

- The cap is **$100 per rolling 24h window**, not per calendar day.
- `eval` is not idempotent: asking twice creates two intents. Both draw
  from the same rolling budget — **the cap is the invariant**, not
  per-intent uniqueness.
- `execute` of one intentId is deduplicated: replay returns the same
  receipt, the shop debits once. Dedup at the shop layer is durable
  (persisted); the gate's in-memory receipt lookup lives for the process
  lifetime — after a gate restart an old intentId is `UNKNOWN_INTENT`
  at the gate, but the money invariant (one debit per intent) still holds
  because the shop dedups independently.
- While the gate is down, **no purchase is possible** (fail-closed) —
  availability is sacrificed for safety, deliberately.
- An indeterminate purchase outcome (connector timeout/5xx) **holds**
  the cap reservation rather than releasing it on a guess; the gate
  reconciles against shop receipts periodically. Worst case: budget
  frozen until the rolling window expires — availability cost, never
  an overspend.
- Corrupt ledger state fails closed (`500`s), it never silently resets
  the budget. Writes are atomic (tmp+rename) — a kill mid-write cannot
  tear the file. Caveat: a fully *missing* ledger file is the bootstrap
  path (fresh budget) — so host filesystem access is a trust assumption,
  as in any demo; the guarantee is about crashes and corruption, not
  about an attacker who already owns the gate host.
- The demo shop denominates in `demo-credit` and says so. The cap number
  equals the real funds at risk when wired to real money — the mechanism
  does not depend on the currency being fake.
- Single-tenant demo: one gate token, one subject wallet, one budget.

## The audit story

Before recording the demo, the public code went through an independent
adversarial audit (Arc Studio). Verdict: **REQUEST CHANGES** — 2 Critical,
2 High, 8 Medium findings, every Critical/High with a reproduced exploit:

- the cap metered a client-declared number, and rounding differences let
  an agent double-spend the budget ($20 of debits against the then-$10 cap)
- a slow connector response could release cap space while money moved
  ($18 against the then-$10 cap)
- a torn ledger write silently reset the budget to zero

All findings were fixed the same day — server-side pricing,
reconcile-not-release, atomic fail-closed ledger — and the fixes were
re-verified live. Notably, the ledger bug turned out to exist **in the
upstream production module**: its own conformance suite documented it as
a known high-severity gap. The fix here is the upstream-planned
remediation, disclosed file-by-file in
[gate/PROVENANCE.md](gate/PROVENANCE.md), and the updated conformance
suite now testifies to the fixed behavior.

That is the point of the demo: "can't overspend" is a checkable claim,
not a marketing line.

## Repository layout

```
gate/
  server.ts        gate service: /eval /execute /audit /mandate /healthz
  shop.ts          /demo/shop/* — server-priced purchase, dedup, receipts,
                   by-intent reconciliation oracle
  catalog.json     canonical trusted price list (single source for gate+shop)
  mandate.json     the demo mandate: $100/rolling-24h + velocity cap
  vendor/          mmf-255 snapshot — pinned by vendor-shasum.txt
  shims/           minimal shims for workspace-package imports
  PROVENANCE.md    upstream commit, verification method, disclosed deltas
agent/
  agent.ts         the shopping loop (brain-pluggable, ollama by default)
  gate-client.sh   the executable contract — the only sanctioned spend path
  task.md          the agent's mission and hard rules
  SYSTEM.md        boundary context for stock-CLI brains
scripts/
  verify.sh        judge-facing reproduction — 20 checks, offline
evidence/
  demo-results.json  live adversarial probe + kill-test + reproduce results
```

## Development

```sh
cd gate
bun install

# run the gate+shop locally (test tokens, isolated data dir)
GATE_TOKEN=dev SHOP_API_KEY=devshop GATE_DATA_DIR=/tmp/gatedata bun server.ts

# conformance suite (43 vectors: spend/lifecycle/crypto tracks + invariants)
bunx vitest run vendor/tests/conformance/mmf/

# eval smoke against the local gate
curl -X POST localhost:8080/eval \
  -H "Authorization: Bearer dev" -H "content-type: application/json" \
  -d '{"intent":{"vendor":"agentbadge-shop","items":[{"sku":"pie","qty":1}]}}'
```

The agent loop expects `GATE_URL` + `GATE_TOKEN` in the environment and an
ollama instance with `llama3.2:3b` (or set `AGENT_BRAIN=claude`/`codex`
with a working stock CLI):

```sh
cd agent
GATE_URL=http://localhost:8080 GATE_TOKEN=dev bun agent.ts
```
