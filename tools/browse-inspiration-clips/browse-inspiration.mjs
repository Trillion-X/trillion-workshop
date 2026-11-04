// tools/browse-inspiration-clips/browse-inspiration.mjs
//
// Inspiration as one run: inspiration.mjs inspiration, unchanged, over the source answers handed in. Each source
// inspiration.json names (pick, library, recent, formats, examples, posts) is read once from `sources`; each row keeps
// the items its tests pass and turns them into cards, with the layouts and card actions the screen draws them with.
//
//   browseInspiration({ sources }) -> { layouts, default_layout, view_all_layout, card_actions, pick_actions, aspects,
//                                       empty, sections: [{ id, title, subtitle?, total, cards, failed? }], said }
//     sources  { <source name>: the answer that source gives } (pick: { pick: { clips, title?, reason? } },
//              library: { rows }, recent: { items }, formats: { formats }, examples: { examples }, posts: { posts })
//   A card is { id, source, section, title?, summary?, detail?, at?, file?, duration?, opens, edit? }; edit is true for
//   a clip that could go into a new edit.
//
// A source left out of `sources` marks its own rows failed (saying it was not given); the other rows are unchanged.
// Refuses: sources that is not an object, and a source name inspiration.json does not hold (naming the ones it does).
//
// What the run never does: it reads no files or records itself (every card is an item handed in), opens no card and
// starts no edit (Make this and Edit these are the screen's actions), and writes nothing.
import settings from './inspiration.json' with { type: 'json' };
import { inspiration } from './inspiration.mjs';

const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export async function browseInspiration({ sources } = {}) {
  const names = Object.keys(settings.sources);
  if (!object(sources)) throw new Error(`Give sources: { <source>: its answer }, the sources being ${names.join(', ')}.`);
  for (const name of Object.keys(sources)) {
    if (!names.includes(name)) throw new Error(`There is no source ${JSON.stringify(name)}; the sources are ${names.join(', ')}.`);
  }
  const read = Object.fromEntries(names.map(name => [name, async () => {
    if (!Object.hasOwn(sources, name)) throw new Error(`${name} was not given.`);
    return sources[name];
  }]));
  return inspiration(read);
}
