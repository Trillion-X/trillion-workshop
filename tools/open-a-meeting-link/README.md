# tools/open-a-meeting-link/

Reads a meeting link (a deep link such as `zoommtg://...` or a web address) through declared routes: which meeting app it is for, what it asks (join, start, schedule, launch) and its parameters. The host is checked first. It can also open the link in the app that owns it, so an agent takes the same road a button does. Secret parameters (passcodes, payloads) are never returned, and a refused link is never opened. It runs on the person's own computer as two `computer` rows.

## Files

| File | Purpose |
|------|---------|
| `read-data/meeting-links.mjs` | `readLink(text, settings?)`, `applyRoster(roster, update)`, `linkTools.read` / `linkTools.open`, and the named exports `read` and `open` that `run-an-export.mjs` calls. |
| `read-data/meeting-links.json` | The routes: schemes, host patterns, actions with their parameters and needed ones, each parameter's form and whether it is secret, and every sentence said. A new meeting app is one more route. |
| `tool-rows.json` | `tool:read-meeting-link` (no capability) and `tool:open-meeting-link` (`open-links-in-their-apps`), run by `tools/records-door`'s `run-an-export.mjs`. |
| `part.json` | Nothing here is imported by other code. |
| `test/meeting-links.test.mjs` | The old app's tests, repointed to this folder. |
| `test/tool-rows.test.mjs` | The rows' capabilities and exports. |

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| `readLink` | `(text, settings?) => { route, action, params, secret_params, redacted }` | Checks the host against the route's list before reading any parameter. It keeps only the parameters the action names and refuses one that is not in its form. |
| `applyRoster` | `(roster, { mode: 'full' \| 'incremental', attendees, removed? }) => roster` | A full update replaces the roster. An incremental one adds, changes and removes attendees by id. |
| `open` | `({ link }) => { opened, route, action, redacted }` | Reads the link first, then hands it to `/usr/bin/open`. |

## Moved from Trillion

`computer/meeting-links.mjs`, `computer/meeting-links.json` and `test/meeting-links.test.mjs` of Trillion-X/trillion (deleted there in `dc79bb0a`), moved one to one. Only the two named exports were added, for `run-an-export.mjs`.

## Not yet

- The `open-links-in-their-apps` capability is not in the engine's `product/computer-capabilities.json`. Until the engine's owner adds it, `tool:open-meeting-link` is refused. Its sandbox rule for starting `/usr/bin/open` is measured there, not here. `tool:read-meeting-link` needs no capability.
- Neither row has been proved end to end on the engine.

## Dependencies

**Depends on:** `tools/records-door` (`run-an-export.mjs`), Node's standard library, and the computer's `/usr/bin/open` for opening.

**Depended on by:** `tool-rows.json`.
