// test/handoff-done-when.test.mjs
// Work that carries a done_when_rule cannot finish while the rule's current read does not pass; the deterministic check
// runs before any judgement of done (F-0161). The rule is the same DATA as a Waiting on you row's (src/done-when.mjs).
import assert from 'node:assert/strict';
import test from 'node:test';
import { handleAgentsRequest, makeAgents } from '../../shared-code/src/agents.mjs';
import { makeDoneWhen } from '../src/done-when.mjs';
import { agentStoreForTests } from '../../shared-code/test/agent-store-for-tests.mjs';

// A files source that answers from this table, standing in for the owner's reader of the person's files.
function setup() {
  const present = new Set();
  const doneWhen = makeDoneWhen({
    readers: { files: async (_arg, names) => names.map(path => ({ path, found: present.has(path), modified_at_ms: null, byte_length: null })) },
    filterRows: ({ rows }) => ({ matches: rows.filter(row => row.path === 'report.pdf' && row.exists === true), incomplete: false }),
  });
  const agents = makeAgents({ store: agentStoreForTests() });
  agents.publish({ agent_id: 'maker', name: 'Maker', description: 'Takes work', takes_work: true });
  const call = (path, body) => handleAgentsRequest(agents, new Request(`https://x.test${path}`, { method: 'POST', body: JSON.stringify(body) }), { doneWhen })
    .then(async response => ({ status: response.status, body: await response.json() }));
  return { present, call, agents };
}

test('a done_when_rule the engine cannot check is refused when the work is handed off', async () => {
  const { call } = setup();
  const refused = await call('/handoffs', { request_key: 'a', job: 'make report', to_agent: 'maker', done_when_rule: { over: 'nowhere', match: 'any', tree: { kind: 'group', rules: [] } } }).catch(error => ({ status: 400, body: { error: error.message } }));
  assert.notEqual(refused.status, 200);
  assert.match(JSON.stringify(refused.body), /done_when_rule/);
});

test('finish is refused until the rule passes, then succeeds; work without a rule finishes as before', async () => {
  const { call, agents, present } = setup();
  const rule = { over: 'files', match: 'any', says: 'report.pdf exists', tree: { kind: 'group', combinator: 'and', negate: false, rules: [{ kind: 'rule', field: 'path', operator: 'is_text', params: { text: 'report.pdf' } }, { kind: 'rule', field: 'exists', operator: 'is_true', params: {} }] } };
  const handed = await call('/handoffs', { request_key: 'b', job: 'make report', to_agent: 'maker', done_when_rule: rule });
  assert.equal(handed.status, 200, JSON.stringify(handed.body));
  const id = handed.body.handoff.handoff_id;
  assert.deepEqual(handed.body.handoff.done_when_rule, rule);
  agents.take({ agent_id: 'maker', handoff_id: id });
  const early = await call('/handoffs/finish', { handoff_id: id, agent_id: 'maker', result: 'done', summary: 'done' }).catch(error => ({ status: 400, body: { error: error.message } }));
  assert.notEqual(early.status, 200);
  console.log('readback refused:', JSON.stringify(early.body).slice(0, 200));
  assert.equal(agents.read({ handoff_id: id }).handoff.state, 'taken');
  present.add('report.pdf');
  const late = await call('/handoffs/finish', { handoff_id: id, agent_id: 'maker', result: 'done', summary: 'done' });
  assert.equal(late.status, 200, JSON.stringify(late.body));
  assert.equal(agents.read({ handoff_id: id }).handoff.state, 'finished');
  console.log('readback finished:', agents.read({ handoff_id: id }).handoff.state);

  const plain = await call('/handoffs', { request_key: 'c', job: 'plain', to_agent: 'maker' });
  agents.take({ agent_id: 'maker', handoff_id: plain.body.handoff.handoff_id });
  const ok = await call('/handoffs/finish', { handoff_id: plain.body.handoff.handoff_id, agent_id: 'maker', result: 'done' });
  assert.equal(ok.status, 200);
});
