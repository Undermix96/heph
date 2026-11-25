# CLAUDE.md — Hephaestus (heph)

Self-hosted, AI-first project tracker. Short name `heph` (CLI, Docker image/container, env vars, plugin).

## Sources of truth

- **Spec:** `docs/HANDOFF.md` — scope and design decisions. Read the relevant section before changing behavior.
- **UI design:** `docs/design/` (`DESIGN.md`, `tokens.css`, mockups). Dark theme only; use the tokens, keep styling isolated.
- **Decisions:** `DECISIONS.md` — one numbered entry `D<n>` per architectural/technical decision (format in the global rules). Never renumber or rewrite; mark superseded entries.

## Work state

- Work state (phases, tasks, next step, diary, open questions) is tracked in Heph itself, project `hephaestus`, through the `heph` MCP server (D47). Start with `get_briefing` (repo `Undermix96/heph`); there is no `PROGRESS.md`.

## Threat model and testing (D54)

- Personal project of a single owner. It runs only on the owner's LAN (trusted) and, from outside, behind Cloudflare Access.
- Users are acting in good faith: the owner and Claude Code. Tests and independent verification target bugs that can happen in normal use (realistic content, mistakes, edge cases of real workflows, concurrency between the UI and Claude Code), not malicious attackers or deliberately hostile input.
- Keep the baseline from the global rules (auth always checked, no secrets in logs or images), but do not design or test for attack scenarios such as crafted payloads, denial of service or adversarial Markdown.

## Rules

- Documentation, code comments and commit messages are **always in English**.
- Small, working commits, each with tests where applicable.
- Follow the project conventions (package scripts, lint, tests) defined in the root `package.json`; run lint, typecheck and tests before committing.
- Never commit `/data`, `.env*` or secrets.
