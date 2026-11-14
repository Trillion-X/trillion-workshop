# surface-badges

Live badges by channel: an owner publishes a short value on a named channel and any navigation row whose surface DATA names that channel shows it. Neither side knows the other. Each badge also says what kind of thing it counts (`kind`: `count` for new things, `notification` for unread notifications), so a reader can choose how to show it from its own DATA (the sidebar shows an unread notification as a red dot on a collapsed row and a count as nothing there, `parts/sidebar/read-data/sidebar-badge-marks.json`).

## Files

| File | Purpose |
|------|---------|
| `surface-badges.ts` | The per-document channel table (on `globalThis`, so separately bundled scripts share it), publish/read/subscribe and a React hook. |
| `README.md` | This file. |

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| `SurfaceBadge` | `{ text: string; kind: string; tone?: string }` | One channel's value: the words to show, the publisher's word for what they count, and optionally a plain tone word (good, attention, bad, info, quiet) a reader may draw a dot in (`sidebar-badge-marks.json` `dot_status_by_tone`). |
| `publishSurfaceBadge` | `(channel: string, badge: SurfaceBadge \| null) => void` | Set or clear a channel. An unchanged badge (same text and kind) notifies nobody. |
| `readSurfaceBadge` | `(channel: string) => SurfaceBadge \| undefined` | Current value. |
| `subscribeSurfaceBadges` | `(listener: () => void) => () => void` | Called after any channel changes. |
| `useSurfaceBadge` | `(channel: string \| undefined) => SurfaceBadge \| undefined` | React read of one channel (`useSyncExternalStore`). |

## Dependencies

**Depends on:** `react`.

**Depended on by:** `../coss/notifications.tsx` (publishes `notifications:unread`, kind `notification`), `src/workspace/catch-up.tsx` (publishes `catch-up`, kind `catch-up`, with the leading state's tone), `parts/sidebar/show/SidebarContent.tsx` (a row with `badgeSource` shows the channel value with the mark its kind has in `sidebar-badge-marks.json`, on the expanded row and the collapsed rail icon).

## Invariants

- One channel table per document.
- `null` or an empty `text` clears a channel; a cleared channel shows no badge.
- Nothing here names a kind; the publisher chooses it and a reader's DATA decides how it shows.
