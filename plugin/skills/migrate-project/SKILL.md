---
name: migrate-project
description: Move an existing project's work state (roadmap, tasks, next step, progress notes, open questions) from files in its repo (PROGRESS.md, ROADMAP.md, HANDOFF, plan files) into Heph (Hephaestus), or record that the project keeps its files. Use when the user wants to migrate or import a project into Heph ("migra il progetto su Heph", "import this project"), or when the Heph session-start text proposes it for an unlinked repo.
---

# Migrate a project to Heph

Standard procedure for existing projects (spec §13, D65–D67). Two outcomes, chosen by the
user: **migrate** (work state into Heph, decisions in `DECISIONS.md`) or **keep legacy**
(the project keeps its files and says so in its `CLAUDE.md`). Follow the steps in order.
Write repo files in English; talk to the user in their language.

Rules for the whole procedure:

- Nothing is lost: every source item ends in Heph, in `DECISIONS.md`, or stays in the repo
  unchanged. Anything that fits nowhere is flagged `TBD` for the user, never dropped.
- Never invent data: no made-up dates, done states or decisions. Unknown stays unknown.
- Nothing is written to Heph or the repo before the user approves the reconciliation report.
- In `private/` read docs only, never real-data files (spreadsheets, exports, databases).
- Existing Italian docs stay in Italian; new repo text is English. Diary notes follow the
  content language of the Heph briefing.

## 0. Choice

Ask: migrate to Heph, or keep the current files?

**Keep legacy:** add this line near the top of the project's `CLAUDE.md` (create a minimal
one if missing), with the tracking file(s) and today's date:

```
Work state: legacy (<file(s)>), not tracked in Heph — chosen YYYY-MM-DD.
```

The line must start exactly with `Work state: legacy`: Heph's session-start text looks for it
(D66). Commit `Docs: keep file-based work tracking`, push, tell the user that Heph will
leave this repo alone and that they can migrate later by deleting the line. Stop.

**Migrate:** continue.

## 1. Preconditions

- Git tree clean (`git status --porcelain` empty); otherwise ask the user to commit first.
- Heph reachable (`list_projects` works). The Heph server must take `origin`,
  `occurred_at` and done tasks in `create_project` (D65); if a call refuses these
  parameters, stop and tell the user to update Heph.
- GitHub remote: `owner/name` from `git remote get-url origin`. Without one the project gets
  internal docs (`update_docs`) and no `link_repo`.
- `list_projects`: if a project already exists for this repo or name, ask whether to fill
  that one or create a new one.
- Record `SHA=$(git rev-parse --short HEAD)`: the pre-migration commit. All later reads of
  the sources use `git show $SHA:<path>`.

## 2. Inventory → manifest

1. Find the sources: tracking files (`PROGRESS.md`, `ROADMAP.md`, `TODO.md`, `HANDOFF*`,
   `*plan*.md`, roadmap chapters of design docs), decision files (`DECISIONS.md`,
   `docs/adr/`, decision sections inside other docs), `CLAUDE.md`, `README.md`. Search the
   whole repo (`git ls-files '*.md'`), not only the root. Show the list and let the user add
   or remove files.
2. Read every source fully. Split it into numbered items `S1…Sn`, one per statement that
   carries information: a phase or milestone (with its verification criterion and outcome),
   a task (done or open, with any date), the next step, the status (testing, waiting for…),
   an open question (open or answered), a decision, a deviation, an incident, a risk, a dated
   progress entry, a reminder, anything else. Keep the source file and line range per item.

## 3. Mapping → reconciliation report

Give every item exactly one target:

| Source item | Target |
| --- | --- |
| Phase / milestone | Heph phase; verification criterion and outcome in its description |
| Task | Task in its phase: `{title, notes, done, done_at}`; `done_at` only when the source gives a date |
| Next step | `set_next_task` (only if it differs from the computed one) |
| Status, what to test, what we wait for | `set_status` with a note |
| Dated progress entry, incident, reminder | `log_progress` with `occurred_at` (source date) and `origin` |
| Undated progress text | one diary note "Imported notes", `origin` set |
| Open questions | one diary note "Open questions": open ones as `- [ ]`, answered ones as `- [x] answer (date)` |
| Decision, deviation (the "why") | `DECISIONS.md` entry; existing entries kept as they are |
| Spec, design, risk register, other durable docs | stay in the repo, unchanged |
| Fits nowhere | `TBD`: ask the user |

