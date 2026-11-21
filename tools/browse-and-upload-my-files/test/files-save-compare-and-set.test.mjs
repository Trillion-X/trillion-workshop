// A text document save is a compare-and-set: write_file_start carries the version the editor read (expected_version),
// and a refused start keeps nothing, sends no piece and finishes nothing. Tested on putFile with a fake door.
import assert from 'node:assert/strict';
import test from 'node:test';
import { PIECE_BYTES, putFile } from '../../workspace-screens/web/src/workspace/files-door.mjs';

const bytesSource = text => {
  const bytes = new TextEncoder().encode(text);
  return { size: bytes.length, readAt: async (offset, length) => bytes.slice(offset, offset + length) };
};

function fakeDoor({ refuseStart = null } = {}) {
  const calls = [];
  const change = async (op, input) => {
    calls.push({ op, input });
    if (op === 'write_file_start' && refuseStart) throw new Error(refuseStart);
    if (op === 'write_file_finish') return { identity: 'id-new', name: input.name };
    return {};
  };
  return { change, calls, ops: () => calls.map(call => call.op) };
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
