// tools/check-against-a-persons-rules-and-verdicts/do-work/piece-sweep.mjs
//
// Purpose
//   Whether every piece of a person's files is still covered by their checks. `sweepAtoms` is moved one to one from
//   old trillion's scripts/method-sources.mjs (lines 62-79): piece by piece, what changed or disappeared since it was
//   recorded (with the checks citing it), new pieces with no check and no reason, checks citing a piece the file no
//   longer has, and reasons pointing at checks that do not exist. `coverage` is that file's --coverage report over the
//   rows a person keeps (do-work/pieces.mjs `pieceRow`) instead of a sources file: per source file, its pieces, those
//   with a check, those with a reason, and the uncovered pieces by name.
//
// Non-negotiable invariants
//   1. A piece is covered when `checked_by` names check rows that all exist, or when `no_check.reason` is words and
//      every id its `covered_by` names (when given) is a row that exists. Anything else is uncovered, and counted.
//   2. A piece standing in two files counts in each file.
//   3. `coverageInRecords` reads the person's records only through the door it is handed, and only in bounded pages
//      (records:list, never one unbounded read): the ids of the Checks list (`fields: []`), then the piece rows by the
//      door's `where { kind: "piece" }` narrowed to the fields the coverage reads (never their text). Each page is folded
//      into a running tally (`coverageTally`) and let go, so what is held is a set of ids, each file's counts and at most
//      a bounded number of named pieces, never the list. It writes nothing. A list of 40,707 rows (39,088 pieces) is
//      read in a test under the heap of the row's container.
//   4. The answer fits the room a door gives a run's answer (`answer.most_bytes`, or the caller's `most_bytes`): every
//      count is whole, the files and named pieces are those that fit, and `next` is where the next page starts. A run
//      whose answer were larger would end with an unknown outcome, since the door carries the answer twice in one
//      65,536-byte message. Record types, bounds and words are DATA in read-data/pieces.json.
//
// Shapes
//   sweepAtoms(recorded, current, citing, allChecks) -> { count, with_check, with_reason, changed, gone, uncovered,
//     orphan_checks, missing_covered_by }
//   coverageTally(exists, { file?, after?, named? }) -> { add(piece), result() }       the running result
//   coverage(pieces, checks, { file?, after?, most_bytes? }) -> { status: "passed" | "failed", totals: { files, pieces,
//     with_check, with_reason, uncovered }, files: [{ file, pieces, with_check, with_reason, uncovered_count,
//     uncovered: [{ id, section, says }] }], missing_checks: [{ piece, check }], missing_covered_by: [{ piece, check }],
//     missing_count: { checks, covered_by }, lines, next }
//       Over every file (no `file`): files after `after` by name, each naming its first uncovered pieces by id.
//       For one `file`: that file, naming its uncovered pieces by id after `after`, as many as fit.
//   coverageInRecords(door, { file?, after?, most_bytes? }) -> coverage of the person's piece rows, read page by page
import SETTINGS from '../read-data/pieces.json' with { type: 'json' };

const fill = (template, values) => String(template).replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));

// Piece by piece: what changed since it was recorded, and what has neither a check nor a reason.
export function sweepAtoms(recorded, current, citing, allChecks) {
  const now = new Map(current.map(atom => [atom.key, atom]));
  const ids = new Set(allChecks.map(check => check.id));
  const cited = key => citing.filter(check => check.source.section === key).map(check => check.id);
  const changed = [], gone = [], uncovered = [], missing_covered_by = [];
  for (const [key, was] of Object.entries(recorded)) {
    const atom = now.get(key);
    if (!atom) gone.push({ key, checks: cited(key) });
    else if (atom.identity !== was.identity) changed.push({ key, checks: cited(key), no_check: was.no_check ?? null });
    for (const id of was.no_check?.covered_by ?? []) if (!ids.has(id)) missing_covered_by.push({ key, check: id });
  }
  for (const atom of current) if (!cited(atom.key).length && !recorded[atom.key]?.no_check) uncovered.push({ key: atom.key, new: !recorded[atom.key] });
  const orphan_checks = citing.filter(check => !now.has(check.source.section)).map(check => ({ check: check.id, section: check.source.section }));
  const with_check = current.filter(atom => cited(atom.key).length).length;
  const with_reason = current.filter(atom => !cited(atom.key).length && recorded[atom.key]?.no_check).length;
  return { count: current.length, with_check, with_reason, changed, gone, uncovered, orphan_checks, missing_covered_by };
}

