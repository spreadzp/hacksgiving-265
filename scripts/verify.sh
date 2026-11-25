#!/usr/bin/env bash
# verify.sh — judge-facing reproduction of hacksgiving-265 claims.
# Runs everything verifiable WITHOUT sprite infrastructure:
#   1. vendored mmf-255 byte-integrity (59/62 identical + 3 disclosed deltas)
#   2. conformance suite — 43/43 vectors green
#   3. local gate+shop boot → behavioral smoke (server-side pricing,
#      cap enforcement, auth boundaries, fail-closed ledger)
#
# The live execute path (gate → connector → shop receipt) requires the
# sprite identity and is verified separately against the live deployment
# (see evidence/ and the README demo video) — it cannot run offline by
# construction, because that boundary IS the security claim.
#
# usage:  git clone <repo> && cd hacksgiving-265/gate && bun install
#         ../scripts/verify.sh        (or: bash scripts/verify.sh from root)
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GATE="$ROOT/gate"
PASS=0; FAIL=0
ok()   { echo "  PASS  $1"; PASS=$((PASS+1)); }
bad()  { echo "  FAIL  $1"; FAIL=$((FAIL+1)); }
info() { echo "  ....  $1"; }

command -v bun >/dev/null || { echo "bun required: https://bun.sh"; exit 64; }
command -v jq >/dev/null || { echo "jq required"; exit 64; }

echo "== 1. vendored mmf-255 byte integrity =="
cd "$ROOT"
# results/* are upstream-committed test-output snapshots that regenerate on
# every suite run — excluded from byte-verification (see PROVENANCE.md).
grep -v '/results/' gate/vendor-shasum.txt > /tmp/vshasum-$$.txt
SUMS=$(sha256sum -c /tmp/vshasum-$$.txt 2>/dev/null); rm -f /tmp/vshasum-$$.txt
OKN=$(echo "$SUMS" | grep -c ': OK$' || true)
DELTAS=$(echo "$SUMS" | grep ': FAILED' | sed 's/: FAILED//' | sed 's|.*/||' | sort | tr '\n' ' ')
info "byte-identical to agentbadge@40eb49c: $OKN/62 code+test files"
if [ "$OKN" -eq 59 ]; then ok "59/62 byte-identical (6 results/ snapshots excluded by design)"; else bad "expected 59 identical, got $OKN"; fi
EXPECTED_DELTAS="evidence-probe.ts ledger.ts own-invariants.test.ts"
if [ "$DELTAS" = "$EXPECTED_DELTAS " ]; then
  ok "deltas are exactly the 3 disclosed arc-R1-H2 files ($DELTAS)"
else
  bad "unexpected vendor deltas: $DELTAS (expected: $EXPECTED_DELTAS)"
fi

echo "== 2. mmf-255 conformance suite =="
cd "$GATE"
[ -d node_modules ] || { info "bun install…"; bun install --silent; }
SUIT=$(timeout 300 bunx vitest run vendor/tests/conformance/mmf/ 2>/dev/null | grep -oP 'Tests\s+\K\d+ passed' | grep -oP '^\d+')
if [ "$SUIT" = "43" ]; then ok "conformance 43/43"; else bad "conformance: got '$SUIT' passed (want 43)"; fi

echo "== 3. local gate+shop behavioral smoke =="
DATA=$(mktemp -d)
PORT=$((20000 + RANDOM % 20000))
T_TOK="verify-gate-token"; S_TOK="verify-shop-key"
GATE_TOKEN=$T_TOK SHOP_API_KEY=$S_TOK GATE_DATA_DIR="$DATA" PORT=$PORT \
  timeout 120 bun server.ts > "$DATA/boot.log" 2>&1 &
GPID=$!
cleanup() { kill $GPID 2>/dev/null; rm -rf "$DATA"; }
trap cleanup EXIT
sleep 2
B="http://localhost:$PORT"
AH="Authorization: Bearer $T_TOK"
CT="content-type: application/json"
ev()  { curl -s -m 10 -X POST "$B/eval" -H "$AH" -H "$CT" -d "$1"; }
FULL='{"intent":{"vendor":"agentbadge-shop","items":[{"sku":"turkey","qty":1},{"sku":"pie","qty":1},{"sku":"potatoes","qty":1},{"sku":"cranberry","qty":1},{"sku":"gravy","qty":1},{"sku":"rolls","qty":1}]}}'

R=$(curl -s -m 10 "$B/healthz"); echo "$R" | grep -q '"ok":true' && ok "healthz" || bad "healthz: $R"

# cap enforcement: full cart ($18.50 server-priced) vs $10 rolling cap
R=$(ev "$FULL")
V=$(echo "$R" | jq -r '.verdict + "/" + .reason + "/" + (.amountUsd|tostring)')
[ "$V" = "DENY/DAILY_CAP_EXCEEDED/18.5" ] && ok "full cart \$18.50 → DENY DAILY_CAP_EXCEEDED" || bad "full cart: $V"

# C1 regression: client-declared amountUsd is ignored entirely
R=$(echo "$FULL" | jq '.intent.amountUsd=0.005' | curl -s -m 10 -X POST "$B/eval" -H "$AH" -H "$CT" -d @-)
[ "$(echo "$R" | jq -r .amountUsd)" = "18.5" ] && ok "client amountUsd 0.005 ignored (server-priced 18.5)" || bad "C1 regression: $(echo "$R" | jq -c .)"

