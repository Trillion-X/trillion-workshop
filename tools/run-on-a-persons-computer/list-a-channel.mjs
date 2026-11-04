// computer/list-a-channel.mjs
//
// Purpose
//   Lists every video a channel, a channel's tab or a playlist holds (any page the computer's link reader can list, such
//   as yt-dlp's thousands of sites), without reading each video: tool:list-every-video-on-a-channel, run by
//   computer/mac-tools.mjs on placement:your-computer. Each video comes back as { id, url, title, duration_seconds,
//   view_count, kind, thumbnail }, with how many the page itself states it has, so the caller can tell the list is whole.
//
// Non-negotiable invariants
//   1. Never an empty answer without a reason: no link reader, a refused page and a page that lists nothing each throw
//      an error saying why in plain words.
//   2. Which programs list a link, and what a page's list needs beyond one read (the other lists holding the same
//      videos, the count the page states, which videos are shorts or live), are DATA: the hear-fetcher rows with a `list`
//      command (records/hear-fetcher-records.json) and the video-list-rule rows (records/video-list-rule-records.json).
//      This file names no site and no program.
//   3. A video listed by several lists is one video: the first list to name it decides its place, and each later list
//      only fills what the earlier ones left unknown.
//   4. A list a rule adds that cannot be read never hides the others: it is answered under `unread` with why, and
//      `complete` then says whether what was read still matches the stated count.
//
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hearingHere } from '../computer-programs/read-data/program-here.mjs';
import { withTables } from '../src/data-rows.mjs';
import fetcherRecords from '../records/hear-fetcher-records.json' with { type: 'json' };
import ruleRecords from '../records/video-list-rule-records.json' with { type: 'json' };
import { refusedThisCopy, runFetcher } from './hear-a-link.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// The settings file with the link readers (`fetchers`) and the rules of a page's list (`rules`) read from their rows.
export const listSettings = () => withTables(JSON.parse(readFileSync(path.join(HERE, 'list-a-channel.json'), 'utf8')), {
  fetchers: { kind: 'hear-fetcher', records: fetcherRecords },
  rules: { kind: 'video-list-rule', records: ruleRecords },
});
const fill = (template, values) => String(template ?? '').replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? ''));
/** Whether every test ({ field, matches }) holds for `fields`; no tests always hold. */
const holds = (tests, fields) => (tests ?? []).every(test => new RegExp(test.matches).test(String(fields?.[test.field] ?? '')));
const numberOr = value => (Number.isFinite(value) ? value : null);
const thumbnailOf = entry => entry.thumbnail
  ?? [...(entry.thumbnails ?? [])].sort((a, b) => (b?.width ?? 0) - (a?.width ?? 0))[0]?.url ?? null;

/** The videos in one list's answer, nested lists (a channel's tabs) walked, each with `list_url`: the list it came in. */
function entriesOf(answer, skip, listUrl) {
  const found = [];
  for (const entry of answer?.entries ?? []) {
    if (!entry || typeof entry !== 'object') continue;
    if (Array.isArray(entry.entries)) found.push(...entriesOf(entry, skip, entry.webpage_url ?? entry.url ?? listUrl));
    else if (!skip.some(tests => holds([tests], entry))) found.push({ ...entry, list_url: listUrl });
  }
  return found;
}

/** One video as the tool answers it, its kind the first `kinds` row that holds for it. */
const videoOf = (entry, kinds) => ({
  id: String(entry.id),
  url: entry.url ?? entry.webpage_url ?? null,
  title: entry.title ?? null,
  duration_seconds: numberOr(entry.duration),
  view_count: numberOr(entry.view_count),
  kind: kinds.find(row => holds(row.when, entry))?.kind ?? null,
  thumbnail: thumbnailOf(entry),
});

