// A link in someone's work to a service they have not connected names that service. The first test of
// Trillion-X/trillion test/connection-links.test.mjs, unchanged; its second (the Connections screen ranking through
// src/connection-recommendations.mjs) stays with that screen in the old tree.
import test from 'node:test';
import assert from 'node:assert/strict';
import { hostsIn, providersForLinks } from '../src/connection-links.mjs';

const tool = (provider, domain) => ({ id: `tool:${provider}`, label: provider, invoke: { provider, connects: { domain, category: 'x', capabilities: [] } } });
const tools = [tool('google', 'google.com'), tool('google-calendar', 'calendar.google.com'), tool('notion', 'notion.so'), tool('apple-notes', 'apple.com'), tool('apple-music', 'apple.com')];

test('hosts are read from links with or without a scheme, and the longest declared domain wins', () => {
  assert.deepEqual(hostsIn('see https://www.notion.so/team/page?x=1 and calendar.google.com/r.'), ['notion.so', 'calendar.google.com']);
  assert.deepEqual([...providersForLinks('https://calendar.google.com/x', tools)], [['google-calendar', 'calendar.google.com']]);
  assert.deepEqual([...providersForLinks('https://docs.google.com/d', tools)], [['google', 'docs.google.com']]);
  assert.deepEqual([...providersForLinks('apple.com/notes', tools).keys()], ['apple-notes', 'apple-music'], 'services sharing the longest domain are all offered');
  assert.equal(providersForLinks('no links here, notion is nice', tools).size, 0);
  assert.equal(providersForLinks('notnotion.so/x', tools).size, 0, 'a name that merely ends the same is not under the domain');
});
