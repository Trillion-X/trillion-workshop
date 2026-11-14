# tools/group-pages/

A group page: a group's name, summary and access, the posts its members share on it, joining the group, and the owner actions that create a page, share an item, read the page's projection and move static items into it. Moved here byte for byte from bitfield-packages `packages/group-page`, where Workshop held nothing of it (the community tools here are old Trillion's community code, a different design). This folder is a prepared restore: the files are the originals and are not yet wired to a tool row.

## Files

| File | Purpose |
|------|---------|
| `moved-from.json` | The receipt: each file's source path and commit, its identity at the source and here, the tests held and why. |
| `do-work/create-group-page.ts`, `create-group-post.ts`, `join-group.ts`, `invoke-owner-action.ts`, `migrate-static-projection-items.ts`, `read-group-page-projection.ts`, `refresh-group-pages.ts` | The actions: browser intent in, owner-action requests out; the actor, time, item identity and owner targets are the owner's. |
| `read-data/read-group-page.ts`, `read-group-page-items.ts`, `read-subject-surfaces.ts`, `generic-record-projection.ts`, `use-member-names.ts`, `group-page-surface.js` | The read side: a scoped feed decoded into group pages, items and subject surfaces. |
| `show/GroupPageView.tsx`, `show/mount-group-page.tsx` | The group page screen. |
| `tests/` and the `.test.ts` beside each action | The package's tests. Six are held (`.held`): they import the retired package runtime, or read the built bytes. |

## What is held

- Every action and the screen call `sendRequestToBitfieldTarget` and `useBitfieldData` from the retired package runtime (`@bitfield/runtime-kit`); they need the records door in its place before a tool row can run them.
- `do-work/ensure-group-membership.ts`, its test and `show/GroupPageView.test.tsx` exist in the package working tree but were never committed there, so they carry no source commit and are not here. Commit them in the package, then move them.
- The package boundary file (`things-to-store-and-run.json`: the generic record-projection contract and the owner-action descriptors) is not carried: it holds retired-runtime rows.
