# expandable-tabs

The one icon-tab / action-group control: icons in one bordered group, the active item grows to show its label.

Adapted from 21st.dev "Expandable Tabs" by victorwelander (registry id 1428, MIT). `provenance.json` lists every adaptation.

## Files

| File | Purpose |
|------|---------|
| `ExpandableTabs.tsx` | The React control: choice and action modes, separators, `sm`/`md` sizes, framer-motion spring expansion. A framed group is a corner holder (`data-corner-holder`, `data-expandable-tabs-size`) and its buttons follow it (`data-corner-follows`): screen-look `nested-corners.css` gives each size's corner and gap, so a button's corner is the group's less the line and padding. |
| `mount-expandable-tabs.tsx` | Mounts the control into a DOM host for non-React pages (`window.ExpansionControls.mountExpandableTabs`). |
| `index.ts` | Public exports. |
| `ExpandableTabs.test.tsx` | Choice, action, keyboard, press-outside and DOM-mount behavior. |
| `provenance.json` | Upstream source, license and adaptations. |

## Key Types / Functions

| Type | Signature / Shape | Role |
|------|-------------------|------|
| `ExpandableTabs` | `(props: ExpandableTabsProps) => JSX.Element` | Renders the group. |
| `ExpandableTabsProps` | `{ items, ariaLabel, mode?: 'choice' \| 'action', value?, onChange?(id), onSelect?(id), size?: 'sm' \| 'md', className?, disabled?, targetRole?, reserveHoverRoom?, orientation?: 'horizontal' \| 'vertical', frame?: 'group' \| 'none' }` | `choice` = picker (radiogroup, `value` stays open). `action` = toolbar (a pointed-at item names itself in its tooltip and never grows, so nothing moves under the pointer; a keyboard-focused item opens its label; press fires `onSelect`; blurring or pressing outside closes). `frame` `'none'` draws the items bare on what holds them (the message box's bottom row) instead of in the bordered glass group. |
| `ExpandableTabItem` | `{ id, label, icon, disabled?, detail?, badge?, pinned?, wrap?, look? } \| { type: 'separator', id }` | Items are DATA; `icon` is a NamedIcon name. `detail` is shown after the word while expanded ("Group by · Project"); `badge` is a count on the icon (active filters); both join the accessible name. `pinned` keeps an item expanded (a tool in use). `wrap(button)` returns the element to render in place of the button, so a menu trigger (the shared `ActionMenu`) can own it. `look` names a shared look the item wears instead of the row's own colours (the pane's close wears `close-control`). |
| `mountExpandableTabs` | `(host: HTMLElement, props: ExpandableTabsProps) => () => void` | One root per host, re-renders in place, returns unmount. |

## Usage

```tsx
<ExpandableTabs
  mode="action"
  size="sm"
  ariaLabel="Work list actions"
  items={[
    { id: 'detach', label: 'Detach', icon: 'PinOff' },
    { type: 'separator', id: 'size' },
    { id: 'narrow', label: 'Narrower', icon: 'Minus' },
    { id: 'widen', label: 'Wider', icon: 'Plus' },
  ]}
  onSelect={(id) => run(id)}
/>
```

## Invariants

Constrained action toolbars can use `labelDisplay="tooltip"` with `frame="none"`. Every icon keeps its accessible name and pinned appearance; labels open in the existing shared hover label on mouse rest or keyboard focus, without changing row width or height. Escape dismisses the label. The default inline expansion remains unchanged for pickers and unconstrained toolbars.

- The control never names what it holds; callers pass every label and icon name.
- Every button keeps its accessible name while collapsed.
- Colors come only from screen-look custom properties.
- Reduced motion swaps state instantly.
- A horizontal row wider than its room wraps onto a second line inside its group; no item is ever cut off out of reach on a narrow pane or a phone.

## Dependencies

**Depends on:** `framer-motion`, `react-dom/client`, `@/packages/ui/show/icon` (NamedIcon), `@/packages/ui/show/cn`.

**Depended on by:** `sidebar/show/SidebarContent.tsx` (list header actions), `screen-arrangement/show/ArrangementSurfaceControl.tsx` (layer and placement pickers), media-workspace `shared-controls-entry.ts`.
