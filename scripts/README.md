# scripts

Tooling scripts (not part of the app image).

| Script             | Purpose                                                                                                                                                                                                      | Run                                               |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------- |
| `docker-smoke.sh`  | Builds the image (unless `SKIP_BUILD=1`), starts a hardened container with fresh volumes and checks hardening, setup, login, REST, MCP, uploads, the CLI and a restart. Used by CI and the Release workflow. | `npm run smoke:docker` (needs Docker, curl, Node) |
| `setup-hooks.mjs`  | Points git at the versioned hooks in `.githooks/` (gitleaks pre-commit, D43). Runs automatically on `npm install`.                                                                                           | `node scripts/setup-hooks.mjs`                    |
| `smoke-github.mjs` | Opt-in check of the GitHub adapter against the real API: reads the public sample repo `octocat/Hello-World` without a token (D61). Not run in CI (60 requests per hour per address).                         | `npm run smoke:github` (needs internet)           |
