// tools/research-a-creator-or-topic/do-work/pull-in-a-creator.mjs
//
// Pulls one creator's whole public output on YouTube, X and Instagram into a folder on this computer, and writes the
// rows that describe it. It runs on the person's own computer: yt-dlp lists and downloads, ffmpeg cuts frames, mlx
// Whisper hears a video that has no captions, and the treg command asks treg's catalog for X and Instagram lists (the
// key stays with treg). Every file is named by its BLAKE3 identity in the rows. Nothing is written to a database here:
// the rows go to rows.jsonl for the person's AI to keep (one line {table, row}).
//
//   node pull-in-a-creator.mjs --creator FILE.json --out FOLDER [--only list|words|frames] [--newest N] [--media none|video]
//                              [--platforms youtube,x,instagram] [--tag NAME]   (--tag names this run's items-NAME.jsonl and rows-NAME.jsonl)
//
// FILE.json is {slug, name, accounts: [{platform: youtube|x|instagram, handle}]}. Re-running is safe: an item whose
// files are already in FOLDER is not asked for again, and rows carry fixed ids.
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const settings = JSON.parse(readFileSync(join(here, 'pull-in-a-creator-settings.json'), 'utf8'));

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, word, i, all) =>
  word.startsWith('--') ? [...pairs, [word.slice(2), all[i + 1]?.startsWith('--') || all[i + 1] === undefined ? 'true' : all[i + 1]]] : pairs, []));
if (!args.creator || !args.out) { console.error('usage: --creator FILE.json --out FOLDER'); process.exit(2); }
const creator = JSON.parse(readFileSync(args.creator, 'utf8'));
const out = args.out;
const newest = args.newest ? Number(args.newest) : Infinity;
const only = args.only ?? 'all';
const wantMedia = (args.media ?? 'video') !== 'none';
const platforms = args.platforms ? args.platforms.split(',') : null;
const tag = args.tag ? `-${args.tag}` : '';
mkdirSync(out, { recursive: true });

const sleep = s => new Promise(r => setTimeout(r, s * 1000));
const polite = () => sleep(settings.seconds_between_requests[0] + Math.random() * (settings.seconds_between_requests[1] - settings.seconds_between_requests[0]));
const run = (cmd, argv, timeout = 600_000) => spawnSync(cmd, argv, { encoding: 'utf8', timeout, maxBuffer: 512 * 1024 * 1024 });
const at = (obj, path) => Array.isArray(path) ? path.map(p => at(obj, p)).find(v => v != null)
  : path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
const b3 = file => run('b3sum', ['--no-names', file]).stdout.trim();
const say = (...words) => console.error(new Date().toISOString(), ...words);

const rowsFile = join(out, `rows${tag}.jsonl`);
const keep = (table, row) => appendFileSync(rowsFile, JSON.stringify({ table, row }) + '\n');

// ---------- listing ----------
function treg(endpoint, method, fields) {
  const argv = ['call', endpoint, '--method', method];
  if (method === 'GET') for (const [k, v] of Object.entries(fields)) argv.push('--query', `${k}=${v}`);
  else argv.push('--data', JSON.stringify(fields));
  const done = run('treg', argv, 180_000);
  try { return JSON.parse(done.stdout); } catch { throw new Error(`treg ${endpoint} answered no JSON: ${(done.stderr || '').slice(-300)}`); }
}

async function listYoutube(account) {
  const items = [];
  for (const tab of settings.lists.youtube.tabs) {
    const url = `https://www.youtube.com/${account.handle.startsWith('UC') ? 'channel/' + account.handle : account.handle}/${tab}`;
    const done = run('yt-dlp', ['--flat-playlist', '--dump-json', '--extractor-retries', '3', url], 300_000);
    for (const line of done.stdout.split('\n').filter(Boolean)) {
      const v = JSON.parse(line);
      items.push({ platform: 'youtube', account: account.handle, tab, id: v.id, url: `https://www.youtube.com/watch?v=${v.id}`,
        title: v.title, text: v.description ?? null, duration: v.duration ?? null, views: v.view_count ?? null,
        published: v.timestamp ? new Date(v.timestamp * 1000).toISOString() : null, is_video: true, media: [] });
    }
    await polite();
  }
  return items;
}

