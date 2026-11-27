---
name: migrate-project
description: Move an existing project's work state (roadmap, tasks, next step, progress notes, open questions) from files in its repo (PROGRESS.md, ROADMAP.md, HANDOFF, plan files) into Heph (Hephaestus), or record that the project keeps its files. Use when the user wants to migrate or import a project into Heph ("migra il progetto su Heph", "import this project"), or when the Heph session-start text proposes it for an unlinked repo.
---

# Migrate a project to Heph

Standard procedure for existing projects (spec §13, D65–D69). Two outcomes, chosen by the
user: **migrate** (work state into Heph, decisions in `DECISIONS.md`) or **keep legacy**
(the project keeps its files and says so in its `CLAUDE.md`). Follow the steps in order.
Write repo files in English; talk to the user in their language.

Rules for the whole procedure:

- Nothing is lost: every source item ends in Heph, in `DECISIONS.md` or the project's
  `CLAUDE.md`, or stays in the repo unchanged. Anything that fits nowhere is flagged `TBD` for the user, never dropped.
- Never invent data: no made-up dates, done states or decisions. Unknown stays unknown.
- Nothing is written to Heph or the repo before the user approves the reconciliation report.
- In `private/` read docs only, never real-data files (spreadsheets, exports, databases).
- Existing Italian docs stay in Italian; new repo text is English. Diary notes follow the
  content language of the Heph briefing.

## 0. Choice

Ask: migrate to Heph, or keep the current files?

**Keep legacy:** check that tracked files are clean (as in step 1), then add this line near the top of the project's `CLAUDE.md` (create a minimal
one if missing), with the tracking file(s) and today's date:

```
Work state: legacy (<file(s)>), not tracked in Heph — chosen YYYY-MM-DD.
```

The line must start exactly with `Work state: legacy`: Heph's session-start text looks for it
(D66). Commit `Docs: keep file-based work tracking`, push if there is a remote, tell the
user that Heph will leave this repo alone and that they can migrate later by deleting the line. Stop.

**Migrate:** continue.

## 1. Preconditions

- Tracked files clean (`git status --porcelain --untracked-files=no` empty); otherwise ask the
  user to commit first. Untracked sources are handled in step 2.
- Heph reachable (`list_projects` works). The Heph server must take `origin`,
  `occurred_at` and done tasks in `create_project` (D65); if a call refuses these
  parameters, stop and tell the user to update Heph.
- GitHub remote: `owner/name` from `git remote get-url origin`. Without one there is no
  `repos` / `link_repo` yet: decisions still go in the repo's `DECISIONS.md` and Heph's
  internal docs stay empty, so linking the repo once it is on GitHub switches Heph to it
  (D68, D69). If decisions are kept in another file (e.g. an ADR index), tell the user to pass
  `docs_path` when the repo is linked later. If an existing Heph project already has internal
  docs, linking will not switch it: ask the user whether to move those docs into the repo's
  `DECISIONS.md` so decisions stay in one place.
- `list_projects`: if a project already exists for this repo or name, ask whether to fill
  that one or create a new one.
- Note the pre-migration commit (`git rev-parse --short HEAD`) and write it into every later
  command as `<SHA>` (shell variables do not survive between tool calls). Later reads of
  tracked sources use `git show "<SHA>:<path>"` (`| cat -n` for numbered lines).

## 2. Inventory → manifest

1. Find the sources: tracking files (`PROGRESS.md`, `ROADMAP.md`, `TODO.md`, `HANDOFF*`,
   `*plan*.md`, roadmap chapters of design docs), decision files (`DECISIONS.md`,
   `docs/adr/`, decision sections inside other docs), `CLAUDE.md`, `README.md`. Search the
   whole repo, not only the root: tracked files (`git ls-files`), untracked ones
   (`git ls-files --others --exclude-standard`) and ignored folders
   (`git ls-files --others --ignored --exclude-standard --directory`; look inside only
   `private/` and doc-like folders, never `node_modules`, build output or data files), including
   non-Markdown tracking files (`TODO.txt`, `ROADMAP` without extension). Show the list, with
   tracked or untracked for each, and let the user add or remove files.
   Once the user confirms the list: sources git does not track have no history, so copy each
   one to the scratchpad (`migration-<slug>-sources/<path>`) and use those copies as their
   pre-migration version from now on.
2. Read every source fully. Split it into numbered items `S1…Sn`, one per statement that
   carries information: a phase or milestone (with its verification criterion and outcome),
   a task (done or open, with any date), the next step, the status (testing, waiting for…),
   an open question (open or answered), a decision, a deviation, an incident, a risk, a dated
   progress entry, a rule or constraint that holds for the whole project, a reminder, anything
   else. Keep the source file and line range per item, read from the file itself
   (`git show <SHA>:<path> | grep -n …`, or `cat -n` on the scratchpad copies), never estimated.
   The same fact stated in two sources is two items; the second gets the target "same as Sx".

## 3. Mapping → reconciliation report

Give every item exactly one target:

