// tools/recently-deleted-and-storage/do-work/recently-deleted-actions.mjs
//
// PURPOSE
//   The AI tools of Recently Deleted and Archived, running over what the engine really has: the person's files door
//   (set_aside, put_back, list_set_aside, forget_set_aside, find_file: tools/live-namespace) and their account records.
//   The engine's set-aside tree holds the names; one record per item (type set-aside-item, set-aside-live.json) adds
//   what the tree does not hold: the state (Recently Deleted or Archived, namespace-set-aside.json), when the item
//   entered it and by whom. How long each state keeps things is the person's own setting:keep_for over the state's
//   default (read-data/when-due.mjs). A name another door set aside (Finder's Trash, an old carried program's
//   delete_file) is adopted into a Recently Deleted item the first time a list or a sweep sees it, so it too shows its
//   days left and is given up when its time ends.
//
//   deleteFiles / archiveFiles  take files, folders or recordings out of view into a state
//   listRecentlyDeleted         what is set aside, newest first, with the days each has left
//   putBackFiles                give every name of these items back
//   setKeepFor                  change how long a state keeps things
//   sweepRecentlyDeleted        move on what is due: Archived to Recently Deleted, Recently Deleted for good
//
//   Each is `fn(input, { door })`, run by tools/records-door/do-work/run-an-export.mjs. Nothing here deletes a byte:
//   forgetting a name notes its file for the byte release (the engine's forget_set_aside), which gives storage back
//   by the person's release rules.
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import { randomUUID } from 'node:crypto';
import settings from '../namespace-set-aside.json' with { type: 'json' };
import live from '../set-aside-live.json' with { type: 'json' };
import { checkDays, due, fail, keepForAnswer, shown, stateOf } from '../read-data/when-due.mjs';

const identityWords = /^(1f|12):[0-9a-f]{64}$/;
const labelOf = name => name.split('/').filter(Boolean).at(-1) ?? name;
const whereOf = name => name.slice(0, name.lastIndexOf('/')) || '/';
const gone = error => /not.?found/i.test(error?.message ?? '');

async function readKeep(door) {
  const record = await door.readRecord(live.keep_for_type, live.keep_for_id);
  return { record, keep: record?.value?.value ?? {} };
}

// What a write expects of the record it changes: its root identity where the door gives one, else its whole value as
// read (the values the person's AI hands the run carry no identity); null when the record must not exist yet.
const expectedOf = (type, before) => (!before ? null : before.identity ? { type, identity: before.identity } : { type, value: before.value });
// One write of one record at the version just read.
async function save(door, id, before, value) {
  await door.write([{ id, type: live.item_type, value, expected: expectedOf(live.item_type, before) }], { key: `set-aside:${randomUUID()}` });
}
const loadItem = async (door, id) => {
  const record = typeof id === 'string' && id.startsWith(live.item_prefix) ? await door.readRecord(live.item_type, id) : null;
  return record?.value?.schema === live.schema && record.value.id === id ? record : null;
};

// One name's set_aside, put_back or forget_set_aside, page by page until its walk is done. Answers what moved.
async function walk(door, operation, name, first = {}) {
  let after, names = 0, folders = 0;
  for (let page = 0; page < live.engine_pages; page += 1) {
    const answer = await door.files(operation, { name, ...(page === 0 ? first : {}), ...(after ? { after } : {}) });
    names += answer?.names ?? 0;
    folders += answer?.folders ?? 0;
    if (!answer?.next_after) return { names, folders };
    after = answer.next_after;
  }
  throw fail('too_large', `${name} has more names than one call moves. Ask again to continue.`);
}

