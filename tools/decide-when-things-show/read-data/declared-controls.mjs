// parts/ui/show/show-rules/declared-controls.mjs
//
// PURPOSE
//   Every control Trillion draws, as its parts declare it: one row { id, label, parent? } per dotted path a part names in
//   its part.json `controls`, and one per open choice (`open.<id>`, placeable-surface-intent/open-choices.json). The
//   person store hands this list out with the show rules (src/show-rules-store.mjs `controls`), so the rules screen and
//   an AI pick a control, or everything inside one, by its words, and `parent` nests each under the path it sits in.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Nothing here names a control: the manifests below say them. A manifest that declares controls and is not read
//      here fails test/show-types-and-controls.test.mjs, so a new part's controls cannot go missing from the picker.
//   2. `parent` is the nearest declared path a control sits in (`record.action` for `record.action.delete`), or absent
//      at the top, so the list is a tree however deep the paths go.
//   3. A path is declared once; the first declaration's words are kept.

import arrangement from '../../../screen-arrangement/part.json' with { type: 'json' };
import palette from '../../../command-palette/part.json' with { type: 'json' };
import sidebar from '../../../sidebar/part.json' with { type: 'json' };
import ui from '../../part.json' with { type: 'json' };
import openChoices from '../placeable-surface-intent/open-choices.json' with { type: 'json' };

const rows = [
  ...[sidebar, arrangement, palette, ui].flatMap(manifest => manifest.controls ?? []),
  ...openChoices.choices.map(choice => ({ id: `open.${choice.id}`, label: choice.label })),
];

const words = new Map();
for (const row of rows) if (typeof row.id === 'string' && !words.has(row.id)) words.set(row.id, row.label ?? row.id);

/** The nearest declared path `id` sits in, or undefined at the top. */
function parentOf(id) {
  for (let cut = id.lastIndexOf('.'); cut > 0; cut = id.lastIndexOf('.', cut - 1)) {
    const path = id.slice(0, cut);
    if (words.has(path)) return path;
  }
  return undefined;
}

/** Every declared control, in declaration order: { id, label, parent? }. */
export const DECLARED_CONTROLS = Object.freeze([...words].map(([id, label]) => {
  const parent = parentOf(id);
  return Object.freeze({ id, label, ...(parent ? { parent } : {}) });
}));
