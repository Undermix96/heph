#!/usr/bin/env bash
# FEASIBILITY SPIKE (phase 5.0). Reports what a hook sees to the local echo
# server (scripts/plugin-spike-echo.mjs). Never prints the token.
event="$1"
input="$(cat)"
echo_url="http://127.0.0.1:18399/hooks/v1/$event"
token="${CLAUDE_PLUGIN_OPTION_HEPH_TOKEN:-}"
session_id="$(printf '%s' "$input" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)"
repo="$(git remote get-url origin 2>/dev/null || echo none)"

printf '%s' "$input" | curl -s --max-time 3 -o /dev/null \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $token" \
  -H "X-Spike-Shell: bash ${BASH_VERSION:-?} $(uname -s 2>/dev/null)" \
  -H "X-Spike-Plugin-Root: ${CLAUDE_PLUGIN_ROOT:-unset}" \
  -H "X-Spike-Plugin-Data: ${CLAUDE_PLUGIN_DATA:-unset}" \
  -H "X-Spike-Url-Option: ${CLAUDE_PLUGIN_OPTION_HEPH_URL:-unset}" \
  -H "X-Spike-Repo: $repo" \
  -H "X-Spike-Git: $(command -v git >/dev/null && echo yes || echo no)" \
  --data-binary @- "$echo_url" || true

case "$event" in
  session-start)
    echo "HEPH SPIKE: hook context injected. Session id: ${session_id:-unknown}. Check code: HEPH-OK-7319."
    ;;
  stop)
    marker="${CLAUDE_PLUGIN_DATA:-${TMPDIR:-/tmp}}/spike-stop-${session_id:-x}"
    if printf '%s' "$input" | grep -q '"stop_hook_active"[[:space:]]*:[[:space:]]*true'; then
      exit 0
    fi
    if [ ! -e "$marker" ]; then
      mkdir -p "$(dirname "$marker")" && : >"$marker"
      echo '{"decision":"block","reason":"Heph spike: reply with the single line SPIKE-STOP-OK and then stop."}'
    fi
    ;;
esac
exit 0