/** The other lists the applying rules name for this answer: [{ url, stated_count }], each filled from the answer. */
function otherLists(rules, answer, url) {
  const lists = [];
  for (const rule of rules) for (const row of rule.read_also ?? []) {
    const match = new RegExp(row.from.matches).exec(String(answer?.[row.from.field] ?? ''));
    if (!match) continue;
    const filled = fill(row.url, { ...answer, ...Object.fromEntries(match.map((group, at) => [at, group])) });
    if (filled !== url && !lists.some(list => list.url === filled)) lists.push({ url: filled, stated_count: row.stated_count ?? null });
  }
  return lists;
}

export const channelTools = {
  /**
   * Every video at a link: { url } -> { url, title, channel, channel_id, count, stated_count, complete, entries, unread? }.
   * Throws why when there is nothing to list.
   */
  async list(input, context = {}, { fetchers = null, rules = null } = {}) {
    const settings = listSettings();
    const words = settings.words;
    const url = String(input?.url ?? '').trim();
    if (!/^https?:\/\//i.test(url)) throw Object.assign(new Error(words.needs_url), { status: 400 });
    const fetcher = fetchers ? fetchers[0] ?? null : hearingHere((settings.fetchers ?? []).filter(row => Array.isArray(row.list)));
    if (!fetcher) throw new Error(fill(words.no_fetcher, { url }));
    const applying = (rules ?? settings.rules ?? []).filter(rule => holds(rule.when, { url }));
    const skip = applying.flatMap(rule => rule.skip ?? []);
    const kinds = applying.flatMap(rule => rule.kinds ?? []);
    const most = (settings.most_minutes ?? 10) * 60;
    const read = async address => JSON.parse(await runFetcher(fetcher, 'list', { url: address, node: process.execPath }, most));
    const failed = error => new Error(fill(refusedThisCopy(error) && fetcher.update_hint ? words.stale_fetcher : words.list_failed,
      { url, error: String(error?.message ?? error), fetcher: fetcher.label ?? fetcher.id, hint: fetcher.update_hint ?? '' }));

    let answer;
    try { answer = await read(url); } catch (error) { throw failed(error); }
    const lists = otherLists(applying, answer, url);
    const others = await Promise.allSettled(lists.map(list => read(list.url)));
    const unread = [];
    const stated = [];
    const order = [];
    others.forEach((outcome, at) => {
      if (outcome.status === 'rejected') return unread.push({ url: lists[at].url, error: String(outcome.reason?.message ?? outcome.reason) });
      if (lists[at].stated_count) stated.push(numberOr(outcome.value?.[lists[at].stated_count]));
      order.push({ answer: outcome.value, list_url: lists[at].url });
    });
    order.push({ answer, list_url: answer?.webpage_url ?? url });
    // A list of videos (no nested lists) states its own count; a channel's page of tabs counts its tabs, so it does not.
    if (!stated.some(count => count !== null) && !(answer?.entries ?? []).some(entry => Array.isArray(entry?.entries))) stated.push(numberOr(answer?.playlist_count));

    const videos = new Map();
    for (const { answer: listed, list_url } of order) {
      for (const entry of entriesOf(listed, skip, list_url)) {
        if (entry.id === undefined || entry.id === null) continue;
        const video = videoOf(entry, kinds);
        const known = videos.get(video.id);
        if (!known) { videos.set(video.id, video); continue; }
        for (const [field, value] of Object.entries(video)) if (known[field] === null && value !== null) known[field] = value;
      }
    }
    const entries = [...videos.values()];
    if (!entries.length) throw new Error(fill(words.no_entries, { url }));
    const statedCount = stated.find(count => count !== null) ?? null;
    return {
      url,
      title: answer?.title ?? null,
      channel: answer?.channel ?? answer?.uploader ?? null,
      channel_id: answer?.channel_id ?? null,
      count: entries.length,
      stated_count: statedCount,
      complete: statedCount === null ? null : entries.length >= statedCount,
      entries,
      ...(unread.length ? { unread } : {}),
    };
  },
};
