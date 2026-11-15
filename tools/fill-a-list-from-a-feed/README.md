A one-to-one port of old trillion `src/list-feed.mjs`. The canonical feed reader remains `watch-my-sources`, declared selectors remain `ui`, and list/Files operations now use `records-door` rather than Worker namespace and store code.

`tool:fill-a-list-from-a-feed` runs `fillAListFromFeed(input, {door})`, preserving JSON/RSS/Atom intake, stable collision-safe row ids, bounded writes, fixed values, prefixes, person edits, opt-in updates, media capture, and run stamps. The function API also preserves the shared-library algorithm with an explicitly supplied admitted `library.add` owner. The installed list row does not claim that a shared-library host is connected.

The source-first history was committed before adaptation at `4097cf388bed69c02c50ad396d667d424ac942da`. Tests exercise the real `listsOverDoor` adapter over a conditional-write door, with current Files calls.
