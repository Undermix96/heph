# HANDOFF — Hephaestus (Heph)

**Name:** Hephaestus — the Greek god of craftsmen and builders. **Short name: `heph`**, used for the CLI, Docker image/container, plugin, env vars and anywhere a short identifier is needed. Use "Hephaestus" in the UI title and docs.

Self-hosted, AI-first tracker for personal software and DIY projects. Single user. Runs in Docker on a LAN server. Designed to be operated by Claude Code (via MCP + hooks) as a first-class user, alongside a web UI.

This document is the source of truth for scope and design decisions agreed so far. The UI visual design is handled separately (a design brief exists); implement the UI functionally and keep styling isolated so the design can be applied later.

---

## 1. Problem and goals

The user runs many parallel projects (software and DIY) and loses track of where each one stands. The core job of the app is: **resume any project after weeks without having to reconstruct context.**

Goals:

- Dashboard with the state of every project, ordered by what needs attention.
- Per-project page: roadmap (macro-phases → tasks), where I am, what's left, next step.
- Diary (progress log) that fills itself automatically while working with Claude Code.
- Claude Code can read and update everything through an MCP server.
- Starting a new project (git repo, GitHub repo, scaffolding, tracker registration) is automated.

Non-goals for v1: multi-user, due dates/priorities/estimates, embedded LLM, project import (to be designed later). Not planned at all: OAuth (D72); a mobile app or PWA (D71), since the web UI is responsive and works on phones.

---

## 2. Core principles

1. **Agent is a first-class user.** All operations live in one domain layer. REST API, MCP server and web UI are thin adapters over it. No UI-only features.
2. **Intent-level MCP tools, not CRUD mirrors.** Tools express meaningful actions (`get_briefing`, `log_progress`, `complete_task`…).
3. **No LLM inside the app.** Intelligence lives in the client (Claude). The app stores, computes and serves.
4. **Markdown for all free text.**
5. **Append-only diary; every change records its source** (`ui`, `claude_code`, `github`, `system`) and is revertible where it makes sense.
6. **Graduated trust for agent writes.** Additive operations are free; destructive ones (delete phase/task, rewrite roadmap, set `completed`/`abandoned`) require explicit confirmation or are created as proposals the user approves in the UI.

---

## 3. Tech stack (decided)

