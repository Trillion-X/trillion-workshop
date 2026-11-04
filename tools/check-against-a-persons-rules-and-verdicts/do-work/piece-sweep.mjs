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
