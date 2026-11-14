// tools/audio-transcription/read-data/hear-here.mjs
//
// Purpose
//   Hears on the person's own computer, with the whisper-cli and model they chose, so nobody pays a speech service:
//   - hearARecording (tool:hear-a-recording): a recording in the person's files into timed words.
//   - hearALink (tool:hear-a-link): a link to a video or a recording (any page the link reader can read, such as
//     yt-dlp's thousands of sites) into its words. The page's own captions win when it has them; otherwise its sound is
//     fetched and heard here. The heard sound is kept in the person's files with its words beside it (keep_sound), so
//     it is searchable and never fetched again.
//   Both run as functions of tools/records-door's run-an-export.mjs; hearing is do-work/audio_transcription.py
//   `transcribe` (this folder's own seam). Moved from the product repo's computer/listen.mjs listeningTools.transcribe and
//   computer/hear-a-link.mjs.
//
// Non-negotiable invariants
//   1. Never an empty answer without a reason: every road that yields no words throws an error saying why in plain
//      words (no link reader, no model, the page refused, nobody speaks), so the run fails with that reason and the AI
//      and the person know what to do next.
//   2. Which programs read links, their arguments, the caption languages and every word are DATA
//      (read-data/hear-a-link.json); this file names no site, no program and no language.
//   3. Nothing is kept on the computer after the run: the working folder is removed whatever happens.
//   4. Keeping the sound is a convenience: if it cannot be kept, the words are still answered, with kept_error.
//   5. A recording is read through the run's door into the run's own folder and removed there once heard; the person's
//      file is never changed.
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { readWholeFile, writeWholeFile } from '../../records-door/read-data/whole-file.mjs';

const run = promisify(execFile);
const HERE = path.dirname(new URL(import.meta.url).pathname);
export const linkSettings = () => JSON.parse(readFileSync(path.join(HERE, 'hear-a-link.json'), 'utf8'));
const fill = (template, values) => String(template ?? '').replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? ''));
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
 * heard_whole, produced_by }: a recording made anywhere, heard free on the person's computer.
 */
