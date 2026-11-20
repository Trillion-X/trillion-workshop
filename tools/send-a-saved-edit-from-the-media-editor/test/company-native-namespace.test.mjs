import assert from 'node:assert/strict';
import test from 'node:test';
import { namespaceClient } from '../../browse-and-upload-my-files/do-work/namespace-client.mjs';
import { sharedByteAddress, sharedFileEntry, sharedNamespaceFolder, sharedNamespaceName, sharedNamespaceSelector, sharedReference, sharedSpaceName, sharedNamespaceFile } from '../../keep-and-wake-ai-sessions-on-this-computer/parts/live-namespace/do-work/shared-file-reference.mjs';
import { filmcraftEditJob } from '../../media-composition/do-work/filmcraft-edit-job.mjs';
import { editorHandoff } from '../src/editor-handoff.mjs';

const identity = `1f:${'a'.repeat(64)}`, other = `1f:${'b'.repeat(64)}`;
const reference = { space_id: 'membership_company', item_id: 'item_video' };
const shared = { ...reference, identity, name: '/Recordings/source.mp4', byte_length: 256 };
const own = { identity: other, name: '/Own/notes.txt', byte_length: 12 };
const signedRow = (changes = {}) => ({ identity, byte_length: 256, media_type: 'video/mp4',
  url: `https://files.test/namespace/bytes/${identity}?lease=held-in-memory`, url_expires_at: new Date(Date.now() + 60000).toISOString(), ...changes });
const companyFolder = sharedSpaceName('/Shared', { ...reference, title: 'Company' });
const mountedName = sharedNamespaceName('/Shared', reference, shared.name, 'video/mp4', 'Company');

test('shared selectors require an exact string pair and names preserve the grant without traversal', () => {
  for (const invalid of [{ space_id: 12, item_id: 'x' }, { space_id: 'x' }, { item_id: 'x' }, { space_id: 'x/y', item_id: 'z' }, { space_id: 'x', item_id: '..' }]) assert.throws(() => sharedReference(invalid), /exact space_id and item_id/);
  assert.equal(sharedReference({ identity }), null);
  assert.deepEqual(sharedReference(shared), reference);
  assert.equal(sharedNamespaceName('/Shared', reference, '../../source.mp4', 'video/mp4', 'Company'), mountedName);
  assert.match(sharedNamespaceName('/Shared', reference, undefined, 'video/mp4', 'Company'), /\/Company \([a-f0-9]{12}\)\/Shared file \([a-f0-9]{12}\)\.mp4$/);
  assert.equal(sharedNamespaceSelector('/Shared', '/Shared/membership_company/item_video/../other'), null);
  assert.deepEqual(sharedNamespaceSelector('/Shared', mountedName), { kind: 'file', name: mountedName, space_name: companyFolder });
  assert.throws(() => sharedNamespaceName('/Shared/unsafe', reference, 'x'), /root folder/);
});

test('shared leases must match source identity, service origin and current expiry, never redirects or embedded keys', () => {
  assert.equal(sharedByteAddress('https://files.test', signedRow()), signedRow().url);
  for (const changes of [{ url: 'https://other.test/namespace/bytes/x?lease=secret' }, { url: `https://files.test/namespace/bytes/${other}?lease=x` },
    { url: `https://user-3bf246f1@example.com/namespace/bytes/${identity}?lease=x` }, { url: `https://files.test/namespace/bytes/${identity}?lease=x#fragment` },
    { url: `https://files.test/namespace/bytes/${identity}` }, { url_expires_at: '2000-01-01T00:00:00Z' }]) assert.throws(() => sharedByteAddress('https://files.test', signedRow(changes)), /does not match/);
  const entry = sharedFileEntry('/Shared', reference, signedRow(), shared.name, 'Company');
  assert.equal(entry.name, mountedName);
  assert.doesNotMatch(JSON.stringify(entry), /lease|url|held-in-memory/);
});

