// src/subject-boards.mjs
//
// Purpose
//   Any record keeps a board: one space for the subject (a decision, a pursuit, a plan, a product, any key), whose
//   Board place (parts/group/show/board-screen.tsx) lays out what is put there in one row per section, and whose lists
//   read the same things as a document sectioned the same way. It runs as Trillion's own Workshop tool
//   tool:keep-a-board (placement this-account, records/workshop-account-tool-records.json), so an AI, a rule or a
//   schedule puts the inspiration, the work and each version's picture on a subject's board with nobody making it.
//   Trillion's own default that would give every decided build a board (records/starting-rules.json
//   starting:board-for-each-decided-build) ships turned off: a space is who a record is shared with (decided
//   2026-10-01), so a space per decision only filled the person's list; a person who wants it turns it on, and any AI
//   or rule may still ask for a board.
//
//   keepABoard({ subject, title, items: [{ section, title?, text? | url? (picture?) | file?, key? }] })
//     -> { space_id, made, added, already_there, said }
//   keepABoard({ subject?, title?, feed: { url, items?, key?, section?, values: { title?, text?, url?, picture?,
//     subject?, subject_title?, section? } } })
//     -> { boards: [{ subject, space_id, made, added }], waiting, read, said }
//   A feed is any https address answering JSON (a product's what's-new list, a shop's products, a log of versions):
//   each item becomes one thing on the board of the subject it names (values.subject), else on `subject`'s board. Its
//   picture is kept in the person's files and put on the board as a picture card; without one, its words are a note.
//
// Non-negotiable invariants
//   1. One space per subject, remembered in one fact (`subject_boards`: { <subject>: { space_id, title, made_at } }),
//      so running it again changes nothing, and a space the person left is never made again under the same subject.
//   2. A pursuit's board is its own room (src/pursuit-rooms.mjs pursuitRoom, made the first time); a second room is
//      never made for it. A board for anything else is a room the person's pursuit list takes in as a pursuit.
//   3. A thing is put on a board once: each carries a source key (its `key`, else its file, address or words), and the
//      space's one-item-per-source rule (src/spaces.mjs addSpaceItems, shareIntoSpace) makes a repeat add nothing.
//   4. A thing's section is the item fact named by `section_fact` (src/subject-boards.json); sections are whatever
//      words the caller sends. Nothing here names a section, a subject, a person or a product.
//   5. A file is shared into the space from the person's own files (src/record-sharing.mjs shareInto), so its bytes
//      stay theirs; nobody is invited and nothing private is copied into the space's description.
//   6. Runs are one at a time per store, so two runs for one new subject cannot make two spaces.
//   7. A feed item is read once: its key is kept in the `subject_boards_read` fact for its feed, so its picture is not
//      fetched again however often a schedule runs; at most `feed.most_per_run` new items are taken per run and
//      `waiting` says how many are left. Only https addresses are read. Nothing here names a feed or a field: which item
//      field is which is the caller's selectors (parts/ui/read-data/declared-selector.ts).
//   8. A board's sections keep the order they first arrived in (kept with the subject as `sections`); each thing also
//      carries its section's place (item fact `section_order_fact`), so the board lays new rows in that order.
//
import settings from './subject-boards.json' with { type: 'json' };
import { selectDeclaredValue } from '../../ui/read-data/declared-selector.ts';
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';

const FACT = 'subject_boards';
const READ_FACT = 'subject_boards_read';
const selected = (value, selector) => {
  if (typeof selector !== 'string' || !selector) return undefined;
  const found = selectDeclaredValue(value, selector);
  return found && typeof found === 'object' && 'selector_contract_error' in found ? undefined : found;
};
const httpsAddress = (value, base) => {
  if (typeof value !== 'string' || !value.trim()) return null;
  try { const url = new URL(value, base); return url.protocol === 'https:' ? url : null; } catch { return null; }
};
const fill = (template, values) => String(template ?? '').replace(/\{(\w+)\}/g, (_, name) => String(values?.[name] ?? ''));
const words = (value, most) => (typeof value === 'string' ? value.trim().slice(0, most) : '');

