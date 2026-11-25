# @heph/web

Web UI of Hephaestus (Vite + React), phase 4 (§12.4), following the approved design in [`docs/design/`](../../docs/design/). Libraries and choices: D48 (libraries), D44 (fixed error texts), D49/D50 (design scope), D52 (polling every 10 s on the visible tab).

Status: groups A and B of phase 4 (app shell, dashboard with Tests, Diary and Proposals tabs, new and edit project, project overview, roadmap, diary, documentation, materials, files with viewer, search, settings, export). Group C (states, phone layout, accessibility, Playwright, release) is next (D55).

| Path                    | Contents                                                                                                    |
| ----------------------- | ----------------------------------------------------------------------------------------------------------- |
| `src/main.tsx`          | Entry point.                                                                                                |
| `src/app/`              | Router, sign-in gate and language (`App.tsx`), top bar, page-wide notices.                                  |
| `src/api/`              | Typed REST client on the `@heph/schema` types, TanStack Query hooks and the mutation helper.                |
| `src/components/ui.tsx` | Building blocks from DESIGN.md §4 (box, buttons, status label, menu, dialog, …).                            |
| `src/features/`         | One folder per area: `auth`, `dashboard`, `diary`, `project`, `proposals`, `roadmap`, `search`, `settings`. |
| `src/i18n/`             | IT/EN dictionaries (`it.ts` defines the keys, `en.ts` must match) and `Intl` formatting.                    |
| `src/lib/errors.ts`     | Error code → fixed translated text (D44).                                                                   |
| `src/styles/`           | `tokens.css` (copy of `docs/design/tokens.css`), base, components and page styles.                          |
| `src/test/`             | Test render helper and invented fixtures.                                                                   |

Tests: logic as plain Vitest tests; components with Testing Library in happy-dom (`// @vitest-environment happy-dom`) against a fake API built with MSW on the `@heph/schema` types.

Commands (from the repo root): `npm run dev:web` (Vite on its own port, proxies `/api` to `:8080`), `npm run build -w @heph/web` (output in `dist/`, served by the server in the image).
