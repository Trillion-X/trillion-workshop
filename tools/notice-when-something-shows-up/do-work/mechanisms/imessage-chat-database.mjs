/**
 * notice-when-something-shows-up/do-work/mechanisms/imessage-chat-database.mjs
 *
 * Purpose
 *   One waiting mechanism: watch the Messages database on the person's own Mac
 *   and report each iMessage or text message the moment Messages writes it: a new
 *   message (added), an edit (changed) and an unsend (removed), in a chat with one
 *   person or in a group, whatever it carries (words, a photo, a video, a voice
 *   note, a file). Nothing is read on a timer: the leaf watches the database's
 *   folder, and each write Messages makes there wakes one read of what is new.
 *
 * Non-negotiable invariants
 *   - Read only. The database opens read-only on every read and closes after it;
 *     this leaf never sends a message and never writes to the database. Sending is
 *     tools/bring-in-new-items-from-this-computer/computer/connections/imessage.mjs,
 *     whose words decoding (textFromAttributedBody) and dates (appleTime) are used
 *     here, not copied.
 *   - A fact carries the change itself, each field within the engine's 1,024 bytes
 *     (CARRIED_BYTES), the same eight fields as every message source: where, place
 *     ("message"), change, at (the message's own time), key (<chat guid>/<message
 *     guid>, the same for its edit and its unsend), by (the sender's handle, "me"
 *     for the person's own), after (JSON text {chat, chat_name, group, from, words,
 *     media, reply_to}), kinds (JSON text of the row's kinds). Words too long for
 *     after are cut and marked `words_cut`; media is told by its attachment guid and
 *     kind, never its bytes.
 *   - Nothing is told twice. The waiter's state keeps the last message row read
 *     (`last_row`) and the newest edit and unsend times read (`edited_mark`,
 *     `retracted_mark`, as the database's own nanosecond text), so a restart reads
 *     on from there; each change also has its own event key (<key>:added,
 *     <key>:changed:<edit time>, <key>:removed).
 *   - Older messages are told only from `history_since` on (an ISO time). Without
 *     it, the first start tells nothing already there: it marks where the database
 *     is and tells what comes after.
 *   - A Mac that refuses the database (Full Disk Access not given to the app that
 *     runs this) is told once as a fact at place "access" with the setting to
 *     change, then the leaf waits quietly; it never fails silently and never spins.
 *
 * Settings (mechanism_settings)
 *   where            the name of this source, told as each fact's where (default "imessage")
 *   database         the Messages database, absolute or under the person's home folder (default Library/Messages/chat.db);
 *                    a waiter run inside a Mac sandbox names it absolutely, since the sandbox may hide the account list
 *   history_since    ISO time: on the first start, also tell messages at or after it
 *   include_own      true to tell the person's own sends too (default false)
 *   kinds            the kinds each message fact carries (default ["seed"])
 *   settle_ms        how long a burst of writes settles before one read (default 250)
 */
import { createHash } from "node:crypto";
import { watch } from "node:fs";
import { userInfo } from "node:os";
import path from "node:path";
import { appleTime, textFromAttributedBody } from "../../../bring-in-new-items-from-this-computer/computer/connections/imessage.mjs";

export const MECHANISM_REF = "package::notice-when-something-shows-up::mechanism::imessage-chat-database";
// A told fact holds at most 1,024 bytes a field (the engine's fact inbox, src/wake/host-events.json).
export const CARRIED_BYTES = 1000;
// Messages' chat style for a group chat (a chat with one person is 45).
const GROUP_STYLE = 43;
const APPLE_EPOCH_MS = 978307200000;

export function describeMechanism() {
  return {
    mechanism_ref: MECHANISM_REF,
    detail_fields: ["where", "place", "change", "at", "key", "by", "after", "kinds"],
    conditions: ["became-reachable"],
  };
}

export function readSettings(settings = {}) {
  const since = typeof settings.history_since === "string" && Number.isFinite(Date.parse(settings.history_since)) ? new Date(settings.history_since).toISOString() : null;
  const settle = Number(settings.settle_ms);
  return {
    where: typeof settings.where === "string" && settings.where ? settings.where : "imessage",
    database: typeof settings.database === "string" && settings.database ? settings.database : "Library/Messages/chat.db",
    history_since: since,
    include_own: settings.include_own === true,
    kinds: Array.isArray(settings.kinds) && settings.kinds.every((kind) => typeof kind === "string") ? settings.kinds : ["seed"],
    settle_ms: Number.isFinite(settle) && settle >= 0 ? settle : 250,
  };
}

/** The database's own nanosecond date text for an ISO time. */
export function appleNanos(iso) {
  return String(BigInt(Date.parse(iso) - APPLE_EPOCH_MS) * 1_000_000n);
}

