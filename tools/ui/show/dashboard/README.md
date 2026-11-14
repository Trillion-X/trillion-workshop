# parts/ui/show/dashboard

A home screen drawn entirely from the caller's DATA: a greeting with the one next step, stat cards with their lines over time, and a grid of cards (chart, rows that answer in place, feed, gallery, spotlight).

## Files

| File | Purpose |
|------|---------|
| `Dashboard.tsx` | The `Dashboard` component and its card drawers, looked up by card `kind` in `CARD_DRAWERS`; a card's head may carry a form button (the shared hover form) beside its "more" button. |
| `index.ts` | The public exports. |

## Key Types

| Type | Shape | Role |
|------|-------|------|
| `DashboardHead` / `DashboardStats` / `DashboardCardView` | `({ greeting, summary?, glance?, headerAction?, next? })` / `({ stats })` / `({ card })` | The dashboard's head (`glance`: counts under the greeting as small tiles, `DashboardGlance { id, value, label, tone?, open? }`, each opening its screen, shown in place of the `summary` sentence), its row of stat cards and one card, each drawn on its own (one piece of a board of placed screens); `Dashboard` is the three together. |
| `DashboardPiece` | `({ children })` | Wraps one part drawn alone in the dashboard's tokens and width measure (`.dashboard-piece`), so it reads as it does inside the whole dashboard. |
| `DashboardProps` | `{ greeting, summary?, headerAction?, next?, stats, cards }` | Everything the screen shows. |
| `DashboardCard` | `CardBase & ({ kind: 'chart' } \| { kind: 'rows' } \| { kind: 'feed' } \| { kind: 'gallery' } \| { kind: 'spotlight'; headline; stages?; detail?; action?; queue? })` | One card; `CardBase` holds `id, title, description?, empty…, more?, form?, wide?, automations?`. |
| `DashboardRow` | `{ id, title, detail?, badge?, meta?, form?, action?, queue?, open?, whole?, icon?, picture?, tone?, mark?, value?, unit?, chips? }` | One row of a rows card, drawn as the glance shape's one-line row (`listing-card`, `form: 'row'`): the lead icon or face with its tone, the title with `meta` (when) muted beside it, the detail after, the mark, the key value with its unit and the row's buttons. Answers in place with `form`, asks an AI with `queue`. `whole` shows the whole title wrapping with the detail and when on one quiet line under it (two lines that survive a phone width); `open` makes the whole row its one control instead of a button. |
| `DashboardCardForm` | `{ label, form: HoverForm }` | A card-head button that opens the shared hover form, such as adding a row. |
| `DashboardStage` | `{ label, text, tone?: 'quiet' \| 'accent' }` | One stage of a spotlight's thread (where it is now, where it gets to). |
| `DashboardStat`, `DashboardFeedItem`, `DashboardTile`, `DashboardAction`, `DashboardPoint` | see `Dashboard.tsx` | Stat cards, feed items, gallery tiles, buttons and chart points. A tile's `badge` (like "New") is a solid chip at the start of its title line, never over its picture. |

## Dependencies

**Depends on:** `coss/ui/button`, `coss/ui/badge`, `chart` (stat lines as sparklines, the chart card as an area chart that scrubs), `person-tag`, `queue-job`, `automation-preview`, `record-views/hover-form`, `relative-time`, `empty-state`, `icon`, `hover-preview`, `listing-card` (every list row); appearance in `parts/screen-look/show/dashboard.css`.

**Depended on by:** `src/workspace/home-screen.tsx` (Home's parts, each one piece of Home's board).
