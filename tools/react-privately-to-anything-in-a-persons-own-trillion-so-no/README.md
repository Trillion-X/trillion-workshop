# tools/react-privately-to-anything-in-a-persons-own-trillion-so-no/

React privately to anything in a person's own Trillion so no space or other account can read the reaction.

Moved here byte for byte from Trillion-X/trillion by `tools/move-code-between-trees`; `moved-from.json` names each file's source path and commit and the identity of its bytes there and here. Trillion-X/trillion imports these files from this package. The folder keeps the source tree's own paths under it, so the files import each other as they did.

## The page route

`tool:answer-the-react-privately-route` (`tool-rows.json`) answers the page route POST /work/api/responses/react as a route tool (`{ path, method, query, body, browser }` in, `{ status, body }` out), as old trillion's person store did (src/person-store.mjs:8446, reached from src/worker.mjs:288 through src/work-responses.mjs): `src/private-responses.mjs` `react` decides, unchanged, over the person's `private-response` records read and written through the run's records door, and its answer is 200; its refusal is 400 `{ error }`; any other path or method is 404 `{ error: 'Not found.' }`. The write stands on what was read, and a reaction changed meanwhile is decided again. Old trillion also refused a request whose reach was not private (403); a page's own run is the person's whole reach, so the route never meets that case.

| File | Purpose |
|------|---------|
| `do-work/react-route.mjs` | `answerReactRoute`, run by `tools/records-door/do-work/run-an-export.mjs`; contract `ports/react-route.json` |
| `tool-rows.json` | The route row |
| `test/react-route.test.mjs` | The row against the records door stand-in: give, the same give again, take away, refusals, 404, a reaction changed meanwhile |

**Depends on:** `tools/keep-and-wake-ai-sessions-on-this-computer` (`src/responses.mjs`, `src/reactions.json`, packed by the row), `tools/records-door`, `tools/content-identity`.
