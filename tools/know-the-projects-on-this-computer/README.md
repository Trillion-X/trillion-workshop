# tools/know-the-projects-on-this-computer/

The projects found on this computer, as a panel: each project card shows its folder, git state, the AIs and teams working in it and its last activity; a person adds a project by path, hides or pins one, refreshes from folders to scan, and picks the current project.

Came from bitfield-packages `packages/projects` (commit d926b7adb8), moved here in 2402dcae5. Its old job file `things-to-store-and-run.json` (the feeds, the actions and the two publish triggers) was parked in the private repository beside this one, commit 2ffc5af3e, path `tools/know-the-projects-on-this-computer/from-bitfield-packages/projects/things-to-store-and-run.json`, and removed from the Workshop in 332230b33.

Verdicts, the file:line evidence and what is still open: verify-every-port research row `verify-every-port/know-the-projects-on-this-computer`.

## Files

| File | Purpose |
|------|---------|
| `index.tsx` | The panel's entry. Takes the raw feed values and the action callbacks as props, decodes the feeds, renders `ProjectsPanel`. No retired runtime import. |
| `show/ProjectsPanel.tsx`, `show/ProjectCard.tsx`, `show/mount-projects.tsx` | The panel, its cards, and the mount that `see-what-is-being-worked-on` renders. |
| `read-data/project-card-types.ts` | The `ProjectCardData`, `ProjectCardMode` and git-status types (written in L14: they were imported but absent). |
| `read-data/read-known-projects.ts`, `read-current-project.ts`, `read-json-payload.ts` | Decode the feeds into project cards, the registry options and the current project. |
| `do-work/scan-project-folders.mjs` | Scans folders for project markers and returns the records; `validateOneProjectPath` is the add check. Ids are BLAKE3 (`content-identity`), not SHA-256. Run directly: `node do-work/scan-project-folders.mjs '<json config>'`. |
| `do-work/publish-current-project.mjs` | The pure parts of publish-current-project: the change predicate, the runtime-loaded predicate, the current-project payload. |
| `do-work/add-known-project.ts`, `hide-known-project.ts`, `pin-known-project.ts`, `refresh-known-projects.ts`, `select-current-project.ts` | Retired request senders (they import `@bitfield/runtime-kit`). Nothing imports them now. Kept until their replacement route exists. |
| `test/scan-project-folders.test.mjs`, `test/publish-current-project.test.mjs` | Tests for the ported functions. |

## Not wired yet

- The feed source: nothing supplies `projectsFeed` / `currentProjectFeed`. `see-what-is-being-worked-on/packages/projects/show/mount-projects.tsx` renders `<Projects />` with no props, so the panel is empty.
- The actions add, hide, pin, select and refresh have no route. Their old writes were facts in the retired runtime. A current store and write route need an owner decision (which database holds a person's pins and selection).
- The publish-current-project wake (the two triggers) needs the engine's waiter (`tool:notice-when-something-shows-up`, `row-changes.mjs`) and a workflow row. Its predicates are in `do-work/publish-current-project.mjs`.
- The scan has no runner on the person's computer yet (no tool row names it).
- Retired-runtime imports remain in the five `do-work/*.ts` senders.
- The copy in `see-what-is-being-worked-on/packages/projects/show/` (ProjectsPanel, ProjectCard) is another tool's; it still imports the missing `@/packages/projects/...` alias. Not touched here.

## Dependencies

**Depends on:** `tools/content-identity` (BLAKE3 ids, via `../../content-identity/read-data/identity.mjs`), `tools/ui` and `tools/screen-arrangement` (the panel's components).

**Depended on by:** `tools/see-what-is-being-worked-on` (`packages/projects/show/mount-projects.tsx` imports this folder's `index.tsx`).
