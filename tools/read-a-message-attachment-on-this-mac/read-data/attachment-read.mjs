// read-data/attachment-read.mjs
//
// Purpose
//   One attachment of the Messages database on this Mac, answered as its bytes (base64 inside a JSON answer) so the
//   Messages screen can show a photo inline. The row id (or guid) names a row of chat.db's attachment table; the row's
//   filename names the file, which is read only from under the person's Library/Messages/Attachments folder. A picture
//   can instead be answered as a JPEG that macOS sips makes with a chosen largest side.
//
// Non-negotiable invariants
//   1. chat.db is never opened where it lives. It is copied, with its -wal, into a private folder and the copy is opened
//      read-only: an immutable read skips the WAL and misses recent attachments.
//   2. A file is read only when its path, with symlinks resolved, is inside <home>/Library/Messages/Attachments.
//   3. Only attachment columns are selected. No message text is read, answered or logged.
//   4. The answer stays under MAX_RAW_BYTES of file, so its base64 stays under the 1 MiB JSON answer limit. A larger file
//      is refused with the JPEG request that would make it smaller.
//   5. sips runs with argv items and no shell.
//
// Key concepts
//   ROWID     the attachment's id in chat.db (a whole number; a guid is the other way to name it)
//   filename  the path the row names, often "~/Library/Messages/Attachments/xx/yy/<guid>/IMG_0001.HEIC"
//   offloaded a file iCloud kept elsewhere: the row exists but its filename is empty or the file is not on this Mac
//
import { execFile } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, isAbsolute, join, resolve, sep } from 'node:path';
import words from './words.json' with { type: 'json' };

export const MAX_RAW_BYTES = 700 * 1024;
export const DEFAULT_JPEG_PX = 2048;
const MIN_JPEG_PX = 64;
const MAX_JPEG_PX = 4096;
const SIPS = '/usr/bin/sips';

const MEDIA_BY_EXTENSION = {
  '.heic': 'image/heic', '.heif': 'image/heif', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.gif': 'image/gif', '.webp': 'image/webp', '.tif': 'image/tiff', '.tiff': 'image/tiff',
  '.mov': 'video/quicktime', '.mp4': 'video/mp4', '.m4a': 'audio/mp4', '.caf': 'audio/x-caf',
};

const isInside = (child, parent) => child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);

/** The request as the tool takes it: { selector, as, most_px } or { refusal }. A whole-number string is a row id. */
export function parseRequest(input = {}) {
  const { attachment, as = 'original', most_px = DEFAULT_JPEG_PX } = input ?? {};
  let selector = null;
  if (Number.isSafeInteger(attachment) && attachment > 0) selector = { column: 'ROWID', value: attachment };
  else if (typeof attachment === 'string' && /^\d{1,15}$/.test(attachment)) selector = { column: 'ROWID', value: Number(attachment) };
  else if (typeof attachment === 'string' && /^[A-Za-z0-9:_.-]{1,200}$/.test(attachment)) selector = { column: 'guid', value: attachment };
  if (!selector) return { refusal: 'bad_attachment' };
  if (as !== 'original' && as !== 'jpeg') return { refusal: 'bad_options' };
  if (!Number.isInteger(most_px) || most_px < MIN_JPEG_PX || most_px > MAX_JPEG_PX) return { refusal: 'bad_options' };
  return { selector, as, most_px };
}

/** The media type: the row's mime type when it names one, else the type of the file's extension. */
export function mediaTypeOf(row) {
  if (typeof row.mime_type === 'string' && row.mime_type.includes('/')) return row.mime_type;
  return MEDIA_BY_EXTENSION[extname(row.filename ?? '').toLowerCase()] ?? 'application/octet-stream';
}

/** The file a row's filename names, under the attachments folder of home, or a refusal. Symlinks are resolved first, so a
 * link that leaves the folder is refused like a path that does. */
export function attachmentPathOf(filename, home) {
  const root = resolve(home, 'Library', 'Messages', 'Attachments');
  const named = filename.startsWith('~/') ? join(home, filename.slice(2)) : filename;
  if (!isAbsolute(named) || !isInside(resolve(named), root)) return { refused: 'outside_attachments' };
  if (!existsSync(root) || !existsSync(resolve(named))) return { refused: 'not_on_this_mac' };
  const real = realpathSync(resolve(named));
  if (!isInside(real, realpathSync(root))) return { refused: 'outside_attachments' };
  return { path: real };
}

/** Copies chat.db and its -wal into folder and returns the copy's path. A copy that cannot be made is the Full Disk Access refusal. */
function copyChatDatabase(home, folder) {
  const source = join(home, 'Library', 'Messages', 'chat.db');
  const copy = join(folder, 'chat.db');
  copyFileSync(source, copy);
  if (existsSync(`${source}-wal`)) copyFileSync(`${source}-wal`, `${copy}-wal`);
  return copy;
}

const defaultOpenDatabase = path => new (process.getBuiltinModule('node:sqlite').DatabaseSync)(path, { readOnly: true });

const defaultSips = argv => new Promise(resolveRun => {
  execFile(SIPS, argv, { timeout: 60000 }, (error, _stdout, stderr) => resolveRun({ code: error ? (error.code ?? 1) : 0, err: String(stderr).trim() }));
});

const refusal = (code, extra = {}) => ({ said: words[code], refused: code, ...extra });

/** Answers one attachment of home's Messages database: { said, attachment, bytes_base64 } or { said, refused, ... }.
 * deps: openDatabase(path) and sips(argv) are injected by the tests; the defaults are node:sqlite and /usr/bin/sips. */
export async function readAttachment(input, { home, openDatabase = defaultOpenDatabase, sips = defaultSips } = {}) {
  const request = parseRequest(input);
  if (request.refusal) return refusal(request.refusal);
  const work = mkdtempSync(join(tmpdir(), 'read-a-message-attachment-'));
  try {
    let copy;
    try {
      copy = copyChatDatabase(home, work);
    } catch {
      return refusal('messages_not_readable');
    }
    let db;
    try {
      db = openDatabase(copy);
    } catch {
      return refusal('messages_not_readable');
    }
    let row;
    try {
      row = db.prepare(`SELECT ROWID AS id, guid, filename, mime_type, transfer_name FROM attachment WHERE ${request.selector.column} = ? LIMIT 1`)
        .get(request.selector.value);
    } finally {
      db.close();
    }
    if (!row) return refusal('not_found');
    if (!row.filename) return refusal('not_on_this_mac');
    const found = attachmentPathOf(row.filename, home);
    if (found.refused) return refusal(found.refused);

    const media = mediaTypeOf(row);
    let file = found.path;
    let type = media;
    if (request.as === 'jpeg') {
      if (!media.startsWith('image/')) return refusal('not_an_image');
      file = join(work, 'picture.jpg');
      const made = await sips(['-s', 'format', 'jpeg', '-Z', String(request.most_px), found.path, '--out', file]);
      if (made.code !== 0 || !existsSync(file)) return refusal('convert_failed');
      type = 'image/jpeg';
    }
    const byteLength = statSync(file).size;
    if (byteLength > MAX_RAW_BYTES) {
      return refusal('too_big', { byte_length: byteLength, limit_bytes: MAX_RAW_BYTES });
    }
    const bytes = readFileSync(file);
    return {
      said: `Read attachment ${row.id} as ${type}, ${bytes.length} bytes.`,
      attachment: { id: row.id, guid: row.guid, media_type: type, byte_length: bytes.length, transfer_name: row.transfer_name, as: request.as },
      bytes_base64: bytes.toString('base64'),
    };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
