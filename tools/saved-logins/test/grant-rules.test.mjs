// Which kept messages can let an AI read saved logins, over message records only. The assertions are the older Workshop copy's
// (test/saved-logins-captured-road.test.mjs at commit b6ae0ebf81) for capturedByVerifiedRoad and grantRefusal. The store-backed
// checks in that file (record_messages through the real message store) are not ported here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { capturedByVerifiedRoad, grantRefusal } from '../src/grant-rules.mjs';

const SAID = 'Put my logins in the vault and then any AI use that for whatever work they have to do.';
const QUOTE = 'any AI use that for whatever work they have to do';

test('a message kept by a verified road counts; one stamped by an AI road or a chat import does not', () => {
  assert.equal(grantRefusal({ speaker: 'person', text: SAID, captured_road: 'carrier_door' }, QUOTE), null);
  assert.equal(grantRefusal({ speaker: 'person', text: SAID, captured_road: 'signed_in_screen' }, QUOTE), null);
  assert.equal(grantRefusal({ speaker: 'person', text: SAID, captured_road: 'record_messages' }, QUOTE), 'grant_not_captured');
  assert.equal(grantRefusal({ speaker: 'person', text: SAID, captured_road: 'chat_import' }, QUOTE), 'grant_not_captured');
});

test('a message kept before roads were stamped counts only when no AI app is recorded as having sent it', () => {
  assert.equal(capturedByVerifiedRoad({ speaker: 'person', text: SAID, recorded_at: '2026-09-29T16:25:56Z' }), true);
  assert.equal(capturedByVerifiedRoad({ speaker: 'person', text: SAID, recorded_by: 'key:abc' }), false);
  assert.equal(capturedByVerifiedRoad({ speaker: 'person', text: SAID, recorded_app: 'Claude' }), false);
  assert.equal(grantRefusal({ speaker: 'person', text: SAID }, QUOTE), null);
  assert.equal(grantRefusal({ speaker: 'person', text: SAID, recorded_by: 'key:abc' }, QUOTE), 'grant_not_captured');
});

test('the older refusals still come first: an AI speaker, a corrected source, short or missing words', () => {
  const road = { captured_road: 'carrier_door' };
  assert.equal(grantRefusal({ ...road, speaker: 'ai', text: SAID }, QUOTE), 'grant_not_person');
  assert.equal(grantRefusal({ ...road, speaker: 'person', text: SAID, source_provenance: { valid: false } }, QUOTE), 'grant_not_person');
  assert.equal(grantRefusal({ ...road, speaker: 'person', text: SAID }, 'any AI'), 'grant_quote_short');
  assert.equal(grantRefusal({ ...road, speaker: 'person', text: SAID }, 'any AI may read my bank'), 'grant_quote_missing');
});
