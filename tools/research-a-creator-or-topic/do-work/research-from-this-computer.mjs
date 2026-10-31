// tools/research-a-creator-or-topic/do-work/research-from-this-computer.mjs
//
// The research steps that need the person's own computer: a channel's latest videos and a video's captions (both by
// yt-dlp, which the person has installed) and the items in a list saved in a file. Nothing leaves the computer except
// what yt-dlp itself asks the video site for.
//
//   node research-from-this-computer.mjs channel    --channel LINK|ID|@HANDLE --out FILE [--limit 30] [--yt-dlp PATH]
//   node research-from-this-computer.mjs captions   --video ID|LINK --out FILE [--watch-base ADDRESS] [--langs en,en-orig] [--js-runtimes node] [--yt-dlp PATH]
//   node research-from-this-computer.mjs saved-list --file FILE --out FILE [--shape list|browser-sidebar] [--limit 5000]
//
// The answer is written to --out and its summary is the last line printed: {"result": ...}, or {"failed": {code, message}}
// with exit 2 (bad-request, no-yt-dlp, no-listing, unreadable-file).
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CAPTION_FORMATS, captionFileOrder, channelListingUrl, DEFAULT_WATCH_BASE, MAX_SAVED_ITEMS, readBrowserSidebar, readCaptionFile,
  readChannelListing, readSavedList,
} from './sources.mjs';

export class Refusal extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

const tail = text => String(text ?? '').slice(-400);

function runYtDlp(run, ytDlp, args, timeout) {
  const done = run(ytDlp, args, { encoding: 'utf8', timeout });
  if (done.error?.code === 'ENOENT') throw new Refusal('no-yt-dlp', `${ytDlp} was not found. Install yt-dlp, or give its path with --yt-dlp.`);
  return done;
}

// A channel's latest videos, newest first as yt-dlp lists them.
export function channelVideos({ channel, limit = 30, ytDlp = 'yt-dlp', run = spawnSync }) {
  let url;
  try { url = channelListingUrl(channel); } catch (error) { throw new Refusal('bad-request', error.message); }
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Refusal('bad-request', 'limit is a whole number from 1 to 500.');
  const done = runYtDlp(run, ytDlp, [
    '--flat-playlist', '--dump-json', '--playlist-end', String(limit), '--retries', '5', '--extractor-retries', '3', '--socket-timeout', '30', url,
  ], 80_000);
  if (!String(done.stdout ?? '').trim()) throw new Refusal('no-listing', `yt-dlp listed no videos for ${url}: ${tail(done.stderr) || 'no reason given'}`);
  const listing = readChannelListing(done.stdout);
  return { source: listing.source, subject_ref: String(channel).trim(), listing_url: url, count: listing.items.length, items: listing.items };
}

const videoIdOf = video => {
  try {
    const url = new URL(video);
    return url.searchParams.get('v') || url.pathname.split('/').filter(Boolean).at(-1) || video;
  } catch { return video; }
};

// A video's spoken words, from the captions the video site holds for it (the auto-made ones when there are no others).
export function videoCaptions({ video, watchBase = DEFAULT_WATCH_BASE, langs = 'en,en-orig', jsRuntimes, ytDlp = 'yt-dlp', run = spawnSync }) {
  const given = String(video ?? '').trim();
  if (!given) throw new Refusal('bad-request', 'Say which video: its id or its link.');
  const url = /^https?:\/\//i.test(given) ? given : `${watchBase}${given}`;
  const work = mkdtempSync(join(tmpdir(), 'captions-'));
  try {
    const done = runYtDlp(run, ytDlp, [
      '--skip-download', '--write-subs', '--write-auto-sub', '--sub-langs', langs, '--sub-format', CAPTION_FORMATS, ...(jsRuntimes ? ['--js-runtimes', jsRuntimes] : []), '--retries', '10', '--extractor-retries', '5',
      '--sleep-requests', '1', '--sleep-subtitles', '2', '--socket-timeout', '30', '--retry-sleep', 'http:exp=1:120', '-o', join(work, 'sub'), url,
    ], 280_000);
    const [first] = captionFileOrder(readdirSync(work));
    const transcript = first ? readCaptionFile(first, readFileSync(join(work, first), 'utf8')) : '';
    return {
      video_id: videoIdOf(given), url, parser: first ? `caption-${first.split('.').at(-1)}` : 'none', has_captions: transcript !== '', char_count: transcript.length,
      transcript, stderr_tail: transcript ? '' : tail(done.stderr), status: transcript ? 'ready' : 'empty',
    };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// The items in a list saved as a JSON file on this computer.
export function savedList({ file, shape = 'list', limit = MAX_SAVED_ITEMS }) {
  if (!file) throw new Refusal('bad-request', 'Say which file: --file PATH.');
  if (!['list', 'browser-sidebar'].includes(shape)) throw new Refusal('bad-request', 'shape is list or browser-sidebar.');
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SAVED_ITEMS) throw new Refusal('bad-request', `limit is a whole number from 1 to ${MAX_SAVED_ITEMS}.`);
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { throw new Refusal('unreadable-file', `${file} could not be read.`); }
  let read;
  try { read = (shape === 'list' ? readSavedList : readBrowserSidebar)(text, limit); } catch (error) { throw new Refusal('unreadable-file', error.message); }
  return { source: read.source, subject_ref: file, count: read.items.length, items: read.items };
}

function options(argv) {
  const found = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--') || argv[i + 1] === undefined) throw new Refusal('bad-request', `${argv[i]} needs a value.`);
    found[argv[i].slice(2)] = argv[i + 1];
  }
  return found;
}
const whole = (value, fallback) => (value === undefined ? fallback : Number(value));

export function main(argv, run = spawnSync) {
  const [command, ...rest] = argv;
  const given = options(rest);
  if (!given.out) throw new Refusal('bad-request', 'Say where to write the answer: --out FILE.');
  let answer;
  if (command === 'channel') answer = channelVideos({ channel: given.channel, limit: whole(given.limit, 30), ytDlp: given['yt-dlp'], run });
  else if (command === 'captions') answer = videoCaptions({ video: given.video, watchBase: given['watch-base'], langs: given.langs, jsRuntimes: given['js-runtimes'], ytDlp: given['yt-dlp'], run });
  else if (command === 'saved-list') answer = savedList({ file: given.file, shape: given.shape, limit: whole(given.limit, MAX_SAVED_ITEMS) });
  else throw new Refusal('bad-request', 'The command is channel, captions or saved-list.');
  writeFileSync(given.out, JSON.stringify(answer));
  // The words of a video can be long; the summary names the file they are in.
  const { transcript: _words, items: _items, ...summary } = answer;
  return { ...summary, out: given.out };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(`${JSON.stringify({ result: main(process.argv.slice(2)) })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ failed: { code: error.code ?? 'failed', message: error.message } })}\n`);
    process.exitCode = 2;
  }
}
