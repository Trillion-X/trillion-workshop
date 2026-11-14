// src/workspace/note-actions.ts
//
// PURPOSE
//   The one place a note's words leave the screen: copied to the clipboard, or saved as a PDF. The transcript, summary
//   and action-item tools on a recording, and the Notes list row menu, all call these, each saying only what to save.
//
// NON-NEGOTIABLE INVARIANTS
//   1. A copy says "copied" only when the clipboard write verifiably happened (copyTextToClipboard is fail-closed).
//   2. A PDF is the one writer's bytes (parts/ui/show/document-export/text-pdf.mjs); words for every outcome are the caller's.
//   3. Nothing here reads or writes the person's records; it only moves the text it is given.

import { copyTextToClipboard } from 'trillion-workshop/tools/ui/show/clipboard/copy-text.ts';
import { downloadFile } from '../../parts/ui/show/document-export/download-file';
import { textPdf } from '../../parts/ui/show/document-export/text-pdf.mjs';
import { notify } from '../../parts/ui/show/coss/notifications';

export type NoteBlock = { heading?: string; text: string };

// A file name safe on every system, from the note's own title.
const fileSafe = (title: string) => title.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Note';

/** Copies `text` and tells the person the outcome in the caller's words. */
export async function copyNoteText(text: string, words: { done: string; failed: string; detail: string }): Promise<boolean> {
  const copied = Boolean(text.trim()) && await copyTextToClipboard(text);
  if (copied) notify(words.done); else notify(words.failed, { kind: 'error', detail: words.detail });
  return copied;
}

/** Saves the blocks as `<title>.pdf` and tells the person the outcome in the caller's words. */
export function saveNotePdf(title: string, blocks: readonly NoteBlock[], words: { done: string; failed: string; detail: string }): boolean {
  const saved = blocks.some(block => block.text.trim()) && downloadFile(`${fileSafe(title)}.pdf`, 'application/pdf', textPdf({ title, blocks: [...blocks] }));
  if (saved) notify(words.done); else notify(words.failed, { kind: 'error', detail: words.detail });
  return saved;
}
