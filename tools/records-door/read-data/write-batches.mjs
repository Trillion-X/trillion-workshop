// tools/records-door/read-data/write-batches.mjs
//
// Records in order as door writes that each fit one message: at most `rows` records (the engine cap or a row's
// most_writes) and `bytes` bytes of their JSON, a record larger than `bytes` going alone. The door's message bound
// (64 KiB) is physics: a write over it is refused whole (413), so a writer that may exceed it cuts here. Pure: no file,
// network or Node module, so a page can load it too.
const utf8 = new TextEncoder();

export function writeBatches(records, { rows, bytes }) {
  if (!(Number.isInteger(rows) && rows > 0 && Number.isInteger(bytes) && bytes > 0)) throw new TypeError('writeBatches needs rows and bytes, each a positive whole number.');
  const out = [];
  let batch = [], held = 0;
  for (const record of records) {
    const size = utf8.encode(JSON.stringify(record)).length;
    if (batch.length && (batch.length >= rows || held + size > bytes)) { out.push(batch); batch = []; held = 0; }
    batch.push(record);
    held += size;
  }
  return batch.length ? [...out, batch] : out;
}
