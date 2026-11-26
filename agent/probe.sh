#!/usr/bin/env bash
# probe.sh — interactive test-drive of the live gate (runs inside hack-agent).
# Usage: ./probe.sh spoof|small|buy|replay|audit|boundary
set -uo pipefail
cd "$(dirname "$0")"
# shellcheck disable=SC1091
[ -f ~/.agent-env ] && . ~/.agent-env
# pretty output — graceful degradation when piped
if [ -f "$PWD/../scripts/pretty.sh" ]; then . "$PWD/../scripts/pretty.sh";
elif [ -f ~/hacksgiving-265/scripts/pretty.sh ]; then . ~/hacksgiving-265/scripts/pretty.sh; fi
hdr() { printf "\n${C_BOLD}${C_CYN}%s %s${C_RESET}\n" "${2:-$I_ZAP}" "$1"; }
dim() { printf "${C_DIM}%s${C_RESET}\n" "$1"; }

FULL='[{"sku":"turkey","qty":1},{"sku":"gravy","qty":1},{"sku":"cranberry","qty":1},{"sku":"potatoes","qty":1},{"sku":"stuffing","qty":1},{"sku":"rolls","qty":1},{"sku":"pie","qty":1}]'
PIE='[{"sku":"pie","qty":1}]'

case "${1:-menu}" in
  spoof)
    hdr "spoof: declaring \$0.001 for the \$113 full table" "$I_CART"
    dim "  ▸ client-declared amount is ignored — the gate prices the cart itself"
    ./gate-client.sh eval 0.001 "$FULL" | jq '{verdict, reason, amountUsd, deny}' ;;
  small)
    hdr "small: one pie — ALLOW at server price \$18" "$I_CART"
    ./gate-client.sh eval 18 "$PIE" | jq '{verdict, amountUsd}' ;;
  buy)
    hdr "buy: real spend path — reserve → connector → shop → receipt" "$I_ZAP"
    ./gate-client.sh buy 18 "$PIE" | jq '{executed, txId: .receipt.txId, amount: .receipt.amountUsd, balance: .receipt.balanceAfterUsd}' ;;
  replay)
    hdr "replay: execute the SAME intentId twice — second must dedup" "$I_ZAP"R=$(./gate-client.sh eval 18 "$PIE")
    IID=$(echo "$R" | jq -r .intentId)
    echo "-- intent $IID — execute #1:"
    curl -sS -m 90 -X POST "$GATE_URL/execute" -H "Authorization: Bearer $GATE_TOKEN" \
      -H 'content-type: application/json' -d "{\"intentId\":\"$IID\"}" \
      | jq -c '{executed, txId: .receipt.txId, state}'
    echo "-- execute #2 (replay):"
    curl -sS -m 90 -X POST "$GATE_URL/execute" -H "Authorization: Bearer $GATE_TOKEN" \
      -H 'content-type: application/json' -d "{\"intentId\":\"$IID\"}" \
      | jq -c '{executed, txId: .receipt.txId, state, dedup: .dedup}'
    dim "  ▸ same txId + dedup = ONE debit, not two" ;;
  audit)
    hdr "audit: intent count + latest verdicts" "$I_BOOK"
    ./gate-client.sh audit | jq '{count: (.intents | length), last: (.intents | sort_by(.ts) | reverse | .[0:4] | map({verdict, amountUsd, reason}))}' ;;
  boundary)
    hdr "boundary: this sprite holds no credential, ever" "$I_LOCK"
    echo -n "shop direct (no key): "
    curl -s -o /dev/null -w "%{http_code}\n" --max-time 20 "$GATE_URL/shop/balance"
    dim "  ▸ 401 — the key exists only inside the connector gateway" ;;
  *)
    echo "usage: ./probe.sh spoof|small|buy|replay|audit|boundary" ;;
esac
