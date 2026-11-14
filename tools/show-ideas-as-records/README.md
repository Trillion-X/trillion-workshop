# tools/show-ideas-as-records/

The Ideas screen: a person's ideas kept as records, drawn through the generic visual-database surface, with the projects they belong to and the lineage between ideas (which idea came from which). The read model takes records, fields, views, actions and relationships as data and composes `tools/keep-lists-of-rows/read-data/visual-database.ts`; the package words live in data, not in code. Moved byte for byte from bitfield-packages `packages/ideas` (the last commit on the checked-out branch; uncommitted edits are not carried).

## Files

| File | Purpose |
|------|---------|
| `__tests__/package-data-contract.test.ts` | The package's code, moved as written. |
| `read-data/__tests__/read-ideas.test.ts` | Test suite for decodeIdeasWorkGraph and related read functions. |
| `read-data/read-idea-lineage.ts` | Relationship projection adapter. Lineage is not a package-specific backend |
| `read-data/read-idea-projects.ts` | The package's code, moved as written. |
| `read-data/read-ideas.ts` | Descriptor-driven read model for the Ideas package. Package vocabulary lives |
| `show/mount-ideas.tsx` | The package's code, moved as written. |
| `things-to-store-and-run.json` | Data the package carried as written. |
| `moved-from.json` | Where each file came from: source path and commit in bitfield-packages, the identity of its source bytes and of its bytes here, the call rows applied, the held tests and the files that still call the retired runtime. |
| `part.json` | Nothing here is imported by this tree; the folder is a part another tree imports. |
| `README.md` | This file |

## Still on the retired runtime

These files are the original bytes, with import paths changed to this tree. They call the retired package runtime or a package path this tree does not hold, so no tool row opens them until each call is swapped for the records door.

- `show/mount-ideas.tsx`: a package path of the old app that is not in this tree, retired package runtime

## Dependencies

**Depends on:** `tools/keep-lists-of-rows` (the visual-database read model), the shared ui parts of the web client, Node 24.

**Depended on by:** nothing yet; a tool row and its screen wiring come once the held calls are swapped.
