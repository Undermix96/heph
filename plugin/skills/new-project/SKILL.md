---
name: new-project
description: Start a new project tracked in Heph (Hephaestus). Use when the user wants to start, create or bootstrap a new software or DIY project ("start a new project…", "nuovo progetto…"). Creates the folder and git repo with README, LICENSE, DECISIONS.md and CLAUDE.md, optionally the GitHub repo, then registers the project in Heph with proposed macro-phases. For DIY projects without code it only registers the project in Heph.
---

# New project (Heph)

Bootstraps a project the way the owner works (spec §9, D64). Follow the steps in order.
Ask only for what is missing from the user's request, all missing items in one message.

## 1. Kind

Software (with a repo) or DIY (no code, no repo). If unclear, ask this first.

- **DIY:** ask only for name, short description and tags, then go to step 5.
- **Software:** continue with step 2.

## 2. Gather (software)

| Item | Notes |
| --- | --- |
| Name | human name, e.g. "Weather station ESP32" |
| Folder | must be new or empty. Suggest the folder where the user keeps projects plus the name (e.g. `D:\Git\<Name>`, next to the current repo); if unsure, ask |
| GitHub | public repo, private repo, or none for now (`--no-github`; visibility still decides the LICENSE) |
| Stack | `node` (Node.js / TypeScript), `python`, `platformio` (C++ / ESP32), or `generic` |
| Short description | 1–2 sentences |
| Tags | e.g. software, diy, 3d-print |
| Copyright holder | public repos only: the user's handle, never a real name. Default `git config user.name`; confirm it and pass `--holder` |
| Design docs folder | optional, copied into `docs/design/` |

Never invent values: if the user does not know something, leave it `TBD`.

## 3. Versions (only node / python)

The script writes `.nvmrc` / `.python-version` only if you pass a version. Check the current
version first and tell the user the version and the date you checked; if you cannot check,
omit the option.

- Node: the newest entry with `lts` in https://nodejs.org/dist/index.json, as `26.13.1`.
- Python: the latest stable 3.x on https://www.python.org/downloads/, as `3.14` (minor only).

## 4. Run the script

From this skill's base directory:

```bash
bash "<skill base dir>/scripts/bootstrap.sh" --dir "<folder>" --name "<Name>" \
  --visibility public|private --stack node|python|platformio|generic \
  --description "<short description>" [--holder "<handle>"] [--design-dir "<folder>"] \
  [--repo-name <name>] [--node-version <x>] [--python-version <x>] [--no-github]
```

It writes `.gitignore` for the stack, `.editorconfig`, `.gitattributes`, `README.md`,
`DECISIONS.md` (D1 = bootstrap), a minimal `CLAUDE.md`, `LICENSE` (MIT, public only), the first
commit, and a second commit with the design docs. With `gh` installed and signed in it creates
the GitHub repo, sets an **SSH** remote and pushes.

Read the result lines `HEPH_DIR`, `HEPH_SLUG`, `HEPH_REPO` (`owner/name` or empty),
`HEPH_GITHUB`, `HEPH_PUSHED`, and handle the outcome:

| Outcome | What to do |
| --- | --- |
| exit 2 (bad option, folder not empty) | Fix the option or ask for another folder. Never empty or delete a folder yourself |
| exit 1 (git missing, no git user.name / user.email) | Nothing was written: tell the user what to set up, then run again |
| `HEPH_GITHUB=skipped: …` | Tell the user why; the local repo is fine. GitHub can be added later (below) |
| `HEPH_GITHUB=failed: …` (e.g. the name is taken) | Ask for another repo name, then add GitHub by hand (below) |
| `created, push failed` | Tell the user to check the SSH key, then `git push -u origin main` |

Adding GitHub by hand (never `gh repo create --source --push`: it may set an HTTPS remote):

```bash
gh repo create <repo-name> --private   # or --public
git -C "<folder>" remote add origin git@github.com:<owner>/<repo-name>.git
git -C "<folder>" push -u origin main
```

## 5. Register in Heph

1. Propose 3–6 macro-phases (title + one line each) from the description; let the user adjust them.
2. Call the Heph MCP tool `create_project` with `name`, `description`, `tags`, `phases` (with
   first tasks if the user gave any) and `repos: ["<HEPH_REPO>"]` only when a GitHub repo exists.
   DIY or no GitHub repo: no `repos` (the project gets internal docs).
3. Software only: `create_project` returns the project's slug. If it differs from `HEPH_SLUG`,
   fix the slug in the repo's `CLAUDE.md` and commit (`Docs: Heph project slug`).
4. A repo that is only local can be linked later with `link_repo`, once it is on GitHub.

## 6. Fill the docs (software)

Replace `TBD` in `README.md` (setup and commands for the stack) and in `CLAUDE.md` (commands)
only with facts you know; keep the rest `TBD`. Commit (`Docs: fill README and CLAUDE.md`) and
push if there is a remote.

## 7. Summary

Report in the user's language: the Heph project and its phases; for software also the folder,
files, commits and the GitHub result (created / skipped and why); and the one next step.
