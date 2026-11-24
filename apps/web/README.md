# @heph/web

Web UI of Hephaestus (Vite + React). For now it only covers the setup wizard and login (phases 1–2); the full UI is phase 4 (§12), following the approved design in [`docs/design/`](../../docs/design/).

| Path                    | Contents                                                                    |
| ----------------------- | --------------------------------------------------------------------------- |
| `src/main.tsx`          | Setup / login / signed-in screens.                                          |
| `src/api.ts`            | Minimal REST client (session cookie).                                       |
| `src/i18n/strings.ts`   | IT/EN strings; to be replaced by a real i18n setup in phase 4.              |
| `src/styles/tokens.css` | Copy of `docs/design/tokens.css` (the single source of design values, D22). |

Commands (from the repo root): `npm run dev:web` (Vite on its own port, proxies `/api` to `:8080`), `npm run build -w @heph/web` (output in `dist/`, served by the server in the image).
