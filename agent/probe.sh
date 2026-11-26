#!/usr/bin/env bash
# probe.sh — interactive test-drive of the live gate (runs inside hack-agent).
# Usage: ./probe.sh spoof|small|buy|replay|audit|boundary
set -uo pipefail
cd "$(dirname "$0")"
# shellcheck disable=SC1091
[ -f ~/.agent-env ] && . ~/.agent-env

FULL='[{"sku":"turkey","qty":1},{"sku":"gravy","qty":1},{"sku":"cranberry","qty":1},{"sku":"potatoes","qty":1},{"sku":"stuffing","qty":1},{"sku":"rolls","qty":1},{"sku":"pie","qty":1}]'
PIE='[{"sku":"pie","qty":1}]'

case "${1:-menu}" in
  spoof)
    echo "== spoof: declaring \$0.001 for the \$113 full table =="
    echo '(client-declared amount must be ignored — the gate prices the cart itself)'
    ./gate-client.sh eval 0.001 "$FULL" | jq '{verdict, reason, amountUsd, deny}' ;;
  small)
    echo "== small: one pie — ALLOW at server price \$18 =="
    ./gate-client.sh eval 18 "$PIE" | jq '{verdict, amountUsd}' ;;
  buy)
    echo "== buy: real spend path (reserve → connector → shop → receipt) =="
    ./gate-client.sh buy 18 "$PIE" | jq '{executed, txId: .receipt.txId, amount: .receipt.amountUsd, balance: .receipt.balanceAfterUsd}' ;;
  replay)
    echo "== replay: execute the SAME intentId twice — second must dedup =="
    R=$(./gate-client.sh eval 18 "$PIE")
    IID=$(echo "$R" | jq -r .intentId)
    echo "-- intent $IID — execute #1:"
    curl -sS -m 90 -X POST "$GATE_URL/execute" -H "Authorization: Bearer $GATE_TOKEN" \
      -H 'content-type: application/json' -d "{\"intentId\":\"$IID\"}" \
      | jq -c '{executed, txId: .receipt.txId, state}'
    echo "-- execute #2 (replay):"
    curl -sS -m 90 -X POST "$GATE_URL/execute" -H "Authorization: Bearer $GATE_TOKEN" \
      -H 'content-type: application/json' -d "{\"intentId\":\"$IID\"}" \
      | jq -c '{executed, txId: .receipt.txId, state, dedup: .dedup}'
    echo '(same txId + dedup flag = ONE debit, not two)' ;;
  audit)
    echo "== audit: intent count + latest verdicts =="
    ./gate-client.sh audit | jq '{count: (.intents | length), last: (.intents | sort_by(.ts) | reverse | .[0:4] | map({verdict, amountUsd, reason}))}' ;;
  boundary)
    echo "== boundary: this sprite holds no credential, ever =="
    echo -n "shop direct (no key): "
    curl -s -o /dev/null -w "%{http_code}\n" --max-time 20 "$GATE_URL/shop/balance"
    echo '(401 — the key exists only inside the connector gateway)' ;;
  *)
    echo "usage: ./probe.sh spoof|small|buy|replay|audit|boundary" ;;
esac
