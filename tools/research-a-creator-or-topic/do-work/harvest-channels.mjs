// tools/research-a-creator-or-topic/do-work/harvest-channels.mjs
//
// tool:keep-channels-latest-videos-and-captions. For each seed (a channel's @handle, id or link, a link to one of its
// tabs, or a playlist link) it lists the newest videos with yt-dlp, then fetches each new video's captions and the
// site's own description of it (and its top comments when asked), never the video itself. It asks politely: one request
// at a time, a wait drawn from a range between requests, a bounded number of requests and seconds in one run, and a stop
// at the first refusal (the site asking whether the caller is a robot, or answering too many requests). How polite is
// DATA (harvest-settings.json); nothing about any channel, topic or list is known here.
//
// A run that stops early answers what it did and `again`: the input to send next (the seeds not finished, and the ids
// settled now added to skip_ids), with `wait_minutes` to wait first after a refusal. The caller repeats until `again` is
// null. The run writes three files in its working folder, always all three, for the engine to keep in the person's files
// (the row's invoke.outputs):
//   out/listing.json    { seeds: [{ seed, listing_url, source, items: [{ video_id, title, url, published, duration, view_count, kept_before }] }] }
//   out/captions.jsonl  one line per video settled now: { video_id, url, seed, status, language, format, lines, info, reason? }
//   out/comments.jsonl  one line per video whose comments were asked for: { video_id, comments }
// With `rows`, one row per seed or per video settled now goes into the person's list through the records door, written
// over the row already held, so the fields the person keeps by hand stay.
//
//   node /opt/records-door/do-work/run-an-export.mjs /opt/research-a-creator-or-topic/do-work/harvest-channels.mjs keepChannelsLatestVideosAndCaptions < input.json
import { execFile } from 'node:child_process';
import { accessSync, constants, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { lineFile, minutesToWait, picked, politeQueue, readPoliteness, readRowsSpec, readSettings, refuse, Stop, tail, wholeIn, words, writeRows } from './harvest-parts.mjs';
import { channelListingUrl, readCaptionLines, readChannelListing } from './sources.mjs';

const INPUTS = new Set(['seeds', 'newest', 'between', 'eras', 'caption_languages', 'skip_ids', 'budget_seconds', 'also', 'comments_per_video', 'comment_mix', 'refusals_in_a_row', 'rows']);
const SEED_KEYS = new Set(['seed', 'id', 'newest']);
const MIX_KINDS = ['question', 'disagreement', 'oldest', 'newest'];
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const ALSO = new Set(['comments']);
const ONE_PER = ['seed', 'video'];
const LANGUAGE = /^-?[A-Za-z0-9.*+_-]{1,40}$/;
const LANGUAGE_HINT = ' (language codes as the site writes them, * for any ending)';

export { readSettings };

// One seed: its words, or { seed, id, newest }: the id of the row it updates and how many of its videos to keep.
function readSeed(item, settings) {
  if (typeof item === 'string' && item.trim()) return { seed: item.trim(), id: null, newest: null, given: item };
  const keys = item && typeof item === 'object' && !Array.isArray(item) ? Object.keys(item) : [];
  if (!keys.includes('seed') || keys.some(key => !SEED_KEYS.has(key)) || typeof item.seed !== 'string' || !item.seed.trim()) refuse('Each seed is words, or { seed, id, newest }.');
  if (item.id !== undefined && (typeof item.id !== 'string' || !item.id.trim() || item.id.includes('/'))) refuse('A seed\'s id is a word without a /.');
  return {
    seed: item.seed.trim(),
    id: item.id === undefined ? null : item.id.trim(),
    newest: item.newest === undefined ? null : wholeIn(item.newest, 'a seed\'s newest', 1, settings.newest_at_most),
    given: item,
  };
}

// The days a request keeps: { from, to } as YYYY-MM-DD, either one alone.
function readWindow(between) {
  if (between === undefined) return null;
  const keys = between && typeof between === 'object' && !Array.isArray(between) ? Object.keys(between) : [];
  const ok = keys.length > 0 && keys.every(key => (key === 'from' || key === 'to') && typeof between[key] === 'string' && DAY.test(between[key]) && !Number.isNaN(Date.parse(between[key])));
  if (!ok) refuse('between is { from, to } as YYYY-MM-DD days, with at least one.');
  if (between.from && between.to && between.from > between.to) refuse('between.from is not after between.to.');
  return { from: between.from ?? null, to: between.to ?? null };
}

// The comment mix: for `videos` of each seed's kept videos (spread evenly across them), read `read` comments and keep up to
// the asked number of each kind: questions, disagreements (the words are DATA), the oldest and the newest.
function readMix(mix, settings) {
  if (mix === undefined) return null;
  const { videos_at_most: videos, read_default: readDefault, each_at_most: each } = settings.comment_mix;
  const unknown = Object.keys(mix && typeof mix === 'object' && !Array.isArray(mix) ? mix : { '': 0 }).filter(key => !['videos', 'read', ...MIX_KINDS].includes(key));
  if (unknown.length) refuse('comment_mix is { videos, read, question, disagreement, oldest, newest }.');
  const kinds = Object.fromEntries(MIX_KINDS.filter(kind => mix[kind] !== undefined).map(kind => [kind, wholeIn(mix[kind], `comment_mix.${kind}`, 0, each)]));
  if (!Object.values(kinds).some(count => count > 0)) refuse('comment_mix asks for at least one comment of some kind.');
  return {
    videos: wholeIn(mix.videos, 'comment_mix.videos', 1, videos),
    read: mix.read === undefined ? readDefault : wholeIn(mix.read, 'comment_mix.read', 1, settings.comments_per_video_at_most),
    kinds,
  };
}

// The input, checked whole before any request: anything it does not say plainly is refused, never guessed.
export function readRequest(input, settings) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) refuse('Send an object.');
  const unknown = Object.keys(input).filter(key => !INPUTS.has(key));
  if (unknown.length) refuse(`Unknown input: ${unknown.join(', ')}.`);
  const also = input.also === undefined ? [] : words(input.also, 'also', 0, ALSO.size);
  if (also.some(item => !ALSO.has(item))) refuse(`also holds only: ${[...ALSO].join(', ')}.`);
  const comments = also.includes('comments');
  if (!comments && input.comments_per_video !== undefined) refuse('comments_per_video goes with also: ["comments"].');
  const mix = readMix(input.comment_mix, settings);
  if (mix && comments) refuse('comment_mix and also: ["comments"] are two ways to ask for comments; send one.');
  const seeds = (Array.isArray(input.seeds) ? input.seeds : refuse(`seeds is a list of 1 to ${settings.seeds_at_most}.`)).map(item => readSeed(item, settings));
  if (!seeds.length || seeds.length > settings.seeds_at_most) refuse(`seeds is a list of 1 to ${settings.seeds_at_most}.`);
  const newest = input.newest === undefined ? null : wholeIn(input.newest, 'newest', 1, settings.newest_at_most);
  const lacking = seeds.find(seed => seed.newest === null && newest === null);
  if (lacking) refuse(`newest is needed: ${lacking.seed} has none of its own.`);
  const eras = input.eras === undefined ? null : wholeIn(input.eras, 'eras', 2, settings.eras_at_most);
  const rows = input.rows === undefined ? null : readRowsSpec(input.rows, ONE_PER, onePer => onePer === 'seed' && seeds.every(seed => seed.id));
  return {
    seeds,
    newest,
    window: readWindow(input.between),
    eras,
    mix,
    languages: words(input.caption_languages, 'caption_languages', 1, settings.languages_at_most, LANGUAGE, LANGUAGE_HINT),
    skip: new Set(input.skip_ids === undefined ? [] : words(input.skip_ids, 'skip_ids', 0, settings.skip_ids_at_most)),
    comments: comments ? wholeIn(input.comments_per_video, 'comments_per_video', 1, settings.comments_per_video_at_most) : 0,
    ...readPoliteness(input, settings),
    rows,
  };
}

