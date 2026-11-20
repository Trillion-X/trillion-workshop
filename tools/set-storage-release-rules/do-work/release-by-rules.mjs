// tools/set-storage-release-rules/do-work/release-by-rules.mjs
//
// PURPOSE
//   Give back the storage of what a person deleted, by their own release rules, over what the engine really has: the
//   person's files door (files_summary, list_set_aside, forget_set_aside, queue_release, release_gone_bytes,
//   list_released: tools/live-namespace src/account_files) and their account records (the set-aside items of
//   tools/recently-deleted-and-storage and their setting:release_rules, do-work/release-rules-setting.mjs). The rules
//   engine is src/namespace-release-rules.mjs, unchanged; this file is the old person store's glue around it
//   (src/person-store.mjs at 1e886c3f68: :4646 releasePlanNow, :4656 releaseByRules, :4674 namespaceStorage).
//
//   planStorageRelease({ items, kept_bytes, now }, ctx)   what leaves now and when every other item will, for items the caller
//                                                         read (no file is reached: a run handed values can do it)
//   readStorage({}, ctx)                                  the whole storage answer, read from the files door
//   releaseDeletedFiles({ rules?, dry_run? }, ctx)        forget for good what the rules say leaves now and give its
//                                                         bytes back; dry_run only says what would leave
//
//   Each is `fn(input, { door, now })`, run by tools/records-door/do-work/run-an-export.mjs.
//
// NON-NEGOTIABLE INVARIANTS
//   1. A rule only gives storage back sooner; keep-for is the longest anything waits (src/namespace-release-rules.mjs).
//   2. Nothing is forgotten when a rule has no comparison or an unfinished one: the plan is refused whole.
//   3. Only items still held (Recently Deleted or Archived) can leave; the byte release itself is the engine's
//      (release.rs: a file stays while any name, set-aside name or move in progress holds it).
//   4. No daily pass is armed here: the engine drops it on purpose (release.rs header), so a person's own schedule or
//      rule runs releaseDeletedFiles. Nothing here names a folder, a kind, a size or a number of days.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import { readFileSync } from 'node:fs';
import byteRelease from '../../organize-my-files/src/namespace-byte-release.json' with { type: 'json' };
import aside from '../../recently-deleted-and-storage/namespace-set-aside.json' with { type: 'json' };
import { forgetSetAsideNow, heldItems } from '../../recently-deleted-and-storage/do-work/recently-deleted-actions.mjs';
import { fail, shown } from '../../recently-deleted-and-storage/read-data/when-due.mjs';
import { initSync, filterRecords } from '../../formula-engine/built-stored-bytes/formula-engine/formula_engine.js';
import live from '../storage-release-live.json' with { type: 'json' };
import { releaseItemFacts, releasePlan, checkReleaseRules } from '../src/namespace-release-rules.mjs';
import { readReleaseRules, describeRules } from './release-rules-setting.mjs';
import setAsideLive from '../../recently-deleted-and-storage/set-aside-live.json' with { type: 'json' };

const DAY = 86_400_000;
const finalStates = new Set(aside.states.filter(state => state.when_due === null).map(state => state.id));
const whereOf = name => name.slice(0, name.lastIndexOf('/')) || '/';

// The engine's formula module decides which items a rule covers; it is started once, on first use.
let started = false;
const filterRows = ({ tree, fields, rows }) => {
  if (!started) { initSync({ module: readFileSync(new URL('../../formula-engine/built-stored-bytes/formula-engine/formula_engine_bg.wasm', import.meta.url)) }); started = true; }
  return filterRecords({ records: rows, fields, tree });
};

const wholeBytes = value => (Number.isInteger(value) && value >= 0 ? value : null);

// An item as the rules and the storage answer read it: the set-aside item with its days left, where it was, when it was set aside and how big it is.
const seenItem = (item, keep, now, bytes) => ({ ...shown(item, keep, now), set_aside_at: new Date(item.entered_at_ms).toISOString(), where: whereOf(item.names[0]), byte_length: bytes });

