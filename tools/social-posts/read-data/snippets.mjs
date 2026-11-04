// src/snippets.mjs
//
// Purpose
//   Words a person sends over and over, kept once and used anywhere they write: found by a title or a tag, filled with
//   the names of whoever or whatever this time, and put into the box they are writing in (the composer's Snippets
//   menu, an AI's use_snippet). A snippet is an ordinary record of the person's own, the same shape a draft is: a title,
//   its words, when it was saved.
//
// Non-negotiable invariants
//   1. The record type, the blank's pattern, every size and every word are DATA (src/snippets.json).
//   2. Using a snippet changes nothing but its use count and last use; the snippet's words are never rewritten by a use.
//   3. A blank is `{name}` in the words; a value given for it fills every place it appears, and a blank with no value is
//      left exactly as written and named back in `left_blank`, so nothing is sent with a hole the sender did not see.
//   4. Saving with expected_set_at is refused when the snippet was saved since that read.
//   5. Nothing leaves the person's records: a snippet is never sent anywhere by being saved, found or used.
//
import data from './snippets.json' with { type: 'json' };

export class SnippetError extends Error {}

const text = value => (typeof value === 'string' ? value : '');
const fill = (template, values) => template.replace(/\{(\w+)\}/g, (whole, name) => (Object.hasOwn(values, name) ? String(values[name]) : whole));
const BLANK = new RegExp(data.variable_pattern, 'g');
const blanksIn = words => [...new Set([...words.matchAll(BLANK)].map(found => found[1]))];

export function makeSnippets({ eeaf, now = () => new Date(), newId = () => crypto.randomUUID() }) {
  const TYPE = data.record_type;
  const idOf = snippetId => (String(snippetId).startsWith(`${TYPE}:`) ? String(snippetId) : `${TYPE}:${snippetId}`);
  const readOne = snippetId => (typeof snippetId === 'string' && snippetId.trim() ? eeaf.read(idOf(snippetId.trim())) : null);
  const shown = snippet => ({ snippet_id: snippet.snippet_id, title: snippet.title, text: snippet.text, tags: snippet.tags ?? [], blanks: blanksIn(snippet.text), set_at: snippet.set_at, uses: snippet.uses ?? 0, ...(snippet.used_at ? { used_at: snippet.used_at } : {}) });
  const tagsOf = tags => {
    if (tags === undefined) return undefined;
    if (!Array.isArray(tags)) throw new SnippetError('tags is a list of short words.');
    return [...new Set(tags.map(tag => text(tag).trim().toLowerCase().slice(0, data.max_tag)).filter(Boolean))].slice(0, data.max_tags);
  };

  /** Creates a snippet (no snippet_id) or changes one (the fields given; the rest stay). */
  function save({ snippet_id: snippetId, title, text: words, tags, expected_set_at: expected } = {}) {
    const earlier = snippetId === undefined || snippetId === null || snippetId === '' ? null : readOne(snippetId);
    if (snippetId && !earlier) throw new SnippetError(fill(data.words.missing, { snippet_id: snippetId }));
    if (earlier && expected !== undefined && earlier.set_at !== expected) throw Object.assign(new SnippetError(fill(data.words.stale, { snippet_id: earlier.snippet_id, set_at: earlier.set_at, expected })), { next_call: { tool: 'list_snippets', arguments: {} } });
    const nextTitle = title === undefined ? earlier?.title ?? '' : text(title).trim().slice(0, data.max_title);
    const nextText = words === undefined ? earlier?.text ?? '' : text(words).trim().slice(0, data.max_text);
    if (!nextTitle) throw new SnippetError(data.words.needs_title);
    if (!nextText) throw new SnippetError(data.words.needs_text);
    if (!earlier && eeaf.ids(TYPE, { limit: data.max_snippets + 1 }).length > data.max_snippets) throw new SnippetError(fill(data.words.too_many, { max: String(data.max_snippets) }));
    const at = now().toISOString();
    const id = earlier?.snippet_id ?? `${TYPE}:${at}:${newId().replace(/-/g, '').slice(0, 10)}`;
    const snippet = { snippet_id: id, title: nextTitle, text: nextText, tags: tagsOf(tags) ?? earlier?.tags ?? [], set_at: at, uses: earlier?.uses ?? 0, ...(earlier?.used_at ? { used_at: earlier.used_at } : {}) };
    eeaf.write([{ id, type: TYPE, value: snippet }], { actor: { by: 'trillion' } });
    return { snippet: shown(snippet) };
  }

  /** Snippets, newest saved first, whose title, words or tags hold every word of `query` and carry `tag`. */
  function list({ query, tag, limit } = {}) {
    const words = text(query).toLowerCase().split(/\s+/).filter(Boolean);
    const wanted = text(tag).trim().toLowerCase();
    const most = Math.min(Math.max(Math.floor(Number(limit) || data.list_limit), 1), data.list_limit);
    const found = eeaf.ids(TYPE, { limit: data.max_snippets }).map(id => eeaf.read(id)).filter(Boolean)
      .filter(snippet => (!wanted || (snippet.tags ?? []).includes(wanted)) && words.every(word => `${snippet.title} ${snippet.text} ${(snippet.tags ?? []).join(' ')}`.toLowerCase().includes(word)))
      .sort((a, b) => String(b.used_at ?? b.set_at).localeCompare(String(a.used_at ?? a.set_at)));
    return { snippets: found.slice(0, most).map(shown), ...(found.length > most ? { more: found.length - most } : {}) };
  }

  /** The words of a snippet with the blanks filled from `values`; counts the use. */
  function use({ snippet_id: snippetId, values = {} } = {}) {
    const snippet = readOne(snippetId);
    if (!snippet) throw new SnippetError(fill(data.words.missing, { snippet_id: snippetId ?? '' }));
    const given = values !== null && typeof values === 'object' && !Array.isArray(values) ? values : {};
    const filled = snippet.text.replace(BLANK, (whole, name) => (Object.hasOwn(given, name) && given[name] !== null && String(given[name]) !== '' ? String(given[name]) : whole));
    const left = blanksIn(filled);
    const at = now().toISOString();
    eeaf.write([{ id: snippet.snippet_id, type: TYPE, value: { ...snippet, uses: (snippet.uses ?? 0) + 1, used_at: at } }], { actor: { by: 'trillion' } });
    return { snippet_id: snippet.snippet_id, title: snippet.title, text: filled, left_blank: left, ...(left.length ? { said: fill(data.words.unfilled, { names: left.join(', ') }) } : {}) };
  }

  function remove({ snippet_id: snippetId } = {}) {
    const snippet = readOne(snippetId);
    if (!snippet) throw new SnippetError(fill(data.words.missing, { snippet_id: snippetId ?? '' }));
    eeaf.write([{ id: snippet.snippet_id, type: TYPE, value: null }], { actor: { by: 'trillion' } });
    return { removed: true, snippet_id: snippet.snippet_id, said: fill(data.words.removed, { title: snippet.title }) };
  }

  return { save, list, use, remove };
}
