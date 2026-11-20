// read-data/filing-refusal.mjs
//
// PURPOSE
//   A thing filed on the person's own Waiting on you list is refused when it gives them nothing to press or do
//   (invariant 7 of needs-you-hold.mjs, `controlOf`): a row that reaches the person with no control is a row no one can
//   finish. The refusal says what the row needs, so the AI that filed it fixes it (gives it the place where it is done,
//   a press, or steps) or does the thing itself. Marking a row done is never refused.
//
//   The words are DATA (`hold.no_control` in the Waiting on you config). The config (list, sources, sections, finishes)
//   is the caller's: this module keeps none of it. Only the refusal rule is here; nothing calls it on a filing path yet
//   (switching it on waits for the owner's word, question 32 of the short list).
//
// NON-NEGOTIABLE INVARIANTS
//   1. Blind: the list, its source, its section and the words are read from the config the caller passes; no name of a
//      list, source or screen is written here.
//   2. Marking a row done is never refused (`done_sets.values` on its source).
//   3. A place that is a whole narrowable screen is never the one thing to do, even with a control beside it
//      (`whole_screen`), and a place that is not a the app screen is refused (`not_a_screen`).

import { cardFieldsOf } from '../../workspace-screens/web/src/card-sections.mjs';
import { controlOf } from './needs-you-hold.mjs';

const fill = (template, values) => String(template ?? '').replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));

// The person's own list's source and section: the source whose finishing sets a row of that list.
function ownSource(config) {
  const name = Object.keys(config.sources ?? {}).find(key => config.sources[key].done_sets?.list === config.list?.id);
  return name ? { name, source: config.sources[name], section: (config.sections ?? []).find(row => row.read?.from === name) } : null;
}

/** Why a row filed on the person's own list (`config.list`) would reach them with no control, in the config's words
 *  (`hold.no_control.refused`, `whole_screen`, `not_a_screen`), or null when it has one or is being marked done. The row
 *  is read the way its source reads it (`cardFieldsOf`) and finished the way its section finishes it. `opensScreen`
 *  says whether an address opens a the app screen; `opensWhole` whether that screen is a whole narrowable one. */
export function rowControlRefusal(config, values, opensScreen = () => true, opensWhole = () => false) {
  const { source, section } = ownSource(config) ?? {};
  if (!source || !section) return null;
  if (Object.entries(source.done_sets.values ?? {}).every(([field, value]) => values?.[field] === value)) return null;
  const card = cardFieldsOf(source, { id: '', values: values ?? {} });
  const address = typeof card.does_in === 'string' ? card.does_in.trim() : '';
  if (address && opensScreen(address) && opensWhole(address)) {
    return fill(config.hold.no_control.whole_screen, { title: card.title ?? '', address, path: address.split(/[?#]/)[0] });
  }
  if (controlOf(config, section, card, opensScreen)) return null;
  const words = config.hold.no_control;
  return fill(address ? words.not_a_screen : words.refused, { title: card.title ?? '', address });
}
