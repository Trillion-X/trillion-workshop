// Shape what the page measured into the tool's answer: per-sample numbers, medians and each median against the bar.
// Pure: no browser, no clock, so a test can feed it numbers.

/** The median of the numbers that are numbers; null when there are none. */
export function median(values) {
  const sorted = values.filter(value => Number.isFinite(value)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

const round = value => (value === null ? null : Math.round(value * 1000) / 1000);

/** Total bytes a visit's responses delivered, from content-length (a 206's length is its range). */
export function deliveredBytes(responses) {
  return responses.reduce((total, response) => total + (Number(response.contentLength) || 0), 0);
}

const MEASURES = ['first_frame_seconds', 'play_to_moving_seconds', 'seek_seconds', 'bytes', 'responses'];

/** The median of each measure over the visits of one kind (`fresh` or `returning`). */
export function mediansOf(visits) {
  return Object.fromEntries(MEASURES.map(name => [name, round(median(visits.map(visit => visit[name])))]));
}

function judge(value, rule) {
  if (value === null || value === undefined) return { value: null, at_most: rule.at_most, within: null, source: rule.source };
  return { value, at_most: rule.at_most, within: value <= rule.at_most, source: rule.source };
}

/** Each kind's median against the bar: fresh is the cold bar, returning the warm bar. Seek and play-to-moving are judged on both. */
export function againstBar(medians, bar) {
  return {
    fresh: {
      first_frame_seconds: judge(medians.fresh.first_frame_seconds, bar.first_frame_cold_seconds),
      bytes: judge(medians.fresh.bytes, bar.bytes_to_first_frame),
      play_to_moving_seconds: judge(medians.fresh.play_to_moving_seconds, bar.play_to_moving_seconds),
      seek_seconds: judge(medians.fresh.seek_seconds, bar.seek_seconds),
    },
    returning: {
      first_frame_seconds: judge(medians.returning.first_frame_seconds, bar.first_frame_warm_seconds),
      play_to_moving_seconds: judge(medians.returning.play_to_moving_seconds, bar.play_to_moving_seconds),
      seek_seconds: judge(medians.returning.seek_seconds, bar.seek_seconds),
    },
  };
}

/** The answer of one run. `samples` is [{ fresh, returning }]. */
export function shapeResult({ host, samples, bar, browser }) {
  const medians = {
    fresh: mediansOf(samples.map(sample => sample.fresh)),
    returning: mediansOf(samples.map(sample => sample.returning)),
  };
  return { host, browser, samples, medians, against_bar: againstBar(medians, bar) };
}