| Source item | Target |
| --- | --- |
| Phase / milestone | Heph phase; verification criterion, outcome, dates and any other attribute in its description |
| Phase done in the source with no tasks | Heph phase, then `update_phase status: done` after creation; source date in its description (the completion time will be today) |
| Task | Task in its phase: `{title, notes, done, done_at}`; long text (over 300 characters) in `notes` |
| Done task without a date | `done: true` without `done_at`, and the notes say "completion date unknown, imported YYYY-MM-DD"; mark it `done (date unknown)` in the report |
| Next step | `set_next_task` (only if it differs from the computed one); if it is not a task yet, add it as a task of the current (first open) phase, or ask the user where |
| Status, what to test, what we wait for | `set_status` with a note. A source status of completed or abandoned: tell the user; it becomes a proposal they approve in Heph |
| Dated progress entry, incident, reminder | `log_progress` with `occurred_at` (source date) and `origin` |
| Undated progress text | one diary note "Imported notes", `origin` set |
| Open questions | one diary note "Open questions": open ones as `- [ ]`, answered ones as `- [x] answer (date)` |
| Decision, deviation (the "why") | `DECISIONS.md` entry; existing entries kept as they are |
| Durable rule, constraint or convention found in a tracking file | `DECISIONS.md` entry if it is the why of a choice, else a rule in the project's `CLAUDE.md`; never only in task notes or the diary (the tracking file is deleted) |
| Spec, design, risk register, other durable docs | stay in the repo, unchanged |
| Fits nowhere | `TBD`: ask the user |

Decisions: if the repo already has a decision file in another format (e.g. an ADR folder),
ask whether to keep it as is or to add a `DECISIONS.md`. Heph shows one docs file per repo:
to keep an ADR folder, point Heph at its index (`link_repo` with `docs_path`, which also
updates a repo that is already linked, D68; check the reply's docs path). Tell the user that
Heph shows only the index, so every new ADR must also be added to the index.
Never rewrite or renumber existing decisions.

Limits: 50 phases, 200 tasks per phase, titles up to 300 characters, `origin` up to 200.

`origin` for everything imported: `migration YYYY-MM-DD: <source path>@<SHA>`.

Times: `done_at` / `occurred_at` take `YYYY-MM-DD` (read as 12:00 UTC) or an ISO date-time; use
the snake_case names exactly. For something dated today, omit them (a plain date of today is
refused before 12:00 UTC).

Write the report to the scratchpad as `migration-<slug>.md`: header (project, SHA, sources),
then a table `Sx | source file:lines | summary | target | details` and totals per target,
counted from the table's target column, never written by hand; the totals sum to the number
of `Sx` rows. Keep only the target category in that column (specifics go in details), then:
`awk -F'|' '/^\| S[0-9]+ /{t=$5; gsub(/^ +| +$/,"",t); print t}' <report> | sort | uniq -c`
Show the report (or its totals and every `TBD`) to the user.

## 4. Verifier #1 (before writing)

Start a fresh subagent that has not seen your reasoning. Give it only: the repo path, the
SHA, the list of source paths (with the scratchpad copies of untracked ones), and the report
file. Ask it to:

- read every tracked source with `git show <SHA>:<path>` (untracked ones from their copies)
  and check that every statement is covered by
  an item, and every item has one target;
- check that nothing is altered: dates, done/open states, numbers, names, decision wording;
- check that every target follows the mapping table (e.g. no durable rule targeted only at
  task notes or the diary);
- report gaps and changes with file and line, and nothing else. It does not write anything.

Fix the report and rerun with a fresh subagent until it reports no gaps (at most 3 rounds in
total; then show the remaining findings to the user). Then ask the user to approve the report. Do not continue
without a clear yes.

## 5. Write to Heph

1. `create_project` with `name`, `description`, `tags`, `repos` (if on GitHub), `origin`,
   and `phases` with their tasks in order (done ones as `{title, done: true}`, plus `done_at`
   when the source gives a date). Or,
   for an existing project: compare with its phases first and ask how to merge duplicates;
   then `add_phase` / `add_task` and `complete_task`. These take no `origin` and completions
   get today's date and each one writes a completion event in the diary, so write
   `imported from <origin>, done <date>` in the task notes and tell the user how many
   completion events to expect.
2. Diary notes in chronological order with `log_progress` (`occurred_at`, `origin`), then the
   "Open questions" and "Imported notes" notes.
3. `set_status` and `set_next_task` if the report says so.
4. Linking the repo imports one year of commits by itself (D62); do not add them by hand.

## 6. Repo changes (one commit)

- `DECISIONS.md`: create it if missing (format of the user's global rules) or keep it;
  move decisions found in the tracking files into new entries; add the entry
  "Work state moved to Heph" citing `SHA` and the Heph project slug.
- Delete the tracked tracking files that are now fully in Heph (`git rm`). Never delete a
  file git does not track (no history would keep it): leave it, or ask the user to archive it. Files that also hold
  durable content (spec, design) stay; only their work-state sections are removed, with a
  one-line pointer to Heph.
- `CLAUDE.md`: sources-of-truth table with a `Heph project <slug>` row (roadmap, next step,
  diary; read at session start, injected by the heph plugin) and the `DECISIONS.md` row, like
  the `new-project` template; add the durable rules, constraints and conventions the report
  maps to `CLAUDE.md`, keeping their wording; remove rules that point to the deleted files.
- `README.md`: fix the docs index.
- Commit `Docs: move work state to Heph`, push if there is a remote. Record the new commit hash.

## 7. Verifier #2 (after writing)

Start another fresh subagent. Give it only: the repo path, the SHA, the source list (with the
scratchpad copies of untracked ones), the report file, the Heph project slug and the
migration commit. Ask it to compare, item by item:

- each `Sx` against Heph (`get_project`, `get_diary`, `get_docs`, `search`) or the repo at the
  migration commit, as the report says;
- that the deleted files contain nothing that is missing from Heph or the repo;
- that every rule the report maps to `CLAUDE.md` or `DECISIONS.md` is there at the migration
  commit, not only in task notes or the diary;
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
