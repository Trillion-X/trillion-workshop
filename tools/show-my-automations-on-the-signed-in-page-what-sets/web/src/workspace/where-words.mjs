// src/workspace/where-words.mjs
//
// PURPOSE
//   Names one test of a rule's `when.where` in plain words from its own values, for the automation editor's heading
//   over that test: the field, the words for its comparison, then its value ("Text contains 'invoice'").
//
// NON-NEGOTIABLE INVARIANTS
//   1. The comparison's words are DATA (src/workflow-looks.json test_words); a comparison with no row is named by its
//      own key in words, so a new kind of test is named without a change here.
//   2. A value of `true` says nothing more ("Subject is filled in"); a list reads "'a' or 'b'".

const spaced = text => String(text).replace(/[-_]+/g, ' ').trim();
const capital = text => text.charAt(0).toUpperCase() + text.slice(1);
const quoted = value => `'${value}'`;
const valueWords = value => {
  if (value === true) return '';
  if (Array.isArray(value)) return value.length < 2 ? value.map(quoted).join('') : `${value.slice(0, -1).map(quoted).join(', ')} or ${quoted(value.at(-1))}`;
  if (value && typeof value === 'object') return JSON.stringify(value);
  return quoted(value);
};

/** "Text contains 'invoice'": one where-test named from its field, comparison and value. */
export function whereWords(test, words = {}) {
  const field = capital(spaced(test?.field ?? 'A field'));
  const comparison = Object.keys(test ?? {}).find(key => key !== 'field');
  if (!comparison) return field;
  const said = typeof words[comparison] === 'string' ? words[comparison] : spaced(comparison);
  return [field, said, valueWords(test[comparison])].filter(Boolean).join(' ');
}
