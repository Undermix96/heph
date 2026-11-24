# Decisions

Durable architectural and technical decisions for Hephaestus (heph), numbered `D<n>`, newest at the bottom.
Entries are never renumbered or rewritten; superseded ones are marked. Cite them in code as `D14`, spec sections as `§4.2` (spec: `docs/HANDOFF.md`).
Work state lives in [`PROGRESS.md`](PROGRESS.md), not here.

---

## D1 — TypeScript end to end (2026-11-24)

Decision: Server, MCP server, CLI, shared schemas and web UI are all written in TypeScript (§3).
Why: One language and one type system across every layer; Zod schemas and inferred types are shared by REST, MCP and the frontend without code generation.
Alternatives rejected:

- Go or Rust backend: faster, but schemas would have to be duplicated or generated for the TS frontend.
- Python backend: same duplication problem, and a second toolchain in one container.

## D2 — SQLite as the only datastore (2026-11-24)

Decision: SQLite in WAL mode with FTS5 for search; the DB file lives on a local Docker volume (`/data/db`), never on NFS/SMB (§3).
Why: Single user, small data, one container; no database service to run; WAL allows reads during writes. Network filesystems break SQLite locking.
Alternatives rejected:

- PostgreSQL: a second service to run and back up for no benefit at this scale.
- JSON files: no transactions, no full-text search.

## D3 — Single container, two ports (2026-11-24)

Decision: One image, one container, two ports: UI + REST (published through a Cloudflare Tunnel behind Access) and the agent port (LAN only) (§4).
Why: Trivial deployment while keeping the agent surface, protected by a static token, off the internet.
Alternatives rejected:

- One port with path-based rules at the proxy: one misconfiguration would expose the agent endpoints.
- Two containers: more moving parts for a single-user app.

## D4 — No dependency on Cloudflare Access headers (2026-11-24)

Decision: The app never inspects Cloudflare Access headers or JWTs; it has its own authentication and behaves the same on the LAN and through the tunnel (§4).
Why: Access is an outer layer, not the app's auth (defense in depth); depending on it would break LAN access.
Alternatives rejected:

- Trusting the Access JWT as login: no auth on the LAN, and coupling to one hosting setup.

## D5 — Web authentication: single user, setup wizard, sessions (2026-11-24)

Decision: Username + password, no registration page. A one-time setup wizard creates the only user. Passwords hashed with argon2id; httpOnly session cookie, `Secure` when the request came over HTTPS; password change in settings; `heph reset-password` in the container (§4).
Why: The smallest auth that is still safe for one user; the CLI guarantees recovery even if the UI is unusable.
Alternatives rejected:

- OAuth/OIDC: deferred to a later phase (§12.8); too much setup for one user now.
- HTTP basic auth: no logout, no session control, credentials on every request.

## D6 — Static bearer token for API, MCP and hooks (2026-11-24)

Decision: A static API token generated during setup, shown in settings, regenerable from the UI and `heph rotate-token`; required by MCP and the hook endpoints (§4).
Why: Claude Code hooks and MCP config need a non-interactive credential that fits in an environment variable (`HEPH_TOKEN`).
Alternatives rejected:

- OAuth for MCP: heavy for a single LAN user; revisit with D5's OAuth phase.
- Per-session tokens: hooks have no interactive step to obtain them.

## D7 — The agent is a first-class user: one domain layer, thin adapters (2026-11-24)

Decision: Every operation lives in one domain layer (`packages/core`); REST, MCP, CLI and the web UI are thin adapters; no UI-only features (§2.1).
Why: Claude Code must be able to do everything the user can; logic in one place keeps adapters from drifting.
Alternatives rejected:

- Business rules in route handlers: duplicated between REST and MCP.
- MCP calling the REST API over HTTP: an extra hop and a second serialisation layer for no gain.

## D8 — Intent-level MCP tools, not CRUD mirrors (2026-11-24)

Decision: MCP tools express meaningful actions (`get_briefing`, `log_progress`, `complete_task`, …); `get_briefing` is the entry point (§2.2, §8).
Why: An agent works better with purposeful tools that return ready-to-use context than with many low-level ones it must orchestrate.
Alternatives rejected:

- Generic CRUD tools per table: more calls, more tokens, more room for inconsistent writes.

## D9 — No LLM inside the app (2026-11-24)

