// Ported from old trillion test/events.test.mjs (tag old-trillion-before-worker-retire, b6ae0ebf81), deleted by
// Trillion-X/trillion #243. The event owner is tools/keep-and-wake-ai-sessions-on-this-computer src/events.mjs; its
// word match runs here as it was. Left out: the seventeen tests over the shipped Instagram, Facebook Page and Stripe
// source rows end to end (the shared Workshop rows from scripts/workshop-rows.mjs, src/workflows.mjs, src/connect.mjs,
// src/service-records.mjs and the old engine tools): those rows and modules are gone and no running code ships a
// delivered event source (searched the three repos for "tool-event-source", "events:instagram", sharedWorkshopPayloads,
// handleConnectStart and makeWorkflows: only held copies, comments and the starting-set catalogue's names). The event rules'
// own continuity over a made-up source is checked by test/events-continuity.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { matchWords } from '../../keep-and-wake-ai-sessions-on-this-computer/src/events.mjs';

test('words match in any case, with accents, emoji and punctuation, and only as whole words', () => {
  assert.equal(matchWords('POTTERY please 🎾!!', ['pottery']), 'pottery');
  assert.equal(matchWords('tenis', ['pottery']), null);
  assert.equal(matchWords('potteryball', ['pottery']), null);
  assert.equal(matchWords('potteryball', ['pottery'], false), 'pottery');
  assert.equal(matchWords('PREÇO?', ['preco']), 'preco');
  assert.equal(matchWords('O8', ['08']), '08');
  assert.equal(matchWords('Клод', ['клод']), 'клод');
});
