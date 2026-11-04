import test from 'node:test';
import assert from 'node:assert/strict';
import { makeWorkshop, readToolData } from '../src/workshop.mjs';

const base = [
  { kind: 'tool-placement', id: 'placement:here', label: 'Here', executor: 'model-runtime', reachable_from: ['hosted'] },
  { kind: 'tool-licence-class', id: 'licence:open', label: 'Open', licences: ['MIT'], allowed_placements: ['placement:here'], store_bytes: true },
  { kind: 'ai-tool-descriptor', id: 'tool:judge', label: 'Judge', job: 'Check an answer', input_schema: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } }, output_schema: { type: 'object', required: ['answer'] }, invoke: { kind: 'model', model: 'local', input: { text: { fill: { from: 'input', field: 'text' } } } }, licence_class: 'licence:open', placements: ['placement:here'] },
];

test('an in-memory shared tool does not load saved, published or discovered catalogs', async () => {
  const unused = () => { throw new Error('an account or marketplace catalog was loaded'); };
  const workshop = makeWorkshop({
    host: 'hosted', data: async () => readToolData(base.map(payload => ({ payload }))),
    store: { readSavedTools: unused },
    market: { published: unused, prices: unused },
    sources: { kept: unused },
    executors: { 'model-runtime': async ({ invocation }) => ({ answer: invocation.input.text }) },
  });
  assert.deepEqual(await Promise.all(['one', 'two', 'three', 'four'].map(text => workshop.askInMemory({ tool_id: 'tool:judge', input: { text } }))),
    [{ answer: 'one' }, { answer: 'two' }, { answer: 'three' }, { answer: 'four' }]);
  await assert.rejects(workshop.askInMemory({ tool_id: 'tool:unlisted', input: {} }), /not a tool this service ships/);
});

test('an executor that answers at once (an account action) is asked like one that answers later', async () => {
  const unused = () => { throw new Error('an account or marketplace catalog was loaded'); };
  const workshop = makeWorkshop({
    host: 'hosted', data: async () => readToolData(base.map(payload => ({ payload }))),
    store: { readSavedTools: unused }, market: { published: unused, prices: unused }, sources: { kept: unused },
    executors: { 'model-runtime': ({ invocation }) => ({ answer: invocation.input.text }) },
  });
  assert.deepEqual(await workshop.askInMemory({ tool_id: 'tool:judge', input: { text: 'now' } }), { answer: 'now' });
  const refusing = makeWorkshop({
    host: 'hosted', data: async () => readToolData(base.map(payload => ({ payload }))),
    store: { readSavedTools: unused }, market: { published: unused, prices: unused }, sources: { kept: unused },
    executors: { 'model-runtime': () => { throw new Error('This account has no action named judge.'); } },
  });
  await assert.rejects(refusing.askInMemory({ tool_id: 'tool:judge', input: { text: 'now' } }), /no action named judge/);
});

test('a shared HTTP model uses its shipped host grant without loading account catalogs', async () => {
  const unused = () => { throw new Error('an account or marketplace catalog was loaded'); };
  const sent = [];
  const httpTool = {
    kind: 'ai-tool-descriptor', id: 'tool:remote-judge', label: 'Remote judge', job: 'Check an answer remotely',
    input_schema: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } },
    invoke: { kind: 'http', url: 'https://judge.example.com/check', method: 'POST', body: { text: '{text}' }, credential_injections: [{ secret_name: 'judge-key', placement: { kind: 'header', name: 'Authorization', prefix: 'Bearer ' } }] },
    licence_class: 'licence:open', placements: ['placement:here'],
  };
  const workshop = makeWorkshop({
    host: 'hosted', data: async () => readToolData([...base, httpTool].map(payload => ({ payload }))),
    store: { readSavedTools: unused }, market: { published: unused, prices: unused }, sources: { kept: unused },
    box: {
      check_exists: async name => name === 'judge-key',
      send: async request => { sent.push(request); return { status_code: 200, body: new TextEncoder().encode('{"answer":"ok"}') }; },
    },
  });
  assert.deepEqual(await workshop.askInMemory({ tool_id: 'tool:remote-judge', input: { text: 'specific answer' } }), { answer: 'ok' });
  assert.equal(sent[0].url, 'https://judge.example.com/check');
  assert.deepEqual(sent[0].credential_injections.map(item => item.secret_name), ['judge-key']);
});

test('a default publisher\'s published read is asked in memory; anyone else\'s published tool is not', async () => {
  const unused = () => { throw new Error('an account or marketplace catalog was loaded'); };
  const read = { kind: 'ai-tool-descriptor', id: 'tool:read-fact', label: 'Read a fact', job: 'Read a fact', read_only: true,
    input_schema: { type: 'object', properties: { thing: { type: 'string' } } }, output_schema: { type: 'object', required: ['fact'] },
    invoke: { kind: 'account-action', action: 'read-fact' }, licence_class: 'licence:open', placements: ['placement:here'] };
  const asked = [];
  const workshop = makeWorkshop({
    host: 'hosted', data: async () => readToolData(base.map(payload => ({ payload }))),
    store: { readSavedTools: unused }, sources: { kept: unused },
    market: { published: unused, prices: unused, publishedOne: async id => (id === 'tool:read-fact' ? { row: read, maker: 'maker:publisher' } : id === 'tool:other' ? { row: { ...read, id: 'tool:other' }, maker: 'maker:someone' } : null) },
    defaultPublisher: maker => maker === 'maker:publisher',
    executors: { 'model-runtime': ({ invocation, input }) => { asked.push(invocation.action); return { fact: input.thing }; } },
  });
  assert.deepEqual(await workshop.askInMemory({ tool_id: 'tool:read-fact', input: { thing: 'listen' } }), { fact: 'listen' });
  assert.deepEqual(asked, ['read-fact']);
  await assert.rejects(workshop.askInMemory({ tool_id: 'tool:other', input: {} }), /not a tool this service ships or a default publisher publishes/);
});