async function listPaged(platform, account) {
  const s = settings.lists[platform];
  const items = [];
  let cursor = null;
  for (let page = 0; page < settings.pages_at_most; page++) {
    const fields = { [s.handle_field]: account.handle, ...(s.page_size ? { limit: s.page_size } : {}), ...(cursor ? { [s.cursor_field]: cursor } : {}) };
    const answer = treg(s.endpoint, s.method, fields);
    const got = at(answer, s.items) ?? [];
    items.push(...got.map(p => platform === 'x' ? xItem(account, p) : igItem(account, p)));
    const next = s.next.map(p => at(answer, p)).find(Boolean);
    const more = s.more ? at(answer, s.more) : true;
    say(platform, account.handle, 'page', page + 1, 'got', got.length, 'total', items.length);
    if (!got.length || !next || !more || next === cursor || items.length >= newest) break;
    cursor = next;
    await polite();
  }
  return items;
}

const xItem = (account, p) => ({
  platform: 'x', account: account.handle, id: String(p.id), url: p.url ?? `https://x.com/${account.handle}/status/${p.id}`,
  title: null, text: p.text ?? '', published: p.createdUtc ? new Date(p.createdUtc * 1000).toISOString() : (p.createdAt ?? null),
  views: p.views ?? null, likes: p.likes ?? null, replies: p.replies ?? null, reposts: p.retweets ?? null, bookmarks: p.bookmarks ?? null,
  is_reply: Boolean(p.isReply), conversation: p.conversationId ?? null,
  media: (p.media ?? []).map(m => ({ kind: m.type ?? m.kind ?? (m.videoUrl || m.video_url ? 'video' : 'photo'), url: m.url ?? m.mediaUrl ?? m.media_url_https ?? null, video: m.videoUrl ?? m.video_url ?? null })),
  is_video: (p.media ?? []).some(m => /video|gif/i.test(m.type ?? m.kind ?? '') || m.videoUrl || m.video_url),
});

const igItem = (account, p) => ({
  platform: 'instagram', account: account.handle, id: p.code, url: p.url ?? `https://www.instagram.com/p/${p.code}/`,
  title: null, text: p.caption?.text ?? p.caption ?? '', published: p.taken_at ? new Date(p.taken_at * 1000).toISOString() : null,
  views: p.play_count ?? p.ig_play_count ?? null, likes: p.like_count ?? null, replies: p.comment_count ?? null,
  duration: p.video_duration ?? null, kind: p.product_type ?? String(p.media_type ?? ''),
  media: [
    ...(p.carousel_media ?? []).map(m => ({ kind: m.video_versions ? 'video' : 'photo', url: m.image_versions2?.candidates?.[0]?.url ?? null, video: m.video_versions?.[0]?.url ?? null })),
    ...(!p.carousel_media ? [{ kind: p.video_url ? 'video' : 'photo', url: p.image_versions2?.candidates?.[0]?.url ?? p.display_uri ?? null, video: p.video_url ?? p.video_versions?.[0]?.url ?? null }] : []),
  ],
  is_video: Boolean(p.video_url || p.video_versions),
});

// ---------- per item files ----------
const itemDir = it => join(out, it.platform, it.id);

function captions(it) {
  const dir = itemDir(it);
  const done = join(dir, 'words.json');
  if (existsSync(done)) return JSON.parse(readFileSync(done, 'utf8'));
  mkdirSync(dir, { recursive: true });
  if (!existsSync(join(dir, 'thumbnail.jpg'))) run('curl', ['-sSfL', '--max-time', '60', '-o', join(dir, 'thumbnail.jpg'), `https://i.ytimg.com/vi/${it.id}/maxresdefault.jpg`]);
  const s = settings.words.youtube_transcript;
  let answer = null;
  try { answer = treg(s.endpoint, 'GET', { url: it.url, language: s.language }); } catch (error) { say('transcript failed', it.id, error.message); }
  const lines = (at(answer ?? {}, s.lines) ?? []).map(l => [Number(l.startMs) / 1000, String(l.text ?? '').replace(/\s+/g, ' ').trim()]).filter(l => l[1]);
  if (!lines.length) return null;
  const words = { origin: `site captions via treg ${s.endpoint}`, lines };
  writeFileSync(done, JSON.stringify(words));
  return words;
}

