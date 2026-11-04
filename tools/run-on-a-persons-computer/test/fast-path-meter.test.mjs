// A fast path with a fallback counts how each ask was served and reports a storm with its reasons
// (computer/fast-path-meter.mjs, wired into computer/local-models.mjs firstAnswer).
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeFastPathMeter, meterSettings } from '../fast-path-meter.mjs';
import { firstAnswer, modelMeter, stormNote } from '../local-models.mjs';

test('a storm needs enough asks in the window, ends when the window passes, and names the commonest reasons', () => {
  const settings = meterSettings();
  let at = 1_000_000;
  const meter = makeFastPathMeter({ settings, now: () => at });
  for (let i = 0; i < settings.min_samples - 1; i += 1) meter.record('p', 'fallback', 'first is not running');
  assert.equal(meter.report('p').storm, false, 'too few asks to say');
  meter.record('p', 'served');
  const report = meter.report('p');
  assert.deepEqual([report.asks, report.fell_back, report.storm], [settings.min_samples, settings.min_samples - 1, true]);
  assert.deepEqual(report.reasons, [{ reason: 'first is not running', times: settings.min_samples - 1 }]);
  at += settings.window_seconds * 1000 + 1;
  assert.deepEqual([meter.report('p').asks, meter.report('p').storm], [0, false]);
});

test('firstAnswer counts served, fallback and unserved asks, and the answer carries the storm once most asks fall back', async () => {
  const settings = meterSettings();
  const rows = [{ id: 'big', url: 'http://one', model: 'm1' }, { id: 'small', url: 'http://two', model: 'm2' }];
  const bigDown = async row => { if (row.id === 'big') throw new Error('down'); return { text: 'ok' }; };
  const before = modelMeter.report('storm-test').asks;
  assert.equal(before, 0);
  for (let i = 0; i < settings.min_samples; i += 1) assert.equal((await firstAnswer(rows, bigDown, 0, [], 0, 'storm-test')).row.id, 'small');
  const report = modelMeter.report('storm-test');
  assert.deepEqual([report.served, report.fell_back, report.storm], [0, settings.min_samples, true]);
  assert.deepEqual(report.reasons, [{ reason: 'big is not running', times: settings.min_samples }]);
  assert.equal(stormNote('storm-test').fast_path.storm, true);
  assert.deepEqual(stormNote('quiet-path'), {});
  assert.equal(await firstAnswer(rows, async () => { throw new Error('down'); }, 0, [], 0, 'none-test'), null);
  assert.equal(modelMeter.report('none-test').unserved, 1);
});
