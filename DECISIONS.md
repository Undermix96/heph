# Decisions

Durable architectural and technical decisions for Hephaestus (heph), numbered `D<n>`, newest at the bottom.
Entries are never renumbered or rewritten (the one-time conversion to `D<n>` numbering on 2026-11-24 kept every entry and its order); superseded ones are marked. Cite them in code as `D14`, spec sections as `§4.2` (spec: `docs/HANDOFF.md`).
Work state lives in Heph itself (project `hephaestus`, via the MCP server; D47), not here.

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

Decision: The container runs as the non-root `node` user with a read-only root filesystem, a tmpfs `/tmp`, all Linux capabilities dropped and `no-new-privileges`; only the two data volumes, `/tmp` and Docker's default in-memory `/dev/shm` are writable. `compose.yaml` and the smoke test use the same flags, and the smoke test asserts them.
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

## D46 — Global cap on failed logins (2026-11-24)

Decision: Besides 10 failures per client address, the login limiter caps failures at 100 per 15-minute window across all clients; past either limit, logins get 403 until the window ends. All login attempts are evaluated one at a time in a single queue (at most 50 waiting, then 429), so concurrency cannot exceed either cap. Invalid login bodies are rejected (400) before the limiter.
Why: Per-address accounting with bounded memory cannot be exact against an attacker with more than 10 000 addresses (e.g. an IPv6 range): evicting entries resets their counts (found by independent verification, 2026-11-24). For a single-user app a global cap bounds password guessing regardless of address count.
Alternatives rejected:

- Unbounded per-address memory: memory exhaustion.
- Per-address limits only: unbounded guesses with enough addresses.
- Account lockout until reset by CLI: too easy to turn into a permanent denial of service.

## D47 — Work state tracked in Heph, PROGRESS.md removed (2026-11-24)

Decision: From release `2026.11.24-b1` the work state of this repository (roadmap, tasks, next step, diary, open questions) lives in Heph's own project `hephaestus`, written through the `heph` MCP server; `PROGRESS.md` is deleted and its content moved into Heph (phases 1–3 as done, phases 4–8 per §12, open questions as a diary note). Decisions stay in this file.
Why: The project CLAUDE.md planned the switch once Heph runs; Heph tracking itself dogfoods the product (user decision, 2026-11-24).
Alternatives rejected:

- Keeping `PROGRESS.md` alongside Heph: two sources of truth that drift.
- Waiting for the web UI (phase 4): the MCP server already covers reading and writing work state.

## D48 — Web UI libraries for phase 4 (2026-11-24)

Decision: On top of React + Vite (D33) the web UI uses React Router (routes and shareable URLs per tab), TanStack Query (server state, cache, invalidation), react-markdown + remark-gfm (Markdown without raw HTML), dnd-kit (accessible drag and drop, plus _Move up / down_ in the ⋯ menu), and Octicons (`@primer/octicons-react`) for icons. i18n uses typed IT/EN dictionaries and `Intl` (no library). Styling is plain CSS per component using only `tokens.css` variables. Tests add Testing Library, happy-dom, MSW (fake API built on the `@heph/schema` contract) and Playwright with axe (end-to-end, screenshots at 1440 and 390 px, accessibility). Licenses checked on 2026-11-24 with `npm view`: all MIT except Playwright (Apache-2.0) and `@axe-core/playwright` (MPL-2.0), both dev-only.
Why: Phase 4 plan approved by the user on 2026-11-24. Mature libraries for the hard parts (routing, server state, safe Markdown, accessible reordering), none for what a little glue code covers (i18n). Octicons is MIT as `docs/design/DESIGN.md` §1 asks and matches the design's Primer style.
Alternatives rejected:

- Lucide: ISC rather than the MIT the design names, and a less Primer-like look.
- i18next: a dependency where typed dictionaries already catch missing keys at typecheck.
- Tailwind or CSS-in-JS: scatters values outside the design tokens.
- Rendering Markdown with raw HTML and a sanitizer: more attack surface than not allowing HTML at all.

## D49 — Design elements of later phases in the phase 4 UI (2026-11-24)