Decision: The app embeds no language model; it stores, computes and serves. Intelligence lives in the client (§2.3).
Why: No API keys, cost, latency or non-determinism on the server; the client already has a better model and the user's context.
Alternatives rejected:

- Server-side summaries with an LLM API: paid, slower, and duplicates what Claude does in the session.

## D10 — Markdown for all free text (2026-11-24)

Decision: Descriptions, notes, status notes, diary bodies and internal docs are Markdown (§2.4).
Why: What Claude writes natively; diffs well; exports cleanly.
Alternatives rejected:

- Rich-text JSON (ProseMirror etc.): heavier, and awkward for the agent to produce.

## D11 — Append-only diary and source on every change (2026-11-24)

Decision: The diary is append-only; every change records its source (`ui`, `claude_code`, `github`, `system`) and is revertible where it makes sense (§2.5).
Why: The diary is the memory that lets the user resume; it must be trustworthy and say who did what.
Alternatives rejected:

- Editable diary entries: history could silently change.

## D12 — Graduated trust for agent writes (2026-11-24)

Decision: Additive agent operations apply directly; destructive ones (delete phase/task, restructure roadmap, `completed`/`abandoned`) need an explicit user-confirmed flag or become a Proposal approved in the UI (§2.6).
Why: The agent works autonomously on the common path; irreversible changes stay under the user's control.
Alternatives rejected:

- Proposals for every agent write: too much friction.
- No gating: one bad agent call could wipe a roadmap.

## D13 — MCP over Streamable HTTP (2026-11-24)

Decision: Official TypeScript MCP SDK, Streamable HTTP transport, bearer token, LAN-only port (§3, §8). Refined by D35 and D36.
Why: One long-running server serves every Claude Code session on the LAN.
Alternatives rejected:

- stdio: needs a local process per machine with database access.

## D14 — Agent file uploads via one-time URLs (2026-11-24)

Decision: Claude asks for a one-time upload URL (`request_upload`) and uploads with `curl -F file=@path <url>`; file content is never passed as base64 in tool arguments (§8).
Why: Base64 in tool calls wastes context tokens and breaks on large files; curl streams from disk.
Alternatives rejected:

- Base64 in a tool argument: token cost, size limits.
- A shared folder mount: ties the app to one dev machine.

## D15 — Work state in the app, decisions in the repo (2026-11-24)

Decision: Where a project stands lives in the app (diary, phases, next task, briefing); decisions live in each repo as `DECISIONS.md` (path configurable); projects without a repo use internal Markdown docs (§7).
Why: Work state changes constantly and fits structured data; decisions are durable and belong with the code.
Alternatives rejected:

- A HANDOFF/PROGRESS file per repo: drifts, and is invisible from the dashboard.

## D16 — English for docs, code comments and commits (2026-11-24)

Decision: Documentation, code comments and commit messages are English; diary content follows the "content language" setting; UI in Italian and English (§7).
Why: Code artifacts stay readable and consistent; the diary is personal.
Alternatives rejected:

- Everything in Italian: inconsistent with public code and tooling.

## D17 — GitHub integration by polling, read-only (2026-11-24)

Decision: Polling with a fine-grained read-only token at a configurable interval; commits (grouped) and releases become diary events; docs fetched from repos; no webhooks, no issue sync (§10).
Why: The server is LAN-only, so GitHub cannot reach it; read-only minimises risk.
Alternatives rejected:

- Webhooks: need a public endpoint.
- Issue sync: duplicates GitHub; tasks link to issues by URL instead.

## D18 — Claude Code integration as a plugin in this repo (2026-11-24)

Decision: A Claude Code plugin versioned in this repo bundles MCP config (`HEPH_URL`, `HEPH_TOKEN`), hooks and skills; installed once at user level; hook scripts depend only on `git` and `curl` where possible (§9).
Why: One install covers every project; versioning it with the server keeps the hook ↔ endpoint contract in sync.
Alternatives rejected:

- Manual per-project configuration: easy to forget, drifts.

## D19 — Global rules injected by the SessionStart hook (2026-11-24)

Decision: The rules Claude follows in every project are injected by the `SessionStart` hook with the briefing, not written to `~/.claude/CLAUDE.md` (§9).
Why: Plugins cannot install a user CLAUDE.md, and the user's own CLAUDE.md stays free.
Alternatives rejected:

