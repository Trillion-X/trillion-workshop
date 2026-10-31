// packages/check-documents-agree-with-their-source/do-work/check-documents-agree-with-their-source.mjs
//
// PURPOSE
//   Several documents each claim to reflect one source. Report which have fallen behind it.
//
// NON-NEGOTIABLE INVARIANTS
//   1. This file names no document, no identifier pattern, no marker and no subject. Every one of
//      those arrives in the descriptor. A test greps this file for the domain words that motivated
//      it and fails if any appears.
//   2. Nothing here touches a filesystem. The caller reads the texts and hands them over, which is
//      what lets the whole engine be tested without fixtures on disk.
//   3. A mirror being SHORTER than its source is correct, not a finding. Mirrors are summaries.
//      The only question asked is whether a mirror carries the source's NEWEST unit.
//   4. A mirror set naming no mirrors is REFUSED at read time. A set with nothing to compare
//      reports clean and proves nothing, which is the failure mode this package exists to end.
//
// KEY CONCEPTS
//   unit          an identifier the source and its mirrors both use, found by a declared pattern.
//                 Ordering is by the captured NUMBER when the pattern captures one, so item 99
//                 sorts BELOW item 218 rather than above it as string ordering would have it.
//                 (No example identifier is spelled out here on purpose. The first version of this
//                 comment used one from the first caller, and the suite's own generalisation test
//                 caught it: an example is how a domain gets into a mechanism, and a comment is
//                 where nobody looks for one.)
//   newest unit   the maximum unit in the source. What every mirror is measured against.
//   behind        the mirror does not contain the source's newest unit.
//   marker        a literal string a mirror must carry, independent of units.

/** Every unit in a text, as an array of {raw, order}. */
export function unitsIn(text, pattern) {
  const matcher = new RegExp(pattern, 'g');
  const found = [];
  let match;
  while ((match = matcher.exec(String(text ?? ''))) !== null) {
    // A zero-length match would spin forever. Advance and continue rather than throwing, because a
    // caller's pattern being over-permissive is not a reason to refuse to report anything at all.
    if (match[0] === '') {
      matcher.lastIndex += 1;
      continue;
    }
    // The capture decides ORDER when there is one. Without it the raw text is all there is, and
    // ordering falls back to comparing the text, which is honest about what it can know.
    const captured = match[1];
    const order = captured === undefined ? Number.NaN : Number(captured);
    found.push({ raw: match[0], order: Number.isFinite(order) ? order : Number.NaN });
  }
  return found;
}

/** The newest unit in a text, or null when the text carries none. */
export function newestUnit(text, pattern) {
  const units = unitsIn(text, pattern);
  if (units.length === 0) return null;
  const ordered = units.filter((unit) => Number.isFinite(unit.order));
  if (ordered.length === 0) {
    // No numeric order available anywhere, so the best available answer is the last one that
    // appears. Reported rather than refused, because a caller may legitimately use a pattern with
    // no capture group when documents are appended in order.
    return units[units.length - 1];
  }
  return ordered.reduce((newest, unit) => (unit.order > newest.order ? unit : newest));
}

/**
 * Refuse a descriptor that cannot answer the question it exists to ask.
 *
 * An empty mirror list is the specific hazard: it produces a clean report over nothing, which is
 * indistinguishable from a healthy set, and a check that cannot fail is worse than no check.
 */
export function readMirrorSet(descriptor) {
  const source = descriptor?.source;
  const mirrors = descriptor?.mirrors;
  const unitPattern = descriptor?.unit_pattern;
  if (typeof source !== 'string' || source === '') {
    throw new Error('a document mirror set must name its source document');
  }
  if (!Array.isArray(mirrors) || mirrors.length === 0) {
    throw new Error(
      `the mirror set for "${source}" names no mirrors, and a set with nothing to compare reports clean while proving nothing`,
    );
  }
  if (typeof unitPattern !== 'string' || unitPattern === '') {
    throw new Error(`the mirror set for "${source}" declares no unit_pattern, so nothing identifies a unit`);
  }
  for (const mirror of mirrors) {
    if (typeof mirror?.document !== 'string' || mirror.document === '') {
      throw new Error(`a mirror in the set for "${source}" names no document`);
    }
  }
  return { source, mirrors, unitPattern, requiredMarkers: descriptor.required_markers ?? [] };
}

/** Mirrors whose text does not carry the source's newest unit. */
export function mirrorsBehind(set, textOf) {
  const newest = newestUnit(textOf(set.source), set.unitPattern);
  if (newest === null) {
    // The SOURCE carries no unit at all. That is a defect in the source, never in the mirrors, and
    // reporting every mirror as behind would bury it under noise.
    return { newest: null, behind: [], sourceCarriesNoUnit: true };
  }
  const behind = [];
  for (const mirror of set.mirrors) {
    const carried = unitsIn(textOf(mirror.document), set.unitPattern).map((unit) => unit.raw);
    if (!carried.includes(newest.raw)) {
      behind.push({ document: mirror.document, missing: newest.raw, carries: carried.length });
    }
  }
  return { newest: newest.raw, behind, sourceCarriesNoUnit: false };
}

/** Mirrors missing a literal string the set requires them to carry. */
export function mirrorsMissingMarkers(set, textOf) {
  const missing = [];
  for (const mirror of set.mirrors) {
    const required = mirror.required_markers ?? set.requiredMarkers;
    if (!Array.isArray(required) || required.length === 0) continue;
    const text = String(textOf(mirror.document) ?? '');
    for (const marker of required) {
      if (!text.includes(marker)) missing.push({ document: mirror.document, marker });
    }
  }
  return missing;
}

/** The whole report for one descriptor. Structured, never a boolean. */
export function agreementReport(descriptor, textOf) {
  const set = readMirrorSet(descriptor);
  const behindResult = mirrorsBehind(set, textOf);
  const missingMarkers = mirrorsMissingMarkers(set, textOf);
  return {
    source: set.source,
    newest_unit: behindResult.newest,
    source_carries_no_unit: behindResult.sourceCarriesNoUnit,
    behind: behindResult.behind,
    missing_markers: missingMarkers,
    agrees:
      !behindResult.sourceCarriesNoUnit &&
      behindResult.behind.length === 0 &&
      missingMarkers.length === 0,
  };
}
