// tools/send-to-a-place: the rows keep their promises. Each is an http row a sharing place finds by its name and fills
// from the picked things alone; the webhook holds no credential and follows no redirect; the Notion and Slack rows take
// their token only from their own connection and place it only in the Authorization header; and no row carries a held
// value or names a person of its own.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const text = readFileSync(new URL('../tool-rows.json', import.meta.url), 'utf8');
const rows = new Map(JSON.parse(text).records.map(({ payload }) => [payload.id, payload]));
const row = id => { assert.ok(rows.has(id), `${id} is a row`); return rows.get(id); };

test('each place is a tool row a note finds by its name, and a tray finds because its input takes things', () => {
  for (const [id, match] of [['tool:send-to-a-webhook', 'webhook'], ['tool:add-to-notion', 'notion'], ['tool:post-to-slack', 'slack']]) {
    const tool = row(id);
    assert.equal(tool.invoke.kind, 'http');
    assert.ok(tool.label.toLowerCase().includes(match), `${tool.label} holds ${match}`);
    assert.ok(Object.hasOwn(tool.input_schema.properties, 'things'));
    assert.deepEqual(tool.input_schema.required, ['things'], 'a share can fill everything the tool requires');
    assert.equal(tool.input_schema.additionalProperties, false);
    assert.deepEqual(tool.verify[0], { kind: 'output-contains', output_selector: '$.said', text: 'answered' });
    assert.deepEqual(tool.output_schema.required, ['status', 'said']);
  }
  assert.deepEqual([...rows.keys()].sort(), ['tool:add-to-notion', 'tool:post-to-slack', 'tool:send-to-a-webhook']);
});

test('the webhook posts to the address given, holds no credential, and does not follow a redirect', () => {
  const tool = row('tool:send-to-a-webhook');
  assert.deepEqual(tool.invoke.url, { from: 'address' });
  assert.equal(tool.invoke.method, 'POST');
  assert.equal(tool.invoke.follow_redirects, false, 'what was posted stays at the address given');
  assert.equal(tool.invoke.report_answer, true);
  assert.equal(tool.invoke.credential_injections, undefined);
  assert.equal(tool.invoke.connection_id, undefined);
  assert.ok(tool.invoke.timeout_ms > 0 && tool.invoke.timeout_ms <= 10_000);
  assert.deepEqual(Object.keys(tool.invoke.body).sort(), ['link', 'things', 'title', 'words']);
  assert.deepEqual(tool.invoke.body.words, { from: 'note', optional: true });
});

test('the webhook carries a sample run its own input takes, and the answer it names is the address answering', () => {
  const tool = row('tool:send-to-a-webhook');
  const sample = tool.verify.find(check => check.kind === 'sample-run');
  const schema = tool.input_schema;
  for (const field of schema.required) assert.ok(Object.hasOwn(sample.input, field), `the sample gives ${field}`);
  for (const field of Object.keys(sample.input)) assert.ok(Object.hasOwn(schema.properties, field), `the tool takes ${field}`);
  for (const thing of sample.input.things) for (const field of schema.properties.things.items.required) assert.equal(typeof thing[field], 'string');
  assert.equal(new URL(sample.input.address).protocol, 'https:');
  assert.equal(sample.contains, `${new URL(sample.input.address).host} answered 200`);
});

test('Notion and Slack take their token only from their own connection, only in the Authorization header', () => {
  for (const [id, connection, field, host] of [
    ['tool:add-to-notion', 'service_connection:notion', 'integration_token', 'api.notion.com'],
    ['tool:post-to-slack', 'service_connection:slack', 'bot_token', 'slack.com'],
  ]) {
    const tool = row(id);
    assert.equal(tool.invoke.connection_id, connection, id);
    assert.equal(tool.invoke.connection, undefined, `${id} names its one connection by id only`);
    const address = new URL(tool.invoke.url);
    assert.equal(address.host, host, id);
    assert.equal(address.protocol, 'https:', id);
    assert.deepEqual(tool.invoke.credential_injections, [{ field_id: field, hosts: [address.host], placement: { kind: 'header', name: 'Authorization', prefix: 'Bearer ', suffix: '' } }], id);
  }
});

test('Notion makes a page in the named database, titled and holding the note and the link only when they are given', () => {
  const body = row('tool:add-to-notion').invoke.body;
  assert.deepEqual(body.parent, { database_id: { from: 'database' } });
  assert.deepEqual(body.properties.title.title[0].text.content, { from: 'title', otherwise: { from: 'things.0.label' } });
  assert.deepEqual(body.children.map(child => child.$when), ['note', 'things.0.address']);
  assert.equal(row('tool:add-to-notion').invoke.headers['Notion-Version'], '2022-06-28');
});

test('Slack posts in the named channel, and its own ok: false is a refusal', () => {
  const invoke = row('tool:post-to-slack').invoke;
  assert.equal(invoke.answer_ok_field, 'ok');
  assert.deepEqual(invoke.body.channel, { from: 'channel' });
  assert.deepEqual(invoke.body.text, { from: 'note', otherwise: { from: 'things.0.label' } });
  assert.deepEqual(invoke.body.attachments[0].$when, 'things.0.address');
});

test('no row carries a held value, a person or an account of its own', () => {
  assert.doesNotMatch(text, /xox[bp]-|secret_[A-Za-z0-9]|ntn_|Bearer [A-Za-z0-9]/);
  assert.doesNotMatch(text, /@[a-z0-9-]+\.(com|net|org|io|ai)\b/i);
});
