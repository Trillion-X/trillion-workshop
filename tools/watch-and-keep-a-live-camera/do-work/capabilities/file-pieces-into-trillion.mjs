// parts/receive-a-camera-stream/do-work/capabilities/file-pieces-into-trillion.mjs
//
// Purpose: the destination capability that keeps a camera's stream in the person's own files. The stream is cut
// into pieces (settings `pieces`), and each piece is sent into the namespace while FFmpeg writes it, through the
// shared chunked sender every uploader uses (live-namespace send-a-file-to-a-namespace.mjs), under
// `pieces.under`/<day>/. From there each piece is a video like any other the person adds, so the recordings road
// (records/starting-rules.json starting:transcribe-video) hears it whole and hands it to their AIs.
//
// Non-Negotiable Invariants:
//   1. A piece on this computer is deleted only after the namespace answered that it holds it (a `sent` row in the
//      ledger <folder>/sent.jsonl); a piece this program did not write (taken over from a hand-made receiver) is
//      never deleted.
//   2. A piece whose send could not finish while it was written is sent whole once it is finished, after each wait in
//      `retry_after_seconds` (the last repeating), and again after a restart, since the ledger says it is unsent.
//   3. A name in the namespace is chosen once per piece and kept in the ledger, so a resend never makes a second file.
//   4. While a camera stream can arrive, this computer does not fall asleep on its own (`stay_awake_command`).
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import { promises as fs, watch } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileSource, growingFileSource, sendFile } from '../../../browse-and-upload-my-files/do-work/send-a-file-to-a-namespace.mjs';
import { programIn, takeAStream } from '../take-a-stream.mjs';

const pad = number => String(number).padStart(2, '0');
const dayOf = date => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const fill = (text, values) => String(text).replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));
/** When a piece began, from the name FFmpeg gave it (2026-10-09 15-36-22.mp4), or null. */
export const pieceTime = file => { const found = /(\d{4})-(\d{2})-(\d{2}) (\d{2})-(\d{2})-(\d{2})/.exec(path.basename(file)); return found ? new Date(+found[1], found[2] - 1, +found[3], +found[4], +found[5], +found[6]) : null; };

/** The namespace name of a piece: `under`/<day>/`name` filled with its time and the camera's name. */
export function pieceName(pieces, file, camera) {
  const at = pieceTime(file) ?? new Date();
  const name = fill(pieces.name, { time: `${pad(at.getHours())}-${pad(at.getMinutes())}-${pad(at.getSeconds())}`, camera: String(camera).replace(/[/\\:]/g, '-') });
  return `${pieces.under.replace(/\/$/, '')}${pieces.folder_per_day ? `/${dayOf(at)}` : ''}/${name}`;
}

export const available = ({ settings }) => Boolean(programIn(settings.ffmpeg.search_path, settings.ffmpeg.program));
export const ready = ({ settings }) => (available({ settings }) ? { ready: true } : { ready: false, why: settings.words.no_ffmpeg });

/**
 * Sends pieces from `folder` into the namespace: send(file, { finished, keep }) sends one (while it grows when
 * `finished` is a promise), resend() sends whole every piece the ledger has not seen held that is no longer being written (`stillWritten`). Answers how many
 * were sent and the last name, through onSent.
 */
