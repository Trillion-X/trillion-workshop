import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { loadRowEvaluator } from 'trillion-workshop/tools/formula-engine/rules/evaluate-over-rows.mjs';

const directory = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(resolve(directory, '../things-to-store-and-run.json'), 'utf8'));
const formulaEngine = fileURLToPath(import.meta.resolve('trillion-workshop/tools/formula-engine/built-stored-bytes/evaluate-over-rows/evaluate-over-rows_bg.wasm'));
const descriptor = manifest.things.find((thing) => thing.payload?.key?.id === 'recording-condition');
const binding = descriptor?.payload?.value?.defaultExpression?.derive?.request?.binding;

test('recording condition formula preserves rule priority and unknown inputs', () => {
  assert.ok(binding, 'recording condition DATA has a Formula Engine binding');
  const evaluator = loadRowEvaluator(new Uint8Array(readFileSync(formulaEngine)));
  const evaluate = (context) => evaluator.evaluate(binding, context);

  assert.equal(evaluate({ 'recording-error': 'microphone denied', 'recording-state': 'recording' }), 'failed');
  assert.equal(evaluate({ 'recording-error': '', 'recording-state': 'cancelled' }), 'cancelled');
  assert.equal(evaluate({ 'recording-state': 'paused' }), 'paused');
  assert.equal(evaluate({ 'recording-state': 'recording' }), 'active');
  assert.equal(evaluate({ 'recording-state': 'stopped', 'recording-duration-ms': 0 }), 'saved');
  assert.equal(evaluate({ 'recording-state': 'stopped', 'recording-duration-ms': 1200 }), 'saved');
  assert.equal(evaluate({ 'recording-state': 'stopped', 'recording-duration-ms': -1 }), null);
  assert.equal(evaluate({ 'recording-state': 'stopped' }), null);
  assert.equal(evaluate({ 'recording-state': 'unknown', 'recording-duration-ms': 1200 }), null);
  assert.equal(evaluate({}), null);
  assert.throws(() => evaluate({ 'recording-state': 'stopped', 'recording-duration-ms': 'invalid' }),
    'malformed duration is refused rather than presented as Saved');
});
