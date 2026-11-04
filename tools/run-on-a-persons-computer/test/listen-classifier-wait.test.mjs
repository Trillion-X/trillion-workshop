// A classifier that never answers (the account's question, or the model on this computer) is no answer after classify_wait_ms,
// so one stuck turn cannot hold the sender and everything queued behind it (6,323 turns waited, none sent, 2026-10-22).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { classifierOf } from '../listen.mjs';

const rows = JSON.parse(readFileSync(new URL(import.meta.resolve('../../bring-in-new-items-from-this-computer/computer/computer-sources.json')), 'utf8'));
const listening = rows.sources?.find?.(row => row.id === 'listening') ?? rows.find?.(row => row.id === 'listening') ?? Object.values(rows).flat?.().find?.(row => row?.id === 'listening');
const asked = { state: 'Said: {text}', question: 'Asks for something?', means: { true: 'yes', false: 'no' }, act_at: 0.5 };
const never = new Promise(() => {});

test('a model that never answers is null after the wait, and the next ask can still be answered', async () => {
  let hang = true;
  const classify = classifierOf(async () => ({ status: 200, body: { classify: asked } }),
    async () => (hang ? never : { answers: { verdict: { noul: 0.9 } } }), { wait_ms: 50 });
  const began = Date.now();
  assert.equal(await classify('remind me'), null);
  assert.ok(Date.now() - began < 1000, `waited ${Date.now() - began} ms`);
  hang = false;
  assert.equal(await classify('remind me'), 'act');
});

test('an account question that never answers is null after the wait', async () => {
  const classify = classifierOf(() => never, async () => ({ answers: { verdict: { noul: 0.9 } } }), { wait_ms: 50 });
  const began = Date.now();
  assert.equal(await classify('remind me'), null);
  assert.ok(Date.now() - began < 1000);
});

test('the listening row waits a bounded time for its classifier', () => {
  assert.ok(listening?.listen?.sending?.classify_wait_ms > 0);
});
