# node-actions

The generic right-click menu over any stamped node: an owner-provided pack says which actions accept the node, and the survivors render through the shared `ActionMenu` at the pointer.

## Files

| File | Purpose |
|------|---------|
| `NodeContextMenu.tsx` | `useNodeContextMenu(pack)`: finds the nearest stamped node on right-click, renders accepted actions as an `ActionMenu` at the pointer, or an action's editor panel in a draggable `AnchoredOverlay`. |
| `node-action-types.ts` | `NodeActionCapability` (one action as DATA plus `accepts`/`run`/`submenu`/`editor`), `acceptedNodeActions`, `indexNodeActions`. |
| `batch-action-types.ts` | `BatchActionCapability` for actions over a whole selection, `acceptedBatchActions`, `indexBatchActions`. |
| `node-ref.ts` | `NodeRef` stamping on DOM (`data-node-ref`), parse/serialize, `closestNodeRef`. |
| `index.ts` | Barrel export. |
| `__tests__/node-action-types.test.ts` | Acceptance, sorting, and submenu indexing. |
| `__tests__/node-ref.test.ts` | Stamp round-trip and nearest-node lookup. |

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| `NodeActionCapability` | `{id, label, icon: string, tone?: 'destructive', shortcut?, hint?, priority?, disabled?, accepts(ref), run?(ref), submenu?(ref), editor?(ref, close)}` | One action. `icon` (a Lucide name) is required because the menu refuses rows without one. |
| `NodeActionPack` | `readonly NodeActionCapability[]` | What a surface hands the menu. |
| `acceptedNodeActions` | `(pack, ref) => NodeActionCapability[]` | Actions whose `accepts` passes, by priority. |
| `indexNodeActions` | `(actions, ref) => Map<string, NodeActionCapability>` | Id lookup including submenu rows. |
| `useNodeContextMenu` | `(pack) => {onContextMenu, contextMenu, openFor, isOpen}` | The hook a surface mounts once. |
| `NodeRef` / `closestNodeRef` | `AddressRef` / `(target) => {ref, element} \| null` | How a DOM node names what it shows. |
| `BatchActionCapability` | `{id, label, icon?, tone?, accepts(refs), run(refs, ctx)}` | Selection-wide action. |

## Dependencies

**Depends on:** `../action-menu` (`ActionMenu`), `../anchored-overlay` (editor panels), `../visual-layer-stack/visual-layer-types` (`AddressRef`, via `node-ref.ts`).

**Depended on by:** `packages/screen-arrangement/show/node-menu-controller.tsx` and `node-action-pack.tsx`, `packages/group/show/GroupBoardPanel.tsx` and `board-action-affordances.ts`, `../action-affordance/render-action-items.ts`.

## Invariants

1. The menu names no node kind and no action; `accepts` tests what the node exposes.
2. Every row has an icon; a submenu row's children are rows too.
3. Choosing an action with an `editor` keeps the menu state and shows the panel instead of closing.
