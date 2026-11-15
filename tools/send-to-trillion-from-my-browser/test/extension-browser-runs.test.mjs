// Send to Trillion as a place the person's Trillion runs work (extension/src/browser-runs.mjs, placement:your-browser):
// it takes only the runs handed to this browser, answers each with the function its tool id names, finishes every run
// with the answer or why not, and reads a page in a window of its own that it closes. The browser below is a stand-in.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readPage, takeRuns } from '../src/browser-runs.mjs';
import settings from '../browser-runs.json' with { type: 'json' };

function account(jobs) {
  const calls = [];
  const call = async (path, body) => {
    calls.push({ path, body });
    if (path === '/handoffs/take') { const job = jobs.shift(); return job ? { handoff: job, generation: 1 } : { handoff: null }; }
    return { ok: true };
  };
  return { calls, call };
}

test('each run handed to this browser is answered by its tool, and one it does not run is finished with why', async () => {
  const { calls, call } = account([
    { handoff_id: 'h_1', input: { tool_id: 'tool:read-a-page-in-my-browser', input: { url: 'https://example.com/' } } },
    { handoff_id: 'h_2', input: { tool_id: 'tool:something-else', input: {} } },
  ]);
  const taken = await takeRuns({ call, runs: { readPage: async input => ({ url: input.url, title: 'Example', text: 'words', links: [] }) }, now: Date.now() + 3_600_000 });
  assert.equal(taken, 2);
  assert.deepEqual(calls.filter(entry => entry.path === '/handoffs/take').map(entry => entry.body), [{ agent_id: 'this-browser', only_mine: true }, { agent_id: 'this-browser', only_mine: true }]);
  const finished = calls.filter(entry => entry.path === '/handoffs/finish').map(entry => entry.body);
  assert.deepEqual(finished[0].result, { url: 'https://example.com/', title: 'Example', text: 'words', links: [] });
  assert.equal(finished[0].generation, 1);
  assert.equal(finished[1].result.error, 'This browser does not run tool:something-else.');
  const card = calls.find(entry => entry.path === '/agents/publish').body;
  assert.equal(card.agent_id, settings.agent.agent_id);
  assert.deepEqual(card.skills.map(skill => skill.id), Object.keys(settings.tools));
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
