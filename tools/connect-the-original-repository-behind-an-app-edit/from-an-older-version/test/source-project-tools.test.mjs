import test from 'node:test';
import assert from 'node:assert/strict';
import { sourceProjectTools } from '../src/source-project-tools.mjs';

test('the connection tool can refresh a chosen saved source at its current commit', () => {
  let call;
  const tool = sourceProjectTools((...args) => { call = args; return 'sent'; })
    .find(row => row.name === 'connect_source_project');
  assert.deepEqual(tool.inputSchema.required, ['owner', 'repo', 'branch']);
  assert.ok(tool.inputSchema.properties.project_id);
  assert.ok(tool.inputSchema.properties.expected_commit);
  assert.ok(tool.inputSchema.properties.current_commit);
  const input = { owner: 'Trillion-X', repo: 'trillion-site', branch: 'main',
    project_id: '1'.repeat(32), expected_commit: 'a'.repeat(40), current_commit: 'c'.repeat(40) };
  assert.equal(tool.run(input), 'sent');
  assert.deepEqual(call, ['/source-projects', input]);
});

test('the removal tool sends the expected saved revision with DELETE', () => {
  let call;
  const tool = sourceProjectTools((...args) => { call = args; return 'sent'; })
    .find(row => row.name === 'remove_source_project');
  assert.deepEqual(tool.inputSchema.required, ['project_id', 'expected_revision']);
  const input = { project_id: '1'.repeat(32), expected_revision: `1f:${'a'.repeat(64)}` };
  assert.equal(tool.run(input), 'sent');
  assert.deepEqual(call, [`/source-projects/${input.project_id}`, { expected_revision: input.expected_revision }, 'DELETE']);
});

test('site repository link and origin tools expose the existing management lifecycle', () => {
  const calls = [];
  const tools = new Map(sourceProjectTools((...args) => { calls.push(args); return 'sent'; }).map(tool => [tool.name, tool]));
  const installation_id = '1'.repeat(32), source_project_id = '2'.repeat(32);
  tools.get('read_site_source_connection').run({ installation_id });
  tools.get('link_site_source_connection').run({ installation_id, source_project_id, expected_source_project_id: null });
  tools.get('unlink_site_source_connection').run({ installation_id, expected_source_project_id: source_project_id });
  tools.get('read_site_source_origin').run({ installation_id });
  tools.get('disconnect_site_source_origin').run({ installation_id, expected_project_origin: { project_id: source_project_id } });
  assert.deepEqual(calls, [
    [`/source-projects/site-link?installation_id=${installation_id}`],
    [`/source-projects/site-link?installation_id=${installation_id}`, { source_project_id, expected_source_project_id: null }, 'PUT'],
    [`/source-projects/site-link?installation_id=${installation_id}`, { expected_source_project_id: source_project_id }, 'DELETE'],
    [`/public-app/installations/${installation_id}/project/source-origin`],
    [`/public-app/installations/${installation_id}/project/source-origin`, { expected_project_origin: { project_id: source_project_id } }, 'DELETE'],
  ]);
});
