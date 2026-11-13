// src/workspace/note-list.ts
//
// PURPOSE
//   What the Notes list (the Media list of recordings) adds to a row's menu: download the kept transcript as a PDF.
//   (Recency groups are src/workspace/recency-group.mjs; copy public link is copyPublicLink in sharing-sheet.tsx.)
//
// NON-NEGOTIABLE INVARIANTS
//   1. Words are DATA (note-list-menu.json).
//   2. A PDF is only the transcript the Files owner kept; no transcript means no PDF, said in words.

import words from './note-list-menu.json';
import { fileResults } from './api';
import { notify } from '../../parts/ui/show/coss/notifications';
import { errorWords } from '../../../../ui/show/safe-error-card/sanitize-error-text.ts';
import { saveNotePdf } from './note-actions';

/** Saves one recording's kept transcript as a PDF named after it. Says in words why it could not. */
export async function downloadTranscriptPdf(identity: string, title: string): Promise<boolean> {
  const data = words.pdf;
  try {
    const result = await fileResults.read<{ results: { value: { text?: string } }[] }>(identity, 'transcript');
    const text = result.results[0]?.value?.text?.trim() ?? '';
    if (!text) { notify(data.failed, { kind: 'error', detail: data.no_transcript }); return false; }
    return saveNotePdf(title, [{ heading: data.transcript_heading, text }], { done: data.done, failed: data.failed, detail: data.failed });
  } catch (error) { notify(data.failed, { kind: 'error', detail: errorWords(error) }); return false; }
}
