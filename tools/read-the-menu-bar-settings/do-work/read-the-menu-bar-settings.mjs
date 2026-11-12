// tools/read-the-menu-bar-settings/do-work/read-the-menu-bar-settings.mjs
//
// tool:read-the-menu-bar-settings, run as a function in the tool container:
//
//   node do-work/read-the-menu-bar-settings.mjs < <the input as JSON>
//
// and prints { result } on its last line (or { error } with exit 1). It answers the Mac menu bar item's own settings rows
// (enabled, how far ahead meetings count, the title's length, the app icon): each row's value as the host last answered it,
// or its default, and whether a requested change is one its row allows. The row definitions are this tool's DATA
// (read-data/menu-bar-settings.json), the one source the Mac app and the web page read; the caller hands in only the host's
// answer and a change. Nothing is kept or written here.
//
// Port of old trillion trillion-apps web/src/workspace/panel-settings.mjs (`panelSettingsState`, the KINDS shape checks, and
// setPanelSetting's message shape) and the row DATA of macos/App/menu-bar-panel.json `settings.rows`, at commit 21a2de08.
// An answer that is not the rows' shape is taken as no answer, so a host that does not know the rows shows its defaults.
import { readFileSync } from 'node:fs';

const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const finite = value => Number.isFinite(value);

const KINDS = {
  switch: (row, value) => typeof value === 'boolean',
  choice: (row, value) => Array.isArray(row.choices) && row.choices.length > 0 && row.choices.some(choice => choice.id === value),
  range: (row, value) => finite(value) && value >= row.least && value <= row.most,
};

// A definition is usable when it names an id, a kind the tool knows and the limits its kind needs.
const usable = row => object(row) && typeof row.id === 'string' && row.id && Object.hasOwn(KINDS, row.kind)
  && (row.kind !== 'switch' || typeof row.default === 'boolean')
  && (row.kind !== 'choice' || (Array.isArray(row.choices) && row.choices.length > 0 && row.choices.every(choice => object(choice) && typeof choice.id === 'string' && choice.id && typeof choice.title === 'string')
    && row.choices.some(choice => choice.id === row.default)))
  && (row.kind !== 'range' || ([row.least, row.most, row.step, row.default].every(finite) && row.least < row.most && row.step > 0
    && row.default >= row.least && row.default <= row.most));

// The host's answer as its rows, or null when it is not an answer of this shape (old panelSettingsState).
export function hostAnswer(answer, definitions) {
  if (!object(answer) || !Array.isArray(answer.rows) || answer.rows.length === 0) return null;
  const rows = answer.rows.filter(row => object(row) && typeof row.id === 'string' && row.id);
  const known = new Map(definitions.map(row => [row.id, row]));
  const shaped = rows.every(row => known.has(row.id) && known.get(row.id).kind === row.kind && KINDS[row.kind](known.get(row.id), row.value));
  return shaped ? new Map(rows.map(row => [row.id, row.value])) : null;
}

// The rows the tool answers for: its DATA, every one usable (checked once, when the tool loads).
export const definitions = JSON.parse(readFileSync(new URL('../read-data/menu-bar-settings.json', import.meta.url), 'utf8')).rows;
if (!Array.isArray(definitions) || !definitions.every(usable)) throw new Error('read-data/menu-bar-settings.json: each row needs an id, a kind (switch, choice or range) and a default its kind allows.');

export function readTheMenuBarSettings(input) {
  if (!object(input)) throw new Error('Send one JSON object: { answer?, set? }.');
  const held = hostAnswer(input.answer, definitions);
  const rows = definitions.map(row => {
    const value = held?.has(row.id) ? held.get(row.id) : row.default;
    const { id, kind, choices, least, most, step } = row;
    return { id, kind, value, ...(kind === 'choice' ? { choices } : {}), ...(kind === 'range' ? { least, most, step } : {}) };
  });
  let change = null;
  if (input.set !== undefined) {
    const { id, value } = input.set ?? {};
    const row = definitions.find(item => item.id === id);
    if (!row) throw new Error(`no menu bar setting named ${id}.`);
    if (!KINDS[row.kind](row, value)) throw new Error(`${value} is not a value ${id} allows.`);
    change = { id, value, kind: row.kind };
  }
  return { rows, held: held !== null, ...(change ? { change } : {}) };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const { readFileSync } = await import('node:fs');
  try {
    process.stdout.write(JSON.stringify({ result: readTheMenuBarSettings(JSON.parse(readFileSync(0, 'utf8') || '{}')) }) + '\n');
  } catch (error) {
    process.stdout.write(JSON.stringify({ error: error.message }) + '\n');
    process.exitCode = 1;
  }
}
