# tools/show-the-persons-spaces-on-the-signed-in-page-answer/

Show the person's spaces on the signed-in page, answer invitations, leave a space and import a whole chat export.

Moved here byte for byte from Trillion-X/trillion by `tools/move-code-between-trees`; `moved-from.json` names each file's source path and commit and the identity of its bytes there and here. Trillion-X/trillion imports these files from this package. The folder keeps the source tree's own paths under it, so the files import each other as they did.

## Screens

| File | Purpose |
|------|---------|
| `web/src/workspace/spaces-screen.tsx` | The pursuits screens: All pursuits (`tool:screen-spaces`, `mountSpacesScreen`) and one Pursuit (`tool:screen-space`, `mountSpaceScreen`): invitations, the space cards, conversation, everything in it, people and rules. Moved byte for byte from the web client (`moved-from.json`); it imports the web shell's files as it was written, and the client build answers those imports with the shell's files. |
| `web/src/workspace/community-screen.tsx` | The places a space turns on (home, matches, tribe, discover, classroom, members, leaderboard, about), drawn inside the space's own screen; only `spaces-screen.tsx` imports it. Moved with it. |
| `web/src/workspace/space-actions.json` | DATA the pursuits screens run: each action names where it shows and what it asks and sends. Only `spaces-screen.tsx` reads it. |
| `web/src/workspace/spaces-plan-gate.tsx` | The plan gate the pursuits list shows when the account's plan does not allow more. Only `spaces-screen.tsx` mounts it. |
| `show/spaces-mount.tsx` | The All pursuits module entry, the file `tool:screen-spaces` names: `mount` is `mountSpacesScreen`. |
| `show/space-mount.tsx` | The Pursuit module entry, the file `tool:screen-space` names: `mount` is `mountSpaceScreen`. |
