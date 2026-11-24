# Progress

Temporary work-state tracker. Delete once Heph is running and tracks itself via MCP.

## Current phase

Roadmap phases 1, 2 and 3 (MCP server) are **done**. Next: phase 4 (web UI).

## Done

- 2026-11-24: Repository setup: spec, design package, `DECISIONS.md`, `CLAUDE.md`, public GitHub repo `heph`.
- 2026-11-24: Phase 1 + 2:
  - npm-workspaces monorepo (`packages/schema`, `packages/core`, `apps/server`, `apps/web`), Biome, Vitest, CI workflow.
  - Docker image (multi-stage, non-root, `/data/db` + `/data/files`, ports 8080 UI/REST and 8081 agent) and `compose.yaml`; `scripts/docker-smoke.sh` end-to-end test.
  - Drizzle schema for the full §5 data model, migrations, FTS5 index kept in sync by triggers.
  - Domain layer: settings, auth, projects, roadmap + next task, append-only diary with events, materials, files (EXIF strip, thumbnails, retention, one-time upload tokens), proposals, live sessions, computed activity/badge/attention, search. `change_log` on every mutation.
  - Setup wizard, login/logout, password change, API token; minimal web pages for setup/login.
  - CLI: `heph reset-password`, `heph rotate-token`.
  - REST API on both ports; `/upload/:token` on the agent port.

## Not done yet (known gaps)

- Revert of changes from `change_log` (data is recorded; no API yet).
- Project export (markdown + files zip, spec §11).
- Real Claude Code CLI check against MCP not run (no CLI on the dev machine).
- Claude session endpoints (hooks) arrive with phase 5; activity already reads `claude_sessions`.

## Next step

Phase 4: functional web UI (dashboard, project page, diary, docs, materials, files, proposals, settings, IT/EN), then apply the design.
