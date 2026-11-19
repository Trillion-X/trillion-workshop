# tools/workspace-screens/web/examples/standalone-workspace/

A standalone page that runs the Workshop's own workspace (the sidebar from `tools/sidebar`, the screen arrangement from
`tools/screen-arrangement`) outside the signed-in workspace page. The page starts from a records source it is given
(`setWorkspaceRecordsSource`, `src/workspace/records-source.ts`), not from the Workshop Worker. Its rows are made up.

## Files

| File | Purpose |
|------|---------|
| `seeds.ts` | The made-up sidebar rows (four placeable surfaces) and the saved state the screens read at start. |
| `entry.ts` | Mounts the records source, answers the arrangement's targets (`answerTargets`), installs the screen runner with the page's screens, and mounts the sidebar and the arrangement. |
| `index.html` | The page: a sidebar column and an arrangement column. |
| `build.mjs` | Bundles the page with esbuild, with the same plugins the workspace build uses for its page script, and assembles its stylesheet. Usage: `node build.mjs [outDir]`. |
| `sample-lesson.webm` | The lesson video the seeded lesson names (a four-second test pattern, made with ffmpeg). |
| `check.mjs` | Headless Chromium check (Playwright, the headless shell Playwright installed): serves the built page, clicks each sidebar entry, asserts its screen mounted in the arrangement, then opens a lesson from the course list, checks its video loads, clicks Mark done and reads the done row back. Saves a screenshot per step. Usage: `node check.mjs <outDir> <shotsDir>`. |
| `../../test/standalone-workspace-seeds.test.mjs` | Checks the seeded rows name screens the entry mounts and the course rows name lessons that exist. |
| `../../src/workspace/records-door-seeded.ts` | The seeded records door the course screens read through (`setRecordsDoor`). |

## What a host page provides

1. A records source, mounted once before anything reads a record: `setWorkspaceRecordsSource(seededRecordsSource(rows))`
   for a page that keeps its rows in memory, or another source with the `WorkspaceRecordsSource` shape
   (`records-source.ts`: `read`, `write`, `outbox`, and optionally `subscribe`, `openRoom`, `admin`).
2. The sidebar list: a record at `placeable-surface-list::<scope>` holding an array of rows shaped
   `{ record: { address }, payload: { kind: 'placeable-surface', id, label, material_target, placement_labels, order, package_entry: { package_name, entry_name } } }`.
3. The screens: for each `entry_name`, a mount in the page's screen map (`installScreenRunner`). A mount takes
   `(element, props)` and returns its cleanup. This page maps `course-lesson`, `posts`, `chat` and `account` to the
   Workshop's own screen mounts.
4. The saved arrangement state, the sidebar placement and the collection view, read as empty when the page has none
   (the seeds list them).
5. For the course screens: a records door, mounted once with `setRecordsDoor(seededRecordsDoor(rows))` (the course and
   lesson screens read through the records door, not the label source). The Worker's door is the default.

## Known limits

- Posts and Account read the signed-in service (`/work/api/...`), so they show their own "could not load" or sign-in
  state here. The check asserts the screen mounted, not that its data loaded.
- The seeded door answers a list in insertion order with no paging, and ignores `order`, `prefix` and `where`.
- The course list reads once when it mounts, so after Mark done it still shows the old count until it is opened again.
- Splitting and tabs are the arrangement's own behaviour; they are not exercised here.
- The lesson is opened from the course list, which is not one of the sidebar's entries, so the entry sets
  `tabsOutsideCatalog: 'keep'`.
