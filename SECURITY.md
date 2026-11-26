# Security

Security posture of Hephaestus (heph), stated as it is. Decisions are referenced as `D<n>` in [`DECISIONS.md`](DECISIONS.md).

## Model

- **Single user, self-hosted.** One account, created by a one-time setup wizard (D5). There is no registration page.
- **Two ports (D3, D24).** The UI port (8080) is meant to be published through a Cloudflare Tunnel protected by Cloudflare Access. The agent port (8081: MCP, uploads, hooks) is meant for the LAN only and must never be routed through the tunnel.
- **The app does its own authentication** and does not rely on Cloudflare Access (D4): it behaves the same on the LAN and through the tunnel.

## Authentication

- Passwords are hashed with argon2id. Login sessions are random tokens stored only as SHA-256 hashes; the cookie is `httpOnly`, `SameSite=Lax`, and `Secure` when the request arrives over HTTPS (`X-Forwarded-Proto`). Sessions expire after 30 days of inactivity.
- Failed logins are rate-limited per TCP peer address (`X-Forwarded-For` is ignored because clients control it; behind the tunnel all logins share one limit). There is also a global cap of 100 failed logins per 15 minutes across all addresses (D46), so many addresses do not help an attacker; while it holds, everyone (the owner included) gets 403 until the window ends. Attempts are evaluated one at a time, so parallel requests cannot exceed either limit; at most 50 attempts wait in line, further ones get 429. Login and setup refuse other origins and non-JSON bodies, so another website cannot lock the owner out. Cookie-authenticated writes from another origin are refused.
- **API token (D6, D45):** one static bearer token for MCP and the agent REST API. It is stored readable in the database because the spec requires showing it in Settings. Rotate it with `docker exec heph heph rotate-token` or from Settings; the old token stops working at once. It does not expire by itself.
- The GitHub token (phase 6) is write-only: the API only says whether it is set.
- Recovery: `docker exec -it heph heph reset-password` sets a new password and signs out every session.

## Agent writes

- Claude Code acts with source `claude_code`; every change is recorded in `change_log` with its source and session.
- Destructive agent changes become proposals unless Claude says the user confirmed them in chat (D12, D37); that claim is recorded, and the `allowClaudeConfirm` setting can turn it off. A project can disable Claude writes entirely.

## Claude Code plugin (D57, D58)

- The plugin keeps the agent URL and the API token in Claude Code's plugin options; the token is a `sensitive` option, kept in the system credential store, not in `settings.json`.
- The hooks call the agent port only (LAN), with the token in an `Authorization` header; it is visible in the local `curl` command line while a hook runs.
- What the hooks send: the hook input from Claude Code (session id, folder, tool name, shell commands and their output for shell tools), the git remote URL, HEAD, a hash of `git status`, and the repo's docs file when it changed. Heph stores the session state and the docs content, not the commands or their output. Credentials in a remote URL are never echoed back into Claude's context.
- The hooks never block a session: with Heph unreachable or misconfigured they print a one-line notice at start and nothing else.

## Files

- Uploads are type-sniffed from their content. Raster images are re-encoded: EXIF, GPS and other metadata are removed and the orientation is applied.
- Downloads are sent with `X-Content-Type-Options: nosniff`, a sandboxed CSP, and as attachments unless they are images or PDFs.
- Agent uploads use one-time URLs that expire after one hour (D14).

## Container (D41)

- Non-root user, read-only root filesystem, tmpfs `/tmp`, all Linux capabilities dropped, `no-new-privileges`. Writable: `/data/db`, `/data/files`, the tmpfs `/tmp` and Docker's default `/dev/shm` (a small in-memory tmpfs, noexec).
- Images are built and published by the manual Release workflow (D42); the server only pulls them.

## Supply chain (D43)

- gitleaks scans staged changes in a pre-commit hook and the full history in CI.
- Dependabot proposes grouped dependency updates weekly. Dependencies install from the lockfile.

## Known limits

- No TLS inside the container: HTTPS is expected from the tunnel; on the LAN, traffic (including the API token) is plain HTTP.
- No multi-user access control and no audit UI yet; `change_log` is only readable in the database for now.
- Backups are manual (copy the volumes with the container stopped); there is no automated, tested restore yet.

## Reporting a vulnerability

Please open a private security advisory on GitHub (Security → Advisories → "Report a vulnerability") rather than a public issue.
