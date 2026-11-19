// The browser extension answering what the person's own computer relays to it (extension/src/browser-runs.mjs): each request is
// answered with the function its tool id names, with the answer or why not, and a page is read in a window of its own that it closes. The browser below is a stand-in.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readPage, runBrowserTool } from '../src/browser-runs.mjs';
import settings from '../browser-runs.json' with { type: 'json' };

test('a relayed request is answered by the function its tool id names, and one this browser does not run is answered with why', async () => {
  const runs = { readPage: async input => ({ url: input.url, title: 'Example', text: 'words', links: [] }) };
  assert.deepEqual(await runBrowserTool('tool:read-a-page-in-my-browser', { url: 'https://example.com/' }, { runs }),
    { result: { url: 'https://example.com/', title: 'Example', text: 'words', links: [] } });
  assert.deepEqual(await runBrowserTool('tool:something-else', {}, { runs }), { error: 'This browser does not run tool:something-else.' });
  assert.deepEqual(await runBrowserTool('tool:read-a-page-in-my-browser', {}, { runs: { readPage: async () => { throw new Error('no page'); } } }), { error: 'no page' });
  assert.deepEqual(Object.keys(settings.tools), ['tool:read-a-page-in-my-browser', 'tool:act-in-my-browser', 'tool:drive-my-browser']);
});

test('the account routes that were retired are not called from this browser', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../src/browser-runs.mjs', import.meta.url), 'utf8');
  for (const route of ['/agents/publish', '/handoffs/take', '/handoffs/finish', 'takeRuns']) assert.equal(source.includes(route), false, route);
});

test('a page is read in its own window, which is closed whether or not it could be read', async () => {
  const removed = [];
  const browser = answer => ({
    windows: { create: async options => { assert.equal(options.focused, false); return { id: 7, tabs: [{ id: 70 }] }; }, remove: async id => { removed.push(id); } },
    tabs: { get: async () => ({ status: 'complete' }), sendMessage: async (tabId, message) => { assert.equal(tabId, 70); assert.ok(message.read_page); return answer; } },
  });
  const read = { ...settings.read_page, settle_ms: 0 };
  const page = await readPage({ url: 'https://example.com/' }, { browser: browser({ url: 'https://example.com/', title: 'Example', text: 'words', links: [] }), read });
  assert.equal(page.text, 'words');
  await assert.rejects(readPage({ url: 'https://example.com/' }, { browser: browser(undefined), read }), /opened https:\/\/example.com\/ but could not read it: the page did not answer/);
  assert.deepEqual(removed, [7, 7]);
  await assert.rejects(readPage({ url: 'file:///etc/hosts' }, { browser: browser({}), read }), /Send the page's address/);
});