Decision: Screens from `docs/design/` that depend on later phases are built in phase 4 only as far as the server already supports them ("Connect Claude Code": API token show / copy / rotate; GitHub token: write-only setting). The rest (test-command recognition, _Sync now_, the live Claude queue) appears as a disabled placeholder saying which phase brings it.
Why: Keeps the layout of the approved design without UI that does nothing (user decision, 2026-11-24).
Alternatives rejected:

- Building the full screens now: no backend behind them until phases 5–6.
- Leaving them out: the layout would change again later.

## D50 — Design extras left out of phase 4 (2026-11-24)

Decision: Bulk actions on the dashboard multi-select bar, CSV export of materials, the project cover image and the "conflicting edit" warning are not built in phase 4.
Why: Not in the spec (§12.4); none is needed by the phase 4 acceptance criteria (user decision, 2026-11-24, D23).
Alternatives rejected:

- Building them now: more scope and API for features nobody asked for yet.

## D51 — Revert API postponed (2026-11-24)

Decision: The revert API on top of `change_log` (D31) is not part of phase 4; the open question on which changes are revertible stays open.
Why: No phase 4 acceptance criterion needs it (user decision, 2026-11-24).
Alternatives rejected:

- Designing it with the UI: decides revert semantics before real use shows what needs undoing.

## D52 — Live updates in the web UI by polling (2026-11-24)

Decision: The web UI refetches the data of the visible screen every 10 seconds while the tab is visible (TanStack Query `refetchInterval`, paused in background tabs) and after every own mutation.
Why: The simplest way to show Claude's changes without reloading; one user and small payloads make the cost negligible (user decision, 2026-11-24).
Alternatives rejected:

- Server-Sent Events: a new long-lived endpoint and reconnect logic for little gain at this scale.
- No refresh: Claude's changes would only appear after a manual reload.

## D53 — Project export as a streamed zip built with fflate (2026-11-24)

Decision: `GET /api/projects/:ref/export` streams a zip with `<slug>.md` (the whole project in one Markdown file), `project.json` (format `heph-project-export`, version 1) and `files/<id>-<safe name>` for every file present on disk; `?format=md` returns the Markdown alone. The domain (`ExportService`) builds the content; the HTTP adapter builds the archive with fflate 0.8 (MIT, no dependencies), compressing the Markdown and JSON and storing uploads as they are, with backpressure so memory does not grow with the archive. fflate writes no Zip64, so an export whose content plus 1 KiB per entry plus 1 MiB reaches 4 GiB, or that has 65 535 entries, is refused with `too_large` (413) before streaming. Archive names never contain directories from the original file name. Files missing on disk are listed as such, not exported. `GET /api/projects/:ref/docs` exposes the cached repo docs for the Documentation tab.

The Markdown (`export-md.ts`) is built as mdast nodes, never by joining strings: the export's own structure (headings, lists, the materials table, names, titles, tags, labels, paths, currency as text and link nodes) plus the user Markdown (descriptions, task notes, docs, diary) parsed with `mdast-util-from-markdown` + GFM, with headings moved down two levels (at most 6), and written with `mdast-util-to-markdown` (all MIT, unified), which escapes text and picks bullets in context. Line endings are normalised and NUL becomes U+FFFD first. A field nested deeper than 32 levels (lists, quotes, emphasis) goes verbatim: the writer recurses per level and is superlinear in nested emphasis (a 2 KB field overflowed the stack or took 25 s, sixth verification round); any writer or parser error in a segment also falls through to the next mode. Raw HTML that could swallow later content becomes code (an HTML block of types 1–5 without its end condition becomes an `html` code block, inline HTML spanning lines becomes inline code); other raw HTML is kept.

"Do not break" (comment in `export-md.ts`): the document is written in segments that each start with one of the export's own headings (one per section, phase, repo docs and diary entry). Each segment is re-parsed with a sentinel heading after it and must have exactly the intended structure (compared ignoring positions, list spread, whitespace runs, URLs and the link/text distinction); otherwise its user fields are retried with all raw HTML as code, then verbatim in a `markdown` code block. Because every segment ends closed and the next starts with an ATX heading, this is as strong as checking the whole document, and the superlinear parser only ever sees one segment. So the export always has one level-1 heading, the six section headings in order, one heading per phase and diary entry and one list item per task, whatever users wrote.

