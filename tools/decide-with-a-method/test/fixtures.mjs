// A synthetic method and an in-memory records door for the decision tests. The method is made up for the tests; it
// holds no one's own method. The door keeps records as the records door does: read by type and id, list by type
// (newest created first for a declared order, else greatest id first) with `fields`, and write with null removing. Like
// the real door it bounds request keys to 512 UTF-8 bytes without control bytes, refuses messages over 64 KiB,
// and notes each write's bytes and its largest record,
// and `carried`: the bytes of that message when a door carries it with every character past ASCII as a \u escape and
// quotes it once more as a JSON string, the most any re-encoding on the way can make of it.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { itemsIn, joinLaid, recordKeyIn, rootFieldsIn } from '../read-data/decision-records.mjs';

const settings = JSON.parse(readFileSync(new URL('../read-data/decide-with-a-method.json', import.meta.url), 'utf8'));
export const DOOR_CAP = 64 * 1024;
const bytes = value => Buffer.byteLength(JSON.stringify(value));
const carried = value => JSON.stringify(JSON.stringify(value).replace(/[\u007f-\uffff]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)).length;

export const today = () => new Date().toISOString().slice(0, 10);

export const plainMethod = () => ({
  id: 'plain', kind: 'branch', name: 'Plain method', about: 'A made-up method for the tests', default_for: ['decision'],
  answer_rules: {
    field_min_words: 2, list_item_min_words: 2, evidence_min: 1,
    check: { handled: [{ name: 'how', label: 'How it was handled', kind: 'text', min_words: 1 }], skip: [{ name: 'because', label: 'Why it does not apply', kind: 'text', min_words: 1 }], distinct: true },
  },
  checks: [
    { id: 'worth_weighing', question: 'Is this worth weighing beyond a quick choice?', on_when_any_other_is_on: true, skip_requires: [{ name: 'why_quick', label: 'Why it is quick', kind: 'text', min_words: 2 }] },
    { id: 'compare_existing', question: 'Could something that already exists do this?', skip_requires: [{ name: 'searched', label: 'Where you looked', kind: 'list', min: 1, min_words: 2, ask: 'Where did you look for something that already does this?' }] },
  ],
  backbone: [{ id: 'name', name: 'Name the change', steps: ['outcome'] }, { id: 'test', name: 'Test it', steps: ['proof', 'existing'] }],
  steps: [
    { id: 'scope', kind: 'scope', question: 'What kind of decision is this?' },
    { id: 'outcome', question: 'Name the change: what is in which state now, and which state should it be in?', fields: [{ name: 'desired_result', label: 'Where you want it' }, { name: 'current_state', label: 'Where it is now' }], checks_skippable: false },
    { id: 'proof', question: 'How will you know it worked?', fields: [{ name: 'check_by', label: 'Check by', kind: 'date' }, { name: 'measure', label: 'What you will measure' }] },
    { id: 'existing', question: 'What already exists?', when: 'compare_existing', fields: [{ name: 'found', label: 'What you found', kind: 'list' }] },
  ],
  decision_fields: [{ name: 'who_it_changes', label: 'Who it changes beyond you', when: 'worth_weighing', ask: 'Who beyond the person does this change?', check: 'Who beyond the person does this move change, and what is different for them?', good_answer: 'Names people beyond the person and one concrete difference for them.', says: 'Who it changes beyond you: {value}.' }],
  voice: [{ id: 'plain-words', rule: 'Say it in plain words', good_answer: 'Short sentences a person reads once' }],
});

// Its checks, as rows of the one Checks list: each names the step it sharpens and is part_of its method.
export const plainChecks = () => [
  { id: 'outcome-before-after', part_of: 'plain', step: 'outcome', check: 'Have you named what is in which state now and which state it should end up in?', good_answer: 'One before-and-after pair with the facts that show the current state.' },
  { id: 'existing-where', part_of: 'plain', step: 'existing', when: 'compare_existing', check: 'Where did you look for something that already does this?', good_answer: 'Names the places searched.' },
];

