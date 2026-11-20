// tools/audio-transcription/read-data/hear-here.mjs
//
// Purpose
//   Hears on the person's own computer, with the whisper-cli and model they chose, so nobody pays a speech service:
//   - hearARecording (tool:hear-a-recording): a recording in the person's files into timed words.
//   - hearALink (tool:hear-a-link): a link to a video or a recording (any page the link reader can read, such as
//     yt-dlp's thousands of sites) into its words. The page's own captions win when it has them; otherwise its sound is
//     fetched and heard here. The words are answered; nothing is kept.
//   Both run as functions of the workflows run-a-function.mjs runner, which hands each function its host (fn(input, host)).
//   A recording is read by name through host.readWholeFile (the run's files right), not through a door. Hearing is
//   do-work/audio_transcription.py `transcribe` (this folder's own seam). Link parsing, command execution and flow use
//   the recovered source helpers; this file binds them to the host and the transcription seam.
//
// Non-negotiable invariants
//   1. Never an empty answer without a reason: every road that yields no words throws an error saying why in plain
//      words (no link reader, no model, the page refused, nobody speaks), so the run fails with that reason and the AI
//      and the person know what to do next.
//   2. Which programs read links, their arguments, the caption languages and every word are DATA
//      (read-data/hear-a-link.json); this file names no site, no program and no language.
//   3. Nothing is kept on the computer after the run: the working folder is removed whatever happens.
//   4. A recording is read by the run's host into the run's own folder and removed there once heard; the person's file is
//      never changed.
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { hearingHere } from '../../computer-programs/read-data/program-here.mjs';
import { captionWords, refusedThisCopy } from './read-link-captions.mjs';
import { linkToolsFor } from './hear-link-flow.mjs';
import { fileURLToPath } from 'node:url';

export { captionWords, refusedThisCopy };

const run = promisify(execFile);
const HERE = path.dirname(fileURLToPath(new URL(import.meta.url)));
export const linkSettings = () => JSON.parse(readFileSync(path.join(HERE, 'hear-a-link.json'), 'utf8'));
const fill = (template, values) => String(template ?? '').replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? ''));
/**
 * Runs one fetcher command (a row's `info`, `captions` or `sound`), its words filled; stdout, or throws its last line.
 * With the DATA switch on (hear-a-link.json `confine`) the link reader, which reads untrusted pages, runs confined under
 * the switch's tier (the Seatbelt runner of tools/run-on-a-persons-computer): it writes only in this run's folder.
 */
export const runFetcher = (row, part, values, seconds, confine = linkSettings().confine) => {
  const [first, ...args] = row[part].map(word => fill(word, values));
  const command = row.program && first === row.check[0] ? row.program : first;
  const failure = (error, stderr = error.stderr) => new Error((String(stderr ?? '').trim().split('\n').filter(line => !/^WARNING/.test(line)).pop() || error.message).replace(/^ERROR:\s*/, ''));
  if (confine?.enabled === true) {
    return import('../../run-on-a-persons-computer/confined-run.mjs')
      .then(({ runConfined }) => runConfined(command, args, { tier: confine.tier, workspace: values.folder, timeout_ms: seconds * 1000, scoped_env: row.env ?? {} }))
      .then(done => done.stdout, error => { throw failure(error); });
  }
  return new Promise((resolve, reject) => {
    execFile(command, args, { env: row.env, maxBuffer: 64 * 1024 * 1024, timeout: seconds * 1000 }, (error, stdout, stderr) => {
      if (error) return reject(failure(error, stderr));
      resolve(String(stdout));
    });
  });
};
const expand = place => String(place).replace(/^~(?=\/|$)/, os.homedir());
const said = (template, values, status) => Object.assign(new Error(fill(template, values)), status ? { status } : {});

