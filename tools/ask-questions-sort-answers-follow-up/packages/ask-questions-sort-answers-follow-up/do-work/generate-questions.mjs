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
// swapping in an AI generator is changing the runner's process_descriptor argv, i.e.
// DATA, never this file). Pure functions are exported for tests; the CLI guard runs
// it as a node process over JSON files exactly how the runner invokes it.
//
//   argv: --content <text-file> --out <records-json> [--max <n>] [--source-ref <ref>]
//   out:  { "records": [ { id, kind:"question", questionId, questionTypeId, label,
//                          required, answer, sourceRef } ] }

import { readFileSync, writeFileSync } from 'node:fs';

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

// ---- CLI (the form the runner dispatches via `ask compute.process`) ----
function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function main() {
  const contentPath = argValue('--content');
  const outPath = argValue('--out');
  if (!contentPath || !outPath) {
    process.stderr.write('usage: generate-questions --content <text-file> --out <records-json> [--max <n>] [--source-ref <ref>]\n');
    process.exit(2);
  }
  const text = readFileSync(contentPath, 'utf8');
  const max = Number(argValue('--max') ?? 8);
  const sourceRef = argValue('--source-ref') ?? '';
  const records = generateQuestions(text, { max, sourceRef });
  writeFileSync(outPath, JSON.stringify({ records }));
  process.exit(0);
}

// Run only when invoked directly (argv[1] is this script); a test IMPORT does not.
if (process.argv[1] && /generate-questions\.mjs$/.test(process.argv[1])) {
  main();
}
