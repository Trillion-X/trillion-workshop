// test/sampled-report.test.mjs
//
// Problem reports are sampled on this computer and go only to a write-only sink (computer/sampled-report.mjs: F-0522).
import test from 'node:test';
import assert from 'node:assert/strict';
import { launchPoint, makeReporter, readSinks, reportSettings } from '../sampled-report.mjs';

const base = reportSettings();
const withSinks = (sinks, kinds = base.kinds) => ({ ...base, sinks, kinds });
const SINK = { id: 'crashes', url: 'https://ingest.example.test/report', ingest_id: 'ing_123', scope: 'ingest' };

test('a shipped sink may hold an address and an ingest identifier only: a reading scope, a token, a secret or an http address is refused when read', () => {
  assert.equal(readSinks(withSinks([SINK])).length, 1);
  assert.throws(() => readSinks(withSinks([{ ...SINK, scope: 'read' }])), /not scoped to ingest/);
  assert.throws(() => readSinks(withSinks([{ ...SINK, api_token: 'x' }])), /holds api_token/);
  assert.throws(() => readSinks(withSinks([{ ...SINK, password: 'x' }])), /holds password/);
  assert.throws(() => readSinks(withSinks([{ ...SINK, url: 'http://ingest.example.test/' }])), /not an https address/);
  assert.deepEqual(base.sinks, [], 'the shipped list is empty');
});

test('sampling is decided here and the same launch decides the same way; over many launches the share sent is the rate, and rates 0 and 1 are exact', async () => {
  const settings = withSinks([SINK], { crash: { rate: 0.5, sink: 'crashes' }, never: { rate: 0, sink: 'crashes' }, always: { rate: 1, sink: 'crashes' } });
  const sent = [];
  const at = launch => makeReporter({ settings, installId: 'install-1', launchId: launch, send: async (sink, body) => sent.push({ sink, body }) });
  assert.equal(launchPoint('install-1', 'a'), launchPoint('install-1', 'a'));
  let yes = 0;
  for (let launch = 0; launch < 4000; launch += 1) if (at(`launch-${launch}`).sampled('crash')) yes += 1;
  assert.ok(yes > 1800 && yes < 2200, `about half of launches send: ${yes}/4000`);
  for (let launch = 0; launch < 500; launch += 1) { assert.equal(at(`l${launch}`).sampled('never'), false); assert.equal(at(`l${launch}`).sampled('always'), true); }
  assert.deepEqual(await at('l1').report('never', 'x'), { sent: false, reason: 'not sampled' });
  assert.equal(sent.length, 0);
  assert.throws(() => at('l1').sampled('other'), /no report kind named other/);
});

test('a report that is sent is scrubbed of this person\'s paths and addresses, cut, and carries only the ingest identifier', async () => {
  const sent = [];
  const reporter = makeReporter({ settings: withSinks([SINK], { crash: { rate: 1, sink: 'crashes' } }), installId: 'i', launchId: 'l', send: async (sink, body) => sent.push({ sink, body }) });
  assert.deepEqual(await reporter.report('crash', 'crashed at /Users/example/dev/app/x.js for someone@example.com'), { sent: true });
  assert.equal(sent[0].body.body, 'crashed at /Users/[user]/dev/app/x.js for [email]');
  assert.equal(sent[0].body.ingest_id, 'ing_123');
  assert.equal(sent[0].sink.url, SINK.url);
  await reporter.report('crash', 'x'.repeat(50000));
  assert.equal(sent[1].body.body.length, base.max_chars);
  const missing = makeReporter({ settings: withSinks([], { crash: { rate: 1, sink: 'crashes' } }), installId: 'i', launchId: 'l' });
  await assert.rejects(missing.report('crash', 'x'), /No sink is set up for crash reports/);
});
