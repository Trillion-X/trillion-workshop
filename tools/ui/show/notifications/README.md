# Notifications

The one notification system for every surface: stacked toasts with icons, tones, live progress, actions and dismiss, plus the notification center, an ordinary screen that shows live work and full history. Where that screen opens (a floating window with no tab bar, or a tab in any container) and how navigation shows it (a row with a live unread count and a hover preview) is surface DATA, never code here. Every caller emits into the same per-document center, so a transfer, an import, an archive Undo and an error all stack together and all land in the same history.

## Files

| File | Purpose |
|------|---------|
| `notification-center.ts` | The store: emit, update, finish, hide, history, unseen count; publishes one change per mutation. Also `describeTransfer`, `formatBytes`, `formatRemaining`. |
| `NotificationParts.tsx` | A notification as the shared glance row (`../listing-card`, form `row`): `notificationListing(record, when?)` turns a record into glance DATA, always a whole row (who it is about as its `face`, turning while `working`, else its saved `preview` or kind icon in a tile tinted through `listing_tones`; the whole title; one quiet line of progress words, detail and when; name chips and the state chip as a badge where the record still has them; the percent as the key value; a ring or the loading mark on the tile while it runs; its actions as buttons, except the one marked `press`) and `NotificationRow` draws it, running the record's actions and dismissing after them; the `press` action is the whole row's own press. Left without `when`, the row says how long ago from the record's own time (`notificationWhen`) and reads it again every 30 seconds while the work runs. The toast and the center both draw it, with their own close or row controls as `controls`. |
| `NotificationPanel.tsx` | The center's screen body: "In progress" first, then history grouped by day; All / Unread / Problems filters; Mark all as read; Clear; per-row read/unread and remove. `compact` is the short live feed a hover preview shows (running work and the latest five, no filters or row actions). It owns no placement. Replaces Expansion's separate Live activity page. |
| `notification-kinds.json` | DATA: notification kind → Lucide icon and tone, plus the fallback, and `listing_tones` (a kind's tone or a chip's badge tone → the glance tone word: good, attention, bad, info, quiet). A new kind is one row; an unknown kind draws with the fallback. |
| `notification-center.test.ts` | Store behaviour: running work never expires, keyed updates, stacking order, dismiss vs history, Undo, read/unread, remove, quiet background work, bounded history, transfer wording. |
| `notifications-render.test.tsx` | On-screen behaviour in jsdom: DATA-driven glyph and tone, determinate and indeterminate progress, settle to done, Undo, dismiss, stacking, clear; the unread badge channel, the panel's live section, day groups, filters, read state, remove and clear, and the compact preview feed mounted through `mountNotificationPanel`. |
| `README.md` | This file. |