Known limitations, accepted by the user on 2026-11-25 and kept as `it.fails` tests: the writer does not round-trip every nested construct exactly (a table after a nested list in a quoted list item, an HTML block after a list item, a hard break inside a setext heading, tight vs loose list items, a soft line break before inline HTML becoming a space); a segment that fails the check is exported with user Markdown as code instead of rendered; link and footnote definitions resolve across fields when the file is read as a whole; raw `<h1>` HTML passes through. Speed measured by the author on 2026-11-25 on this machine: 1000 diary entries (549 KB of Markdown) 5.5 s; a single 125 KB field 2.1 s and a single 1 MB field 43 s (two parses, superlinear in `fromMarkdown`); the export runs synchronously in the request.
Why: Spec §11 and D32; fflate, the Markdown parser and the limitations chosen by the user on 2026-11-24 and 2026-11-25. Seven independent verification rounds drove the escaping, HTML and checking rules; string-level fixes kept failing on context (lists next to lists, notes inside list items, character references writing real line breaks).
Alternatives rejected:

- yazl: one dependency and no release since 2024.
- archiver: nine dependencies for a single zip.
- Building the archive in memory: memory grows with the project's files.
- Demoting headings with regular expressions: two independent verification rounds found CommonMark cases it got wrong (CRLF, block quotes, lists, HTML).
- User Markdown verbatim inside code fences: robust and fast, but the `.md` would show source instead of rendered text (user decision, 2026-11-25).
- Writing each user field to a string and joining: the writer cannot see the surrounding context; the fifth verification round broke it three ways.
- Checking the whole document in one parse: the parser is superlinear, so large projects would take minutes.

## D54 — Threat model: trusted LAN, good-faith users (2026-11-25)

Decision: Hephaestus is a personal project used only on the owner's trusted LAN and through Cloudflare Access. Tests and independent verification target bugs of normal use by good-faith users (the owner and Claude Code): realistic content, mistakes, real workflows and concurrency. They do not model malicious attackers, crafted payloads, denial of service or adversarial input. Existing security baselines (authentication in the app, login limits, secrets handling, hardened container) stay.
Why: User decision, 2026-11-25, after the phase 4.0 export went through six adversarial verification rounds that hardened it against hostile Markdown nobody would write; the effort did not match the risk of a single-user, trusted-network app.
Alternatives rejected:

- Public-app threat model: costs far more than the risk of a personal LAN tool justifies.
- Removing the hardening already done (D46, D53 checks): it works and is tested; removing it is work with no benefit.

## D55 — Faster workflow: grouped steps, verification per group (2026-11-25)

Decision: For this project, the global rule "independent verification after each step" is replaced by: steps are grouped (phase 4 remaining work in three groups: A app shell, dashboard and project page with roadmap; B diary, docs, materials, files, proposals, settings and export in the UI; C empty/loading/error states, phone layout, accessibility, Playwright end-to-end and screenshots, release); each working step is still a commit with its tests; only affected tests run during development and the full CI checks once before each commit; the local Docker smoke test runs only when Docker files or dependencies change; one independent verification per group by a fresh subagent on the same model, in depth but within the D54 threat model; at most 2 rounds per group, plus up to 2 more only if the second round finds serious problems for D54; findings outside D54 are listed, not fixed; Playwright end-to-end tests and screenshots only in the last group of a phase. Recorded in the project CLAUDE.md.
Why: Sub-phase 4.0 took a full day and about 1.06 million subagent tokens in eight verification rounds; the user asked to speed up and save usage while keeping in-depth tests (user decision, 2026-11-25).
Alternatives rejected:

- A cheaper model for verification: the user wants in-depth verification kept.
- A hard cap of 2 rounds: serious problems found in round 2 must still be fixed and verified.
- Verification after every step (global rule): too costly for the pace needed.