function download(it) {
  const dir = itemDir(it);
  mkdirSync(dir, { recursive: true });
  const have = readdirSync(dir).find(f => /^video\.(mp4|webm|mkv|mov)$/.test(f));
  if (have) return join(dir, have);
  const h = settings.media.video_height_at_most;
  const direct = it.media?.find(m => m.video)?.video;
  if (it.platform !== 'youtube' && direct) {
    const got = run('curl', ['-sSL', '--max-time', '300', '-o', join(dir, 'video.mp4'), direct]);
    return got.status === 0 && existsSync(join(dir, 'video.mp4')) ? join(dir, 'video.mp4') : null;
  }
  run('yt-dlp', ['-f', `bv*[height<=${h}]+ba/b[height<=${h}]/b`, '--merge-output-format', 'mp4', '-o', join(dir, 'video.%(ext)s'), it.url], 900_000);
  const file = readdirSync(dir).find(f => /^video\.(mp4|webm|mkv|mov)$/.test(f));
  return file ? join(dir, file) : null;
}

function hear(it, video) {
  const dir = itemDir(it);
  const done = join(dir, 'words.json');
  if (existsSync(done)) return JSON.parse(readFileSync(done, 'utf8'));
  const got = run('mlx_whisper', [video, '--model', settings.words.whisper_model, '--output-format', 'json', '--output-dir', dir, '--output-name', 'heard', '--word-timestamps', 'True'], 1_800_000);
  if (!existsSync(join(dir, 'heard.json'))) { say('hear failed', it.id, (got.stderr || '').slice(-200)); return null; }
  const h = JSON.parse(readFileSync(join(dir, 'heard.json'), 'utf8'));
  const words = { origin: `local ASR (${settings.words.whisper_model})`, lines: (h.segments ?? []).map(s => [Math.round(s.start * 100) / 100, s.text.trim()]) };
  writeFileSync(done, JSON.stringify(words));
  return words;
}

function frames(it, video) {
  const dir = join(itemDir(it), 'frames');
  if (existsSync(join(dir, 'times.json'))) return JSON.parse(readFileSync(join(dir, 'times.json'), 'utf8'));
  mkdirSync(dir, { recursive: true });
  const f = settings.frames;
  const got = run('ffmpeg', ['-hide_banner', '-nostats', '-i', video, '-vf', `select='eq(n\\,0)+gt(scene\\,${f.scene_change})',scale=${f.width}:-2,showinfo`,
    '-vsync', 'vfr', '-frames:v', String(f.at_most_per_video), '-q:v', '3', join(dir, 'f%04d.jpg')], 900_000);
  const times = [...(got.stderr || '').matchAll(/pts_time:([\d.]+)/g)].map(m => Number(m[1]));
  const files = readdirSync(dir).filter(n => /^f\d{4}\.jpg$/.test(n)).sort();
  const list = files.map((name, i) => ({ name, t: times[i] ?? null }));
  if (list.length) run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-pattern_type', 'glob', '-i', join(dir, 'f*.jpg'), '-vf',
    `scale=320:-2,tile=${f.sheet_columns}x${Math.ceil(list.length / f.sheet_columns)}`, '-frames:v', '1', '-y', join(dir, 'sheet.jpg')]);
  writeFileSync(join(dir, 'times.json'), JSON.stringify(list));
  return list;
}

// ---------- rows ----------
const textOf = words => words?.lines?.map(l => l[1]).join(' ').replace(/\s+/g, ' ').trim() ?? null;

