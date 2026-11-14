# version-history/

The history of any record that keeps versions, drawn so a person chooses one by looking: a picture of each version, when and by whom it was made, what changed in words, Preview, Compare with the current one side by side, and Restore with its own pending/done/failed state.

## Files

| File | Purpose |
|------|---------|
| `VersionHistory.tsx` | The `VersionHistory` component: the newest-first list, one version opened large, and two side by side. |
| `index.ts` | Barrel export. |

The look lives in `parts/screen-look/show/version-history.css` (container queries on the list's own width).

## Key Types / Functions

| Type / Export | Signature / Shape | Role |
|---------------|-------------------|------|
| `VersionHistory` | `(props: VersionHistoryProps) => JSX.Element` | Renders the history; owns only which version is open. |
| `VersionHistoryProps` | `{ rows, picture?, onRestore?, onRestoreAsDraft?, emptyWords?, noun? }` | `picture(id)` draws one version (asked once, only when on screen); `onRestore(id)` puts one back; `onRestoreAsDraft(id)` puts one back as the draft, leaving what is current as it is. |
| `VersionRow` | `{ id, number, at: string \| null, by: string \| null, words: string \| null, current: boolean }` | One version as DATA; the caller fills it from whatever record it has. |
| `VersionPicture` | `{ src } \| null` | Any image address the browser can show. |

## Invariants

- Blind to the record: nothing here names sites, pages, documents or files; a new kind of record with history is a caller passing rows and a `picture` function.
- A version never changes, so its picture is asked for once per list and kept; one with no picture still shows its words.
- The current version is marked Current and is never offered for restore.

## Usage

```tsx
<VersionHistory
  rows={history.map(row => ({ id: row.revision, number: row.number, at: row.created_at, by: row.by, words: row.words, current: row.live }))}
  picture={id => drawVersion(id)}
  onRestore={id => restoreVersion(id)}
/>
```

## Dependencies

**Depends on:** `../button`, `../icon/NamedIcon`, `../relative-time`, `parts/screen-look/show/version-history.css`.
**Depended on by:** `src/workspace/public-apps-screen.tsx` (a site's Versions view).