/** A media kind from an attachment's type. */
export function mediaKind({ mime_type: mime, uti, audio }) {
  const type = String(mime ?? "");
  if (audio) return "voice_note";
  if (type.startsWith("image/")) return "photo";
  if (type.startsWith("video/")) return "video";
  if (type.startsWith("audio/")) return "audio";
  if (/sticker/i.test(String(uti ?? ""))) return "sticker";
  return "document";
}

/** `after` as JSON text within CARRIED_BYTES. Over it, media keeps only its kind and identity, then the words are cut to fit
 *  and marked `words_cut` (their whole length in bytes), then media past what fits is left out and counted. */
export function afterOf({ chat, chat_name, group, from = null, words, media, reply_to }) {
  const fits = (value) => Buffer.byteLength(JSON.stringify(value)) <= CARRIED_BYTES;
  const whole = { chat, chat_name: chat_name ?? null, group, from, words, media, reply_to: reply_to ? `${chat}/${reply_to}` : null };
  if (fits(whole)) return JSON.stringify(whole);
  let lean = { ...whole, media: media.map(({ kind, identity }) => ({ kind, identity })) };
  if (fits(lean)) return JSON.stringify(lean);
  if (words) {
    const letters = Array.from(words);
    const cut = (count) => ({ ...lean, words: letters.slice(0, count).join(""), words_cut: Buffer.byteLength(words) });
    let low = 0;
    let high = letters.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (fits(cut(middle))) low = middle; else high = middle - 1;
    }
    lean = cut(low);
    if (fits(lean)) return JSON.stringify(lean);
  }
  const kept = [...lean.media];
  while (kept.length && !fits({ ...lean, media: kept, media_cut: media.length - kept.length })) kept.pop();
  return JSON.stringify({ ...lean, media: kept, media_cut: media.length - kept.length });
}

// The columns a message read takes. Dates are read as text: node:sqlite refuses an integer past 2^53, and every nanosecond
// date since 2001 is past it.
const MESSAGE_COLUMNS = `m.ROWID AS row, m.guid AS guid, m.text AS text, m.attributedBody AS body,
  CAST(m.date AS TEXT) AS date, CAST(COALESCE(m.date_edited, 0) AS TEXT) AS edited, CAST(COALESCE(m.date_retracted, 0) AS TEXT) AS retracted,
  m.is_from_me AS mine, m.is_audio_message AS audio, m.associated_message_type AS reaction, m.thread_originator_guid AS reply_to,
  h.id AS handle, c.guid AS chat, c.chat_identifier AS chat_identifier, NULLIF(c.display_name, '') AS chat_name, c.style AS style`;
const MESSAGE_FROM = `FROM message m
  LEFT JOIN handle h ON h.ROWID = m.handle_id
  LEFT JOIN chat_message_join j ON j.message_id = m.ROWID
  LEFT JOIN chat c ON c.ROWID = j.chat_id`;

/** Every read the leaf makes of one open database, as plain rows. */
export function readDatabase(db) {
  const all = (sql, ...params) => db.prepare(sql).all(...params);
  const columns = new Set(all("PRAGMA table_info(message)").map((column) => column.name));
  const edits = columns.has("date_edited") && columns.has("date_retracted");
  const attachmentsOf = (row) => all(`SELECT a.guid AS guid, a.mime_type AS mime_type, a.uti AS uti, a.transfer_name AS name, a.total_bytes AS bytes
      FROM message_attachment_join x JOIN attachment a ON a.ROWID = x.attachment_id WHERE x.message_id = ? ORDER BY a.ROWID`, row);
  const columnsFor = edits ? MESSAGE_COLUMNS : MESSAGE_COLUMNS.replace(/CAST\(COALESCE\(m\.date_edited, 0\) AS TEXT\)/, "'0'").replace(/CAST\(COALESCE\(m\.date_retracted, 0\) AS TEXT\)/, "'0'");
  return {
    edits,
    newest() {
      const row = all("SELECT COALESCE(MAX(ROWID), 0) AS row FROM message")[0]?.row ?? 0;
      const marks = edits ? all("SELECT CAST(COALESCE(MAX(date_edited), 0) AS TEXT) AS edited, CAST(COALESCE(MAX(date_retracted), 0) AS TEXT) AS retracted FROM message")[0] : { edited: "0", retracted: "0" };
      return { row: Number(row), edited: marks.edited, retracted: marks.retracted };
    },
    lastRowBefore(nanos) {
      return Number(all("SELECT COALESCE(MAX(ROWID), 0) AS row FROM message WHERE date < CAST(? AS INTEGER)", nanos)[0]?.row ?? 0);
    },
    added(afterRow) {
      return all(`SELECT ${columnsFor} ${MESSAGE_FROM} WHERE m.ROWID > ? ORDER BY m.ROWID`, afterRow).map((row) => ({ ...row, attachments: attachmentsOf(row.row) }));
    },
    changed(editedMark, retractedMark) {
      if (!edits) return [];
      return all(`SELECT ${columnsFor} ${MESSAGE_FROM}
          WHERE m.date_edited > CAST(? AS INTEGER) OR m.date_retracted > CAST(? AS INTEGER) ORDER BY m.ROWID`, editedMark, retractedMark)
        .map((row) => ({ ...row, attachments: attachmentsOf(row.row) }));
    },
  };
}

