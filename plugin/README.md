# Heph plugin for Claude Code

Connects Claude Code to a Hephaestus (heph) server: every session starts with the
project briefing and rules, the dashboard shows when Claude is working or running
tests, Claude is reminded to keep the diary, and local edits to `DECISIONS.md` show
in the Documentation tab before they are pushed. Spec §9; decisions D57, D58, D59.

## Install

The exact commands, with your server's URL, are on Heph's **Settings > Connect
Claude Code** page.

```powershell
claude plugin marketplace add Undermix96/heph
```

```powershell
claude plugin install heph@heph --scope user
```

Then, inside a Claude Code session, run `/plugin configure heph@heph` and enter:

| Option         | Value                                                                      |
| -------------- | -------------------------------------------------------------------------- |
| Heph agent URL | the agent port as this machine reaches it, e.g. `http://192.168.1.10:8081` |
| Heph API token | Settings > Connect Claude Code; stored in the system credential store      |

If you added Heph's MCP server by hand before, remove it, or Claude Code skips the
plugin's copy (D57):

```powershell
claude mcp remove heph --scope user
```

Update with `claude plugin marketplace update heph` and `claude plugin update heph@heph`;
the installed version is the commit (no `version` field, D57).

## What it contains

| Part        | File                   | Does                                                                     |
| ----------- | ---------------------- | ------------------------------------------------------------------------ |
| MCP server  | `.mcp.json`            | Heph's tools over Streamable HTTP, URL and token from the plugin options |
| Hooks       | `hooks/hooks.json`     | SessionStart, Stop, Pre/PostToolUse (Bash, PowerShell), SessionEnd       |
| Hook script | `scripts/heph-hook.sh` | forwards each hook to `/hooks/v1/*` and prints the answer                |

The script needs only `bash`, `git` and `curl` (Git Bash on Windows). It never blocks
a session: if Heph is not configured, refuses the token or is unreachable, the session
starts with a one-line notice and every other hook stays silent.

## Privacy and security

- Sent to your Heph server only: the hook input Claude Code provides (session id,
  working folder, tool name, the shell command, its output for tool hooks), the git
  remote URL, HEAD and a hash of `git status`, and the content of the repo's docs
  file when it changed.
- The agent port is LAN only (D24); the token travels in an `Authorization` header and
  appears in the `curl` command line of the local machine.

The 5.0 feasibility spike and its checklist are in `SPIKE.md` (superseded).

## Tests

`apps/server/src/plugin.hooks.test.ts` runs this script against a real server in
temporary git repos with invented data (`npm test`). On Windows it uses Git Bash
(`HEPH_TEST_BASH` overrides the path).
