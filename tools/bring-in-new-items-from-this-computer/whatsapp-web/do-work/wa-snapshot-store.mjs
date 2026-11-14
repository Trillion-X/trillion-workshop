// packages/whatsapp-web-connector/do-work/wa-snapshot-store.mjs
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The PURE, I/O-free core of the WhatsApp (Baileys v7) connector: it turns the
// STREAM of Baileys message batches (history sync on reconnect + live
// `messages.upsert`) into a durable, DEDUPLICATED snapshot — exactly the JSON
// shape the whatsapp-web-decoder reads ({self_jid, contacts, messages}). The
// live worker is a thin shell that owns the WebSocket, QR/pairing, and the
// credentials-vault round-trip, and calls THIS module on every event batch, then
// writes the returned snapshot to the capture dir a file-glob observer watches.
//
// This is an ACQUISITION-ADAPTER LEAF (the save-what-you-watch-and-read pattern):
// it owns ONLY "WhatsApp event stream -> durable snapshot". It does NO network,
// NO auth, NO decoding (the decoder + transcript-mapper own that), NO ledger, NO
// credentials (the worker + credentials-vault own that). No god package.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. PURE + immutable: mergeMessages returns a NEW snapshot; the input is never
//    mutated. So the whole merge/dedup/order contract is unit-testable with plain
//    objects — no sockets, no files.
// 2. Idempotent dedup: a message redelivered across history + live (or replayed
//    on reconnect) appears ONCE. Identity = `${remoteJid}:${id}` from the WA key
//    — the same conversation+message can never double-count.
// 3. Chronological: messages are kept ordered by messageTimestamp (ascending), so
//    the decoder's per-thread order (and the sidebar's "last message") is stable
//    regardless of the order batches arrive (history is often newest-first).
// 4. Self-describing output: the snapshot is the decoder's input contract
//    verbatim — this module never encodes decoder knowledge (no thread grouping,
//    no text extraction; the decoder owns those).
import crypto from 'node:crypto';

/** Empty snapshot for a viewer (our own jid). contacts maps jid -> display name. */
export function emptySnapshot(selfJid = null) {
  return { self_jid: selfJid, contacts: {}, messages: [] };
}

/** Stable per-message identity within the account: remoteJid + WA message id.
 *  Falls back to a content hash when a key/id is absent (malformed event) so a
 *  keyless message still dedups against an identical redelivery. */
export function messageKey(m) {
  const key = (m && m.key) || {};
  const jid = key.remoteJid || '';
  if (key.id) return `${jid}:${key.id}`;
  const basis = JSON.stringify([jid, m && m.messageTimestamp, m && m.message]);
  return `${jid}:sha:${crypto.createHash('sha256').update(basis).digest('hex').slice(0, 24)}`;
}

/** Epoch seconds for ordering. Baileys messageTimestamp is seconds (number or a
 *  protobuf Long {low}); tolerate ISO strings too. Missing -> 0 (sorts first). */
function tsOf(m) {
  let v = m && (m.messageTimestamp ?? m.timestamp);
  if (v && typeof v === 'object') v = v.low ?? v.value;
  if (typeof v === 'string') { const n = Date.parse(v); return Number.isNaN(n) ? 0 : n / 1000; }
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** A non-fromMe message tells us the sender's display name (pushName). Capture it
 *  into contacts keyed by the actual sender jid (group participant, else the 1:1
 *  remoteJid) so the decoder can label speakers without a separate contacts sync. */
function captureContact(contacts, m) {
  const key = (m && m.key) || {};
  if (key.fromMe) return;
  const name = m && m.pushName;
  if (typeof name !== 'string' || !name) return;
  const jid = key.participant || key.remoteJid;
  if (jid && !contacts[jid]) contacts[jid] = name;
}

/**
 * Merge a batch of Baileys WAMessages into a snapshot. Deduplicates by message
 * identity, captures pushName contacts, and keeps messages chronological.
 * Returns a NEW snapshot (input untouched).
 *
 * @param {{self_jid:?string, contacts:Object, messages:Array}} snapshot
 * @param {Array<Object>} waMessages  raw WAMessages (from messages.upsert.messages or history)
 * @param {{selfJid?:string}} [opts]
 */
export function mergeMessages(snapshot, waMessages, opts = {}) {
  const base = snapshot || emptySnapshot();
  const contacts = { ...(base.contacts || {}) };
  const seen = new Set();
  const merged = [];
  // Existing first (preserve), then new — dedup wins for the FIRST occurrence.
  for (const m of base.messages || []) {
    const k = messageKey(m);
    if (seen.has(k)) continue;
    seen.add(k); merged.push(m);
  }
  for (const m of Array.isArray(waMessages) ? waMessages : []) {
    if (!m || typeof m !== 'object' || !m.key) continue;
    const k = messageKey(m);
    if (seen.has(k)) continue;
    seen.add(k); merged.push(m);
    captureContact(contacts, m);
  }
  merged.sort((a, b) => tsOf(a) - tsOf(b));
  return {
    self_jid: opts.selfJid || base.self_jid || null,
    contacts,
    messages: merged,
  };
}

/** Merge Baileys history-sync DIRECTORY data into the snapshot's contacts map.
 *  Every `messaging-history.set` event delivers, ALONGSIDE its message chunk, a
 *  `contacts` array (Contact: {id, name?, notify?, verifiedName?}) and a `chats`
 *  array (Chat: {id, name?} — a group chat's `name` IS its subject). Both entries
 *  bind a jid -> display name, and the decoder's title/speaker resolution reads
 *  `snapshot.contacts[jid]` — so capturing this directory is precisely what turns
 *  phone-number titles into real contact names and group subjects, with NO extra
 *  contacts-sync round-trip. Pure: returns a NEW snapshot, input untouched.
 *  Fail-open per entry: a malformed or nameless row is skipped, never throws
 *  (L090 self-describing, generic). First real name wins — a later empty/notify
 *  never clobbers an already-captured name (stable titles across resyncs). */
export function mergeContacts(snapshot, directory = {}) {
  const base = snapshot || emptySnapshot();
  const contacts = { ...(base.contacts || {}) };
  const put = (jid, name) => {
    if (typeof jid !== 'string' || !jid) return;
    if (typeof name !== 'string' || !name.trim()) return;
    if (!contacts[jid]) contacts[jid] = name.trim();
  };
  for (const c of Array.isArray(directory.contacts) ? directory.contacts : []) {
    if (c && typeof c === 'object') put(c.id, c.name || c.notify || c.verifiedName);
  }
  for (const ch of Array.isArray(directory.chats) ? directory.chats : []) {
    if (ch && typeof ch === 'object') put(ch.id, ch.name || ch.subject);
  }
  return { self_jid: base.self_jid || null, contacts, messages: base.messages || [] };
}

/** Convenience: fold many batches (e.g. a full history sync arriving in chunks)
 *  onto a starting snapshot in one call. */
export function mergeBatches(snapshot, batches, opts = {}) {
  let acc = snapshot || emptySnapshot(opts.selfJid || null);
  for (const batch of Array.isArray(batches) ? batches : []) {
    acc = mergeMessages(acc, batch, opts);
  }
  return acc;
}
