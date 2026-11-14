# surface-notes

Notes on places: a short message, a count, a highlight and screens to open, left on a navigation row or a list by its id. An owner publishes the whole set (Trillion's page publishes what the person's AI left through `note_in_sidebar`); each row and list heading reads the note for its own id and draws it. Neither side knows the other.

## Files

| File | Purpose |
|------|---------|
| `surface-notes.ts` | The per-document note table (on `globalThis`, so separately bundled scripts share it), publish/read/subscribe and a React hook. |
| `README.md` | This file. |

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| `SurfaceNoteOpen` | `{ id: string; label: string; icon?: string; open: () => void }` | A screen a note offers to open. |
| `SurfaceNote` | `{ message?: string; count?: number; highlight?: boolean; by?: string; opens?: SurfaceNoteOpen[] }` | One note on one row or list. |
| `publishSurfaceNotes` | `(notes: ReadonlyMap<string, SurfaceNote>, key: string) => void` | Replace every note; the same `key` again notifies nobody. |
| `readSurfaceNote` | `(id: string) => SurfaceNote \| undefined` | Current note on an id. |
| `subscribeSurfaceNotes` | `(listener: () => void) => () => void` | Called after the set changes. |
| `useSurfaceNote` | `(id: string \| undefined) => SurfaceNote \| undefined` | React read of one id (`useSyncExternalStore`). |

## Dependencies

**Depends on:** `react`.

**Depended on by:** `src/workspace/sidebar-notes.ts` (publishes the `sidebar-notes` record), `parts/sidebar/show/SidebarContent.tsx` (a row draws its note's count as a badge of kind `note`, its highlight as `data-sidebar-note`, its message and screens in `SurfacePreviewCard`; a list heading draws count, highlight and message). Appearance: `parts/screen-look/show/navigation-preview.css`.

## Invariants

- One note table per document.
- Publishing replaces the whole set; a note absent from it is gone.
- An unchanged set (same key) notifies nobody.
