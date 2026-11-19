// Public tool entry for the existing clipboard policy owner. Keep this tool's settings and CLI seam here.
import { markupHasText, pasteDecision as canonicalPasteDecision } from '../../messages-screen/read-data/paste-policy.mjs';
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';
import data from './paste-policy.json' with { type: 'json' };

export { markupHasText };
export const pasteSettings = () => data;
export function pasteDecision(clipboard, { settings = pasteSettings(), ...options } = {}) {
  return canonicalPasteDecision(clipboard, { ...options, settings });
}

/** The tool's run: { clipboard, now? } on standard input -> { result: the decision }. `now` (ISO) names the attachment's stamp. */
export function decidePaste(input = {}) {
  const at = input.now ? new Date(input.now) : new Date();
  return pasteDecision(input.clipboard ?? {}, { now: () => at });
}

if (import.meta.url === (process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : '')) {
  const { text } = await import('node:stream/consumers');
  const input = JSON.parse((await text(process.stdin)) || '{}');
  console.log(JSON.stringify({ result: decidePaste(input) }));
}
