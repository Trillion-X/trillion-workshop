# tools/item-record/

Descriptor-driven item records: top-level posts, replies and activity effects are all item_records whose roles come from descriptor data; a feed reader that splits them by role, a composer, a home rail and the owner-action builders that create a record or record an effect. Moved here byte for byte from bitfield-packages `packages/item-record`, where the Workshop held only the later copies of two of its files (the composer config, at `tools/edit-a-document-together/do-work/composer-config.ts`, and the leaderboard, at `tools/person-list/read-data/read-leaderboard.ts`). This folder is a prepared restore: the files are the originals and are not yet wired to a tool row.

## Files moved from bitfield-packages (packages/item-record)

Each file below is the package's own, byte for byte; `moved-from.json` names each source path and commit, the identity of its source bytes and of its bytes here, and the `calls` that made a real name or id made up. After the first commit only import paths changed. A file named `.held` is the same bytes with its test name taken off so the repository test does not run it; the reason is under `held` in the receipt. Most files import `@/packages/ui` and the retired package runtime (`@bitfield/runtime-kit`); the shared ui parts live in apps `tools/ui`, so the screens and targets here are prepared, not wired to a tool row.

| File | What it is |
|---|---|
| `do-work/create-item-record.ts` | Builds and sends the descriptor-backed create request; accepts pass-through fields |
| `do-work/owner-actions.ts` | Builds workflow owner-action requests from descriptor data |
| `do-work/read-activity-effects.ts` | A file of the package. |
| `do-work/read-item-record-feed.test.ts.held` | A test of the package, held: imports @bitfield/runtime-kit or @bitfield/slot-protocol (the retired package runtime); needs the records door in its place |
| `do-work/read-item-record-feed.ts` | Browser read helper for the admitted subject-scoped feed target |
| `do-work/record-activity-effect.ts` | A file of the package. |
| `do-work/refresh-item-records.ts` | Triggers the `refresh-item-records` republish action |
| `read-data/read-home-rail.ts` | A file of the package. |
| `read-data/read-item-records.test.ts` | Unit tests: decodeFeedItem tolerance/legacy rows + splitFeed partition/dedup/sort/categories |
| `read-data/read-item-records.ts` | Decodes the `item-records` input into FeedItems; exports `splitFeed` for descriptor-role partitioning |
| `read-data/record-descriptors.ts` | Generic descriptor interpreter for fields, relationships, roles, and reader-keyed views |
| `show/ItemFeed.empty-state.test.tsx.held` | A test of the package, held: a JSX test: it needs a DOM test runtime and the shared ui parts (tools/ui) that live in apps tools/ui; not run here |
| `show/ItemFeed.tsx` | Generic subject-scoped composer and durable post list with nested replies; Community identity and empty-state copy arrive as package-set DATA |
| `show/mount-item-composer.tsx` | A file of the package. |
| `show/mount-item-record.tsx` | Browser-local entry source mounting the feed; passes all props including target_ref through |
| `tests/item-record-actions.test.mjs` | A test of the package. |
| `tests/item-record-composer.test.mjs.held` | A test of the package, held: bundles a package source that imports retired package paths |
| `tests/item-record-create-target.test.mjs.held` | A test of the package, held: reads the package boundary file things-to-store-and-run.json (or the package's own data path), which is not carried |
| `tests/item-record-descriptors.test.mjs` | A test of the package. |
| `tests/item-record-projections.test.mjs` | A test of the package. |
| `tests/item-record-surface.test.mjs.held` | Package-local entry, feed-reader, and genericness proof (held: reads the package boundary file things-to-store-and-run.json (or the package's own data path), which is not carried) |
| `tests/load-ts-module.mjs` | A test of the package. |

### Not carried

- 30 files: generated build output of the retired package runtime (entry scope, built entry bytes); not carried
- 5 files: package README, package.json or ignore file; this folder has its own README
- 1 file: maps package entries to the retired package runtime's entry scope; not carried
- 1 file: the package boundary file: record contracts, actions and surfaces for the retired package runtime (slot workflows, owner targets); not carried
- 1 file: the Workshop holds a later copy at tools/edit-a-document-together/do-work/composer-config.ts (moved from trillion tools/documents); kept
- 1 file: the Workshop holds a later copy at tools/person-list/read-data/read-leaderboard.ts (metric windows as descriptor data); kept

The receipt's `not_carried` names each path.
