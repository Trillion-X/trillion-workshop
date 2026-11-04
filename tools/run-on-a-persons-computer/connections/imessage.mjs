// computer/connections/imessage.mjs
//
// Purpose
//   iMessage as a connection this Mac carries (a client program on the person's own computer, loaded by
//   computer/carry-connections.mjs, never part of the hosted service). Sends through the Messages app with AppleScript
//   and reads recent messages from the Messages database, both as the person signed in to this Mac.
//   Ported from bitfield-packages imessage-messages-sender (the AppleScript) and imessage-chatdb-decoder (the database
//   read and the attributedBody decode), with no Bitfield runtime.
//
// Non-negotiable invariants
//   1. The recipient and the words reach AppleScript only as argv items, never inside the script text, so nothing a
//      message says can run as a script.
//   2. The database opens read-only; nothing here writes to it.
//   3. A refusal by macOS is reported with the exact setting that allows it, never as a silent empty answer.
//
// Key concepts
//   "me"             the handle of this Mac's iMessage account (E:<email> or P:<phone> in Messages, prefix removed)
//   attributedBody   the typedstream blob modern Messages keeps the words in when the text column is empty
//   message date     nanoseconds since 2001-01-01 (seconds on old databases)
//
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

const APPLE_EPOCH = 978307200;

const SEND_SCRIPT = [
  'on run argv',
  '  set recipientId to item 1 of argv',
  '  set messageBody to item 2 of argv',
  '  tell application "Messages"',
  '    set targetService to 1st service whose service type = iMessage',
  '    set targetBuddy to buddy recipientId of targetService',
  '    send messageBody to targetBuddy',
  '  end tell',
  '  return "SENT"',
  'end run',
].join('\n');
const ACCOUNT_SCRIPT = 'tell application "Messages" to get description of (1st account whose service type = iMessage)';

/** Runs osascript with the script and argv items; resolves { code, out, err, timed_out }. */
export const runOsascript = (script, argv = [], { timeout = 30000 } = {}) => new Promise(resolve => {
  execFile('osascript', ['-e', script, ...argv], { timeout }, (error, stdout, stderr) => resolve({ code: error ? (error.code ?? 1) : 0, out: String(stdout).trim(), err: String(stderr).trim(), timed_out: Boolean(error?.killed) }));
});

/** The words of a message kept in an attributedBody blob: the first byte array after the NSString class marker. */
export function textFromAttributedBody(blob) {
  if (!blob) return null;
  const data = Buffer.from(blob);
  let anchor = data.indexOf('NSString');
  if (anchor === -1) anchor = data.indexOf('NSMutableString');
  if (anchor === -1) return null;
  const plus = data.indexOf('+', anchor);
  if (plus === -1 || plus + 1 >= data.length) return null;
  let at = plus + 1;
  let length;
  if (data[at] === 0x81) { length = data.readUInt16LE(at + 1); at += 3; }
  else if (data[at] === 0x82) { length = data.readUInt32LE(at + 1); at += 5; }
  else { length = data[at]; at += 1; }
  if (length <= 0 || at + length > data.length) return null;
  return data.subarray(at, at + length).toString('utf8') || null;
}

/** An ISO time from a Messages date (nanoseconds since 2001, or seconds on old databases), given as a number or as
 * its digits: the read takes the date as text, because node:sqlite refuses an integer past 2^53 and every
 * nanosecond date since 2001 is past it. */
export function appleTime(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  const seconds = number > 1e11 ? number / 1e9 : number;
  return new Date((seconds + APPLE_EPOCH) * 1000).toISOString();
}

// What macOS said, in words that name the setting to change.
// An answer that never came (timed_out) is macOS holding the script at its Allow prompt.
function refusal(err, words, timedOut = false) {
  if (timedOut || /-1712/.test(err)) return words.asking;
  if (/-1743|Not authorized to send Apple events/i.test(err)) return words.automation;
  if (/-1728|Can.t get buddy/i.test(err)) return words.unknown_recipient;
  return err || words.not_sent;
}

