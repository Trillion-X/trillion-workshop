// The shown tab is one value for the page: a publish tells every reader once, and the same id again tells nobody.
import assert from 'node:assert/strict';
import test from 'node:test';
import { publishShownTab, readShownTab, subscribeShownTab } from './shown-tab.ts';

test('a reader hears each change of the shown tab, and the same tab again is not a change', () => {
  const heard: Array<string | null> = [];
  const stop = subscribeShownTab(() => heard.push(readShownTab()));
  publishShownTab('screen.calendar');
  publishShownTab('screen.calendar');
  publishShownTab('tool:notes');
  publishShownTab(null);
  stop();
  publishShownTab('screen.home');
  assert.deepEqual(heard, ['screen.calendar', 'tool:notes', null]);
  assert.equal(readShownTab(), 'screen.home');
});
