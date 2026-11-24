# Design brief — Hephaestus

## Name
**Hephaestus** — the Greek god of craftsmen, blacksmiths and builders. Short name: **Heph**. How (or whether) the name and its mythology influence the visual identity is up to you.

## What it is
A self-hosted web app where one person keeps track of many parallel personal projects — software projects and hands-on DIY projects (electronics, woodworking, 3D printing…). The main problem it solves: **opening a project after weeks and immediately knowing where I was, what's left, and what to do next.**

The app is also updated automatically by an AI coding assistant (Claude Code), which writes diary entries, completes tasks, uploads screenshots and changes statuses while working. The UI must make it clear what happened, who did it (me, the AI, GitHub, the system) and what the AI is doing right now.

Visual style, layout, typography, colour and interaction patterns are entirely up to you.

## Users and context
- Single user, logged in. Desktop-first, must also work on phone-sized screens.
- Interface available in Italian and English (language selector). Text lengths vary between languages.
- Content (descriptions, notes, diary, documentation) is markdown.

## Key concepts
- **Project** — name, description, tags (e.g. software, DIY), cover image, links, linked GitHub repos, progress.
- **Roadmap** — ordered **macro-phases**, each containing ordered **tasks** (exactly two levels). Progress is computed from completed tasks.
- **Next step** — the single next task to do on a project. Always visible; a project without one is flagged.
- **Status** — two things combined into what the user sees:
  - lifecycle: *in development*, *awaiting my manual test* (with a note on what to test), *on hold* (with a reason), *completed*, *abandoned*;
  - activity (computed): *AI working now*, *AI running tests now*, *recently active*, *idle*, *inactive for a long time*.
- **Diary** — chronological log of everything that happened: notes, work sessions (grouped entries from one AI session), automatic events (task done, status changed, commits from GitHub, files uploaded, test outcomes). Entries can contain images/files. Each entry shows its source.
- **Documentation** — a markdown document of decisions for the project (read-only when it comes from a GitHub repo, editable otherwise).
- **Materials** — shopping/parts list: name, quantity, link, price, notes, status (to buy / ordered / arrived / used).
- **Files** — images (photos, AI test screenshots) and other files (PDF, STL, …), attached to project, phase, task or diary entry. Can be pinned.
- **Proposals** — changes the AI wants to make that need my approval (e.g. delete a phase, mark project completed).

## Screens

### 1. First-run setup
Shown only the first time: create username and password. No registration elsewhere.

### 2. Login
Username + password.

### 3. Dashboard (home)
Overview of all projects, ordered by what needs attention:
1. awaiting my manual test
2. AI working / testing right now
3. in development but inactive or with no next step
4. in development and recently active
5. on hold
6. completed / abandoned (hidden or collapsed by default)

Per project, at a glance: name, cover (if any), tags, status/activity, progress, current phase, next step, time since last activity.
Needs: search, filter by tag and status, quick access to create a project, visibility of pending proposals and pending manual tests.

### 4. Project page
The heart of the app. Must answer instantly: *where am I, what's next, what's left.*
- Header: name, status/activity, progress, tags, links, repos, cover.
- Next step, prominent.
- Status note when relevant (what to test; what we're waiting for). For "awaiting manual test": actions "test passed" / "test failed" + notes.
- Roadmap: phases with their tasks; complete tasks, reorder, add/edit phases and tasks, set a different next step.
- Diary: timeline, with AI sessions grouped; add a note with files/images.
- Documentation tab.
- Materials tab.
- Files/gallery tab.
- Pending proposals for this project (approve / reject).
- Edit project details, change status, export.
When the AI is working on the project right now, this should be noticeable.

### 5. Create / edit project
Name, description, tags, links, repos, cover image, optional initial phases.

### 6. Search results
Across projects, tasks, diary and documentation.

### 7. Settings
- Account: change password.
- Language.
- "Connect Claude Code": shows ready-to-copy commands and the access token (regenerate token).
- GitHub token and sync interval.
- Thresholds (days for "recently active" / "inactive"), file retention, test command patterns.

## States to design for
Empty states (no projects, no diary, no materials), loading, errors, a project with no next step, very long names/descriptions, many projects (dozens), long diaries, many screenshots.