export async function piecesSender({ client, chunking, folder, pieces, camera, retryAfter = [30, 120, 600], stillWritten = () => false, onSent = () => {}, say = () => {} }) {
  await fs.mkdir(folder, { recursive: true });
  const ledgerFile = path.join(folder, 'sent.jsonl');
  const rows = new Map();
  for (const line of (await fs.readFile(ledgerFile, 'utf8').catch(() => '')).split('\n')) { try { const row = JSON.parse(line); rows.set(row.file, row); } catch {} }
  const remember = async row => { rows.set(row.file, row); await fs.appendFile(ledgerFile, `${JSON.stringify(row)}\n`); };
  const sending = new Set();
  let attempt = 0, retry = null;

  async function send(file, { finished = null, keep = false } = {}) {
    if (rows.get(file)?.state === 'sent' || sending.has(file)) return;
    sending.add(file);
    const row = rows.get(file) ?? { file, name: pieceName(pieces, file, camera), keep };
    if (!rows.has(file)) await remember({ ...row, state: 'arriving' });
    const source = finished ? await growingFileSource(file, { finished }) : await fileSource(file);
    try {
      const sent = await sendFile({ client, source, name: row.name, modifiedAtMs: Date.now(), mediaType: pieces.media_type, chunking, parallel: 16 });
      await remember({ ...row, state: 'sent', identity: sent.identity, sent_at: new Date().toISOString() });
      if (!row.keep) await fs.rm(file).catch(() => {});
      attempt = 0;
      say(`${sent.state === 'uploaded' ? 'sent' : 'already there'}  ${row.name}  ${sent.identity}`);
      onSent(row.name);
    } catch (error) {
      say(`not sent yet  ${row.name}: ${error.message}`);
      clearTimeout(retry);
      retry = setTimeout(() => { attempt += 1; void resend(); }, (retryAfter[Math.min(attempt, retryAfter.length - 1)] ?? 60) * 1000);
    } finally { sending.delete(file); await source.close(); }
  }

  // Every piece written here and not yet held, whole: after a failed send, and after a restart.
  async function resend() {
    const files = (await fs.readdir(folder).catch(() => [])).filter(name => name.endsWith('.mp4')).map(name => path.join(folder, name));
    for (const file of [...new Set([...files, ...[...rows.values()].filter(row => row.state !== 'sent').map(row => row.file)])]) {
      if (stillWritten(file) || rows.get(file)?.state === 'sent') continue;
      if (!(await fs.stat(file).catch(() => null))) continue;
      await send(file, { keep: rows.get(file)?.keep ?? false });
    }
  }
  return { send, resend, held: file => rows.get(file)?.state === 'sent', stop: () => clearTimeout(retry) };
}

/** Start taking `camera`'s stream on `port` with `key` into the person's files. Returns { stop() }. */
export async function start({ ctx, camera, port, key, onState = () => {} }) {
  const { settings, say } = ctx;
  const { pieces } = settings;
  const ffmpeg = programIn(settings.ffmpeg.search_path, settings.ffmpeg.program);
  const folder = path.join(ctx.appData, settings.keep_while_sending.under_app_data, camera.id);
  const state = { receiving: false, since: null, ended: null, pieces: 0, last: '' };
  const growing = new Map(); // file -> { resolve, reject } of its `finished`
  const sender = await piecesSender({ client: ctx.client, chunking: ctx.chunking, folder, pieces, camera: camera.values.camera, retryAfter: settings.retry_after_seconds, stillWritten: file => growing.has(file), say, onSent: name => { state.pieces += 1; state.last = path.posix.basename(name); onState({ ...state }); } });
  let thisRun = new Set();
  const finish = (file, refused = false) => { const done = growing.get(file); growing.delete(file); if (refused) done?.reject(new Error('cut off: sent with another key')); else done?.resolve(); };
  const watcher = watch(folder, (event, name) => {
    if (!name?.endsWith('.mp4')) return;
    const file = path.join(folder, name);
    if (growing.has(file) || sender.held(file)) return;
    void fs.stat(file).then(() => {
      if (growing.has(file)) return;
      thisRun.add(file);
      void sender.send(file, { finished: new Promise((resolve, reject) => growing.set(file, { resolve, reject })) });
    }, () => {});
  });
  await sender.resend();
  const awake = settings.stay_awake_command?.length ? spawn(settings.stay_awake_command[0], [...settings.stay_awake_command.slice(1), String(process.pid)], { stdio: 'ignore' }) : null;
  const listener = takeAStream({
    ffmpeg, port, app: settings.listen.app, key, say,
    output: ['-c', 'copy', '-f', 'segment', '-segment_time', String(pieces.seconds), '-reset_timestamps', '1', '-strftime', '1', '-segment_format_options', pieces.segment_options, '-segment_list', 'pipe:1', '-segment_list_type', 'csv', path.join(folder, '%Y-%m-%d %H-%M-%S.mp4')],
    // The segment list names a piece once FFmpeg closed it.
    onLine: line => finish(path.join(folder, line.split(',')[0])),
    onStarted: () => { Object.assign(state, { receiving: true, since: new Date(), ended: null, pieces: 0, last: '' }); onState({ ...state }); },
    onRefused: async () => { for (const file of thisRun) { finish(file, true); await fs.rm(file).catch(() => {}); } say('cut off a stream sent with another key'); onState({ refused: new Date() }); },
    onEnded: async ({ started }) => { for (const file of [...growing.keys()]) finish(file); thisRun = new Set(); if (started) { Object.assign(state, { receiving: false, ended: new Date() }); onState({ ...state }); } },
  });
  return { stop() { listener.stop(); watcher.close(); sender.stop(); awake?.kill(); for (const file of [...growing.keys()]) finish(file); } };
}
