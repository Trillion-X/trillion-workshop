# signed-event-effects/do-work/

Target handler source for generic signed-event effect projection.

## Files

| File | Purpose |
|---|---|
| `signed-event-effects-targets.js` | Reads descriptor-supplied rules, creates generic effect records from signed-event facts, sends writes to the descriptor-selected owner, and reads effect lists from the descriptor-selected reader. |
| `signed-event-effects-targets.d.ts` | Type declaration for hosted TypeScript entry modules that mount the JavaScript target handlers. |

## Boundary

This folder contains no product policy, provider clients, concrete target addresses, or event-family constants. Rule matching, write routing, and read routing are input data.
