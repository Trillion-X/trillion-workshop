// Canonical legacy row JSON without constructing the whole quoted row in SQLite or JS. Raw
// TEXT bytes already accepted by SQLite are read in bounded BLOB slices; a source's primary key
// and scalar field byte lengths are its append-only signature. Offsets are bytes, never UTF-16.
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const fields = ['at', 'entity', 'value'];
const queries = fields.map(field => `SELECT hex(substr(CAST(${field} AS BLOB), ?, ?)) AS hex FROM workshop_facts WHERE seq = ? LIMIT 1`);
export const workshopHistorySource = (sql, seq) => {
  const source = sql.exec(`SELECT length(CAST(at AS BLOB)) AS at, length(CAST(entity AS BLOB)) AS entity,
    length(CAST(value AS BLOB)) AS value FROM workshop_facts WHERE seq = ? LIMIT 1`, seq).toArray()[0] ?? null;
  if (source && !fields.every(field => Number.isSafeInteger(source[field]) && source[field] >= 0)) throw new Error('Workshop history source byte lengths are not supported.');
  return source;
};
export const sameWorkshopHistorySource = (a, b) => Boolean(a && b && fields.every(field => a[field] === b[field]));
export const workshopHistoryWholeBound = (seq, source) => encoder.encode(`{"seq":${seq},"at":"","entity":"","value":""}`).length + fields.reduce((sum, field) => sum + source[field] * 6, 0) + 1;
function fromHex(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let at = 0; at < bytes.length; at++) bytes[at] = Number.parseInt(hex.slice(at * 2, at * 2 + 2), 16);
  return bytes;
}
function completeUtf8(bytes) {
  let lead = bytes.length - 1;
  while (lead >= 0 && (bytes[lead] & 0xc0) === 0x80) lead--;
  if (lead < 0) throw new Error('Workshop history source does not contain complete UTF-8.');
  const first = bytes[lead], width = first < 0x80 ? 1 : first < 0xe0 ? 2 : first < 0xf0 ? 3 : 4;
  return bytes.length - lead < width ? bytes.subarray(0, lead) : bytes;
}
export function workshopHistorySlice(sql, seq, source, cursor, ceiling) {
  if (!Number.isSafeInteger(cursor?.stage) || cursor.stage < 0 || cursor.stage > 7 || !Number.isSafeInteger(cursor?.byte) || cursor.byte < 0 || (cursor.stage % 2 === 0 && cursor.byte !== 0) || (cursor.stage < 7 && cursor.stage % 2 === 1 && cursor.byte > source[fields[(cursor.stage - 1) / 2]]) || (cursor.stage === 7 && cursor.byte !== 0)) throw new Error('Workshop history serialization cursor does not match its source.');
  const next = { ...cursor };
  const chunks = [];
  let bytes = 0;
  const fixed = { 0: `{"seq":${seq},"at":"`, 2: '","entity":"', 4: '","value":"', 6: '"}' };
  const append = chunk => { chunks.push(chunk); bytes += chunk.length; };
  // At most sixteen source/fixed pieces per wake, even for low-escape ASCII tails.
  for (let pieces = 0; next.stage < 7 && pieces < 16; pieces++) {
    if (next.stage % 2 === 0) {
      const chunk = encoder.encode(fixed[next.stage]);
      if (chunk.length > ceiling - bytes) break;
      append(chunk); next.stage++; next.byte = 0;
      continue;
    }
    const index = (next.stage - 1) / 2, field = fields[index];
    if (next.byte === source[field]) { next.stage++; next.byte = 0; continue; }
    // One source byte can require six JSON bytes (ASCII controls). Four bytes always admit one
    // complete UTF-8 code point. At a smaller tail budget, stop and resume in the next file.
    const take = Math.min(source[field] - next.byte, Math.floor((ceiling - bytes) / 6));
    if (take < 4 && source[field] - next.byte > take) break;
    if (take < 1) break;
    // reads-ok: one seq-keyed LIMIT 1 row; take is capped by the remaining ceiling / 6.
    const row = sql.exec(queries[index], next.byte + 1, take, seq).toArray()[0];
    if (!row || typeof row.hex !== 'string' || row.hex.length !== take * 2) throw new Error('Workshop task history rows changed before they could be kept.');
    const raw = completeUtf8(fromHex(row.hex));
    if (!raw.length) break;
    const quoted = encoder.encode(JSON.stringify(decoder.decode(raw)).slice(1, -1));
    if (quoted.length > ceiling - bytes) throw new Error('Workshop history serialization exceeded its byte admission.');
    append(quoted); next.byte += raw.length;
  }
  if (!bytes) throw new Error('The Workshop history file limit cannot hold one serialization step.');
  const whole = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { whole.set(chunk, offset); offset += chunk.length; }
  return { bytes: whole, cursor: next, final: next.stage === 7 };
}


export function workshopHistoryHex(bytes) {
  const alphabet = encoder.encode('0123456789ABCDEF');
  const encoded = new Uint8Array(bytes.length * 2);
  for (let at = 0; at < bytes.length; at++) {
    encoded[at * 2] = alphabet[bytes[at] >> 4];
    encoded[at * 2 + 1] = alphabet[bytes[at] & 15];
  }
  return decoder.decode(encoded);
}
