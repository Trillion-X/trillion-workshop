// A text document save is a compare-and-set: write_file_start carries the version the editor read (expected_version).
// A refused start sends nothing else; a refused finish preserves the concurrent bytes and cancels without retrying.
// Tested on putFile with a fake door.
import assert from 'node:assert/strict';
import test from 'node:test';
import { PIECE_BYTES, putFile } from '../../workspace-screens/web/src/workspace/files-door.mjs';

const bytesSource = text => {
  const bytes = new TextEncoder().encode(text);
  return { size: bytes.length, readAt: async (offset, length) => bytes.slice(offset, offset + length) };
};

function fakeDoor({ refuseStart = null, refuseFinish = null, refuseCancel = null, afterPiece = null, current = { identity: 'id-A', version: 3, text: 'opened' } } = {}) {
  const calls = [];
  const held = { ...current };
  const pieces = [];
  const change = async (op, input) => {
    calls.push({ op, input });
    if (op === 'write_file_start' && refuseStart) throw new Error(refuseStart);
    if (op === 'write_file_piece') {
      pieces.push(Buffer.from(input.content_base64, 'base64'));
      afterPiece?.(held);
    }
    if (op === 'write_file_finish') {
      if (refuseFinish) throw refuseFinish;
      Object.assign(held, { identity: 'id-new', version: held.version + 1, text: Buffer.concat(pieces).toString() });
      return { identity: held.identity, name: input.name };
    }
    if (op === 'write_file_cancel' && refuseCancel) throw refuseCancel;
    return {};
  };
  return { change, calls, held, ops: () => calls.map(call => call.op) };
}

test('a save at the version the editor read names that version in write_file_start and finishes', async () => {
  const door = fakeDoor();
  const kept = await putFile(door.change, { source: bytesSource('hello'), name: '/notes/a.txt', mediaType: 'text/plain', expectedVersion: 3 });
  assert.equal(kept.identity, 'id-new');
  assert.deepEqual(door.ops(), ['write_file_start', 'write_file_piece', 'write_file_finish']);
  assert.equal(door.calls[0].input.expected_version, 3);
  assert.equal(door.calls[1].input.offset, 0);
});

test('a name changed since it was opened (version no longer matches) keeps nothing and says so to the caller', async () => {
  const door = fakeDoor({ refuseStart: 'version changed' });
  await assert.rejects(putFile(door.change, { source: bytesSource('edit'), name: '/notes/a.txt', expectedVersion: 2 }), /version changed/);
  assert.deepEqual(door.ops(), ['write_file_start']);
});

test('a document larger than one piece is sent in order from offset 0 and never finished early', async () => {
  const door = fakeDoor();
  const text = 'x'.repeat(PIECE_BYTES + 10);
  await putFile(door.change, { source: bytesSource(text), name: '/notes/big.txt', expectedVersion: 0 });
  const offsets = door.calls.filter(call => call.op === 'write_file_piece').map(call => call.input.offset);
  assert.deepEqual(offsets, [0, PIECE_BYTES]);
  assert.equal(door.calls[0].input.expected_version, 0);
  assert.equal(door.ops().at(-1), 'write_file_finish');
});

test('a piece that fails cancels the upload and rethrows; nothing is finished', async () => {
  const calls = [];
  const change = async (op, input) => {
    calls.push(op);
    if (op === 'write_file_piece') throw new Error('piece refused');
    return {};
  };
  await assert.rejects(putFile(change, { source: bytesSource('abc'), name: '/notes/a.txt', expectedVersion: 1 }), /piece refused/);
  assert.deepEqual(calls, ['write_file_start', 'write_file_piece', 'write_file_cancel']);
});

for (const cancelFails of [false, true]) {
  test(`a refused finish preserves the concurrent bytes and refusal when cancellation fails=${cancelFails}`, async () => {
    const refusal = Object.assign(new Error('namespace_conflict'), { code: 'namespace_conflict', outcome: 'not_started' });
    const concurrent = { identity: 'id-B', version: 4, text: 'concurrent edit' };
    const draft = 'my draft';
    const source = bytesSource(draft);
    const door = fakeDoor({
      refuseFinish: refusal,
      refuseCancel: cancelFails ? new Error('cancel transport ended') : null,
      afterPiece: held => Object.assign(held, concurrent),
    });
    await assert.rejects(putFile(door.change, { source, name: '/notes/a.txt', expectedVersion: 3 }), error => error === refusal);
    assert.deepEqual(door.ops(), ['write_file_start', 'write_file_piece', 'write_file_finish', 'write_file_cancel']);
    assert.equal(door.calls[0].input.expected_version, 3);
    assert.deepEqual(door.held, concurrent);
    assert.equal(new TextDecoder().decode(await source.readAt(0, source.size)), draft);
    const upload = door.calls[0].input.upload_id;
    assert.ok(door.calls.every(call => call.input.upload_id === upload));
  });
}

test('a new-document finish conflict preserves the name created by another writer and never retries without its version', async () => {
  const refusal = Object.assign(new Error('namespace_conflict'), { code: 'namespace_conflict', outcome: 'not_started' });
  const concurrent = { identity: 'id-B', version: 1, text: 'someone else created this name' };
  const door = fakeDoor({
    current: { identity: null, version: 0, text: null },
    refuseFinish: refusal,
    afterPiece: held => Object.assign(held, concurrent),
  });
  await assert.rejects(putFile(door.change, { source: bytesSource('new draft'), name: '/notes/new.txt', expectedVersion: 0 }), error => error === refusal);
  assert.deepEqual(door.ops(), ['write_file_start', 'write_file_piece', 'write_file_finish', 'write_file_cancel']);
  assert.equal(door.calls[0].input.expected_version, 0);
  assert.deepEqual(door.held, concurrent);
});
