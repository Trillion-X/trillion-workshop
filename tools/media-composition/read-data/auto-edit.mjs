// tools/media-composition/read-data/auto-edit.mjs (moved from Trillion-X/trillion parts/media-composition/read-data/auto-edit.mjs)
//
// A RECORDING'S KEPT WORDS BECOME CUT PROPOSALS, STREAMED AS TYPED LINES, KEPT PER (RECORDING, MODE, ALGORITHM VERSION).
//
// Purpose: the transcript a recording keeps (src/transcript-words.mjs: segments with timed words) is read, the cleanup engine
// (./auto-cleanup.ts detectCleanupSpans) finds the spans to cut for the asked mode, and each is announced the way every other
// suggestion is (./suggestion-stream.mjs): status, thinking, then `complete` with the proposals or a typed ending. A recording
// with no timed words ends in NO_TRANSCRIPT, a transcript with nothing to cut in NO_PROPOSALS: never an empty success.
//
// Non-negotiable invariants:
//   1. The modes, the fillers, the proposal kind, the version and the words are DATA (./auto-edit.json, ./suggestion-stream.json).
//   2. Proposals are data (spans in seconds of the recording's own time); nothing is applied or rendered here.
//   3. Pure with respect to storage: the transcript, the cache and the stop signal are handed in.
//   4. A transcript is read once per ask, capped at `most_words` timed words; the ones past the cap are not read.
//
// Key concepts:
//   timedWords(transcript) -> [{ text, start, end }]
//   autoEditLines({ identity, mode, transcript, cache, signal }) -> async iterable of typed lines
//   autoEditText(args) -> async iterable of newline-ended JSON text, ready to stream as the body of a response
import { detectCleanupSpans, cleanupSpansInAuthorOrder } from './auto-cleanup.ts';
import { encodeSuggestionLine, runSuggestion } from './suggestion-stream.mjs';
import suggestionRules from './suggestion-stream.json' with { type: 'json' };
import rules from './auto-edit.json' with { type: 'json' };

const fill = (template, values) => template.replace(/\{(\w+)\}/gu, (whole, name) => (name in values ? String(values[name]) : whole));
const finite = value => typeof value === 'number' && Number.isFinite(value);

/** The timed words of a kept transcript, in order, as { text, start, end }; a segment without word times gives none. */
export function timedWords(transcript, settings = rules) {
  const words = [];
  for (const segment of Array.isArray(transcript?.segments) ? transcript.segments : []) {
    for (const word of Array.isArray(segment?.words) ? segment.words : []) {
      if (words.length >= settings.most_words) return words;
      const text = String(word?.word ?? word?.text ?? '').trim();
      if (text && finite(word?.start) && finite(word?.end) && word.end >= word.start) words.push({ text, start: word.start, end: word.end });
    }
  }
  return words;
}

async function* produce({ words, mode, modeSettings, settings }) {
  yield { type: 'status', message: fill(settings.words.reading, { count: words.length }) };
  const spans = cleanupSpansInAuthorOrder(detectCleanupSpans(words, { ...modeSettings, fillers: settings.fillers }));
  const seconds = Math.round(spans.reduce((sum, span) => sum + (span.end - span.start), 0) * 100) / 100;
  yield { type: 'thinking', text: fill(settings.words.found, { spans: spans.length, seconds }) };
  yield { type: 'complete', proposals: spans.map(span => ({ kind: settings.proposal_kind, start: span.start, end: span.end, reason: span.reason, mode })) };
}

/** The typed lines of one ask. An unknown mode is a FAILED ending, never a guess at another mode. */
export async function* autoEditLines({ identity, mode, transcript, cache, signal }, settings = rules, stream = suggestionRules) {
  const error = code => ({ type: 'error', code, message: stream.errors[code] });
  const words = timedWords(transcript, settings);
  if (!words.length) { yield error('NO_TRANSCRIPT'); return; }
  if (!Object.hasOwn(stream.modes, mode)) { yield error('FAILED'); return; }
  yield* runSuggestion({
    input: identity, mode, algorithm_version: settings.algorithm_version, cache, signal,
    produce: ({ mode: asked, settings: modeSettings }) => produce({ words, mode: asked, modeSettings, settings }),
  }, stream);
}

/** The same lines as newline-ended JSON text, each checked against the line DATA before it leaves. */
export async function* autoEditText(args, settings = rules, stream = suggestionRules) {
  for await (const line of autoEditLines(args, settings, stream)) yield encodeSuggestionLine(line, stream);
}
