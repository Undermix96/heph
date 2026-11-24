# Decisions

Architectural and technical decisions for Hephaestus (heph), with their rationale.
One dated section per decision; newest at the bottom. Superseded decisions are kept and marked, never deleted.
Work state (what's done, what's next) does **not** belong here.

---

## 2026-11-24 — TypeScript end to end

**Decision:** Server, MCP server, CLI, shared schemas and web UI are all written in TypeScript.
**Why:** One language and one type system across every layer; Zod schemas and inferred types can be shared between REST, MCP and the frontend without code generation.

## 2026-11-24 — SQLite as the only datastore

**Decision:** SQLite in WAL mode, with FTS5 for full-text search. The DB file lives on a local Docker volume (`/data/db`), never on NFS/SMB.
**Why:** Single user, small data, one container. No separate database service to run; backup is copying files. WAL gives concurrent reads during writes. Network filesystems break SQLite locking, hence the local-volume requirement.

## 2026-11-24 — Single container, two ports

**Decision:** One Docker image, one container, exposing two ports: the **UI + REST** port (published through a Cloudflare Tunnel protected by Cloudflare Access) and the **MCP** port (LAN only, never routed through the tunnel).
**Why:** Keeps deployment trivial while isolating the agent-facing surface from the internet. The UI is reachable remotely behind Access; the MCP endpoint, which uses a static bearer token, is never exposed outside the LAN.

## 2026-11-24 — No dependency on Cloudflare Access headers

**Decision:** The app never inspects or requires Cloudflare Access headers or JWTs. It has its own authentication (see below) and behaves identically when reached directly on the LAN or through the tunnel.
**Why:** Access is an extra outer layer, not the app's auth. Depending on it would break LAN access and couple the app to one hosting setup.

## 2026-11-24 — Web authentication: single user, setup wizard, sessions

**Decision:** Username + password, no registration page. On first start a one-time setup wizard creates the only user; afterwards it is unreachable. Passwords are hashed with argon2. Login creates an httpOnly session cookie (marked `Secure` when the request came over HTTPS). Password can be changed in settings and reset from inside the container with `heph reset-password`.
**Why:** Single-user app; this is the smallest auth that is still safe. The CLI reset guarantees recovery even if the UI is unusable. OAuth is deferred to a later phase.

## 2026-11-24 — Static bearer token for API, MCP and hooks

**Decision:** A static API token is generated during setup, shown in settings, and regenerable from the UI and from `heph rotate-token`. It is required by the MCP server and by the hook endpoints.
**Why:** Claude Code hooks and the MCP config need a non-interactive credential that can live in an environment variable (`HEPH_TOKEN`). One token, one user, easy rotation.

## 2026-11-24 — The agent is a first-class user: one domain layer, thin adapters

**Decision:** Every operation lives in a single domain layer. The REST API, the MCP server and the web UI are thin adapters over it. There are no UI-only features.
**Why:** Claude Code must be able to do everything the user can. Keeping logic in one place prevents the adapters from drifting apart.

## 2026-11-24 — Intent-level MCP tools, not CRUD mirrors

**Decision:** MCP tools express meaningful actions (`get_briefing`, `log_progress`, `complete_task`, …) rather than mirroring tables. `get_briefing` is the primary entry point.
**Why:** An agent works better with few, purposeful tools that return compact, ready-to-use context than with many low-level ones it has to orchestrate.

## 2026-11-24 — No LLM inside the app

**Decision:** The app embeds no language model. It stores, computes and serves; all intelligence lives in the client (Claude).
**Why:** Avoids API keys, cost, latency and non-determinism on the server. The client already has a far more capable model and the user's context.

## 2026-11-24 — Markdown for all free text

**Decision:** Descriptions, notes, status notes, diary bodies and internal docs are stored and rendered as Markdown.
**Why:** It is what Claude writes natively, it diffs well, and it exports cleanly.

## 2026-11-24 — Append-only diary and source on every change

**Decision:** The diary is append-only. Every change records its `source` (`ui`, `claude_code`, `github`, `system`) and is revertible where that makes sense.
**Why:** The diary is the memory that lets the user resume a project; it must be trustworthy. Knowing who did what is essential when an agent writes alongside the user.

## 2026-11-24 — Graduated trust for agent writes

