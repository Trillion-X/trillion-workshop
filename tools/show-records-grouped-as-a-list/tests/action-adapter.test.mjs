import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  buildRecordActionInput,
  buildRecordActionRequest,
  invokeRecordAction,
} from '../do-work/invoke-record-action.mjs';
import { readProcessSessionProof } from '../do-work/read-process-session-proof.mjs';
import { foldRecordProjection } from '../read-data/read-record-projection.mjs';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function firstAction(index = 0) {
  const descriptors = await readJson(join(packageRoot, 'data/record-projection-descriptors.json'));
  const fixtures = await readJson(join(packageRoot, 'fixtures/record-projection-fixtures.json'));
  const snapshot = foldRecordProjection({
    descriptor: descriptors.projection,
    records: fixtures.sparse.records,
    related: fixtures.sparse.related,
  });
  return { row: snapshot.rows[0], action: snapshot.rows[0].actions[index] };
}

test('builds generic owner-action input from descriptor copy rules', async () => {
  const { row, action } = await firstAction(0);
  const input = buildRecordActionInput(action, { row, answers: { note: 'hello' } });

  assert.equal(input.action_id, 'open-record');
  assert.equal(input.row_id, 'record.alpha');
  assert.equal(input.record_id, 'record.alpha');
  assert.equal(input.note, 'hello');
});

test('builds opaque workflow request without local execution', async () => {
  const { row, action } = await firstAction(1);
  const request = buildRecordActionRequest(action, { row });

  assert.equal(request.target, 'slot::workflow');
  assert.equal(request.payload.operation, 'execute_definition');
  assert.equal(request.payload.definition_id, 'workflow::group-list::request-action');
  assert.equal(request.payload.include_steps, false);
  assert.equal(request.payload.include_output, false);
  assert.equal(request.payload.input.record_id, 'record.alpha');
  console.log('[group-list] record action descriptor invoked');
});

test('routes future action ids without adding a function', async () => {
  const futureAction = {
    id: 'future.action',
    target: 'slot::workflow',
    operation: 'future.operation',
    input: { value: 1 },
    copy: [{ key: 'selected_id', from: 'row.recordId' }],
  };
  const request = buildRecordActionRequest(futureAction, { row: { recordId: 'record.future' } });

  assert.equal(request.payload.operation, 'future.operation');
  assert.equal(request.payload.action_id, 'future.action');
  assert.equal(request.payload.input.selected_id, 'record.future');
});

test('rejects disabled actions before target send', async () => {
  assert.throws(
    () => buildRecordActionRequest({ id: 'blocked', enabled: false, disabledReason: 'Blocked by descriptor.' }),
    /Blocked by descriptor/,
  );
});

test('invokes through caller supplied sender only', async () => {
  const { row, action } = await firstAction(0);
  const seen = [];
  const result = await invokeRecordAction(action, { row }, async (request) => {
    seen.push(request);
    return { ok: true };
  });

  assert.deepEqual(result, { ok: true });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].target, 'slot::workflow');
});

test('reads process session proof records without executing sessions', () => {
  const proof = readProcessSessionProof([
    {
      payload: {
        session_id: 'process_session:abc',
        status: 'done',
        proof: { command: 'node tests' },
      },
    },
    {
      payload: {
        status: 'ignored',
      },
    },
  ]);

  assert.equal(proof.length, 1);
  assert.equal(proof[0].sessionId, 'process_session:abc');
  assert.equal(proof[0].status, 'done');
  console.log('[group-list] process session proof read');
});