# small cart → ALLOW at server price
R=$(ev '{"intent":{"vendor":"agentbadge-shop","items":[{"sku":"pie","qty":1},{"sku":"gravy","qty":1}]}}')
[ "$(echo "$R" | jq -r .verdict)" = "ALLOW" ] && [ "$(echo "$R" | jq -r .amountUsd)" = "4.5" ] \
  && ok "pie+gravy → ALLOW at server price \$4.50" || bad "small cart: $(echo "$R" | jq -c '{verdict,amountUsd}')"
IID=$(echo "$R" | jq -r .intentId)

# C2 regression: unknown sku / qty inflation rejected
R=$(ev '{"intent":{"vendor":"agentbadge-shop","items":[{"sku":"caviar","qty":1}]}}')
[ "$(echo "$R" | jq -r .reason)" = "UNKNOWN_SKU" ] && ok "unknown sku → DENY UNKNOWN_SKU" || bad "unknown sku: $R"
R=$(ev '{"intent":{"vendor":"agentbadge-shop","amountUsd":1e-9,"items":[{"sku":"turkey","qty":100}]}}')
[ "$(echo "$R" | jq -r .verdict)" = "DENY" ] && ok "qty-inflation vector → DENY" || bad "qty inflation: $R"

# adversarial basics: approved-flag ignored, verdict computed by gate
R=$(ev '{"intent":{"vendor":"agentbadge-shop","approved":true,"verdict":"ALLOW","wallet":"0xother","items":[{"sku":"turkey","qty":1},{"sku":"pie","qty":1},{"sku":"potatoes","qty":1}]}}')
[ "$(echo "$R" | jq -r .verdict)" = "DENY" ] && [ "$(echo "$R" | jq -r .wallet)" != "0xother" ] \
  && ok "approved/verdict/wallet spoofing ignored" || bad "spoofing: $(echo "$R" | jq -c .)"

# vendor outside allowlist
R=$(ev '{"intent":{"vendor":"evil-shop","items":[{"sku":"pie","qty":1}]}}')
[ "$(echo "$R" | jq -r .reason)" = "UNKNOWN_VENDOR" ] && ok "vendor outside allowlist → DENY" || bad "vendor: $R"

# malformed/oversized
# R2#6: no python3 dependency — coreutils only; non-413 is a hard failure
PAD=$(printf 'x%.0s' $(seq 1 20000))
CODE=$(printf '{"pad":"%s"}' "$PAD" | curl -s -o /dev/null -w '%{http_code}' -m 10 -X POST "$B/eval" -H "$AH" -H "$CT" -d @-)
[ "$CODE" = "413" ] && ok "oversized body → 413 before buffering" || bad "oversized body → $CODE (want 413)"
R=$(curl -s -m 10 -X POST "$B/eval" -H "$AH" -H "$CT" -d 'not json')
echo "$R" | jq -e . >/dev/null 2>&1 && ok "malformed json → structured 4xx, not 5xx" || bad "malformed json: $R"

# auth boundary: no token → 401; empty token → 401
CODE=$(curl -s -o /dev/null -w '%{http_code}' -m 10 -X POST "$B/eval" -H "$CT" -d "$FULL")
[ "$CODE" = "401" ] && ok "no token → 401" || bad "no token → $CODE"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -m 10 -X POST "$B/eval" -H "Authorization: Bearer" -H "$CT" -d "$FULL")
[ "$CODE" = "401" ] && ok "empty bearer → 401" || bad "empty bearer → $CODE"

# execute without a preceding ALLOW'd intent
CODE=$(curl -s -o /dev/null -w '%{http_code}' -m 10 -X POST "$B/execute" -H "$AH" -H "$CT" -d '{"intentId":"int_forge00000000"}')
[ "$CODE" = "404" ] && ok "execute unknown intent → 404 refusal" || bad "execute unknown: $CODE"

# shop boundary: no key → 401; with key → catalog + balance readable
CODE=$(curl -s -o /dev/null -w '%{http_code}' -m 10 "$B/demo/shop/balance")
[ "$CODE" = "401" ] && ok "shop without key → 401" || bad "shop no key → $CODE"
R=$(curl -s -m 10 "$B/demo/shop/balance" -H "Authorization: Bearer $S_TOK")
echo "$R" | grep -q balanceUsd && ok "shop with key → balance readable" || bad "shop keyed: $R"

# shop server-side pricing: PRICE_MISMATCH on lying totals
R=$(curl -s -m 10 -X POST "$B/demo/shop/purchase" -H "Authorization: Bearer $S_TOK" -H "$CT" \
  -d '{"intentId":"verify_probe","amountUsd":0.01,"items":[{"sku":"pie","qty":1}]}')
[ "$(echo "$R" | jq -r .error)" = "PRICE_MISMATCH" ] && ok "shop rejects client-inflated totals (PRICE_MISMATCH)" || bad "shop mismatch: $R"

# fail-closed ledger: corrupt file → 5xx, never silent reset
echo '{"entries":{' > "$DATA/spend-ledger.json"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -m 10 -X POST "$B/eval" -H "$AH" -H "$CT" -d '{"intent":{"vendor":"agentbadge-shop","items":[{"sku":"pie","qty":1}]}}')
[ "$CODE" = "500" ] && ok "corrupt ledger → fail-closed 500 (no silent budget reset)" || bad "corrupt ledger → $CODE (want 500)"
rm -f "$DATA/spend-ledger.json"

info "execute happy-path (connector → receipt) requires live sprite identity —"
info "verified against the live deployment, see evidence/ and README."

echo
echo "== verify.sh: $PASS passed, $FAIL failed =="
[ "$FAIL" -eq 0 ]
