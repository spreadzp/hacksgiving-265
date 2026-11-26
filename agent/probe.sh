#!/usr/bin/env bash
# probe.sh — interactive test-drive of the live gate, no inline-JSON hell.
# Run inside hack-agent sprite:  ./probe.sh <case>
# Cases: spoof | small | buy | audit | replay | boundary
set -uo pipefail
cd "$(dirname "$0")"
# shellcheck disable=SC1091
[ -f ~/.agent-env ] && . ~/.agent-env

FULL='{"items":[{"sku":"turkey","qty":1},{"sku":"gravy","qty":1},{"sku":"cranberry","qty":1},{"sku":"potatoes","qty":1},{"sku":"stuffing","qty":1},{"sku":"rolls","qty":1},{"sku":"pie","qty":1}],"amountUsd":0.001}'
PIE='{"items":[{"sku":"pie","qty":1}]}'

case "${1:-menu}" in
  spoof)
    echo "== spoof: claiming \$0.001 for the \$113 full table =="
    echo '(client-declared amountUsd must be ignored — server prices the cart)'
    ./gate-client.sh eval "$FULL" | jq '{verdict, reason, amountUsd, deny}' ;;
  small)
    echo "== small: one pie — should ALLOW at server price \$18 =="
    ./gate-client.sh eval "$PIE" | jq '{verdict, amountUsd}' ;;
  buy)
    echo "== buy: real spend path (reserve → connector → shop → receipt) =="
    ./gate-client.sh buy "$PIE" | jq '{executed, txId: .receipt.txId, amount: .receipt.amountUsd, balance: .receipt.balanceAfterUsd}' ;;
  replay)
    echo "== replay: same intent twice — second must dedup (one debit) =="
    IDEM="probe-$(date +%s)"
    BODY=$(echo "$PIE" | jq -c --arg i "$IDEM" '. + {intentId: $i}')
    echo "-- first:";  ./gate-client.sh buy "$BODY" | jq -c '{executed, txId: .receipt.txId}'
    echo "-- replay:"; ./gate-client.sh buy "$BODY" | jq -c '{executed, txId: .receipt.txId, dedup: (.dedup // .state)}'
    echo '(same txId twice = dedup correct; audit shows ONE debit)' ;;
  audit)
    echo "== audit: intents count + last verdicts =="
    ./gate-client.sh audit | jq '{count: (.intents | length), last: (.intents | sort_by(.ts) | reverse | .[0:4] | map({verdict, amountUsd, reason}))}' ;;
  boundary)
    echo "== boundary: agent has no credential, ever =="
    echo "-- shop direct:"; curl -s -o /dev/null -w "%{http_code}\n" --max-time 20 "$GATE_URL/shop/balance"
    echo '(401/404 — no api_key exists in this environment)' ;;
  *)
    echo "usage: ./probe.sh spoof|small|buy|replay|audit|boundary" ;;
esac
