// tools/reply-templates: the expander and its row. The cases are the old reply-template package's Rust tests (a
// provider record's template filled from the caller's request, a reply that is not a screen, top-level data entries
// as sources, the request's template winning, arbitrary output kept, a missing template and bad JSON refused) with
// made-up values, then the refusals this tool adds. Its one stored template, a styled button, was a screen and stays
// with the screens owner.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { expandReplyTemplate } from '../read-data/expand.mjs';

const folder = join(import.meta.dirname, '..');
const bind = (key, path, more = {}) => ({ $kind: 'binding', select: { from: 'dataSource', key, path }, ...more });

test('a provider record\'s template is filled from the caller\'s request', () => {
  const reply = expandReplyTemplate({
    provider_record: { template: { control: { kind: 'button', props: { disabled: bind('caller_request', 'locked') }, events: { click: 'use' }, children: bind('caller_request', 'words') } } },
    caller_request: { words: 'Send', locked: false },
  });
  assert.deepEqual(reply, { control: { kind: 'button', props: { disabled: false }, events: { click: 'use' }, children: 'Send' } });
});

test('a reply that is not a screen expands by the same rule', () => {
  const reply = expandReplyTemplate({ data: { clip: { uri: 'file:clip-1', seconds: 3 } }, template: { audio_reply: { source: bind('clip', 'uri') } } });
  assert.deepEqual(reply, { audio_reply: { source: 'file:clip-1' } });
});

test('each top-level entry of data is a source by its own name', () => {
  const reply = expandReplyTemplate({
    data: { person: { name: 'Ari' }, task: { title: 'Review' } },
    template: { material: { title: bind('person', 'name'), next: bind('task', 'title') } },
  });
  assert.deepEqual(reply, { material: { title: 'Ari', next: 'Review' } });
});

test('the request\'s template wins over the provider record\'s', () => {
  assert.deepEqual(expandReplyTemplate({ provider_record: { template: { chosen: 'record' } }, template: { chosen: 'request' } }), { chosen: 'request' });
});

test('arbitrary output is kept: lists, numbers, nulls, plain objects and whole-source bindings', () => {
  const reply = expandReplyTemplate({
    caller_request: { label: 'Apply', rows: [{ n: 1 }, { n: 2 }] },
    template: { text: bind('caller_request', 'label'), second: bind('caller_request', ['rows', 1, 'n']), dotted: bind('caller_request', 'rows.0.n'), whole: bind('caller_request'), list: [1, null, true, 'x'], media: { source: 'file:asset-1' } },
  });
  assert.equal(reply.text, 'Apply');
  assert.equal(reply.second, 2);
  assert.equal(reply.dotted, 1);
  assert.deepEqual(reply.whole, { label: 'Apply', rows: [{ n: 1 }, { n: 2 }] });
  assert.deepEqual(reply.list, [1, null, true, 'x']);
  assert.deepEqual(reply.media, { source: 'file:asset-1' });
});

test('a binding that finds nothing gives its default, else null, and the same when it is marked required', () => {
  const reply = expandReplyTemplate({ caller_request: { a: 1 }, template: { x: bind('caller_request', 'b', { default: 'none' }), y: bind('caller_request', 'a.deep'), z: bind('nobody', 'a'), w: { $kind: 'binding', default: 7 } } });
  assert.deepEqual(reply, { x: 'none', y: null, z: null, w: 7 });
  const required = (more) => ({ $kind: 'binding', select: { from: 'dataSource', key: 'caller_request', path: 'b', required: true }, ...more });
  assert.deepEqual(expandReplyTemplate({ caller_request: { a: 1 }, template: { with_default: required({ default: 'none' }), without: required() } }), { with_default: 'none', without: null });
});

test('an object key named itemTemplate passes through unexpanded, at any depth', () => {
  const item = { label: bind('item', 'name') };
  const reply = expandReplyTemplate({
    caller_request: { name: 'Ari' },
    template: { list: { items: [1, 2], itemTemplate: item, title: bind('caller_request', 'name') }, deep: [{ itemTemplate: item }] },
  });
  assert.deepEqual(reply, { list: { items: [1, 2], itemTemplate: item, title: 'Ari' }, deep: [{ itemTemplate: item }] });
});

test('a template that is present but null is a template and gives null, while an absent one is refused', () => {
  assert.equal(expandReplyTemplate({ provider_record: { template: null } }), null);
  assert.equal(expandReplyTemplate({ template: null, provider_record: { template: null } }), null);
  assert.deepEqual(expandReplyTemplate({ template: null, provider_record: { template: { kept: 1 } } }), { kept: 1 });
  assert.throws(() => expandReplyTemplate({ template: null }), /give a template/);
  assert.throws(() => expandReplyTemplate({ provider_record: { other: 1 } }), /give a template/);
});

test('a key may itself be a binding', () => {
  const reply = expandReplyTemplate({ caller_request: { which: 'person' }, data: { person: { name: 'Ari' } }, template: { name: { $kind: 'binding', select: { from: 'dataSource', key: bind('caller_request', 'which'), path: 'name' } } } });
  assert.deepEqual(reply, { name: 'Ari' });
});

test('a missing template, a source or a transform this tool does not do, and a bad request are refused by name', () => {
  assert.throws(() => expandReplyTemplate({}), /give a template/);
  assert.throws(() => expandReplyTemplate({ provider_record: null }), /give a template/);
  assert.throws(() => expandReplyTemplate('x'), /give a request object/);
  assert.throws(() => expandReplyTemplate({ template: { x: { $kind: 'binding', select: { from: 'ambient', key: 'k' } } } }), /select.from "ambient" is not supported/);
  assert.throws(() => expandReplyTemplate({ template: { x: { $kind: 'binding', select: { from: 'dataSource', key: 'data' }, transform: [{ op: 'upper' }] } } }), /transform is not supported/);
  assert.throws(() => expandReplyTemplate({ template: { x: { $kind: 'binding', select: { from: 'dataSource', key: 'data', path: 3 } } } }), /select.path must be/);
  assert.throws(() => expandReplyTemplate({ template: { x: { $kind: 'binding', select: { from: 'dataSource' } } } }), /select.key must name/);
});

const run = (input) => new Promise((resolve) => {
  const child = execFile('node', [join(folder, 'do-work', 'expand-a-reply-template.mjs')], { cwd: folder }, (error, stdout) => resolve({ code: error?.code ?? 0, out: JSON.parse(stdout.trim().split('\n').at(-1)) }));
  child.stdin.end(typeof input === 'string' ? input : JSON.stringify(input));
});

test('the row\'s sample runs as the container runs it and gives the text it promises', async () => {
  const [row] = JSON.parse(await readFile(join(folder, 'tool-rows.json'), 'utf8')).records.map((record) => record.payload);
  const [sample] = row.verify;
  const { code, out } = await run(sample.input);
  assert.equal(code, 0);
  assert.equal(out.result.reply.line, sample.contains);
});

test('bad JSON and a missing template print their reason and fail', async () => {
  const bad = await run('{');
  assert.equal(bad.code, 1);
  assert.match(bad.out.error, /not JSON/);
  const none = await run({});
  assert.equal(none.code, 1);
  assert.match(none.out.error, /give a template/);
});

test('the folder holds no path of anyone\'s', async () => {
  for (const file of ['read-data/expand.mjs', 'tool-rows.json', 'README.md']) assert.doesNotMatch(await readFile(join(folder, file), 'utf8'), /\/Users\//, file);
});
