// computer/read-new-items.mjs
//
// Purpose: what the person writes, records or receives in apps on this Mac (a note, a voice memo, a message, an
// email, an event, a photo, a download) reaches their Trillion account's one door (/mcp/api/inbound, dev/trillion
// src/inbound.mjs), where it is kept word for word and handed to whichever of their AIs takes it first. Each place is
// a row's `read` block in computer-sources.json (route, reader, store, settle_seconds, and the reader's own fields); a
// reader is a leaf in READERS that turns a store into items { source_id, title, text, at, file?, picture? }. Most places
// need no leaf of their own: `sqlite` runs the row's query against the row's stores, and `folder` lists the row's
// folder, so a new place is one more row.
//
// Invariants:
// - Read only for provider stores. They are opened read-only and never written.
//   Connection journals are integration progress: their pending rows are acknowledged only after the door
//   confirms receipt. Their reader admits already-captured new items, including ones kept before its first tick.
// - Nothing written before a carrier first ran is sent: its `since` is set on the first run and kept.
// - An item is sent once it has not changed for settle_seconds, and again only when its time or words change (the
//   door keys the job the same way, so a resend after a lost reply is harmless). The cursor moves only after the
//   account answers 200.
// - Locked notes, deleted notes, and folders named in skip_folders are never read out.
// - A store macOS will not let this app read is reported as `needs access` and its Privacy pane is opened once;
//   nothing else stops. Each look reads in a fresh child process, so access granted while the app runs is used on
//   the next look without restarting anything (a running process keeps the access it started with).
// - Once a store reads, the carrier's status is `working`, and it is saved at once and after every item sent, so a
//   restart part way through never loses the status or sends again what already went.
// - One item that cannot be sent (its file vanished or will not open) is recorded as `failed` and skipped until the
//   next look; the items after it still go.
// - The core names no app: routes, stores, queries and folders are DATA; app knowledge lives only in the rows and in
//   the few reader leaves whose store is not a query away (apple-notes, voice-memos).
// - When the account cannot take anything (not signed in, plan, busy, unreachable), every place waits (1 minute,
//   doubling to 30), so a struggling account is not asked again every look. Nothing is lost: what was not sent is read
//   again after. When it turns away one item (a 4xx about that item), only that item waits, until it changes or the
//   `turned_away` row's minutes pass, and every other item and place still goes: on 2026-10-06 one 388,140-character note made every look stop at Apple
//   Notes for five hours, so no voice memo after it was sent.
// - When one item's file is what the account would not keep (a 5xx that says the storage did not finish this file), only
//   that item waits (held.stuck, per source_id: `item_trouble.retry_seconds` doubling to `longest_seconds`) and the rest
//   of its place and every other place still go; it remains pending until the file is actually kept. Only the account
//   as a whole (not reachable, 429, not signed in, other 5xx) sets
//   the one account-wide wait, and each look starts at the place after the one that started the last (state.next_place),
//   so under that wait every place still gets its turn. On 2026-10-08 one memo whose file the storage would not finish
//   kept the whole reader waiting 30 minutes at a time, and Messages and Photos were never read.
// - Words longer than the `long_text` row's characters go whole as a text file beside the item, with their opening as
//   its text, so a long note arrives instead of being turned away.
// - A picture leaves whole only where the row says so and at the size its data caps: a place with `preview_px` sends a
//   small JPEG preview and says where the picture is on this Mac; a place with `file` (Photos) keeps a JPEG copy in the
//   person's files, its long edge at most `file.long_edge` pixels (made with sips from the original, else the largest
//   copy Photos keeps here; an iCloud-only original is never downloaded, and the item says a smaller copy is what is
//   kept). A video whose original is on this Mac is kept whole (the row's `file.video`), so its sound is heard and its
//   words transcribed where it arrives; a video only in iCloud keeps its still and says so. A place with `group` sends one item per window (a conversation's hour), once the window has closed and
//   settled. A place with `cursor: "moves"` reads from the oldest item not yet sent, and at least `reread_minutes` (60)
//   back so what syncs in late from another device is still caught, never before its first run; so a busy store is
//   read over a bounded window, and what can never be read again is forgotten. A grouped place is read from the start
//   of the window its cursor falls in, so a window already sent is read whole and never resent as its later half
//   (on 2026-09-30 one hour of Mail went out eight times, each a new decision case, as the cursor slid through it).
// - Who wrote each item decides how it arrives: an item read with its own `from_person` (a query column, such as Mail's
//   1 for a message in a Sent mailbox) goes on as the person's words only when it is 1, and a window never mixes the
//   person's items with others'; an item without one follows its row, where `from_person: false` (Mail) means someone
//   else wrote it. Someone else's words reach the door as information, never as the person's own instructions.
// - A place with `see` (Photos) arrives with what is in the picture, read on this computer and nowhere else (the server
//   never reads pixels): the words in it (Apple Vision) and, when the local `visual_caption` model answers, what it shows,
//   written into the item's text by `see.ocr` and `see.caption`. What was seen is kept in workdir under the picture's
//   path, size and time, so nothing is read twice, and is kept as the file's `visual-observation` result.
// - A place with `backfill` (Photos) also reads its past, newest first, a few items every `every_seconds` and at most
//   `most_per_hour` an hour: the row's query is read with `:before` (the oldest item reached) and `:limit`, the batch goes
//   to the door as one `{ items }` request, and the cursor (`backfill_before`, in the reader's state) only moves down, to
//   the oldest. It starts at once, from where the live read began. The door counts an item as brought in when its `at` is
//   1,440 minutes (src/brought-in.json) older than the time it is kept, so no rule, decision or handoff follows what is
//   older than a day; what is newer arrives as live, as it should. A row may add `history_after_minutes` to make it wait.
// - A place is `arrived` once its first item reached the account; Connections calls it Connected only then.
// - A place with `hear` (Voice Memos) arrives with its words: its recording is heard on this computer by the first
//   `hearing` row that runs here before it is sent, the words are kept as the file's transcript and written into the
//   item's text by `hear.text`, so they never wait on the account's own hearing (on 2026-10-04 28 voice memos arrived
//   as a title and a length only, because the account was too busy to hear them).
import {isOwnWrite} from './own-writes.mjs';
import limits from './read-new-items.json' with {type: 'json'};
import {readFileSync, writeFileSync, renameSync, existsSync, readdirSync, statSync, mkdirSync, rmSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {execFile} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {blake3} from '@noble/hashes/blake3.js';
import {bytesToHex} from '@noble/hashes/utils.js';
import {accessPaneAddress, placesOf} from './computer-sources.mjs';
import {readIncomingItems, assertIncomingAllowed, acknowledgeIncomingItem} from './connections/incoming-items.mjs';

const APPLE_EPOCH_SECONDS = 978307200;
const fromAppleTime = seconds => new Date((Number(seconds) + APPLE_EPOCH_SECONDS) * 1000);
const expand = place => place.replace(/^~(?=\/)/, os.homedir());

// The times a store keeps, to and from a Date. A row whose store keeps another unit converts it in its query.
const TIMES = {
  'apple-seconds': {to: fromAppleTime, from: date => date.getTime() / 1000 - APPLE_EPOCH_SECONDS},
  'unix-seconds': {to: seconds => new Date(Number(seconds) * 1000), from: date => date.getTime() / 1000},
};

// Decoders a row names for a column its store keeps in its own format: [{from, decoder, into}].
export const DECODERS = {
  // An NSAttributedString archive (typedstream), as Messages keeps a message's words: the string after `NSString`,
  // its length in one byte, or 0x81 and two bytes, or 0x82 and four (little-endian).
  'typedstream-string'(bytes) {
    if (!bytes) return null;
    const buffer = Buffer.from(bytes);
    const named = buffer.indexOf('NSString');
    const plus = named < 0 ? -1 : buffer.indexOf(0x2b, named + 8);
    if (plus < 0) return null;
    let offset = plus + 1, length = buffer[offset++];
    if (length === 0x81) { length = buffer.readUInt16LE(offset); offset += 2; }
    else if (length === 0x82) { length = buffer.readUInt32LE(offset); offset += 4; }
    return buffer.subarray(offset, offset + length).toString('utf8');
  },
};

/** `{name}` in a row's template, filled from values; a missing value is empty. */
export const fill = (template, values) => String(template ?? '').replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? ''));
const timeValues = at => {
  const date = new Date(at);
  return {time: date.toLocaleString('en-US', {dateStyle: 'medium', timeStyle: 'short'}), clock: date.toLocaleTimeString('en-US', {timeStyle: 'short'})};
};
const sizeOf = bytes => (bytes < 1024 ? `${bytes} B` : bytes < 1024 ** 2 ? `${Math.round(bytes / 1024)} KB` : bytes < 1024 ** 3 ? `${(bytes / 1024 ** 2).toFixed(1)} MB` : `${(bytes / 1024 ** 3).toFixed(1)} GB`);
// The folder a place's stores live under, before any wildcard: listing it is how a refusal by macOS shows.
const baseOf = store => path.dirname(expand(store).split('*')[0]);