// The running tally of a coverage: one piece folded in at a time, so a list of any size is read page by page and only
// counts, and at most `named` uncovered pieces of each file, are held. `exists(id)` says whether a check row exists.
// `file` (when given) keeps only that file; `after` then skips its uncovered pieces up to that id, so a caller pages
// through every uncovered piece of one file by id.
export function coverageTally(exists, { file: only = null, after = null, named = SETTINGS.answer.named_per_file } = {}) {
  const files = new Map();
  const missing_checks = [], missing_covered_by = [];
  const counts = { missing_checks: 0, missing_covered_by: 0, pieces: 0 };
  const fileOf = name => {
    if (!files.has(name)) files.set(name, { file: name, pieces: 0, with_check: 0, with_reason: 0, uncovered_count: 0, uncovered: [], after_count: 0 });
    return files.get(name);
  };
  const note = (list, key, item) => { counts[key] += 1; if (list.length < SETTINGS.answer.missing_at_most) list.push(item); };
  // The `named` uncovered pieces of a file with the smallest ids (after `after`), whatever order the pages come in.
  const name = (entry, item) => {
    if (after !== null && !(item.id > after)) return;
    entry.after_count += 1;
    const list = entry.uncovered;
    if (list.length >= named && !(item.id < list.at(-1).id)) return;
    let at = list.length;
    while (at > 0 && list[at - 1].id > item.id) at -= 1;
    list.splice(at, 0, item);
    if (list.length > named) list.pop();
  };
  return {
    add(piece) {
      if (!piece || typeof piece !== 'object') return;
      counts.pieces += 1;
      const checkedBy = Array.isArray(piece.checked_by) ? piece.checked_by : [];
      for (const id of checkedBy) if (!exists(id)) note(missing_checks, 'missing_checks', { piece: piece.id, check: id });
      const checked = checkedBy.length > 0 && checkedBy.every(id => exists(id));
      const reason = piece.no_check && typeof piece.no_check.reason === 'string' && piece.no_check.reason.trim() ? piece.no_check : null;
      const coveredBy = Array.isArray(reason?.covered_by) ? reason.covered_by : [];
      for (const id of coveredBy) if (!exists(id)) note(missing_covered_by, 'missing_covered_by', { piece: piece.id, check: id });
      const reasoned = !checked && reason !== null && coveredBy.every(id => exists(id));
      const sources = Array.isArray(piece.sources) && piece.sources.length ? piece.sources : [{ file: null, section: piece.key ?? null }];
      for (const source of sources) {
        const fileName = source?.file ?? SETTINGS.no_file;
        if (only !== null && fileName !== only) continue;
        const entry = fileOf(fileName);
        entry.pieces += 1;
        if (checked) entry.with_check += 1;
        else if (reasoned) entry.with_reason += 1;
        else { entry.uncovered_count += 1; name(entry, { id: piece.id, section: source?.section ?? piece.key ?? null, says: piece.says ?? null }); }
      }
    },
    result: () => ({ files: [...files.values()].sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0)), missing_checks, missing_covered_by, counts }),
  };
}

const bytes = value => Buffer.byteLength(JSON.stringify(value));

