# Hephaestus (heph)

> **Work in progress.** The backend (data model, REST API, auth, CLI) and the MCP server work; the web UI is only a setup/login page for now, and the Claude Code plugin (hooks, automatic diary) is not built yet.

Hephaestus is a self-hosted, AI-first tracker for personal software and DIY projects.
Its core job: let you resume any project after weeks without reconstructing context.

- Dashboard ordered by what needs attention; per-project roadmap (phases → tasks), next step and diary.
- Built to be operated by [Claude Code](https://claude.com/claude-code) as a first-class user, through an MCP server and hooks that keep the diary up to date automatically.
- Single user, single Docker container, SQLite storage, runs on a LAN server.

## Run with Docker Compose

Requirements: Docker with the Compose plugin on a Linux host. The published image is `ghcr.io/undermix96/heph` (built by the manual **Docker image** workflow in GitHub Actions; amd64 by default, arm64 on request).

Only `compose.yaml` is needed on the server (plus an optional `.env`):

```sh
mkdir heph && cd heph
curl -fsSLO https://raw.githubusercontent.com/Undermix96/heph/main/compose.yaml
docker compose up -d
```

To update: `docker compose pull && docker compose up -d`. Pin a version with `HEPH_TAG` in `.env` (e.g. `HEPH_TAG=sha-cde56b2`).

To build from source instead of pulling: `docker compose -f compose.yaml -f compose.build.yaml up -d --build` in a clone of the repo.

Then open `http://<server>:8080` and complete the one-time setup wizard (username + password). The wizard shows the **API token** once; you can see it again later in Settings.

| Port   | Serves                                                                           | Expose                                          |
| ------ | -------------------------------------------------------------------------------- | ----------------------------------------------- |
| `8080` | Web UI + REST API (`/api`)                                                       | LAN, and through your Cloudflare Tunnel         |
| `8081` | MCP (`/mcp`), REST API with the token, one-time uploads (`/upload`), later hooks | **LAN only**: never route it through the tunnel |

To change the host ports or time zone, copy `.env.example` to `.env` and edit it.

Data lives in two named volumes: `heph-db` (`/data/db`, SQLite) and `heph-files` (`/data/files`, uploads and thumbnails). They must be on local storage, not NFS/SMB. Back up by copying both volumes while the container is stopped.

### Recovery and maintenance

```sh
docker exec -it heph heph reset-password             # new password, signs out all sessions
docker exec -it heph heph reset-password --username me   # also rename the user
docker exec heph heph rotate-token                   # new API token; the old one stops working
docker compose logs -f heph
```

### Connect Claude Code (MCP)

Heph exposes an MCP server at `http://<server>:8081/mcp` (Streamable HTTP, bearer token). Register it once at user level, with the API token from the setup wizard or Settings:

```sh
claude mcp add --scope user --transport http heph http://<server>:8081/mcp \
  --header "Authorization: Bearer <api-token>"
```

Then ask Claude Code for the briefing of a project (tool `get_briefing`), or use the `heph_overview` and `heph_resume` prompts. Destructive changes Claude asks for (deleting phases or tasks, restructuring the roadmap, marking a project completed or abandoned) are stored as proposals for you to approve, unless you confirmed them in the chat. After `heph rotate-token`, update the header.

The Claude Code plugin (phase 5) will replace this manual step and add the hooks that keep the diary up to date.

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
```

Layout: `packages/schema` (shared Zod schemas and types), `packages/core` (database, migrations, domain layer), `apps/server` (HTTP adapters and the `heph` CLI), `apps/web` (web UI).

## Documentation

- [`docs/HANDOFF.md`](docs/HANDOFF.md): product spec and scope.
- [`DECISIONS.md`](DECISIONS.md): architectural and technical decisions.
- [`docs/design/`](docs/design/): approved UI design (mockups, tokens).

## License

[MIT](LICENSE)
