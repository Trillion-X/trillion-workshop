// ---- Where a line's words come from: the recording spans its piece already cites (readers.json spoken_spans) ----------
const ROOT = join(here, '..', '..');
const fold = foldWith(JSON.parse(readFileSync(VERDICT_RULES, 'utf8')).fold);
let spokenRows = null;   // the spoken_spans tsv, read once
const tsvRows = () => {
  if (spokenRows) return spokenRows;
  const { path, clip, from, to, text } = readers.spoken_spans.tsv;
  const [head, ...lines] = readFileSync(join(ROOT, path), 'utf8').split('\n');
  const at = name => head.split('\t').indexOf(name);
  const number = cell => (cell === undefined || cell === '' ? null : Number(cell));
  spokenRows = lines.map(line => line.split('\t')).map(cells => ({ clip: cells[at(clip)], from: number(cells[at(from)]), to: number(cells[at(to)]), text: cells[at(text)] ?? '' }));
  return spokenRows;
};

/** The recording spans the plan named by a piece's `cites_plan` line cites (none when it names no plan). */
export function citedSpans(sourceText) {
  const pattern = new RegExp(readers.spoken_spans.cites_plan);
  const named = sourceText.split('\n').map(line => pattern.exec(line)).find(Boolean);
  return named ? spansOfPlan(named[1]) : [];
}

/** His words in one recording span: the clip's word lists inside from-to (padded), then the moment rows that overlap it. */
function spanText({ clip, from = null, to = null }) {
  const spoken = readers.spoken_spans, pad = spoken.pad_s;
  const inside = (start, end) => (from === null ? true : start !== null && end !== null && start >= from - pad && end <= to + pad);
  const overlaps = row => (from === null ? row.from === null : row.from !== null && row.from < to && row.to > from);
  const words = spoken.words_json.map(template => join(ROOT, template.replace('{clip}', clip))).filter(existsSync)
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
