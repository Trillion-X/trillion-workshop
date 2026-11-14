// parts/ui/show/clipboard/copy-answer.ts
//
// Writes a copied answer to the system clipboard in both forms together, with its time citations linked to the
// source's moments (answer-copy.mjs). Falls back to the plain form through copyTextToClipboard when the browser cannot write
// both. Returns whether anything was copied; never throws.
import { answerForClipboard } from './answer-copy.mjs';
import { copyTextToClipboard } from 'trillion-workshop/tools/ui/show/clipboard/copy-text.ts';

/** Copies `answer` for pasting elsewhere; `base` is the source's address, so each citation opens it at that second. */
export async function copyAnswerToClipboard(answer: string, options: { base?: string | null } = {}): Promise<boolean> {
  const { html, text } = answerForClipboard(answer, options);
  try {
    if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
      await navigator.clipboard.write([new ClipboardItem({ 'text/html': new Blob([html], { type: 'text/html' }), 'text/plain': new Blob([text], { type: 'text/plain' }) })]);
      return true;
    }
  } catch { /* the plain form below still works */ }
  return copyTextToClipboard(text);
}
