// tools/research-a-creator-or-topic/do-work/harvest-posts.mjs
//
// tool:keep-public-posts-by-link. For each link to a public post (the link pattern is DATA) it asks a third-party public
// mirror for the post as JSON and keeps the post's text, numbers and the addresses of its media, never the media
// themselves. The mirror's address is DATA (harvest-settings.json, `posts.mirror_base`): this tool depends on that
// mirror staying up and answering, and a link it cannot read is told as failed with the mirror's own word. It asks as
// politely as the channel harvest does and with the same limits file: one request at a time, a wait drawn from a range, a
// bounded number of requests and seconds in one run, and a stop at the first refusal.
//
// A run that stops early answers what it did and `again`: the input to send next (the links not settled are the ones
// whose ids are not in skip_ids), with `wait_minutes` after a refusal. The run writes one file in its working folder:
//   out/posts.jsonl  one line per post settled now: { post_id, user, link, status, post?, reason? }
// With `rows`, one row per post settled now goes into the person's list through the records door, written over the row
// already held, so the fields the person keeps by hand stay.
//
//   node /opt/records-door/do-work/run-an-export.mjs /opt/research-a-creator-or-topic/do-work/harvest-posts.mjs keepPublicPostsByLink < input.json
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { lineFile, minutesToWait, picked, politeQueue, readPoliteness, readRowsSpec, readSettings, refuse, Stop, tail, words, writeRows } from './harvest-parts.mjs';

const INPUTS = new Set(['links', 'skip_ids', 'budget_seconds', 'refusals_in_a_row', 'rows']);

// The input, checked whole before any request.
export function readRequest(input, settings) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) refuse('Send an object.');
  const unknown = Object.keys(input).filter(key => !INPUTS.has(key));
  if (unknown.length) refuse(`Unknown input: ${unknown.join(', ')}.`);
  const { links_at_most: most, skip_ids_at_most: skipMost } = settings.posts;
  return {
    links: words(input.links, 'links', 1, most),
    skip: new Set(input.skip_ids === undefined ? [] : words(input.skip_ids, 'skip_ids', 0, skipMost)),
    ...readPoliteness(input, settings),
    rows: input.rows === undefined ? null : readRowsSpec(input.rows, ['post'], () => false),
  };
}

// A post's user and id from its link, or null.
export function readPostLink(link, settings) {
  const match = new RegExp(settings.posts.link_pattern, 'i').exec(link);
  return match ? { user: match[1], post_id: match[2], link } : null;
}

export async function keepPublicPostsByLink(input, context = {}, {
  settings = readSettings(),
  out = resolve('out'),
  now = () => performance.now() / 1000,
  sleep = seconds => new Promise(done => setTimeout(done, seconds * 1000)),
  random = Math.random,
  fetchPage = fetch,
} = {}) {
  const asked = readRequest(input, settings);
  const { mirror_base: mirror, answer_field: field, user_agent: agent, post_fields: fields, answer_bytes_at_most: bytesMost } = settings.posts;
  mkdirSync(out, { recursive: true });
  const file = lineFile(join(out, 'posts.jsonl'), settings.file_bytes_at_most);
  const started = now();
  const ends = started + asked.budget - (asked.rows ? settings.seconds_kept_for_records : 0);
  const queue = politeQueue(settings, { ends, now, sleep, random });
  const skip = new Set(asked.skip);
  const skipped = [];
  const failed = [];
  const settled = [];
  const facts = [];
  const seen = new Set();
  let ready = 0;
  let stopped = 'finished';

  // One post from the mirror, as one line.
  async function settle(target) {
    const { seconds, atEnd } = await queue.begin();
    let line;
    try {
      const response = await fetchPage(`${mirror}/${target.user}/status/${target.post_id}`, { signal: AbortSignal.timeout(Math.max(1, Math.floor(seconds * 1000))), headers: { accept: 'application/json', 'user-agent': agent } });
      queue.check(`http error ${response.status}`);
      if (!response.ok) {
        await response.body?.cancel();
        line = { ...target, status: 'failed', reason: `the mirror answered HTTP ${response.status}` };
      } else {
        const bytes = Buffer.from(await response.arrayBuffer());
        const post = bytes.length > bytesMost ? null : JSON.parse(bytes.toString('utf8'))?.[field];
        line = post && typeof post === 'object'
          ? { ...target, status: 'ready', post: picked(post, fields) }
          : { ...target, status: 'failed', reason: bytes.length > bytesMost ? 'the mirror\'s answer is larger than the settings allow' : 'the mirror held no post' };
      }
    } catch (error) {
      if (error instanceof Stop) throw error;
      if (atEnd) throw new Stop('budget');
      line = { ...target, status: 'failed', reason: tail(error.name === 'TimeoutError' ? `the request took longer than ${Math.floor(seconds)} seconds` : error.message) };
    }
    if (!file.add(line)) {
      if (!file.empty) throw new Stop('files');
      line = { ...target, status: 'failed', reason: 'the post is larger than one file holds' };
      file.add(line);
    }
    return line;
  }

  try {
    for (const link of asked.links) {
      const target = readPostLink(link, settings);
      if (!target) { skipped.push({ link, reason: 'not a link to a post this tool reads' }); continue; }
      if (seen.has(target.post_id)) continue;
      seen.add(target.post_id);
      if (skip.has(target.post_id)) continue;
      const line = await settle(target);
      skip.add(target.post_id);
      settled.push(target.post_id);
      if (line.status === 'failed') failed.push({ post_id: target.post_id, reason: line.reason });
      else ready += 1;
      facts.push({ ...target, status: line.status, ...(line.post ?? {}) });
    }
  } catch (error) {
    if (!(error instanceof Stop)) throw error;
    stopped = error.why;
  }

  const rows = asked.rows ? await writeRows(asked.rows, facts, 'post_id', context, settings) : null;
  // Rows that could not be written leave this run's posts unsettled: the next run asks the mirror for them again.
  const keptIds = rows?.error ? [...asked.skip] : [...skip];
  const again = asked.links.some(link => {
    const target = readPostLink(link, settings);
    return target && !keptIds.includes(target.post_id);
  }) ? {
    ...Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'refusals_in_a_row')),
    skip_ids: keptIds.slice(-settings.posts.skip_ids_at_most),
    ...(stopped === 'refusal' ? { refusals_in_a_row: asked.refusals + 1 } : {}),
  } : null;
  return {
    stopped,
    requests: queue.requests,
    seconds: Math.round((now() - started) * 10) / 10,
    posts: { ready, failed },
    settled: settled.length,
    ...(skipped.length ? { skipped } : {}),
    ...(rows ? { rows } : {}),
    ...(stopped === 'refusal' ? { wait_minutes: minutesToWait(asked.refusals, settings.pause_after_refusal) } : {}),
    again,
  };
}
