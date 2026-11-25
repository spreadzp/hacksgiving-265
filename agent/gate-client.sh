#!/usr/bin/env bash
# gate-client — the ONLY sanctioned way to spend (executable contract, D-265-3).
# The agent holds no connector grant (infra deny) and no shop api_key (401),
# so this client is the spend path by construction, not by instruction.
#
#   gate-client.sh eval   <amountUsd> [items-json]   → verdict + reason
#   gate-client.sh buy    <amountUsd> [items-json]   → eval; ALLOW → execute → receipt
#   gate-client.sh mandate                           → the loaded mandate (caps)
#   gate-client.sh audit                             → gate audit (ledger + intents)
#
# Env: GATE_URL (default http://localhost:8080 — set to the gate sprite URL),
#      GATE_TOKEN (agent→gate Bearer; lives in env, never in the video frame).
set -uo pipefail

GATE_URL="${GATE_URL:-http://localhost:8080}"
AUDIT_LOG="${GATE_AUDIT_LOG:-$(dirname "$0")/agent-audit.jsonl}"
CT='content-type: application/json'

log() { # timestamped local trail: what the agent asked the gate
  printf '%s %s\n' "$(date -u +%FT%TZ)" "$1" >> "$AUDIT_LOG"
}

# R2#3: no curl -f — an HTTP 502 OUTCOME_UNKNOWN is a *designed* gate outcome
# (reservation held pending reconcile), not a transport error; the body must
# reach the caller. -m 90 covers the gate worst case (~15s connector timeout
# + reconcile retries with backoff ≈ 60s+).
post() { # post <path> <json-body>
  curl -sS -m 90 -X POST "$GATE_URL$1" \
    -H "Authorization: Bearer ${GATE_TOKEN:-}" -H "$CT" -d "$2"
}
get() {
  curl -sS -m 20 "$GATE_URL$1" -H "Authorization: Bearer ${GATE_TOKEN:-}"
}

case "${1:-}" in
  eval)
    AMT="${2:?usage: gate-client.sh eval <amountUsd> [items]}"
    ITEMS="${3:-[]}"
    BODY="{\"intent\":{\"vendor\":\"agentbadge-shop\",\"amountUsd\":$AMT,\"items\":$ITEMS}}"
    log "EVAL  amount=$AMT items=$ITEMS"
    R=$(post /eval "$BODY") || { log "EVAL  transport-error"; exit 2; }
    log "VERDICT $(echo "$R" | jq -c '{verdict,reason,deny}')"
    echo "$R" | jq .
    ;;
  buy)
    AMT="${2:?usage: gate-client.sh buy <amountUsd> [items]}"
    ITEMS="${3:-[]}"
    BODY="{\"intent\":{\"vendor\":\"agentbadge-shop\",\"amountUsd\":$AMT,\"items\":$ITEMS}}"
    log "EVAL  amount=$AMT items=$ITEMS"
    R=$(post /eval "$BODY") || { log "EVAL  transport-error"; exit 2; }
    V=$(echo "$R" | jq -r .verdict)
    log "VERDICT $(echo "$R" | jq -c '{verdict,reason,deny}')"
    if [ "$V" != "ALLOW" ]; then echo "$R" | jq .; exit 1; fi
    IID=$(echo "$R" | jq -r .intentId)
    log "EXEC  intent=$IID"
    X=$(post /execute "{\"intentId\":\"$IID\"}") || { log "EXEC  transport-error"; exit 2; }
    log "RECEIPT $(echo "$X" | jq -c '{executed,txId:.receipt.txId,amount:.receipt.amountUsd}')"
    echo "$X" | jq .
    ;;
  mandate) get /mandate | jq . ;;
  audit)   get /audit | jq . ;;
  *) echo "usage: gate-client.sh {eval|buy|mandate|audit} ..." >&2; exit 64 ;;
esac
