// The actual function-runner descriptor and fd contract over synthetic account records. No live account is opened.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { answerOf, rowOf } from '../test-helpers/run-a-row.mjs';

const rows = JSON.parse(readFileSync(new URL('../tools/describe-the-workshop/what-this-tool-does-and-how-to-run-it.json', import.meta.url)));
const actual = rowOf(rows, 'tool:manage-my-api-descriptions');
const source = { id: 'sample', kind: 'openapi', url: 'https://sample.example.com/spec.json' };

test('shared source validator has one active owner, its real DATA dependency and both consumer closures', async () => {
  const validator = new URL('../tools/ai-tool-catalog/read-data/live-source-problems.mjs', import.meta.url);
  const renamed = new URL('../tools/ai-tool-catalog/read-data/renamed-tools.json', import.meta.url);
  assert.ok(existsSync(validator), 'the shared validator MOVE has not landed');
  assert.ok(existsSync(renamed), 'the shared validator DATA MOVE has not landed');
  assert.equal(existsSync(new URL('../tools/describe-the-workshop/read-data/live-source-problems.mjs', import.meta.url)), false);
  assert.equal(existsSync(new URL('../tools/describe-the-workshop/read-data/renamed-tools.json', import.meta.url)), false);
  const manifest = JSON.parse(readFileSync(new URL('../tools/ai-tool-catalog/part.json', import.meta.url)));
  for (const name of ['read-data/live-source-problems.mjs', 'read-data/renamed-tools.json']) assert.ok(manifest.public.includes(name));
  for (const id of ['tool:describe-a-tool', 'tool:manage-my-api-descriptions']) {
    const packed = rowOf(rows, id).invoke.files.package_files.find(item => item.package === 'ai-tool-catalog');
    assert.ok(packed, `${id} has no declared shared validator package`);
    for (const name of ['read-data/live-source-problems.mjs', 'read-data/renamed-tools.json']) assert.ok(packed.paths.includes(name));
  }
  const original = readFileSync(new URL('../tools/describe-the-workshop/ports/source-baselines/live-source-problems.mjs.held', import.meta.url), 'utf8');
  const active = readFileSync(validator, 'utf8');
  assert.ok(active.includes(original.trim()), 'the original active validator function changed during the MOVE');
  assert.equal((active.match(/export function liveSourceProblems\(/g) ?? []).length, 1);
  const { liveSourceProblems } = await import(validator.href);
  assert.deepEqual(liveSourceProblems({ ...source, licence: 'MIT', licence_class: 'fixture' },
    { openapi: { source: { row: { placements: ['placement:your-mac'] } } } },
    [{ id: 'fixture', licences: ['MIT'], allowed_placements: ['placement:your-computer'] }]), []);
});

test('packed source-reader descriptors retain their canonical protocol owner and recordless inner scope', () => {
  for (const [id, file] of [
    ['tool:read-my-api-descriptions', 'live-source-tool-row.json'],
    ['tool:derive-current-api-description-rows', 'derive-source-tool-row.json'],
  ]) {
    const original = JSON.parse(readFileSync(new URL(`../tools/ai-tool-catalog/read-data/${file}`, import.meta.url)));
    const packed = rowOf(rows, id);
    assert.deepEqual(packed, original);
  }
  const inner = rowOf(rows, 'tool:derive-current-api-description-rows');
  assert.equal(inner.invoke.records, undefined);
  assert.equal(inner.record_model, undefined);
});

test('the shipped static row reads the native task snapshot, not a request field', async () => {
  const task = { source_data: { config: { kinds: {}, sources: [] }, reads: [] } };
  const result = await answerOf(actual, {}, { task });
  assert.equal(result.status, 0);
  assert.deepEqual(result.result, { every_account: [], yours: [], kinds: [] });
  const spoof = await answerOf(actual, { source_data: task.source_data }, { task });
  assert.equal(spoof.status, 1);
  assert.match(spoof.error, /Supply add, edit or remove/);
  assert.deepEqual(spoof.kept, []);
});

test('a synthetic bound consumer changes original-preserving records through its actual fd', async () => {
  const row = structuredClone(actual);
  row.invoke.files.package_files[0].paths.push('test/source-consumer.mjs');
  row.invoke.run = ['node', '/opt/records-door/do-work/run-an-export.mjs', '/opt/describe-the-workshop/test/source-consumer.mjs', 'boundSource'];
  row.invoke.stdin = { fill: { from: 'input' } };
  const result = await answerOf(row, { add: source, request_key: 'fd-consumer' });
  assert.equal(result.status, 0);
  assert.equal(result.result.yours[0].id, 'sample');
  assert.equal(result.kept.find(row => row.id === 'tool-source:sample').value.url, source.url);
  assert.equal(result.kept.filter(row => row.type === 'tool-source-change').length, 1);
});

test('the real export runner given a records fd without native source configuration changes nothing', async () => {
  const row = structuredClone(actual);
  row.invoke.run = ['node', '/opt/records-door/do-work/run-an-export.mjs', '/opt/describe-the-workshop/do-work/sources.mjs', 'accountToolSourcesFromDoor'];
  row.invoke.stdin = { fill: { from: 'input' } };
  const result = await answerOf(row, { add: source, request_key: 'unbound' });
  assert.equal(result.status, 1);
  assert.match(result.error, /current account tool-source owner is unavailable/);
  assert.deepEqual(result.kept, []);
});
