# action-row

The one row of actions for a selection or an open item: a rounded surface of icon buttons where the hovered or focused action grows to show its name. It is the DOM-page form of `expandable-tabs` (action mode) for rows whose buttons a non-React page owns.

## Files

| File | Purpose |
|------|---------|
| `action-row.tsx` | `enhanceActionRow`: marks a page-owned row, draws each button's `data-menu-icon`, wraps its words in a label that opens on hover or focus, and re-shapes a button when the page rewrites its words. |
| `index.ts` | Public exports. |
| `action-row.test.tsx` | Icon and word buttons, rewritten words, and buttons owned by another renderer (left alone). |
| `provenance.json` | The 21st.dev references the anatomy comes from and every adaptation. |

## Key Types / Functions

| Type | Signature / Shape | Role |
|------|-------------------|------|
| `enhanceActionRow` | `(node: HTMLElement \| null, {label}: ActionRowOptions) => () => void` | Gives the row `role=toolbar`, its label and the `ui-action-row` look; returns a function that stops following it. |
| `ActionRowOptions` | `{ label: string }` | What the row is for, for assistive technology. |

## Usage

```js
// Markup the page owns: each action is a button; its icon is DATA.
// <div class="toolbar"><button data-menu-icon="scissors">Edit video</button><button data-menu-icon="send">Publish / schedule</button></div>
window.ExpansionControls.enhanceActionRow(toolbar, {label: 'Recording actions'});
```

## Invariants

- The page's buttons stay the page's: same element, listeners, disabled and hidden state.
- A button without `data-menu-icon` shows its words; no action is ever unlabeled.
- Buttons inside another renderer's root (`[data-shared-root]`, `[data-action-row-skip]`) take the look from CSS only.
- Appearance lives in `screen-look/show/action-row.css`.

## Dependencies

**Depends on:** `ui/show/icon` (`NamedIcon`), `react`, `react-dom`.
**Depended on by:** `media-workspace` (Library selection bar and the recording view's actions) through `shared-controls-entry.ts`.
