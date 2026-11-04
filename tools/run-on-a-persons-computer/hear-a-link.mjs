// computer/hear-a-link.mjs
//
// Purpose
//   Turns a link to a video or a recording (any page the Mac's link reader can read, such as yt-dlp's thousands of
//   sites) into its words on the person's Mac: tool:hear-a-link, run by computer/mac-tools.mjs on
//   placement:your-computer. The page's own captions win when it has them; otherwise its sound is fetched and heard on the
//   Mac with the first `hearing` row of computer-sources.json (the same hearing tool:hear-a-recording uses),
//   so a video with no captions costs nobody anything. The heard sound is kept in the person's files with its words on
//   it (keep_sound), so it is searchable and never fetched again.
//
// Non-negotiable invariants
//   1. Never an empty answer without a reason: every road that yields no words throws an error saying why in plain
//      words (no link reader, no hearing program, the page refused, nobody speaks), so the run fails with that reason
//      and the AI and the person know what to do next.
//   2. Which programs read links, their arguments, the caption languages and every word are DATA
//      (computer/hear-a-link.json and the hear-fetcher rows in records/hear-fetcher-records.json); this file names no site,
//      no program and no language.
//   3. Nothing is kept on the Mac after the run: the working folder is removed whatever happens.
//   4. Keeping the sound is a convenience: if it cannot be kept, the words are still answered, with kept_error.
//
import { execFile } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hearWith, hearingHere, toolCaller } from './keep-drive-files.mjs';
import { runConfined } from './confined-run.mjs';
import { withTables } from '../src/data-rows.mjs';
import fetcherRecords from '../records/hear-fetcher-records.json' with { type: 'json' };

const HERE = path.dirname(fileURLToPath(import.meta.url));
// The settings file with the link readers (`fetchers`) read from their hear-fetcher rows.
export const linkSettings = () => withTables(JSON.parse(readFileSync(path.join(HERE, 'hear-a-link.json'), 'utf8')), { fetchers: { kind: 'hear-fetcher', records: fetcherRecords } });
const fill = (template, values) => String(template ?? '').replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? ''));

/** Runs one fetcher command (a row's `info`, `captions` or `sound`), its words filled; stdout, or throws its last line. */
export const runFetcher = (row, part, values, seconds, confine = linkSettings().confine) => {
  const [first, ...args] = row[part].map(word => fill(word, values));
  const command = row.program && first === row.check[0] ? row.program : first;
  const failure = (error, stderr = error.stderr) => new Error((String(stderr ?? '').trim().split('\n').filter(line => !/^WARNING/.test(line)).pop() || error.message).replace(/^ERROR:\s*/, ''));
  // With the DATA switch on, the link reader runs confined (computer/confined-run.mjs): it writes only in this run's folder.
  if (confine?.enabled === true) {
    return runConfined(command, args, { tier: confine.tier, workspace: values.folder, timeout_ms: seconds * 1000, scoped_env: row.env ?? {} }).then(done => done.stdout, error => { throw failure(error); });
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

/** Keeps the heard sound in the person's files with its words on it; returns { identity, name } or { kept_error }. */
async function keepSound({ file, title, words, settings, context }) {
  try {
    const call = toolCaller(context.origin, context.key);
    const name = `${settings.keep_sound.folder.replace(/\/$/, '')}/${String(title || 'link').replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 120)}${path.extname(file)}`;
    const bytes = readFileSync(file);
    const started = await call('start_file_upload', { name, byte_length: bytes.length });
    if (started.send_bytes_to) {
      const sent = await fetch(started.send_bytes_to, { method: 'PUT', body: bytes, signal: AbortSignal.timeout(600_000) });
      if (!sent.ok) throw new Error(`sending the sound: ${sent.status}`);
    }
    const found = await call('find_file', { name_or_identity: name, seconds: 60 });
    const identity = found.identity;
    if (identity) await call('record_file_results', { results: [{ identity, kind: 'transcript', value: words, produced_by: words.produced_by }] });
    return { identity, name };
  } catch (error) {
    return { kept_error: String(error?.message ?? error) };
  }
}

export const linkTools = {
  /**
   * The words said in a video or recording at a link: { url, languages? } -> { url, title, duration_seconds, text,
   * segments, language, heard_whole, source: 'captions' | 'heard', produced_by, file? }. Throws why when there are none.
   */
  async hear(input, context = {}, { fetchers = null, hearing = undefined, hear = hearWith, keep = keepSound } = {}) {
    const settings = linkSettings();
    const words = settings.words;
    const url = String(input?.url ?? '').trim();
    if (!/^https?:\/\//i.test(url)) throw Object.assign(new Error(words.needs_url), { status: 400 });
    const fetcher = fetchers ? fetchers[0] ?? null : hearingHere(settings.fetchers ?? []);
    if (!fetcher) throw new Error(fill(words.no_fetcher, { url }));
    const folder = mkdtempSync(path.join(os.tmpdir(), 'trillion-link-'));
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
      // No captions: the sound, heard on this Mac.
      const hearingRow = hearing === undefined ? hearingHere(JSON.parse(readFileSync(path.join(HERE, 'computer-sources.json'), 'utf8')).hearing ?? []) : hearing;
      if (!hearingRow) throw new Error(fill(words.no_hearing, { url }));
      try { await runFetcher(fetcher, 'sound', values, most); } catch (error) { throw failed(error); }
      const sound = fileIn(folder, 'sound');
      if (!sound || !statSync(sound).size) throw failed(new Error('no sound came back'));
      const heard = await hear(hearingRow, sound);
      if (!String(heard?.text ?? '').trim()) throw new Error(fill(words.no_words, { url }));
      const result = { ...about, text: heard.text, segments: heard.segments ?? [], language: heard.language ?? null, heard_whole: heard.heard_whole !== false, source: 'heard', produced_by: heard.produced_by ?? hearingRow.produced_by };
      if (settings.keep_sound?.on && context.key && context.origin && input.keep_sound !== false) {
        const kept = await keep({ file: sound, title: about.title, words: { text: result.text, segments: result.segments, language: result.language, heard_whole: result.heard_whole, produced_by: result.produced_by }, settings, context });
        return { ...result, ...(kept.identity ? { file: kept.identity, file_name: kept.name } : {}), ...(kept.kept_error ? { kept_error: kept.kept_error } : {}) };
      }
      return result;
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  },
};
