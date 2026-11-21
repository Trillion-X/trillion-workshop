// tools/media-composition/do-work/suggest-media-cuts.mjs
//
// The container run of tool:suggest-media-cuts: a recording's kept transcript (handed in, segments with timed words) becomes
// cut proposals through read-data/auto-edit.mjs, as the typed lines it streams. The container keeps nothing: the caller hands
// in the answer it kept earlier (`kept`, { algorithm_version, proposals }) and gets back the one to keep (`keep`), so the
// cache stays per (recording, mode, algorithm version) in the caller's own records.
//
//   suggestMediaCuts({ identity, mode, transcript | transcript_file, kept? }) -> { lines, keep: { id, entry } | null, modes }
// `transcript_file` is the local path of a transcript the hearing tool kept in Files ({ segments: timed words }), placed in
// the run's folder by the engine from its identity, so a long recording's words never ride in a step's answer.
import { autoEditLines } from '../read-data/auto-edit.mjs';
import { suggestionId } from '../read-data/suggestion-stream.mjs';
import { pathToFileURL } from 'node:url';
import { readFileSync, realpathSync } from 'node:fs';
import stream from '../read-data/suggestion-stream.json' with { type: 'json' };

/** The transcript a kept transcript file holds, as timed words in one segment: { segments: [{ words }] }. */
export function transcriptOfFile(file) {
  const kept = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(kept?.segments)) throw new Error('The transcript file has no segments.');
  return { segments: [{ words: kept.segments }] };
}

export async function suggestMediaCuts({ identity, mode, transcript = null, transcript_file: transcriptFile = null, kept = null }) {
  if (!transcript && transcriptFile) transcript = transcriptOfFile(transcriptFile);
  const id = suggestionId({ input: identity, mode });
  let keep = null;
  const cache = { get: () => kept ?? undefined, set: (key, entry) => { keep = { id: key, entry }; } };
  const lines = [];
  for await (const line of autoEditLines({ identity, mode, transcript, cache })) lines.push(line);
  return { id, lines, keep, modes: Object.keys(stream.modes) };
}

if (import.meta.url === (process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : '')) {
  const { text } = await import('node:stream/consumers');
  const input = JSON.parse((await text(process.stdin)) || '{}');
  console.log(JSON.stringify({ result: await suggestMediaCuts(input) }));
}
