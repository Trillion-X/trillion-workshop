// tools/media-composition/read-data/suggestion-stream.mjs (moved from Trillion-X/trillion parts/media-composition/read-data/suggestion-stream.mjs)
//
// A SUGGESTION ARRIVES AS TYPED LINES THE PERSON CAN WATCH, STOPS WHEN ASKED, AND IS KEPT FOR THE ALGORITHM THAT MADE IT.
//
// Purpose: an AI suggestion over a record (cuts in a recording, a tidy of files, tasks from a message) can take a while. It is
// streamed as one JSON object per line: what it is doing (`status`), what it is thinking (`thinking`), then either the proposals
// as data the person can apply or restore (`complete`) or a typed ending (`error`). A finished suggestion is kept by what it was
// made from and how it was asked for, together with the algorithm's version, so asking again is free until the algorithm changes.
//
// Non-negotiable invariants:
//   1. The line types, their required fields, the error codes and the words are DATA (./suggestion-stream.json).
//   2. A cache entry is read only when its algorithm_version equals the current one; an older answer is never shown as current.
//   3. Proposals are data, never applied here. An empty list is the typed ending NO_PROPOSALS, not an empty success.
//   4. A suggestion that is stopped (its `signal`) ends in ABORTED and keeps nothing; a producer that throws ends in FAILED.
//   5. Pure with respect to storage and time: the cache and the producer are handed in.
//
// Cache: { get(id) -> { algorithm_version, proposals } | undefined, set(id, entry) }, each may be async.
import rules from './suggestion-stream.json' with { type: 'json' };

/** One line as text, checked against the DATA's shape. Throws on a type the DATA does not name or a missing field. */
export function encodeSuggestionLine(line, settings = rules) {
  const shape = settings.lines[line?.type];
  if (!shape) throw new Error(`unknown suggestion line type ${String(line?.type)}`);
  for (const field of shape.required) if (line[field] === undefined) throw new Error(`a ${line.type} line needs ${field}`);
  return `${JSON.stringify(line)}\n`;
}

/** Lines out of streamed text. A last line not yet ended is held back (`rest`); an unreadable or unknown line is reported, not dropped silently. */
export function decodeSuggestionLines(text, settings = rules) {
  const parts = text.split('\n');
  const rest = parts.pop();
  const lines = [];
  const unreadable = [];
  for (const part of parts) {
    if (!part.trim()) continue;
    try {
      const line = JSON.parse(part);
      const shape = settings.lines[line?.type];
      if (!shape || shape.required.some((field) => line[field] === undefined)) throw new Error('shape');
      lines.push(line);
    } catch { unreadable.push(part); }
  }
  return { lines, rest, unreadable };
}

/** The key a finished suggestion is kept under. */
export const suggestionId = ({ input, mode }) => `${input}:${mode}`;

/**
 * Makes the suggestion for `input` in `mode`, as lines. `produce({ input, mode, settings, signal })` is an async iterable of
 * `status`/`thinking` lines that returns (or finally yields a `complete` line with) the proposals.
 */
export async function* runSuggestion({ input, mode, algorithm_version, produce, cache, signal }, settings = rules) {
  const id = suggestionId({ input, mode });
  const error = (code) => ({ type: 'error', code, message: settings.errors[code] });
  const kept = await cache.get(id);
  if (kept && kept.algorithm_version === algorithm_version) { yield { type: 'complete', proposals: kept.proposals, cached: true }; return; }
  yield { type: 'status', message: settings.words.working };
  let proposals = null;
  try {
    for await (const line of produce({ input, mode, settings: settings.modes[mode], signal })) {
      if (signal?.aborted) { yield error('ABORTED'); return; }
      if (line.type === 'complete') { proposals = line.proposals; break; }
      yield line;
    }
  } catch { yield error(signal?.aborted ? 'ABORTED' : 'FAILED'); return; }
  if (signal?.aborted) { yield error('ABORTED'); return; }
  if (!Array.isArray(proposals) || proposals.length === 0) { yield error('NO_PROPOSALS'); return; }
  await cache.set(id, { algorithm_version, proposals });
  yield { type: 'complete', proposals, cached: false };
}
