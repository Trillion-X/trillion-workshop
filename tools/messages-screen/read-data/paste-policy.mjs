// parts/chat/read-data/paste-policy.mjs
//
// Purpose: the one owner of what a paste into a composer becomes (hand-offs, notes, AI chat). Pure: it reads what was on
// the clipboard and answers { action: 'insert' } (let the field take it, so undo keeps working), { action: 'attach_text',
// name, text, media_type, said } or { action: 'attach_images', files, said }. The composer applies the answer and offers the
// undo; the rules (threshold, file name, image-versus-text) are DATA (paste-policy.json).
//
// Non-negotiable invariants
//   1. A short paste is never intercepted: it is `insert`.
//   2. An image attaches only when the clipboard markup has no text of its own; a copy that has text keeps its text.
//   3. Nothing is lost silently: an attach answer carries `said`, the words the person reads beside the attachment.
//
import data from './paste-policy.json' with { type: 'json' };

export const pasteSettings = () => data;
const fill = (template, values) => String(template ?? '').replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? ''));

/** Whether clipboard markup carries words of its own: a scan that skips tags, and the bodies of the tags `data.markup_skip` names. */
export function markupHasText(markup, skip = data.markup_skip) {
  const text = String(markup ?? '');
  const lower = text.toLowerCase();
  let at = 0; let words = '';
  while (at < text.length) {
    const open = text.indexOf('<', at);
    if (open < 0) { words += text.slice(at); break; }
    words += text.slice(at, open);
    const close = text.indexOf('>', open);
    if (close < 0) break;
    const name = lower.slice(open + 1, close).split(/[\s/]/)[0];
    at = close + 1;
    if (skip.includes(name)) { const end = lower.indexOf(`<${'/'}${name}`, at); at = end < 0 ? text.length : end; }
  }
  return words.replace(/&nbsp;/g, ' ').trim().length > 0;
}

/** clipboard: { text, html, files: [{ type, name }] }. */
export function pasteDecision(clipboard, { settings = pasteSettings(), now = () => new Date() } = {}) {
  const images = (clipboard.files ?? []).filter(file => String(file.type ?? '').startsWith(settings.image_prefix));
  if (images.length && !markupHasText(clipboard.html, settings.markup_skip)) return { action: 'attach_images', files: images, said: fill(settings.words.attached_images, { count: images.length }) };
  const text = String(clipboard.text ?? '');
  if (text.length > settings.long_text_chars) {
    const name = fill(settings.file_name, { stamp: now().toISOString().replace(/[:T]/g, '-').slice(0, 19) });
    return { action: 'attach_text', name, text, media_type: settings.media_type, said: fill(settings.words.attached_text, { count: text.length, name }) };
  }
  return { action: 'insert' };
}
