// The workspace's road to spaces (src/work-spaces.mjs): it passes the screen's verbs to the person's own
// store unchanged, shows only invitations into a space, refuses writes from other pages, makes keys that reach only
// the space they were made in (what can be shared is test/space-shareable.test.mjs), and never lets the screen publish
// an agent, set its capacity, take or finish work as one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { handleWorkSpaces, isWorkSpacesPath } from '../src/work-spaces.mjs';

const origin = 'https://app.example';
function personAnswering(answers = {}, screen = { summaries: [], pursuits: [] }) {
  const asked = [];
  return {
    asked,
    workScreen: async () => screen,
    fetch: async request => {
      const url = new URL(request.url);
      asked.push({ method: request.method, path: `${url.pathname}${url.search}`, reach: request.headers.get('x-trillion-reach'), body: request.method === 'GET' ? null : await request.json() });
      return Response.json(answers[`${request.method} ${url.pathname}`] ?? { ok: true });
    },
  };
}
const call = (person, method, path, body, from = origin, roads = {}) => {
  const url = new URL(`${origin}${path}`);
  const request = new Request(url, { method, headers: { origin: from, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return handleWorkSpaces(request, { person, origin, url, makeKey: async () => assert.fail('no key'), importExport: async () => assert.fail('no import'), ...roads });
};

test('shared recording words pass through the member owner route, with its refusal and retry headers intact', async () => {
  const asked = [];
  const person = { fetch: async request => {
    asked.push(new URL(request.url).pathname);
    return Response.json({ error: 'The words are busy. Try again in a second.' }, { status: 429,
      headers: { 'cache-control': 'private, no-store', 'retry-after': '2' } });
  } };
  const response = await call(person, 'GET', '/work/api/spaces/membership_1/items/item%20recording/transcript');
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(response.headers.get('retry-after'), '2');
  assert.deepEqual(asked, ['/spaces/membership_1/items/item%20recording/transcript']);
  assert.equal((await call(person, 'POST', '/work/api/spaces/membership_1/items/item_1/transcript', { text: 'injected' })).status, 404);
  assert.equal(asked.length, 1, 'no transcript writer is introduced through this read');
});

test('associated references and visible preview batches reach the member owner, preserving current refusal headers', async () => {
  const asked = [];
  const person = { fetch: async request => {
    asked.push({ method: request.method, path: new URL(request.url).pathname + new URL(request.url).search, body: request.method === 'POST' ? await request.json() : null });
    return Response.json({ error: 'The source is busy.' }, { status: 429, headers: { 'cache-control': 'private, no-store', 'retry-after': '2' } });
  } };
  const refs = await call(person, 'GET', '/work/api/spaces/company/items/record/references?after=6&limit=6');
  assert.equal(refs.status, 429); assert.equal(refs.headers.get('retry-after'), '2');
  const previewsPath = '/work/api/spaces/company/previews?item_ids=%5B%22record%22%5D';
  const preview = await call(person, 'GET', previewsPath);
  assert.equal(preview.status, 429); assert.equal(preview.headers.get('cache-control'), 'private, no-store');
  assert.deepEqual(asked, [{ method: 'GET', path: '/spaces/company/items/record/references?after=6&limit=6', body: null }, { method: 'GET', path: '/spaces/company/previews?item_ids=%5B%22record%22%5D', body: null }]);
  assert.equal((await call(person, 'POST', '/work/api/spaces/company/previews', { item_ids: ['record'] }, 'https://elsewhere.test')).status, 403);
  assert.equal(asked.length, 2);
});

test('shared video critique reads and writes use the existing same-origin room routes', async () => {
  const person = personAnswering();
  await call(person, 'GET', '/work/api/spaces/membership_1/responses?record=item_video&all_parts=true&limit=40&before=cursor');
  const note = { items: [{ kind: 'message', body: { text: 'Tighten the opening' }, reply_to: 'item_video', anchor: { record: 'item_video', part: { kind: 'moment', start_ms: 12_345 } } }] };
  await call(person, 'POST', '/work/api/spaces/membership_1/items', note);
  assert.equal(person.asked[0].path, '/spaces/membership_1/responses?record=item_video&all_parts=true&limit=40&before=cursor');
  assert.deepEqual(person.asked[1].body, note);
  assert.equal(person.asked.every(ask => ask.reach === null), true);
  assert.equal((await call(person, 'POST', '/work/api/spaces/membership_1/items', note, 'https://elsewhere.test')).status, 403);
  assert.equal(person.asked.length, 2);
});

test('revision-checked shared record routes forward encoded addresses and methods through the Space owner', async () => {
  const person = personAnswering();
  const address = 'shared:media-edit:edit-1';
  await call(person, 'GET', `/work/api/spaces/membership_1/records/${encodeURIComponent(address)}`);
  await call(person, 'POST', `/work/api/spaces/membership_1/records/${encodeURIComponent(address)}`, { expected_revision: null, value: { title: 'Shared cut' } });
  await call(person, 'DELETE', `/work/api/spaces/membership_1/records/${encodeURIComponent(address)}`, { expected_revision: 1 });
  assert.deepEqual(person.asked.map(({ method, path }) => `${method} ${path}`), [
    `GET /spaces/membership_1/records/${encodeURIComponent(address)}`,
    `POST /spaces/membership_1/records/${encodeURIComponent(address)}`,
    `DELETE /spaces/membership_1/records/${encodeURIComponent(address)}`,
  ]);
  assert.deepEqual(person.asked[1].body, { expected_revision: null, value: { title: 'Shared cut' } });
  assert.deepEqual(person.asked[2].body, { expected_revision: 1 });
  assert.equal((await call(person, 'POST', `/work/api/spaces/membership_1/records/${encodeURIComponent(address)}`, { value: {} }, 'https://elsewhere.test')).status, 403);
  assert.equal(person.asked.length, 3);
});

test('PUT member-type edits reach the Space owner with the submitted body', async () => {
  const person = personAnswering();
  const types = { types: [{ id: 'editor', label: 'Editor', inherits: ['member'] }] };
  await call(person, 'PUT', '/work/api/spaces/membership_1/member-types', types);
  assert.deepEqual(person.asked.map(({ method, path, body }) => ({ method, path, body })), [
    { method: 'PUT', path: '/spaces/membership_1/member-types', body: types },
  ]);
  assert.equal((await call(person, 'PUT', '/work/api/spaces/membership_1/member-types', types, 'https://elsewhere.test')).status, 403);
  assert.equal(person.asked.length, 1, 'a cross-origin update never reaches the Space owner');
});

test('the persistent starting-type action reaches the same Space owner route', async () => {
  const person = personAnswering();
  const choice = { member_type: 'editor' };
  await call(person, 'POST', '/work/api/spaces/membership_1/members/joining-type', choice);
  assert.deepEqual(person.asked.map(({ method, path, body }) => ({ method, path, body })), [
    { method: 'POST', path: '/spaces/membership_1/members/joining-type', body: choice },
  ]);
  assert.equal((await call(person, 'POST', '/work/api/spaces/membership_1/members/joining-type', choice, 'https://elsewhere.test')).status, 403);
  assert.equal(person.asked.length, 1, 'a cross-origin write never reaches the Space owner');
});

test('the Spaces screens reach the person store on the same routes an AI uses, with no reach of their own', async () => {
  const person = personAnswering();
  assert.equal(isWorkSpacesPath('/work/api/spaces'), true);
  assert.equal(isWorkSpacesPath('/work/api/spacesuit'), false);
  await call(person, 'GET', '/work/api/spaces');
  await call(person, 'GET', '/work/api/spaces/membership_1');
  await call(person, 'GET', '/work/api/spaces/membership_1/items?before=x&limit=5');
  await call(person, 'POST', '/work/api/spaces/membership_1/items', { items: [{ kind: 'message', body: { text: 'hi' } }] });
  await call(person, 'POST', '/work/api/spaces/membership_1/share', { record_id: 'pursuit:one' });
  await call(person, 'POST', '/work/api/spaces/membership_1/withdraw', { item_id: 'item_1' });
  await call(person, 'POST', '/work/api/spaces/membership_1/name', { name: 'Ben' });
  await call(person, 'POST', '/work/api/spaces/membership_1/handoffs/read', {});
  await call(person, 'POST', '/work/api/spaces/membership_1/share', { file: '/notes/plan.pdf' });
  await call(person, 'GET', '/work/api/spaces/membership_1/items/item%202/file');
  await call(person, 'POST', '/work/api/spaces/membership_1/agents/find', { job: 'summarise the week' });
  await call(person, 'POST', '/work/api/spaces/membership_1/handoffs', { job: 'summarise the week', to_agent: 'agent_a', case_id: 'item_1', request_key: 'k1', from_agent: 'someone', parent_handoff_id: 'h0' });
  await call(person, 'POST', '/work/api/spaces/membership_1/leave', { membership_id: 'membership_other' });
  await call(person, 'POST', '/work/api/spaces/membership_1/items/item_1/react', { symbol: 'heart', on: true });
  assert.deepEqual(person.asked.map(({ method, path }) => `${method} ${path}`), [
    'GET /spaces', 'GET /spaces/membership_1', 'GET /spaces/membership_1/items?before=x&limit=5', 'POST /spaces/membership_1/items',
    'POST /spaces/membership_1/share', 'POST /spaces/membership_1/withdraw', 'POST /spaces/membership_1/name', 'POST /spaces/membership_1/handoffs/read',
    'POST /spaces/membership_1/share', 'GET /spaces/membership_1/items/item%202/file', 'POST /spaces/membership_1/agents/find', 'POST /spaces/membership_1/handoffs',
    'POST /network/leave', 'POST /spaces/membership_1/items/item_1/react',
  ]);
  assert.deepEqual(person.asked[13].body, { symbol: 'heart', on: true }, 'a reaction from the screen reaches the store as given');
  assert.ok(person.asked.every(item => item.reach === null), 'the store reads the account itself, never a reach from the browser');
  assert.deepEqual(person.asked[4].body, { record_id: 'pursuit:one' });
  assert.deepEqual(person.asked[8].body, { file: '/notes/plan.pdf' });
  assert.deepEqual(person.asked[10].body, { job: 'summarise the week' });
  assert.deepEqual(person.asked[11].body, { job: 'summarise the week', request_key: 'k1', to_agent: 'agent_a', case_id: 'item_1' }, 'a handoff carries only what the screen asks for');
  assert.deepEqual(person.asked[12].body, { membership_id: 'membership_1' }, 'leaving leaves the space the page is on, never one the body names');
});

test('agents are found and handed work on the screen, never published, given capacity, taken or finished', async () => {
  const person = personAnswering();
  for (const path of ['agents/publish', 'agents/capacity', 'agents/withdraw', 'handoffs/take', 'handoffs/finish', 'items/item_1', 'items/item_1/file', 'keys/extra']) {
    const answer = await call(person, 'POST', `/work/api/spaces/membership_1/${path}`, {});
    assert.equal(answer.status, 404, path);
  }
  assert.equal((await call(person, 'GET', '/work/api/spaces/membership_1/handoffs')).status, 404);
  assert.equal(person.asked.length, 0);
});

test('a key made on the screen reaches only this one space and nothing private, whatever the browser asks', async () => {
  const person = personAnswering();
  const asked = [];
  const makeKey = async reach => { asked.push(reach); return { key: 'nm_x', reach }; };
  const answer = await call(person, 'POST', '/work/api/spaces/membership_1/keys', { reach: { private: true, spaces: 'all' } }, origin, { makeKey });
  assert.deepEqual(await answer.json(), { key: 'nm_x', reach: { private: false, spaces: ['membership_1'] } });
  assert.deepEqual(asked, [{ private: false, spaces: ['membership_1'] }]);
  const refused = await call(person, 'POST', '/work/api/spaces/membership_1/keys', {}, origin, { makeKey: async () => { throw new Error('A key cannot reach further than the sign-in that makes it.'); } });
  assert.equal(refused.status, 400);
  assert.equal((await call(person, 'POST', '/work/api/spaces/membership_1/keys', {}, 'https://elsewhere.example', { makeKey })).status, 403);
  assert.equal(asked.length, 1);
});

test('a chat export is brought into this space the way bring_in_chat_export does, each chat kept by the store', async () => {
  const person = personAnswering({ 'POST /spaces/membership_1/import': { conversation_id: 'c1', added: 3 } });
  let given;
  const importExport = async (body, keep) => { given = body; return { brought_in: [await keep(`/spaces/${body.space_id}/import`, { conversation: { title: 'Hi' } })], next_offset: null }; };
  const answer = await call(person, 'POST', '/work/api/spaces/membership_1/import', { file: '/exports/conversations.json', offset: 30, limit: 10, space_id: 'membership_other' }, origin, { importExport });
  assert.deepEqual(given, { file: '/exports/conversations.json', offset: 30, limit: 10, space_id: 'membership_1' });
  assert.deepEqual(await answer.json(), { brought_in: [{ conversation_id: 'c1', added: 3 }], next_offset: null });
  assert.deepEqual(person.asked.map(({ method, path, reach }) => [method, path, reach]), [['POST', '/spaces/membership_1/import', null]]);
  const refusing = personAnswering();
  refusing.fetch = async () => Response.json({ error: 'You are not a member of that pursuit.' }, { status: 400 });
  const refused = await call(refusing, 'POST', '/work/api/spaces/membership_1/import', { file: '/x.json' }, origin, { importExport: async (body, keep) => keep('/spaces/membership_1/import', {}) });
  assert.equal(refused.status, 400);
  assert.deepEqual(await refused.json(), { error: 'You are not a member of that pursuit.' });
});

test('space invitations stay available without the paid Network screen and expose no contact details', async () => {
  // The account's own /spaces/invitations routes answer (src/person-spaces.mjs), never the paid /network ones.
  const person = personAnswering({ 'GET /spaces/invitations': { invitations: [{ request_id: 'q1', why: 'Join me', asked_at: '2026-09-27T10:00:00Z', space: { title: 'Snacks', label: 'project' } }] },
    'POST /spaces/invitations/answer': { status: 'accepted' } });
  const listed = await (await call(person, 'GET', '/work/api/spaces/invitations')).json();
  assert.deepEqual(listed, { invitations: [{ request_id: 'q1', why: 'Join me', asked_at: '2026-09-27T10:00:00Z', space: { title: 'Snacks', label: 'project' } }] });
  assert.ok(!JSON.stringify(listed).includes('r_ana') && !JSON.stringify(listed).includes('secret@'));
  assert.deepEqual(await (await call(person, 'POST', '/work/api/spaces/invitations/answer', { request_id: 'q1', accept: true })).json(), { status: 'accepted' });
  await call(person, 'POST', '/work/api/spaces/start', { title: 'Kitchen', members_are: 'customers', members: [{ email: 'ana@example.com' }] });
  assert.deepEqual(person.asked.map(({ method, path, body }) => [method, path, body]), [
    ['GET', '/spaces/invitations', null],
    ['POST', '/spaces/invitations/answer', { request_id: 'q1', accept: true }],
    ['POST', '/spaces', { title: 'Kitchen', members_are: 'customers', members: [{ email: 'ana@example.com' }] }]], 'the new space carries its customer eligibility before inviting anyone');
  assert.ok(person.asked.every(({ path }) => !path.startsWith('/network')), 'no paid Network route is asked');
});

test('a write from another page is refused before the store is asked', async () => {
  const person = personAnswering();
  const answer = await call(person, 'POST', '/work/api/spaces/membership_1/items', { items: [] }, 'https://elsewhere.example');
  assert.equal(answer.status, 403);
  assert.equal(person.asked.length, 0);
});

test('a space is marked seen, described, pictured and invited to, and an invite link is read and joined, on the store\'s own routes', async () => {
  const person = personAnswering();
  await call(person, 'POST', '/work/api/spaces/membership_1/seen', {});
  await call(person, 'POST', '/work/api/spaces/membership_1/about', { description: 'Our brand', picture: '/pictures/logo.png' });
  await call(person, 'GET', '/work/api/spaces/membership_1/picture');
  await call(person, 'POST', '/work/api/spaces/membership_1/invites', { days: 7 });
  await call(person, 'GET', '/work/api/spaces/membership_1/invites');
  await call(person, 'POST', '/work/api/spaces/membership_1/invites/revoke', { invite_id: 'invite_1' });
  await call(person, 'GET', '/work/api/spaces/join/code%201');
  await call(person, 'POST', '/work/api/spaces/join/code%201', { space_id: 'somewhere' });
  assert.deepEqual(person.asked.map(({ method, path }) => `${method} ${path}`), [
    'POST /spaces/membership_1/seen', 'POST /spaces/membership_1/about', 'GET /spaces/membership_1/picture', 'POST /spaces/membership_1/invites',
    'GET /spaces/membership_1/invites', 'POST /spaces/membership_1/invites/revoke', 'GET /spaces/join/code%201', 'POST /spaces/join/code%201',
  ]);
  assert.deepEqual(person.asked[1].body, { description: 'Our brand', picture: '/pictures/logo.png' });
  assert.deepEqual(person.asked[7].body, {}, 'joining carries nothing from the browser but the code');
});