// The answer, within `most_bytes` of JSON: every count is whole (the totals, each file's counts, how many checks are
// missing), and the files shown and the pieces named are those that fit. `next` is the `after` of the next page, or null:
// over every file it is the last file shown; for one `file` it is the last uncovered piece named.
function answerOf({ files, missing_checks, missing_covered_by, counts }, { file, most_bytes, after } = {}) {
  const only = file ?? null;
  most_bytes ??= SETTINGS.answer.most_bytes;
  after ??= null;
  if (only !== null && !files.length) throw new PieceRefusal(fill(SETTINGS.words.no_such_file, { file: only }));
  const totals = files.reduce((sum, entry) => ({ files: sum.files + 1, pieces: sum.pieces + entry.pieces, with_check: sum.with_check + entry.with_check,
    with_reason: sum.with_reason + entry.with_reason, uncovered: sum.uncovered + entry.uncovered_count }), { files: 0, pieces: 0, with_check: 0, with_reason: 0, uncovered: 0 });
  const answer = { status: totals.uncovered ? 'failed' : 'passed', totals, files: [], missing_checks: [], missing_covered_by: [],
    missing_count: { checks: counts.missing_checks, covered_by: counts.missing_covered_by }, lines: [fill(SETTINGS.words.totals, totals)], next: null };
  let room = most_bytes - bytes(answer) - SETTINGS.answer.cursor_bytes;
  const take = (list, item, line) => {
    const cost = bytes(item) + 1 + bytes(line) + 1;
    if (cost > room) return false;
    room -= cost; list.push(item); answer.lines.push(line);
    return true;
  };
  for (const { uncovered, after_count: afterCount, ...counted } of only === null ? files.filter(entry => after === null || entry.file > after) : files) {
    const entry = { ...counted, uncovered: [] };
    if (!take(answer.files, entry, fill(SETTINGS.words.file, { ...entry, uncovered: entry.uncovered_count }))) {
      if (!answer.files.length) throw new PieceRefusal(fill(SETTINGS.words.too_little_room, { most_bytes }));
      answer.next = answer.files.at(-1).file;
      break;
    }
    for (const piece of uncovered) if (!take(entry.uncovered, piece, fill(SETTINGS.words.uncovered, { ...piece, file: entry.file }))) break;
    if (only !== null && entry.uncovered.length < afterCount) {
      if (!entry.uncovered.length) throw new PieceRefusal(fill(SETTINGS.words.too_little_room, { most_bytes }));
      answer.next = entry.uncovered.at(-1).id;
    }
  }
  for (const item of missing_checks) if (!take(answer.missing_checks, item, fill(SETTINGS.words.missing_check, item))) break;
  for (const item of missing_covered_by) if (!take(answer.missing_covered_by, item, fill(SETTINGS.words.missing_covered_by, item))) break;
  return answer;
}

/** Per source file: its pieces, with a check, with a reason, and uncovered by name; failed when any is uncovered. */
export function coverage(pieces, checks, options = {}) {
  const ids = new Set((checks ?? []).map(check => check?.id).filter(id => typeof id === 'string'));
  const tally = coverageTally(id => ids.has(id), { file: options.file ?? null, after: options.file == null ? null : options.after ?? null, named: options.named ?? Infinity });
  for (const piece of pieces ?? []) tally.add(piece);
  return answerOf(tally.result(), options);
}

// What a page of piece rows carries: never the text, which the coverage does not read.
const PIECE_FIELDS = ['kind', 'checked_by', 'no_check', 'sources', 'says', 'key'];

/**
 * The coverage of the person's own piece rows, read through `door` (read only), page after page: first the ids of
 * every row of the Checks list (`fields: []`, ids only), then the piece rows (`where { kind: "piece" }`, narrowed to
 * the fields the coverage reads), each folded into the running tally and let go.
 */
export async function coverageInRecords(door, options = {}) {
  const ids = new Set();
  for await (const record of door.list({ type: SETTINGS.check_type, fields: [] })) {
    if (typeof record?.id === 'string' && record.id.startsWith(SETTINGS.record_prefix)) ids.add(record.id.slice(SETTINGS.record_prefix.length));
  }
  const named = options.file == null ? SETTINGS.answer.named_per_file : SETTINGS.answer.named_in_one_file;
  const tally = coverageTally(id => typeof id === 'string' && ids.has(id), { file: options.file ?? null, after: options.file == null ? null : options.after ?? null, named });
  for await (const record of door.list({ type: SETTINGS.check_type, where: { [SETTINGS.kind_field]: SETTINGS.piece_kind }, fields: PIECE_FIELDS })) {
    const value = record?.value;
    if (value && typeof value === 'object' && value[SETTINGS.kind_field] === SETTINGS.piece_kind && typeof record.id === 'string') {
      tally.add({ ...value, id: record.id.slice(SETTINGS.record_prefix.length) });
    }
  }
  const result = tally.result();
  if (!result.counts.pieces) throw new PieceRefusal(SETTINGS.words.no_pieces);
  return answerOf(result, options);
}

export class PieceRefusal extends Error {}
