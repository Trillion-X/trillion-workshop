// src/snippets.mjs
//
// Purpose
//   Filling a saved snippet's blanks (tool:use-a-snippet). A snippet is an ordinary record of the person's own: a title,
//   its words, when it was saved. Saving, finding and removing one are the store's job (workflow:keep-the-persons-snippets,
//   tools/workflows/recipes), so this code only reads the record it is handed.
//
// Non-negotiable invariants
//   1. The record type, the blank's pattern and the words shown are DATA (read-data/snippets.json).
//   2. Using a snippet changes nothing: it answers the filled words and writes nothing.
//   3. A blank is `{name}` in the words; a value given for it fills every place it appears, and a blank with no value is
//      left exactly as written and named back in `left_blank`, so nothing is sent with a hole the sender did not see.
//   4. Nothing leaves the person's records: a snippet is never sent anywhere by being used.
//
import data from './snippets.json' with { type: 'json' };

export class SnippetError extends Error {}

const fill = (template, values) => template.replace(/\{(\w+)\}/g, (whole, name) => (Object.hasOwn(values, name) ? String(values[name]) : whole));
const BLANK = new RegExp(data.variable_pattern, 'g');
const blanksIn = words => [...new Set([...words.matchAll(BLANK)].map(found => found[1]))];

/** eeaf: read(id) -> the record's value or null, over the records the caller handed in. */
export function makeSnippets({ eeaf }) {
  const TYPE = data.record_type;
  const idOf = snippetId => (String(snippetId).startsWith(`${TYPE}:`) ? String(snippetId) : `${TYPE}:${snippetId}`);
  const readOne = snippetId => (typeof snippetId === 'string' && snippetId.trim() ? eeaf.read(idOf(snippetId.trim())) : null);

  /** The words of a snippet with the blanks filled from `values`. Nothing is written. */
  function use({ snippet_id: snippetId, values = {} } = {}) {
    const snippet = readOne(snippetId);
    if (!snippet) throw new SnippetError(fill(data.words.missing, { snippet_id: snippetId ?? '' }));
    const given = values !== null && typeof values === 'object' && !Array.isArray(values) ? values : {};
    const filled = snippet.text.replace(BLANK, (whole, name) => (Object.hasOwn(given, name) && given[name] !== null && String(given[name]) !== '' ? String(given[name]) : whole));
    const left = blanksIn(filled);
    return { snippet_id: snippet.snippet_id, title: snippet.title, text: filled, left_blank: left, ...(left.length ? { said: fill(data.words.unfilled, { names: left.join(', ') }) } : {}) };
  }

  return { use };
}