/** The seam's `transcribe` on one file: { text, segments, language, produced_by }, or throws the seam's last line. */
export async function hearFile(file, { modelPath, whisperCli = null, ffmpeg = null, language = '', python = 'python3', script = path.join(HERE, '..', 'do-work', 'audio_transcription.py') }, words = linkSettings().words) {
  const out = `${file}.heard.json`;
  const programs = [...(whisperCli ? ['--whisper-cli', whisperCli] : []), ...(ffmpeg ? ['--ffmpeg', ffmpeg] : [])];
  try {
    await run(python, [script, 'transcribe', '--audio', file, '--out', out, '--model-path', modelPath, ...programs], { maxBuffer: 64 * 1024 * 1024 });
  } catch (error) {
    throw new Error(String(error.stderr ?? '').trim().split('\n').pop() || error.message);
  }
  const heard = JSON.parse(readFileSync(out, 'utf8'));
  rmSync(out, { force: true });
  const segments = (heard.segments ?? []).map(({ start, end, text }) => ({ start, end, text: String(text ?? '').trim() }));
  return { text: String(heard.full_text ?? segments.map(segment => segment.text).join(' ')).trim(), segments, language: heard.language || language || null, produced_by: words.heard_by };
}

/** The hearing settings of one request; refuses without a model unless a test gives its own hearing. */
const hearingOf = (input, words) => {
  if (!String(input?.model_path ?? '').trim()) throw said(words.needs_model, {}, 400);
  return { modelPath: input.model_path, whisperCli: input.whisper_cli ?? null, ffmpeg: input.ffmpeg ?? null, language: input.language ?? '' };
};

/**
 * tool:hear-a-recording: { file, model_path, whisper_cli?, ffmpeg?, language? } -> { text, segments, language,
 * heard_whole, produced_by }: a recording from the person's files (`file`, its name or identity), read by the run's host,
 * heard free on the person's computer.
 */
export async function hearARecording(input, host, { hear = hearFile } = {}) {
  const settings = linkSettings();
  const words = settings.words;
  if (!String(input?.file ?? '').trim()) throw said(words.needs_file, {}, 400);
  const hearing = hear === hearFile ? hearingOf(input, words) : {};
  const { title, size, bytes } = await host.readWholeFile(input.file, { mostBytes: settings.most_bytes });
  if (!bytes) throw said(words.too_large, { file: input.file, size });
  const folder = mkdtempSync(path.join(os.tmpdir(), 'heard-'));
  try {
    const file = path.join(folder, `recording${path.extname(title) || '.wav'}`);
    writeFileSync(file, bytes, { mode: 0o600 });
    return { ...(await hear(file, hearing, words)), heard_whole: true };
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

/** The program a fetcher row runs: the one the person gave, else its check program in `search_path`, else on PATH. */
export function fetcherProgram(row, given = null) {
  if (given) return given;
  const name = row.check[0];
  return (row.search_path ?? []).map(folder => path.join(expand(folder), name)).find(file => existsSync(file)) ?? name;
}

/**
 * tool:hear-a-link: { url, languages?, model_path?, link_reader? } -> { url, title, duration_seconds, text,
 * segments, language, heard_whole, source: 'captions' | 'heard', produced_by }. Throws why when there are none.
 */
export async function hearALink(input, _context = {}, { fetchers = null, hear = hearFile, settings = linkSettings() } = {}) {
  const words = settings.words;
  const hearing = hear === hearFile
    ? (String(input?.model_path ?? '').trim() ? { ...hearingOf(input, words), produced_by: words.heard_by } : null)
    : { produced_by: words.heard_by };
  const flow = linkToolsFor({
    linkSettings: () => settings,
    hearingHere: rows => {
      if (!input.link_reader || !rows.length) return hearingHere(rows);
      const row = rows[0];
      const requested = String(input.link_reader);
      const exact = path.isAbsolute(requested) || requested.includes(path.sep) ? path.resolve(expand(requested)) : null;
      const found = hearingHere([{ ...row, check: [path.basename(requested), ...row.check.slice(1)], ...(exact ? { search_path: [path.dirname(exact)] } : {}) }]);
      if (!found || (exact && found.program !== exact)) return null;
      return { ...found, check: row.check };
    },
    hearWith: (row, file) => hear(file, hear === hearFile ? hearingOf(input, words) : {}, words),
    runFetcher, captionWords, refusedThisCopy, fill,
  });
  return flow.hear(input, {}, { fetchers, hearing });
}
