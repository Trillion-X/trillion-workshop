# ui/show/document-export — save a note's words as a file

One pure PDF writer and one download helper, so every "Export PDF" / "Download PDF" on a note (transcript, summary, action items, the Notes list row menu) saves the same way.

## Files

| File | Purpose |
|------|---------|
| `text-pdf.mjs` | `textPdf({ title, blocks })` writes the bytes of a paged A4 Helvetica PDF from titled text blocks; characters outside Latin-1 print as "?". Tested by `test/text-pdf.test.mjs`. |
| `download-file.ts` | `downloadFile(name, type, bytes)` saves bytes through an object URL; returns false instead of throwing. |

## Dependencies

**Depends on:** the browser `Blob`, `URL` and `document` only.
**Depended on by:** the meeting transcript, summary, action-item and Notes-list actions (`src/workspace/note-actions.ts`).
