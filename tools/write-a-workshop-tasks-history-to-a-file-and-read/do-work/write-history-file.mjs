// Writes one Workshop task's history pieces into files, and reads those files back whole.
// The line shape is the legacy history shape the old piece reader accepts (see the pinned
// src/workshop-task-history.mjs parts()): a whole legacy row is its own JSON line; a row larger than
// the file ceiling is written as continuation lines { workshop_history_part: { seq, offset, total: null,
// final, hex } }, each line holding exact bytes in hex. Every line stays whole inside one file, and no
// file holds more than file_bytes. Nothing here touches a device: the caller supplies the sink that
// receives each file's bytes, and the sink decides where they go.
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const PART = 'workshop_history_part';
const fail = message => { throw new Error(`Workshop history file: ${message}`); };
const integer = value => Number.isSafeInteger(value) && value >= 0;
const toHex = bytes => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
const fromHex = hex => {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index++) bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  return bytes;
};
// The line length with an empty hex, using final:false (the longer of the two booleans), so a
// line never grows past the room counted for it.
const shellLength = (seq, offset) => encoder.encode(`${JSON.stringify({ [PART]: { seq, offset, total: null, final: false, hex: '' } })}\n`).length;
const partLine = (seq, offset, final, bytes) => encoder.encode(`${JSON.stringify({ [PART]: { seq, offset, total: null, final, hex: toHex(bytes) } })}\n`);

/**
 * pieces: async iterable of { seq, first, last, bytes } (the held piece generator's shape).
 * sink: { write(index, bytes) } called once per whole line, in order; index is the file number from 0.
 * Returns { files } where files is the number of files written (0 for no pieces).
 */
export async function writeHistoryFiles({ pieces, sink, file_bytes }) {
  if (!integer(file_bytes) || file_bytes < 1) fail('invalid file ceiling.');
  let index = 0;
  let used = 0;
  let wrote = false;
  let open = null;
  let offset = 0;
  const emit = async line => {
    if (line.length > file_bytes) fail('a line is larger than the file ceiling.');
    if (wrote && used + line.length > file_bytes) { index += 1; used = 0; }
    await sink.write(index, line);
    wrote = true;
    used += line.length;
  };
  for await (const piece of pieces) {
    const { seq, first, last, bytes } = piece;
    if (!integer(seq) || typeof first !== 'boolean' || typeof last !== 'boolean' || !(bytes instanceof Uint8Array)) fail('an invalid piece was given.');
    if (first) {
      if (open !== null) fail('a row starts before the row before it ended.');
      offset = 0;
    } else if (open === null || open !== seq) fail('a piece continues no row.');
    if (first && last && bytes.length + 1 <= file_bytes) {
      const text = decoder.decode(bytes);
      if (Object.hasOwn(JSON.parse(text), PART)) fail('a whole row carries a continuation key.');
      await emit(encoder.encode(`${text}\n`));
      open = null;
      continue;
    }
    let start = 0;
    do {
      const room = Math.floor((file_bytes - shellLength(seq, offset)) / 2);
      if (room < 1) fail('the file ceiling holds no byte of a row.');
      const count = Math.min(room, bytes.length - start);
      const finalChunk = start + count === bytes.length;
      await emit(partLine(seq, offset, finalChunk ? last : false, bytes.subarray(start, start + count)));
      offset += count;
      start += count;
    } while (start < bytes.length);
    open = last ? null : seq;
  }
  if (open !== null) fail('the pieces ended inside a row.');
  return { files: wrote ? index + 1 : 0 };
}

/**
 * files: the file bytes in order, each a whole set of lines. Returns each row's legacy JSON text, in order.
 * Refuses anything the writer could not have made: a missing first piece, a reordered or repeated piece,
 * a whole row inside an unfinished row, or a file that ends inside a row.
 */
export function readHistoryFiles(files) {
  const rows = [];
  let pending = null;
  for (const bytes of files) {
    if (!(bytes instanceof Uint8Array)) fail('a file is not bytes.');
    for (const line of decoder.decode(bytes).split('\n').filter(Boolean)) {
      let parsed;
      try { parsed = JSON.parse(line); } catch { fail('a line is not JSON.'); }
      const part = parsed[PART];
      if (part === undefined) {
        if (pending) fail('a whole row interrupted an unfinished row.');
        rows.push(line);
        continue;
      }
      const { seq, offset, total, final, hex } = part;
      if (!integer(seq) || !integer(offset) || (total !== null && (!integer(total) || total < 1)) || (total === null && typeof final !== 'boolean') || typeof hex !== 'string' || hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) fail('invalid byte continuation.');
      const length = hex.length / 2;
      if (!pending) {
        if (offset !== 0) fail('a row is missing its first piece.');
        pending = { seq, total, offset: 0, pieces: [] };
      }
      if (pending.seq !== seq || pending.total !== total || pending.offset !== offset || (total !== null && offset + length > total)) fail('a row has a missing, repeated or reordered piece.');
      pending.pieces.push(fromHex(hex));
      pending.offset += length;
      const last = total === null ? final : pending.offset === total;
      if (last) {
        const whole = new Uint8Array(pending.offset);
        let at = 0;
        for (const piece of pending.pieces) { whole.set(piece, at); at += piece.length; }
        rows.push(decoder.decode(whole));
        pending = null;
      }
    }
  }
  if (pending) fail('the files end inside a row.');
  return rows;
}