const dayNumber = published => {
  const digits = String(published ?? '').replace(/\D/g, '').slice(0, 8);
  return digits.length === 8 ? Date.UTC(+digits.slice(0, 4), +digits.slice(4, 6) - 1, +digits.slice(6, 8)) / 86400000 : null;
};

// Of a listing (newest first), the videos to keep: the newest `count`; inside the asked days when there are any; and with
// `eras`, the days split into that many equal spans, each keeping the newest of its share (the remainder going to the
// newest spans). Videos with no date are left out when days or eras are asked.
export function selectVideos(items, { count, window, eras }) {
  if (!window && !eras) return { items: items.slice(0, count), undated: 0 };
  const dated = items.map(item => ({ item, day: dayNumber(item.published) }));
  const within = dated.filter(({ day }) => day !== null
    && (!window?.from || day >= dayNumber(window.from)) && (!window?.to || day <= dayNumber(window.to)));
  const undated = dated.filter(({ day }) => day === null).length;
  if (!eras) return { items: within.slice(0, count).map(({ item }) => item), undated };
  if (!within.length) return { items: [], undated };
  const days = within.map(({ day }) => day);
  const low = window?.from ? dayNumber(window.from) : Math.min(...days);
  const high = window?.to ? dayNumber(window.to) : Math.max(...days);
  const era = day => Math.min(eras - 1, Math.floor(((day - low) / (high - low + 1)) * eras));
  const share = index => Math.floor(count / eras) + (index >= eras - (count % eras) ? 1 : 0);
  const taken = new Array(eras).fill(0);
  const kept = within.filter(({ day }) => {
    const index = era(day);
    if (taken[index] >= share(index)) return false;
    taken[index] += 1;
    return true;
  });
  return { items: kept.map(({ item }) => ({ ...item, era: era(dayNumber(item.published)) + 1 })), undated };
}