- Asking the user to paste rules into their CLAUDE.md: manual and drifts from the server.

## D20 — Two-level roadmap, minimal planning model (2026-11-24)

Decision: Exactly two levels (macro-phases → tasks); no subtasks, due dates, priorities or estimates in v1; always one next task (computed, overridable) (§5).
Why: The goal is resuming work, not project management.
Alternatives rejected:

- Arbitrary nesting or a full PM model: more UI and agent complexity for no gain in the core job.

## D21 — Node.js 26 LTS (2026-11-24)

Decision: Target Node.js 26 ("Lithium"), pinned in `.nvmrc` and the Docker base image.
Why: Current Active LTS with the longest support window. Checked on 2026-11-24 against https://nodejs.org/dist/index.json (latest LTS v26.13.1, released 2026-11-10).
Alternatives rejected:

- Node 24 (Maintenance LTS): shorter support window.

## D22 — Dark theme only for the first UI (2026-11-24)

Decision: The approved design (`docs/design/`) is dark only; the UI uses `docs/design/tokens.css` so a light theme can be added; styling isolated from logic.
Why: Matches the approved design while keeping a light variant possible.
Alternatives rejected:

- Designing both themes now: not part of the approved design.

## D23 — Conflict rule between spec and design (2026-11-24)

Decision: When `docs/HANDOFF.md` and `docs/design/` disagree, the spec wins; a design choice is adopted only if it adds something without contradicting the spec.
Why: The spec is the agreed scope; the design is the visual layer (user decision, 2026-11-24).
Alternatives rejected:

- Design wins: it would change agreed behaviour (thresholds, retention, badge order).

## D24 — Hooks and agent uploads are served on the LAN agent port (2026-11-24)

Decision: `/mcp`, `/hooks/*` and `/upload/*` are served on the agent port (default 8081); `HEPH_URL` points there. REST is on both ports: cookie or token on the UI port, token only on the agent port.
Why: The UI port sits behind Cloudflare Access, which would block `curl` from hooks and uploads; §11 lists these under REST without naming a port.
Alternatives rejected:

- Hooks on the UI port with an Access service token: more setup, and exposes them to the internet.

## D25 — Badge precedence vs dashboard ordering (2026-11-24)

Decision: The badge follows §6 precedence: live activity (`claude_testing` > `claude_working`) → lifecycle → recency. Dashboard ordering follows the §6 list (awaiting manual test first). They are separate computations.
Why: Spec §6 wins over the design's badge table (D23).
Alternatives rejected:

- The design's badge order (awaiting test above live activity): contradicts §6.

## D26 — Next task: computed default with override (2026-11-24)

Decision: The next task is the override if it points to an open task, else the first open task of the first non-done phase; completing the override clears it; "no next step" means no open task in non-done phases; `complete_task` returns the new next task (§5).
Why: Spec §5; the design's "suggest but don't pick" contradicts it.
Alternatives rejected:

- An explicit pointer only (design §9): projects would lose their next step after every completion.

## D27 — Activity thresholds and session expiry defaults (2026-11-24)

Decision: `recently_active` < 7 days, `inactive` > 30 days (spec), live sessions expire after 30 minutes without events; all configurable.
Why: Spec wins (D23); values to be tuned after real use (§13).
Alternatives rejected:

- The design's 3 / 21 days: contradicts §6.

## D28 — Screenshot retention: last N per target (2026-11-24)

Decision: Unpinned Claude Code uploads are kept up to the last N (default 20) per attached target; older ones are deleted; pinned files never are.
Why: Spec §5 wins over the design's age-based expiry (D23).
Alternatives rejected:

- Delete after N days (design): contradicts §5.

## D29 — Phase status is stored and kept in sync with tasks (2026-11-24)

Decision: `phases.status` is stored and settable; task changes keep it in sync (all done → `done`; reopened or partly done → `in_progress`); progress is always computed.
Why: §5 lists status as a field and progress as computed; syncing prevents a done-looking phase from blocking the next-task computation.
Alternatives rejected:

- Fully computed status: the user could not mark an empty phase done.
- Fully manual status: easy to forget, breaks D26.

## D30 — Docs per repo (2026-11-24)

