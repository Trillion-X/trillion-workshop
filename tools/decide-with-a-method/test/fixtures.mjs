// A synthetic method and an in-memory records door for the decision tests. The method is made up for the tests; it
// holds no one's own method. The door keeps records as the records door does: read by type and id, list by type
// (newest created first for a declared order, else greatest id first) with `fields`, and write with null removing.
import assert from 'node:assert/strict';

export const today = () => new Date().toISOString().slice(0, 10);

export const plainMethod = () => ({
  id: 'plain', name: 'Plain method', about: 'A made-up method for the tests', default_for: ['decision'],
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

// Its checks, as rows of the Method checks list: each names the step it sharpens and its method.
export const plainChecks = () => [
  { id: 'outcome-before-after', method: 'plain', step: 'outcome', check: 'Have you named what is in which state now and which state it should end up in?', good_answer: 'One before-and-after pair with the facts that show the current state.' },
  { id: 'existing-where', method: 'plain', step: 'existing', when: 'compare_existing', check: 'Where did you look for something that already does this?', good_answer: 'Names the places searched.' },
];

export function memoryDoor() {
  const records = new Map();
  const writes = [];
  const lists = [];
  const view = (kept, fields) => (fields ? Object.fromEntries(fields.filter(name => name in kept.value).map(name => [name, kept.value[name]])) : kept.value);
  // `where` keeps the rows whose fields equal it as JSON, as the door does.
  const matches = (kept, where) => !where || Object.entries(where).every(([name, value]) => JSON.stringify(kept.value?.[name]) === JSON.stringify(value));
  return {
    records, writes, lists,
    put(id, type, value) { records.set(id, { type, value: structuredClone(value) }); },
    value(id) { return structuredClone(records.get(id)?.value ?? null); },
    async read(type, id) { const kept = records.get(id); return kept && kept.type === type ? structuredClone(kept.value) : null; },
    async *list({ type, order, prefix = '', fields, where }) {
      lists.push({ type, ...(where ? { where } : {}) });
      const rows = [...records.entries()].filter(([id, kept]) => kept.type === type && id.startsWith(prefix) && matches(kept, where));
      rows.sort(order ? ([, a], [, b]) => (a.value.created_at < b.value.created_at ? 1 : -1) : ([a], [b]) => (a < b ? 1 : -1));
      for (const [id, kept] of rows) yield { id, type, value: structuredClone(view(kept, fields)) };
    },
    async write(list, { key } = {}) {
      assert.ok(list.length >= 1 && list.length <= 256, `a write carries 1 to 256 records, not ${list.length}`);
      writes.push({ key, ids: list.map(record => record.id) });
      for (const { id, type, value } of list) {
        assert.ok(typeof type === 'string' && type, `${id} carries its type`);
        if (value === null) records.delete(id); else records.set(id, { type, value: structuredClone(value) });
      }
      return { changed: true, write_count: list.length };
    },
  };
}
