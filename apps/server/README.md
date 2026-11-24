# @heph/server

HTTP adapters and the `heph` CLI over `@heph/core`. One process serves two ports (D3, D24):

| Port                   | App              | Serves                                                   | Auth                                                  |
| ---------------------- | ---------------- | -------------------------------------------------------- | ----------------------------------------------------- |
| UI (8080)              | `createUiApp`    | web UI, `/api` (REST), `/api/setup`, `/health`           | session cookie or bearer token                        |
| Agent (8081, LAN only) | `createAgentApp` | `/mcp` (D35), `/api` (REST), `/upload/:token`, `/health` | bearer token only; upload URLs carry a one-time token |

| Path                     | Contents                                                                            |
| ------------------------ | ----------------------------------------------------------------------------------- |
| `src/main.ts`            | Boot: config, DB, both servers, housekeeping (expired sessions, temp uploads).      |
| `src/config.ts`          | Environment variables (`HEPH_DATA_DIR`, `HEPH_UI_PORT`, `HEPH_AGENT_PORT`, …).      |
| `src/routes/`            | REST routes (`api.ts`), auth and setup (`auth.ts`), one-time uploads (`upload.ts`). |
| `src/mcp/`               | MCP server: tools and prompts (`server.ts`), Markdown formatters, the `/mcp` route. |
| `src/http/`              | Error mapping, auth middleware, streaming multipart parser.                         |
| `src/cli.ts`, `src/cli/` | `heph reset-password`, `heph rotate-token` (`docker exec -it heph heph …`).         |
| `src/test/`              | Test harness: in-process apps, real-port MCP client helpers.                        |

Commands (from the repo root): `npm run dev` (watch mode, data in `./data`), `npm run build -w @heph/server` (bundle to `dist/` with tsdown; npm packages stay external).
