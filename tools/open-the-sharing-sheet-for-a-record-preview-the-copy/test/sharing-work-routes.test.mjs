// The Sharing screen's routes through the page session (src/work-sharing.mjs): the one list of where shares go, sending
// a share again, what was shared before and the AIs that take work. The screen once read a route no one answered.
import test from 'node:test';
import assert from 'node:assert/strict';
import { handleWorkSharing, isWorkSharingPath } from '../src/work-sharing.mjs';

const origin = 'https://app.test';
function person() {
  const asked = [];
  return {
    asked,
    fetch: async request => {
      const url = new URL(request.url);
      asked.push({ method: request.method, path: `${url.pathname}${url.search}`, body: request.method === 'GET' ? null : await request.text() });
      if (url.pathname === '/agents/find') return Response.json({ agents: [{ agent_id: 'a1', name: 'Claude', takes_work: true, ready_now: true }, { agent_id: 'a2', name: 'Paused', takes_work: false }, { agent_id: 'a3', takes_work: true }] });
      return Response.json({ answered: url.pathname });
    },
  };
}
const call = (path, { method = 'GET', body, from = origin, sharesSent = async () => ({ shares: [] }) } = {}) => {
  const url = new URL(`${origin}${path}`);
  const store = person();
  const request = new Request(url, { method, headers: { origin: from, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { store, answer: handleWorkSharing(request, { person: store, origin, url, sharesSent }) };
};

test('the Sharing screen reaches the one list of where shares go, and sending again, through its session', async () => {
  for (const path of ['/work/api/share-destinations', '/work/api/share-destinations/deliver', '/work/api/shares', '/work/api/share-agents', '/work/api/shared-with-me', '/work/api/sharing/r1']) assert.equal(isWorkSharingPath(path), true, path);
  assert.equal(isWorkSharingPath('/work/api/share-destinationsx'), false);
  const read = call('/work/api/share-destinations');
  assert.deepEqual(await (await read.answer).json(), { answered: '/share-destinations' });
  const sent = call('/work/api/share-destinations/deliver', { method: 'POST', body: { to: ['private'] } });
  assert.equal((await sent.answer).status, 200);
  assert.deepEqual(sent.store.asked, [{ method: 'POST', path: '/share-destinations/deliver', body: '{"to":["private"]}' }]);
});

test('a write from another site is refused before it reaches the person', async () => {
  const refused = call('/work/api/share-destinations/deliver', { method: 'POST', body: {}, from: 'https://elsewhere.test' });
  assert.equal((await refused.answer).status, 403);
  assert.deepEqual(refused.store.asked, []);
});

test('shared before is read through the list reader with the page query, and the AI picker lists only AIs that take work', async () => {
  let searched = null;
  const listed = call('/work/api/shares?before=2026-09-01T00%3A00%3A00.000Z', { sharesSent: async search => { searched = search; return { shares: [{ share_id: 's1' }], next_before: null }; } });
  assert.deepEqual(await (await listed.answer).json(), { shares: [{ share_id: 's1' }], next_before: null });
  assert.equal(searched, '?before=2026-09-01T00%3A00%3A00.000Z');
  const agents = call('/work/api/share-agents');
  assert.deepEqual(await (await agents.answer).json(), { agents: [{ agent_id: 'a1', name: 'Claude', ready_now: true }, { agent_id: 'a3', name: 'a3', ready_now: false }] });
});