/** Whether an item read with a `from_person` value (a query column: 1/0, true/false) was written by the person. */
const personOf = item => item.from_person === true || item.from_person === 1 || item.from_person === '1' || item.from_person === 'true';
/** Who wrote an item: its own `from_person` when it was read with one, else its place's row (the person unless it says false). */
export const fromPersonOf = (carrier, item) => (item.from_person === undefined || item.from_person === null ? carrier.from_person !== false : personOf(item));

/**
 * Items from a place's own windows (`group`: {by?, window_minutes, title, heading?, line, pictures?}): one per
 * value of `by` per window, dated at the window's end so it settles only once the window has closed.
 */
export function grouped(items, group) {
  const window = (group.window_minutes ?? 60) * 60_000;
  const windows = new Map();
  for (const item of items) {
    const start = Math.floor(Date.parse(item.at) / window) * window;
    // What the person wrote never shares a window's item with what others wrote: theirs keeps the window's plain key.
    const mine = personOf(item) ? 'mine:' : '';
    const key = `${mine}${group.by ? String(item[group.by] ?? '') : ''}@${new Date(start).toISOString()}`;
    if (!windows.has(key)) windows.set(key, {start, members: []});
    windows.get(key).members.push(item);
  }
  return [...windows].map(([key, {start, members}]) => {
    members.sort((left, right) => left.at.localeCompare(right.at));
    const first = {...members[0], count: members.length};
    return {source_id: key, title: fill(group.title ?? '{title}', first), from: new Date(start).toISOString(), at: new Date(start + window).toISOString(),
      ...(first.from_person === undefined || first.from_person === null ? {} : {from_person: personOf(first)}),
      text: [group.heading ? fill(group.heading, first) : null, ...members.map(member => fill(group.line ?? '{text}', member))].filter(Boolean).join('\n'),
      pictures: members.map(member => member.picture).filter(Boolean).slice(0, group.pictures ?? 0)};
  });
}

/** Reads one protobuf message's fields: [{field, wire, value}] (value is bytes for length-delimited fields). */
export function protobufFields(bytes) {
  const fields = [];
  let offset = 0;
  const varint = () => {
    let value = 0n, shift = 0n;
    for (;;) {
      if (offset >= bytes.length) throw new Error('cut short');
      const byte = bytes[offset++];
      value |= BigInt(byte & 0x7f) << shift;
      if (byte < 0x80) return value;
      shift += 7n;
    }
  };
  while (offset < bytes.length) {
    const tag = Number(varint());
    const field = tag >>> 3, wire = tag & 7;
    if (wire === 0) fields.push({field, wire, value: varint()});
    else if (wire === 1) { fields.push({field, wire, value: bytes.subarray(offset, offset + 8)}); offset += 8; }
    else if (wire === 2) { const length = Number(varint()); fields.push({field, wire, value: bytes.subarray(offset, offset + length)}); offset += length; }
    else if (wire === 5) { fields.push({field, wire, value: bytes.subarray(offset, offset + 4)}); offset += 4; }
    else throw new Error(`unknown wire type ${wire}`);
  }
  return fields;
}

/** The text of one Apple Notes body (gzipped NoteStoreProto: document 2, note 3, note_text 2), or null. */
export function appleNoteText(gzipped) {
  if (!gzipped) return null;
  let message = gunzipSync(gzipped);
  for (const field of [2, 3, 2]) {
    const found = protobufFields(message).find(item => item.field === field && item.wire === 2);
    if (!found) return null;
    message = found.value;
  }
  return new TextDecoder().decode(message);
}

const columnsOf = (db, table) => new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(column => column.name));
const pick = (columns, name, as) => (columns.has(name) ? `${as}.${name}` : 'NULL');

// The picture a sqlite row keeps (`file`: {try, whole, folder, name, long_edge, smaller, missing}): the first of the places
// in `try` (path templates filled from the row, relative to `files_from`: the edited picture and the original first, then
// each smaller copy Photos keeps) that names a file here, checked on disk only, never fetched. A template with a value the
// row lacks is passed over. The first `whole` templates are the whole picture; when the file found is a later one,
// `smaller` is added to the words (or `missing` when none is); the item is never failed over it.
const fileOf = (carrier, store, row, values) => {
  const plan = carrier.file;
  const root = expand(carrier.files_from ?? path.dirname(store));
  const video = plan.video;
  const isVideo = video && Object.entries(video.when ?? {}).every(([key, value]) => row[key] === value);
  if (isVideo) {
    const original = video.try
      .filter(template => [...template.matchAll(/\{(\w+)\}/g)].every(([, key]) => row[key] != null && row[key] !== ''))
      .map(template => path.resolve(root, fill(template, row))).find(candidate => existsSync(candidate));
    if (original) {
      const ext = path.extname(original).slice(1).toLowerCase();
      return {note: '', file: {path: original, name: fill(video.name, {...values, ext}), folder: fill(video.folder ?? plan.folder, values),
        media_type: video.media_types?.[ext] ?? 'application/octet-stream'}};
    }
  }
  const still = fileOfStill(plan, root, row, values);
  return isVideo && video.missing && still.file ? {...still, note: `${still.note}${fill(video.missing, values)}`} : still;
};

const fileOfStill = (plan, root, row, values) => {
  const whole = plan.whole ?? 1;
  const named = plan.try.map((template, index) => ({template, whole: index < whole}))
    .filter(({template}) => [...template.matchAll(/\{(\w+)\}/g)].every(([, key]) => row[key] != null && row[key] !== ''))
    .map(({template, whole}) => ({path: path.resolve(root, fill(template, row)), whole}));
  const found = named.find(candidate => existsSync(candidate.path));
  if (!found) return {note: fill(plan.missing, values)};
  return {note: found.whole ? '' : fill(plan.smaller, values),
    file: {path: found.path, name: fill(plan.name, values), folder: fill(plan.folder, values), media_type: 'image/jpeg', long_edge: plan.long_edge}};
};

