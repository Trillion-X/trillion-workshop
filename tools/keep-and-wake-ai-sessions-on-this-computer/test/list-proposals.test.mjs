// An AI proposes, a person decides (src/list-proposals.mjs): a proposal is bounded by the rows it may change and the
// scopes its evidence comes from, is checked by the list's own rules when made, and is applied exactly once, all or
// nothing, through putRows when a person approves. A list that says review_changes: true refuses an AI's direct write;
// a list that does not stays open. Runs against the real record store, in strict model mode when RECORD_MODEL_STRICT=1.
import test from 'node:test';
import assert from 'node:assert/strict';
import { localStore } from '../src/local-store.mjs';
import { handleListsRequest, makeLists } from '../../keep-lists-of-rows/lists.mjs';

const ai = { by: 'key:k1', via: { app: 'Claude Code', road: 'key', basis: 'authenticated' } };
const person = { by: 'app:Trillion', via: { road: 'session', basis: 'authenticated' } };
const fresh = t => {
  const store = localStore(':memory:');
  t.after(() => store.close?.());
  const lists = makeLists({ eeaf: store.eeaf });
  lists.save({ id: 'people', label: 'People', fields: [{ id: 'name', label: 'Name', required: true }, { id: 'email', label: 'Email', kind: 'email', unique: true }, { id: 'title', label: 'Title' }] });
  lists.save({ id: 'notes', label: 'Notes', fields: [{ id: 'text', label: 'Text' }] });
  lists.putRows('people', { rows: [{ id: 'ana', values: { name: 'Ana', email: 'ana@x.io', title: 'Engineer' } }, { id: 'ben', values: { name: 'Ben', email: 'ben@x.io' } }] }, { actor: person });
  lists.putRows('notes', { rows: [{ id: 'n1', values: { text: 'Ana leads platform now' } }] }, { actor: person });
  return { store, lists };
};

test('a proposal changes nothing until a person approves, then applies once, as the approver', t => {
  const { store, lists } = fresh(t);
  const made = lists.proposeChanges('people', {
    rows: [{ id: 'ana', values: { title: 'Platform lead' } }, { id: 'cal', values: { name: 'Cal' } }], remove: ['ben'],
    editable: ['ana', 'ben', 'cal'], scopes: [{ list_id: 'notes' }], evidence: [{ list_id: 'notes', row_id: 'n1' }], note: 'From the meeting notes',
  }, { actor: ai });
  assert.equal(made.status, 'pending');
  assert.equal(made.review.decide_with, 'decide_list_proposal');
  assert.equal(lists.row('people', 'ana').values.title, 'Engineer', 'nothing changed yet');
  const pending = lists.proposals('people', {});
  assert.deepEqual(pending.proposals.map(p => [p.proposal_id, p.by, p.saw[0].values]), [[made.proposal_id, 'key:k1', { title: 'Engineer' }]]);
  assert.deepEqual([pending.proposals[0].evidence, pending.proposals[0].scopes, pending.proposals[0].via.road], [[{ list_id: 'notes', row_id: 'n1' }], [{ list_id: 'notes' }], 'key']);
  assert.equal(store.eeaf.read(`list-proposal:people:${made.proposal_id}`).status, 'pending');
});

test('approve is refused to an AI and applied for a person, exactly once', t => {
  const { store, lists } = fresh(t);
  const made = lists.proposeChanges('people', { rows: [{ id: 'ana', values: { title: 'Platform lead' } }, { id: 'cal', values: { name: 'Cal' } }], remove: ['ben'], editable: ['ana', 'ben', 'cal'] }, { actor: ai });
  assert.throws(() => lists.decideProposal('people', { proposal_id: made.proposal_id, decision: 'approve' }, { actor: ai }), error => error.detail?.code === 'person_decides');
  const applied = lists.decideProposal('people', { proposal_id: made.proposal_id, decision: 'approve' }, { actor: person });
  assert.deepEqual([applied.status, applied.kept, applied.removed], ['applied', ['ana', 'cal'], ['ben']]);
  assert.equal(lists.row('people', 'ana').values.title, 'Platform lead');
  assert.equal(lists.row('people', 'ben'), null);
  assert.equal(store.eeaf.read(`list-proposal:people:${made.proposal_id}`).status, 'applied');
  assert.throws(() => lists.decideProposal('people', { proposal_id: made.proposal_id, decision: 'approve' }, { actor: person }), error => error.detail?.code === 'proposal_decided');
  // Closed proposals can be removed; open ones cannot.
  assert.equal(lists.decideProposal('people', { proposal_id: made.proposal_id, decision: 'remove' }, { actor: person }).removed, true);
  assert.equal(store.eeaf.read(`list-proposal:people:${made.proposal_id}`), null);
});

test('a row changed since it was proposed makes the proposal conflicted, and nothing of it is applied', t => {
  const { lists } = fresh(t);
  const made = lists.proposeChanges('people', { rows: [{ id: 'ana', values: { title: 'Platform lead' } }, { id: 'ben', values: { title: 'Designer' } }], editable: ['ana', 'ben'] }, { actor: ai });
  lists.putRows('people', { rows: [{ id: 'ben', values: { title: 'Founder' } }] }, { actor: person });
  const answer = lists.decideProposal('people', { proposal_id: made.proposal_id, decision: 'approve' }, { actor: person });
  assert.equal(answer.status, 'conflicted');
  assert.deepEqual(answer.conflicts, [{ row_id: 'ben', found: true, fields: ['title'] }]);
  assert.equal(lists.row('people', 'ana').values.title, 'Engineer', 'all or nothing');
  // The proposer revises it against what the rows hold now, and it applies.
  const revised = lists.proposeChanges('people', { proposal_id: made.proposal_id, rows: [{ id: 'ana', values: { title: 'Platform lead' } }], editable: ['ana'] }, { actor: ai });
  assert.equal(revised.status, 'pending');
  assert.equal(lists.decideProposal('people', { proposal_id: made.proposal_id, decision: 'approve' }, { actor: person }).status, 'applied');
  assert.equal(lists.row('people', 'ben').values.title, 'Founder');
});

