// The identity proof must admit the shape Instagram actually returned before subscription begins.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { recordsList, rowsFromList } from '../parts/ai-tool-catalog/do-work/derive-tool-rows-from-sources.mjs';
import { selectDeclaredValue } from '../parts/ui/read-data/declared-selector.ts';
import { schemaProblems } from '../src/workshop.mjs';

const read = path => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const sources = read('../records/workshop-tool-records.json').records.map(row => row.payload)
  .filter(row => ['source:service-connection-descriptors', 'source:how-to-ask-something-else-to-do-things'].includes(row.id));
assert.equal(sources.length, 2);
const derived = sources.map(source => rowsFromList(source, recordsList(source.list.records)
  .filter(entry => /^instagram(-|$)/.test(entry.record_name))));
assert.deepEqual(derived.flatMap(result => result.refused), []);
const tool = id => derived.flatMap(result => result.rows).find(row => row.id === id);
const source = read('../records/workshop-event-source-records.json').records
  .find(row => row.payload.id === 'events:instagram').payload;
const proof = tool(source.route_key_proof.tool_id);
// Preserve the distinct user_id and id fields observed in the provider response; values are invented.
const identity = { user_id: '17841400000000001', username: 'example_account', id: '28487000000000002' };

test('Instagram identity proof accepts the provider response with its optional id', () => {
  assert.deepEqual(schemaProblems(identity, proof.output_schema, 'output'), []);
  assert.deepEqual(schemaProblems({ user_id: identity.user_id, username: identity.username }, proof.output_schema, 'output'), []);
});

test('Instagram still requires user_id and rejects malformed or undeclared fields', () => {
  assert.deepEqual(schemaProblems({ id: identity.id }, proof.output_schema, 'output'), ['output.user_id is required']);
  assert.deepEqual(schemaProblems({ ...identity, id: 123 }, proof.output_schema, 'output'), ['output.id must be string']);
  assert.deepEqual(schemaProblems({ ...identity, unexpected: true }, proof.output_schema, 'output'),
    ['output.unexpected is not an input this tool takes']);
});

test('the source continues to route by the Instagram user_id from the same sealed GET proof', () => {
  const connect = tool('tool:connect-service-instagram');
  assert.equal(proof.id, 'tool:instagram-find-my-account');
  assert.equal(proof.invoke.method, 'GET');
  assert.equal(proof.invoke.url, 'https://graph.instagram.com/v23.0/me?fields=user_id,username');
  assert.equal(proof.invoke.connection_id, 'service_connection:instagram');
  assert.equal(proof.invoke.connection, connect.invoke.connects.connection);
  assert.equal(source.route_key_proof.output_selector, '$.user_id');
  assert.equal(selectDeclaredValue(identity, source.route_key_proof.output_selector), identity.user_id);
  assert.notEqual(identity.user_id, identity.id);
});

test('subscription still requires a successful provider acknowledgement', () => {
  const listen = tool(source.listen_tool_id);
  assert.equal(listen.id, 'tool:instagram-listen-for-comments-and-messages');
  assert.equal(listen.invoke.method, 'POST');
  assert.deepEqual(schemaProblems({ success: true }, listen.output_schema, 'output'), []);
  assert.deepEqual(schemaProblems({ success: false }, listen.output_schema, 'output'), ['output.success must be one of true']);
  assert.deepEqual(schemaProblems({}, listen.output_schema, 'output'), ['output.success is required']);
});
