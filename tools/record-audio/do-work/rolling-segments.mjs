// parts/record-audio/do-work/rolling-segments.mjs
//
// NO PRIOR: searched parts/ and ~/dev/bitfield-packages/packages for a recording that runs without end and is cut into
// pieces that each play on their own ("rolling", "segment", "continuous", "always on", "chunk length"); the recorders
// (record-in-the-browser.ts, RecordAudioPanel, RecordVideoPanel) each make one recording that ends when it is stopped.
//
// PURPOSE
//   The arithmetic of recording that never stops: when each piece of a long recording begins and ends, what each piece
//   is named, and the list that ties every piece of every input together. Pieces are cut on the clock (every
//   `segment_seconds` since the start of the day, counted in the device's own time), never from when an input started,
//   so every input on every device that records the same moment cuts at the same instants: the pieces of a camera, a
//   phone and a microphone that start at 16.20.00 are the same 16.20.00 to 16.25.00, and line up without any shared
//   clock beyond each device's own time.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Nothing here names a device, a kind of input or a place: names and folders come from the caller's DATA.
//   2. A window always ends after it begins: an input that starts at 16.24.59.900 records to 16.25.00 and then the
//      next window, never an empty piece.
//   3. A name is a pure function of the moment, the input's name and the file ending, so a piece recorded again after
//      a reload is named the same.

const two = value => String(value).padStart(2, '0');

/** The day a moment falls on, in the device's own time: 2026-10-05. */
export const dayOf = at => `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())}`;

/** The time of day of a moment, as it goes into a file name: 16.20.00. */
export const timeOf = at => `${two(at.getHours())}.${two(at.getMinutes())}.${two(at.getSeconds())}`;

/** The window a moment falls in when pieces are `seconds` long, counted from the start of the device's day:
 *  { start, end } in milliseconds since 1970. */
export function windowAt(ms, seconds) {
  const length = Math.max(1, Math.round(seconds)) * 1000;
  const at = new Date(ms);
  const midnight = new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime();
  const start = midnight + Math.floor((ms - midnight) / length) * length;
  const nextMidnight = new Date(at.getFullYear(), at.getMonth(), at.getDate() + 1).getTime();
  return { start, end: Math.min(start + length, nextMidnight) };
}

/** An input's name as a person reads it in a file name: the device's own label without the bus numbers browsers add
 *  ("FaceTime HD Camera (05ac:8514)" reads "FaceTime HD Camera"), and nothing a folder name cannot hold. */
export function inputName(label, fallback) {
  const cleaned = String(label ?? '')
    .replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)\s*$/i, '')
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || fallback;
}

/** Where a piece is kept: the folder for its day under `folder`, named by the moment its window began and the input,
 *  so every input's piece of the same moment sits side by side. */
export function pieceName({ folder, startMs, input, extension }) {
  const at = new Date(startMs);
  return { folder: `${folder}/${dayOf(at)}`, name: `${timeOf(at)} ${input}.${extension}` };
}

/** The list that ties a session together: every input it records and every piece kept so far, by start, so a person
 *  or an AI lines the angles and the sound up by time. `pieces` are { input, start_ms, end_ms, file, identity }. */
export function sessionList({ startedMs, segmentSeconds, inputs, pieces, device }) {
  const byStart = [...pieces].sort((left, right) => Math.floor(left.start_ms / 1000) - Math.floor(right.start_ms / 1000) || left.input.localeCompare(right.input));
  const moments = [];
  for (const piece of byStart) {
    const last = moments[moments.length - 1];
    // Inputs cut a few milliseconds apart at the same instant; the same second is the same moment.
    if (last && Math.floor(last.start_ms / 1000) === Math.floor(piece.start_ms / 1000)) last.files.push({ input: piece.input, file: piece.file, identity: piece.identity });
    else moments.push({ start_ms: piece.start_ms, end_ms: piece.end_ms, starts: new Date(piece.start_ms).toISOString(), files: [{ input: piece.input, file: piece.file, identity: piece.identity }] });
  }
  return {
    what: 'Recordings made at the same time by several cameras and microphones. Each moment lists the files recorded together; they start at the same instant and run the same length, so they line up by time.',
    started: new Date(startedMs).toISOString(),
    device,
    piece_seconds: segmentSeconds,
    inputs,
    moments,
  };
}