const later = (a, b) => (BigInt(a ?? 0) >= BigInt(b ?? 0) ? String(a ?? 0) : String(b ?? 0));
const isLater = (a, b) => BigInt(a ?? 0) > BigInt(b ?? 0);

/** The fact one message row is told as, or null when it is not a message of its own (a tapback) or carries nothing. */
export function changeOf(own, row, change) {
  if (!row.guid || Number(row.reaction ?? 0) !== 0) return null;
  if (!own.include_own && Number(row.mine) === 1) return null;
  const chat = row.chat ?? row.chat_identifier ?? row.handle ?? null;
  if (!chat) return null;
  const key = `${chat}/${row.guid}`;
  const from = Number(row.mine) === 1 ? "me" : row.handle ?? null;
  const group = Number(row.style) === GROUP_STYLE;
  const at = change === "added" ? appleTime(row.date) : appleTime(change === "removed" ? row.retracted : row.edited) ?? appleTime(row.date);
  if (!at) return null;
  const event_key = change === "changed" ? `${key}:changed:${row.edited}` : `${key}:${change}`;
  if (change === "removed") {
    return { event_key, at, detail: { where: own.where, place: "message", change, at, key, by: from, after: JSON.stringify({ chat, chat_name: row.chat_name ?? null, group, from }), kinds: JSON.stringify(own.kinds) } };
  }
  const words = (row.text && row.text.trim() ? row.text : textFromAttributedBody(row.body)) ?? null;
  // The object replacement character stands where an attachment sits in the words; it says nothing on its own.
  const said = words ? words.replace(/￼/g, "").trim() || null : null;
  const media = (row.attachments ?? []).map((item) => Object.fromEntries(Object.entries({
    kind: mediaKind({ ...item, audio: Number(row.audio) === 1 }),
    identity: item.guid ?? null,
    media_type: item.mime_type ?? null,
    bytes: Number(item.bytes) > 0 ? Number(item.bytes) : null,
    name: item.name ?? null,
  }).filter(([, value]) => value !== null)));
  if (!said && !media.length) return null;
  const after = afterOf({ chat, chat_name: row.chat_name, group, from, words: said, media, reply_to: row.reply_to });
  return { event_key, at, detail: { where: own.where, place: "message", change, at, key, by: from, after, kinds: JSON.stringify(own.kinds) } };
}

/**
 * The changes since a state, each {event_key, at, detail}, and the state after them. `state` is {last_row, edited_mark,
 * retracted_mark, started_at}; a row added is never also told as an edit in the same read.
 */
export function changesSince(own, reader, state) {
  const changes = [];
  const added = reader.added(state.last_row);
  const since = state.started_at;
  for (const row of added) {
    const at = appleTime(row.date);
    if (since && at && at < since) continue;
    const change = changeOf(own, row, "added");
    if (change) changes.push(change);
  }
  const fresh = new Set(added.map((row) => row.row));
  let edited = state.edited_mark;
  let retracted = state.retracted_mark;
  for (const row of reader.changed(state.edited_mark, state.retracted_mark)) {
    edited = later(edited, row.edited);
    retracted = later(retracted, row.retracted);
    if (fresh.has(row.row)) continue;
    const kind = isLater(row.retracted, state.retracted_mark) && BigInt(row.retracted ?? 0) > 0n ? "removed" : isLater(row.edited, state.edited_mark) ? "changed" : null;
    if (!kind) continue;
    const change = changeOf(own, row, kind);
    if (change) changes.push(change);
  }
  for (const row of added) {
    edited = later(edited, row.edited);
    retracted = later(retracted, row.retracted);
  }
  const last_row = added.length ? Math.max(state.last_row, ...added.map((row) => Number(row.row))) : state.last_row;
  return { changes, state: { ...state, last_row, edited_mark: edited, retracted_mark: retracted } };
}