export function memoryDoor() {
  const records = new Map();
  const writes = [];
  const lists = [];
  const roots = new Set();
  const identities = new Map();
  let writeMark = 9007199254740992n;
  const advance = id => identities.set(id, String(++writeMark));
  const raw = (type, key) => records.get(key)?.type === type ? records.get(key).value : null;
  const logicalPrefixes = [settings.records.step, settings.records.call,
    ...Object.values(settings.records.laid_apart).map(row => `${row.type}:`)];
  const physical = key => {
    // Fixture seeding installs a root before its parts. Physical records and unrelated keys must not try
    // joining that not-yet-installed map; logical decision-key edits still follow the published snapshot.
    if (key.includes(':content:') || key.startsWith(`${settings.records.part.type}:`)) return key;
    for (const id of roots) {
      const root = records.get(id)?.value;
      if (!root || id === key || !logicalPrefixes.some(prefix => key.startsWith(`${prefix}${id}:`))) continue;
      const resolved = recordKeyIn(id, root, key, raw);
      if (resolved !== key) return resolved;
    }
    return key;
  };
  const view = (kept, fields) => (fields ? Object.fromEntries(fields.filter(name => name in kept.value).map(name => [name, kept.value[name]])) : kept.value);
  // `where` keeps the rows whose fields equal it as JSON, as the door does.
  const matches = (kept, where) => !where || Object.entries(where).every(([name, value]) => JSON.stringify(kept.value?.[name]) === JSON.stringify(value));
  return {
    records, writes, lists,
    put(id, type, value) { if (type === 'decision') roots.add(id); const key = physical(id) ?? id; records.set(key, { type, value: structuredClone(value) }); advance(key); },
    value(id) { return structuredClone(records.get(physical(id))?.value ?? null); },
    async read(type, id) { const kept = records.get(id); return kept && kept.type === type ? structuredClone(kept.value) : null; },
    async readRecord(type, id) {
      const identity = records.get(id)?.type === type ? identities.get(id) : undefined;
      const value = await this.read(type, id);
      return value === null ? null : { type, value, ...(identity !== undefined ? { identity } : {}) };
    },
    async *list({ type, order, prefix = '', fields, where }) {
      lists.push({ type, ...(where ? { where } : {}) });
      const rows = [...records.entries()].filter(([id, kept]) => kept.type === type && id.startsWith(prefix) && matches(kept, where));
      rows.sort(order ? ([, a], [, b]) => (a.value.created_at < b.value.created_at ? 1 : -1) : ([a], [b]) => (a < b ? 1 : -1));
      for (const [id, kept] of rows) yield { id, type, value: structuredClone(view(kept, fields)) };
    },
    async write(list, { key } = {}) {
      assert.ok(typeof key === 'string' && key.trim() && Buffer.byteLength(key) <= 512 && !/[\u0000-\u001f]/u.test(key), 'a request key fits the native 512-byte bound and contains no control bytes');
      assert.ok(list.length >= 1 && list.length <= 256, `a write carries 1 to 256 records, not ${list.length}`);
      const size = bytes({ records: list, key });
      assert.ok(size <= DOOR_CAP, `a write of ${size} bytes is over the door's 64 KiB cap (413)`);
      // A record carrying `expected` is written only if it still holds exactly that ({ type, value }, or null when absent), as the engine checks: otherwise the whole write is refused and nothing changes.
      const sorted = value => JSON.stringify(value, (name, item) => (item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : item));
      if (list.some(record => {
        if (!('expected' in record)) return false;
        if (record.expected && Object.hasOwn(record.expected, 'identity')) return records.get(record.id)?.type !== record.expected.type || identities.get(record.id) !== record.expected.identity;
        return sorted(record.expected) !== sorted(records.get(record.id) ?? null);
      })) throw Object.assign(new Error('changed'), { code: 'original_command_conflict' });
      writes.push({ key, ids: list.map(record => record.id), bytes: size, carried: carried({ records: list, key }), largest: Math.max(...list.map(bytes)) });
      for (const { id, type, value } of list) {
        assert.ok(typeof type === 'string' && type, `${id} carries its type`);
        if (value === null) { records.delete(id); if (type === 'decision') roots.delete(id); }
        else { records.set(id, { type, value: structuredClone(value) }); if (type === 'decision') roots.add(id); }
        advance(id);
      }
      return { changed: true, write_count: list.length };
    },
  };
}

// A decision as the tools see it, put together from its records the way read-data/decision-records.mjs lays them out:
// the root with its lists back inside it (`input.evidence`, `answered_steps`, `decision_history`, ...) and its method
// snapshot, so a test can say what a decision holds without naming every record.
export function caseView(door, id) {
  const kept = door.value(id);
  if (!kept?.counts) return kept;
  const get = (type, key) => door.records.get(key)?.type === type ? structuredClone(door.records.get(key).value) : null;
  const root = rootFieldsIn(id, kept, get);
  const read = (type, key) => {
    const physical = Object.hasOwn(root.record_keys ?? {}, key) ? root.record_keys[key] : key;
    return physical === null ? null : get(type, physical);
  };
  const { record } = joinLaid(id, kept, get, undefined, { method: true });
  return { ...record, answered_steps: itemsIn(read, id, 'answered_steps', root.counts.answered_steps ?? 0) };
}