**Decision:** Additive agent operations are applied directly. Destructive ones (delete phase/task, restructure roadmap, set `completed`/`abandoned`) require an explicit user-confirmed flag or are stored as a **Proposal** that the user approves or rejects in the UI.
**Why:** Lets Claude work autonomously on the common path while keeping irreversible changes under the user's control.

## 2026-11-24 — MCP over Streamable HTTP

**Decision:** The MCP server uses the official TypeScript MCP SDK with the Streamable HTTP transport, authenticated by the bearer token, served on the LAN-only port.
**Why:** HTTP transport lets one long-running server serve any Claude Code session on the LAN; stdio would require a local process per machine.

## 2026-11-24 — File uploads from the agent via one-time URLs

**Decision:** Claude requests a one-time upload URL (`request_upload`) and uploads with `curl -F file=@path <url>`. File content is never passed as base64 in tool arguments.
**Why:** Base64 in tool calls wastes context tokens and breaks on large files; curl streams directly from disk.

## 2026-11-24 — Work state in the app, decisions in the repo

**Decision:** Where a project stands (diary, phases, next task, briefing) lives in the app, not in repo files. Architectural decisions live in each repo as `DECISIONS.md` (path configurable per repo). Projects without a repo use internal Markdown docs stored in the app.
**Why:** Work state changes constantly and is better served by structured data; decisions are durable, belong with the code, and should be reviewable in git.

## 2026-11-24 — English for docs, code comments and commits

**Decision:** Documentation, code comments and commit messages are always in English. Diary content follows the app's "content language" setting. The UI is available in Italian and English.
**Why:** Code artifacts stay readable to anyone and consistent across projects; the diary is personal and can use the user's language.

## 2026-11-24 — GitHub integration by polling, read-only

**Decision:** GitHub is integrated by polling with a fine-grained read-only token at a configurable interval. Commits (grouped) and releases are imported as diary events; docs files are fetched from linked repos. No webhooks, no issue sync.
**Why:** The server is LAN-only, so GitHub cannot reach it. Read-only access minimizes risk. Tasks can still link to issues/PRs by URL.

## 2026-11-24 — Claude Code integration as a plugin in this repo

**Decision:** A Claude Code plugin, versioned in this repository, bundles the MCP config (reading `HEPH_URL` / `HEPH_TOKEN`), hooks and skills. It is installed once at user level. Hook scripts depend only on `git` and `curl` where possible.
**Why:** One install covers every project; versioning it with the server keeps the hook ↔ endpoint contract in sync. Minimal dependencies make hooks work on any dev machine.

## 2026-11-24 — Global rules injected by the SessionStart hook

**Decision:** The rules Claude must follow in every project (English for docs/comments/commits, track state via MCP, decisions in `DECISIONS.md`, current `session_id`) are injected by the `SessionStart` hook together with the project briefing, not written to `~/.claude/CLAUDE.md`.
**Why:** Plugins cannot install a user CLAUDE.md, and the user's own CLAUDE.md must stay free for personal instructions.

## 2026-11-24 — Two-level roadmap, deliberately minimal planning model

**Decision:** Roadmaps have exactly two levels: macro-phases → tasks. No subtasks, due dates, priorities or estimates in v1. Every project should always have one **next task** (computed by default, overridable).
**Why:** The goal is resuming work, not project management. A single, always-visible next step matters more than planning detail.

## 2026-11-24 — Node.js 26 LTS

**Decision:** Target Node.js 26 (current Active LTS, "Lithium"), pinned in `.nvmrc` and in the Docker base image.
**Why:** Latest LTS gives the longest support window and current language/runtime features.

## 2026-11-24 — Dark theme only for the first UI

**Decision:** The approved design (`docs/design/`) is dark-theme only. The UI is implemented with the design tokens in `docs/design/tokens.css` so a light theme can be added later. Styling is kept isolated from functional components.
**Why:** Matches the approved design while keeping the door open for a light variant.

## 2026-11-24 — Conflict rule between spec and design

**Decision:** When `docs/HANDOFF.md` and `docs/design/` disagree, the spec wins. A design choice is adopted only where it adds something without contradicting the spec.
**Why:** The spec is the agreed product scope; the design package is the visual layer.

