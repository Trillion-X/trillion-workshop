// Ported from trillion test/catalogue-screen-get-started.test.mjs (tag old-trillion-before-worker-retire).
//
// Get started is a catalogue screen (tool:get-started, moved from records/marketplace-screens.json) drawn from one read,
// tool:read-setup, whose answer is the whole description: the layout is the read itself. Old trillion's read asked the
// account's setup owner (GET /setup/facts?user_agent=&origin=); today's tool:read-setup asks the account files door's
// setup_facts with the same two browser facts, reads the account's own show rules and setup context, and draws with
// tool:see-what-is-left-to-set-up (tools/set-up-my-account/test/read-setup.test.mjs holds that test and the golden).
//
// Adapted: the old test's routing assertions (own-resource-compatibility sends /work/api/screens/get-started to the
// screen host) are the engine's generic screen host now; what stays here is the row the host reads, with its read's
// input drawn from the asking browser and the page's own account (the brief's contract B), and its layout drawn from
// what the read answered, through the same binding form the host draws (src/screen-layout.mjs: a `binding` selects a
// path of `self`, else its default).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const rowsOf = path => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8')).records.map(record => record.payload);
const screenRow = rowsOf('../tool-rows.json').find(row => row.id === 'tool:get-started');
const readRow = rowsOf('../../set-up-my-account/tool-rows.json').find(row => row.id === 'tool:read-setup');

// The binding form the screen host draws: { $kind: 'binding', select: { from: 'self', path }, default }.
const draw = (value, self) => (Array.isArray(value) ? value.map(item => draw(item, self))
  : value && typeof value === 'object' && value.$kind === 'binding' && value.select?.from === 'self'
    ? value.select.path.reduce((node, key) => node?.[key], self) ?? value.default
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, draw(item, self)])) : value);

test('Get started is a reads screen with one read, tool:read-setup, for the asking browser and the page\'s account', () => {
  assert.equal(screenRow.kind, 'ai-tool-descriptor');
  assert.equal(screenRow.label, 'Get started');
  assert.equal(screenRow.screen.kind, 'reads');
  assert.equal(screenRow.screen.shown_when, undefined, 'every account is shown it');
  assert.equal(screenRow.invoke, undefined, 'a screen row runs nothing itself');
  assert.deepEqual(screenRow.screen.reads.map(read => [read.id, read.tool]), [['setup', 'tool:read-setup']]);
  const context = { query: {}, browser: { user_agent: 'Mozilla/5.0 (iPhone)', origin: 'https://app.example', visitor: 'v' }, account_id: 'acct-a' };
  assert.deepEqual(draw(screenRow.screen.reads[0].input, context), { user_agent: 'Mozilla/5.0 (iPhone)', origin: 'https://app.example', account_id: 'acct-a' });
  assert.deepEqual(draw(screenRow.screen.reads[0].input, { query: {}, browser: {}, account_id: 'acct-a' }), { user_agent: '', origin: '', account_id: 'acct-a' },
    'a read with no browser facts asks with empty ones, as old readSetup did');
});

test('the layout is what the read answered, whole', () => {
  const answered = { title: 'Connect your AI to start', ready: false, requirements: [], sections: [{ id: 'setup-with-ai' }] };
  assert.deepEqual(draw(screenRow.screen.layout, { reads: { setup: answered } }), answered);
});

test('the read is a Workshop row that takes what the screen sends and runs the screen tool through its door', () => {
  assert.ok(readRow, 'tool:read-setup is in tools/set-up-my-account');
  assert.deepEqual(Object.keys(screenRow.screen.reads[0].input).sort(), ['account_id', 'origin', 'user_agent']);
  for (const name of Object.keys(screenRow.screen.reads[0].input)) assert.ok(readRow.input_schema.properties[name], name);
  assert.deepEqual(readRow.invoke.records.runs, ['tool:see-what-is-left-to-set-up']);
  assert.deepEqual(readRow.invoke.records.rights.map(right => right.files ? ['files', right.operations] : [right.id, right.operations]),
    [['files', ['setup_facts']], ['show-rules', ['workspace:read']], ['setup-context', ['workspace:read']]]);
});