/** The plan for items already read: { items: [{ id, label, state, state_label, byte_length, set_aside_at, where, by, name_count, folder, due_at }], kept_bytes, rules?, now? }.
 *  Rules left out are the person's saved ones. Answers the plan { now, items, leaving, kept_after } with the rules and what they can name. */
export async function planStorageRelease({ items, kept_bytes, rules, now: at } = {}, { door, now = Date.now } = {}) {
  if (!Array.isArray(items)) throw fail('bad_items', 'Give the items set aside (what list_recently_deleted answers, each with byte_length).');
  if (wholeBytes(kept_bytes) === null) throw fail('bad_kept_bytes', 'Give kept_bytes: the bytes the files use now (files_summary bytes).');
  const rows = items.map(item => {
    if (wholeBytes(item?.byte_length) === null || !Number.isFinite(Date.parse(item.set_aside_at)) || typeof item.id !== 'string') throw fail('bad_items', 'Each item needs id, set_aside_at and byte_length.');
    return { names: [], ...item, state_label: item.state_label ?? aside.states.find(state => state.id === item.state)?.label ?? item.state };
  });
  const chosen = rules === undefined ? (await readReleaseRules(door)).rules : checkReleaseRules(rules);
  const when = typeof at === 'string' && Number.isFinite(Date.parse(at)) ? Date.parse(at) : now();
  const plan = await releasePlan({ items: rows, rules: chosen, keptBytes: kept_bytes, finalStates, filterRows, now: when });
  return { ...plan, ...describeRules(chosen), item_rows: rows.map(row => ({ id: row.id, label: row.label, byte_length: row.byte_length, facts: releaseItemFacts(row, when) })) };
}

// How big what is set aside is, name by name, from the engine's set-aside tree: a name is a file in its folder's listing, or a folder whose names and folders are added up.
function sizer(door) {
  let calls = 0;
  const listings = new Map();
  const listing = async folder => {
    if (listings.has(folder)) return listings.get(folder);
    const found = { files: new Map(), folders: [] };
    for (let after; ;) {
      if ((calls += 1) > live.size_calls) throw fail('too_large', 'There is more set aside than one run sizes. Ask again to go on.');
      const answer = await door.files('list_set_aside', { folder, limit: live.page, ...(after ? { after } : {}) });
      for (const row of answer?.names ?? []) found.files.set(row.name, row.byte_length ?? 0);
      if (after === undefined) found.folders.push(...answer?.folders ?? []);
      if (!answer?.next_after) break;
      after = answer.next_after;
    }
    listings.set(folder, found);
    return found;
  };
  const folderBytes = async folder => {
    const here = await listing(folder);
    let bytes = [...here.files.values()].reduce((sum, each) => sum + each, 0);
    for (const sub of here.folders) bytes += await folderBytes(sub);
    return bytes;
  };
  return async name => {
    const file = (await listing(whereOf(name))).files.get(name);
    return file === undefined ? folderBytes(name) : file;
  };
}

// What is held in Recently Deleted and Archived, each with its size, and the bytes the files keep.
async function readItems(door, now) {
  const keepRecord = await door.readRecord(setAsideLive.keep_for_type, setAsideLive.keep_for_id);
  const keep = keepRecord?.value?.value ?? {};
  const size = sizer(door);
  const items = [];
  for (const item of await heldItems(door, now)) {
    let bytes = wholeBytes(item.byte_length);
    if (bytes === null) { bytes = 0; for (const name of item.names) bytes += await size(name); }
    items.push(seenItem(item, keep, now, bytes));
  }
  items.sort((a, b) => b.entered_at_ms - a.entered_at_ms || (a.id < b.id ? 1 : -1));
  return { items, keep };
}

