# Plugin feasibility spike (phase 5.0)

Throwaway plugin that checks the Claude Code facts the phase 5 design depends on.
It is replaced by the real plugin in phase 5 group B. Every hook reports to a local
echo server (`scripts/plugin-spike-echo.mjs`, port 18399), which logs field names and
a few values, never the token.

## Run (owner, on Windows, real Claude Code)

1. In a terminal at the repo root: `node scripts/plugin-spike-echo.mjs` (leave it running).
2. Install: `claude plugin marketplace add Undermix96/heph`, then
   `claude plugin install heph@heph --scope user`.
3. When asked, enter the Heph agent URL (e.g. `http://<server>:8081`, no trailing slash)
   and the API token from Heph Settings.
4. Start a new `claude` session in this repo and go through the checklist.

## Checklist

| #   | Check                                                                | How                                                                                                                      | Pass when                                                                                                                                |
| --- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `userConfig` prompt; token stored as sensitive                       | install step 3                                                                                                           | prompt appears; token not in `~/.claude/settings.json`                                                                                   |
| 2   | `${user_config.*}` in `.mcp.json`                                    | `/mcp` in the session                                                                                                    | `plugin:heph:heph` connected; ask Claude to call its `list_projects`                                                                     |
| 3   | SessionStart stdout injected                                         | ask Claude "what is the Heph check code and session id?"                                                                 | answers `HEPH-OK-7319` (`HEPH-OK-7320` after the update in row 8) and an id; echo log shows `session-start` with `x-spike-shell: bash …` |
| 4   | Stop command hook (shell form; exec form failed on Windows, see D57) | send any message                                                                                                         | echo log shows `/hooks/v1/stop`                                                                                                          |
| 5   | Stop block once, no loop                                             | first reply                                                                                                              | Claude adds `SPIKE-STOP-OK` once; later turns are normal                                                                                 |
| 6   | HTTP hook token from plugin option                                   | ask Claude to run `git status`                                                                                           | echo log `pre-tool-use` and `post-tool-use` with `token: present (N chars)`; note `tool_response_type/keys`                              |
| 7   | SessionEnd HTTP hook                                                 | `/exit`                                                                                                                  | echo log shows `/hooks/v1/session-end` with `reason`                                                                                     |
| 8   | Update without `version`                                             | after Claude pushes a new commit: `claude plugin marketplace update heph`, `claude plugin update heph@heph`, new session | check code becomes the new one                                                                                                           |

Report for each row: pass / fail and the relevant echo log lines.
Afterwards: `claude plugin uninstall heph@heph` (the real plugin replaces it).
