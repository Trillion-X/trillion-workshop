// tools/list-and-run-my-tools-for-any-ai/test/delete-tool.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deleteTool, DeleteToolError } from '../do-work/delete-tool.mjs';
import { saveTool } from '../do-work/save-tool.mjs';
import { publishTool } from '../do-work/publish-tool.mjs';
import { savedAndListedDatabase } from './saved-and-listed-database.mjs';

const descriptor = {
  kind: 'ai-tool-descriptor', id: 'tool:echo-test', job: 'Echo the input text back',
  input_schema: { type: 'object', properties: { text: { type: 'string' } } },
  invoke: { kind: 'container', run: ['python3', 'main.py'], workdir: '/work' },
  can_do: ['Echo the text back'], cannot_do: ['Send messages'],
  verify: [{ kind: 'sample-run', input: { text: 'hi' } }],
  licence_class: 'licence:maker-own', placements: ['placement:this-account'],
};
const files = { 'main.py': 'print(1)' };
const facts = { host_version: '2026.11.20' };
const saved = () => savedAndListedDatabase({ saved: [{ id: 'tool:echo-test', descriptor, fingerprint: '1f:aa', files: Buffer.from('x'), made_at: 'then' }] });

test('deletes a saved tool: the row keeps its id, becomes status deleted and gets deleted_at', async () => {
  const db = saved();
  assert.deepEqual(await deleteTool({ tool_id: 'tool:echo-test', maker: 'person:ana' }, db.client), { tool_id: 'tool:echo-test', deleted: true });
  const row = db.saved.find(item => item.id === 'tool:echo-test');
  assert.equal(row.status, 'deleted');
  assert.ok(row.deleted_at);
  assert.ok(db.log.includes('COMMIT'));
});

test('a deleted tool is not published: publish refuses it as not a saved tool', async () => {
  const db = saved();
  await deleteTool({ tool_id: 'tool:echo-test', maker: 'person:ana' }, db.client);
  await assert.rejects(publishTool({ tool_id: 'tool:echo-test', maker: 'person:ana' }, db.client), /is not one of the saved tools/);
});

test('saving the same id again revives a deleted tool, and it can be published again', async () => {
  const db = saved();
  await deleteTool({ tool_id: 'tool:echo-test', maker: 'person:ana' }, db.client);
  await saveTool({ descriptor, files }, db.client);
  const row = db.saved.find(item => item.id === 'tool:echo-test');
  assert.equal(row.status, null);
  assert.equal(row.deleted_at, null);
  const listed = await publishTool({ ...facts, tool_id: 'tool:echo-test', maker: 'person:ana' }, db.client);
  assert.equal(listed.listing.status, 'published');
});

test('a tool this maker still has published is refused until it is withdrawn', async () => {
  const db = savedAndListedDatabase({
    saved: [{ id: 'tool:echo-test', descriptor, fingerprint: '1f:aa', files: Buffer.from('x') }],
    listings: [{ tool_id: 'tool:echo-test', maker: 'person:ana', status: 'published' }],
  });
  await assert.rejects(deleteTool({ tool_id: 'tool:echo-test', maker: 'person:ana' }, db.client),
    error => error instanceof DeleteToolError && /Withdraw it with unpublish_tool first/.test(error.message));
  assert.equal(db.saved[0].status, null);
});

test('a withdrawn listing does not block the delete, and another maker\'s published listing does not either (as before)', async () => {
  const withdrawn = savedAndListedDatabase({
    saved: [{ id: 'tool:echo-test', descriptor, fingerprint: '1f:aa', files: Buffer.from('x') }],
    listings: [{ tool_id: 'tool:echo-test', maker: 'person:ana', status: 'withdrawn' }],
  });
  assert.equal((await deleteTool({ tool_id: 'tool:echo-test', maker: 'person:ana' }, withdrawn.client)).deleted, true);
  const others = savedAndListedDatabase({
    saved: [{ id: 'tool:echo-test', descriptor, fingerprint: '1f:aa', files: Buffer.from('x') }],
    listings: [{ tool_id: 'tool:echo-test', maker: 'person:bo', status: 'published' }],
  });
  assert.equal((await deleteTool({ tool_id: 'tool:echo-test', maker: 'person:ana' }, others.client)).deleted, true);
});

test('an unknown tool, a missing tool_id and a missing maker are each refused in plain words', async () => {
  const db = saved();
  await assert.rejects(deleteTool({ tool_id: 'tool:nothing', maker: 'person:ana' }, db.client), /is not one of this database's saved tools/);
  await assert.rejects(deleteTool({ maker: 'person:ana' }, db.client), /tool_id: the saved tool to delete/);
  await assert.rejects(deleteTool({ tool_id: 'tool:echo-test' }, db.client), /maker: the person deleting the tool/);
});

test('a second delete of the same tool is refused, since the deleted row is not live', async () => {
  const db = saved();
  await deleteTool({ tool_id: 'tool:echo-test', maker: 'person:ana' }, db.client);
  await assert.rejects(deleteTool({ tool_id: 'tool:echo-test', maker: 'person:ana' }, db.client), /is not one of this database's saved tools/);
});
