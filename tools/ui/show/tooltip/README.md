# tooltip

The shared tooltip: a themed replacement for the operating system's `title` tooltip, as a component for React call sites and as one document-level delegate that draws every `title` attribute in the shared look. The one tooltip owner in Trillion: every hover label in `parts/` and `src/` is this component or a `title` this delegate draws.

## Files

| File | Purpose |
|------|---------|
| `Tooltip.tsx` | `Tooltip` component: wraps a trigger, shows a label (and an optional keyboard shortcut or trailing detail) after a one-second rest or keyboard focus, above the trigger, and never when the trigger's own text already says the label. |
| `title-tooltips.tsx` | `installTitleTooltips`: one delegate per document. Hovering an element with a `title` sets the text aside in `data-title-tooltip` (so no native tooltip appears), shows it in the shared look above the element, and restores the `title` when the pointer leaves. Also owns `titleRepeatsLabel` and `TOOLTIP_PLACEMENT`, which the component reads, and `TooltipCard` / `TOOLTIP_LAYER_STYLE`, the one card and layer sizing the delegate and the hover labels draw. |
| `hover-labels.tsx` | `useHoverLabels()`: one hover label for a group of icon controls (ExpandableTabs: a list's view switcher, toolbars). `bind(label)` gives each control its handlers; the group draws one label in the tooltip look after the pointer rests `intent_ms`, moves it at once to a neighbour (warm for `warm_ms`), anchors it to the control's live box with floating-ui `autoUpdate`, and closes it when the pointer leaves, a press, Escape, or the control sliding out from under a still pointer (never naming the control that slid in). Proof: `test/hover-labels.test.mjs`. |
| `hover-labels.json` | DATA: `intent_ms` (rest before a label opens) and `warm_ms` (after one closes, the next opens at once). |
| `index.ts` | Barrel. |

Every tooltip is drawn on the shared `Card` variant `tooltip`: a small popover of the worn look, its popover surface (`--glass-bg-popover`), its ink (`--text-primary`) and its own font (`--font-primary`, `--font-size-body-xs`), lifted off the work by a hairline in the look's line colour and its raised shadow (`.floating-tooltip` in `parts/screen-look/show/surfaces.css`). `test/floating-surfaces-stand-apart.test.mjs` opens both tooltips, the hover card and the popover Card in every look (and in a look a person made) and fails when one blends into the pane under it or when one control opens two tooltips.

Tests live in `test/tooltip.test.mjs` (run in Chromium): the delegate sets a title aside while hovered and restores it on leave, catches a re-written title, ignores empty titles, never draws a title that repeats the visible text, installs once per document, and opens above its element (below only when there is no room above); the component opens above its trigger, never opens for a label its trigger already shows, and still opens for that label when it carries a shortcut.

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| `Tooltip` | `({label, shortcut?, trailing?, side? = 'top', sideOffset? = 6, delayDuration? = 1000, children}) => JSX` | Themed tooltip around a React trigger. `shortcut` draws as a `Kbd`; `trailing` is any non-interactive detail after the label. |
| `installTitleTooltips` | `(doc?: Document) => () => void` | Starts the delegate; installing twice returns the first teardown. The teardown restores any `title` set aside. |
| `titleRepeatsLabel` | `(element: Element, title: string) => boolean` | True when the text only repeats what the element already shows; both the component and the delegate never open such a tooltip. |
| `TOOLTIP_LAYER_STYLE` | `{position: 'fixed', left: 0, top: 0, width: 'max-content', maxWidth: 'calc(100vw - 16px)', pointerEvents: 'none'}` | A tooltip layer before placing: as wide as its words, never wider than the window, never sized by where it was last placed (the one-letter-a-line tooltip in an AI chat's small frame). |
| `TooltipCard` | `({label}) => JSX.Element` | The one tooltip card: shared tooltip look, at most 320 px (less in a narrow window), words that wrap anywhere, at most ten lines. |
| `TOOLTIP_PLACEMENT` | `{side: 'top', fallbackSide: 'bottom', offset: 6, collisionPadding: 8}` | Where every tooltip opens. The component's default `side`/`sideOffset`/`collisionPadding` and the delegate's floating-ui placement, flip and shift all read it. |
| `TITLE_ASIDE_ATTRIBUTE` | `'data-title-tooltip'` | Where a hovered element's `title` waits. |
| `TITLE_TOOLTIP_DELAY_MS` | `1000` | The same rest delay as `Tooltip`. |
| `TOOLTIP_TRIGGER_ATTRIBUTE` | `'data-tooltip-trigger'` | Set by `Tooltip` on its trigger; the delegate never draws a second tooltip for such a control. |

## Invariants

- A `title` is absent only while the pointer rests on its element; screen readers still find it.
- A `title` written during hover is set aside too, so a native tooltip cannot slip through.
- The tooltip never takes pointer events.
- One tooltip per control: a control `Tooltip` wraps carries `data-tooltip-trigger`, and the delegate leaves it to the component (its `title` is still set aside).
- A tooltip wears the worn look: its popover surface, ink and font, never a fixed dark chip in the browser's default face; it is solid, lifted by a border and a shadow, and its words contrast at least 4.5 to 1 with it.
- A tooltip adds something the element does not already show (a tip, a shortcut, what will happen). A label its trigger already shows, with no shortcut or detail, never opens; the native tooltip stays suppressed too. Give such call sites a real tip instead.
- A tooltip never sits under the pointer. The pointer rests on the control and its arrow hangs down and right, so every tooltip opens above its control, flips below only when there is no room above (8 px from the window edge), and shifts sideways to stay inside the window. Call sites do not pass `side="bottom"`; `side="right"` is for vertical rails.

## Dependencies

**Depends on:** `@radix-ui/react-tooltip` (component), `@floating-ui/dom` (delegate placement), `react-dom/client`, `../card/Card`, `../text/Text`, `../kbd/Kbd`, `../container/container`, `../layer-order`.

**Depended on by:** `button/Button.tsx` (icon-only buttons wrap themselves), `control-rail-button`, `selectable-pill-bar`, `capability-icon-row`, `linked-identity`, `copy-button/CopyButton`, `canvas-tools/CanvasToolPicker`, `visual-layer-stack/LayerStackEditor`, `coss/workspace-controls.tsx`, `parts/sidebar` (`SidebarContent`, `DesktopSidebar`), `parts/screen-arrangement` (`ContainerHeader`); `src/workspace/main.tsx` installs the delegate for every workspace screen; `media-workspace` `shared-controls-entry.ts` installs the delegate for every Expansion screen.