test('readable names preserve extensions and never merge duplicate, case-folded or normalized source labels', async () => {
  const firstSpace = { space_id: 'membership_one', title: 'Ruth Patterson Popcorn Company' };
  const secondSpace = { space_id: 'membership_two', title: firstSpace.title.toUpperCase() };
  const firstRef = { space_id: firstSpace.space_id, item_id: 'item_one' };
  const secondRef = { space_id: firstSpace.space_id, item_id: 'item_two' };
  const first = sharedNamespaceName('/Shared', firstRef, '/Recordings/C9598.MP4', 'video/mp4', firstSpace.title);
  const second = sharedNamespaceName('/Shared', secondRef, '/Recordings/C9598.MP4', 'video/mp4', firstSpace.title);
  assert.match(first, /^\/Shared\/Ruth Patterson Popcorn Company \([a-f0-9]{12}\)\/C9598 \([a-f0-9]{12}\)\.MP4$/);
  assert.notEqual(first.toLowerCase(), second.toLowerCase());
  assert.notEqual(sharedSpaceName('/Shared', firstSpace).toLowerCase(), sharedSpaceName('/Shared', secondSpace).toLowerCase());
  const long = sharedNamespaceName('/Shared', firstRef, `${'🍿'.repeat(500)}.MP4`, 'video/mp4', '🍿'.repeat(500));
  assert.ok(long.split('/').filter(Boolean).every(component => Buffer.byteLength(component) <= 255));
  assert.ok(long.endsWith('.MP4'));
  assert.equal(sharedNamespaceName('/Shared', firstRef, 'Café.MP4', 'video/mp4', firstSpace.title), sharedNamespaceName('/Shared', firstRef, 'Cafe\u0301.MP4', 'video/mp4', firstSpace.title));
  const read = async route => {
    assert.ok(route === '/spaces' || route.includes('/items?'), 'Name mapping must not call private Files, lease minting or bytes');
    return { status: 200, body: route === '/spaces' ? { spaces: [firstSpace, secondSpace] } : { space_id: firstSpace.space_id,
      items: [firstRef, secondRef].filter(ref => ref.item_id === new URL(route, 'https://files.test').searchParams.get('item_id'))
        .map(ref => ({ item_id: ref.item_id, kind: 'file', body: { identity, byte_length: 256, name: 'C9598.MP4', media_type: 'video/mp4' } })), next_before: null } };
  };
  const selected = await sharedNamespaceFile('/Shared', secondRef, read, { row: signedRow() });
  assert.equal(selected.name, second); assert.deepEqual(sharedReference(selected), secondRef);
  assert.doesNotMatch(JSON.stringify(selected), /url|lease|membership_one\/|item_two\//);
});

test('member catalogs retain order-independent identity, paginate and omit withdrawn or nonfile rows', async () => {
  const calls = [];
  const control = async route => {
    calls.push(route);
    if (route === '/spaces') return { status: 200, body: { spaces: [{ space_id: reference.space_id, title: 'Company' }, { space_id: 123 }] } };
    return { status: 200, body: { space_id: reference.space_id, items: route.includes('before=')
      ? [{ item_id: 'item_document', kind: 'file', body: { identity: other, byte_length: 12, media_type: 'application/pdf', name: '/Documents/notes.pdf' } }]
      : [{ item_id: reference.item_id, kind: 'file', title: 'Video', body: { identity, byte_length: 256, media_type: 'video/mp4', name: shared.name } }, { item_id: 'item_hidden', kind: 'file', hidden: true, body: { identity, byte_length: 256, name: 'hidden.mp4' } }, { item_id: 'item_gone', kind: 'file', withdrawn: {}, body: {} }, { item_id: 'item_task', kind: 'task', body: {} }], next_before: route.includes('before=') ? null : 'page-2' } };
  };
  const root = await sharedNamespaceFolder('/Shared', { kind: 'root' }, control);
  assert.equal(root.size, 1); assert.equal(root.values().next().value.display_name, 'Company');
  const entries = await sharedNamespaceFolder('/Shared', { kind: 'space', space_id: reference.space_id }, control);
  assert.deepEqual([...entries.values()].map(entry => entry.item_id), ['item_video', 'item_document']);
  assert.equal(calls.filter(route => route.includes('/items?')).length, 2);
  assert.equal(calls.filter(route => route.endsWith('/file')).length, 0, 'Catalog sizes must not mint read addresses for directory entries');
  await assert.rejects(sharedNamespaceFolder('/Shared', { kind: 'space', space_id: reference.space_id }, async route => ({ status: 200, body: route === '/spaces' ? { spaces: [{ space_id: reference.space_id, title: 'Company' }] } : { space_id: reference.space_id, items: [], next_before: 'repeat' } })), /repeated its page cursor/);
});

test('shared metadata goes to the existing exact member file owner with no private fallback', async () => {
  const calls = [];
  const client = namespaceClient({ origin: 'https://files.test', control: async route => { calls.push(route); return { status: 200, body: signedRow() }; } });
  assert.equal((await client.sharedFile(reference)).identity, identity);
  assert.deepEqual(calls, ['/spaces/membership_company/items/item_video/file']);
  await assert.rejects(client.sharedFile({ ...reference, item_id: null }), /exact space_id/);
  const denied = namespaceClient({ origin: 'https://files.test', control: async () => ({ status: 200, body: { error: 'Source withdrawn' } }) });
  await assert.rejects(denied.sharedFile(reference), error => error.status === 403);
});

test('one native pass shares catalog pages across clips but never caches source grants or the post-admission catalog', async () => {
  const calls = [], second = { ...reference, item_id: 'item_second' };
  const client = namespaceClient({ origin: 'https://files.test', control: async route => {
    calls.push(route);
    if (route.endsWith('/file')) return { status: 200, body: signedRow() };
    if (route === '/spaces') return { status: 200, body: { spaces: [{ space_id: reference.space_id, title: 'Company' }] } };
    assert.ok(route.startsWith('/spaces/membership_company/items?'));
    assert.equal(new URL(route, 'https://files.test').searchParams.get('limit'), '1');
    return { status: 200, body: { space_id: reference.space_id, items: [reference, second].filter(ref => ref.item_id === new URL(route, 'https://files.test').searchParams.get('item_id')).map(ref => ({ item_id: ref.item_id,
      kind: 'file', body: { identity, byte_length: 256, media_type: 'video/mp4', name: shared.name } })), next_before: null } };
  } });
  const catalog = new Map();
  for (const ref of [reference, second, reference]) assert.deepEqual(sharedReference(await client.sharedNamespaceFile(ref, { root: '/Shared', catalog })), ref);
  assert.equal(calls.filter(route => route.endsWith('/file')).length, 3, 'Every source grant is checked, even a repeated clip');
  assert.equal(calls.filter(route => route === '/spaces').length, 1);
  assert.equal(calls.filter(route => route.includes('/items?')).length, 2, 'Only distinct selected item metadata is read');
  await client.sharedNamespaceFile(reference, { root: '/Shared', catalog: new Map() });
  assert.equal(calls.filter(route => route === '/spaces').length, 2, 'The post-admission pass starts fresh');
  assert.equal(calls.filter(route => route.endsWith('/file')).length, 4);
  assert.equal(calls.filter(route => route.includes('/items?')).length, 3);
});

test('opening first, middle or last exact upload reads no full company page or unrelated size', async () => {
  const calls = [];
  for (const index of [0, 1250, 2499]) {
    const ref = { ...reference, item_id: `item_${index}` };
    const entry = await sharedNamespaceFile('/Shared', ref, async route => {
      calls.push(route);
      if (route === '/spaces') return { status: 200, body: { spaces: [{ space_id: ref.space_id, title: 'Company' }] } };
      if (route.endsWith('/file')) {
        assert.equal(route, `/spaces/${ref.space_id}/items/${ref.item_id}/file`, 'Only the selected missing size may be checked');
        return { status: 200, body: signedRow() };
      }
      const query = new URL(route, 'https://files.test').searchParams;
      assert.equal(query.get('item_id'), ref.item_id, 'Opening must not request an unfiltered upload catalog');
      assert.equal(query.get('limit'), '1'); assert.equal(query.has('before'), false);
      return { status: 200, body: { space_id: ref.space_id, items: [{ item_id: ref.item_id, kind: 'file', body: { identity, name: `clip-${index}.MP4` } }], next_before: null } };
    });
    assert.deepEqual(sharedReference(entry), ref);
    assert.match(entry.name, new RegExp(`clip-${index} \\([a-f0-9]{12}\\)\\.MP4$`));
  }
  assert.equal(calls.filter(route => route.includes('/items?')).length, 3);
  assert.equal(calls.filter(route => route.endsWith('/file')).length, 3);
});

test('exact member name lookup refuses wrong pages, hidden or withdrawn items and mismatched source facts', async () => {
  const item = { item_id: reference.item_id, kind: 'file', body: { identity, byte_length: 256, name: shared.name, media_type: 'video/mp4' } };
  const read = page => async route => ({ status: 200, body: route === '/spaces' ? { spaces: [{ space_id: reference.space_id, title: 'Company' }] } : page });
  for (const page of [
    { space_id: 'other_space', items: [item] },
    { space_id: reference.space_id, items: [{ ...item, item_id: 'other_item' }] },
    { space_id: reference.space_id, items: [item, item] },
    { space_id: reference.space_id, items: [item], next_before: 'unexpected-page' },
  ]) await assert.rejects(sharedNamespaceFile('/Shared', reference, read(page), { row: signedRow() }), /match this exact file/);
  for (const changes of [{ hidden: true }, { withdrawn: {} }, { kind: 'task' }, { body: null }]) {
    assert.equal(await sharedNamespaceFile('/Shared', reference, read({ space_id: reference.space_id, items: [{ ...item, ...changes }] }), { row: signedRow() }), null);
  }
  for (const changes of [{ identity: other }, { byte_length: 1 }]) {
    await assert.rejects(sharedNamespaceFile('/Shared', reference, read({ space_id: reference.space_id, items: [item] }), { row: signedRow(changes) }), /changed while its mounted name/);
  }
});

test('saved Filmcraft edits preserve each member grant, repeated cuts and private Files separation', async () => {
  const edl = { encode: { width: 1920, height: 1080 }, spine: { segments: [
    { kind: 'clip', source: identity, ...reference, in: 0, out: 2 },
    { kind: 'clip', source: identity, ...reference, item_id: 'item_second_grant', in: 2, out: 3 },
    { kind: 'clip', source: identity, ...reference, in: 3, out: 4 },
    { kind: 'clip', source: other, in: 0, out: 1 },
  ] } };
  const before = structuredClone(edl), prepared = filmcraftEditJob({ edl });
  assert.equal(prepared.job.files.inputs.length, 3, 'Equal bytes through separate grants remain separate imports');
  assert.deepEqual(edl, before); assert.equal(prepared.clips, 4);
  const requests = [], checked = [], facts = new Map([['media_edit:company-edit', { edl }]]);
  const handoff = editorHandoff({ readFact: key => facts.get(key), writeFact: (key, value) => facts.set(key, value),
    sharedFile: async ref => { checked.push(ref); return signedRow(); }, locate: async id => { assert.equal(id, other); return { ...own, names: [own.name] }; },
    runJob: async job => { requests.push(job); return { task_id: 'accepted' }; }, readJob: async () => ({ task_id: 'accepted', tool_id: 'tool:run-an-app-job', state: 'queued' }) });
  assert.equal((await handoff.send({ edit: 'company-edit' }, { requestKey: 'once' })).state, 'queued', 'Accepting the job is not a saved project');
  assert.deepEqual(checked.map(ref => ref.item_id), ['item_video', 'item_second_grant']);
  assert.equal(requests[0].input.files.inputs[0].byte_length, 256);
  assert.deepEqual(sharedReference(requests[0].input.files.inputs[0]), reference);
  assert.doesNotMatch(JSON.stringify(requests), /lease|held-in-memory|url_expires_at/);
});

test('shared saved edits stop before an app job when source permissions, identity or size no longer hold', async () => {
  const edl = { encode: { width: 1920, height: 1080 }, spine: { segments: [{ kind: 'clip', source: identity, ...reference, in: 0, out: 1 }] } };
  for (const read of [async () => { throw new Error('Source hidden or withdrawn'); }, async () => signedRow({ identity: other }), async () => signedRow({ byte_length: null }), async () => ({ error: 'No longer shared' })]) {
    const handoff = editorHandoff({ readFact: () => ({ edl }), sharedFile: read,
      locate: () => assert.fail('Shared clip reached private Files'), runJob: () => assert.fail('Refused source reached an app job') });
    await assert.rejects(handoff.send({ edit: 'company-edit' }, { requestKey: 'once' }), /hidden or withdrawn|missing or has changed/);
  }
});
