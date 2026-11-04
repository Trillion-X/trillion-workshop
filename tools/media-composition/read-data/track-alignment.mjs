// parts/media-composition/read-data/track-alignment.mjs
//
// SEPARATE TRACKS OF ONE RECORDING ARE CHECKED TO BE IN STEP, FROM WHEN EACH WAS CAPTURED AND WHERE EACH FILE STARTS.
//
// Purpose: a recording made of a screen, a camera, a microphone and system sound as separate files only plays right if the
// files line up. Each track records the wall-clock instant its first sample was captured; its file records the timestamp it
// starts at. If the two disagree by a different amount for different tracks, those tracks drift against each other. This
// measures that, names the track furthest out, and gives the shift that would bring each track to the reference, so an editor
// corrects it or a recorder can be told it is broken, before anyone has to find out by watching.
//
// Non-negotiable invariants:
//   1. Pure arithmetic over numbers handed in; reading a file's first timestamp is `readStart`, handed in by the caller.
//   2. The reference is the track with the earliest wall clock; every other track is compared to it, so adding a track never
//      changes how the others compare to each other.
//   3. A track that cannot be read is reported, never guessed, and the others are still compared.
//   4. The tolerance, the seek points and the words are DATA (./track-alignment.json).
//
// Key concepts: `measureAlignment(tracks)`, `alignmentProbe({ tracks, readStart })`, `seekPoints(duration_ms)`.
import rules from './track-alignment.json' with { type: 'json' };

const fill = (template, values) => template.replace(/\{(\w+)\}/gu, (whole, name) => (name in values ? String(values[name]) : whole));

/**
 * `tracks`: [{ id, wall_clock_ms, first_timestamp_ms }]. -> { reference, offsets: [{ id, offset_ms, shift_ms }], skew_ms, in_step, worst, said }
 * `offset_ms` is how much later (positive) or earlier (negative) a track's content is than the reference's at the same wall-clock
 * instant; `shift_ms` is what to add to the track's timestamps to bring it to the reference.
 */
export function measureAlignment(tracks, settings = rules) {
  if (tracks.length < 2) return { reference: tracks[0]?.id ?? null, offsets: tracks.map((track) => ({ id: track.id, offset_ms: 0, shift_ms: 0 })), skew_ms: 0, in_step: true, worst: null, said: settings.words.one_track };
  const reference = tracks.reduce((first, track) => (track.wall_clock_ms < first.wall_clock_ms ? track : first));
  const lag = (track) => track.first_timestamp_ms - track.wall_clock_ms;
  const offsets = tracks.map((track) => {
    const offset = Math.round(lag(track) - lag(reference));
    return { id: track.id, offset_ms: offset, shift_ms: -offset };
  });
  const values = offsets.map((offset) => offset.offset_ms);
  const skew = Math.max(...values) - Math.min(...values);
  const inStep = skew <= settings.tolerance_ms;
  const worst = [...offsets].sort((a, b) => Math.abs(b.offset_ms) - Math.abs(a.offset_ms))[0];
  const said = inStep
    ? fill(settings.words.in_step, { count: tracks.length, skew_ms: skew })
    : fill(settings.words.out_of_step, { track: worst.id, offset_ms: Math.abs(worst.offset_ms), direction: worst.offset_ms > 0 ? settings.words.late : settings.words.early, skew_ms: skew, tolerance_ms: settings.tolerance_ms });
  return { reference: reference.id, offsets, skew_ms: skew, in_step: inStep, worst: inStep ? null : worst.id, said };
}

/** The instants (ms into a recording of `duration_ms`) a probe seeks every track to, in the DATA's order. */
export const seekPoints = (duration_ms, settings = rules) => settings.seek_fractions.map((fraction) => Math.round(duration_ms * fraction));

/**
 * Reads each track's first timestamp (`readStart(track)` -> ms, or throws) and measures. Tracks that cannot be read are listed
 * in `unreadable` with words, and the rest are still compared. -> measureAlignment's answer plus { unreadable: [{ id, said }] }
 */
export async function alignmentProbe({ tracks, readStart }, settings = rules) {
  const readable = [];
  const unreadable = [];
  for (const track of tracks) {
    try {
      const first = await readStart(track);
      if (!Number.isFinite(first)) throw new Error('no timestamp');
      readable.push({ id: track.id, wall_clock_ms: track.wall_clock_ms, first_timestamp_ms: first });
    } catch { unreadable.push({ id: track.id, said: fill(settings.words.unreadable, { track: track.id }) }); }
  }
  return { ...measureAlignment(readable, settings), unreadable };
}
