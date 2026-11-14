# canvas-tools/

The pointer-meaning primitive for any canvas: ONE interpreter owns "what does this gesture mean right now," and the active tool's DATA row decides the intent.

## Why

Pan-vs-marquee-vs-move-vs-draw meaning used to be scattered across component handlers (the L055 root: each item decided "drag", the stage decided "pan by ⌘/middle", a separate toggle decided "draw"). That scatter made the dense-board marquee impossible (a press on an item could never become a rubber-band). This module dissolves the whole category (L063) into a single data-driven decision table (L069): `(activeTool, hitKind, gesturePhase) → CanvasIntent`. New tools/shortcuts/modifiers are DATA rows, never new code branches (enum-dissolution). The headline effect: `marquee-select.node.drag = selection.marquee` lets you rubber-band across a fully-dense board with zero empty space.

## Files

| File | Purpose |
|------|---------|
| `canvas-tool-types.ts` | The contract: `CanvasHit`, `GestureChord`, `CanvasIntent`, `CanvasToolDescriptor`, `TemporaryToolRule`, `IntentHandler`/`IntentHandlerMap`. `CanvasIntent.kind` is closed by Physics; everything else is DATA. |
| `canvas-tools.ts` | The default `CANVAS_TOOLS` + `TEMPORARY_TOOLS` registries (Society DATA) and the pure resolvers: `resolveIntent`, `resolveTemporaryTool`, `toolForShortcut`, `indexTools`, `chordOf`. |
| `use-canvas-tool.ts` | `useCanvasTool` hook — owns active-tool state, Space/middle temporary override, keyboard-shortcut binding; exposes `effectiveTool`/`resolveIntent`/`chord`. |
| `CanvasToolPicker.tsx` | Generic toolbar over a `CanvasToolDescriptor[]` — sorted icon buttons, active highlight, tooltip = label + shortcut. Reuses `Button`/`NamedIcon`/`Tooltip`. |
| `canvas-tools.test.ts` | The combinatorial gauntlet: tool × hit × phase table, temporary-tool overrides, shortcuts, and the deletion test (a foreign tool set runs with zero interpreter change). |
| `index.ts` | Barrel — re-exported from `@/packages/ui`. |

## Key Types / Functions

| Type / Function | Signature / Shape | Role |
|------|------|------|
| `CanvasIntent` | `{ kind: 'viewport.pan' \| 'selection.marquee' \| 'selection.click' \| 'node.move' \| 'node.resize' \| 'marks.stroke' \| 'text.place' \| 'connector.start' \| 'noop'; …config }` | The resolved meaning of a gesture. `kind` closed by Physics (irreducible pointer ops); new tools recombine these, never add a kind. |
| `CanvasHit` | `{ kind: 'empty' \| 'node' \| 'resizeHandle' \| 'connectorPort'; world; client; ref? }` | What the pointer landed on. Generic core never enumerates node families. |
| `CanvasToolDescriptor` | `{ id; label; icon; cursor; activeCursor?; shortcuts: string[]; order; gestures: { empty?; node?; resizeHandle?; connectorPort? } }` | A tool as DATA. Adding a tool is adding one row. |
| `TemporaryToolRule` | `{ toolId; while: { key?; button?; outsideTextInput? } }` | Modifier overrides as DATA (Space → hand, middle → hand) — no `if (metaKey) pan` branch. |
| `resolveIntent(tool, hitKind, phase)` | `→ CanvasIntent` | The whole interpreter — a table lookup, no branching on tool id. |
| `resolveTemporaryTool(state, activeId, tools, rules?)` | `→ CanvasToolDescriptor` | Picks the effective tool given keys/buttons held. |
| `useCanvasTool(opts?)` | `→ CanvasToolApi` | Active-tool state owner + shortcut/Space binding + `resolveIntent(hit, phase, chord)`. |
| `CanvasToolPicker` | `(props: { tools; activeToolId; onSelect; orientation?; className? })` | The tool rail. |

## Dependencies

**Depends on:** `@/packages/ui/show/node-actions/node-ref` (the universal `NodeRef` address — Physics leaf), `@/packages/ui/show/button`, `@/packages/ui/show/icon/NamedIcon`, `@/packages/ui/show/tooltip`, `@/packages/ui/show/cn`, `react`.

**Depended on by:** `@/packages/ui` (barrel) → `packages/group/show/GroupBoardPanel.tsx` (the vision-board / group canvas). Any canvas surface can consume it; the registries are DATA a consumer may override.

## How a consumer wires it (the contract)

1. `const tool = useCanvasTool({ tools })` — hold the active tool.
2. Render `<CanvasToolPicker tools={tools} activeToolId={tool.activeToolId} onSelect={tool.setActiveTool} />`.
3. On a press over a node, gate the node interaction on `resolveIntent(tool, 'node', 'drag')`: claim it (drag/resize + `stopPropagation`) only when the intent is `node.move`/`node.resize`; otherwise let the press bubble to the stage.
4. On a stage press, resolve `effectiveTool(...)` + `resolveIntent(tool, 'empty', phase)` → dispatch pan/marquee/stroke. Never branch on the tool id yourself.
