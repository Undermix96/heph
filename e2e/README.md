# e2e

Playwright end-to-end tests of Hephaestus (D56): the real server built from this checkout, a fresh data dir in `.e2e-data/` (gitignored, deleted at every run) and **invented data** seeded by `global-setup.ts` through the agent API, as Claude Code would.

| File              | Contents                                                                                                                                                                 |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `global-setup.ts` | Creates the user, seeds invented projects, diary notes and materials, saves the signed-in state.                                                                         |
| `flows.spec.ts`   | Main workflows: dashboard, create project, roadmap keyboard move and polling, mark done, manual test, diary note with image, proposal approve, search, settings, export. |
| `a11y.spec.ts`    | axe (WCAG 2.1 AA) on every screen at 1440 and 390 px: no serious or critical violations.                                                                                 |
| `screens.spec.ts` | Full-page screenshots of every screen at 1440 and 390 px in `.e2e-data/screens/`; no sideways scroll.                                                                    |
| `pages.ts`        | The list of screens.                                                                                                                                                     |

Commands (repo root): `npm run build` then `npm run e2e`. First time only: `npx playwright install chromium`. In CI the `e2e` job runs the same and uploads the screenshots as an artifact.
