# Command Palette

Package-owned global command palette entry and current-item selection runner.

## Files

| File | Purpose |
|---|---|
| `things-to-store-and-run.json` | Publishes the command-palette package entry, render-root component records, and source-built stored-byte contract. |
| `entry-to-package-data-map.json` | Records the package entry source mapping used by package-entry scope generation. |
| `show/` | Browser palette UI, root gate, reply reader, and mount function. |
| `do-work/` | Requests current-item ranking and runs selected palette results. |

## Rules

- The palette asks the current-item owner for rows; it does not scan package files or route through workflow search.
- Package entry bytes are built in memory and written to live state; durable package-root output files are not source truth.
- Root executable source is declared with `source_bytes.address_label` pointing at the live package entry-byte record; integrity metadata is not an active root loading path.

## In Trillion

Each place results come from (`command-palette.json` `sources`) is the show-rules control `palette.source.<its id>` and each action `palette.action.<its id>`, declared in `part.json` `controls`, so one rule on `palette` hides every row and a new source or action needs no code (`test/show-types-and-controls.test.mjs`).

Ported from `<checkout>/packages/command-palette`; every difference from that package is listed in `scripts/port-sources.json`. Trillion's Find anything screen (`src/workspace/command-palette.tsx`, DATA in `src/workspace/command-palette.json`, screen row `tool:screen-command-palette` in `records/workshop-screen-tool-records.json`) renders this palette as an ordinary screen that opens as a floating window in the middle of the screen over a dimmed, blurred backdrop. Cmd+K (Ctrl+K elsewhere) opens and closes it from anywhere, and the Start list in the sidebar carries it. The page answers the palette's own requests (`slot::find-current-items`, `slot::workflow` search and item, the open action) from the screens this person is offered and everything `@` offers, so a result can be a screen, a file, a tool, an AI, a person, a decision or anything else `@` reaches. Each result shows the same hover preview as the sidebar with the shared open choices (`parts/ui/show/placeable-surface-intent/open-choices.json`), and two actions under the results ask your AIs.

| File | Purpose |
|------|---------|
| `part.json` | What other parts and screens may import from this part: the palette, its gate and its types. |

| Name | Signature / Shape | Role |
|------|-------------------|------|
| `CommandPaletteFrameProps` | `{ open, onClose, label, width, children }` | What a screen passes to draw the palette's window itself; the package's FloatingPanel is the default. |
| `CommandPalette` / `CommandPaletteGate` props `frame?`, `wrapResult?` | `ComponentType<CommandPaletteFrameProps>` / `(result, row) => ReactNode` | Trillion draws the palette inside its own floating window and wraps each result in its hover preview. |

**Depends on (Trillion):** `parts/ui` (the shared components named in `parts/ui/part.json`), `#workspace-records` (`src/workspace/records.ts`).
**Depended on by (Trillion):** `src/workspace/command-palette.tsx`.
