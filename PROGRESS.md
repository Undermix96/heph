# Progress

Work state of Hephaestus (heph): phases, what is done, the next step, open questions.
Decisions live in [`DECISIONS.md`](DECISIONS.md), scope in [`docs/HANDOFF.md`](docs/HANDOFF.md).
Temporary: once Heph runs, its own MCP server tracks this project and this file is deleted (CLAUDE.md).

Status: Phase 3 (MCP server) built and aligned with the global rules; first CalVer release being published; waiting for user verification of the phase 3 acceptance criteria.
Last updated: 2026-11-24

## Done

### Repository setup (2026-11-24)

- Commits: `6b63a44`, `d3e02e5`. Public repo `Undermix96/heph`, spec, design package, decisions, CLAUDE.md.

### Phase 1 Foundation + Phase 2 Core model & REST (2026-11-24)

- Content: monorepo (`packages/schema`, `packages/core`, `apps/server`, `apps/web`), Docker image + compose, SQLite + migrations + FTS5, domain layer, setup wizard, login, CLI (`heph reset-password`, `heph rotate-token`), REST API for projects, roadmap, diary, materials, files (EXIF strip, thumbnails), proposals, status/activity model, search.
- Commits: `ccef5aa` … `cde56b2`.
- Verification: 287 tests; Docker smoke test (`scripts/docker-smoke.sh`); CI green. User verified the setup wizard on the server (2026-11-24).
- Outcome: 12 bugs found by the independent test suites and fixed (D34 among them). Deviations from the spec: none; ambiguities resolved in D23–D33.

### Phase 3 MCP server (2026-11-24): built, awaiting user verification

- Content: `POST /mcp` on the agent port (D35), 30 tools and 2 prompts (D36), briefing, roadmap restructuring as proposals (D38), "confirmed in chat" tracking (D37).
- Commits: `b9329c1`, `b0d8948`, `e04ed75`, `b99de8d`, `dd0cb51`.
- Verification so far:
  - 510 tests (215 written by independent subagents); CI green on `dd0cb51`.
  - Docker smoke test includes MCP `initialize`, `tools/list`, `get_briefing`.
  - Real Claude Code CLI 2.1.331 against the published image (`sha-dd0cb51`) on 2026-11-24: `get_briefing` by repo, `complete_task`, `log_progress`; server showed the task done, the next task updated and a `session` diary entry with source `claude_code` and the session id. 5 turns, 0.41 USD.
- Acceptance criteria for the user (phase 3 is done when all pass on the user's server with a published release):
  1. `claude mcp add … heph http://<server>:8081/mcp` connects and lists the heph tools.
  2. In a real project, "get the heph briefing for <project>" returns status, next task, roadmap and rules.
  3. Asking Claude to delete a task creates a proposal visible through `list_proposals`; nothing is deleted.
  4. `http://<server>:8081/health` reports the CalVer version of the release.
- Outcome: 4 bugs found by the independent suites and fixed (digit-only refs, stale payload validation, next marker, git remote URLs). Tool count 30, not the ~31 estimated in the plan.

### Alignment with the global rules (2026-11-24)

- Timestamps as UTC ISO strings; migrations regenerated (D39, D40), commit `ab29542`. Existing databases must be recreated.
- Hardened container (D41) and CalVer multi-arch Release workflow (D42), commit `9e28a0d`.
- gitleaks pre-commit + CI and Dependabot (D43), commit `9fb3042`; full history scanned: no leaks.
- DECISIONS.md renumbered into D1–D45 with rejected alternatives; this file in the new format; package READMEs and SECURITY.md (`dcfcc1e`, `0ba2c07`).
- Independent verification: 6 rounds by fresh subagents given only the criteria and the diff. Found and fixed: Docker build broken by the hook setup script; `testing_since` still integer; REST upload expiry and MCP text times not ISO; years outside 0000–9999; login limiter bypassable (spoofed X-Forwarded-For, concurrency, cross-site lockout, more than 10 000 addresses → global cap D46); stale docs. Commits `be3d58f`, `54a608e`, `230ad5e`, `a6e4e03`, `6c99b84`, `62e9d0d`. Last round found no bugs.
- Tests: 650 (45 files); lint, typecheck, build and Docker smoke test green locally on `62e9d0d`.

## In progress

- CI on `62e9d0d`, then the first CalVer release (multi-arch) with the Release workflow.

## Next step

User: recreate the server volumes, deploy the first CalVer release and check the phase 3 acceptance criteria.

## Open questions

- [x] Spec vs design conflicts: spec wins, design extras only if compatible (2026-11-24, D23).
- [x] Timestamps: switch to ISO strings and recreate the database (2026-11-24, D39, D40).
- [x] API token readable in Settings: keep (2026-11-24, D45).
- [x] Error texts: fixed in the UI, detailed for the agent (2026-11-24, D44).
- [x] Backups: leave as they are for now, copying the volumes with the container stopped (2026-11-24).
- [ ] Project import strategy (§13): to design before phase 8.
- [ ] Activity thresholds, session expiry and diary trigger: tune after real use (§13).
- [ ] Revert API on top of `change_log` (D31): which changes are revertible, and from which UI.
- [ ] Project export (§11): Markdown + files zip, planned with the web UI.