// Every item that is set aside and kept: the items already recorded plus the names another door set aside (adopted
// into a Recently Deleted item here, at most `adopt_items` a run).
async function heldItems(door, now) {
  const items = [];
  for await (const row of door.list({ type: live.item_type })) if (row.value?.schema === live.schema && row.value.status === 'held') items.push(row.value);
  const covered = items.flatMap(item => item.names);
  const isCovered = name => covered.some(top => name === top || name.startsWith(`${top}/`));
  const stack = ['/'];
  let calls = 0, adopted = 0;
  while (stack.length && calls < live.adopt_calls && adopted < live.adopt_items) {
    const folder = stack.pop();
    for (let after; calls < live.adopt_calls;) {
      calls += 1;
      const answer = await door.files('list_set_aside', { folder, limit: live.adopt_page, ...(after ? { after } : {}) });
      for (const row of answer?.names ?? []) {
        if (adopted >= live.adopt_items || isCovered(row.name)) continue;
        const item = { schema: live.schema, id: `${live.item_prefix}${randomUUID()}`, label: labelOf(row.name), state: 'deleted', names: [row.name], name_count: 1,
          folder: false, entered_at_ms: Date.parse(row.named_at) || now, by: live.adopted_by, status: 'held',
          ...(Number.isInteger(row.byte_length) ? { byte_length: row.byte_length } : {}) };
        await save(door, item.id, null, item);
        items.push(item);
        adopted += 1;
      }
      if (after === undefined) stack.push(...answer?.folders ?? []);
      if (!answer?.next_after) break;
      after = answer.next_after;
    }
  }
  return items;
}

const seen = (item, keep, now) => ({ ...shown(item, keep, now), set_aside_at: new Date(item.entered_at_ms).toISOString(),
  where: whereOf(item.names[0]), names: item.names.slice(0, settings.names_shown_per_item) });

/** Take these files, folders or recordings out of view into `state`: { items: [{ name, expected_version? } | { identity, label? }], by? }.
 *  Answers { set_aside: [item], refused: [{ asked, error }], said }. */
export async function setAsideFiles({ state, items, by = null } = {}, { door, now = Date.now } = {}) {
  stateOf(state);
  if (!Array.isArray(items) || !items.length || items.length > settings.items_per_request) throw fail('bad_items', `Choose from 1 to ${settings.items_per_request} files or folders.`);
  const done = [], refused = [];
  for (const asked of items) {
    const moved = [];
    let counted = { names: 0, folders: 0 }, label = null;
    try {
      if (typeof asked?.name === 'string') {
        const name = asked.name.trim().replace(/\/+$/, '');
        if (!name.startsWith('/')) throw fail('bad_name', 'Give a name starting with /, or a file identity.');
        label = asked.label ?? labelOf(name);
        const answer = await walk(door, 'set_aside', name, Object.hasOwn(asked, 'expected_version') ? { expected_version: asked.expected_version } : {});
        moved.push(name);
        counted = answer;
      } else if (identityWords.test(asked?.identity ?? '')) {
        // A recording or file with every name it has: each live name is set aside, in passes while it still has one.
        label = asked.label ?? asked.identity;
        for (let pass = 0; pass < live.max_passes; pass += 1) {
          // A file with no live name left may answer not found; either way there is nothing more to set aside.
          const names = (await door.files('find_file', { name_or_identity: asked.identity }).catch(error => (gone(error) ? { names: [] } : Promise.reject(error))))?.names ?? [];
          if (!names.length) break;
          for (const name of names) {
            const answer = await walk(door, 'set_aside', name);
            moved.push(name);
            counted = { names: counted.names + answer.names, folders: counted.folders + answer.folders };
          }
        }
        if (!moved.length) throw fail('no_name', 'That file has no name to set aside.');
      } else throw fail('bad_name', 'Give a name starting with /, or a file identity.');
    } catch (error) {
      if (!moved.length) { refused.push({ asked, error: error.message }); continue; }
      refused.push({ asked, error: `${error.message} Set aside so far: ${moved.join(', ')}.` });
    }
    const item = { schema: live.schema, id: `${live.item_prefix}${randomUUID()}`, label, state, names: moved, name_count: counted.names, folder: counted.folders > 0,
      entered_at_ms: now(), by, status: 'held' };
    await save(door, item.id, null, item);
    done.push(seen(item, (await readKeep(door)).keep, now()));
  }
  return { set_aside: done, refused, said: stateOf(state).set_aside_words };
}

/** tool:delete-files */
export const deleteFiles = (input, context) => setAsideFiles({ ...input, state: 'deleted' }, context);
/** tool:archive-files */
export const archiveFiles = (input, context) => setAsideFiles({ ...input, state: 'archived' }, context);

