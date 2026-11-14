# sharing-sheet

The one sharing sheet every place that shares uses: a caller hands in DATA (the preview, the places, the fields, a linked-records switch, its own buttons) and gets the same sheet. Nothing about what is being shared is known here.

## Files

| File | Purpose |
|------|---------|
| `SharingSheet.tsx` | `SharedCopy`: one shared copy under a heading (a picture, or a title and labelled fields), drawn the same in the sheet and wherever a person reads what someone shared with them. `SharingSheet`: the preview of what others will see (a picture, or a title and labelled fields), the places to switch on or off and the places that open at once, a switch per field, the linked-records switch, the caller's buttons and Save. |

## Key Types / Functions

| Type / Export | Signature / Shape | Role |
|---------------|-------------------|------|
| `SharingSheet` | `({ preview, places, fields?, chain?, words, previewFor?, onSave?, onOpen?, actions?, proposed?, invite?, access?, general?, options?, lock?, history? })` | The sheet: preview, the lock row, invite, who has access, who else can open it, places, fields, linked records, history, More choices, buttons. |
| `SharingInvite` | `{ label, placeholder, roles?, role?, invite(value, role) }` | The invite row: a name, email or number, a role chosen from the caller's roles, Invite. |
| `SharingAccessRow` | `{ id, label, detail?, badge?, icon?, role?: { value, choices, change? }, remove?: { label, run } }` | One person, place or link that can open it now, with their role (a choice when `change` is given) and a way to take it back. |
| `SharingGeneral` | `{ value, choices: [{ id, label, detail, icon }], change(id) }` | Who else can open it: one of the caller's choices, changed at once. |
| `SharingLock` | `{ label, detail?, on, blocked?, ask?: { label, again?, go, differ }, change(on, secret?) }` | Keeping the thing to the person's own devices: a switch that may ask for a secret in place (twice when it is being set); `blocked` says why it cannot turn. |
| `SharingHistory` | `{ heading, rows: [{ id, label, detail?, icon? }] }` | What happened to the thing (who checked it), newest first. |
| `SharingOption` | `{ id, label, kind: 'date' \| 'number' \| 'text' \| 'switch', value, placeholder?, detail?, change(value) }` | One More choices option, saved when left (or turned). |
| `SharingRole` | `{ id, label }` | A role in the caller's words. |
| `SharedCopy` | `({ heading: string, preview: SharingPreview })` | One shared copy under its heading; the sheet's preview, and the copy a person opens from Shared with me. |
| `SharingPreview` | `{ image?: { src, alt, width?, height? }, title?, fields?: [{ id, label, value }] }` | What others see; the caller's copy, never computed here. |
| `SharingPlace` | `{ id, label, icon?, logo?, picked?, href? }` | A place: switched on or off, or with `href` one that opens at once through `onOpen`. |
| `SharingField` | `{ id, label, included, match_only? }` | A field the thing carries; switching it off asks `previewFor(leaveOut)` for the new preview. With `match_only` present (true or false) and `words.field_ways` given, the switch becomes a choice of three: goes as it is, only to match (copies carry a mark, never the value; the preview shows `shown_as_match`), or stays out. |
| `SharingAction` | `{ id, label, icon?, primary?, run }` | A caller's own button (Share, Copy link, Save image). |
| `SharingChoice` | `{ picked: string[], leave_out: string[], match_only: string[], chain: boolean }` | What `onSave` receives. |
| `SharingWords` | `{ preview, places, fields?, save?, saved?, failed, access?, general?, more?, fewer?, field_ways? }` | Every word the sheet shows that is not the caller's DATA. |

## Dependencies

**Depends on:** `coss/ui/button`, `coss/ui/input`, `coss/ui/select`, `coss/ui/badge`, `coss/logo`, `switch/Switch`, `icon/NamedIcon`, `coss/notifications`; appearance in `screen-look/show/guide.css` (`.sharing-sheet*`).
**Depended on by:** `share-card/ShareSheet.tsx` (a card of numbers shared to apps), Trillion's `src/workspace/sharing-sheet.tsx` (who one record, one part of a record or one space is shared with, from every ⋯ menu's Share, a list's Share and a space's Share), the Shared with me screen in the Workshop's `tools/open-the-sharing-sheet-for-a-record-preview-the-copy/web/src/workspace/shared-with-me-screen.tsx` (`SharedCopy`: one thing someone shared with the person, opened).

## Invariants

- The preview is the caller's copy: `previewFor` answers with the same copy the share makes, so the sheet cannot show a field that would not go.
- Places, fields and words are DATA; a new kind of place is a row.
- Places, fields and the linked-records switch wait for Save; a place with `href`, a caller's button, Invite, a role, a removal, general access and an option act at once, each showing pending inside its own control and saying a failure.
- Every control is a shared one.

## References

Notion's share menu (Mobbin screen f70f3807-8825-4a81-926f-54447ffa0665), Perplexity's Manage who can view (Mobbin bef96c05-29f8-4374-9cbb-e47cfa83b0cd: people with access, then general access), MagicPath's Share project (Mobbin 027e1fb7-1a45-4952-ba26-38211d0e5736: invite with a role), HoneyBook's Share file (Mobbin e770eb31-4ced-4f78-a274-f61207a14024: email code before signing or paying), the Notability/boards.com share sheet the owner sent (who has access, Not signed up badge, Make public, Copy link), 21st.dev Share Dialog (component 26993) and People Picker (24801), anatomy only, no code copied, and Strava's share sheet for a card.
