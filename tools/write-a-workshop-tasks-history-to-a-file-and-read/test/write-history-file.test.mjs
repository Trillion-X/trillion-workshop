import test from 'node:test';
import assert from 'node:assert/strict';
import { writeHistoryFiles, readHistoryFiles } from '../do-work/write-history-file.mjs';

const encoder = new TextEncoder();
const legacyRow = (seq, value) => JSON.stringify({ seq, at: '2026-11-20T00:00:00Z', entity: 'task', value });

// Cuts each row's bytes into pieces of at most `size` bytes, marked first and last, as the piece generator does.
function piecesOf(rows, size) {
  const out = [];
  for (const row of rows) {
    const bytes = encoder.encode(row.text);
    const seq = row.seq;
    if (bytes.length === 0) { out.push({ seq, first: true, last: true, bytes }); continue; }
    for (let start = 0; start < bytes.length; start += size) {
      const end = Math.min(bytes.length, start + size);
      out.push({ seq, first: start === 0, last: end === bytes.length, bytes: bytes.subarray(start, end) });
    }
  }
  return out;
}
async function* asAsync(items) { for (const item of items) yield item; }

// Collects what the sink received: one Uint8Array per file, the bytes of its lines in order.
function fileSink() {
  const files = [];
  return {
    files,
    write: async (index, bytes) => {
      files[index] = [...(files[index] ?? []), ...bytes];
    },
  };
}
const asFiles = sink => sink.files.map(bytes => Uint8Array.from(bytes));

test('a row larger than the file ceiling is written in files under the ceiling and reads back whole, byte for byte', async () => {
  const big = legacyRow(2, 'é'.repeat(3000) + 'end');
  const small = legacyRow(1, 'short');
  const sink = fileSink();
  const result = await writeHistoryFiles({ pieces: asAsync(piecesOf([{ seq: 1, text: small }, { seq: 2, text: big }], 700)), sink, file_bytes: 1024 });
  assert.ok(result.files > 1);
  for (const bytes of asFiles(sink)) assert.ok(bytes.length <= 1024, `file of ${bytes.length} bytes`);
  assert.deepEqual(readHistoryFiles(asFiles(sink)), [small, big]);
});

test('a row that fits the ceiling is written as its own legacy line, unchanged', async () => {
  const row = legacyRow(7, 'fits');
  const sink = fileSink();
  const result = await writeHistoryFiles({ pieces: asAsync(piecesOf([{ seq: 7, text: row }], 4096)), sink, file_bytes: 4096 });
  assert.equal(result.files, 1);
  assert.equal(new TextDecoder().decode(Uint8Array.from(sink.files[0])), `${row}\n`);
  assert.deepEqual(readHistoryFiles(asFiles(sink)), [row]);
});

test('no pieces write no file and read back no rows', async () => {
  const sink = fileSink();
  assert.deepEqual(await writeHistoryFiles({ pieces: asAsync([]), sink, file_bytes: 512 }), { files: 0 });
  assert.deepEqual(readHistoryFiles([]), []);
});

test('a file ceiling that holds no byte of a row is refused, not written around', async () => {
  const row = legacyRow(3, 'x'.repeat(200));
  await assert.rejects(
    () => writeHistoryFiles({ pieces: asAsync(piecesOf([{ seq: 3, text: row }], 100)), sink: fileSink(), file_bytes: 40 }),
    /ceiling holds no byte|larger than the file ceiling|invalid file ceiling/,
  );
  await assert.rejects(() => writeHistoryFiles({ pieces: asAsync([]), sink: fileSink(), file_bytes: 0 }), /invalid file ceiling/);
});

test('pieces that continue no row, or start a row inside one, are refused', async () => {
  await assert.rejects(
    () => writeHistoryFiles({ pieces: asAsync([{ seq: 4, first: false, last: true, bytes: encoder.encode('a') }]), sink: fileSink(), file_bytes: 512 }),
    /continues no row/,
  );
  await assert.rejects(
    () => writeHistoryFiles({ pieces: asAsync([
      { seq: 4, first: true, last: false, bytes: encoder.encode('{"seq":4') },
      { seq: 5, first: true, last: true, bytes: encoder.encode(legacyRow(5, 'b')) },
    ]), sink: fileSink(), file_bytes: 512 }),
    /starts before the row before it ended/,
  );
});

test('pieces that end inside a row are refused by the writer, and a file that ends inside a row by the reader', async () => {
  const row = legacyRow(6, 'y'.repeat(300));
  const cut = encoder.encode(row).subarray(0, 100);
  await assert.rejects(
    () => writeHistoryFiles({ pieces: asAsync([{ seq: 6, first: true, last: false, bytes: cut }]), sink: fileSink(), file_bytes: 512 }),
    /ended inside a row/,
  );
  const sink = fileSink();
  await writeHistoryFiles({ pieces: asAsync(piecesOf([{ seq: 6, text: row }], 90)), sink, file_bytes: 256 });
  const files = asFiles(sink);
  const lastFile = files.at(-1);
  files[files.length - 1] = lastFile.subarray(0, lastFile.length - 5);
  assert.throws(() => readHistoryFiles(files), /missing|ends inside a row|not JSON|invalid byte|reordered/);
});

test('the reader refuses a row whose first piece is missing, and a whole row inside an unfinished row', () => {
  const part = (seq, offset, final, text) => encoder.encode(`${JSON.stringify({ workshop_history_part: { seq, offset, total: null, final, hex: Buffer.from(text).toString('hex') } })}\n`);
  assert.throws(() => readHistoryFiles([part(8, 3, true, 'tail')]), /missing its first piece/);
  const whole = encoder.encode(`${legacyRow(9, 'z')}\n`);
  assert.throws(() => readHistoryFiles([concat(part(9, 0, false, 'head'), whole)]), /interrupted an unfinished row/);
});

test('the reader refuses a repeated or reordered piece', () => {
  const part = (offset, final, text) => encoder.encode(`${JSON.stringify({ workshop_history_part: { seq: 10, offset, total: null, final, hex: Buffer.from(text).toString('hex') } })}\n`);
  assert.throws(() => readHistoryFiles([concat(part(0, false, 'ab'), part(0, true, 'cd'))]), /missing, repeated or reordered/);
  assert.throws(() => readHistoryFiles([concat(part(0, false, 'ab'), part(3, true, 'cd'))]), /missing, repeated or reordered/);
});

function concat(...chunks) {
  const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let at = 0;
  for (const chunk of chunks) { out.set(chunk, at); at += chunk.length; }
  return out;
}