/** The fact a refused database is told as: the setting to change, and the program macOS asks about. */
export function accessChange(own, error, at, program = process.execPath) {
  const after = {
    state: "refused",
    why: String(error?.message ?? error).slice(0, 200),
    setting: "System Settings > Privacy & Security > Full Disk Access",
    give_it_to: "the app that runs this engine, or the program below when it runs on its own",
    program,
  };
  return { event_key: `access:refused`, at, detail: { where: own.where, place: "access", change: "removed", at, key: `access:${own.where}`, by: null, after: JSON.stringify(after), kinds: JSON.stringify(["imessage-needs-full-disk-access"]) } };
}

const refused = (error) => /authorization denied|not permitted|unable to open|operation not permitted|EPERM|EACCES/i.test(String(error?.message ?? error));

// The person's home folder: the account list's, else HOME. A run in a Mac sandbox may not read the account list
// (uv_os_get_passwd answered ENOENT on the first live start, Nov 20 2026), so a waiter there names its database absolutely.
function homeFolder() {
  try { return userInfo().homedir; } catch { return process.env.HOME ?? "/"; }
}

function openReadOnly(file) {
  const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
  return new DatabaseSync(file, { readOnly: true });
}

const waitForAbort = (signal) => new Promise((resolve) => {
  if (!signal || signal.aborted) return resolve();
  signal.addEventListener("abort", resolve, { once: true });
});

/**
 * Watch the Messages database and report each message change as Messages writes it.
 * @param {object} settings the descriptor row's mechanism_settings
 * @param {object} handlers onTransition, signal, state ({last_row, edited_mark, retracted_mark, started_at, told}), keepState,
 *   and for tests: open (path → a read-only database), watchFolder ((folder, wake) → {close}), now, home
 */
export async function watchForTransitions(settings, handlers) {
  const own = readSettings(settings);
  const signal = handlers.signal;
  const now = handlers.now ?? (() => Date.now());
  const file = path.isAbsolute(own.database) ? own.database : path.join(handlers.home ?? homeFolder(), own.database);
  const open = handlers.open ?? openReadOnly;
  const watchFolder = handlers.watchFolder ?? ((folder, wake) => watch(folder, { persistent: true }, wake));

  let state = handlers.state && Number.isInteger(handlers.state.last_row) ? { told: [], ...handlers.state } : null;
  let told = new Set(state?.told ?? []);

  const tell = async (change) => {
    if (signal?.aborted || told.has(change.event_key)) return true;
    const nextTold = [...(state?.told ?? []).filter((key) => key !== change.event_key), change.event_key].slice(-500);
    const accepted = await handlers.onTransition({ condition: "became-reachable", observed_identity: { where: own.where, place: change.detail.place }, event_key: change.event_key, state: { ...state, told: nextTold }, detail: change.detail });
    if (accepted === false) return false;
    state = { ...state, told: nextTold };
    told = new Set(nextTold);
    return true;
  };

  const withDatabase = (work) => {
    const db = open(file);
    try { return work(readDatabase(db)); } finally { db.close?.(); }
  };

  // The first start marks where the database is (or where history_since begins) and tells nothing older.
  const begin = () => withDatabase((reader) => {
    const newest = reader.newest();
    const started_at = own.history_since ?? new Date(now()).toISOString();
    const last_row = own.history_since ? reader.lastRowBefore(appleNanos(own.history_since)) : newest.row;
    return { last_row, edited_mark: newest.edited, retracted_mark: newest.retracted, started_at, told: [] };
  });

  // One read of what is new; facts are told in order, and the state moves only past what was told.
  let reading = Promise.resolve();
  const read = () => {
    reading = reading.then(async () => {
      if (signal?.aborted) return;
      const { changes, state: next } = withDatabase((reader) => changesSince(own, reader, state));
      for (const change of changes) if (!(await tell(change))) return;
      state = { ...next, told: state.told };
      await handlers.keepState?.(state);
    }).catch((error) => process.stderr.write(`${JSON.stringify({ imessage: "read_failed", error: String(error?.message ?? error) })}\n`));
    return reading;
  };

  try {
    if (!state) {
      state = begin();
      await handlers.keepState?.(state);
    } else {
      // A restart opens the database once before anything else, so a refusal is told and not only logged by a read.
      withDatabase(() => null);
    }
    await read();
  } catch (error) {
    if (!refused(error)) throw error;
    await tell(accessChange(own, error, new Date(now()).toISOString()));
    await waitForAbort(signal);
    return;
  }

  // Messages writes the database's -wal file on each message; any write in the folder wakes one read once the burst settles.
  let timer = null;
  const wake = () => {
    if (timer) return;
    timer = setTimeout(() => { timer = null; void read(); }, own.settle_ms);
  };
  const watcher = watchFolder(path.dirname(file), wake);
  try {
    await waitForAbort(signal);
  } finally {
    clearTimeout(timer);
    watcher?.close?.();
    await reading;
  }
}
