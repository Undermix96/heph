# CLAUDE.md — Hephaestus (heph)

Self-hosted, AI-first project tracker. Short name `heph` (CLI, Docker image/container, env vars, plugin).

## Sources of truth

- **Spec:** `docs/HANDOFF.md` — scope and design decisions. Read the relevant section before changing behavior.
- **UI design:** `docs/design/` (`DESIGN.md`, `tokens.css`, mockups). Dark theme only; use the tokens, keep styling isolated.
- **Decisions:** `DECISIONS.md` — one numbered entry `D<n>` per architectural/technical decision (format in the global rules). Never renumber or rewrite; mark superseded entries.

## Work state

- Until Heph itself is running, work state (current phase, done, next step) is tracked in `PROGRESS.md`. Update it as you work.
- Once Heph is running, track work state through Heph's MCP server instead and **delete `PROGRESS.md`**.

## Rules

- Documentation, code comments and commit messages are **always in English**.
- Small, working commits, each with tests where applicable.
- Follow the project conventions (package scripts, lint, tests) defined in the root `package.json`; run lint, typecheck and tests before committing.
- Never commit `/data`, `.env*` or secrets.