// Which of a seed's kept videos have their comments read for the mix: `videos` of them, spread evenly across the list.
export function spreadAcross(items, videos) {
  const many = Math.min(videos, items.length);
  return Array.from({ length: many }, (_, at) => items[Math.floor(((at + 0.5) * items.length) / many)]);
}

// Of the comments read, up to the asked number of each kind; a comment is in one kind only.
export function mixComments(read, kinds, words, fields) {
  const pool = read.filter(comment => comment && typeof comment.text === 'string');
  const spoken = new RegExp(`\\b(?:${words.map(word => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`, 'i');
  const stamped = pool.filter(comment => Number.isFinite(comment.timestamp));
  const lists = {
    question: pool.filter(comment => comment.text.includes('?')),
    disagreement: pool.filter(comment => spoken.test(comment.text)),
    oldest: [...stamped].sort((a, b) => a.timestamp - b.timestamp),
    newest: [...stamped].sort((a, b) => b.timestamp - a.timestamp),
  };
  const used = new Set();
  const kept = [];
  for (const kind of MIX_KINDS) {
    let room = kinds[kind] ?? 0;
    for (const comment of lists[kind]) {
      if (room === 0) break;
      if (used.has(comment)) continue;
      used.add(comment);
      kept.push({ ...picked(comment, fields), kind });
      room -= 1;
    }
  }
  return kept;
}

// The program, from the folders the settings name, then the run's PATH.
export function findProgram({ name, places, places_under_home: underHome }) {
  const folders = [...places, ...underHome.map(place => join(userInfo().homedir, place)), ...String(process.env.PATH ?? '').split(delimiter)];
  for (const folder of folders.filter(Boolean)) {
    const path = join(folder, name);
    try {
      if (statSync(path).isFile()) { accessSync(path, constants.X_OK); return path; }
    } catch { /* not in this folder */ }
  }
  return refuse(`${name} was not found on this computer. Install it, or add the folder it is in to harvest-settings.json.`);
}

// Of the caption files one request left, the first requested language that has one (of the languages one pattern
// matches, the shortest name: a plain track before a translated one), json3 before WebVTT.
export function pickCaptionFile(names, videoId, languages) {
  const kinds = ['json3', 'vtt'];
  const patterns = languages.filter(language => !language.startsWith('-')).map(language => new RegExp(`^(?:${language})$`));
  const found = names.map(name => {
    const kind = name.slice(name.lastIndexOf('.') + 1);
    const language = name.slice(videoId.length + 1, name.lastIndexOf('.'));
    return { name, kind, language, rank: patterns.findIndex(pattern => pattern.test(language)) };
  }).filter(file => file.name.startsWith(`${videoId}.`) && kinds.includes(file.kind) && file.rank >= 0);
  return found.sort((a, b) => a.rank - b.rank || a.language.length - b.language.length || kinds.indexOf(a.kind) - kinds.indexOf(b.kind) || a.name.localeCompare(b.name))[0] ?? null;
}