Decision: `projects.docs_source` selects `repo` or `internal`; with `repo`, every linked repo has its own docs path (default `DECISIONS.md`) and cached content; the Documentation tab shows one entry per repo.
Why: §7 makes the path configurable per repo while projects can have many repos.
Alternatives rejected:

- One docs path per project: ambiguous with several repos.

## D31 — Diary strictly append-only; reverts via change log (2026-11-24)

Decision: Diary entries are never edited or deleted through the API; every mutation writes a `change_log` row (before/after JSON, source, session); a revert applies the inverse and appends a compensating event.
Why: §2.5.
Alternatives rejected:

- Editable or soft-deletable notes: weakens the trust D11 relies on.

## D32 — Small additions adopted from the design (2026-11-24)

Decision: Per-project `claude_write_enabled`; `decision_note` on proposals that Claude can read; per-repo `show_commits`; a `content_language` setting (§7). Export stays Markdown + files in a zip, plus a `project.json`.
Why: They improve the product without changing agreed behaviour (D23).
Alternatives rejected:

- JSON-only export (design): §11 asks for Markdown.

## D33 — Monorepo layout and core libraries (2026-11-24)

Decision: npm workspaces: `packages/schema` (Zod), `packages/core` (Drizzle schema, migrations, domain), `apps/server` (Hono adapters, CLI), `apps/web` (Vite + React). Libraries: Hono, Zod v4, Drizzle + better-sqlite3, @node-rs/argon2, sharp, busboy, pino, Vitest, Biome. Integer ids. _Timestamp storage superseded by D39._
Why: No extra package manager (corepack is gone from Node 25+); one domain package for all adapters; mature, light dependencies; short integer ids are easy for an agent to reference.
Alternatives rejected:

- pnpm: one more tool to install.
- Express/Fastify: heavier; Hono is web-standard and testable in-process.
- Prisma: heavier runtime and engine binary.
- UUIDs: long for the agent to reference.

## D34 — Diary keyset pagination and no all-digit slugs (2026-11-24)

Decision: Diary lists paginate with a keyset cursor (`before` = occurredAt, `beforeId` = id). Slugs are never only digits (generated ones get a `p-` prefix; explicit ones are rejected), so an all-digit project reference is always an id.
Why: Found by the domain tests: timestamp-only cursors skipped entries; digit-only slugs were unreachable.
Alternatives rejected:

- Offset pagination: skips or repeats entries while new ones are added.

## D35 — MCP server: SDK v2, stateless, on the agent port (2026-11-24)

Decision: `@modelcontextprotocol/server` v2 (stable line, MCP 2026-07-28) through `createMcpHandler`, which also serves 2025-era clients with a stateless fallback; a fresh `McpServer` per request; `POST /mcp` on the agent port, bearer token, cross-origin requests refused. Checked on 2026-11-24: server 2.4.0 on npm. Verified with the real Claude Code CLI 2.1.331 on 2026-11-24.
Why: Works with whichever protocol revision the client speaks and survives restarts.
Alternatives rejected:

- SDK v1 (`@modelcontextprotocol/sdk`): replaced by v2.
- Stateful sessions: state to keep and lose on restart, no benefit for request/response tools.

## D36 — MCP tool conventions (2026-11-24)

Decision: Compact Markdown results with ids as `#42`; domain errors as tool errors (`isError`); optional `session_id` on every write tool; `get_briefing` resolves project → repo (also git remote URLs) → session; single moves and edits apply directly; deletes, restructuring and `completed`/`abandoned` need `confirmed: true` or become proposals; material deletion not exposed over MCP; positions are 1-based for the agent.
Why: Intent-level tools (D8) with graduated trust (D12).
Alternatives rejected:

- JSON results: more tokens, less readable for the agent.
- Protocol errors for domain failures: the agent cannot recover as easily.

## D37 — "Confirmed in chat" is recorded and can be disabled (2026-11-24)

Decision: When the agent passes `confirmed: true`, `change_log.confirmed` and the diary event record it; the setting `allowClaudeConfirm` (default on) forces every destructive agent change through a proposal when off.
Why: The flag is self-reported by the agent; the user needs visibility and an opt-out.
Alternatives rejected:

- Not offering a confirmed flag: every agreed change would need a UI round trip.

## D38 — Roadmap restructuring as a batch of operations (2026-11-24)

