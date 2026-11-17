# tools/know-the-projects-on-this-computer/

The projects found on this computer, as a panel: each project card shows its folder, git state, the AIs and teams working in it and its last activity; a person adds a project by path, hides or pins one, refreshes from folders to scan, and picks the current project.

Moved here byte for byte from bitfield-packages `packages/projects` by hand, with the receipt `from-bitfield-packages/projects/moved-from.json` naming each file's source path and commit and the identity of its bytes there and here.

## Files

| File | Purpose |
|------|---------|
| `index.tsx` | The panel's entry: reads the projects and current-project feeds and wires the actions to `ProjectsPanel`. |
| `show/ProjectsPanel.tsx`, `show/ProjectCard.tsx`, `show/mount-projects.tsx` | The panel and its cards. |
| `read-data/read-known-projects.ts`, `read-current-project.ts`, `read-json-payload.ts` | Decode the feeds into project cards, the registry options and the current project. |
| `do-work/add-known-project.ts`, `hide-known-project.ts`, `pin-known-project.ts`, `refresh-known-projects.ts`, `select-current-project.ts` | One request per action. |
| `do-work/process-scripts/read-known-projects.py` | Scans folders it is given for project markers (package.json, Cargo.toml, pyproject.toml, go.mod, deno.json, bun.lockb, .git, .claude) and prints project records as JSON. |
| `from-bitfield-packages/projects/things-to-store-and-run.json` | The package's own records: the feeds, the actions and the triggers that publish projects. |

## Not wired yet

- Nothing here runs as a tool: the actions send requests to `slot::workflow` and the entry reads `@bitfield/runtime-kit`, the retired Bitfield runtime. Wiring (a `tool-rows.json` that runs the scan on the person's computer, the actions as rows) is held for the lead.
- `read-data/project-card-types.ts` (`ProjectCardData`) is imported by `read-known-projects.ts` but was never in the source package or its history; it has to be written from how `ProjectCard.tsx` and `read-known-projects.ts` use the type.
- The scan script names its project ids with SHA-256; moved as it was.

## Dependencies

**Depends on:** the retired Bitfield runtime kit (the feeds and request sender), `tools/ui` components (not in this repository).

**Depended on by:** nothing yet.