// node:sqlite, loaded only when a read runs.
function openReadOnly(path) {
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
  return new DatabaseSync(path, { readOnly: true });
}

/**
 * settings: this connection's row in computer/carry-connections.json
 * run:      (script, argv) → { code, out, err, timed_out }   (osascript; a fake in tests)
 * open:     path → a read-only database with prepare(sql).all(...params) (node:sqlite; a fake in tests)
 */
export function imessage(settings, { run = runOsascript, open = openReadOnly } = {}) {
  const words = settings.words;
  let me = null;

  // This Mac's iMessage handle, or why it could not be read (a refused Automation permission says which setting).
  async function account() {
    const answer = await run(ACCOUNT_SCRIPT, []);
    if (answer.code !== 0) return { handle: null, why: refusal(answer.err, words, answer.timed_out) };
    if (!answer.out || answer.out === 'missing value') return { handle: null, why: words.no_account };
    return { handle: answer.out.replace(/^[A-Za-z]:/, ''), why: null };
  }

  return {
    // Carried when this Mac has an iMessage account signed in to Messages.
    async start() {
      const found = await account();
      me = found.handle;
      return me ? { carried: true, account: me } : { carried: false, why: found.why };
    },
    async send({ to, text, link, owner_identity }) {
      const found = to === 'me' ? await account() : { handle: me, why: words.no_account };
      const recipient = to === 'me' ? found.handle : to;
      if (!recipient) return { sent: false, error: found.why };
      if (to === 'me' && (typeof owner_identity !== 'string' || recipient.toLowerCase() !== owner_identity.trim().toLowerCase())) {
        return { sent: false, error: 'This Mac’s Messages account does not match your verified Trillion sign-in address. Nothing was sent through iMessage.' };
      }
      const body = [text, link].filter(Boolean).join('\n');
      const answer = await run(SEND_SCRIPT, [recipient, body]);
      return answer.code === 0 && answer.out === 'SENT'
        ? { sent: true, to: recipient, at: new Date().toISOString() }
        : { sent: false, to: recipient, error: refusal(answer.err, words, answer.timed_out) };
    },
    async read({ with: who, limit } = {}) {
      let db;
      try { db = open(join(homedir(), settings.database)); } catch (error) {
        return { messages: [], error: /authorization denied|not permitted|unable to open/i.test(String(error.message)) ? words.full_disk_access : String(error.message) };
      }
      try {
        const filter = who ? 'AND (h.id LIKE ? OR c.chat_identifier LIKE ? OR c.display_name LIKE ?)' : '';
        const like = `%${String(who ?? '').replace(/[%_]/g, '')}%`;
        const rows = db.prepare(`SELECT m.text AS text, m.attributedBody AS body, CAST(m.date AS TEXT) AS date, m.is_from_me AS mine, h.id AS handle,
            COALESCE(NULLIF(c.display_name, ''), c.chat_identifier) AS chat
          FROM message m
          LEFT JOIN handle h ON h.ROWID = m.handle_id
          LEFT JOIN chat_message_join j ON j.message_id = m.ROWID
          LEFT JOIN chat c ON c.ROWID = j.chat_id
          WHERE ((m.text IS NOT NULL AND TRIM(m.text) <> '') OR m.attributedBody IS NOT NULL) ${filter}
          ORDER BY m.date DESC LIMIT ?`).all(...(who ? [like, like, like] : []), limit ?? settings.read_limit);
        return {
          messages: rows.map(row => ({
            from: row.mine ? 'me' : row.handle ?? null,
            chat: row.chat ?? row.handle ?? null,
            at: appleTime(row.date),
            text: (row.text && row.text.trim() ? row.text : textFromAttributedBody(row.body)) ?? '',
          })),
        };
      } catch (error) {
        return { messages: [], error: /authorization denied|not permitted/i.test(String(error.message)) ? words.full_disk_access : String(error.message) };
      } finally { db.close?.(); }
    },
  };
}