test('a retried approval after the rows were written marks it applied without writing again', t => {
  const { lists } = fresh(t);
  const made = lists.proposeChanges('people', { rows: [{ id: 'ana', values: { title: 'Platform lead' } }], editable: ['ana'] }, { actor: ai });
  lists.putRows('people', { rows: [{ id: 'ana', values: { title: 'Platform lead' } }] }, { actor: person });
  const answer = lists.decideProposal('people', { proposal_id: made.proposal_id, decision: 'approve' }, { actor: person });
  assert.equal(answer.status, 'applied');
});

test('a proposal is bounded by its editable rows, its scopes and the list\'s own rules', t => {
  const { lists } = fresh(t);
  const refused = (input, code) => assert.throws(() => lists.proposeChanges('people', input, { actor: ai }), error => error.detail?.code === code);
  refused({ rows: [{ id: 'ana', values: { title: 'X' } }], editable: ['ben'] }, 'bad_proposal');
  refused({ rows: [{ id: 'ana', values: { title: 'X' } }], editable: ['ana'], evidence: [{ list_id: 'notes', row_id: 'n1' }] }, 'bad_proposal');
  refused({ rows: [{ id: 'ana', values: { title: 'X' } }], editable: Array.from({ length: 21 }, (_, n) => `r${n}`) }, 'bad_proposal');
  refused({ rows: [{ id: 'cal', values: { email: 'ANA@x.io', name: 'Cal' } }], editable: ['cal'] }, 'not_unique');
  refused({ rows: [{ id: 'dee', values: { title: 'No name' } }], editable: ['dee'] }, 'missing_required');
  // Decline and withdraw close a proposal; only its proposer withdraws.
  const one = lists.proposeChanges('people', { rows: [{ id: 'ana', values: { title: 'X' } }], editable: ['ana'] }, { actor: ai });
  assert.throws(() => lists.decideProposal('people', { proposal_id: one.proposal_id, decision: 'withdraw' }, { actor: { by: 'key:other', via: ai.via } }), error => error.detail?.code === 'person_decides');
  assert.equal(lists.decideProposal('people', { proposal_id: one.proposal_id, decision: 'withdraw' }, { actor: ai }).status, 'withdrawn');
  const two = lists.proposeChanges('people', { rows: [{ id: 'ana', values: { title: 'Y' } }], editable: ['ana'] }, { actor: ai });
  assert.equal(lists.decideProposal('people', { proposal_id: two.proposal_id, decision: 'decline' }, { actor: person }).status, 'declined');
  assert.deepEqual(lists.proposals('people', { status: 'declined' }).proposals.map(p => p.proposal_id), [two.proposal_id]);
  assert.equal(lists.row('people', 'ana').values.title, 'Engineer');
});

test('review_changes is opt-in: off, an AI writes directly; on, its direct write is refused and points at proposing', async t => {
  const { lists } = fresh(t);
  lists.putRows('people', { rows: [{ id: 'ana', values: { title: 'Direct' } }] }, { actor: ai });
  assert.equal(lists.row('people', 'ana').values.title, 'Direct');
  lists.save({ id: 'people', review_changes: true });
  assert.throws(() => lists.putRows('people', { rows: [{ id: 'ana', values: { title: 'Again' } }] }, { actor: ai }), error => error.detail?.code === 'needs_review');
  lists.putRows('people', { rows: [{ id: 'ana', values: { title: 'By hand' } }] }, { actor: person });
  // Over HTTP, an app the list stamps as an AI is gated the same way, and a proposal over HTTP is kept for the person.
  const ask = async (path, body, app) => {
    const response = await handleListsRequest(lists, new Request(`https://person${path}`, body ? { method: 'POST', body: JSON.stringify(body), headers: { 'x-trillion-app': app } } : {}));
    return { status: response.status, body: await response.json() };
  };
  assert.equal((await ask('/lists/people/rows', { rows: [{ id: 'ana', values: { title: 'Z' } }] }, 'Claude')).body.refused.code, 'needs_review');
  const proposed = (await ask('/lists/people/proposals', { rows: [{ id: 'ana', values: { title: 'Z' } }], editable: ['ana'] }, 'Claude')).body;
  assert.equal(proposed.status, 'pending');
  assert.equal((await ask(`/lists/people/proposals/${proposed.proposal_id}`)).body.rows[0].values.title, 'Z');
  assert.equal((await ask(`/lists/people/proposals/${proposed.proposal_id}/decide`, { decision: 'approve' }, 'Claude')).body.refused.code, 'person_decides');
  assert.equal((await ask(`/lists/people/proposals/${proposed.proposal_id}/decide`, { decision: 'approve' }, 'You, in Trillion')).body.status, 'applied');
  assert.equal(lists.row('people', 'ana').values.title, 'Z');
});
