# Hephaestus (heph)

> **Work in progress.** The backend, the MCP server and the web UI work; the Claude Code plugin (phase 5) is being built. GitHub integration and the new-project skill come next.

Hephaestus is a self-hosted, AI-first tracker for personal software and DIY projects.
Its core job: let you resume any project after weeks without reconstructing context.

- Dashboard ordered by what needs attention; per-project roadmap (phases → tasks), next step and diary.
- Built to be operated by [Claude Code](https://claude.com/claude-code) as a first-class user, through an MCP server and hooks that keep the diary up to date automatically.
- Single user, single Docker container, SQLite storage, runs on a LAN server.

## Run with Docker Compose

Requirements: Docker with the Compose plugin on a Linux host. The published image is `ghcr.io/undermix96/heph`, multi-arch (amd64 + arm64), built and smoke-tested by the manual **Release** workflow in GitHub Actions. Versions are CalVer `YYYY.MM.DD-b<N>`; each release has a git tag and a GitHub release with its commits. The container runs hardened (non-root, read-only root filesystem, no capabilities, no privilege escalation).

Only `compose.yaml` is needed on the server (plus an optional `.env`):

```sh
mkdir heph && cd heph
curl -fsSLO https://raw.githubusercontent.com/Undermix96/heph/main/compose.yaml
docker compose up -d
```

To update: `docker compose pull && docker compose up -d`. Pin a release with `HEPH_TAG` in `.env` (e.g. `HEPH_TAG=2026.11.24-b1`).

To build from source instead of pulling: `docker compose -f compose.yaml -f compose.build.yaml up -d --build` in a clone of the repo.

Then open `http://<server>:8080` and complete the one-time setup wizard (username + password). The wizard shows the **API token** once; you can see it again later in Settings.

| Port   | Serves                                                                                       | Expose                                          |
| ------ | -------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `8080` | Web UI + REST API (`/api`)                                                                   | LAN, and through your Cloudflare Tunnel         |
| `8081` | MCP (`/mcp`), plugin hooks (`/hooks`), REST API with the token, one-time uploads (`/upload`) | **LAN only**: never route it through the tunnel |

To change the host ports or time zone, copy `.env.example` to `.env` and edit it. Set `HEPH_PUBLIC_AGENT_URL` there to the agent URL as your Claude Code machines reach it (e.g. `http://192.168.1.10:8081`): Settings > Connect Claude Code then shows the exact values to paste.

Data lives in two named volumes: `heph-db` (`/data/db`, SQLite) and `heph-files` (`/data/files`, uploads and thumbnails). They must be on local storage, not NFS/SMB. Back up by copying both volumes while the container is stopped.

### Recovery and maintenance

```sh
docker exec -it heph heph reset-password             # new password, signs out all sessions
docker exec -it heph heph reset-password --username me   # also rename the user
docker exec heph heph rotate-token                   # new API token; the old one stops working
docker compose logs -f heph
```

### Connect Claude Code (plugin)

The Claude Code plugin in [`plugin/`](plugin/README.md) bundles Heph's MCP server and the hooks that inject the project briefing at session start, show live sessions and test runs on the dashboard, remind Claude to keep the diary and sync local `DECISIONS.md` edits. Install it once at user level:

```sh
claude plugin marketplace add Undermix96/heph
claude plugin install heph@heph --scope user
```

Then run `/plugin configure heph@heph` in a Claude Code session and enter the agent URL and the API token (Settings > Connect Claude Code shows both). The hooks need `bash`, `git` and `curl` (Git Bash on Windows). Destructive changes Claude asks for (deleting phases or tasks, restructuring the roadmap, marking a project completed or abandoned) are stored as proposals for you to approve, unless you confirmed them in the chat. After `heph rotate-token`, update the token with `/plugin configure heph@heph`.

Without the plugin you can still add the MCP server by hand (`claude mcp add --scope user --transport http heph http://<server>:8081/mcp --header "Authorization: Bearer <api-token>"`), but not both: Claude Code skips the plugin's server when the same one is configured by hand.

### Cloudflare Tunnel

Point the tunnel at `http://<server>:8080`. The app does not read any Cloudflare Access header; it uses its own login. Login cookies are marked `Secure` automatically when requests arrive over HTTPS (via `X-Forwarded-Proto`).

## Development

Requires Node.js 26 (see `.nvmrc`).

```sh
npm install
npm run dev        # server on :8080 (UI/REST) and :8081 (agent), data in ./data
npm run dev:web    # Vite dev server for the web UI, proxies /api to :8080
npm run check      # lint + typecheck + tests
npm run smoke:docker   # build the image and run an end-to-end smoke test
npm run e2e        # Playwright end-to-end, axe and screenshots (after npm run build)
```

Layout: `packages/schema` (shared Zod schemas and types), `packages/core` (database, migrations, domain layer), `apps/server` (HTTP adapters and the `heph` CLI), `apps/web` (web UI).

## Documentation

- [`docs/HANDOFF.md`](docs/HANDOFF.md): product spec and scope.
- [`DECISIONS.md`](DECISIONS.md): architectural and technical decisions (D1…).
- Work state (roadmap, next step, diary, open questions): tracked in Heph itself through its MCP server (D47).
- [`SECURITY.md`](SECURITY.md): security posture and how to report a vulnerability.
- [`plugin/`](plugin/README.md): the Claude Code plugin.
- Package READMEs: [`packages/schema`](packages/schema/README.md), [`packages/core`](packages/core/README.md), [`apps/server`](apps/server/README.md), [`apps/web`](apps/web/README.md), [`scripts`](scripts/README.md).
- [`docs/design/`](docs/design/): approved UI design (mockups, tokens).

## License

[MIT](LICENSE)
