// test/tool-listing.test.mjs
//
// The encoder catalogue: the paged list of the tools an account has that serve a job (src/job-slots.mjs makeToolListing),
// read by the meaning encoders one page per wake (src/meaning-sets.mjs). Each test drives the listing directly over the
// job-tool index, with no store around it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sqliteHost } from '../../keep-and-wake-ai-sessions-on-this-computer/src/local-store.mjs';
import { jobToolsIndex, makeToolListing } from '../src/job-slots.mjs';

function listing(t, descriptors) {
  const host = sqliteHost(':memory:'); t.after(() => host.db.close());
  const index = jobToolsIndex(host.sql);
  const tools = makeToolListing({ index: () => index, shipped: async () => ({ tools: [] }), descriptors: async ids => descriptors(ids) });
  return { index, tools };
}

// Walks the catalogue the way the meaning encoders do: one page per call, the cursor they keep, a restart when the
// catalogue changed under them. A pending page moves the cursor past what it could not read, so the walk goes on.
async function run(tools, job, pages) {
  const seen = new Map(); let after = null, revision = null, pending = 0, complete = false;
  for (let call = 0; call < pages && !complete; call += 1) {
    const page = await tools.page(job, { after, revision, limit: 32 });
    if (page.restart) { after = null; revision = page.cursor.revision; continue; }
    if (page.pending) pending += 1;
    for (const tool of page.tools) seen.set(tool.id, tool);
    revision = page.cursor.revision; after = page.cursor.after;
    complete = page.complete;
  }
  return { tools: [...seen.keys()].sort(), pending, complete };
}
async function walk(tools, job = 'encode') {
  const pass = await run(tools, job, 500);
  assert.ok(pass.complete, 'the catalogue walk completes within 500 pages');
  return pass;
}

test('a catalogue of more than fifty installed tools is walked to the end, one bounded page at a time', async t => {
  const reads = [];
  const { index, tools } = listing(t, async ids => { reads.push(ids.length); return ids.map(id => ({ id, serves: ['encode'] })); });
  const ids = Array.from({ length: 51 }, (_, n) => `tool:late-${String(n).padStart(3, '0')}`);
  index.installed('install:many', { context: 'private', components: ids.map(id => ({ kind: 'tool', id })) });
  assert.deepEqual((await walk(tools)).tools, ids);
  assert.ok(reads.every(count => count <= 32), 'each descriptor read stays within one page');
  const again = reads.length;
  assert.deepEqual((await walk(tools)).tools, ids);
  assert.ok(reads.slice(again).every(count => count <= 32), 'a repeat walk reads one page of descriptors at a time');
});

test('descriptors that cannot be read yet do not hold back the tools after them', async t => {
  let available = false;
  const { index, tools } = listing(t, async ids => ids.map(id => (id === 'tool:zz-later' || available ? { id, serves: ['encode'] } : null)));
  const unknown = Array.from({ length: 40 }, (_, n) => `tool:unknown-${String(n).padStart(3, '0')}`);
  index.installed('install:unknown', { context: 'private', components: unknown.map(id => ({ kind: 'tool', id })) });
  index.installed('install:zz-later', { context: 'private', components: [{ kind: 'tool', id: 'tool:zz-later' }] });
  const first = await run(tools, 'encode', 20);
  assert.ok(first.pending > 0, 'the unreadable descriptors were reported as pending');
  assert.ok(first.tools.includes('tool:zz-later'), 'the tool after the unreadable page is reached in the same pass');
  assert.equal(first.complete, false, 'a pass with an unreadable descriptor is not complete');
  assert.equal(index.unread(200).length, unknown.length, 'the unreadable descriptors stay unread and retryable');
  available = true;
  assert.deepEqual((await walk(tools)).tools, [...unknown, 'tool:zz-later'].sort(), 'once readable, every installed tool is listed');
});

test('a withdrawal while a descriptor is awaited restarts the page and reinserts nothing withdrawn', async t => {
  let arrived, release;
  const seen = new Promise(resolve => { arrived = resolve; }), waiting = new Promise(resolve => { release = resolve; });
  const { index, tools } = listing(t, async ids => { arrived(); await waiting; return ids.map(id => ({ id, serves: ['encode'] })); });
  index.installed('install:w', { context: 'private', components: [{ kind: 'tool', id: 'tool:withdrawn' }] });
  // The first page is the shipped catalogue and reads no descriptor; the awaited read is the next page.
  const first = await tools.page('encode', { limit: 32 });
  const old = tools.page('encode', { after: first.cursor.after, revision: first.cursor.revision, limit: 32 });
  await seen;
  index.installed('install:w', { context: 'private', removed_at: 'now', components: [] });
  release();
  const answer = await old;
  assert.equal(answer.restart, true, 'the awaited page answers that the catalogue changed, not with its stale tools');
  assert.deepEqual(answer.tools, []);
  assert.deepEqual((await walk(tools)).tools, [], 'the withdrawn tool is not listed');
});

test('a tool saved while a cold walk awaits its descriptor is listed by the next walk, and the cold walk does not answer with stale rows', async t => {
  let arrived, release, reads = 0;
  const seen = new Promise(resolve => { arrived = resolve; }), waiting = new Promise(resolve => { release = resolve; });
  const { index, tools } = listing(t, async ids => {
    reads += 1;
    if (reads === 1) { arrived(); await waiting; }
    return ids.map(id => ({ id, serves: ['encode'] }));
  });
  index.installed('install:cold', { context: 'private', components: [{ kind: 'tool', id: 'tool:cold-old' }] });
  const first = await tools.page('encode', { limit: 32 });
  const cold = tools.page('encode', { after: first.cursor.after, revision: first.cursor.revision, limit: 32 });
  await seen;
  index.saved({ id: 'tool:cold-new', serves: ['encode'] });
  release();
  const answer = await cold;
  assert.equal(answer.restart, true, 'the cold page knows its catalogue moved while it waited');
  assert.deepEqual(answer.tools, []);
  assert.deepEqual((await walk(tools)).tools, ['tool:cold-new', 'tool:cold-old'].sort());
});
