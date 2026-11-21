// tools/keep-a-continuous-awareness-reading/src/settings-from-rows.mjs
//
// The settings one reading is given, assembled by its caller from two places: the scalar settings (src/awareness-settings.json,
// DATA of this owner) and the texts, which are rows of the person's awareness framework (old_store.awareness_framework, read
// by the caller's own SQL and handed in). A stage, trait or pursuit judgement is one row, its `extra` keeps its id and its
// `order` (the place the reading walks it in). A section of the settings (instructions, words, questions, ...) is one row,
// id `...settings--<section>`, whose `extra.value` is the section as the reading takes it.
//
// Nothing here reads a store and nothing is written: the caller passes the rows, and the scalars stay as DATA says.

const FRAMEWORK = 'record:awareness-framework:';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const parsed = text => (typeof text === 'string' ? JSON.parse(text) : text ?? null);
const extraOf = row => parsed(row.extra) ?? {};

// The rows of one kind (`stages`, `traits`, `pursuit_judgements`) in their order, each as the reading takes it.
function listOf(rows, kind, shape) {
  return rows
    .filter(row => row.id.startsWith(`${FRAMEWORK}${kind}--`))
    .sort((a, b) => extraOf(a).order - extraOf(b).order)
    .map(row => shape(row, extraOf(row)));
}

/**
 * The awareness settings: `scalars` (the DATA file's settings) with the rows of the framework put in. Returns the object the
 * reading takes as `settings`. A row that is none of these kinds is left out.
 */
export function awarenessSettingsOf({ scalars, rows }) {
  if (!object(scalars)) throw new TypeError('awarenessSettingsOf needs the scalar settings (scalars).');
  const framework = (rows ?? []).filter(row => row?.id?.startsWith(FRAMEWORK));
  const sections = Object.fromEntries(framework
    .filter(row => row.id.startsWith(`${FRAMEWORK}settings--`))
    .map(row => [row.id.slice(`${FRAMEWORK}settings--`.length), extraOf(row).value]));
  return {
    ...scalars,
    stages: listOf(framework, 'stages', (row, extra) => ({ id: extra.id, label: row.label, ask: row.ask })),
    traits: listOf(framework, 'traits', (row, extra) => ({ id: extra.id, label: row.label, ask: row.ask })),
    pursuit_judgements: listOf(framework, 'pursuit_judgements', (row, extra) => ({ id: extra.id, label: row.label, ask: row.ask, choices: parsed(row.choices) })),
    ...sections,
  };
}
