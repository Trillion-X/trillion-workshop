# tools/browser-saved-items/

Sorts the tabs a person pinned in their browser into folders by rules they wrote, keeps every tab, makes a backup of the file first, and can put the backup back. Ported from the `browser-saved-items` package, which did this for one person's design bookmarks with their categories, sites and words inside the code; here the categories, sites and words are the person's rules, given with each request, and the tool names none.

It reads only the browser's sidebar file (the Arc layout: spaces, pinned folders, tabs, split views) in a folder the person grants for change. It does not read history, cookies, passwords or page content. The browser rewrites the file while it runs, so it is closed first.

## Files

| File | Purpose |
|------|---------|
| `do-work/organize-saved-browser-items.py` | `tool:organize-saved-browser-tabs`: the granted folder in argv, `{ file, rules, apply? }` or `{ file, restore_from }` on standard input, `{ result }` or `{ error }` on the last line. Changed from the package: the folder tree, the sites, the words and the choice of category are the person's `rules`; the catalog files the package read from a design-library folder are gone (`relevant_hosts` is the list a person gives); the report is the answer, not a file; every request is a report until `apply: true`; before a write the tool checks that the same tabs are reachable and no item appeared or went, and refuses a root folder holding anything that is not a folder, tab or split view; a tab that only moves with its split view is reported as that; tabs keep their order instead of set order; the restore keeps the file it replaces. The package's second script, which added a person's sites to a design-component catalog, was glue to that catalog and is not carried. |
| `part.json` | Nothing in this folder is imported by another tool. |
| `tool-rows.json` | The row. It runs on the person's computer with the `change-a-folder` grant and no internet. |
| `test/organize-saved-browser-items.test.mjs` | The command run as the engine runs it on a made-up sidebar file for a bakery's saved tabs: a report that writes nothing, an apply that keeps every tab and the split view with its backup equal to the old file, a restore, refusals that change nothing (folder count, unknown space, a destination that does not exist, a rule that covers every tab, an item that could not be kept, file names that leave the folder or are links). |

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| rules | `{ space, root_folder, folders: { top: [sub] }, fallback, skip_hosts, relevant_hosts, relevant_words, rules: [{ put_in, hosts, words }] }` | All of the person's choices. A tab outside the root folder is covered when its site is in `relevant_hosts` or a `relevant_words` word is in its title, address or folder path, and not when its site is in `skip_hosts`. The first rule whose site or word matches picks the folder, otherwise `fallback`. |
| `read_rules` | `(rules) -> parsed` | Refuses a rule that would cover every tab and a destination `folders` does not make. |
| `organize` | `(document, rules, stamp) -> report` | Reuses the root folder's existing folders for the tree, moves the covered tabs (a split view as one unit), brings the sync copy of every changed item up to date, checks the tabs are the same, and returns the decisions. |
| `run` | `(folder, request) -> result` | The report, the backed-up atomic write, and the restore. |

## Dependencies

**Depends on:** nothing (Python 3 standard library).

**Depended on by:** `tool-rows.json`. The local engine runs the row on the person's computer (`computer` kind) after the person grants `change-a-folder`.
