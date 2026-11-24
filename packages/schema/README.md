# @heph/schema

Shared contract of Hephaestus: Zod input schemas, enums and view (output) types used by the server, the MCP adapter and the web UI. No runtime dependencies besides Zod, no I/O.

| File            | Contents                                                                                                                                   |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/enums.ts`  | Sources, lifecycle and activity states, phase/material/proposal states, event kinds, languages.                                            |
| `src/inputs.ts` | Input schemas for every domain operation, settings and their defaults, restructure operations (D38), `normalizeRepo()` for GitHub remotes. |
| `src/views.ts`  | Types returned by the domain (and therefore REST/MCP). Timestamps are UTC ISO strings (`IsoTime`, D39).                                    |

Rules:

- Changing a schema changes the API for both the UI and the agent: update the callers and the tests in the same commit.
- The web UI may import this package; it must stay free of Node-only code.