- **Language:** TypeScript end to end.
- **Backend:** Node.js + Hono (or Fastify), Drizzle ORM, **SQLite** (WAL mode, FTS5 for search).
- **Validation:** Zod schemas shared by REST, MCP and frontend.
- **MCP:** official TypeScript MCP SDK, Streamable HTTP transport.
- **Frontend:** TypeScript SPA (framework at implementer's discretion), i18n IT/EN.
- **Packaging:** single Docker image, single container.

Why SQLite: single user, small data, one container, backup = copy files. The DB file must live on a local Docker volume (not NFS/SMB).

---

## 4. Deployment, network, auth

- One container exposing **two ports**:
  - **UI + REST API** port — this one is published through a Cloudflare Tunnel protected by Cloudflare Access.
  - **MCP** port — LAN only, never routed through the tunnel.
- **Do not inspect or require Cloudflare Access headers/JWT.** The app must work identically from LAN (direct) and from the tunnel.
- Volumes: `/data/db` (SQLite), `/data/files` (uploads + thumbnails).
- **Web login:** username + password, no registration page.
  - First start: UI shows a one-time setup wizard to create the user. After that the wizard is unreachable.
  - Password hashed with argon2; session cookie (httpOnly, secure when behind HTTPS).
  - Settings page: change password.
  - CLI inside the container: `docker exec heph heph reset-password` (interactive), works even if the UI is unusable.
- **API/MCP token:** a static bearer token generated during setup. Shown in settings, regenerable from UI and CLI (`heph rotate-token`). Required by MCP and by hook endpoints.
- Settings page **"Connect Claude Code"**: shows the exact commands (env vars with URL + token prefilled, plugin install commands) ready to copy.

---

## 5. Data model

All entities have `id`, `created_at`, `updated_at`. Changes write to the diary/events with a `source`.

**Project**

- `name`, `slug`, `description` (md), `tags[]` (e.g. `software`, `diy`, `3d-print`, free-form)
- `lifecycle_status` (see §6) + `status_note` (md; e.g. what to test, what we're waiting for)
- `cover_file_id?`
- `links[]` (label + url)
- `repos[]` — GitHub repos (`owner/name`), many per project (e.g. firmware + app)
- `docs_source`: `repo` (path in a linked repo, default `DECISIONS.md`) or `internal` (editable md stored in app)
- `next_task_override_id?`
- computed: `progress`, `last_activity_at`, `activity_state`, `next_task`

**Phase** (macro-phase) — ordered within project

- `title`, `description` (md), `order`, `status` (`todo` / `in_progress` / `done`), computed progress from tasks.

**Task** — ordered within phase (exactly two levels: phase → task; no subtasks)

- `title`, `notes` (md), `order`, `done` (bool), `done_at`, optional `link` (e.g. GitHub issue/PR URL).

**Next task**: default = first open task of the first non-done phase; can be overridden. There should always be one; if none exists, the project is flagged "no next step defined".

**Diary entry** (append-only)

- `project_id`, `type` (`note`, `session`, `event`), `body` (md), `source`, `session_id?`, `files[]`, `timestamp`.
- Events are generated automatically: task completed, status changed, next step changed, file uploaded, commits/releases from GitHub, manual test outcome.
- Entries sharing a Claude Code `session_id` are grouped and shown as one "session" block.

**Material** (BOM / shopping list) — per project, optionally linked to a phase

- `name`, `quantity`, `link?`, `price?`, `notes?`, `status` (`to_buy` / `ordered` / `arrived` / `used`).

**File / attachment**

- Any file type. Attachable to project, phase, task or diary entry.
- Images: thumbnails generated, EXIF stripped (GPS!), orientation fixed.
- Other files: downloadable; configurable max size.
- `source` (`ui`, `claude_code`), `caption?`, `pinned` (bool).
- Retention for Claude Code screenshots: keep last N per task/entry unless pinned (configurable).

**Claude session** (live activity)

- `session_id`, `project_id`, `repo`, `started_at`, `last_heartbeat_at`, `ended_at?`, `is_testing`, `testing_since?`.

**Proposal** (pending destructive agent change)

- `project_id`, `kind`, `payload`, `created_by`, `state` (`pending` / `approved` / `rejected`).

**Settings**: language (UI), activity thresholds, test-command patterns, retention, GitHub token, poll interval.

---

## 6. Status model

Two independent layers, combined into one displayed badge.

**Lifecycle status** (set by user or Claude):

- `in_development` — default for an open project
- `awaiting_manual_test` — Claude finished something and needs the user to test. `status_note` says _what_ to test. The UI offers "test passed / test failed + notes"; the outcome goes to the diary and status returns to `in_development`.
- `on_hold` — waiting for something external (parts, decision); reason in `status_note`
- `completed`
- `abandoned` (distinct from deletion)

**Activity state** (computed, never set):

- `claude_working` — an open Claude Code session on a linked repo (heartbeats from hooks; auto-expires after N minutes without events)
- `claude_testing` — sub-state: a hook detected a test command running (configurable patterns: `npm test`, `pnpm test`, `pytest`, `playwright`, `vitest`, `go test`, …)
- `recently_active` — last activity < X days (default 7)
- `idle` — between thresholds
- `inactive` — last activity > Y days (default 30)

Badge precedence: live activity → lifecycle → recency. An `in_development` project with no activity for 60 days shows as **inactive**.

**Dashboard default ordering ("needs attention"):**

1. `awaiting_manual_test`
2. Live (`claude_working` / `claude_testing`)
3. `in_development` but inactive or without a next step
4. `in_development` recently active, with next step visible
5. `on_hold`
6. `completed` / `abandoned` (collapsed/filtered by default)

---

## 7. Documentation model (replaces the per-repo HANDOFF file)

- **Work state** (where I am, what's next) lives **in the app** (diary, phases, next task, briefing). Not in repo files.
- **Decisions** (architecture, technical choices, the "why") live **in the repo** as `DECISIONS.md` (path configurable per repo), always in English.
- The app shows the decisions file in a "Documentation" tab (rendered markdown, last modified, related commits). Sources:
  - GitHub polling (pushed version);
  - the end-of-turn hook uploads the local file content if it changed (no AI involved, just a hash check), so unpushed edits are visible too.
- Projects without repo: `docs_source = internal`, editable from UI and MCP.

**Language rules:** documentation, code comments and commit messages are **always in English**. Diary content language follows the app setting "content language" (communicated to Claude in the briefing). UI language: IT/EN selector.

---

## 8. MCP server

Streamable HTTP, bearer token auth, LAN port. Tools (indicative signatures; refine during implementation):

Read:

- `get_briefing(project?)` → compact markdown: status, activity, current phase, next task, what's left (open phases/tasks summary), blockers/status note, last N diary entries, materials pending, docs pointer, language rules. If `project` omitted, resolved from repo (see hooks). **Most important tool.**
- `list_projects(filter?)` → name, status, activity, progress, next task.
- `needs_attention()` → dashboard ordering as a list.
- `get_project(project)` → full structure (phases, tasks, materials, links).
- `search(query)` → FTS over projects, tasks, diary, docs.
- `get_file(file_id)` → returns images as image content so Claude can view them.
- `get_docs(project)`.
- `list_changes(project, limit?, before?)` → recorded changes, newest first, with whether each can be reverted (D74).

Write (free):

- `create_project(name, description?, tags?, repos?, phases?, origin?)` — phase tasks are titles or `{title, notes?, done?, done_at?}` (imports, D65)
- `link_repo(project, owner/name, docs_path?, show_commits?)` — on a repo the project already has, updates its docs path (D68)
- `log_progress(project, body, session_id?, file_ids?, occurred_at?, origin?)` — `occurred_at` backdates imported history, never in the future (D65)
- `add_phase(project, title, description?, position?)`, `add_task(phase, title, notes?, position?)`
- `complete_task(task)` → returns the new next task
- `set_next_task(project, task)`
- `set_status(project, status, note)` for `in_development` / `awaiting_manual_test` / `on_hold`
- `add_material(project, …)`, `update_material(material, …)`
- `request_upload(project, target?, caption?)` → one-time upload URL; Claude then runs `curl -F file=@path <url>`. **Never pass file content as base64 in tool args.**
- `update_docs(project, body)` (internal docs only)

Write (confirmation / proposal):

- `set_status` to `completed` / `abandoned`, `delete_phase`, `delete_task`, `restructure_roadmap(...)` → create a Proposal unless the call includes an explicit user-confirmed flag; UI shows pending proposals.
- `propose_revert(project, change_id, reason?)` → always a Proposal, even when the user confirmed in chat; only the user reverts, by approving it in the UI (D75).

Optional MCP prompts (show as `/` commands in Claude Code): e.g. "overview of all projects". Not used for bootstrap.

---

## 9. Claude Code integration (plugin)

A **Claude Code plugin versioned in this repository** bundles: MCP server config, hooks, skills. Installed once at user level; applies to every project.

**Config:** the plugin's MCP config reads env vars `HEPH_URL`, `HEPH_TOKEN` (set once in shell profile or `~/.claude/settings.json` → `env`).

**Hooks** (scripts should depend only on `git` + `curl` where possible):

- `SessionStart`: read `git remote` from cwd → call `/hooks/session-start` with repo + session_id → stdout injects into context: the **project briefing** + **global rules** (docs/comments/commits in English, track state via MCP, decisions in `DECISIONS.md`, current session_id to pass to `log_progress`). If the repo is not linked to any project, the injected text tells Claude to propose registering it.
- `Stop` (end of every turn): heartbeat. Then decide whether a diary entry is due: changed files or new commits since last entry, or N turns / X minutes of work without one. If due, return a block decision with instructions ("update the project diary: what was done, where you stopped, next step"); respect `stop_hook_active` to avoid loops. Also: if `DECISIONS.md` hash changed, upload its content.
- `PreToolUse` / `PostToolUse` on Bash: match test command patterns → mark session `is_testing` on/off.
- `SessionEnd`: close the session.
- Sessions without events for N minutes are closed server-side.

**Global rules are injected by the hook**, not via `~/.claude/CLAUDE.md` (plugins can't install it). The user's own CLAUDE.md stays free.

**Skill: new project bootstrap** (auto-triggered by e.g. "start a new project…", also invocable manually):

1. Ask only what's missing: folder, name, public/private, stack, optional design-docs folder, tags, short description.
2. Deterministic script (inside the skill): `git init`, stack-appropriate `.gitignore`, `README.md`, `LICENSE` (public only), `DECISIONS.md` template, minimal project `CLAUDE.md`, initial commit.
3. `gh repo create` (public/private), push. (Requires `gh` installed + authenticated; if missing, skip with a clear message.)
4. Copy design docs into the repo (e.g. `docs/design/`), commit, push.
5. Register on tracker via MCP: create project, link repo, tags, propose initial macro-phases from the description.
6. Final summary.
   DIY variant: no repo, tracker registration only.

---

## 10. GitHub integration

- Fine-grained read-only token in settings.
- **Polling** (no webhooks; server is LAN-only), configurable interval.
- Imports into diary as events: commits (grouped), releases. Updates `last_activity_at`.
- Fetches docs file from linked repos.
- No issue sync. Tasks can link to issues/PRs by URL.

---

## 11. REST API

Same domain operations as MCP, consumed by the UI. Plus:

- `/hooks/*` endpoints for the plugin (token auth).
- `/upload/:one_time_token` for agent uploads.
- `/setup` (only before first user exists).
- Export: whole project as a single markdown file (+ files as zip).
- Changes (D74): `GET /projects/:ref/changes` (`before`, `limit`, `revertible`), `GET /changes/:id`, `POST /changes/:id/revert` (UI session only); the project page has a "Changes" tab.

---

## 12. Roadmap

1. **Foundation** — repo skeleton, Docker image, SQLite + migrations, domain layer, setup wizard, login, CLI (`heph reset-password`, `heph rotate-token`), settings.
2. **Core model + REST** — projects, phases, tasks, next task, diary, materials, files (upload, thumbnails, EXIF strip), status model + computed activity, search.
3. **MCP server** — tools from §8, proposals.
4. **Web UI (functional)** — dashboard, project page, diary, docs tab, materials, files, proposals, settings, i18n IT/EN. Apply visual design when available.
5. **Claude Code plugin** — hooks, injected rules, live sessions, testing detection, auto-diary, docs upload, "Connect Claude Code" page.
6. **GitHub integration** — polling, events, docs fetch.
7. **Bootstrap skill** — new project flow.
8. **Later** — project import (done, D65–D70). No notifications (D73), no OAuth (D72), no mobile app / PWA (D71).

---

## 13. Open items

- Project import strategy: decided (2026-11-27). Existing projects choose per project: migrate to Heph with the `heph:migrate-project` skill (inventory, reconciliation report, two independent verifier passes, D67), or keep file-based tracking with the `Work state: legacy` marker in their `CLAUDE.md`, which the SessionStart text honours (D66). The generic MCP parameters `origin`, `occurred_at` and done tasks in `create_project` carry the history (D65); no import-specific endpoint.
- Exact thresholds and defaults (activity, session expiry, diary trigger) to tune after real use.