// The storage already given back: its bytes and objects in all, and per day for the last forecast_days.
async function readGivenBack(door, now) {
  let bytes = 0, objects = 0, pending = false;
  const perDay = new Map();
  let after;
  for (let page = 0; page < live.given_back_pages; page += 1) {
    const answer = await door.files('list_released', { limit: live.page, ...(after ? { after } : {}) });
    for (const row of answer?.released ?? []) {
      bytes += row.byte_length ?? 0;
      objects += 1;
      const day = new Date(row.released_at).toISOString().slice(0, 10);
      perDay.set(day, { day, bytes: (perDay.get(day)?.bytes ?? 0) + (row.byte_length ?? 0), objects: (perDay.get(day)?.objects ?? 0) + 1 });
    }
    pending = Boolean(answer?.pending);
    if (!answer?.next_after) { after = undefined; break; }
    after = answer.next_after;
  }
  const since = new Date(now - (byteRelease.forecast_days - 1) * DAY).toISOString().slice(0, 10);
  return { total: { bytes, objects, pending, partial: after !== undefined },
    by_day: [...perDay.values()].filter(row => row.day >= since).sort((a, b) => (a.day < b.day ? -1 : 1)) };
}

/** How much storage the files use and when the storage of what was deleted is given back: kept, waiting, leaving (per day), each waiting item
 *  with when and why it leaves, what was given back, and the rules. It changes nothing. */
export async function readStorage(_input = {}, { door, now = Date.now } = {}) {
  const at = now();
  const summary = await door.files('files_summary', {});
  const { items } = await readItems(door, at);
  const plan = await planStorageRelease({ items, kept_bytes: summary.bytes, now: new Date(at).toISOString() }, { door, now });
  const leavingBy = new Map(plan.items.map(row => [row.id, row]));
  const given = await readGivenBack(door, at);
  return {
    kept: { bytes: summary.bytes, files: summary.files, by_origin: summary.by_origin },
    waiting: { bytes: items.reduce((sum, item) => sum + item.byte_length, 0), items: items.length },
    leaving: plan.leaving,
    items: items.map(item => ({ id: item.id, label: item.label, state_label: item.state_label, byte_length: item.byte_length, set_aside_at: item.set_aside_at, where: item.where,
      facts: releaseItemFacts(item, at), ...leavingBy.get(item.id) })),
    given_back: given.total, given_back_by_day: given.by_day,
    rules: plan.rules, item_facts: plan.item_facts, orders: plan.orders, choices: plan.choices,
  };
}

/** Forget for good what the rules say leaves now and give its storage back: { rules?, dry_run? }. `rules` (checked) replace the saved ones for this run only.
 *  Answers { leaving: [{ id, label, byte_length, because }], bytes, dry_run } and, when something left, { forgotten, released: { objects, bytes, more } }. */
export async function releaseDeletedFiles({ rules, dry_run = false } = {}, { door, now = Date.now } = {}) {
  const at = now();
  const summary = await door.files('files_summary', {});
  const { items } = await readItems(door, at);
  const plan = await planStorageRelease({ items, kept_bytes: summary.bytes, rules, now: new Date(at).toISOString() }, { door, now });
  const why = new Map(plan.items.map(row => [row.id, row.because]));
  const leaving = items.filter(item => plan.now.includes(item.id));
  const answer = { leaving: leaving.map(item => ({ id: item.id, label: item.label, byte_length: item.byte_length, because: why.get(item.id) ?? null })),
    bytes: leaving.reduce((sum, item) => sum + item.byte_length, 0), dry_run: Boolean(dry_run) };
  if (dry_run || !leaving.length) return answer;
  const forgotten = [];
  for (let from = 0; from < leaving.length; from += aside.items_per_request) {
    forgotten.push(...(await forgetSetAsideNow({ ids: leaving.slice(from, from + aside.items_per_request).map(item => item.id) }, { door })).removed);
  }
  // The files the forgotten names held now go to the engine's byte release: queue, then remove, round by round while work is left.
  const released = { objects: 0, bytes: 0, more: true };
  for (let round = 0; round < live.give_back_rounds && released.more; round += 1) {
    const queued = await door.files('queue_release', { limit: live.round_limit });
    const done = await door.files('release_gone_bytes', { limit: live.round_limit });
    released.objects += done?.released ?? 0;
    released.bytes += done?.bytes ?? 0;
    released.more = Boolean(queued?.more || done?.more);
  }
  return { ...answer, forgotten, released };
}
