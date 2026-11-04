// tools/record-log/do-work/log-position.mjs
//
// A place in a record log, from a time or a log row id. Pure: no store. The log row ids are UUIDv7, so the first twelve
// hex digits are the millisecond the row was made, and an id cut to those digits sorts just before every row made in
// that millisecond. Moved out of the old JS record store copy so a reader of positions needs no store to compute one.

/** The smallest log row id made at `ms`: its first twelve hex digits, as a prefix. */
export function logIdAt(ms) {
  const hex = Math.max(0, Math.floor(ms)).toString(16).padStart(12, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-`;
}
/** The time (ms) a log row id was made at: its first twelve hex digits. */
export function logTimeOf(id) {
  return Number.parseInt(`${id.slice(0, 8)}${id.slice(9, 13)}`, 16);
}
/** A place in the log: a log row id as given, or the place of a time (anything Date.parse reads). */
export function logPositionOf(at) {
  if (typeof at === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-/.test(at)) return at;
  const ms = Date.parse(at);
  if (!Number.isFinite(ms)) throw new Error(`${at} is neither a time nor a log row id.`);
  return logIdAt(ms);
}