/** What is set aside, newest first, a page at a time (`after`: the last row's { ms, id }). Answers { items, next_after, keep_for }. */
export async function listRecentlyDeleted({ state = null, after = null, limit } = {}, { door, now = Date.now } = {}) {
  if (state !== null) stateOf(state);
  const size = Math.min(Math.max(1, Number(limit) || settings.list_limit), settings.list_limit);
  const { keep } = await readKeep(door);
  const at = now();
  const all = (await heldItems(door, at)).filter(item => state === null || item.state === state)
    .sort((a, b) => b.entered_at_ms - a.entered_at_ms || (a.id < b.id ? 1 : -1));
  const start = after && typeof after === 'object' ? all.findIndex(item => item.entered_at_ms < after.ms || item.entered_at_ms === after.ms && item.id < after.id) : 0;
  const rest = start < 0 ? [] : all.slice(start);
  const page = rest.slice(0, size);
  return { items: page.map(item => seen(item, keep, at)), next_after: rest.length > size ? { ms: page.at(-1).entered_at_ms, id: page.at(-1).id } : null, keep_for: keepForAnswer(keep) };
}

/** Give every name of these items back: { ids }. Answers { results: [{ id, label, put_back: true } | { id, label?, error }] }. */
export async function putBackFiles({ ids } = {}, { door } = {}) {
  if (!Array.isArray(ids) || !ids.length || ids.length > settings.items_per_request) throw fail('bad_ids', `Choose from 1 to ${settings.items_per_request} to put back.`);
  const results = [];
  for (const id of new Set(ids)) {
    const record = await loadItem(door, id);
    if (!record || record.value.status !== 'held') { results.push({ id, error: 'It is not in Recently Deleted or Archived.' }); continue; }
    const item = record.value;
    const left = [...item.names];
    let error = null;
    for (const name of item.names) {
      try { await walk(door, 'put_back', name); left.splice(left.indexOf(name), 1); }
      catch (caught) {
        error = /already names another file/.test(caught.message) ? `Another file now has the name ${name}. Rename or move that one, then put this back.` : caught.message;
        break;
      }
    }
    if (left.length !== item.names.length) await save(door, id, record, { ...item, names: left, ...(left.length ? {} : { status: 'restored' }) });
    results.push(error ? { id, label: item.label, error } : { id, label: item.label, put_back: true });
  }
  return { results };
}

/** Change how long a state keeps things: { after_days: { <state>: days | null } }; a state left out keeps its days. Answers the keep-for now in force. */
export async function setKeepFor({ after_days } = {}, { door } = {}) {
  if (!after_days || typeof after_days !== 'object' || Array.isArray(after_days)) throw fail('bad_keep_for', 'Say how many days each state keeps things, as after_days: { state: days }.');
  const chosen = Object.entries(after_days).map(([state, days]) => [stateOf(state).id, checkDays(days)]);
  const { record, keep } = await readKeep(door);
  const next = { ...keep, ...Object.fromEntries(chosen) };
  if (chosen.length) {
    await door.write([{ id: live.keep_for_id, type: live.keep_for_type, value: { ...(record?.value ?? {}), value: next },
      expected: expectedOf(live.keep_for_type, record) }], { key: `set-aside-keep-for:${randomUUID()}` });
  }
  return keepForAnswer(next);
}

/** Move on everything whose time has ended (as of `at`, an ISO time, or now), oldest first, at most `sweep_batch`: Archived to Recently Deleted, Recently Deleted for good.
 *  Answers { moved: [{ id, label, to }], removed: [{ id, label }] }. */
export async function sweepRecentlyDeleted({ at } = {}, { door, now = Date.now } = {}) {
  const when = typeof at === 'string' && Number.isFinite(Date.parse(at)) ? Date.parse(at) : now();
  const { keep } = await readKeep(door);
  const ended = (await heldItems(door, when)).filter(item => { const time = due(item, keep); return time !== null && time <= when; })
    .sort((a, b) => a.entered_at_ms - b.entered_at_ms || (a.id < b.id ? -1 : 1)).slice(0, settings.sweep_batch);
  const moved = [], removed = [];
  for (const item of ended) {
    const record = await loadItem(door, item.id);
    if (!record || record.value.status !== 'held') continue;
    const target = stateOf(item.state).when_due;
    if (target === null) {
      for (const name of item.names) {
        try { await walk(door, 'forget_set_aside', name); } catch (error) { if (!gone(error)) throw error; }
      }
      await save(door, item.id, record, { ...record.value, status: 'forgotten' });
      removed.push({ id: item.id, label: item.label });
    } else {
      await save(door, item.id, record, { ...record.value, state: stateOf(target).id, entered_at_ms: when, by: 'schedule' });
      moved.push({ id: item.id, label: item.label, to: target });
    }
  }
  return { moved, removed };
}