## D56 — Phase 4 group C: touch targets, e2e in CI, diary months, UTF-8 bodies (2026-11-25)

Decision: On the phone (below 600 px) interactive controls are at least 44 px high (and icon buttons 44 px wide), through a Heph token `--control-touch-min: 44px` added to the copy of the design tokens. Playwright end-to-end tests, axe accessibility checks (no serious or critical WCAG 2.1 AA violations) and screenshots at 1440 and 390 px run locally (`npm run e2e`) and in a separate `e2e` CI job against the real server with invented data. The diary month bar uses `GET /api/projects/:ref/diary/months` and `GET /api/diary/months` (entry counts per UTC month). REST request bodies must be valid UTF-8 and are refused with a validation error otherwise.
Why: User decisions on the group C plan, 2026-11-25. The owner's global rule asks for 44 px touch targets where the design says 40 px; e2e in CI catches UI regressions on every push; jumping to a month not yet loaded needs counts from the server; task #42 showed a Windows shell sending Latin-1, which a lenient decoder stored as U+FFFD without any error.
Alternatives rejected:

- 40 px controls (design): below the owner's rule.
- E2E only locally: regressions would wait for the next manual run.
- Month counts from the loaded entries only: cannot jump to months not loaded yet.
- Decoding bodies leniently: silent loss of characters.

## D57 — Plugin configuration and hook transport, from the 5.0 spike (2026-11-26)

Decision: The plugin takes the Heph agent URL and API token through `userConfig` in `plugin.json` (token `sensitive`, kept in the OS secure store), not through `HEPH_URL` / `HEPH_TOKEN` environment variables; the MCP server reads them as `${user_config.*}`, the hooks as `CLAUDE_PLUGIN_OPTION_HEPH_URL` / `CLAUDE_PLUGIN_OPTION_HEPH_TOKEN`. Every hook (SessionStart, Stop, PreToolUse, PostToolUse, SessionEnd) is a shell-form command hook, `bash "${CLAUDE_PLUGIN_ROOT}/scripts/…" <event>`, depending only on `git` and `curl`. Tool hooks match `Bash|PowerShell`. `plugin.json` has no `version`, so the installed version is the commit SHA and `claude plugin update` picks up every push. The plugin and the marketplace (`.claude-plugin/marketplace.json`, source `./plugin`) live in this repo. Supersedes the env-var part of D18 and §9.
Why: User decision of 2026-11-26 (token not in a plain-text file), then measured by the owner in real Claude Code sessions on Windows on 2026-11-26 (Claude Code CLI and desktop app, Git Bash 5.3, checklist in `plugin/SPIKE.md`):

- `claude plugin install` does not prompt for `userConfig`; values are set with `/plugin configure heph@heph`. The sensitive token is not written to `settings.json`.
- `${user_config.*}` works in the `.mcp.json` URL and header. A plugin MCP server pointing at the same server as a manually added one is skipped ("same server as already-configured"), so the manual `heph` server must be removed.
- Shell-form command hooks run in Git Bash and receive both plugin options, including the sensitive token. SessionStart stdout is injected into the context. Stop `{"decision":"block"}` makes Claude continue once; the next call has `stop_hook_active: true`.
- Exec-form hooks (`command` + `args`) lose the backslashes of `${CLAUDE_PLUGIN_ROOT}` on Windows (`C:Usersdev.claude…`), so the script is not found.
- HTTP hooks fire, but `$CLAUDE_PLUGIN_OPTION_HEPH_TOKEN` in `headers` with `allowedEnvVars` resolves to empty: no token reaches the server.
- On Windows, Claude Code often runs shell commands with the PowerShell tool, which a `Bash` matcher misses.
- Without `version`, an update moved the installed copy from `7398bbf0acb6` to `844da1503a38`.
- Observed hook inputs: Stop has `stop_hook_active`, `last_assistant_message`, `background_tasks`; PostToolUse for Bash has `tool_response` with `stdout`, `stderr`, `interrupted`; SessionEnd `reason` was `prompt_input_exit`.
  Alternatives rejected:
