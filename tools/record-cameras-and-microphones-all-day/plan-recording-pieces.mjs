// tools/record-cameras-and-microphones-all-day/plan-recording-pieces.mjs
//
// The part of recording every camera and microphone all day that runs without a browser: the plan of pieces a stretch
// of recording is cut into. Every input switched on records from `started_at` to `until`, cut on the clock every
// `segment_seconds` counted from the start of the device's day (rolling-segments.mjs windowAt), so the pieces of every
// input on every device that records the same moment begin and end at the same instants. Each piece is named the way
// always-recording.ts names it (pieceName: the day's folder under `folder`, then the time its piece began and the
// input's name), and the session list that ties them together (sessionList) comes back as it would be kept beside them.
//
// Inputs:
//   started_at       when recording began (ISO time)
//   until            when the stretch planned ends (ISO time, after started_at)
//   segment_seconds  how long a piece is (300 when left out; at least 1)
//   folder           the folder pieces are kept under ("Recordings" when left out)
//   inputs           [{ label, kind: 'camera' | 'microphone', extension?, with_sound? }]: label is the device's own label
//                    (bus numbers such as "(05ac:8514)" are dropped), extension the file ending ("webm" when left out)
//   device           which device records, as a person reads it (kept in the list)
//   list_name        the list's own name in the day's folder ("Recording list" when left out)
//   time_zone        the device's own time zone (IANA name; the run's own when left out): days and windows are its days
//
// Refuses: a time that does not read, until not after started_at, no inputs, an input without a label or with a kind
// other than camera or microphone, a time zone that is not known, and a plan of more than 5000 pieces.
import { inputName, pieceName, sessionList, windowAt } from './rolling-segments.mjs';

const MAX_PIECES = 5000;
const KINDS = ['camera', 'microphone'];

const timeOf = (value, field) => {
  const ms = typeof value === 'string' ? Date.parse(value) : NaN;
  if (!Number.isFinite(ms)) throw new Error(`Give ${field} as an ISO time, for example 2026-11-04T16:20:00Z.`);
  return ms;
};

export function planRecordingPieces({ started_at, until, segment_seconds = 300, folder = 'Recordings', inputs, device = 'this device', list_name = 'Recording list', time_zone } = {}) {
  if (time_zone !== undefined) {
    try { new Intl.DateTimeFormat('en', { timeZone: time_zone }); } catch { throw new Error(`time_zone ${JSON.stringify(time_zone)} is not a known IANA time zone; give one such as Europe/London.`); }
    process.env.TZ = time_zone;
  }
  const startedMs = timeOf(started_at, 'started_at');
  const untilMs = timeOf(until, 'until');
  if (untilMs <= startedMs) throw new Error('until must be after started_at.');
  if (!Number.isFinite(segment_seconds) || segment_seconds < 1) throw new Error('segment_seconds must be a number of seconds, at least 1.');
  if (!Array.isArray(inputs) || inputs.length === 0) throw new Error('Give inputs: [{ label, kind: camera | microphone }], one per input switched on.');
  const named = inputs.map((input, index) => {
    if (!KINDS.includes(input?.kind)) throw new Error(`Input ${index} has kind ${JSON.stringify(input?.kind)}; use camera or microphone.`);
    const name = inputName(input.label, '');
    if (!name) throw new Error(`Input ${index} needs label: the device's own label, as text.`);
    const extension = typeof input.extension === 'string' && /^[a-z0-9]{1,8}$/i.test(input.extension) ? input.extension : 'webm';
    return { name, kind: input.kind, with_sound: input.kind === 'microphone' || Boolean(input.with_sound), extension };
  });

  // The windows: the first from the moment recording began to the end of its clock window, then whole windows, the
  // last ending where the stretch ends.
  const windows = [];
  for (let start = startedMs; start < untilMs;) {
    const end = Math.min(windowAt(start, segment_seconds).end, untilMs);
    windows.push({ start, end });
    if (windows.length * named.length > MAX_PIECES) throw new Error(`That plan has more than ${MAX_PIECES} pieces; plan a shorter stretch or longer pieces.`);
    start = end;
  }
  const pieces = windows.flatMap(({ start, end }) => named.map(input => {
    const place = pieceName({ folder, startMs: start, input: input.name, extension: input.extension });
    return { input: input.name, folder: place.folder, name: place.name, file: `${place.folder}/${place.name}`, start_ms: start, end_ms: end, seconds: (end - start) / 1000 };
  }));
  const list = pieceName({ folder, startMs: startedMs, input: list_name, extension: 'json' });
  return {
    time_zone: time_zone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    list: `${list.folder}/${list.name}`,
    first_cut_at: new Date(windows[0].end).toISOString(),
    piece_count: pieces.length,
    pieces,
    session_list: sessionList({
      startedMs, segmentSeconds: segment_seconds, device,
      inputs: named.map(({ name, kind, with_sound }) => ({ name, kind, with_sound })),
      pieces: pieces.map(piece => ({ input: piece.input, start_ms: piece.start_ms, end_ms: piece.end_ms, file: piece.file, identity: null })),
    }),
  };
}