function runProgram(program, args, seconds, most) {
  return new Promise(done => {
    execFile(program, args, { timeout: Math.max(1, Math.floor(seconds * 1000)), killSignal: 'SIGKILL', maxBuffer: most, encoding: 'utf8' }, (error, stdout, stderr) => {
      done({ stdout, stderr: `${stderr}${error && !error.killed && !stderr ? error.message : ''}`, killed: Boolean(error?.killed) });
    });
  });
}

export async function keepChannelsLatestVideosAndCaptions(input, context = {}, {
  settings = readSettings(),
  out = resolve('out'),
  now = () => performance.now() / 1000,
  sleep = seconds => new Promise(done => setTimeout(done, seconds * 1000)),
  random = Math.random,
} = {}) {
  const asked = readRequest(input, settings);
  const program = findProgram(settings.program);
  const always = [...settings.program.always, ...(settings.program.js_runtime_option ? [settings.program.js_runtime_option, `node:${process.execPath}`] : [])];
  mkdirSync(out, { recursive: true });
  const captions = lineFile(join(out, 'captions.jsonl'), settings.file_bytes_at_most);
  const comments = lineFile(join(out, 'comments.jsonl'), settings.file_bytes_at_most);
  const listing = { seeds: [] };
  const started = now();
  const ends = started + asked.budget - (asked.rows ? settings.seconds_kept_for_records : 0);
  const queue = politeQueue(settings, { ends, now, sleep, random });
  const skip = new Set(asked.skip);
  const settled = [];
  const failed = [];
  const counts = { ready: 0, empty: 0, comments: 0 };
  const seeds = [];
  const videoFacts = [];
  const mixVideos = new Set();
  let commentsKeptNow = 0;
  let stopped = 'finished';

  // One request, politely: the queue says when it may start and for how long; this runs the program and reads its words.
  async function request(args) {
    const { seconds, atEnd } = await queue.begin();
    const ran = await runProgram(program, [...always, ...args], seconds, settings.file_bytes_at_most);
    queue.check(ran.stderr);
    if (ran.killed && atEnd) throw new Stop('budget');
    return ran.killed ? { ...ran, stderr: `the request took longer than ${settings.request_seconds_at_most} seconds` } : ran;
  }

  // One video's captions, description and (when asked) comments, from one request.
  async function settle(item, seed) {
    const work = mkdtempSync(join(tmpdir(), 'captions-'));
    try {
      const reading = asked.mix ? (mixVideos.has(item.video_id) ? asked.mix.read : 0) : asked.comments;
      commentsKeptNow = 0;
      const commentArgs = reading ? settings.comment_arguments.map(arg => arg.replace('{count}', String(reading))) : [];
      const ran = await request([...settings.caption_arguments, '--sub-langs', asked.languages.join(','), ...commentArgs, '-o', join(work, '%(id)s.%(ext)s'), item.url]);
      const names = readdirSync(work);
      const infoName = names.find(name => name === `${item.video_id}.info.json`);
      let line;
      let info = null;
      if (!infoName) {
        line = { video_id: item.video_id, url: item.url, seed, status: 'failed', reason: tail(ran.stderr) || 'the site described no video' };
      } else {
        info = JSON.parse(readFileSync(join(work, infoName), 'utf8'));
        const file = pickCaptionFile(names, item.video_id, asked.languages);
        const lines = file ? readCaptionLines(file.name, readFileSync(join(work, file.name), 'utf8')) : [];
        line = {
          video_id: item.video_id, url: item.url, seed, status: lines.length ? 'ready' : 'empty',
          language: lines.length ? file.language : null, format: lines.length ? file.kind : null, lines, info: picked(info, settings.info_fields),
        };
      }
      if (!captions.add(line)) {
        if (!captions.empty) throw new Stop('files');
        line = { video_id: item.video_id, url: item.url, seed, status: 'failed', reason: 'its captions are larger than one file holds' };
        captions.add(line);
      }
      if (reading && info) {
        const read = info.comments ?? [];
        const kept = asked.mix
          ? { video_id: item.video_id, read: read.length, comments: mixComments(read, asked.mix.kinds, settings.comment_mix.disagreement_words, settings.comment_fields) }
          : { video_id: item.video_id, comments: read.map(comment => picked(comment, settings.comment_fields)) };
        if (!comments.add(kept)) throw new Stop('files');
        counts.comments += 1;
        commentsKeptNow = kept.comments.length;
      }
      if (line.status === 'failed') failed.push({ video_id: item.video_id, reason: line.reason });
      else counts[line.status] += 1;
      return line;
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }

  try {
    for (const { seed, id: rowId, newest: own } of asked.seeds) {
      const count = own ?? asked.newest;
      const windowed = Boolean(asked.window || asked.eras);
      let listingUrl;
      try { listingUrl = channelListingUrl(seed); } catch (error) { seeds.push({ seed, finished: true, error: error.message }); continue; }
      const ran = await request([...settings.listing_arguments, '--playlist-end', String(windowed ? settings.window_list_at_most : count), listingUrl]);
      const found = readChannelListing(ran.stdout, settings.watch_address_start);
      if (!found.items.length) {
        seeds.push({ seed, listing_url: listingUrl, finished: true, error: tail(ran.stderr) || 'the site listed no videos' });
        continue;
      }
      const chosen = selectVideos(found.items.map(item => ({
        video_id: item.item_id, title: item.title, url: item.url, published: item.published, duration: item.duration[0] ?? null,
        view_count: item.view_count, kept_before: skip.has(item.item_id),
      })), { count, window: asked.window, eras: asked.eras });
      const items = chosen.items;
      if (!items.length) {
        seeds.push({ seed, listing_url: listingUrl, finished: true, error: 'the site listed no videos inside the days asked for', undated: chosen.undated });
        continue;
      }
      if (asked.mix) for (const item of spreadAcross(items, asked.mix.videos)) mixVideos.add(item.video_id);
      listing.seeds.push({ seed, listing_url: listingUrl, source: found.source, items });
      const told = {
        seed, ...(rowId ? { row_id: rowId } : {}), listing_url: listingUrl, source: found.source, listed: items.length,
        kept: items.filter(item => item.kept_before).length, comments_kept: 0, ...(windowed ? { undated: chosen.undated } : {}), finished: false,
      };
      seeds.push(told);
      for (const item of items) {
        if (skip.has(item.video_id)) continue;
        const line = await settle(item, seed);
        skip.add(item.video_id);
        settled.push(item.video_id);
        told.kept += 1;
        told.comments_kept += commentsKeptNow;
        videoFacts.push({ ...item, seed, listing_url: listingUrl, source: found.source, caption_status: line.status, caption_language: line.language ?? null });
      }
      told.finished = true;
    }
  } catch (error) {
    if (!(error instanceof Stop)) throw error;
    stopped = error.why;
  }
  writeFileSync(join(out, 'listing.json'), JSON.stringify(listing));

  const rows = asked.rows ? await writeRows(asked.rows, asked.rows.one_per === 'video' ? videoFacts : seeds.filter(seed => seed.listing_url && seed.source !== undefined), asked.rows.one_per === 'video' ? 'video_id' : 'seed', context, settings) : null;
  // Rows that could not be written leave this run's videos unsettled: the next run lists and settles them again.
  const unfinished = rows?.error ? asked.seeds.map(seed => seed.given) : asked.seeds.filter((_, at) => !seeds[at]?.finished).map(seed => seed.given);
  const keptIds = rows?.error ? [...asked.skip] : [...skip];
  const again = unfinished.length ? {
    ...Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'refusals_in_a_row')),
    seeds: unfinished,
    skip_ids: keptIds.slice(-settings.skip_ids_at_most),
    ...(stopped === 'refusal' ? { refusals_in_a_row: asked.refusals + 1 } : {}),
  } : null;
  return {
    stopped,
    requests: queue.requests,
    seconds: Math.round((now() - started) * 10) / 10,
    seeds,
    captions: { ready: counts.ready, empty: counts.empty, failed },
    comments: counts.comments,
    settled: settled.length,
    ...(rows ? { rows } : {}),
    ...(stopped === 'refusal' ? { wait_minutes: minutesToWait(asked.refusals, settings.pause_after_refusal) } : {}),
    again,
  };
}
