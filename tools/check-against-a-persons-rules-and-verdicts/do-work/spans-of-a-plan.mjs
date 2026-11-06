// tools/check-against-a-persons-rules-and-verdicts/do-work/spans-of-a-plan.mjs
//
// Purpose
//   Where a line's words come from: the recording spans its piece already cites. A piece whose plan line (the person's
//   `spoken_spans.cites_plan` pattern) names a plan is bound to that plan's segments that cite a recording (`clip`,
//   `from`, `to`); each span's text is the words said in it: the clip's word lists (`spoken_spans.words_json`, with
//   {clip}) inside from-to, padded by `pad_s`, then the moment rows (a tab-separated table, `spoken_spans.tsv`) whose
//   times overlap it. An untimed segment reads the clip's whole word list and its untimed rows. do-work/spoken-origins.mjs
//   then marks each line own-words (in the person's own origin word), unverified-speaker or added-words from these spans.
//   Moved from source-repo-a tools/copy-gate/check.mjs (tsvRows, citedSpans, spanText, spansOfPlan) one to one;
//   what changed is that the person's settings and their files (the plan, the word lists, the table, by the names the
//   settings and the plan give them) are handed in with `holding`, so this file reads no file and holds no path.
//
// Non-negotiable invariants
//   1. A span's text is only words the files handed in hold: nothing is guessed or filled in. A word list that was not
//      handed in is absent; a plan that was not handed in is refused (code ENOENT), never guessed.
//   2. A segment whose `speaker` matches `spoken_spans.speaker_unverified` gives a span with speaker_verified false, so
//      its words are judged as added words, never softened.
//   3. A segment whose line joins two spans names the second in `also` (one span or a list); its text is the segment's
//      span, then each `also` span in order, so a line made of both is the person's words only in that order.
//
// Shapes
//   holding({ settings, files })  settings: { spoken_spans: { cites_plan, words_json: [template], tsv: { path, clip, from,
//                                 to, text }, pad_s, speaker_unverified } }   files: { <name>: <text> }
//   citedSpans(sourceText)        -> the spans of the plan a piece's plan line names, or []
//   spansOfPlan(name)             -> [{ clip, from, to, speaker_verified, text }]
let readers = {}, held = {};
/** Hold the person's settings and their files (by name) for the reads that follow. */
export function holding({ settings = {}, files = {} } = {}) {
  readers = settings;
  held = files;
  spokenRows = null;
}
const join = (...parts) => parts.filter(Boolean).join('/');
const isAbsolute = () => false;   // a name is as the settings or the plan give it, looked up among the files handed in
const existsSync = name => typeof held[name] === 'string';
function readFileSync(name) {
  if (!existsSync(name)) throw Object.assign(new Error(`${name} was not handed in`), { code: 'ENOENT' });
  return held[name];
}

// ---- Where a line's words come from: the recording spans its piece already cites (readers.json spoken_spans) ----------
const ROOT = '';
let spokenRows = null;   // the spoken_spans tsv, read once
const tsvRows = () => {
  if (spokenRows) return spokenRows;
  if (!readers.spoken_spans.tsv || !existsSync(join(ROOT, readers.spoken_spans.tsv.path))) return (spokenRows = []);
  const { path, clip, from, to, text } = readers.spoken_spans.tsv;
  const [head, ...lines] = readFileSync(join(ROOT, path), 'utf8').split('\n');
  const at = name => head.split('\t').indexOf(name);
  const number = cell => (cell === undefined || cell === '' ? null : Number(cell));
  spokenRows = lines.map(line => line.split('\t')).map(cells => ({ clip: cells[at(clip)], from: number(cells[at(from)]), to: number(cells[at(to)]), text: cells[at(text)] ?? '' }));
  return spokenRows;
};

/** The recording spans the plan named by a piece's `cites_plan` line cites (none when it names no plan). */
export function citedSpans(sourceText) {
  if (!readers.spoken_spans) return [];
  const pattern = new RegExp(readers.spoken_spans.cites_plan);
  const named = sourceText.split('\n').map(line => pattern.exec(line)).find(Boolean);
  return named ? spansOfPlan(named[1]) : [];
}

/** His words in one recording span: the clip's word lists inside from-to (padded), then the moment rows that overlap it. */
function spanText({ clip, from = null, to = null }) {
  const spoken = readers.spoken_spans, pad = spoken.pad_s ?? 0;
  const inside = (start, end) => (from === null ? true : start !== null && end !== null && start >= from - pad && end <= to + pad);
  const overlaps = row => (from === null ? row.from === null : row.from !== null && row.from < to && row.to > from);
  const words = (spoken.words_json ?? []).map(template => join(ROOT, template.replace('{clip}', clip))).filter(existsSync)
    .flatMap(file => JSON.parse(readFileSync(file, 'utf8')).words ?? []).filter(word => inside(word.start, word.end)).map(word => word.text);
  const rows = tsvRows().filter(row => row.clip === clip && overlaps(row)).map(row => row.text);
  return [words.join(' '), ...rows].join('\n');
}

/**
 * The recording spans a plan (absolute or repository-relative path) cites, each { clip, from, to, speaker_verified, text }: his words in it.
 * A segment whose line joins two of his spans names the second in `also` (one span or a list); its text is the segment's span, then each
 * `also` span in order, so a line made of both is still his words when they come in that order.
 */
export function spansOfPlan(planPath) {
  const plan = JSON.parse(readFileSync(isAbsolute(planPath) ? planPath : join(ROOT, planPath), 'utf8'));
  const unverified = new RegExp(readers.spoken_spans.speaker_unverified);
  return (plan.segments ?? []).filter(segment => segment.clip).map(({ clip, from = null, to = null, speaker, also = [] }) => ({
    clip, from, to, speaker_verified: !(typeof speaker === 'string' && unverified.test(speaker)),
    text: [{ clip, from, to }, ...[also].flat()].map(spanText).join('\n'),
  }));
}
