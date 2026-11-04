import test from 'node:test';
import assert from 'node:assert/strict';
import { suggestConnections } from '../do-work/suggest-connections.mjs';

const tool = (provider, domain) => ({ id: `tool:${provider}`, invoke: { provider, connects: { domain } } });
test('the row suggests the linked services not yet connected, with the reason in words', () => {
  const out = suggestConnections({ text: 'see https://www.notion.so/x and calendar.google.com/r', tools: [tool('notion', 'notion.so'), tool('google-calendar', 'calendar.google.com')], connected: ['google-calendar'] });
  assert.deepEqual(out.suggestions, [{ provider: 'notion', host: 'notion.so', reason: 'Your work links to notion.so' }]);
  assert.throws(() => suggestConnections({ text: 'x' }), /Give tools/);
});
