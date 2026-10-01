// packages/ask-questions-sort-answers-follow-up/do-work/generate-questions.mjs
//
// The missing UPSTREAM transform for the ask/recall loop: content text -> recall
// QuestionDescriptor records. The package already CONSUMES questions (fill handler
// over the open question-type-capability registry); this generates them. It is a
// `run-a-job-on-your-stuff` transform — a PROCESS the generic runner dispatches
// (read content -> run this -> validate against the output_contract -> write the
// admitted question records). No domain logic leaks into the runner.
//
// Deterministic + dependency-free (the L078 FLOOR — an extractive cloze baseline;
// swapping in an AI generator is changing the tool row's argv, i.e. DATA, never
// this file). Pure functions are exported for tests.
//
//   argv[2]: { "text": "...", "max": <n>, "source_ref": "<ref>" }
//   out:     { "questions": [ { id, kind:"question", questionId, questionTypeId, label,
//                              required, answer, sourceRef } ] }

/** Words too common to be a useful cloze blank (a small, generic stoplist). */
const STOPWORDS = new Set([
  'about', 'above', 'after', 'again', 'against', 'their', 'there', 'these', 'those',
  'which', 'while', 'would', 'could', 'should', 'because', 'between', 'through',
  'where', 'being', 'every', 'other', 'these', 'still', 'never', 'always', 'often',
  'thing', 'things', 'something', 'someone', 'people', 'really',
]);

/** Split text into trimmed sentences (>= 20 chars to skip fragments). */
export function splitSentences(text) {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 20);
}

/** Tiny deterministic string hash (djb2) — stable question ids without Date/random. */
function hash(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i += 1) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/** The most "significant" word to blank: the longest alphabetic token (>= 5 chars)
 *  that is not a stopword. Returns null when the sentence has none. */
export function keyWord(sentence) {
  const tokens = sentence.match(/\b[A-Za-z][A-Za-z'-]{4,}\b/g) ?? [];
  let best = null;
  for (const t of tokens) {
    if (STOPWORDS.has(t.toLowerCase())) continue;
    if (!best || t.length > best.length) best = t;
  }
  return best;
}

/** Turn one sentence into a recall QuestionDescriptor (a cloze when a key word
 *  exists, else a free-recall prompt). questionTypeId `text` resolves against the
 *  open question-type-capability registry (NOT an enum here). */
export function questionFromSentence(sentence, index, sourceRef) {
  const word = keyWord(sentence);
  const questionId = `q-${index}-${hash(sentence)}`;
  if (word) {
    const label = sentence.replace(word, '_____');
    return { id: questionId, kind: 'question', questionId, questionTypeId: 'text', label, required: true, answer: word, sourceRef };
  }
  return { id: questionId, kind: 'question', questionId, questionTypeId: 'text', label: `Recall: ${sentence}`, required: true, answer: '', sourceRef };
}

/** Generate up to `max` recall questions from content text. Pure + deterministic. */
export function generateQuestions(text, { max = 8, sourceRef = '' } = {}) {
  return splitSentences(text).slice(0, max).map((s, i) => questionFromSentence(s, i, sourceRef));
}

// ---- The Workshop tool "Make quiz questions from a piece of text" ----
// argv[2] is one JSON input: { text, max?, source_ref? }. Prints one JSON line: { questions }.
if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const { text, max = 8, source_ref: sourceRef = '' } = JSON.parse(process.argv[2] ?? '{}');
    if (typeof text !== 'string' || !text.trim()) throw new Error('text must be the words to make questions from.');
    process.stdout.write(`${JSON.stringify({ questions: generateQuestions(text, { max: Number(max), sourceRef: String(sourceRef) }) })}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