export async function hearARecording(input, { door }, { hear = hearFile } = {}) {
  const words = linkSettings().words;
  if (!String(input?.file ?? '').trim()) throw said(words.needs_file, {}, 400);
  const hearing = hear === hearFile ? hearingOf(input, words) : {};
  const { title, size, bytes } = await readWholeFile(door, input.file);
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
 * Runs one fetcher command (a row's `info`, `captions` or `sound`), its words filled; stdout, or throws its last line.
 * With the DATA switch on (hear-a-link.json `confine`) the link reader, which reads untrusted pages, runs confined under
 * the switch's tier (the Seatbelt runner of tools/run-on-a-persons-computer): it writes only in this run's folder.
 */
export const runFetcher = (row, part, values, seconds, confine = linkSettings().confine) => {
  const [first, ...args] = row[part].map(word => fill(word, values));
  const command = row.program && first === row.check[0] ? row.program : first;
  const failure = (error, stderr = error.stderr) => new Error((String(stderr ?? '').trim().split('\n').filter(line => !/^WARNING/.test(line)).pop() || error.message).replace(/^ERROR:\s*/, ''));
  if (confine?.enabled === true) {
    return import('../../run-on-a-persons-computer/from-old-trillion/computer/confined-run.mjs')
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

/** Whether a page refused the link reader itself (an old copy it no longer answers), which updating the reader fixes. */
export const refusedThisCopy = error => /\b(403|Forbidden|Sign in|confirm you|not a bot)\b/i.test(String(error?.message ?? error));

const seconds = stamp => {
  const parts = String(stamp).trim().replace(',', '.').split(':').map(Number);
  return parts.reduce((sum, part) => sum * 60 + part, 0);
};

/**
 * The words of a WebVTT captions file as { text, segments }: cue tags and timing are taken out, and a line a rolling
 * caption repeats in the next cue is kept once, so automatic captions read as the speech, not as each line three times.
 */
export function captionWords(vtt) {
  const segments = [];
  let last = '';
  for (const block of String(vtt).replace(/\r/g, '').split(/\n\n+/)) {
    const lines = block.split('\n');
    const at = lines.findIndex(line => line.includes('-->'));
    if (at < 0) continue;
    const [from, to] = lines[at].split('-->').map(side => side.trim().split(/\s+/)[0]);
    for (const raw of lines.slice(at + 1)) {
      const line = raw.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
      if (!line || line === last) continue;
      last = line;
      segments.push({ start: seconds(from), end: seconds(to), text: line });
    }
  }
  return { text: segments.map(segment => segment.text).join(' '), segments };
}

const fileIn = (folder, stem) => readdirSync(folder).filter(name => name.startsWith(`${stem}.`)).map(name => path.join(folder, name))[0] ?? null;

/** Keeps the heard sound in the person's files with its words beside it; returns { identity, name } or { kept_error }. */
export async function keepSound({ file, title, words, settings, door }) {
  try {
    const name = `${settings.keep_sound.folder.replace(/\/$/, '')}/${String(title || 'link').replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 120)}${path.extname(file)}`;
    const kept = await writeWholeFile(door, name, readFileSync(file), { mediaType: 'audio/*' });
    await writeWholeFile(door, `${name}.words.json`, Buffer.from(JSON.stringify(words)), { mediaType: 'application/json' });
    return { identity: kept?.identity ?? name, name };
  } catch (error) {
    return { kept_error: String(error?.message ?? error) };
  }
}

/**
 * tool:hear-a-link: { url, languages?, model_path?, link_reader?, keep_sound? } -> { url, title, duration_seconds, text,
 * segments, language, heard_whole, source: 'captions' | 'heard', produced_by, file? }. Throws why when there are none.
 */
export async function hearALink(input, context = {}, { fetchers = null, hear = hearFile, keep = keepSound } = {}) {
  const settings = linkSettings();
  const words = settings.words;
  const url = String(input?.url ?? '').trim();
  if (!/^https?:\/\//i.test(url)) throw said(words.needs_url, {}, 400);
  const fetcher = fetchers ? fetchers[0] ?? null : (settings.fetchers ?? []).map(row => ({ ...row, program: fetcherProgram(row, input.link_reader) }))[0] ?? null;
  if (!fetcher) throw said(words.no_fetcher, { url });
  const folder = mkdtempSync(path.join(os.tmpdir(), 'link-'));
  const values = { url, folder, languages: input.languages ?? settings.languages, node: process.execPath };
  const most = (settings.most_minutes ?? 30) * 60;
  const failed = error => new Error(fill(refusedThisCopy(error) && fetcher.update_hint ? words.stale_fetcher : words.fetch_failed,
    { url, error: String(error?.message ?? error), fetcher: fetcher.label ?? fetcher.id, hint: fetcher.update_hint ?? '' }));
  try {
    let info = {};
    try { info = JSON.parse(await runFetcher(fetcher, 'info', values, most)); } catch (error) { throw failed(error); }
    const about = { url, title: info.title ?? null, duration_seconds: Number.isFinite(info.duration) ? info.duration : null };
    // The page's own captions, when it has them in a language asked for.
    try { await runFetcher(fetcher, 'captions', values, most); } catch { /* no captions: the sound is heard below */ }
    const captions = fileIn(folder, 'captions');
    if (captions) {
      const read = captionWords(readFileSync(captions, 'utf8'));
      if (read.text) {
        const language = path.basename(captions).split('.').slice(-2, -1)[0] ?? null;
        return { ...about, ...read, language, heard_whole: true, source: 'captions', produced_by: words.captions_by };
      }
    }
    // No captions: the sound, heard on this computer.
    if (hear === hearFile && !String(input.model_path ?? '').trim()) throw said(words.no_hearing, { url });
    try { await runFetcher(fetcher, 'sound', values, most); } catch (error) { throw failed(error); }
    const sound = fileIn(folder, 'sound');
    if (!sound || !statSync(sound).size) throw failed(new Error('no sound came back'));
    const heard = await hear(sound, hear === hearFile ? hearingOf(input, words) : {}, words);
    if (!String(heard?.text ?? '').trim()) throw said(words.no_words, { url });
    const result = { ...about, text: heard.text, segments: heard.segments ?? [], language: heard.language ?? null, heard_whole: heard.heard_whole !== false, source: 'heard', produced_by: heard.produced_by ?? words.heard_by };
    if (settings.keep_sound?.on && context.door && input.keep_sound !== false) {
      const kept = await keep({ file: sound, title: about.title, words: { text: result.text, segments: result.segments, language: result.language, heard_whole: result.heard_whole, produced_by: result.produced_by }, settings, door: context.door });
      return { ...result, ...(kept.identity ? { file: kept.identity, file_name: kept.name } : {}), ...(kept.kept_error ? { kept_error: kept.kept_error } : {}) };
    }
    return result;
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}