// Reader leaves: (carrier, since: Date) -> items. Each knows one app's own store and nothing else.
export const READERS = {
  incoming(carrier) { return readIncomingItems(expand(carrier.store), {includeDelivered: carrier.include_delivered === true}); },
  'apple-notes'(carrier, since) {
    const db = new DatabaseSync(expand(carrier.store), {readOnly: true});
    try {
      const has = columnsOf(db, 'ZICCLOUDSYNCINGOBJECT');
      const rows = db.prepare(`SELECT o.ZIDENTIFIER AS id, COALESCE(${pick(has, 'ZTITLE1', 'o')}, ${pick(has, 'ZTITLE', 'o')}) AS title,
          o.ZMODIFICATIONDATE1 AS modified, ${pick(has, 'ZISPASSWORDPROTECTED', 'o')} AS locked, ${pick(has, 'ZMARKEDFORDELETION', 'o')} AS deleted,
          ${pick(has, 'ZTITLE2', 'f')} AS folder, ${pick(has, 'ZFOLDERTYPE', 'f')} AS folder_type, d.ZDATA AS data
        FROM ZICCLOUDSYNCINGOBJECT o JOIN ZICNOTEDATA d ON d.Z_PK = o.ZNOTEDATA LEFT JOIN ZICCLOUDSYNCINGOBJECT f ON f.Z_PK = o.ZFOLDER
        WHERE o.ZMODIFICATIONDATE1 > ?`).all((since.getTime() / 1000) - APPLE_EPOCH_SECONDS);
      const skip = new Set(carrier.skip_folders ?? []);
      // Folder type 1 is the app's own Recently Deleted folder.
      return rows.filter(row => row.id && !row.locked && !row.deleted && Number(row.folder_type) !== 1 && !skip.has(row.folder))
        .map(row => ({source_id: row.id, title: row.title ?? null, text: appleNoteText(row.data), at: fromAppleTime(row.modified).toISOString()}))
        .filter(item => item.text?.trim());
    } finally { db.close(); }
  },
  'voice-memos'(carrier, since) {
    const db = new DatabaseSync(expand(carrier.store), {readOnly: true});
    try {
      const has = columnsOf(db, 'ZCLOUDRECORDING');
      const rows = db.prepare(`SELECT ${pick(has, 'ZUNIQUEID', 'r')} AS id, COALESCE(${pick(has, 'ZENCRYPTEDTITLE', 'r')}, ${pick(has, 'ZCUSTOMLABEL', 'r')}) AS title,
          r.ZDATE AS recorded, ${pick(has, 'ZDURATION', 'r')} AS seconds, r.ZPATH AS file FROM ZCLOUDRECORDING r WHERE r.ZDATE > ? AND r.ZPATH IS NOT NULL`).all((since.getTime() / 1000) - APPLE_EPOCH_SECONDS);
      const folder = path.dirname(expand(carrier.store));
      return rows.filter(row => row.id).map(row => {
        const file = path.isAbsolute(row.file) ? row.file : path.join(folder, row.file);
        const length = Math.round(Number(row.seconds) || 0);
        return {source_id: row.id, title: row.title ?? null, at: fromAppleTime(row.recorded).toISOString(),
          text: `A voice memo${row.title ? ` called "${row.title}"` : ''}, ${Math.floor(length / 60)}:${String(length % 60).padStart(2, '0')} long. Its sound is the attached file.`,
          file: {path: file, name: `${row.title || 'Voice memo'} ${fromAppleTime(row.recorded).toISOString().slice(0, 16).replace('T', ' ')}${path.extname(file)}`, media_type: 'audio/mp4'}};
      }).filter(item => existsSync(item.file.path));
    } finally { db.close(); }
  },
  // Any SQLite store: the row's `query` runs against every store its `store` names (wildcards allowed), with `:since`
  // in the row's `time` unit, and returns source_id, at, title?, text?, picture? and any values its templates use.
  // `text` (a template) builds the words from those values; `decode` turns a column kept in the store's own format
  // into words. A store without the query's table (a second, empty store beside the real one) is passed over.
  sqlite(carrier, since) {
    const time = TIMES[carrier.time ?? 'apple-seconds'];
    const stores = placesOf(carrier.store, os.homedir());
    if (!stores.length) { readdirSync(baseOf(carrier.store)); throw new Error(`nothing at ${carrier.store}`); }
    const items = [];
    let answered = 0, lastError = null;
    for (const store of stores) {
      let rows;
      const db = new DatabaseSync(store, {readOnly: true, allowUnknownNamedParameters: true});
      // A query may also take :before (the oldest time a back-fill has reached; none means no bound) and :limit (a
      // back-fill's batch; -1 is no limit), as the `backfill` option reads the past.
      const bound = {since: time.from(since), before: carrier.before === undefined ? 1e15 : time.from(new Date(carrier.before)), limit: carrier.limit ?? -1};
      try { rows = db.prepare(carrier.query).all(bound); answered += 1; }
      catch (error) { if (!/no such table/i.test(error.message)) throw error; lastError = error; continue; }
      finally { db.close(); }
      for (const row of rows) {
        for (const {from, decoder, into} of carrier.decode ?? []) if (!row[into]) row[into] = DECODERS[decoder](row[from]);
        const decoded = new Set((carrier.decode ?? []).map(step => step.from));
        const values = Object.fromEntries(Object.entries(row).filter(([key, value]) => !decoded.has(key) && !(value instanceof Uint8Array)));
        const at = time.to(row.at).toISOString();
        const picture = row.picture ? path.resolve(expand(carrier.files_from ?? path.dirname(store)), row.picture) : null;
        Object.assign(values, {at, ...timeValues(at), source_id: String(row.source_id ?? ''), title: row.title ?? null});
        values.text = carrier.text ? fill(carrier.text, values) : row.text;
        const kept = carrier.file ? fileOf(carrier, store, row, values) : null;
        if (kept) values.text = `${values.text}${kept.note}`;
        items.push({...values, picture: picture && existsSync(picture) ? picture : undefined, ...(kept?.file ? {file: kept.file} : {})});
      }
    }
    if (!answered) throw lastError;
    return items.filter(item => item.source_id && String(item.text ?? '').trim());
  },
  // Any folder: each file added after `since` (names_containing narrows it, skip_endings passes over files still
  // arriving), described by the row's `text` template from name, size, path and time. The file itself is a picture
  // the place may preview; it is never sent whole.
  folder(carrier, since) {
    const folder = expand(carrier.store);
    const items = [];
    for (const entry of readdirSync(folder, {withFileTypes: true})) {
      if (!entry.isFile() || entry.name.startsWith('.')) continue;
      if (carrier.names_containing && !carrier.names_containing.some(part => entry.name.includes(part))) continue;
      if ((carrier.skip_endings ?? []).some(ending => entry.name.endsWith(ending))) continue;
      const file = path.join(folder, entry.name);
      // A file Trillion's own work just wrote here is not something new the person made (computer/own-writes.mjs).
      if (isOwnWrite(file)) continue;
      const stat = statSync(file);
      const added = stat.birthtimeMs || stat.mtimeMs;
      if (added <= since.getTime()) continue;
      const at = new Date(added).toISOString();
      const values = {name: entry.name, path: file, size: sizeOf(stat.size), at, ...timeValues(at)};
      items.push({...values, source_id: `${entry.name}:${Math.round(added)}`, title: entry.name, text: fill(carrier.text ?? '{name}', values), picture: file});
    }
    return items;
  },
};

