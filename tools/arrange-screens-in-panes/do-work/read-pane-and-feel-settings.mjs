// tools/arrange-screens-in-panes/do-work/read-pane-and-feel-settings.mjs
//
// The Workshop tool "Read the Panes and Feel settings": answers what a screen needs to draw the Panes section (the
// starting pane sizes and the settings rows a person edits) and the Feel section (the feels every moment plays, from
// tools/feel's rows). It reads the two DATA files this tool and tools/feel own and keeps nothing.
//
// Non-negotiable invariants
//   1. Nothing here names a pane, a setting or a feel: the DATA says them. This only reads and checks them.
//   2. Every moment names a feel the DATA defines; a moment that names an unknown feel is refused, never drawn.
//   3. The answer is the DATA as it stands: nothing is defaulted in code.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** The pane sizes DATA (this tool's own read-data-free file, next to do-work/). */
export const PANE_SIZES_PATH = join(HERE, '..', 'pane-sizes.json');
/** The feel rows DATA, owned by tools/feel. */
export const FEEL_ROWS_PATH = join(HERE, '..', '..', 'feel', 'records', 'feel-moments.json');

const read = path => JSON.parse(readFileSync(path, 'utf8'));

/** The runner calls fn(input, host); the input is empty and the DATA is read from its own files. */
export function readPaneAndFeelSettings(_input = {}) {
  return readPaneAndFeelSettingsFrom({ panes: PANE_SIZES_PATH, feel: FEEL_ROWS_PATH });
}

/** The Panes and Feel settings as the DATA states them: { panes: { defaults, sections }, feel: { outputs, feels, moments } }. */
export function readPaneAndFeelSettingsFrom(paths) {
  const panes = read(paths.panes);
  const feel = read(paths.feel);
  if (!panes || typeof panes.defaults !== 'object' || !Array.isArray(panes.sections)) {
    throw new Error('pane-sizes.json needs defaults (an object) and sections (a list).');
  }
  if (!feel || !Array.isArray(feel.moments) || typeof feel.feels !== 'object') {
    throw new Error('feel-moments.json needs moments (a list) and feels (an object).');
  }
  const unknown = feel.moments.filter(moment => !(moment?.feel in feel.feels)).map(moment => moment.i ?? moment.id ?? '?');
  if (unknown.length) throw new Error(`moments name a feel the DATA does not define: ${unknown.join(', ')}`);
  return {
    panes: { defaults: panes.defaults, sections: panes.sections },
    feel: { outputs: feel.outputs ?? [], feels: feel.feels, moments: feel.moments },
  };
}
