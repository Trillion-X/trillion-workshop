# tools/node-tree-decoder/

Reads a tree of nodes out of any application's file, lets a caller change the grouping, and writes the changed tree back in the file's own shape. A node has an identity, a parent, children and a title; browser sidebars, bookmark files, exported outlines, mail folders, playlists with folders, project trees and org charts all share that shape. Which keys carry which part, and which layout the file uses (flat with parent references, or physically nested), is a descriptor row; the three scripts know no application.

Moved byte for byte from the old `node-tree-decoder` package of `bitfield-packages` (`moved-from.json` is the receipt). Its `proof/` scripts (which ran against one person's real application files) and its review notes were not carried.

## Files

| File | Purpose |
|------|---------|
| `do-work/process-scripts/decode_node_tree.py` | The decoder: one tree in, a containment projection out (`{node_id, parent_id, ordinal, role, title, external_identity, attributes}` per node). Pure; never raises; returns findings and rejections. |
| `do-work/process-scripts/encode_node_tree.py` | The inverse: a changed projection back into the tree's own shape, driven by the same descriptor row. Refuses before writing; never half-writes. |
| `do-work/process-scripts/apply_tree_to_file.py` | Installs a rebuilt tree over its source file: a copy of the file before the change, an atomic replace, then a read back that the tree decodes the same. The only script that touches a file. |
| `do-work/process-scripts/__tests__/test_decode_node_tree.py` | Twenty fixtures, one for each way a tree can silently lose a member. |
| `do-work/process-scripts/__tests__/test_encode_node_tree.py` | Thirty-three fixtures: the round trip, the refusals, declared creation, the orphan guard and the nested layout. |
| `things-to-store-and-run.json` | The package's own boundary file: the capability, the stored scripts and the descriptor rows. |
| `moved-from.json`, `ports/` | The receipt and the port contracts of the move. |

## Key Functions

| Name | Signature | Role |
|------|-----------|------|
| `decode_tree` | `(payload, descriptor) -> {records, findings, rejections}` | The decoder contract. |
| `leaf_count` | `(payload, descriptor) -> int` | How many leaves the projection holds, to prove no member was lost. |
| `apply_containment` | `(payload, descriptor, records) -> receipt` | The write-back contract; raises `EncodeRefusal` before writing anything. |

Run the tests with `python3 -m pytest do-work/process-scripts/__tests__` (53 pass; Python only, no other package).

## Dependencies

**Depends on:** Python 3.10 or later and its standard library.

**Depended on by:** nothing in this repository yet; no tool row runs these scripts yet.
