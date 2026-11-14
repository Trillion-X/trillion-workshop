# ui/show/file-field/

One form field that takes a file the person keeps: chosen from their files, or dropped or uploaded, holding that file's id.

## Files

| File | Purpose |
|------|---------|
| `FileField.tsx` | The field: the licensed kibo Dropzone (drop, or click to upload) beside "Choose from your files", which opens the one shared folder tree (`coss/project-tree.tsx` `ProjectTree`, navigator mode) in a coss Popover listing only files of the kind the field takes; while a file uploads, its name and share done; once chosen, the shared `FileChip` with a remove button. A file of another kind is refused in words before any upload. |
| `file-takes.json` | DATA: each kind of file a field can take (`video`, `audio`, `picture`, `recording`, `seen-or-heard`, `any`) with the media types it accepts (`type/*` or exact) and its word for one file, and every sentence the field says. A new kind of file is one row. |
| `takes-file.mjs` (+ `.d.mts`) | `takesFile` and `takesOf` in plain JavaScript with JSON imports, so the field and the Worker's file cards (src/work-workshop.mjs `fileActions`) decide what a file takes in one place. |
| `index.ts` | Exports `FileField`, `takesFile`, `takesOf` and the types. |

## Key Types / Functions

| Type | Signature / Shape | Role |
|------|-------------------|------|
| `FileField` | `({ label, takes?, multiple?, value, onChange, source? }) => JSX` | The field; `value` is the chosen file's id or `''`. Without a `source` its buttons are off. |
| `FileFieldSource` | `{ root: string; list(folder, { cursor?, session?, page_size? }) => Promise<FileFieldEntry[] | FileFieldPage>; upload(file, onProgress) => Promise<FileFieldEntry> }` | Where files come from and where a dropped one goes; the caller's (the web app's is `src/workspace/your-files.ts`). |
| `FileFieldEntry` | `{ id, name, folder, media_type?, path? }` | A file (its id) or a folder (its path) the source listed or uploaded. |
| `takesFile` | `(accept: string[], mediaType, name) => boolean` | Whether a file is of an accepted kind; a file with no media type is known by its name's ending (`file-chip/file-kinds.json` `endings`). |
| `takesOf` | `(takes?: string) => { accept: string[]; noun: string }` | A `takes` id's row of `file-takes.json`; an unknown id takes any file. |

## Dependencies

**Depends on:** `../kibo/dropzone` (Dropzone, DropzoneEmptyState), `../coss/project-tree` (ProjectTree), `../file-chip` (FileChip, fileKindIcon, file-kinds.json), `../coss/ui/popover`, `../coss/ui/button`, `../icon/NamedIcon`, `../spinner/Spinner`; appearance in `parts/screen-look/show/file-field.css`.

**Depended on by:** `../coss/guide.tsx` (a row field with `kind: 'file'`, its source from the guide's `files` option), and through it `src/workspace/tool-screen.tsx` (a Workshop tool's input whose screen `inputs` says `"file": { "takes": ... }`, built by `src/workspace/tool-inputs.ts`).

## Invariants

1. Blind: no address, folder or product is named here; where files come from is the caller's `source`.
2. A field never takes a file of another kind: the chooser lists only files of its kind, and a dropped or uploaded file of another kind is refused before upload.
3. The value is only ever an id the source answered; nothing is typed.

## References

Square's "Choose a file or drag and drop it here" box (Mobbin 004704ad-da19-4a6d-9402-9b1b9a0eea83), Mintlify's "Select video" chooser with its Upload tile (Mobbin 465c41fd-a84a-4bfa-9109-249e93d618d6), 21st.dev 19201 "File Dropzone" (one file, kind checked on drop).

## Multiple files and bounded metadata pages

A source may return `{ entries, cursor?, session? }`. The chooser requests one page at a time with the shared FileTree Show more control. First-page selections remain usable while later metadata loads. A failed page keeps its cursor for retry; reopening or changing source starts a fresh session and ignores stale results. Selection values retain only the exact source identities, never signed addresses or original file bytes. Removing a chip removes that selection. Uploaded files follow the same source owner before becoming selectable.
