---

name: new-project
description: Start a new project tracked in Heph (Hephaestus). Use when the user wants to start, create or bootstrap a new software or DIY project ("start a new project…", "nuovo progetto…"). Creates the folder and git repo with README, LICENSE, DECISIONS.md and CLAUDE.md, optionally the GitHub repo, then registers the project in Heph with proposed macro-phases. For DIY projects without code it only registers the project in Heph.
---

# New project (Heph)

Bootstraps a project the way the owner works (spec §9, D64). Follow the steps in order.
Ask only for what is missing from the user's request, all missing items in one message.

## 1. Gather

| Item               | Notes                                                                                   |
| ------------------ | --------------------------------------------------------------------------------------- |
| Kind               | software (repo) or DIY (no repo: go to step 5)                                          |
| Name               | human name, e.g. "Weather station ESP32"                                                |
| Folder             | where to create it; must be new or empty. Suggest `<parent of the current repo>/<Name>` |
| Visibility         | public or private GitHub repo                                                           |
| Stack              | `node` (Node.js / TypeScript), `python`, `platformio` (C++ / ESP32), or `generic`       |
| Short description  | 1–2 sentences                                                                           |
| Tags               | e.g. software, diy, 3d-print                                                            |
| Design docs folder | optional, copied into `docs/design/`                                                    |

Never invent values: if the user does not know something, use `TBD` where the script allows it.

## 2. Versions (only node / python)

The script writes `.nvmrc` / `.python-version` only if you pass a version. Check the current
LTS (Node: https://nodejs.org/dist/index.json, first entry with `lts`; Python: the latest stable
3.x on https://www.python.org/downloads/) and tell the user the version and the date you checked.
If you cannot check, omit the option.

## 3. Run the script

From this skill's base directory:

```bash
bash "<skill base dir>/scripts/bootstrap.sh" --dir "<folder>" --name "<Name>" \
  --visibility public|private --stack node|python|platformio|generic \
  --description "<short description>" [--design-dir "<folder>"] \
  [--node-version <x>] [--python-version <x>] [--no-github]
```

- It refuses a non-empty folder (exit 2): ask for another folder, never empty one yourself.
- It creates: `.gitignore` for the stack, `.editorconfig`, `.gitattributes`, `README.md`,
  `DECISIONS.md` (D1 = bootstrap), minimal `CLAUDE.md`, `LICENSE` (MIT, public only, holder from
  `git config user.name`), the first commit, and a second commit with the design docs if given.
- GitHub: only when `gh` is installed and signed in; the remote is SSH. Otherwise it says why it
  skipped (`HEPH_GITHUB=skipped: ...`); tell the user, the local repo is still fine.
- Read the result lines `HEPH_DIR`, `HEPH_SLUG`, `HEPH_REPO` (`owner/name` or empty),
  `HEPH_GITHUB`, `HEPH_PUSHED`.

## 4. Fill the docs

Replace the `TBD` in `README.md` (setup and commands for the stack) and in `CLAUDE.md` (commands)
only with facts you know; keep the rest `TBD`. Commit (`Docs: fill README and CLAUDE.md`) and
push if `HEPH_PUSHED=true`.

## 5. Register in Heph

1. Propose 3–6 macro-phases (title + one line each) from the description; let the user adjust them.
2. Then call the Heph MCP tool `create_project` with `name`, `description`, `tags`,
   `repos: ["<HEPH_REPO>"]` when there is a GitHub repo (DIY or no repo: no `repos`, the project
   gets internal docs), and `phases` with their first tasks if the user gave any.
3. If the repo exists only locally, say that the user can link it later with `link_repo` once it
   is on GitHub.

## 6. Summary

Report in the user's language: folder, files created, commits, GitHub result (created / skipped
and why), the Heph project and its phases, and the one next step.
