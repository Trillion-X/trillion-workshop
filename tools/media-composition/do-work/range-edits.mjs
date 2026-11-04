// tools/media-composition/do-work/range-edits.mjs
//
// PURPOSE
//   Edits to a person's recording, text or timeline as KEPT RANGES over the original, never as new content. A range is
//   { start, end } in the source's own unit (seconds, characters, frames); an edit is the list of ranges that stay. Because the
//   output type holds only positions in the original, an AI that proposes an edit cannot invent, reword or add anything:
//   what is not kept is removed, and nothing else can appear. The same interval rules judge whether the pieces a render needs
//   (subject masks, captions, overlays) cover the kept time before an export is allowed.
//
// NON-NEGOTIABLE INVARIANTS
//   1. A range has exactly start and end, finite numbers with 0 <= start < end <= length. Any other field, a range outside the
//      source, an overlap or an out-of-order list is a refusal in words; nothing is repaired by guessing.
//   2. Ranges may arrive in any order; touching ranges (end equals the next start) are one range; the answer is always sorted and disjoint.
//   3. Applying an edit returns only items of the original, in original order: the edit cannot add an item.
//   4. After an export, the produced length must equal the kept total within a tolerance that is the caller's DATA.
//   5. Readiness is judged by DATA: which segment states count as ready is passed in (`ready_states`), never named here.
//
const refusal = message => Object.assign(new Error(message), { status: 400 });
const number = value => typeof value === 'number' && Number.isFinite(value);

/** The kept ranges as a sorted, disjoint list, or a refusal. `length` is the source's size in its unit. */
export function keptRanges(ranges, length) {
  if (!number(length) || length <= 0) throw refusal('The source length must be a positive number.');
  if (!Array.isArray(ranges)) throw refusal('Kept ranges must be a list.');
  for (const [index, range] of ranges.entries()) {
    const extra = range && typeof range === 'object' ? Object.keys(range).find(key => key !== 'start' && key !== 'end') : 'not an object';
    if (extra) throw refusal(`Range ${index} may hold only start and end (found ${extra}); an edit is positions in the original, not new content.`);
    if (!number(range.start) || !number(range.end) || range.start < 0 || range.end > length || range.start >= range.end) {
      throw refusal(`Range ${index} must have 0 <= start < end <= ${length}.`);
    }
  }
  const sorted = ranges.map(({ start, end }) => ({ start, end })).sort((a, b) => a.start - b.start);
  const merged = [];
  for (const range of sorted) {
    const last = merged.at(-1);
    if (last && range.start < last.end) throw refusal(`Ranges overlap near ${range.start}; keep each part of the original once.`);
    if (last && range.start === last.end) last.end = range.end;
    else merged.push({ ...range });
  }
  return merged;
}

/** What the kept ranges leave out. */
export function removedRanges(kept, length) {
  const removed = [];
  let at = 0;
  for (const range of keptRanges(kept, length)) {
    if (range.start > at) removed.push({ start: at, end: range.start });
    at = range.end;
  }
  if (at < length) removed.push({ start: at, end: length });
  return removed;
}

export const keptTotal = kept => kept.reduce((sum, range) => sum + (range.end - range.start), 0);

/** The items of the original that sit wholly inside a kept range, in original order. `span(item)` → { start, end }. */
export function applyKept(items, kept, span = item => item) {
  const inside = item => { const { start, end } = span(item); return kept.some(range => start >= range.start && end <= range.end); };
  return items.filter(inside);
}

/** Whether a finished output has the length the edit promised: { ok, expected, actual }. */
export function checkOutputLength(kept, actual, tolerance) {
  const expected = keptTotal(kept);
  return { ok: number(actual) && Math.abs(actual - expected) <= tolerance, expected, actual };
}

/** Whether `segments` ({ start, end, state }) cover every kept range with a state in `readyStates`: { ready, pending, gaps }. */
export function coverage(kept, segments, readyStates) {
  const usable = segments.filter(segment => readyStates.includes(segment.state)).sort((a, b) => a.start - b.start);
  const pending = segments.filter(segment => !readyStates.includes(segment.state)
    && kept.some(range => segment.start < range.end && segment.end > range.start));
  const gaps = [];
  for (const range of kept) {
    let at = range.start;
    for (const segment of usable) {
      if (segment.end <= at || segment.start >= range.end) continue;
      if (segment.start > at) gaps.push({ start: at, end: segment.start });
      at = Math.max(at, segment.end);
    }
    if (at < range.end) gaps.push({ start: at, end: range.end });
  }
  return { ready: gaps.length === 0, pending, gaps };
}

/** Refuses an export while the pieces it needs are not ready, saying which part of the time is missing. */
export function refuseUntilReady(kept, segments, readyStates, what = 'the pieces this export needs') {
  const found = coverage(kept, segments, readyStates);
  if (!found.ready) {
    const first = found.gaps[0];
    throw Object.assign(refusal(`Not ready: ${what} do not yet cover ${first.start} to ${first.end}.`), { status: 409, retry: true, gaps: found.gaps });
  }
  return found;
}
