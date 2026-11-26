#!/usr/bin/env bash
# Heph plugin hook (§9, D57, D58). Usage: heph-hook.sh <event>
#   event: session-start | stop | pre-tool-use | post-tool-use | session-end
#
# Forwards the hook's stdin JSON to Heph's agent port with a few git facts as
# headers and prints Heph's answer as the hook output. Needs only bash, git
# and curl (Git Bash on Windows). Every decision is made by the server
# (apps/server/src/routes/hooks.ts, contract v1).
#
# "Do not break": this script must never block or break a Claude Code session.
# It always exits 0, prints nothing on errors except a one-line notice at
# session start, and never parses JSON beyond reading the session id.

event="${1:-}"
url="${CLAUDE_PLUGIN_OPTION_HEPH_URL:-}"
token="${CLAUDE_PLUGIN_OPTION_HEPH_TOKEN:-}"
url="${url%/}"

notice() {
  # Only SessionStart output reaches Claude's context; keep it to one line.
  [ "$event" = session-start ] && printf 'Heph: %s\n' "$1"
  exit 0
}

if [ -z "$url" ] || [ -z "$token" ]; then
  cat >/dev/null
  notice "the plugin is not configured, so this session is not tracked. Ask the user to run /plugin configure heph@heph (agent URL and API token from Heph Settings > Connect Claude Code)."
fi
if ! command -v curl >/dev/null 2>&1; then
  cat >/dev/null
  notice "curl is not installed, so this session is not tracked."
fi

in_git=false
if command -v git >/dev/null 2>&1 && [ "$(git rev-parse --is-inside-work-tree 2>/dev/null)" = true ]; then
  in_git=true
fi

git_remote() {
  $in_git || return 0
  git remote get-url origin 2>/dev/null || git remote get-url "$(git remote 2>/dev/null | head -n 1)" 2>/dev/null
}

# Percent-encodes a value for a query string (UTF-8 bytes, brackets, spaces...).
urlencode() {
  local LC_ALL=C s="$1" out="" c i
  for ((i = 0; i < ${#s}; i++)); do
    c="${s:i:1}"
    case "$c" in
      [A-Za-z0-9._~/-]) out+="$c" ;;
      *) out+="$(printf '%%%02X' "'$c")" ;;
    esac
  done
  printf '%s' "$out"
}

# POST stdin (or $2 as a file) to /hooks/v1/<path>; prints "<body>\n<http code>".
# -g: never treat [] or {} in URLs as curl globs.
post() {
  local path="$1" data="$2" timeout="$3"
  shift 3
  curl -sS -g --max-time "$timeout" -o - -w '\n%{http_code}' \
    -H "Authorization: Bearer $token" \
    -H 'Content-Type: application/json' \
    "$@" --data-binary "$data" "$url/hooks/v1/$path" 2>/dev/null
}

case "$event" in
  session-start)
    input="$(cat)"
    remote="$(git_remote)"
    head="" worktree=""
    if $in_git; then
      head="$(git rev-parse --verify -q HEAD 2>/dev/null)"
      worktree="$(git --no-optional-locks status --porcelain=v1 2>/dev/null | git hash-object --stdin 2>/dev/null)"
    fi
    out="$(printf '%s' "$input" | post session-start @- 8 \
      -H "X-Heph-Remote: $remote" -H "X-Heph-Head: $head" -H "X-Heph-Worktree: $worktree")"
    code="${out##*$'\n'}"
    body="${out%$'\n'*}"
    case "$code" in
      200) printf '%s\n' "$body" ;;
      401) notice "Heph refused the API token, so this session is not tracked. Ask the user to update it with /plugin configure heph@heph (Heph Settings > Connect Claude Code)." ;;
      404) notice "$url answered but has no Heph hook endpoints, so this session is not tracked. The plugin URL must be Heph's agent port (e.g. :8081), not the web UI port, and the server must be a release with the plugin endpoints." ;;
      000 | '') notice "Heph is not reachable at $url, so this session is not tracked (no briefing). Tell the user if they expected Heph to work; the work itself is not affected." ;;
      *) notice "Heph answered with an error (HTTP $code), so this session is not tracked. Tell the user; the work itself is not affected." ;;
    esac
    ;;

  stop)
    input="$(cat)"
    session_id="$(printf '%s' "$input" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)"
    remote="$(git_remote)"
    head="" worktree=""
    if $in_git; then
      head="$(git rev-parse --verify -q HEAD 2>/dev/null)"
      worktree="$(git --no-optional-locks status --porcelain=v1 2>/dev/null | git hash-object --stdin 2>/dev/null)"
    fi
    out="$(printf '%s' "$input" | post stop @- 5 \
      -H "X-Heph-Remote: $remote" -H "X-Heph-Head: $head" -H "X-Heph-Worktree: $worktree")"

    # Docs (§7): upload the local docs file when it differs from Heph's copy,
    # so unpushed edits show in the Documentation tab.
    if $in_git && [ -n "$session_id" ]; then
      target="$(curl -sS -g -f --max-time 3 -H "Authorization: Bearer $token" \
        "$url/hooks/v1/docs?session_id=$session_id" 2>/dev/null)"
      docs_path="${target%%$'\t'*}"
      docs_hash="${target#*$'\t'}"
      docs_hash="${docs_hash%%$'\n'*}"
      root="$(git rev-parse --show-toplevel 2>/dev/null)"
      file="$root/$docs_path"
      if [ -n "$target" ] && [ -n "$docs_path" ] && [ -f "$file" ]; then
        local_hash="$(git hash-object --no-filters -- "$file" 2>/dev/null)"
        if [ -n "$local_hash" ] && [ "$local_hash" != "$docs_hash" ]; then
          enc_path="$(urlencode "$docs_path")"
          curl -sS -g -f --max-time 10 -o /dev/null -X PUT \
            -H "Authorization: Bearer $token" -H 'Content-Type: application/octet-stream' \
            --data-binary "@$file" "$url/hooks/v1/docs?session_id=$session_id&path=$enc_path" \
            2>/dev/null || true
        fi
      fi
    fi

    # 200 = a block decision for Claude Code; 204 or an error = nothing.
    [ "${out##*$'\n'}" = 200 ] && printf '%s\n' "${out%$'\n'*}"
    ;;

  pre-tool-use | post-tool-use)
    remote="$(git_remote)"
    # 2 s: a healthy Heph on the LAN answers in milliseconds; a hung one must not slow every
    # shell command down to the 5 s hook timeout (verification B5).
    post "$event" @- 2 -H "X-Heph-Remote: $remote" >/dev/null
    ;;

  session-end)
    post session-end @- 2 >/dev/null
    ;;

  *)
    cat >/dev/null
    ;;
esac
exit 0
