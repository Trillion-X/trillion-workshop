// The sharing default (src/sharing-choice.mjs, src/pool-settings.json sharing_defaults): a person who never chose
// shares decisions made on or after the default's day, never one made before; an explicit choice always wins.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fromDayWords, sharingChoice, sharingView } from '../src/sharing-choice.mjs';
import settings from '../../keep-and-wake-ai-sessions-on-this-computer/src/pool-settings.json' with { type: 'json' };

const row = { on: true, from_day: '2026-09-28' };

test('a person who never chose shares decisions made from the default day, and none made before it', () => {
  assert.equal(sharingChoice(undefined, row, '2026-09-28T00:00:01Z'), true);
  assert.equal(sharingChoice(undefined, row, '2026-10-02T12:00:00Z'), true);
  assert.equal(sharingChoice(undefined, row, '2026-09-27T23:59:59Z'), false, 'a decision made under the earlier promise stays private');
  assert.equal(sharingChoice(undefined, row, undefined), true, 'the screen shows On');
  assert.equal(sharingChoice(undefined, row, null), false, 'a decision with no date is never shared by default');
});

test('an explicit choice wins over the default either way, for any decision', () => {
  assert.equal(sharingChoice(false, row, '2026-10-02T00:00:00Z'), false);
  assert.equal(sharingChoice(true, row, '2020-01-01T00:00:00Z'), true);
  assert.equal(sharingChoice(true, { on: false, from_day: '2026-09-28' }, '2020-01-01T00:00:00Z'), true);
});

test('a default that is off shares nothing the person did not choose', () => {
  assert.equal(sharingChoice(undefined, { on: false, from_day: '2026-09-28' }, '2026-10-02T00:00:00Z'), false);
  assert.equal(sharingChoice(undefined, undefined, '2026-10-02T00:00:00Z'), false);
});

test('the screen view says whether it is the person\'s own choice, and the live defaults are on', () => {
  assert.deepEqual(sharingView(undefined, row), { on: true, chosen: false, from_day: '2026-09-28' });
  assert.deepEqual(sharingView(false, row), { on: false, chosen: true, from_day: '2026-09-28' });
  assert.equal(settings.sharing_defaults.share.on, true);
  assert.equal(settings.sharing_defaults.stories.on, true);
  assert.equal(fromDayWords('2026-09-28'), 'September 28, 2026');
});