/** One thing as the space keeps it: what it is, its source key and its section; null for a thing with nothing in it. */
export function boardThing(item) {
  const section = words(item?.section, 200);
  const title = words(item?.title, 300) || null;
  const key = words(item?.key, 400);
  if (typeof item?.file === 'string' && /^(1f|12):[0-9a-f]{64}$/.test(item.file)) return { section, title, file: item.file };
  const url = words(item?.url, 2000);
  const picture = words(item?.picture, 2000);
  if (/^https?:\/\/\S+$/i.test(url)) return { section, title, kind: settings.kinds.link, body: { url, ...(/^https:\/\/\S+$/i.test(picture) ? { picture } : {}) }, source_ref: `board:${key || url}`.slice(0, 500) };
  const text = words(item?.text, 20000);
  if (text) return { section, title, kind: settings.kinds.note, body: text, source_ref: `board:${key || `${section}:${text}`}`.slice(0, 500) };
  return null;
}

export const subjectBoardMethods = {
  // tool:keep-a-board.
  keepABoard(input = {}) {
    const run = (this.subjectBoardsRun ?? Promise.resolve()).catch(() => {}).then(() => (input?.feed ? this.subjectBoardsFromFeed(input) : this.subjectBoardOnce(input)));
    this.subjectBoardsRun = run;
    return run;
  },

  async subjectBoardOnce({ subject, title, items = [] } = {}) {
    const key = words(subject, 500);
    if (!key) throw new Error('subject names the thing the board is for: a record id, or any words that stay the same.');
    if (!Array.isArray(items) || items.length > settings.most_items) throw new Error(`items is a list of at most ${settings.most_items} things.`);
    const things = items.map(boardThing);
    if (things.some(thing => thing === null)) throw new Error('Each thing has a section and one of text, url or file (a file identity from this person\'s files).');
    const network = this.network();
    const relay = this.relay();
    const kept = { ...(this.fact(FACT) ?? {}) };
    const spaces = (await network.spaces({ relay })).spaces;
    const has = id => spaces.some(space => space.space_id === id);
    // Invariant 2: a pursuit's own room is its board.
    const pursuitRoom = !kept[key] && key.startsWith('pursuit:') ? (await this.pursuitRoom(key)).space_id : null;
    let spaceId = kept[key]?.space_id ?? pursuitRoom;
    const name = words(title, 300) || kept[key]?.title || key;
    let made = false;
    if (spaceId && !has(spaceId)) throw new Error('You left the pursuit this board was in, so it is not made again. Ask its owner to invite you back.');
    if (!spaceId) {
      spaceId = (await network.createMembership({ relay, person_ref: this.ctx.id.toString(), label: settings.space_label, title: name })).membership_id;
      made = true;
    }
    if (!kept[key]) { kept[key] = { space_id: spaceId, title: name, made_at: new Date().toISOString() }; this.setFact(FACT, kept); }
    const at = { relay, space_id: spaceId };
    const placed = [];
    let added = 0;
    const own = things.filter(thing => !thing.file);
    if (own.length) {
      const answer = await network.addSpaceItems({ ...at, items: own.map(({ kind, title: label, body, source_ref }) => ({ kind, title: label, body, source_ref })) });
      added += answer.added.length;
      own.forEach((thing, index) => placed.push({ id: answer.ids[index], section: thing.section }));
    }
    for (const thing of things.filter(one => one.file)) {
      const answer = await this.shareInto(spaceId, { file: thing.file });
      if (!answer.updated) added += 1;
      placed.push({ id: answer.item_id, section: thing.section });
    }
    // Invariant 8: each section keeps the place it first came in, so the board lays its rows in that order.
    const sections = [...(kept[key].sections ?? [])];
    for (const { section } of placed) if (section && !sections.includes(section)) sections.push(section);
    if (sections.length !== (kept[key].sections ?? []).length) { kept[key] = { ...kept[key], sections }; this.setFact(FACT, kept); }
    for (const { id, section } of placed) {
      if (section) await network.setSpaceItemFacts({ ...at, item_id: id, facts: { [settings.section_fact]: section, [settings.section_order_fact]: sections.indexOf(section) } });
    }
    const said = fill(made ? settings.said.made : added ? settings.said.kept : settings.said.nothing, { title: name, added });
    return { space_id: spaceId, made, added, already_there: things.length - added, said };
  },

  // Invariant 7: each new item of a feed onto the board of the subject it names.
  async subjectBoardsFromFeed({ subject, title, feed = {}, read = (...args) => fetch(...args) } = {}) {
    const feedUrl = httpsAddress(feed.url);
    if (!feedUrl) throw new Error('feed.url is an https address that answers JSON.');
    const values = feed.values && typeof feed.values === 'object' ? feed.values : {};
    const answer = await read(feedUrl, { headers: { accept: 'application/json' } });
    if (!answer.ok) throw new Error(`${feedUrl.host} answered ${answer.status} instead of the feed.`);
    const body = await answer.json();
    const found = selected(body, feed.items ?? '$.rows');
    const items = Array.isArray(found) ? found : Array.isArray(body) ? body : [];
    const seenAll = { ...(this.fact(READ_FACT) ?? {}) };
    const seen = new Set(seenAll[feedUrl.href] ?? []);
    const feedId = bytesToHex(blake3(new TextEncoder().encode(feedUrl.href))).slice(0, 16);
    const fresh = [];
    const within = new Set();
    for (const item of items) {
      const key = selected(item, feed.key ?? '$.id');
      if (key === undefined || key === null || key === '' || seen.has(String(key)) || within.has(String(key))) continue;
      within.add(String(key));
      fresh.push({ key: String(key), item });
    }
    const now = fresh.slice(0, settings.feed.most_per_run);
    const groups = new Map();
    for (const { key, item } of now) {
      const text = value => { const found = selected(item, value); return typeof found === 'string' ? found.trim() : typeof found === 'number' ? String(found) : ''; };
      const to = text(values.subject) || words(subject, 500);
      if (!to) continue;
      const scoped = `${feedId}:${key}`;
      const thing = { section: text(values.section) || words(feed.section, 200) || settings.feed.section, title: text(values.title) || null, key: `feed:${scoped}` };
      const picture = httpsAddress(text(values.picture), feedUrl);
      const kept = picture ? await this.subjectBoardPicture(picture, `${settings.feed.folder}/${scoped.replace(/[^\w.-]+/g, '-').slice(0, 120)}`, read) : null;
      const link = httpsAddress(text(values.url), feedUrl);
      const note = text(values.text);
      if (kept) Object.assign(thing, { file: kept });
      else if (link) Object.assign(thing, { url: link.href });
      else if (note) Object.assign(thing, { text: note });
      else continue;
      const group = groups.get(to) ?? { title: text(values.subject_title) || (to === words(subject, 500) ? title : null), items: [] };
      group.items.push(thing);
      groups.set(to, group);
    }
    const boards = [];
    for (const [to, group] of groups) {
      const kept = await this.subjectBoardOnce({ subject: to, title: group.title ?? undefined, items: group.items });
      boards.push({ subject: to, space_id: kept.space_id, made: kept.made, added: kept.added });
    }
    for (const { key } of now) seen.add(key);
    seenAll[feedUrl.href] = [...seen].slice(-settings.feed.most_remembered);
    this.setFact(READ_FACT, seenAll);
    const waiting = fresh.length - now.length;
    const added = boards.reduce((sum, board) => sum + board.added, 0);
    return { boards, waiting, read: items.length, said: fill(added ? settings.said.feed : settings.said.feed_nothing, { added, boards: boards.length, waiting }) };
  },

  // A feed item's picture, kept in the person's own files; its identity, or null when it cannot be read.
  async subjectBoardPicture(address, name, read) {
    const file = await read(address).catch(() => null);
    if (!file?.ok) return null;
    const type = file.headers.get('content-type') || '';
    if (!type.startsWith('image/')) return null;
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (!bytes.byteLength) return null;
    const ending = type.split('/')[1]?.split(';')[0] || 'png';
    const kept = await this.namespaceFiles().keep({ name: `${name}.${ending}`, size: bytes.byteLength, open: async () => [bytes], media_type: type });
    return typeof kept?.identity === 'string' ? kept.identity : null;
  },
};

/** The account action of one person store (the row's invoke.action). */
export const subjectBoardActions = store => ({
  'keep-a-board': async input => store.keepABoard(input ?? {}),
});
