// tools/edit-a-shared-draft/test/edit-a-shared-draft.test.mjs
//
// The shared draft as a function of its input: the caller reads the draft (and approvals) from a store, runs the tool and applies
// the writes it returns, each only while the store still holds its `expect`. Covers a stale edit refused, a co-author's own section,
// every author approving one identity, an edit after approval withdrawing it, a frozen draft, an author who never approves, an
// author who withdraws, a non-author refused, and the identity being the same whatever order keys are written in. All records are
// made up; the three principals are sample names.
import test from 'node:test';
import assert from 'node:assert/strict';
import { editSharedDraft, identityOf } from '../do-work/edit-a-shared-draft.mjs';

const OWNER = 'sample-owner';
const B = 'sample-coauthor-b';
const C = 'sample-coauthor-c';

function draftOf(authors = [OWNER, B, C]) {
  return {
    owner: OWNER,
    authors,
    title: 'Sample title',
    body: 'Sample body',
    pictures: [{ id: 'pic-1', identity: '1f:' + '0'.repeat(64) }],
    sections: { [OWNER]: 'Owner part', [B]: 'B part', [C]: 'C part' },
    status: 'open',
    edits: [],
  };
}

// Apply the tool's writes to a Map store, compare-and-set on `expect`. Returns the answer, plus whether every write landed.
function apply(store, address, answer) {
  for (const write of answer.writes) {
    const held = store.get(write.address) ?? null;
    const heldIdentity = held ? identityOf(held) : null;
    if (write.kind === 'approval') {
      if ((held?.identity ?? null) !== write.expect) return { ...answer, landed: false };
      store.set(write.address, write.value);
      continue;
    }
    if (heldIdentity !== write.expect) return { ...answer, landed: false };
    store.set(write.address, write.value);
  }
  return { ...answer, landed: true };
}

function setup(authors) {
  const owner = new Map([['draft:d1', draftOf(authors)]]);
  return owner;
}

test('a co-author edits their own section; the identity moves and the edit is logged', () => {
  const store = setup();
  const read = store.get('draft:d1');
  const answer = apply(store, 'draft:d1', editSharedDraft({ op: 'edit', draft_id: 'd1', author: B, expect: identityOf(read), changes: { sections: { [B]: 'B new part' } }, stored: { draft: read }, now: '2026-11-21T12:00:00.000Z' }));
  assert.equal(answer.ok, true);
  assert.equal(answer.landed, true);
  const after = store.get('draft:d1');
  assert.equal(after.sections[B], 'B new part');
  assert.equal(after.sections[OWNER], 'Owner part');
  assert.equal(after.edits.length, 1);
  assert.equal(after.edits[0].by, B);
  assert.equal(answer.identity, identityOf(after));
});

test('a stale edit is refused with the current identity and writes nothing', () => {
  const store = setup();
  const old = store.get('draft:d1');
  const first = apply(store, 'draft:d1', editSharedDraft({ op: 'edit', draft_id: 'd1', author: OWNER, expect: identityOf(old), changes: { title: 'Owner title' }, stored: { draft: old } }));
  assert.equal(first.landed, true);
  const second = editSharedDraft({ op: 'edit', draft_id: 'd1', author: B, expect: identityOf(old), changes: { body: 'stale body' }, stored: { draft: store.get('draft:d1') } });
  assert.equal(second.ok, false);
  assert.equal(second.refused, 'stale');
  assert.deepEqual(second.writes, []);
  assert.equal(second.current, identityOf(store.get('draft:d1')));
});

test('a co-author cannot change another author\'s section or a non-author touch the draft', () => {
  const store = setup();
  const read = store.get('draft:d1');
  const other = editSharedDraft({ op: 'edit', draft_id: 'd1', author: B, expect: identityOf(read), changes: { sections: { [OWNER]: 'taken' } }, stored: { draft: read } });
  assert.equal(other.refused, 'not_your_section');
  const outsider = editSharedDraft({ op: 'edit', draft_id: 'd1', author: 'sample-outsider', expect: identityOf(read), changes: { title: 'x' }, stored: { draft: read } });
  assert.equal(outsider.refused, 'not_an_author');
});

test('three authors each approve the same identity in their own store, and the draft is ready', () => {
  const store = setup();
  const frozen = editSharedDraft({ op: 'freeze', draft_id: 'd1', owner: OWNER, expect: identityOf(store.get('draft:d1')), stored: { draft: store.get('draft:d1') } });
  apply(store, 'draft:d1', frozen);
  const shared = store.get('draft:d1');
  const approvals = new Map();
  for (const who of [OWNER, B, C]) {
    const their = new Map([['draft:d1', shared]]);
    const answer = apply(their, 'draft-approval:d1', editSharedDraft({ op: 'approve', draft_id: 'd1', author: who, expect: identityOf(shared), stored: { draft: shared, approval: null } }));
    assert.equal(answer.landed, true);
    approvals.set(who, their.get('draft-approval:d1'));
  }
  const check = editSharedDraft({ op: 'check', draft_id: 'd1', stored: { draft: shared, approvals: [...approvals.values()] } });
  assert.equal(check.ready, true);
  assert.deepEqual(check.missing, []);
});

