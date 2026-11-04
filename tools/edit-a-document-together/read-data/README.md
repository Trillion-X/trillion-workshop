# Documents Read Data

Pure readers for authored scene content, material descriptors, runtime config,
and generic action/binding-capable scene records.

The readers do not translate retired row shapes back into active content. New
materials are configured by descriptor data, including frame defaults.

## Document libraries

Every produced write-up is a composition document stored at its own scene
address, so it opens in the editor and every piece is individually editable.
Named libraries are DATA-defined views over the generic index feed.

| File | Purpose |
|------|---------|
| `document-sections.ts` | Generic mapper: ordered `DocumentSection` rows (`{text, heading?, level?, style?}`) → a `CompositionContent` node tree of `Text` blocks. Heading levels map to the same styles the format bar writes. Producers translate their own vocabulary to sections at their boundary. |
| `document-index.ts` | Per-document address convention (`package::documents::documents::<id>`), the lightweight `composition-document-index` pointer record builder (title/summary/status/time — never a body copy), and the scoped-index-feed reader DATA-defined libraries consume. |
| `what-enter-does-in-this-block.ts` | Pure decision for what pressing Enter does inside a block, read from DATA and never from a branch. A block carries `made_by_shortcut` (stamped by the rule's own effect template); that rule's `what_enter_does` says whether Enter makes another one like it, leaves the kind when the item is empty, or falls through to a plain block. Also derives the marker the next item starts with, advancing the ordinal for counted rows. Knows no kind names: a test fails if one appears. |

The scoped `ca-document-index-feed` sink is a `record_from_matching_records`
projection over `composition-document-index` rows, so library views never
materialize document bodies. Row activation opens the existing editor at the
document's `scene_address`.
