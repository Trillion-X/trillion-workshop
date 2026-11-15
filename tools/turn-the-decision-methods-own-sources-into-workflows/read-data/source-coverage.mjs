// Strict source and step qualification over the shared piece-coverage owner.
import { sweepAtoms } from '../../check-against-a-persons-rules-and-verdicts/do-work/piece-sweep.mjs';
export { sweepAtoms };

// Strict generic consumer. The shared sweep supplies the per-source
// inventory sweep; only qualified current links/reasons enter its covered counts.
import { stepAnatomyProblems } from '../../workflows/read-data/recipe-problems.mjs';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
const words = value => typeof value === 'string' && value.trim().length > 0;
const pin = value => typeof value === 'string' && /^1f:[a-f0-9]{64}$/.test(value);
export const textIdentity = text => {
  if (typeof text !== 'string') throw new TypeError('Piece text must be a string.');
  return makeHashCodeHexFromBytes(new TextEncoder().encode(text));
};

/** Current independent readbacks. Pure: no source, account or filesystem access. */
export function sourceCoverage({ sources, pieces, steps } = {}) {
  const gaps = [];
  const gap = (kind, fields) => gaps.push({ kind, ...fields });
  const index = (rows, list) => {
    if (!Array.isArray(rows)) throw new TypeError(`${list} must be an array.`);
    const found = new Map();
    rows.forEach((row, at) => {
      if (!words(row?.id)) gap('invalid_id', { list, at });
      else if (found.has(row.id)) gap('duplicate_id', { list, id: row.id });
      else found.set(row.id, row);
    });
    return found;
  };
  const sourceById = index(sources, 'sources'), pieceById = index(pieces, 'pieces'), stepById = index(steps, 'steps');
  const occupied = new Map(), collisions = new Set();
  for (const [list, rows] of [['sources', sourceById], ['pieces', pieceById], ['steps', stepById]]) for (const id of rows.keys()) {
    if (occupied.has(id)) { collisions.add(id); gap('colliding_record_id', { id, lists: [occupied.get(id), list] }); }
    else occupied.set(id, list);
  }
  if (!sourceById.size) gap('missing_source_inventory', {});
  const validSources = new Set();
  for (const source of sourceById.values()) {
    const before = gaps.length;
    if (!pin(source.identity)) gap('invalid_source_identity', { source_id: source.id });
    if (source.text !== undefined && (!words(source.text) || textIdentity(source.text) !== source.identity)) gap('source_bytes_mismatch', { source_id: source.id });
    if (!pieces.some(piece => piece?.source_id === source.id)) gap('unexamined_source', { source_id: source.id });
    if (gaps.length === before && !collisions.has(source.id)) validSources.add(source.id);
  }
  const validPieces = new Set();
  for (const piece of pieceById.values()) {
    const before = gaps.length;
    const source = sourceById.get(piece.source_id);
    if (!source) gap('missing_source', { piece_id: piece.id, source_id: piece.source_id });
    else if (!pin(source.identity) || piece.source_identity !== source.identity) gap('stale_piece_source', { piece_id: piece.id, source_id: piece.source_id, expected: source.identity, actual: piece.source_identity ?? null });
    else if (!validSources.has(source.id)) gap('invalid_source_reference', { piece_id: piece.id, source_id: source.id });
    if (!words(piece.text) || !pin(piece.identity) || typeof piece.text !== 'string' || piece.identity !== textIdentity(piece.text)) gap('invalid_piece_identity', { piece_id: piece.id });
    if (!words(piece.location)) gap('missing_location', { piece_id: piece.id });
    if (gaps.length === before && !collisions.has(piece.id)) validPieces.add(piece.id);
  }
  const problemsByStep = new Map();
  for (const step of stepById.values()) {
    const earlier = [...stepById.values()].filter(prior => prior.position < step.position && Array.isArray(prior.part_of) && Array.isArray(step.part_of) && prior.part_of.some(branch => step.part_of.includes(branch)));
    const problems = stepAnatomyProblems(step, { earlier: new Set(earlier.map(row => row.id)), schemas: { this: step.submit, steps: new Map(earlier.map(row => [row.id, row.submit])) } });
    problemsByStep.set(step.id, problems);
    if (problems.length) gap('invalid_step_anatomy', { step_id: step.id, problems });
  }
  const linked = new Map(), validStepIds = new Set();
  for (const step of stepById.values()) {
    const before = gaps.length;
    const candidates = [];
    const versions = step.source_versions;
    if (!versions || typeof versions !== 'object' || Array.isArray(versions)) gap('missing_source_versions', { step_id: step.id });
    for (const id of Array.isArray(step.came_from) ? step.came_from : []) {
      const piece = pieceById.get(id);
      if (!piece) { gap('missing_piece', { step_id: step.id, piece_id: id }); continue; }
      if (versions?.[id] !== piece.identity) { gap('stale_step_source', { step_id: step.id, piece_id: id, expected: piece.identity, actual: versions?.[id] ?? null }); continue; }
      if (!validPieces.has(id)) { gap('invalid_piece_reference', { step_id: step.id, piece_id: id }); continue; }
      candidates.push(id);
    }
    for (const id of Object.keys(versions ?? {})) if (!Array.isArray(step.came_from) || !step.came_from.includes(id)) gap('uncited_source_version', { step_id: step.id, piece_id: id });
    if (!collisions.has(step.id) && !problemsByStep.get(step.id).length && gaps.length === before) {
      validStepIds.add(step.id);
      for (const id of candidates) linked.set(id, [...(linked.get(id) ?? []), step.id]);
    }
  }
  const reasons = new Map();
  for (const piece of pieceById.values()) if (piece.no_check !== undefined) {
    const reason = piece.no_check;
    const refs = reason?.covered_by ?? [];
    const valid = words(reason?.reason) && reason.piece_identity === piece.identity && Array.isArray(refs) && refs.every(id => words(id) && validStepIds.has(id));
    if (!valid) gap('invalid_no_check', { piece_id: piece.id, expected_piece_identity: piece.identity });
    if (Array.isArray(refs)) for (const id of refs) if (!stepById.has(id)) gap('missing_covered_by', { piece_id: piece.id, step_id: id });
    if (valid && validPieces.has(piece.id)) reasons.set(piece.id, reason);
  }
  const outcomes = [...pieceById.values()].map(piece => {
    const step_ids = linked.get(piece.id) ?? [];
    const status = step_ids.length ? 'step' : reasons.has(piece.id) ? 'reason' : 'uncovered';
    if (status === 'uncovered') gap('uncovered', { source_id: piece.source_id, piece_id: piece.id, location: piece.location });
    return { source_id: piece.source_id, piece_id: piece.id, status, step_ids };
  });
  return { ok: gaps.length === 0, qualification: 'structural', semantic_verification: 'not_established', inventory_completeness: 'not_established', scope: 'supplied_inventory', count: outcomes.length, with_step: outcomes.filter(row => row.status === 'step').length, with_reason: outcomes.filter(row => row.status === 'reason').length, uncovered: outcomes.filter(row => row.status === 'uncovered').length,
    sources: [...sourceById.keys()].map(source_id => {
      const own = [...pieceById.values()].filter(row => row.source_id === source_id);
      const recorded = Object.fromEntries(own.map(row => [row.id, { identity: row.identity, ...(reasons.has(row.id) ? { no_check: reasons.get(row.id) } : {}) }]));
      const citing = own.flatMap(row => (linked.get(row.id) ?? []).map(id => ({ id, source: { section: row.id } })));
      const sweep = sweepAtoms(recorded, own.map(row => ({ key: row.id, identity: row.identity })), citing, [...stepById.values()]);
      return { source_id, identity: sourceById.get(source_id).identity, ...sweep, pieces: outcomes.filter(row => row.source_id === source_id) };
    }), gaps };
}