The on-screen stack is `../coss/ui/toast.tsx` (Coss stacked Base UI toast, drawing each card from a record). The imperative front door is `../coss/notifications.tsx`. `../toast/index.ts` gives React surfaces the older `useToastContext()` shape over the same center. Appearance is `packages/screen-look/show/notifications.css`; kind → icon/tone is `notification-kinds.json` in this folder (the UI part owns what a kind means; screen-look only paints the tones).

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| `notify` | `(title: string, options?: NotificationInput) => NotificationHandle` | Show a notification; mounts the shared host on first use. From `../coss/notifications.tsx`; in Expansion `window.ExpansionControls.notify`. |
| `clearNotifications` | `() => void` | Hide settled cards (for example before a dialog). Running work stays. |
| `mountNotificationPanel` | `(element: HTMLElement, {compact?, recordFilter?}) => () => void` | Put the panel (or its compact live feed) into a screen element; returns the cleanup. From `../coss/notification-panel.tsx`, its own file so a page carrying only toasts never carries the panel and its record views (the workspace fetches it when Notifications or the bell's hover feed first opens). In Expansion `window.ExpansionControls.mountNotificationPanel`. |
| `NOTIFICATION_UNREAD_BADGE` | `'notifications:unread'` | The badge channel (`../surface-badges`) the center publishes its unread count on; a navigation row whose DATA says `badge_source: "notifications:unread"` shows it. |
| `notificationCenter` | `() => NotificationCenter` | The document's one center (shared across bundles through `globalThis`). |
| `ensureNotificationHost` | `({position?}) => NotificationCenter` | Mount the toast stack once; the first caller's position wins. |
| `NotificationInput` | `{kind?, detail?, progress?: {value: number \| null, label?}, actions?: NotificationAction[], timeout?, running?, key?, quiet?}` | What a caller supplies. `value` 0..1 or `null` (indeterminate). `timeout: 0` stays until dismissed. `key` updates a live card in place. `quiet` puts background work in the center only (no toast, no unread). |
| `NotificationAction` | `{id?, label, onAction?: () => unknown, dismisses?: boolean}` | A button on the card and its history row. A returned promise keeps it busy. `dismisses` defaults to true. |
| `NotificationHandle` | `{id, update(patch), finish(patch?), dismiss()}` | Change a live card; `finish` clears progress and lets it expire. |
| `NotificationFace` | `{name, picture?, provider?}` | Who a notification is about, leading it: the provider's mark when known, else the picture, else initials. |
| `NotificationInput` (who and press) | `{face?, working?}`, action `{press?}` | `face` leads the row; `working` says someone is at it now (left out, `running` says it); an action with `press` is the whole row's press and draws no button; a press anywhere on the body (or Enter on its title) runs it even when the row has other buttons, which stay their own. |
| `NotificationInput` (from a store) | `{id?, at?, read?, toast?, onRead?(read), kept?}` | A notification read from the caller's own lasting store: emitting the same `id` updates it in place; `at` is when it happened; `read` is the store's read state; `toast: false` puts it in the center with no card; `onRead` tells the store when the person marks it; `kept` records stay through Remove and Clear; `about` names the thing it is about in that store (a press that asked an AI for work), so a control on that thing can follow it. |
| `forget` | `center.forget(id)` | The caller's store no longer holds that record: it leaves history, kept or not. |
| `NotificationRecord` | input + `{id, kind, title, running, visible, read, createdAt, updatedAt, revision}` | What renderers read. |
| `NotificationChange` | `{type: 'added' \| 'updated' \| 'hidden' \| 'removed', record}` | What subscribers receive (O(changed)). |
| `createNotificationCenter` | `(options?: {defaultTimeout?, historyLimit?, now?}) => NotificationCenter` | Build a center (tests, isolated hosts). |
| `describeTransfer` | `({doneItems, totalItems, doneBytes, totalBytes, elapsedMs, itemNoun?}) => NotificationProgress` | "10 of 42 clips · 2.1 GB of 8.4 GB · About 3 min left". |
| `notificationKindAppearance` | `(kind?) => {icon, tone}` | Resolve a kind through DATA, with fallback. |
| `notificationListing` | `(record: NotificationRecord, when?: string) => Listing` | A notification as glance DATA for `../listing-card`. |
| `NotificationRow` | `({record, onDismiss, when?, controls?, className?}) => ReactElement` | One notification as a glance row whose buttons run its actions and whose `press` action is the row's own press. |
| `notificationWhen` | `(record, now?) => string` | When it happened, in words, from `at` (else when it was emitted). |
| `NotificationPanel` | `({center, compact?}) => ReactElement` | The center's screen body. |
| `NOTICE_SUBJECT` | `'notification'` | What show rules call a notice (`src/workspace/show-rules.json` subjects). |
| `noticeThing` | `(record, channel: string) => ShowThing` | A notice as show rules read it: `id`, `kind`, `title`, `key`, `about` and the `channel` it would show on (`toast` for the card, `list` for Notifications and the bell). |

## Showing the center

The center is a screen like any other. An app lists it in its surface DATA; Expansion's `workspace-surfaces.json` row is:

```json
{"id": "media-workspace.notifications", "label": "Notifications", "icon": "Bell",
 "package_entry": {"package_name": "media-workspace", "entry_name": "notifications"},
 "open_placement": {"layer": "overlay", "size": {"width": 420, "height": 620}, "chrome": {"header": false}},
 "preview_surface_id": "media-workspace.notifications-preview",
 "badge_source": "notifications:unread"}
```

Clicking the row opens a floating window with no tab bar (moved by the shared grab strip, resized from any edge, closed or turned into a tab from the strip); dragging the row onto a container opens it as a tab there; resting on the row shows the compact feed in a hover card.

## Emit API for other work (archive, restore, errors)

```js
// Archive with Undo
window.ExpansionControls.notify('Archived 3 recordings', {
  kind: 'archive',
  actions: [{id: 'undo', label: 'Undo', onAction: () => restore(ids)}],
});

// Long-running work with live progress, then a settled result
const job = window.ExpansionControls.notify('Exporting 2 videos', {kind: 'export', progress: {value: null}});
job.update({progress: {value: 0.4, label: '1 of 2 videos'}});
job.finish({title: '2 videos exported', kind: 'done', actions: [{label: 'View', onAction: openExports}]});

// An error says what happened in plain words and offers the next step
window.ExpansionControls.notify('Could not move these to the Trash', {
  kind: 'error', detail: 'The drive stopped answering. Reconnect it and try again.',
  actions: [{label: 'Try again', onAction: retry}],
});
```

A new kind is one row in `notification-kinds.json` (Lucide icon name and tone; running work without a measure draws the shared `../loading-mark`). An unknown kind still draws with the fallback bell, so a caller never waits on styling.

## Dependencies

**Depends on:** `@base-ui/react` (toast stack), `../show-rules` (`showOf`, `onShowChange`, `ShowRuleMenu`: whether a notice pops up or is listed, and the menu that quiets notices like it), `../surface-badges` (unread channel), `react`, `react-dom`, `../listing-card` (every notification is its row form, with the tile ring and loading mark), `../expandable-tabs`, `../relative-time`, `packages/screen-look/show/notifications.css`.

**Depended on by:** `../coss/notifications.tsx`, `../coss/notification-panel.tsx`, `../coss/ui/toast.tsx`, `../toast/index.ts` (React surfaces: service-connections, visual-database, documents, screen-look, sales-contract-builder and others), Expansion (`media-workspace` `shared-controls-entry.ts`, `development/bitfield-workspace.tsx` mounts the `notifications` and `notifications-preview` screens, `activity-notifications.js`, every `ExpansionControls.notify` call). Navigation reaches it only through surface DATA (`packages/sidebar` reads `badge_source` and `preview_surface_id`).

## Invariants

- One center per document. Nothing keeps a second list of notifications.
- Every notification surface (toast card, center panel) is opaque on the screen-look `--surface` token.
- Read state changes only through the person's action; showing the panel does not clear the count.
- Whether a notice pops up is the person's show rules, never a setting here: before a card shows the center asks `showOf('notification', noticeThing(record, 'toast'))`; silenced keeps it in history with no card, hidden also leaves it out of the list and the unread count. When rules change, a card they now silence leaves the screen. Every row carries `ShowRuleMenu` for notices like it.
- Running work (progress or `running: true`) never expires; it settles through `finish` and then expires on its timeout. Dismissing a running card hides it; the center still shows it live. When dismissed work settles, the result comes back into view.
- No kind names in code. Kind → icon/tone is DATA; tones are CSS in screen-look.
- The bottom toast stack is an overlay: it floats above the arranged stage (z-60, below menus and dialogs) and takes no layout space; the stage keeps its full height. It stacks above a docked floating control by reading `--floating-occlusion-bottom`.

## References

Anatomy only, original code: 21st.dev #2527 "Google Drive Uploader Toast" (progress ring on the glyph, per-file progress, cancel), #28243 "Animated Toast" (tone accent, inline Undo), #27135 "Notification Panel" (bell, unseen dots, Escape closes); Mobbin Dropbox and Supabase upload trays, Dovetail and Fabric notification panels. Center: 21st.dev #27135 (tabs with count, Mark all as read, grouped rows, per-row read/archive), #8245 (All / Unread toggle), #29394 (activity rows); Mobbin Linear inbox https://mobbin.com/screens/18c6955a-c42f-4cc1-9aa2-0276456720fb, GitHub notifications https://mobbin.com/screens/2e7cf2ed-0d26-4544-93c4-4a7b6cba2e8d, dashboard activity feed https://mobbin.com/screens/a111dca7-48a2-4456-bba7-acec68ff70f0. Stack geometry is Coss (MIT) on Base UI.