Decision: `restructure_roadmap` takes operations (`add_phase`, `update_phase`, `move_phase`, `delete_phase`, `add_task`, `update_task`, `move_task`, `delete_task`); new phases get a temporary `ref` (never digit-only); validated when proposed and again when approved; applied in one transaction; the proposal stores a before/after outline.
Why: A coherent reorganisation the user approves or rejects as a whole.
Alternatives rejected:

- A free-form "replace the roadmap" payload: hard to review and validate, loses ids.

## D39 — Timestamps as UTC ISO 8601 strings (2026-11-24)

Decision: Database columns store UTC ISO 8601 text with milliseconds (`2026-11-24T12:00:00.000Z`) through the `isoTime` column type; the domain computes in unix ms; views, REST and MCP expose ISO strings; the diary cursor `before` is an ISO time. Supersedes the timestamp part of D33.
Why: User rule "timestamps in UTC as ISO strings" (global CLAUDE.md, user decision 2026-11-24). Fixed-width ISO keeps text order equal to time order, so comparisons and ORDER BY stay correct.
Alternatives rejected:

- Keep unix ms: contradicts the rule; unreadable in the DB and the API.
- ISO strings throughout the domain: every expiry and threshold calculation would parse strings.

## D40 — Migrations regenerated from scratch before first production use (2026-11-24)

Decision: The migrations were regenerated as `0000_init` + `0001_search_fts` for D39; existing databases must be recreated.
Why: Nothing is in production and there is no data to keep (user decision, 2026-11-24). From now on migrations are append-only and never edited once merged.
Alternatives rejected:

- A conversion migration from integers to text: work for data that does not exist.

## D41 — Hardened container (2026-11-24)

Decision: The container runs as the non-root `node` user with a read-only root filesystem, a tmpfs `/tmp`, all Linux capabilities dropped and `no-new-privileges`; only the two data volumes are writable. `compose.yaml` and the smoke test use the same flags, and the smoke test asserts them.
Why: User rule for container deployments (global CLAUDE.md); limits what a compromised process can do.
Alternatives rejected:

- Default Docker settings: a writable image filesystem and default capabilities for no need.

## D42 — CalVer multi-arch releases (2026-11-24)

Decision: Releases are triggered manually by the Release workflow: version `YYYY.MM.DD-b<N>` (N = releases that UTC day + 1), amd64 smoke test first, then a multi-arch image (linux/amd64 + linux/arm64) pushed to `ghcr.io/undermix96/heph` with tags `<version>`, `latest` and `sha-<short>`, a git tag and a GitHub release listing the commits since the previous release. The version is exposed in `/health` and as the MCP server version. The server only pulls published images.
Why: User rules on versioning and multi-arch images (global CLAUDE.md, user decision 2026-11-24).
Alternatives rejected:

- SemVer: the user's convention is CalVer.
- Building on the server: the server only pulls.

## D43 — Secret scanning and dependency updates (2026-11-24)

Decision: gitleaks v8.30.1 scans staged changes in a versioned pre-commit hook (`.githooks`, set up by `npm install`; local binary or the pinned Docker image) and the full history in CI. Dependabot opens weekly grouped updates for npm, GitHub Actions and the Docker base image.
Why: User rules (global CLAUDE.md); the repo is public. Version checked on 2026-11-24 (winget and ghcr.io).
Alternatives rejected:

- CI-only scanning: a secret would already be pushed.
- The gitleaks GitHub Action: running the pinned image keeps CI and the hook on the same version.

## D44 — Error texts: fixed for the UI, detailed for the agent (2026-11-24)

Decision: The REST/MCP error format keeps `code` and the domain `message` (the agent needs the detail to recover). The web UI (phase 4) shows fixed, translated texts per error `code` with an action, never the raw message.
Why: User rule "user-facing errors are fixed texts per error type" (global CLAUDE.md) balanced with D36; user decision, 2026-11-24.
Alternatives rejected:

- Fixed texts in the API too: the agent could no longer tell what to fix.

## D45 — API token stays readable in Settings (2026-11-24)

Decision: The API token is stored readable and shown in Settings as §4 requires; the GitHub token is write-only (the API returns only whether it is set).
Why: The project spec wins over the global write-only-secrets rule (the global rules give the project precedence); user decision, 2026-11-24.
Alternatives rejected:

- Write-only API token: contradicts §4 ("shown in settings") and the "Connect Claude Code" page.