Decisions: if the repo already has a decision file in another format (e.g. an ADR folder),
ask whether to keep it as is (then `link_repo` with `docs_path` pointing to its index or main
file) or to add a `DECISIONS.md`. Never rewrite or renumber existing decisions.

`origin` for everything imported: `migration YYYY-MM-DD: <source path>@<SHA>`.

Times: `done_at` / `occurred_at` take `YYYY-MM-DD` (read as 12:00 UTC) or an ISO date-time; use
the snake_case names exactly. For something dated today, omit them (a plain date of today is
refused before 12:00 UTC).

Write the report to the scratchpad as `migration-<slug>.md`: header (project, SHA, sources),
then a table `Sx | source file:lines | summary | target | details` and totals per target.
Show the report (or its totals and every `TBD`) to the user.

## 4. Verifier #1 (before writing)

Start a fresh subagent that has not seen your reasoning. Give it only: the repo path, the
SHA, the list of source paths, and the report file. Ask it to:

- read every source with `git show <SHA>:<path>` and check that every statement is covered by
  an item, and every item has one target;
- check that nothing is altered: dates, done/open states, numbers, names, decision wording;
- report gaps and changes with file and line, and nothing else. It does not write anything.

Fix the report and repeat until it reports no gaps (at most 2 more rounds; then show the
remaining findings to the user). Then ask the user to approve the report. Do not continue
without a clear yes.

## 5. Write to Heph

1. `create_project` with `name`, `description`, `tags`, `repos` (if on GitHub), `origin`,
   and `phases` with their tasks in order (done ones as `{title, done: true, done_at}`). Or,
   for an existing project, `add_phase` / `add_task` and `complete_task` (tell the user that
   completions then get today's date).
2. Diary notes in chronological order with `log_progress` (`occurred_at`, `origin`), then the
   "Open questions" and "Imported notes" notes.
3. `set_status` and `set_next_task` if the report says so.
4. Linking the repo imports one year of commits by itself (D62); do not add them by hand.

## 6. Repo changes (one commit)

- `DECISIONS.md`: create it if missing (format of the user's global rules) or keep it;
  move decisions found in the tracking files into new entries; add the entry
  "Work state moved to Heph" citing `SHA` and the Heph project slug.
- Delete the tracking files that are now fully in Heph (`git rm`). Files that also hold
  durable content (spec, design) stay; only their work-state sections are removed, with a
  one-line pointer to Heph.
- `CLAUDE.md`: sources-of-truth table with a `Heph project <slug>` row (roadmap, next step,
  diary; read at session start, injected by the heph plugin) and the `DECISIONS.md` row, like
  the `new-project` template; remove rules that point to the deleted files.
- `README.md`: fix the docs index.
- Commit `Docs: move work state to Heph`, push. Record the new commit hash.

## 7. Verifier #2 (after writing)

Start another fresh subagent. Give it only: the repo path, the SHA, the source list, the
report file, the Heph project slug and the migration commit. Ask it to compare, item by item:

- each `Sx` against Heph (`get_project`, `get_diary`, `get_docs`, `search`) or the repo at the
  migration commit, as the report says;
- that the deleted files contain nothing that is missing from Heph or the repo;
- that the repo's `CLAUDE.md` and `README.md` no longer point to deleted files.

It reports missing or changed items by `Sx` id and writes nothing. Fix what it finds (repo:
new commit; Heph: new entries, since the diary is append-only) and rerun with a fresh
subagent, at most 3 rounds in total; then show the remaining findings to the user.

## 8. Close

1. Upload the report: `request_upload` for the project, `curl -F file=@<report>` to the URL.
2. `log_progress` (no `occurred_at`): migration done; counts per target and `TBD`; SHA and
   migration commit; verifier rounds and outcome; attach the report with `file_ids`.
3. Summary for the user: the Heph project, what moved where, what stayed in the repo, open
   `TBD`s, and the one next step (checking the project in the Heph UI).
