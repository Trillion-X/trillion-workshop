type TimedRange = { start_ms?: number; end_ms?: number };
const indexes = new WeakMap<readonly TimedRange[], (seconds: number) => number>();

/** First matching source row, including shared boundaries and overlapping or
 * unsorted ranges. Ordered transcripts prune to a logarithmic lookup. Arbitrary
 * ranges safely visit only branches whose time envelope can contain the seek;
 * their worst case is the original linear scan, never a changed match. */
export function timedTextSegmentLookup(segments: readonly TimedRange[] | undefined) {
  if (!segments?.length) return () => -1;
  const cached = indexes.get(segments);
  if (cached) return cached;
  let capacity = 1;
  while (capacity < segments.length) capacity *= 2;
  const starts = new Float64Array(capacity * 2).fill(Infinity);
  const ends = new Float64Array(capacity * 2).fill(-Infinity);
  segments.forEach((segment, index) => {
    if (typeof segment.start_ms !== 'number' || typeof segment.end_ms !== 'number'
      || !(segment.start_ms <= segment.end_ms)) return;
    starts[capacity + index] = segment.start_ms;
    ends[capacity + index] = segment.end_ms;
  });
  for (let node = capacity - 1; node > 0; node -= 1) {
    starts[node] = Math.min(starts[node * 2], starts[node * 2 + 1]);
    ends[node] = Math.max(ends[node * 2], ends[node * 2 + 1]);
  }
  const lookup = (seconds: number) => {
    if (!Number.isFinite(seconds)) return -1;
    const milliseconds = seconds * 1000;
    function visit(node: number): number {
      if (starts[node] > milliseconds || ends[node] < milliseconds) return -1;
      if (node >= capacity) return node - capacity;
      const first = visit(node * 2);
      return first >= 0 ? first : visit(node * 2 + 1);
    }
    return visit(1);
  };
  indexes.set(segments, lookup);
  return lookup;
}
