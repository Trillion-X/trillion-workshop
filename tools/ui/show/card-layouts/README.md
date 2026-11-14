# card-layouts

One set of cards drawn in a layout chosen by DATA: named sections of sideways rows (the 21st.dev home page), a shuffled column-balanced wall (Pinterest's home feed), an even grid, or any layout a caller adds as one more row. Hovering a card opens the shared hover card with whatever the caller mounts (a player), the name and the card's actions.

## Files

| File | Purpose |
|------|---------|
| `CardLayouts.tsx` | The component: layout switch (shared `ExpandableTabs`), sections with title, count, subtitle, tools and View all, the card with its picture and name, the hover card (Base UI `PreviewCard`), `cardsFor` and `shuffleKey`. |
| `mount-card-layouts.tsx` | `mountCardLayouts(host, options)` for pages that are not React; calling it again redraws, the returned function releases the host. |
| `CardLayouts.test.tsx` | A layout drawn from its DATA row alone, empty sections hidden, each card once when ungrouped, stable shuffle per seed, the choice control, View all and back, reading and failed sections, opening a card, the empty message, a card taking its image's shape. |
| `index.ts` | Public exports. |
| `README.md` | This file. |

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| `CardLayouts` | `(options: CardLayoutsOptions) => JSX.Element` | Draws the chosen layout. |
| `CardLayoutsOptions` | `{cards, sections, layouts, layout, focus?, focusLayout?, seed, label, empty: {title, description?}, viewAllLabel?, backLabel?, onLayout(id), onFocus(sectionId \| null), onOpen(cardId), onCardAction(cardId, actionId), onSectionAction?(sectionId, actionId), onRetry?(sectionId), onPreview?(cardId, host) => release}` | Everything the caller supplies; every word is caller DATA. |
| `LayoutCard` | `{id, title, detail?, summary?, picture?: ReactNode, aspect?: number, groups: string[], actions?: CardAction[]}` | One card. `groups` names the sections that hold it; `summary` shows only in the hover card; `aspect` is the picture box's starting width / height until an image inside loads. |
| `CardSection` | `{id, title, subtitle?, total?, actions?: CardAction[], pending?, error?}` | One section. Not drawn while it holds no cards and nothing is pending or failed. |
| `CardLayout` | `{id, label, icon, grouped: boolean, shuffle: boolean, flow: string}` | One layout row. `flow` is a name the screen-look CSS draws (`row`, `wall`, `grid`). |
| `CardAction` | `{id, label, icon, lead?, pinned?, disabled?}` | A card or section action. `lead` is a labeled button; the rest share one `ExpandableTabs` action group; `pinned` keeps a name open (Saved). |
| `cardsFor` | `(cards, sectionId \| null, shuffle, seed) => LayoutCard[]` | A section's cards, or every card once; shuffled by `shuffleKey` when asked. |
| `shuffleKey` | `(seed, id) => number` | FNV-1a of seed and id: the same seed always gives the same order. |
| `mountCardLayouts` | `(host: HTMLElement, options: CardLayoutsOptions) => () => void` | Mount, redraw, release. |

## Usage

```ts
const release = window.ExpansionControls.mountCardLayouts(host, {
  cards, sections, label: 'Inspiration', seed: new Date().toDateString(),
  layouts: [
    {id: 'sections', label: 'Sections', icon: 'Rows3', grouped: true, shuffle: false, flow: 'row'},
    {id: 'wall', label: 'Wall', icon: 'LayoutDashboard', grouped: false, shuffle: true, flow: 'wall'},
  ],
  layout: 'sections', empty: {title: 'Nothing here yet'},
  onLayout, onFocus, onOpen, onCardAction,
});
```

## Invariants

- Blind: never names a kind of card, section or layout. A new layout is a caller row; a new flow is one CSS rule in `screen-look/show/card-layouts.css`.
- Ungrouped layouts show each card once however many sections hold it.
- The shuffle is a pure function of seed and card id.
- Appearance lives only in `screen-look/show/card-layouts.css`.

## Dependencies

**Depends on:** `../coss/ui/button`, `../expandable-tabs/ExpandableTabs`, `../icon` (`NamedIcon`), `../layer-order/layer-order`, `../scrollable-surface/scroll-fade` (`watchScrollFade`), `../coss/workspace-controls` (`mountSharedContent`), `../one-owner-per-node`, `@base-ui/react/preview-card`; look in `screen-look/show/card-layouts.css`.

**Depended on by:** Trillion Media's Inspiration screen (`media-workspace/inspiration-ui.js` through `shared-controls-entry.ts`).

## References

21st.dev home page (the owner's captures 2026-09-27), 21st.dev components Scroller (3929) and Masonry Grid (7844); Mobbin: Higgsfield https://mobbin.com/screens/084ea6ae-141e-4913-856a-0f812a28f00e, SchoolAI https://mobbin.com/screens/f1c4ed4f-7ba1-4c9a-91b5-8652a01a1c18, Pinterest https://mobbin.com/screens/eb0ad4dd-1cc1-4287-9819-38cbe7028c63, Curater https://mobbin.com/screens/570811a7-d458-4a3b-ae87-ecb4cdeb5fac. Inspiration only; no upstream code copied.