function rowsFor(it, words, video, frameList) {
  const key = `${it.platform === 'youtube' ? 'yt' : it.platform === 'x' ? 'x' : 'ig'}-${it.id}`;
  const folder = `creators/${creator.slug}/${it.platform}/${it.id}`;
  keep('inspiration_videos', { id: `record:inspiration-videos:${key}`, kind: it.platform === 'youtube' ? (it.tab === 'shorts' ? 'short' : 'video') : (it.is_video ? 'post video' : 'post'),
    title: it.title ?? (it.text ?? '').split('\n')[0].slice(0, 200), url: it.url, source: `${creator.name} (${it.platform} ${it.account})`,
    video_id: it.id, views: it.views == null ? null : String(it.views), length_seconds: it.duration == null ? null : String(it.duration),
    transcript_words: words ? String(textOf(words).split(' ').length) : null, transcript_from: words?.origin ?? null,
    published: it.published, description: it.text ?? null,
    extra: JSON.stringify({ creator: creator.slug, account: it.account, likes: it.likes, replies: it.replies, reposts: it.reposts, bookmarks: it.bookmarks, media: it.media, is_reply: it.is_reply, conversation: it.conversation, kind: it.kind }) });
  if (words?.lines?.length) {
    const wordsFile = join(itemDir(it), 'words.json');
    keep('video_transcripts', { id: `record:video-transcripts:${key}`, kind: it.platform === 'youtube' ? (it.tab === 'shorts' ? 'short' : 'video') : 'post video',
      language: 'en', platform: it.platform, transcript_origin: words.origin, video: it.title ?? (it.text ?? '').slice(0, 120), video_id: it.id,
      word_count: String(textOf(words).split(' ').length), segments: JSON.stringify(words.lines.map(l => [l[0], 0])), text: textOf(words),
      file_b3: b3(wordsFile), file_path: wordsFile, source_url: it.url, creator: creator.name, length_seconds: it.duration == null ? null : String(it.duration),
      published: it.published?.slice(0, 10) ?? null, views: it.views == null ? null : String(it.views), channel_id: it.account,
      extra: JSON.stringify({ lines: words.lines }) });
  }
  if (video) keep('video_files', { id: `record:video-files:${folder}/${video.split('/').pop()}`, bytes: String(statSync(video).size), file: `${folder}/${video.split('/').pop()}`,
    file_b3: b3(video), file_path: video, folder, platform: it.platform, video: it.id, video_key: key, creator: creator.name, source_url: it.url });
  for (const f of frameList ?? []) {
    const file = join(itemDir(it), 'frames', f.name);
    keep('analysed_video_screenshots', { id: `record:analysed-video-screenshots:${encodeURIComponent(`${folder}/frames/${f.name}`)}`, bytes: String(statSync(file).size),
      file_b3: b3(file), file_path: file, group: 'scene-changes', image: `${folder}/frames/${f.name}`, kind: 'frame', shows: 'A frame where the picture changes (a cut or a new graphic)',
      source_creator: creator.slug, source_item: `${creator.slug}/${key}`, frame_label: f.name, window_start_s: f.t == null ? null : String(f.t), window_end_s: f.t == null ? null : String(f.t), video_key: key });
  }
}

// ---------- main ----------
const listFile = join(out, `items${tag}.jsonl`);
let items = [];
if (only === 'all' || only === 'list' || !existsSync(listFile)) {
  for (const account of creator.accounts.filter(a => !platforms || platforms.includes(a.platform))) {
    say('listing', account.platform, account.handle);
    const got = account.platform === 'youtube' ? await listYoutube(account) : await listPaged(account.platform, account);
    items.push(...got.slice(0, newest));
  }
  const seen = new Set();
  items = items.filter(it => !seen.has(`${it.platform}:${it.id}`) && seen.add(`${it.platform}:${it.id}`));
  writeFileSync(listFile, items.map(i => JSON.stringify(i)).join('\n') + '\n');
  say('listed', items.length);
} else items = readFileSync(listFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
if (only === 'list') process.exit(0);

writeFileSync(rowsFile, '');
let n = 0;
for (const it of items) {
  n++;
  try {
    let words = null, video = null, frameList = null;
    if (it.platform === 'youtube') { words = captions(it); await polite(); }
    if (wantMedia && it.is_video) {
      video = download(it);
      if (video && !words) words = hear(it, video);
      if (video && only !== 'words') frameList = frames(it, video);
    }
    rowsFor(it, words, video, frameList);
    say(`${n}/${items.length}`, it.platform, it.id, words ? `${words.lines.length} lines` : 'no words', video ? 'video' : '', frameList ? `${frameList.length} frames` : '');
  } catch (error) { say('failed', it.platform, it.id, error.message); }
}
console.log(JSON.stringify({ result: { items: items.length, rows: rowsFile } }));
