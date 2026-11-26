# pretty.sh — zero-dep terminal styling, sourced by verify.sh / probe.sh.
# Baseline: pure ANSI + unicode (works in any terminal, degrades cleanly
# when piped). Opportunistic: uses gum for banners/spinners IF installed.
#
#   . scripts/pretty.sh
#   banner "the agent that can't overspend"
#   section "1. byte integrity" ; pass "x" ; fail "y" ; note "z"
#   verdict_badge ALLOW|DENY ; summary_box "20/20 PASS"

# TTY detection — piped output (judge logs, CI) stays clean plaintext
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  C_RESET=$'\033[0m';  C_BOLD=$'\033[1m';  C_DIM=$'\033[2m'
  C_RED=$'\033[31m';   C_GRN=$'\033[32m';  C_YEL=$'\033[33m'
  C_BLU=$'\033[34m';   C_CYN=$'\033[36m';  C_MAG=$'\033[35m'
  C_BRED=$'\033[91m';  C_BGRN=$'\033[92m'; C_BCYN=$'\033[96m'
else
  C_RESET='' C_BOLD='' C_DIM='' C_RED='' C_GRN='' C_YEL='' \
  C_BLU='' C_CYN='' C_MAG='' C_BRED='' C_BGRN='' C_BCYN=''
fi

I_PASS="✔"; I_FAIL="✘"; I_NOTE="▸"; I_LOCK="🔒"; I_CART="🦃"
I_SHIELD="🛡"; I_BOOK="📜"; I_ZAP="⚡"; I_ROBOT="🤖"

have_gum() { command -v gum >/dev/null 2>&1 && [ -t 1 ]; }

banner() { # banner <title> — gum if present, unicode box otherwise
  local t="$1"
  if have_gum; then
    gum style --foreground 212 --border-foreground 212 --border double \
      --align center --width 64 --margin "1 0" --padding "1 3" "$t"
  else
    local pad=$(( (62 - ${#t}) / 2 ))
    printf "${C_MAG}╔%s╗\n" "$(printf '═%.0s' $(seq 64))"
    printf "║%*s%s%*s ║\n" "$pad" "" "$C_BOLD$C_BCYN$t$C_RESET$C_MAG" "$((62 - pad - ${#t}))" ""
    printf "╚%s╝${C_RESET}\n" "$(printf '═%.0s' $(seq 64))"
  fi
}

section() { printf "\n${C_BOLD}${C_BLU}━━━ %s ━━━${C_RESET}\n" "$1"; }
pass()    { printf "  ${C_BGRN}%s PASS${C_RESET}  %s\n" "$I_PASS" "$1"; }
fail()    { printf "  ${C_BRED}%s FAIL${C_RESET}  %s\n" "$I_FAIL" "$1"; }
note()    { printf "  ${C_DIM}%s      %s${C_RESET}\n" "$I_NOTE" "$1"; }

verdict_badge() { # verdict_badge <verdict> — colored inline badge
  case "$1" in
    ALLOW) printf "${C_BGRN}${C_BOLD}✔ ALLOW${C_RESET}" ;;
    DENY)  printf "${C_BRED}${C_BOLD}✘ DENY${C_RESET}" ;;
    *)     printf "${C_YEL}? %s${C_RESET}" "$1" ;;
  esac
}

summary_box() { # summary_box <line1> [line2] — closing scoreboard.
  # Emoji count as 1 char but render 2 cells — compensate padding per emoji.
  local l1="$1" l2="${2:-}"
  _boxline() {
    local txt="$1" w=54
    local emojis=$(printf '%s' "$txt" | grep -o '[🛡🦃🔒📜⚡🤖✔✘]' | wc -l)
    local pad=$(( w - ${#txt} - emojis ))
    [ $pad -lt 1 ] && pad=1
    printf "│  %s%*s│\n" "$txt" "$pad" ""
  }
  printf "\n${C_BOLD}${C_CYN}┌────────────────────────────────────────────────────────┐\n"
  _boxline "$l1"
  [ -n "$l2" ] && _boxline "$l2"
  printf "└────────────────────────────────────────────────────────┘${C_RESET}\n"
}

spin() { # spin <title> <cmd...> — gum spinner or plain run
  local title="$1"; shift
  if have_gum; then
    gum spin --spinner dot --title "$title" -- "$@"
  else
    printf "${C_DIM}  %s %s…${C_RESET}\n" "$I_NOTE" "$title"
    "$@"
  fi
}