## 2026-11-24 — Hooks and agent uploads are served on the LAN agent port

**Decision:** `/mcp`, `/hooks/*` and `/upload/*` are served on the agent port (LAN only, default 8081). `HEPH_URL` points to it. The REST API is mounted on both ports; on the UI port it accepts the session cookie or the bearer token, on the agent port only the bearer token.
**Why:** The UI port sits behind Cloudflare Access, which would block `curl` calls from Claude Code hooks and uploads. The spec lists these endpoints under REST without naming a port; this keeps the agent surface off the tunnel.

## 2026-11-24 — Badge precedence vs dashboard ordering

**Decision:** The displayed badge follows the spec precedence: live activity (`claude_testing` > `claude_working`) → lifecycle → recency. Dashboard ordering follows the spec list (awaiting manual test first). They are two different computations.
**Why:** Spec §6 wins over the design's badge table.

## 2026-11-24 — Next task: computed default with override

**Decision:** The next task is the override if it points to an open task, else the first open task of the first non-done phase. Completing the override clears it. "No next step" means no open task exists in non-done phases. `complete_task` returns the new next task.
**Why:** Spec §5; the design's "suggest but don't pick" contradicts it.

## 2026-11-24 — Activity thresholds and session expiry defaults

**Decision:** `recently_active` < 7 days, `inactive` > 30 days (spec defaults; design used 3/21). Live sessions expire after 30 minutes without events. All configurable in settings.
**Why:** Spec wins; values to be tuned after real use.

## 2026-11-24 — Screenshot retention: last N per target

**Decision:** Unpinned files uploaded by Claude Code are kept up to the last N (default 20) per attached target (task, diary entry, phase or project); older ones are deleted. Pinned files are never deleted.
**Why:** Spec §5 wins over the design's age-based expiry.

## 2026-11-24 — Phase status is stored and kept in sync with tasks

**Decision:** `phases.status` is a stored field that can be set explicitly. Task changes keep it in sync: all tasks done → `done`; some done or a task reopened in a done phase → `in_progress`. Phase progress is always computed from tasks.
**Why:** The spec lists status as a field and progress as computed; syncing avoids a done-looking phase that blocks the next-task computation.

## 2026-11-24 — Docs per repo

**Decision:** `projects.docs_source` selects `repo` or `internal`. With `repo`, every linked repo has its own docs path (default `DECISIONS.md`) and cached content; the Documentation tab shows one entry per repo.
**Why:** The spec makes the path configurable per repo while projects can have many repos.

## 2026-11-24 — Diary is strictly append-only; reverts via change log

**Decision:** Diary entries are never edited or deleted through the API. Every domain mutation writes a `change_log` row (before/after JSON, source, session). A revert applies the inverse change and appends a compensating event.
**Why:** Spec §2 principle 5.

## 2026-11-24 — Small additions adopted from the design

**Decision:** Adopted because they don't contradict the spec: a per-project `claude_write_enabled` switch; a `decision_note` on proposals that Claude can read; a per-repo `show_commits` toggle; a `content_language` setting (spec §7 mentions it). Export stays Markdown + files in a zip, which also includes a `project.json`.
**Why:** They improve the product without changing agreed behavior.

## 2026-11-24 — Monorepo layout and core libraries

**Decision:** npm workspaces: `packages/schema` (Zod), `packages/core` (Drizzle schema, migrations, domain), `apps/server` (Hono adapters, CLI), `apps/web` (Vite + React SPA). Libraries: Hono, Zod v4, Drizzle + better-sqlite3, @node-rs/argon2, sharp, busboy, pino, Vitest, Biome. Integer IDs, unix-ms timestamps.
**Why:** No extra package manager to install (corepack is gone from Node 25+); one domain package for all adapters; mature, light dependencies. Integer IDs are short for an agent to reference.

## 2026-11-24 — Diary keyset pagination and no all-digit slugs

**Decision:** Diary lists paginate with a keyset cursor `(before = occurredAt, beforeId = id)` of the last entry received, because many entries share a millisecond. Project slugs can never be only digits (generated ones get a `p-` prefix; explicit ones are rejected), so a project reference that is all digits is always an id.
**Why:** Found by the domain test suite: timestamp-only cursors skipped entries, and digit-only slugs were unreachable by slug.