- Environment variables (spec §9): the token would sit in plain text in `settings.json` or a shell profile.
- Native HTTP hooks for tool and session-end events: they cannot send the token, and the agent port always checks it (D6, D24).
- Exec-form hooks: broken paths on Windows.
- A pinned `version` stamped at release: updates would need a version bump commit on every release.

## D58 — Hook contract v1 and live sessions (2026-11-26)

Decision: The plugin script (`plugin/scripts/heph-hook.sh`) is a thin forwarder: it POSTs the hook's stdin JSON unchanged to `/hooks/v1/<event>` on the agent port with the API token and git facts as headers (`X-Heph-Remote`, `X-Heph-Head`, `X-Heph-Worktree` = hash of `git status --porcelain`), and prints the response body as the hook output; it never parses JSON beyond reading the session id. SessionStart answers plain text (header + briefing + rules + session id line, at most 9 500 characters: the briefing is compacted, then cut, never the rules); Stop answers 204 or a `{"decision":"block"}` JSON; tool and end hooks answer 204. `GET`/`PUT /hooks/v1/docs` keep the repo's docs file in sync by git blob SHA-1 (`git hash-object --no-filters`), storing the bytes as on disk with origin `hook`. Every hook call upserts the session (created if SessionStart was missed, reopened if it had ended or expired) and links it to the project of its GitHub repo; linking a repo moves its open sessions to that project. A test command (settings `testCommandPatterns`, plain text at the start of a command in a chain, after env assignments, `npx` or PowerShell `&`) marks the session testing until the PostToolUse of the same tool call; overlapping runs are tracked by tool call id; Stop ends any run. MCP writes with a `session_id` heartbeat an open session. Every bearer-token call records the last agent call (throttled to 10 s) for the Connect page.
Why: Spec §5, §6, §9; D57 measured what Claude Code sends. All logic on the server is testable in-process and changes without reinstalling the plugin; the script stays within `git` + `curl`. Group A verification (2026-11-26) found that a cut briefing could drop the rules and the session id, and that moved repos and missed SessionStarts were mishandled; fixed in 1e093d5.
Alternatives rejected:

- Logic in the script (JSON parsing with sed, decisions client-side): untestable on Windows, needs `jq`.
- One endpoint for all events: the URL documents the event and keeps responses simple.
- Ignoring hooks of unknown sessions: a Heph restart during a session would hide it until the next SessionStart.

## D59 — Auto-diary nudge: changes + threshold (2026-11-26)

Decision: At each Stop, Heph asks Claude (block decision) to write a diary note with log_progress when: the Stop is not already a continuation (`stop_hook_active`), the session is linked to a project with Claude write enabled, work changed since the baseline (HEAD moved or `git status` hash changed; baseline = git state at the last diary note of the session, or at session start or the first hook with git facts), and (HEAD moved, or `diaryNudgeTurns` turns, default 5, or `diaryNudgeMinutes`, default 30, since the last note). After a nudge, the next one waits `diaryNudgeTurns` turns; continuation turns are not counted. Outside git only the thresholds count. Notes (not automatic events) from the session reset the counters. Defaults are provisional (§13) and editable in Settings.
Why: User decision of 2026-11-26 among "changes + threshold", "commits only" and "every N turns"; it records uncommitted work without nudging on every turn, and never loops.
Alternatives rejected:

- Commits only: uncommitted work would never be recorded.
- Every N turns: nudges even when nothing changed.

## D60 — Connect Claude Code page and phase 5 scope (2026-11-26)

Decision: Settings > Connect Claude Code shows the steps with copy buttons: add the marketplace, install the plugin, `/plugin configure heph@heph` with the agent URL and the token (show / copy / regenerate), remove a manually added `heph` MCP server, link each repository to its project. The agent URL comes from `HEPH_PUBLIC_AGENT_URL` (now in `compose.yaml` and `.env.example`; also used for upload links); unset, the page shows a TBD hint, because the server cannot know the host port Docker publishes. A status pill shows the last Claude call ("connected" within one hour). The design's step "Heph project slug in the repo's CLAUDE.md" is replaced by linking the repo to its project, since the spec links projects to repos in Heph (§5, §9; spec wins, D23). The live "Claude queue" of mockup 01 is postponed to phase 8 (task #48), so the dashboard placeholder stays. Supersedes the phase 5 parts of D49.
Why: User decisions on the phase 5 plan, 2026-11-26; §4 asks for exact, prefilled commands.
Alternatives rejected:

