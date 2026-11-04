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
//      every id its `covered_by` names (when given) is a row that exists. Anything else is uncovered, and named.
//   2. A piece standing in two files counts in each file.
//   3. `coverageInRecords` reads the person's records only through the door it is handed: the piece rows by the door's
//      `where { kind: "piece" }`, never the whole list, then each check row a piece names, one read each. It writes
//      nothing. Record types and words are DATA in read-data/pieces.json.
//
// Shapes
//   sweepAtoms(recorded, current, citing, allChecks) -> { count, with_check, with_reason, changed, gone, uncovered,
//     orphan_checks, missing_covered_by }
//   coverage(pieces, checks) -> { status: "passed" | "failed", files: [{ file, pieces, with_check, with_reason,
//     uncovered: [{ id, section, says }] }], missing_checks: [{ piece, check }], missing_covered_by: [{ piece, check }],
//     lines }
//   coverageInRecords(door) -> coverage(the person's piece rows, the check rows they name)
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

/** Per source file: its pieces, with a check, with a reason, and uncovered by name; failed when any is uncovered. */
export function coverage(pieces, checks) {
  const ids = new Set((checks ?? []).map(check => check?.id).filter(id => typeof id === 'string'));
  const missing_checks = [], missing_covered_by = [];
  const files = new Map();
  const fileOf = name => {
    if (!files.has(name)) files.set(name, { file: name, pieces: 0, with_check: 0, with_reason: 0, uncovered: [] });
    return files.get(name);
  };
  for (const piece of pieces ?? []) {
    const named = Array.isArray(piece.checked_by) ? piece.checked_by : [];
    for (const id of named) if (!ids.has(id)) missing_checks.push({ piece: piece.id, check: id });
    const checked = named.length > 0 && named.every(id => ids.has(id));
    const reason = piece.no_check && typeof piece.no_check.reason === 'string' && piece.no_check.reason.trim() ? piece.no_check : null;
    const coveredBy = Array.isArray(reason?.covered_by) ? reason.covered_by : [];
    for (const id of coveredBy) if (!ids.has(id)) missing_covered_by.push({ piece: piece.id, check: id });
    const reasoned = !checked && reason !== null && coveredBy.every(id => ids.has(id));
    const sources = Array.isArray(piece.sources) && piece.sources.length ? piece.sources : [{ file: null, section: piece.key ?? null }];
    for (const source of sources) {
      const file = fileOf(source.file ?? SETTINGS.no_file);
      file.pieces += 1;
      if (checked) file.with_check += 1;
      else if (reasoned) file.with_reason += 1;
      else file.uncovered.push({ id: piece.id, section: source.section ?? piece.key ?? null, says: piece.says ?? null });
    }
  }
  const report = [...files.values()].sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  const lines = [
    ...report.map(file => fill(SETTINGS.words.file, { ...file, uncovered: file.uncovered.length })),
    ...report.flatMap(file => file.uncovered.map(piece => fill(SETTINGS.words.uncovered, { ...piece, file: file.file }))),
    ...missing_checks.map(item => fill(SETTINGS.words.missing_check, item)),
    ...missing_covered_by.map(item => fill(SETTINGS.words.missing_covered_by, item)),
  ];
  const status = report.some(file => file.uncovered.length) ? 'failed' : 'passed';
  return { status, files: report, missing_checks, missing_covered_by, lines };
}

/** The coverage of the person's own piece rows, read through `door` (read only). */
export async function coverageInRecords(door) {
  const pieces = [];
  for await (const record of door.list({ type: SETTINGS.check_type, where: { [SETTINGS.kind_field]: SETTINGS.piece_kind } })) {
    if (record?.value && typeof record.value === 'object' && record.value[SETTINGS.kind_field] === SETTINGS.piece_kind) pieces.push(record.value);
  }
  if (!pieces.length) throw new PieceRefusal(SETTINGS.words.no_pieces);
  const named = new Set(pieces.flatMap(piece => [...(Array.isArray(piece.checked_by) ? piece.checked_by : []),
    ...(Array.isArray(piece.no_check?.covered_by) ? piece.no_check.covered_by : [])]).filter(id => typeof id === 'string'));
  const checks = [];
  for (const id of [...named].sort()) {
    const value = await door.read(SETTINGS.check_type, `${SETTINGS.record_prefix}${id}`);
    if (value && typeof value === 'object') checks.push({ ...value, id });
  }
  return coverage(pieces, checks);
}

export class PieceRefusal extends Error {}
