// src/media-tools.mjs
//
// Cut suggestions for one recording, as values. The recording's words (with word times) and the cut suggestions already
// kept for it are handed in; the answer is the suggestion's lines and proposals, and `keep`: the entries the caller keeps
// (the store's own write), so a later ask with the same mode and words answers from them.
//
// Browsing the Media library (list_media) and the next edit (next_media_edit) are not here: the browse is workflow
// recipe workflow:browse-my-recordings-and-media, and the next edit is read by its owner.
import { autoEditLines } from '../../media-composition/read-data/auto-edit.mjs';
import editRules from '../../media-composition/read-data/suggestion-stream.json' with { type: 'json' };

export async function suggestMediaCuts({ identity, mode, transcript = null, kept = {} } = {}) {
  if (typeof identity !== 'string' || !/^(1f|12):[0-9a-f]{64}$/u.test(identity)) throw new Error('Name the recording by its content identity (1f: then 64 hex).');
  const keep = {};
  const cache = { get: id => kept[id], set: (id, entry) => { keep[id] = entry; } };
  const lines = [];
  for await (const line of autoEditLines({ identity, mode, transcript, cache })) lines.push(line);
  const done = lines.find(line => line.type === 'complete');
  return { identity, mode, modes: Object.keys(editRules.modes), lines, proposals: done?.proposals ?? [], keep };
}
