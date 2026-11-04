// src/choice-mapping.mjs
//
// PURPOSE
//   Where a row's state goes when the row moves to a list whose choices differ. A choice is classified by KIND (not started,
//   in progress, finished, dropped: src/choice-kinds.json), the target choice of that kind is found by name first when it has
//   several, else the first of that kind; never by position or id. Work that moves keeps its meaning.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Pure and blind: kinds, their naming words and every sentence are DATA; no list, field or choice is named here.
//   2. A kind the field states for a choice (`kinds`) wins over the naming words.
//   3. A value that cannot be matched never silently becomes some other state: it takes the target's `starts` value or
//      nothing, and the answer says so in words.
//
import data from './choice-kinds.json' with { type: 'json' };

const plain = text => String(text ?? '').toLowerCase().replace(/[\s_]+/g, ' ').trim();
const NAMED = new Map(data.kinds.flatMap(kind => kind.names.map(name => [plain(name), kind.id])));
const fill = (template, values) => template.replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));

/** The kind id of one choice of `field` ({ choices, kinds? }), or null when nothing says. */
export function kindOfChoice(field, value) {
  const stated = field?.kinds?.[value];
  if (typeof stated === 'string' && data.kinds.some(kind => kind.id === stated)) return stated;
  return NAMED.get(plain(value)) ?? null;
}

/**
 * `value` of the `from` field as a value of the `to` field: { value, matched: 'name'|'kind'|'start'|'none', said? }.
 * An empty value stays empty. A value the target already has, by name, in the same kind, is kept as that target's spelling.
 */
export function mapChoice(from, to, value) {
  if (value === null || value === undefined || value === '') return { value: null, matched: 'none' };
  const targets = Array.isArray(to?.choices) ? to.choices : [];
  const kind = kindOfChoice(from, value);
  const sameKind = kind ? targets.filter(choice => kindOfChoice(to, choice) === kind) : [];
  const named = sameKind.find(choice => plain(choice) === plain(value));
  if (named !== undefined) return { value: named, matched: 'name' };
  if (sameKind.length) return { value: sameKind[0], matched: 'kind' };
  // No choice of that kind: a target spelling the same word keeps the word (an unclassified choice moves by name alone).
  const byWord = kind ? undefined : targets.find(choice => plain(choice) === plain(value));
  if (byWord !== undefined) return { value: byWord, matched: 'name' };
  const start = typeof to?.starts === 'string' && targets.includes(to.starts) ? to.starts : null;
  const field = to?.label ?? to?.id ?? 'the target';
  const fallback = start === null ? data.words.fell_to_empty : fill(data.words.fell_to_start, { start });
  return { value: start, matched: start === null ? 'none' : 'start', said: fill(data.words.unmapped, { value, field, fallback }) };
}