test('an edit after approval withdraws that approval until every author approves the new identity', () => {
  const store = setup();
  const before = store.get('draft:d1');
  const approvals = [OWNER, B, C].map(who => ({ principal: who, identity: identityOf(before) }));
  apply(store, 'draft:d1', editSharedDraft({ op: 'freeze', draft_id: 'd1', owner: OWNER, expect: identityOf(before), stored: { draft: before } }));
  apply(store, 'draft:d1', editSharedDraft({ op: 'unfreeze', draft_id: 'd1', owner: OWNER, expect: identityOf(store.get('draft:d1')), stored: { draft: store.get('draft:d1') } }));
  const reread = store.get('draft:d1');
  apply(store, 'draft:d1', editSharedDraft({ op: 'edit', draft_id: 'd1', author: B, expect: identityOf(reread), changes: { title: 'Changed after approval' }, stored: { draft: reread } }));
  const changed = store.get('draft:d1');
  const check = editSharedDraft({ op: 'check', draft_id: 'd1', stored: { draft: changed, approvals } });
  assert.equal(check.ready, false);
  assert.deepEqual(check.withdrawn.sort(), [OWNER, B, C].sort());
  assert.deepEqual(check.approved, []);
});

test('a frozen draft refuses every edit', () => {
  const store = setup();
  const read = store.get('draft:d1');
  apply(store, 'draft:d1', editSharedDraft({ op: 'freeze', draft_id: 'd1', owner: OWNER, expect: identityOf(read), stored: { draft: read } }));
  const frozen = store.get('draft:d1');
  const refused = editSharedDraft({ op: 'edit', draft_id: 'd1', author: B, expect: identityOf(frozen), changes: { body: 'nope' }, stored: { draft: frozen } });
  assert.equal(refused.refused, 'frozen');
  assert.deepEqual(refused.writes, []);
});

test('an author who never approves keeps the draft not ready', () => {
  const draft = draftOf();
  const id = identityOf(draft);
  const check = editSharedDraft({ op: 'check', draft_id: 'd1', stored: { draft, approvals: [{ principal: OWNER, identity: id }, { principal: B, identity: id }] } });
  assert.equal(check.ready, false);
  assert.deepEqual(check.missing, [C]);
});

test('an author who withdraws (removed from authors) no longer blocks, and their old approval is ignored', () => {
  const draft = draftOf();
  const id = identityOf(draft);
  const without = { ...draft, authors: [OWNER, B] };
  const check = editSharedDraft({ op: 'check', draft_id: 'd1', stored: { draft: without, approvals: [{ principal: OWNER, identity: id }, { principal: B, identity: id }, { principal: C, identity: id }] } });
  assert.equal(check.ready, true);
  assert.deepEqual(check.approved.sort(), [OWNER, B].sort());
});

test('the identity is the same whatever order a draft\'s keys are written in', () => {
  const a = draftOf();
  const b = { ...draftOf(), sections: { [C]: 'C part', [B]: 'B part', [OWNER]: 'Owner part' } };
  assert.equal(identityOf(a), identityOf(b));
  assert.match(identityOf(a), /^1f:[0-9a-f]{64}$/);
});

test('only the owner can freeze', () => {
  const draft = draftOf();
  const refused = editSharedDraft({ op: 'freeze', draft_id: 'd1', owner: B, expect: identityOf(draft), stored: { draft } });
  assert.equal(refused.refused, 'not_owner');
});

// The row names this function and the files it packs; the sample run's answer is the row's own proof.
test('the row names this function and every file the container packs, and its sample run answers', async () => {
  const { default: rows } = await import('../what-this-tool-does-and-how-to-run-it.json', { with: { type: 'json' } });
  const { readFileSync, existsSync } = await import('node:fs');
  const row = rows.records.find(record => record.payload.id === 'tool:edit-a-shared-draft').payload;
  assert.equal(row.invoke.run.at(-1), 'editSharedDraft');
  assert.ok(row.invoke.run[2].endsWith('do-work/edit-a-shared-draft.mjs'));
  assert.equal(row.invoke.files.package_files[0].package, 'edit-a-shared-draft');
  for (const path of ['do-work/edit-a-shared-draft.mjs', 'read-data/edit-a-shared-draft.json']) {
    assert.ok(existsSync(new URL('../' + path, import.meta.url)), path);
  }
  const sample = row.verify[0];
  const answer = editSharedDraft(sample.input);
  assert.ok(answer.missing.includes('sample-owner'));
  assert.ok(readFileSync(new URL('../read-data/edit-a-shared-draft.json', import.meta.url), 'utf8').includes('no_change'));
});