- Deriving the agent URL from the browser's host and the container port: wrong whenever Docker maps another host port (the owner's server does).
- A UI setting for the agent URL: one more setting for what is deployment configuration.
- Building the queue now: no progress data for its bars, and not needed by the phase 5 acceptance criteria.

## D61 — GitHub integration: port, adapter, polling and errors (2026-11-26)

Decision: The domain defines a `GitHubPort` (`packages/core/src/github.ts`); the server implements it over the REST API (`apps/server/src/github/http.ts`, API version 2022-11-28) with Node's `fetch`: bearer token, ETag conditional requests (one client per token keeps its cache), `Link` pagination, file contents with the raw media type and the git blob SHA computed locally (it equals GitHub's contents `sha`). `GitHubSyncService` runs one sync at a time and re-reads each repo row in its final transaction. The server's 60 s tick polls repos whose `lastPolledAt` is older than `githubPollMinutes`; `POST /api/projects/:ref/github/sync` (Sync now), `POST /api/github/verify` and `GET /api/github/status`. Failures never escape the poller: 401 sets a global "token invalid" state and stops the run; rate limits (403 with no quota, 429, `retry-after`) stop calls until the reset time; 404 or 403 without quota loss is a per-repo "not found or no access"; network and 5xx errors are per-repo and retried at the next interval. Logs carry counts and error codes only. `HEPH_GITHUB_API_URL` points tests and e2e at a local fake; `npm run smoke:github` checks the adapter against the real API on the public repo `octocat/Hello-World` without a token.
Why: Spec §10 and D17. The domain stays free of HTTP (owner's rule: pure core, one adapter per provider). Spike run by Claude on 2026-11-26 against the real API (no token): contents `sha` equals the git blob SHA, `If-None-Match` gives 304 (still counted without a token), `Link` pagination, missing file 404; verification rounds A6 and B6 drove the serialization, fresh-row and error rules.
Alternatives rejected:

- Octokit: a large dependency for six endpoints.
- GraphQL: one more query language for data the REST endpoints return directly.
- Webhooks: the server is LAN-only (D17).

## D62 — What GitHub puts in the diary (2026-11-26)

Decision: Only the repo's default branch is followed. Linking a repo imports the last 365 days once: commits grouped per local day of the server time zone (`TZ`) as one `commits` event per day (`occurredAt` = newest commit of the day; data: repo, branch, day, count, up to 50 commits) and the releases published in that year (drafts skipped, pre-releases marked); afterwards only commits after the last seen one (walking back to it, so merged commits are included; after a force push, only commits newer than its time) and new releases. A relinked repo continues from what the diary already has. `showCommits` off writes no commit events. No GitHub token means no polling and no calls; the UI says so. The diary stays append-only (D11, D31): each sync adds its own `commits` event for a day, and the web UI shows the consecutive events of one repo and day as one box. Up to 2 000 commits are imported per link (older ones in that year are skipped).
Why: Owner decisions of 2026-11-26 (import the last year grouped per day; default branch only; no token, no polling; same-day syncs merged in the UI, not in the database).
Alternatives rejected:

- Import only from the link onwards: the owner wants the year of history.
- All branches: more calls and noise in the diary.
- Polling public repos without a token: 60 requests per hour shared by every repo.
- Updating the day's event in place: breaks the append-only diary.

## D63 — Docs from GitHub and from the Stop hook: the most recent change wins (2026-11-26)

Decision: Both sources key the cached docs by git blob SHA. A poll reads the docs file only when GitHub's SHA differs from the last one read from GitHub (`docsGithubSha`) and then also stores the last 5 commits touching the file. GitHub's copy replaces the cache unless the cache is a Stop-hook copy saved after GitHub's last change to the file; the hook replaces the cache whenever the local file differs from it (D58). Changing the docs path forgets both. A non-UTF-8 file is a repo error, not a crash.
Why: §7 shows pushed and unpushed edits; neither source should overwrite a newer copy from the other.
Alternatives rejected:

- GitHub always wins: an unpushed decision would disappear at every poll.
- The hook always wins: a change pushed from another machine would never show.

## D64 — New-project skill in the plugin (2026-11-26)

Decision: `plugin/skills/new-project/` (`/heph:new-project`, or triggered by "start a new project…") follows §9: Claude asks only what is missing, checks current Node/Python versions before passing them, and runs `scripts/bootstrap.sh` (bash + git; `gh` optional). The script refuses a non-empty folder, writes the stack `.gitignore` (Node/TypeScript, Python, PlatformIO, generic), `.editorconfig`, `.gitattributes`, README, `DECISIONS.md` (D1 = bootstrap), a minimal `CLAUDE.md` and, for public repos only, the MIT `LICENSE` with the holder from `git config user.name`; commits; copies design docs in a second commit; and, with `gh` installed and signed in, creates the repo, sets an SSH remote and pushes, otherwise says why it skipped. It prints `HEPH_*` result lines. Claude then proposes macro-phases and registers the project with `create_project` (DIY: registration only, internal docs). Skill files are excluded from Biome formatting (it broke the YAML front matter).
Why: §9 and the owner's new-project rules; owner decisions of 2026-11-26 on the stacks. A deterministic script makes the files the same every time and is testable with a fake `gh`.
Alternatives rejected:

- Letting Claude write every file freehand: different results each time, untestable.
- A separate CLI or package: one more thing to install; the plugin is already installed.

## D65 — Import through generic MCP parameters (2026-11-27)

Decision: Imported history goes through the normal tools (§13): `create_project` takes `origin` and phase tasks as titles or `{title, notes, done, done_at}`; `log_progress` takes `occurred_at` and `origin`. Times are ISO date-times (offset allowed) or `YYYY-MM-DD`, read as 12:00 UTC so the day is the same in Europe; times in the future are refused. Tasks created done write no `task_completed` event, and a phase done at creation gets the time of its last task as completion time. A backdated note never moves the project's last activity backwards. `origin` is stored on the project and on diary entries, shown by `get_project` ("Imported: …") and `get_diary` ("imported (…)"). REST accepts the same fields (camelCase) through the shared schemas.
Why: §13 asks for no import-specific code and an origin on imported entities; owner decision of 2026-11-27 ("small generic MCP extension"). Without these parameters a migration would stamp every past completion and note with today's date and flood the diary with completion events.
Alternatives rejected:

- Existing tools only (dates written in the text): history ordered by import time, one event per old task.
- An `import_project` tool taking a whole document: import-specific code, against §13.
- Backdating any write (phases, materials): not needed to keep work state; more surface.

## D66 — Legacy file tracking marker, honoured by the session-start text (2026-11-27)

Decision: A project that keeps its own file-based work tracking says so in its `CLAUDE.md` with a line starting `Work state: legacy` (written by the `heph:migrate-project` skill, with the file and the date chosen). In sessions whose repo is not linked to a Heph project, the SessionStart text starts with that escape: if the marker is there, Claude follows the project's `CLAUDE.md`, ignores Heph's text and rules, and proposes nothing. Otherwise it proposes the migration skill when the repo tracks work in files, or registering it. The same hint is in `get_briefing`'s error for an unlinked repo. Linked projects are unchanged.
Why: Owner decision of 2026-11-27. Before this, every unlinked repo was told "track work state in Heph, not in repo files" and "propose registering", which contradicts a project that chose to keep its files. A marker in the repo needs no new data in Heph, travels with the repo and is read by Claude anyway.
Alternatives rejected:

- An ignore list in Heph settings: more code and UI for a choice that belongs to the repo.
- A `.heph-ignore` file read by the plugin script: logic in the script (D58 keeps it a forwarder).