// The readers, each run in a fresh child process (see the invariants). Resolves to the items or rejects with the
// reader's own error text.
/**
 * At most `most_children` reader children run at once (read-new-items.json). A read over the cap waits for a place up to
 * `wait_seconds`, then is turned away with the reason; a finished child hands its place to the oldest waiting read.
 */
export function childLimit({ most_children, wait_seconds }, { setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let running = 0;
  const waiting = [];
  const release = () => {
    const next = waiting.shift();
    if (next) { clearTimer(next.timer); next.resolve(); } else running -= 1;
  };
  return async run => {
    if (running >= most_children) {
      await new Promise((resolve, reject) => {
        const entry = { resolve, timer: setTimer(() => {
          waiting.splice(waiting.indexOf(entry), 1);
          reject(new Error(`Reading waits: ${running} readers are already running (at most ${most_children}); Trillion will try again.`));
        }, wait_seconds * 1000) };
        waiting.push(entry);
      });
    } else running += 1;
    try { return await run(); } finally { release(); }
  };
}
const childPlace = childLimit(limits);

export const CHILD_READERS = new Proxy({}, {
  // A slow read ends after the row's read_seconds (60 by default). A timeout alone does not prove an access refusal.
  get: (_, reader) => (carrier, since) => childPlace(() => new Promise((resolve, reject) => execFile(process.execPath, ['--no-warnings', fileURLToPath(import.meta.url), '--read', JSON.stringify({carrier: {...carrier, reader}, since: since.toISOString()})], {maxBuffer: 256 * 1024 * 1024, timeout: (carrier.read_seconds ?? 60) * 1000},
    (error, stdout, stderr) => (error ? reject(new Error(error.killed && error.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? 'Reading took too long; Trillion will try again.' : stderr.trim() || error.message)) : resolve(JSON.parse(stdout)))))),
});

const refusedByMacOS = error => /unable to open database|not permitted|authorization denied|EPERM|EACCES/i.test(String(error?.message ?? error));
const fold = text => String(text ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const keyOf = item => `${item.at}:${bytesToHex(blake3(new TextEncoder().encode(item.text))).slice(0, 24)}`;

/**
 * carriers: the DATA rows. account(route, {method, body}) -> {status, body} | null (trillion-account.mjs).
 * keep(file) -> {id, name}: puts a file in the person's files. openAccessPane(): opens the Privacy pane.
 */
// The account's own trouble (it is busy, down, or unreachable), as against one file that cannot be read.
// "could not be reached" is what keeping a file says when the account gave no answer at all (a timeout or no connection,
// read-this-computer.mjs fileKeeper): the account, not the item, so every place waits instead of trying item after item.
const accountTrouble = error => /\b(5\d\d|429)\b|busy|unavailable|not signed in|could not be reached|fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|socket hang up/i.test(String(error?.message ?? error));
// An answer about this one item (its words or files are not something the door takes), as against the account itself
// (not signed in, not on a plan that keeps it, not reachable, too busy): HTTP says which.
// Trouble that is about keeping this one item's file (the storage did not finish it), though it comes back as a 5xx like
// the account's own: it makes that item wait, not every place. The door itself not reachable or too busy never counts.
const fileTrouble = error => /did not finish this file|storage service|Durable Object/i.test(String(error?.message ?? error)) && !/\b429\b|not signed in|fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|socket hang up/i.test(String(error?.message ?? error));
const itemRefused = status => status >= 400 && status < 500 && ![401, 402, 403, 408, 429].includes(status);
// A 409 that names the account's own quota ("Resource quota: ...": an earlier command unsettled, a receipt not yet written), or that the
// account says is retryable, is the account's trouble of the moment, not a refusal of the item: the item waits on item_trouble's doubling
// wait, not the hour of a turn-away (2026-10-21: 3,000 photos and memos waited an hour per try behind it). Only a final refusal waits the hour.
const quotaTrouble = (status, body) => status === 409 && (body?.retryable === true || /^Resource quota:/.test(String(body?.error ?? '')));

/** A small JPEG of a picture in workdir (sips), or null when it is not a picture sips can read. */
export const makePreview = (picture, px, workdir) => new Promise(resolve => {
  mkdirSync(workdir, {recursive: true});
  const out = path.join(workdir, `${path.parse(picture).name} preview.jpg`);
  execFile('/usr/bin/sips', ['-Z', String(px), '-s', 'format', 'jpeg', picture, '--out', out], {timeout: 30_000}, error => resolve(!error && existsSync(out) ? out : null));
});

/** A JPEG copy of a picture in workdir (sips) whose long edge is at most `edge` pixels (a smaller picture is not enlarged), or null. */
export const makeCopy = (picture, edge, workdir) => new Promise(resolve => {
  mkdirSync(workdir, {recursive: true});
  const out = path.join(workdir, `${bytesToHex(blake3(new TextEncoder().encode(picture))).slice(0, 16)} copy.jpg`);
  execFile('/usr/bin/sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', picture], {timeout: 30_000}, (_, stdout) => {
    const sides = [...String(stdout ?? '').matchAll(/pixel(?:Width|Height):\s*(\d+)/g)].map(match => Number(match[1]));
    const shrink = !sides.length || Math.max(...sides) > edge;
    execFile('/usr/bin/sips', [...(shrink ? ['-Z', String(edge)] : []), '-s', 'format', 'jpeg', '-s', 'formatOptions', '85', picture, '--out', out], {timeout: 60_000}, error => resolve(!error && existsSync(out) ? out : null));
  });
});

/**
 * carriers: the `read` blocks of computer-sources.json rows. account(route, {method, body}) -> {status, body} | null
 * (trillion-account.mjs). keep(file) -> {id, name}: puts a file in the person's files. preview(picture, px, workdir)
 * -> path | null. openAccessPane(): opens the Privacy pane. hear(recording path) -> transcript value | null: hears a
 * recording on this computer (null when no hearing program is here); keepWords(identity, value): keeps the words as the
 * kept file's transcript, so the account's own hearing finds them there and hears nothing again. copy(picture, px, workdir)
 * -> path | null makes the capped JPEG a `file` row keeps. see(picture, type) -> observation | null reads a picture on this
 * computer (observe-visual.mjs: Apple Vision words and, when a local model answers, a caption); keepSeen(identity,
 * observation) keeps what was seen as the kept file's `visual-observation` result.
 */
export function readNewItems({carriers, account, keep, stateFile, workdir = path.join(path.dirname(stateFile), 'written-elsewhere-previews'), readers = CHILD_READERS, preview = makePreview, copy = makeCopy, hear = null, keepWords = null, see = null, keepSeen = null, spent = () => Date.now(), longText = null, turnedAway = {ask_again_minutes: 60}, itemTrouble = {retry_seconds: 60, longest_seconds: 1800}, now = () => new Date(), openAccessPane = () => execFile('/usr/bin/open', [accessPaneAddress()]), log = () => {}}) {
  let state = {};
  try { state = JSON.parse(readFileSync(stateFile, 'utf8')); } catch {}
  const save = () => { writeFileSync(`${stateFile}.next`, JSON.stringify(state, null, 1)); renameSync(`${stateFile}.next`, stateFile); };
  let running = false;
  // Seconds this look has spent reading pictures (`see`); a place's `see.look_budget_seconds` caps it (see seenOf).
  let seeing = 0;
  const quiet = () => state.account_quiet_until && Date.parse(state.account_quiet_until) > now().getTime();
  function wait(reason) {
    state.account_quiet_for = Math.min(Math.max((state.account_quiet_for ?? 30) * 2, 60), 1800);
    state.account_quiet_until = new Date(now().getTime() + state.account_quiet_for * 1000).toISOString();
    log(`${reason}; asking the account again after ${state.account_quiet_until}`);
    return `${reason}; waiting until ${state.account_quiet_until}`;
  }

  // A place whose read block has `hear` ({ text }, DATA) sends its recording with the words said in it: the recording is
  // heard on this computer before it is sent, and what was heard is kept in workdir under the recording's path, size and
  // time, so a send the account turned away is never heard twice. A recording that cannot be heard here goes without
  // its words, and the account's own hearing works them out after it arrives.
  async function heardOf(carrier, item) {
    if (!carrier.hear || !item.file || !hear) return null;
    const {size, mtimeMs} = statSync(item.file.path);
    const kept = path.join(workdir, 'heard', `${bytesToHex(blake3(new TextEncoder().encode(`${item.file.path}:${size}:${mtimeMs}`))).slice(0, 32)}.json`);
    try { return JSON.parse(readFileSync(kept, 'utf8')); } catch {}
    let value;
    try { value = await hear(item.file.path); }
    catch (error) { log(`${carrier.route}: ${item.source_id} goes without its words: ${String(error?.message ?? error).slice(0, 160)}`); return null; }
    if (!value) return null;
    mkdirSync(path.dirname(kept), {recursive: true});
    writeFileSync(kept, JSON.stringify(value));
    return value;
  }

  // What a place with `see` read in a picture, kept in workdir under the picture's path, size and time (and the item), so a
  // send the account turned away never reads it twice. A picture that cannot be read goes without its words.
  async function seenOf(carrier, item, pixels) {
    if (!carrier.see || !see || !pixels) return null;
    const source = item.file?.path ?? item.picture;
    const {size, mtimeMs} = statSync(source);
    const kept = path.join(workdir, 'seen', `${bytesToHex(blake3(new TextEncoder().encode(`${item.source_id}:${source}:${size}:${mtimeMs}`))).slice(0, 32)}.json`);
    try { return JSON.parse(readFileSync(kept, 'utf8')).observation; } catch {}
    // Once this look has spent its budget the rest are read for their words only (no model caption, nothing kept for
    // later), so a cold caption model can never hold the other places up; a caption is also cut off at its own timeout.
    const over = seeing >= (carrier.see.look_budget_seconds ?? Infinity);
    let observation;
    const began = spent();
    try { observation = await see(pixels, 'image/jpeg', {caption: !over, caption_timeout_seconds: carrier.see.caption_timeout_seconds}); }
    catch (error) { log(`${carrier.route}: ${item.source_id} goes without what is in it: ${String(error?.message ?? error).slice(0, 160)}`); return null; }
    finally { seeing += (spent() - began) / 1000; }
    if (over) return observation ?? null;
    mkdirSync(path.dirname(kept), {recursive: true});
    writeFileSync(kept, JSON.stringify({observation: observation ?? null}));
    return observation ?? null;
  }

  // The words a `see` row adds: the words in the picture, and what it shows when a local model described it.
  const seenWords = (carrier, observation) => {
    if (!observation) return '';
    const written = String(observation.text ?? '').replace(/\s+/g, ' ').trim().slice(0, carrier.see.ocr_characters ?? 2000);
    const shows = observation.confidence === 'vision-caption' ? String(observation.title ?? '').trim() : '';
    return `${written ? fill(carrier.see.ocr, {words: written}) : ''}${shows ? fill(carrier.see.caption, {words: shows}) : ''}`;
  };

  async function filesOf(carrier, item, made = null) {
    const files = item.file ? [await keep(made ? {...item.file, path: made} : item.file)] : [];
    const pictures = carrier.preview_px ? item.pictures ?? (item.picture ? [item.picture] : []) : [];
    for (const picture of pictures) {
      const made = await preview(picture, carrier.preview_px, workdir);
      if (!made) continue;
      // A preview is extra: an account that keeps no files (the free plan answers 402) still gets the item's words.
      try { files.push(await keep({path: made, name: path.basename(made), media_type: 'image/jpeg'})); }
      catch (error) { if (accountTrouble(error)) throw error; log(`${carrier.route}: sent without its preview: ${String(error?.message ?? error).slice(0, 120)}`); }
      finally { rmSync(made, {force: true}); }
    }
    return files.length ? files : undefined;
  }

  // Words longer than longText.characters (DATA: computer-sources.json `long_text`) go whole as a text file in the
  // person's files, and the item carries their opening and where the rest is, so a long note arrives instead of being
  // turned away for its length.
  async function wordsOf(carrier, item, words) {
    if (!longText || words.length <= longText.characters) return {text: words};
    mkdirSync(workdir, {recursive: true});
    const name = `${fill(longText.file_name, {route: carrier.route, title: item.title || item.source_id}).replace(/[/:]/g, '-')}.txt`;
    const made = path.join(workdir, `${bytesToHex(blake3(new TextEncoder().encode(`${carrier.route}:${item.source_id}`))).slice(0, 16)} ${name}`);
    writeFileSync(made, words);
    try {
      const file = await keep({path: made, name, media_type: 'text/plain; charset=utf-8'});
      return {text: `${words.slice(0, longText.characters)}${fill(longText.rest, {name, characters: words.length})}`, file};
    } finally { rmSync(made, {force: true}); }
  }

  // What one item sends to the door: its words (with what was heard and seen in it) and the files that go with it. A
  // `file` row's capped JPEG copy is made once, read, kept, and removed again.
  async function bodyOf(carrier, item) {
    const heard = await heardOf(carrier, item);
    let made = null;
    if (item.file?.long_edge) {
      made = await copy(item.file.path, item.file.long_edge, workdir);
      if (!made) { log(`${carrier.route}: ${item.source_id} goes without its picture: no copy could be made`); item = {...item, file: undefined}; }
    }
    try {
      // A kept video is not a picture: only its still (if any) is looked at, never the movie's bytes.
      const pixels = item.file && !String(item.file.media_type ?? '').startsWith('image/') ? item.picture : made ?? item.file?.path ?? item.picture;
      const observation = await seenOf(carrier, item, pixels);
      const files = await filesOf(carrier, item, made);
      if (heard && keepWords && files?.[0]?.id) {
        try { await keepWords(files[0].id, heard); }
        catch (error) { if (accountTrouble(error)) throw error; log(`${carrier.route}: the words of ${item.source_id} were not kept beside it: ${String(error?.message ?? error).slice(0, 160)}`); }
      }
      if (observation?.frames?.length && keepSeen && item.file && files?.[0]?.id) {
        try { await keepSeen(files[0].id, observation); }
        catch (error) { if (accountTrouble(error)) throw error; log(`${carrier.route}: what is in ${item.source_id} was not kept beside it: ${String(error?.message ?? error).slice(0, 160)}`); }
      }
      const words = heard?.text ? fill(carrier.hear.text, {text: item.text, words: heard.text}) : item.text;
      const {text, file} = await wordsOf(carrier, item, `${words}${seenWords(carrier, observation)}`);
      const all = [...(files ?? []), ...(file ? [file] : [])];
      return {route: carrier.route, source_id: item.source_id, text, at: item.at, ...(item.title ? {title: item.title} : {}), ...(item.source_ref ? {source_ref: item.source_ref} : {}), ...(item.conversation_id ? {conversation_id: item.conversation_id} : {}), ...(item.from && !carrier.group ? {from: item.from} : {}), ...(fromPersonOf(carrier, item) ? {} : {from_person: false}), ...(all.length ? {files: all} : {})};
    } finally { if (made) rmSync(made, {force: true}); }
  }

  // An item whose file the account would not keep (fileTrouble) waits alone, from itemTrouble.retry_seconds doubling to
  // longest_seconds, recorded per source_id in held.stuck. A transient storage failure never turns into a bare send:
  // the item remains pending until keeping its file succeeds.
  const stuck = (held, item) => { const entry = held.stuck?.[item.source_id]; return entry?.key === keyOf(item) && Date.parse(entry.until) > now().getTime(); };
  function itemWaits(carrier, held, item, reason) {
    const before = held.stuck?.[item.source_id];
    const tries = (before?.key === keyOf(item) ? before.tries : 0) + 1;
    const until = new Date(now().getTime() + Math.min(itemTrouble.retry_seconds * 2 ** (tries - 1), itemTrouble.longest_seconds) * 1000).toISOString();
    (held.stuck ??= {})[item.source_id] = {key: keyOf(item), tries, until};
    held.failed = {source_id: item.source_id, error: String(reason?.message ?? reason), at: now().toISOString()};
    save();
    log(`${carrier.route}: ${item.source_id} waits until ${until} (try ${tries}): ${held.failed.error.slice(0, 160)}`);
  }

  // An item the door turned away is not asked about again until it changes or turnedAway.ask_again_minutes (DATA:
  // computer-sources.json `turned_away`) have passed, since the door itself can change: on 2026-10-07 memos turned away
  // for a file field the door did not read yet would otherwise have waited for good after the door learned it.
  const stillTurnedAway = (held, item) => {
    const entry = held.refused?.[item.source_id];
    return entry?.key === keyOf(item) && now().getTime() - Date.parse(entry.at) < turnedAway.ask_again_minutes * 60_000;
  };

  // A place with `backfill` ({per_look, every_seconds, most_per_hour}) also reads its past, newest
  // first, from the time the first run began down to its oldest item: the row's query with :before (held.backfill_before,
  // the oldest time reached) and :limit. Each look sends one batch as a single `{ items }` request, at most per_look and
  // what is left of the hour's most_per_hour. The door counts an item whose `at` is a day or more older than the
  // time it is kept as brought in (src/brought-in.mjs), so the batch is history: kept and searchable, handing nothing on.
  // It starts at once, from where the live read began (held.first_since); a row may add history_after_minutes to make the
  // cursor wait until it is that old. What is under a day old simply arrives as live, as the door sees it.
  // A row whose `backfill.round` changes reads again what the live read already sent, from the live cursor (held.since)
  // down to where the live read began (held.first_since), then goes on from where the past had got to: what was sent
  // before the row learned to read pictures is read again, and nothing is sent twice by the past itself.
  async function backfill(carrier, held) {
    const plan = carrier.backfill;
    if (plan?.round && held.backfill_round !== plan.round && held.since) {
      const reached = held.backfill_before ?? null;
      held.backfill_round = plan.round;
      if (reached && held.first_since && reached < held.first_since) held.backfill_resume = {before: reached, done: Boolean(held.backfill_done)};
      held.backfill_before = held.since;
      delete held.backfill_done; delete held.backfill_seen;
    }
    if (plan && held.backfill_resume && held.first_since && held.backfill_before && held.backfill_before <= held.first_since) {
      held.backfill_before = held.backfill_resume.before;
      if (held.backfill_resume.done) held.backfill_done = true;
      delete held.backfill_resume; delete held.backfill_seen;
    }
    if (!plan || held.backfill_done || quiet()) return;
    // A look whose live part already used the picture-reading budget leaves the past for the next look.
    if (seeing >= (carrier.see?.look_budget_seconds ?? Infinity)) return;
    const at = now().getTime();
    if (held.backfill_at && at - Date.parse(held.backfill_at) < plan.every_seconds * 1000) return;
    if (held.backfill_retry_until && Date.parse(held.backfill_retry_until) > at) return;
    held.backfill_before ??= held.first_since;
    if (plan.history_after_minutes && Date.parse(held.backfill_before) > at - plan.history_after_minutes * 60_000) return;
    const hour = held.backfill_hour = (held.backfill_hour ?? []).filter(went => at - went < 3_600_000);
    const room = Math.min(plan.per_look, 200, plan.most_per_hour - hour.length);
    if (room <= 0) return;
    held.backfill_at = new Date(at).toISOString();
    let items;
    try { items = await readers[carrier.reader]({...carrier, backfill: undefined, before: held.backfill_before, limit: room + 1 + (held.backfill_seen?.length ?? 0)}, new Date(0)); }
    catch (error) { log(`${carrier.route}: the past could not be read: ${String(error?.message ?? error).slice(0, 160)}`); return; }
    // Items already sent at the instant the cursor stopped in (held.backfill_seen) come back with it, and are passed over.
    const seen = new Set(held.backfill_seen ?? []);
    items = items.filter(item => !seen.has(item.source_id)).sort((left, right) => right.at.localeCompare(left.at));
    // Reading again (a new round) stops where the live read began; below it the past goes on from where it had got to.
    if (held.backfill_resume && held.first_since) {
      items = items.filter(item => item.at >= held.first_since);
      if (!items.length) {
        held.backfill_before = held.backfill_resume.before;
        if (held.backfill_resume.done) held.backfill_done = true;
        delete held.backfill_resume; delete held.backfill_seen; save(); return;
      }
    }
    if (!items.length) { held.backfill_done = true; log(`${carrier.route}: everything older has been read`); save(); return; }
    // One more than the batch is read to see whether the batch ends part way through items kept at the same instant; if it
    // does, the rest of that instant waits for the next look (the batch stops short of it, or, when the whole batch is one
    // instant, the ones sent are remembered so they are not sent again).
    let going = items.slice(0, room);
    let next = going.at(-1).at;
    let remembered = [];
    if (items.length > room && items[room].at === next) {
      const whole = going.filter(item => item.at !== next);
      if (whole.length) going = whole;
      else remembered = [...seen, ...going.map(item => item.source_id)];
      next = new Date(Date.parse(next) + 1).toISOString();
    }
    const oldest = going.at(-1).at;
    // Permanently unreadable local media is passed over after two attempts. A transient storage failure keeps the
    // history cursor in place with capped backoff until the actual file can be kept.
    const bodies = [], ready = [];
    for (const item of going) {
      try { bodies.push(await bodyOf(carrier, item)); ready.push(item); }
      catch (error) {
        if (accountTrouble(error) && !fileTrouble(error)) { wait(`${carrier.route}: ${error?.message ?? error}`); return; }
        const reason = String(error?.message ?? error);
        const tries = (held.backfill_failures ??= {})[item.source_id] = (held.backfill_failures[item.source_id] ?? 0) + 1;
        held.failed = {source_id: item.source_id, error: reason, at: now().toISOString()};
        save();
        if (fileTrouble(error)) {
          held.backfill_retry_until = new Date(now().getTime() + Math.min(itemTrouble.retry_seconds * 2 ** (tries - 1), itemTrouble.longest_seconds) * 1000).toISOString();
          save();
          log(`${carrier.route}: a past item's file waits until ${held.backfill_retry_until} (try ${tries}): ${reason.slice(0, 160)}`);
          return;
        }
        if (tries < 2) { log(`${carrier.route}: a past item could not be made ready: ${reason.slice(0, 160)}`); return; }
        log(`${carrier.route}: the past item ${item.source_id} is passed over after ${tries} failures: ${reason.slice(0, 160)}`);
      }
    }
    for (const {source_id} of going) if (held.backfill_failures?.[source_id] && ready.some(item => item.source_id === source_id)) delete held.backfill_failures[source_id];
    let answer = {status: 200, body: {items: []}};
    if (ready.length) {
      try { answer = await account('/inbound', {method: 'POST', body: {items: bodies}}); }
      catch (error) { if (accountTrouble(error)) wait(`${carrier.route}: ${error?.message ?? error}`); else log(`${carrier.route}: the past could not be sent: ${String(error?.message ?? error).slice(0, 160)}`); return; }
    }
    if (answer?.status !== 200) { wait(answer ? `the account answered ${answer.status}: ${answer.body?.error ?? ''}`.trim() : 'not signed in on this Mac'); return; }
    // An item the door turned away is passed over (it is named in the log), never asked for again: the cursor moves on.
    const answers = answer.body?.items ?? [];
    const completed = [];
    let fileRetry = null;
    ready.forEach((item, index) => {
      if (answers[index]?.error) {
        const reason = String(answers[index].error);
        log(`${carrier.route}: the past item ${item.source_id} was turned away: ${reason.slice(0, 160)}`);
        if (fileTrouble(reason)) {
          const tries = (held.backfill_item_file_tries ??= {})[item.source_id] = (held.backfill_item_file_tries[item.source_id] ?? 0) + 1;
          fileRetry ??= {source_id: item.source_id, tries, reason};
          held.failed = {source_id: item.source_id, error: reason, at: now().toISOString()};
        } else {
          // Preserve the existing pass-over behavior for permanent item refusals while another sibling retries.
          completed.push(item.source_id);
        }
      } else {
        completed.push(item.source_id);
        if (held.backfill_failures) delete held.backfill_failures[item.source_id];
        if (held.backfill_item_file_tries) delete held.backfill_item_file_tries[item.source_id];
        if (held.failed?.source_id === item.source_id) delete held.failed;
        held.backfill_count = (held.backfill_count ?? 0) + 1;
        hour.push(at);
      }
    });
    if (fileRetry) {
      // Keep successful items out of the next read while leaving the failed item under the same cursor.
      held.backfill_seen = [...new Set([...seen, ...completed])];
      held.backfill_retry_until = new Date(now().getTime() + Math.min(itemTrouble.retry_seconds * 2 ** (fileRetry.tries - 1), itemTrouble.longest_seconds) * 1000).toISOString();
      save();
      log(`${carrier.route}: a past item's file waits until ${held.backfill_retry_until} (try ${fileRetry.tries}): ${fileRetry.reason.slice(0, 160)}`);
      return;
    }
    delete state.account_quiet_for;
    delete state.account_quiet_until;
    held.backfill_before = next;
    held.backfill_seen = remembered;
    delete held.backfill_retry_until;
    held.backfill_last_at = oldest;
    save();
    log(`${carrier.route}: sent ${going.length} older items as history, down to ${oldest}`);
  }

  async function carry(carrier) {
    const held = state[carrier.route] ??= {since: now().toISOString(), sent: {}};
    held.first_since ??= held.since;
    if (!Object.hasOwn(READERS, carrier.reader)) return (held.status = `no reader called ${carrier.reader}`);
    const read = readers[carrier.reader];
    let items;
    // A grouped place reads each window whole: from the start of the window `since` falls in, never before the first run.
    const size = (carrier.group?.window_minutes ?? 60) * 60_000;
    let readFrom = carrier.group ? Math.max(Date.parse(held.first_since), Math.floor(Date.parse(held.since) / size) * size - 1) : Date.parse(held.since);
    // Older readers advanced past a refused grouped window. Keep it in the read range until the door confirms it.
    const failedWindow = carrier.group && /@([^@]+)$/.exec(held.failed?.source_id ?? '');
    if (failedWindow && Number.isFinite(Date.parse(failedWindow[1])))
      readFrom = Math.max(Date.parse(held.first_since), Math.min(readFrom, Date.parse(failedWindow[1]) - 1));
    try { items = await read(carrier, new Date(readFrom)); }
    catch (error) {
      if (!refusedByMacOS(error) || !existsSync(baseOf(carrier.store))) return (held.status = String(error.message ?? error));
      if (!held.asked_for_access_at) { held.asked_for_access_at = now().toISOString(); openAccessPane(); }
      return (held.status = 'needs access');
    }
    if (carrier.group) items = grouped(items, carrier.group);
    held.status = 'working';
    // An older reader could leave a refusal/error behind after this version was delivered.
    if (held.failed) {
      const recovered = items.find(item => item.source_id === held.failed.source_id);
      if (recovered && held.sent[recovered.source_id] === keyOf(recovered)) delete held.failed;
    }
    for (const item of items) if (held.refused?.[item.source_id] && held.sent[item.source_id] === keyOf(item)) delete held.refused[item.source_id];
    held.last_read_at = now().toISOString();
    held.latest_item_at = items.reduce((latest, item) => item.at > latest ? item.at : latest, held.latest_item_at ?? '');
    held.seen_count = items.length;
    save();
    const settled = now().getTime() - (carrier.settle_seconds ?? 120) * 1000;
    held.waiting = 0;
    let wentThisLook = 0;
    for (const item of items.sort((left, right) => left.at.localeCompare(right.at))) {
      if (held.sent[item.source_id] === keyOf(item)) {
        if (carrier.reader === 'incoming') acknowledgeIncomingItem(expand(carrier.store), item);
        continue;
      }
      if (stillTurnedAway(held, item)) continue;
      if (stuck(held, item)) { held.waiting += 1; continue; }
      if (Date.parse(item.at) > settled) { held.waiting += 1; continue; }
      // A place whose items each take reading (Photos) sends at most `most_per_look` a look; the rest wait for the next.
      if (carrier.most_per_look && wentThisLook >= carrier.most_per_look) { held.waiting += 1; continue; }
      let answer;
      try {
        if (carrier.reader === 'incoming' && assertIncomingAllowed(expand(carrier.store), item) === false) {
          if (held.failed?.source_id === item.source_id) delete held.failed;
          if (held.refused) delete held.refused[item.source_id];
          continue;
        }
        const body = await bodyOf(carrier, item);
        if (carrier.reader === 'incoming' && assertIncomingAllowed(expand(carrier.store), item) === false) {
          if (held.failed?.source_id === item.source_id) delete held.failed;
          if (held.refused) delete held.refused[item.source_id];
          continue;
        }
        answer = await account('/inbound', {method: 'POST', body});
      } catch (error) {
        if (fileTrouble(error)) { itemWaits(carrier, held, item, error); continue; }
        if (accountTrouble(error)) return (held.status = wait(`${carrier.route}: ${error?.message ?? error}`));
        held.failed = {source_id: item.source_id, error: String(error?.message ?? error), at: now().toISOString()};
        log(`${carrier.route}: could not send ${item.source_id}: ${held.failed.error}`);
        continue;
      }
      // The door turned this one item away: it is not asked about again until it changes, and the rest still go.
      if (answer && quotaTrouble(answer.status, answer.body)) { itemWaits(carrier, held, item, `the account answered ${answer.status}: ${answer.body.error}`); continue; }
      if (answer && itemRefused(answer.status)) {
        held.failed = {source_id: item.source_id, error: `the account answered ${answer.status}: ${answer.body?.error ?? ''}`.trim(), at: now().toISOString()};
        (held.refused ??= {})[item.source_id] = {key: keyOf(item), at: now().toISOString()};
        save();
        log(`${carrier.route}: ${item.source_id} was turned away: ${held.failed.error.slice(0, 200)}`);
        continue;
      }
      if (answer?.status >= 500 && fileTrouble(answer.body?.error)) { itemWaits(carrier, held, item, `the account answered ${answer.status}: ${answer.body.error}`); continue; }
      if (answer?.status !== 200) return (held.status = wait(answer ? `the account answered ${answer.status}: ${answer.body?.error ?? ''}`.trim() : 'not signed in on this Mac'));
      if (![answer.body?.message_id, answer.body?.arrival_id].some(value => typeof value === 'string' && value.trim())) return (held.status = wait('the account did not confirm an item receipt'));
      delete state.account_quiet_for;
      delete state.account_quiet_until;
      wentThisLook += 1;
      held.sent[item.source_id] = keyOf(item);
      if (held.stuck) delete held.stuck[item.source_id];
      if (held.failed?.source_id === item.source_id) delete held.failed;
      if (held.refused) delete held.refused[item.source_id];
      held.first_arrival_at ??= now().toISOString();
      // The account answers { message_id, arrival_id, repeated, decision_case_id? }; its rules hand the arrival on.
      held.last_sent = {at: now().toISOString(), message_id: answer.body?.message_id ?? null, arrival_id: answer.body?.arrival_id ?? null, decision_case_id: answer.body?.decision_case_id ?? null};
      save();
      if (carrier.reader === 'incoming') acknowledgeIncomingItem(expand(carrier.store), item);
      log(`${carrier.route}: sent ${item.source_id} as ${held.last_sent.arrival_id ?? held.last_sent.message_id}`);
    }
    if (carrier.cursor === 'moves') {
      // Read next from the oldest item not yet sent, and at least reread_minutes back, never before the first run; what
      // was sent before that is never read again, so it is forgotten.
      // A refusal is still an unsent item. Keeping it behind the cursor is what makes its timed retry real, and
      // readers use a strict > cursor predicate, so the cursor stays one millisecond before that item's start.
      const unsent = items.filter(item => held.sent[item.source_id] !== keyOf(item)).map(item => Date.parse(item.from ?? item.at) - (carrier.group ? 0 : 1));
      const reread = now().getTime() - (carrier.reread_minutes ?? 60) * 60_000;
      const next = Math.max(Date.parse(held.first_since), Math.min(reread, ...unsent));
      held.since = new Date(next).toISOString();
      for (const [id, key] of Object.entries(held.sent)) if (Date.parse(key.slice(0, 24)) <= next) delete held.sent[id];
      for (const [id, {key}] of Object.entries(held.refused ?? {})) if (Date.parse(String(key).slice(0, 24)) <= next) delete held.refused[id];
      for (const [id, {key}] of Object.entries(held.stuck ?? {})) if (Date.parse(String(key).slice(0, 24)) <= next) delete held.stuck[id];
    }
    await backfill(carrier, held);
    return (held.status = 'working');
  }

  return {
    async tick() {
      if (running || quiet()) return;
      running = true;
      seeing = 0;
      try {
        // Start at the place after the one that started the last look, so one place that keeps the account waiting never
        // starves the rest: every place gets its turn over successive looks. When a place sets the account-wide wait, the
        // next look starts at the place after it, so the places behind it are next in line, not one look further each.
        const count = carriers.length || 1;
        const first = (state.next_place ?? 0) % count;
        state.next_place = (first + 1) % count;
        for (const [step, carrier] of [...carriers.slice(first), ...carriers.slice(0, first)].entries()) {
          try { await carry(carrier); } catch (error) { (state[carrier.route] ??= {since: now().toISOString(), sent: {}}).status = String(error.message ?? error); }
          if (quiet()) { state.next_place = (first + step + 1) % count; break; }
        }
        save();
      } finally { running = false; }
    },
    // Everything a carrier's store holds (not only what came after `since`), matched against the words of `q` in its
    // title or text: every word must appear, case and accents ignored. Read in the same fresh children, so it answers
    // only once macOS lets this app read the store. Nothing is sent anywhere.
    async search(q, {routes = null} = {}) {
      const words = fold(q).split(/\s+/).filter(Boolean);
      if (!words.length) throw new Error('Say what to look for.');
      const found = [], refused = [];
      for (const carrier of carriers) {
        if (routes && !routes.includes(carrier.route)) continue;
        if (!Object.hasOwn(READERS, carrier.reader)) continue;
        let items;
        try { items = await readers[carrier.reader]({...carrier, include_delivered: true}, new Date(0)); }
        catch (error) { refused.push({route: carrier.route, status: refusedByMacOS(error) ? 'needs access' : String(error.message ?? error)}); continue; }
        for (const item of items) {
          const haystack = fold(`${item.title ?? ''}\n${item.text ?? ''}`);
          if (words.every(word => haystack.includes(word))) found.push({route: carrier.route, source_id: item.source_id, title: item.title ?? null, at: item.at, text: item.text});
        }
      }
      return {items: found.sort((left, right) => right.at.localeCompare(left.at)), refused};
    },
    status: () => carriers.map(carrier => {
      const held = state[carrier.route];
      return {route: carrier.route, status: held?.status ?? 'starting', arrived: Boolean(held?.first_arrival_at || held?.last_sent), waiting: held?.waiting ?? 0,
        last_sent: held?.last_sent ?? null, last_read_at: held?.last_read_at ?? null,
        latest_item_at: held?.latest_item_at ?? null, seen_count: held?.seen_count ?? 0,
        failed: held?.failed ?? null, account_waits_until: quiet() ? state.account_quiet_until : null};
    }),
  };
}

// Run as a child: node read-new-items.mjs --read '{"carrier": {...}, "since": "<iso>"}' prints the items as JSON.
if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === '--read') {
  const {carrier, since} = JSON.parse(process.argv[3]);
  try { process.stdout.write(JSON.stringify(READERS[carrier.reader](carrier, new Date(since)))); }
  catch (error) { process.stderr.write(String(error.message ?? error)); process.exitCode = 1; }
}
