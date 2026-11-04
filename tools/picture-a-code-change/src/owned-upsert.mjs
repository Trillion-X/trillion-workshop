// src/owned-upsert.mjs
//
// ONE MESSAGE OF OUR OWN ON A SHARED SURFACE: FOUND BY MARKER AND AUTHOR, WRITTEN ONCE, NEVER WRITTEN STALE.
//
// Purpose: an adapter that posts a status, a diagram or a summary where others also post (a pull request, a thread, a board) must
// not post a second copy each run, must not be fooled by someone copying its marker, and must not overwrite the present with a
// message composed about the past. This is that rule, written once: the surface's three verbs and the moving thing's current
// version are handed in; nothing here names a surface.
//
// Non-negotiable invariants:
//   1. A message is ours only when it carries the marker AND was written by `owner`; a marker alone is never enough.
//   2. The version of the thing is read before composing and again immediately before writing; if the two differ nothing is
//      written (`overtaken`). A failed read of either is an error that reaches the caller, never a quiet skip.
//   3. Listing is paged through to its end; a failed page is an error, not "no message found".
//   4. An update whose body is already what is there writes nothing (`unchanged`).
//   5. Older duplicates of our own message are reported, never deleted.
//
// Surface: { list(page) -> { messages: [{ id, author, body }], next? }, create(body), update(id, body) }.
import rules from './owned-upsert.json' with { type: 'json' };

const fill = (template, values) => template.replace(/\{(\w+)\}/gu, (whole, name) => (name in values ? String(values[name]) : whole));

/** Every message on the surface, all pages. A failed page throws. */
async function everyMessage(surface) {
  const found = [];
  let page = undefined;
  do {
    const answer = await surface.list(page);
    found.push(...answer.messages);
    page = answer.next;
  } while (page !== undefined && page !== null);
  return found;
}

/**
 * Keeps one message of ours up to date. `compose()` returns the body (it must include `marker`); `currentVersion()` returns
 * the moving thing's present version (any comparable value). -> { outcome, id, said, duplicates: [id] }
 */
export async function upsertOwned({ surface, marker, owner, compose, currentVersion }, settings = rules) {
  const before = await currentVersion();
  const body = await compose();
  if (!String(body).includes(marker)) throw new Error('the composed message does not carry the marker, so it could not be found again');
  const ours = (await everyMessage(surface)).filter((message) => message.author === owner && String(message.body).includes(marker));
  const latest = ours.at(-1);
  const duplicates = ours.slice(0, -1).map((message) => message.id);
  const said = (outcome) => fill(settings.words[outcome], {}) + (duplicates.length ? ` ${fill(settings.words.duplicates, { count: duplicates.length })}` : '');
  const after = await currentVersion();
  if (after !== before) return { outcome: 'overtaken', id: latest?.id ?? null, said: said('overtaken'), duplicates };
  if (!latest) { const made = await surface.create(body); return { outcome: 'created', id: made?.id ?? null, said: said('created'), duplicates }; }
  if (latest.body === body) return { outcome: 'unchanged', id: latest.id, said: said('unchanged'), duplicates };
  await surface.update(latest.id, body);
  return { outcome: 'updated', id: latest.id, said: said('updated'), duplicates };
}
