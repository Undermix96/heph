#!/usr/bin/env bash
# End-to-end smoke test of the Docker image: build, start with fresh volumes,
# run setup + login, use the API token, upload an image, use the CLI, restart
# and check that data survived. Requires docker and curl.
set -euo pipefail

IMAGE=${IMAGE:-heph:smoke}
NAME=heph-smoke-$$
UI_PORT=${UI_PORT:-18080}
AGENT_PORT=${AGENT_PORT:-18081}
UI=http://127.0.0.1:$UI_PORT
AGENT=http://127.0.0.1:$AGENT_PORT
JAR=$(mktemp)

cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker volume rm -f "$NAME-db" "$NAME-files" >/dev/null 2>&1 || true
  rm -f "$JAR"
}
trap cleanup EXIT

fail() { echo "FAIL: $*" >&2; docker logs "$NAME" 2>&1 | tail -30 >&2; exit 1; }
json() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const v=JSON.parse(s);console.log(eval('v'+process.argv[1]))})" "$1"; }

start() {
  # Same hardening as compose.yaml: read-only root, no capabilities, no privilege escalation.
  # MSYS_NO_PATHCONV: stop Git Bash on Windows rewriting /tmp; no effect on Linux.
  MSYS_NO_PATHCONV=1 docker run -d --name "$NAME" --init --read-only --tmpfs /tmp --cap-drop ALL \
    --security-opt no-new-privileges:true -p "$UI_PORT:8080" -p "$AGENT_PORT:8081" \
    -v "$NAME-db:/data/db" -v "$NAME-files:/data/files" "$IMAGE" >/dev/null
  for _ in $(seq 1 30); do
    curl -fsS "$UI/health" >/dev/null 2>&1 && curl -fsS "$AGENT/health" >/dev/null 2>&1 && return 0
    sleep 1
  done
  fail "container did not become healthy"
}

if [ "${SKIP_BUILD:-}" != "1" ]; then
  echo "==> build $IMAGE"
  docker build -q -t "$IMAGE" . >/dev/null
fi

echo "==> start"
start

echo "==> hardening"
docker exec "$NAME" sh -c 'touch /app/write-test' 2>/dev/null && fail "root filesystem is writable"
docker exec "$NAME" sh -c 'touch /data/files/.write-test && rm /data/files/.write-test' || fail "data volume not writable"
[ "$(docker exec "$NAME" id -u)" != "0" ] || fail "container runs as root"

echo "==> setup wizard"
[ "$(curl -fsS "$UI/api/auth/status" | json .setupDone)" = "false" ] || fail "setup already done"
TOKEN=$(curl -fsS -c "$JAR" -H 'content-type: application/json' \
  -d '{"username":"admin","password":"smoke-test-pass"}' "$UI/api/setup" | json .apiToken)
[[ "$TOKEN" == heph_* ]] || fail "no API token from setup"
code=$(curl -s -o /dev/null -w '%{http_code}' -H 'content-type: application/json' \
  -d '{"username":"x","password":"another-pass"}' "$UI/api/setup")
[ "$code" = "409" ] || fail "second setup returned $code"

echo "==> web UI is served"
curl -fsS "$UI/" | grep -q '<div id="root">' || fail "index.html not served"
curl -fsS "$UI/some/client/route" | grep -q '<div id="root">' || fail "SPA fallback missing"

echo "==> login + cookie API"
curl -fsS -c "$JAR" -H 'content-type: application/json' \
  -d '{"username":"admin","password":"smoke-test-pass"}' "$UI/api/auth/login" >/dev/null
SLUG=$(curl -fsS -b "$JAR" -H 'content-type: application/json' \
  -d '{"name":"Smoke project","phases":[{"title":"One","tasks":["First task"]}]}' "$UI/api/projects" | json .slug)
[ "$SLUG" = "smoke-project" ] || fail "unexpected slug $SLUG"

echo "==> token API on the agent port"
NEXT=$(curl -fsS -H "authorization: Bearer $TOKEN" "$AGENT/api/projects/$SLUG/next-task" | json .nextTask.title)
[ "$NEXT" = "First task" ] || fail "next task: $NEXT"
code=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" "$AGENT/api/projects")
[ "$code" = "401" ] || fail "agent port accepted a cookie ($code)"

echo "==> MCP on the agent port"
mcp() {
  curl -fsS -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
    -H 'accept: application/json, text/event-stream' -d "$1" "$AGENT/mcp"
}
mcp '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' \
  | grep -q '"name":"heph"' || fail "MCP initialize"
mcp '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' | grep -q '"get_briefing"' || fail "MCP tools/list"
mcp "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tools/call\",\"params\":{\"name\":\"get_briefing\",\"arguments\":{\"project\":\"$SLUG\"}}}" \
  | grep -q 'First task' || fail "MCP get_briefing"
code=$(curl -s -o /dev/null -w '%{http_code}' -H 'content-type: application/json' -d '{}' "$AGENT/mcp")
[ "$code" = "401" ] || fail "MCP without token returned $code"

echo "==> one-time upload with curl -F"
URL_PATH=$(curl -fsS -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"caption":"smoke"}' "$AGENT/api/projects/$SLUG/upload-requests" | json .path)
IMG=.smoke-shot-$$.png
docker exec "$NAME" node -e "require('/app/node_modules/sharp')({create:{width:32,height:16,channels:3,background:'#09f'}}).png().toBuffer().then(b=>process.stdout.write(b))" > "$IMG"
FILE_ID=$(curl -fsS -F "file=@$IMG;filename=shot.png" "$AGENT$URL_PATH" | json .id)
rm -f "$IMG"
curl -fsS -H "authorization: Bearer $TOKEN" "$AGENT/api/files/$FILE_ID/thumbnail" -o /dev/null || fail "no thumbnail"

echo "==> CLI: rotate-token"
NEW_TOKEN=$(docker exec "$NAME" heph rotate-token | tail -1)
code=$(curl -s -o /dev/null -w '%{http_code}' -H "authorization: Bearer $TOKEN" "$AGENT/api/projects")
[ "$code" = "401" ] || fail "old token still valid ($code)"
curl -fsS -H "authorization: Bearer $NEW_TOKEN" "$AGENT/api/projects" >/dev/null || fail "new token rejected"

echo "==> CLI: reset-password (stdin)"
printf 'reset-pass-123\nreset-pass-123\n' | docker exec -i "$NAME" heph reset-password >/dev/null
code=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" "$UI/api/auth/me")
[ "$code" = "401" ] || fail "session survived password reset ($code)"
curl -fsS -c "$JAR" -H 'content-type: application/json' \
  -d '{"username":"admin","password":"reset-pass-123"}' "$UI/api/auth/login" >/dev/null || fail "login with reset password"

echo "==> restart keeps data"
docker restart "$NAME" >/dev/null
for _ in $(seq 1 30); do curl -fsS "$UI/health" >/dev/null 2>&1 && break; sleep 1; done
N=$(curl -fsS -b "$JAR" "$UI/api/projects" | json .length)
[ "$N" = "1" ] || fail "projects after restart: $N"
curl -fsS -H "authorization: Bearer $NEW_TOKEN" "$AGENT/api/files/$FILE_ID/content" -o /dev/null || fail "file lost on restart"

echo "==> healthcheck"
for _ in $(seq 1 20); do
  [ "$(docker inspect -f '{{.State.Health.Status}}' "$NAME")" = "healthy" ] && break
  sleep 2
done
[ "$(docker inspect -f '{{.State.Health.Status}}' "$NAME")" = "healthy" ] || echo "note: healthcheck not yet healthy (interval 30s)"

echo "OK: docker smoke test passed"
