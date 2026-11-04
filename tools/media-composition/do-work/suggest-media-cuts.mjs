// tools/media-composition/do-work/suggest-media-cuts.mjs
//
// The container run of tool:suggest-media-cuts: a recording's kept transcript (handed in, segments with timed words) becomes
// cut proposals through read-data/auto-edit.mjs, as the typed lines it streams. The container keeps nothing: the caller hands
// in the answer it kept earlier (`kept`, { algorithm_version, proposals }) and gets back the one to keep (`keep`), so the
// cache stays per (recording, mode, algorithm version) in the caller's own records.
//
//   suggestMediaCuts({ identity, mode, transcript, kept? }) -> { lines, keep: { id, entry } | null, modes }
import { autoEditLines } from '../read-data/auto-edit.mjs';
import { suggestionId } from '../read-data/suggestion-stream.mjs';
import stream from '../read-data/suggestion-stream.json' with { type: 'json' };

export async function suggestMediaCuts({ identity, mode, transcript, kept = null }) {
  const id = suggestionId({ input: identity, mode });
  let keep = null;
  const cache = { get: () => kept ?? undefined, set: (key, entry) => { keep = { id: key, entry }; } };
  const lines = [];
  for await (const line of autoEditLines({ identity, mode, transcript, cache })) lines.push(line);
  return { id, lines, keep, modes: Object.keys(stream.modes) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { text } = await import('node:stream/consumers');
  const input = JSON.parse((await text(process.stdin)) || '{}');
  console.log(JSON.stringify({ result: await suggestMediaCuts(input) }));
}
