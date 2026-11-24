# Hephaestus (heph)

> **Work in progress** — not usable yet.

Hephaestus is a self-hosted, AI-first tracker for personal software and DIY projects.
Its core job: let you resume any project after weeks without reconstructing context.

- Dashboard ordered by what needs attention; per-project roadmap (phases → tasks), next step and diary.
- Built to be operated by [Claude Code](https://claude.com/claude-code) as a first-class user, through an MCP server and hooks that keep the diary up to date automatically.
- Single user, single Docker container, SQLite storage, runs on a LAN server.

## Documentation

- [`docs/HANDOFF.md`](docs/HANDOFF.md) — product spec and scope.
- [`DECISIONS.md`](DECISIONS.md) — architectural and technical decisions.
- [`docs/design/`](docs/design/) — approved UI design (mockups, tokens).

## License

[MIT](LICENSE)
