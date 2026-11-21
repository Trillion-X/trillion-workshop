// test/read-a-message-attachment.test.mjs
//
// Every file here is made up: a fake home folder with a fixture chat.db (attachment rows only) and fake attachment files.
import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DEFAULT_JPEG_PX, MAX_RAW_BYTES, readAttachment } from '../read-data/attachment-read.mjs';

const ATTACHMENTS = join('Library', 'Messages', 'Attachments');
const PHOTO_BYTES = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);

function makeHome(rows) {
  const home = mkdtempSync(join(tmpdir(), 'attachment-test-home-'));
  mkdirSync(join(home, 'Library', 'Messages', 'Attachments'), { recursive: true });
  const db = new DatabaseSync(join(home, 'Library', 'Messages', 'chat.db'));
  db.exec('CREATE TABLE attachment (ROWID INTEGER PRIMARY KEY, guid TEXT, filename TEXT, mime_type TEXT, transfer_name TEXT, total_bytes INTEGER)');
  const insert = db.prepare('INSERT INTO attachment (ROWID, guid, filename, mime_type, transfer_name, total_bytes) VALUES (?, ?, ?, ?, ?, ?)');
  for (const row of rows) insert.run(row.id, row.guid, row.filename, row.mime_type ?? null, row.transfer_name ?? null, 0);
  db.close();
  return home;
}

function putFile(home, relative, bytes) {
  const path = join(home, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
  return path;
}

const photoRow = {
  id: 7, guid: 'at_0_AAAA-1111', filename: `~/${ATTACHMENTS}/ab/01/at_0_AAAA-1111/IMG_0001.HEIC`, mime_type: 'image/heic', transfer_name: 'IMG_0001.HEIC',
};

test('answers a photo named by row id as its bytes, with its media type and length', async () => {
  const home = makeHome([photoRow]);
  putFile(home, `${ATTACHMENTS}/ab/01/at_0_AAAA-1111/IMG_0001.HEIC`, PHOTO_BYTES);
  const answer = await readAttachment({ attachment: 7 }, { home });
  assert.equal(answer.refused, undefined);
  assert.equal(answer.attachment.media_type, 'image/heic');
  assert.equal(answer.attachment.byte_length, 10);
  assert.equal(answer.attachment.as, 'original');
  assert.deepEqual(Buffer.from(answer.bytes_base64, 'base64'), PHOTO_BYTES);
  rmSync(home, { recursive: true, force: true });
});

test('answers the same photo by guid and by a whole-number string, the extension deciding the media type', async () => {
  const home = makeHome([{ ...photoRow, mime_type: null, filename: `~/${ATTACHMENTS}/ab/01/at_0_AAAA-1111/IMG_0001.jpg` }]);
  putFile(home, `${ATTACHMENTS}/ab/01/at_0_AAAA-1111/IMG_0001.jpg`, PHOTO_BYTES);
  const byGuid = await readAttachment({ attachment: 'at_0_AAAA-1111' }, { home });
  const byText = await readAttachment({ attachment: '7' }, { home });
  assert.equal(byGuid.attachment.id, 7);
  assert.equal(byText.attachment.id, 7);
  assert.equal(byGuid.attachment.media_type, 'image/jpeg', 'no mime type in the row: the extension decides');
  rmSync(home, { recursive: true, force: true });
});

test('refuses a file that the row names outside the attachments folder', async () => {
  const home = makeHome([
    { id: 1, guid: 'g1', filename: '~/../../etc/hosts' },
    { id: 2, guid: 'g2', filename: '/etc/hosts' },
    { id: 3, guid: 'g3', filename: `~/${ATTACHMENTS}/../../Notes/secret.txt` },
    { id: 4, guid: 'g4', filename: 'relative/IMG.jpg' },
  ]);
  putFile(home, 'Notes/secret.txt', Buffer.from('made up'));
  for (const id of [1, 2, 3, 4]) {
    const answer = await readAttachment({ attachment: id }, { home });
    assert.equal(answer.refused, 'outside_attachments', `row ${id}`);
    assert.equal(answer.bytes_base64, undefined);
  }
  rmSync(home, { recursive: true, force: true });
});

test('refuses a symlink inside the attachments folder that leads outside it', async () => {
  const home = makeHome([{ id: 5, guid: 'g5', filename: `~/${ATTACHMENTS}/link/IMG.HEIC`, mime_type: 'image/heic' }]);
  const outside = putFile(home, 'Notes/outside.heic', PHOTO_BYTES);
  mkdirSync(join(home, ATTACHMENTS, 'link'), { recursive: true });
  symlinkSync(outside, join(home, ATTACHMENTS, 'link', 'IMG.HEIC'));
  const answer = await readAttachment({ attachment: 5 }, { home });
  assert.equal(answer.refused, 'outside_attachments');
  rmSync(home, { recursive: true, force: true });
});

test('refuses an unknown row id, and a row whose file is not on this Mac', async () => {
  const home = makeHome([{ id: 9, guid: 'g9', filename: null, mime_type: 'image/jpeg' }, { id: 10, guid: 'g10', filename: `~/${ATTACHMENTS}/gone/IMG.jpg` }]);
  assert.equal((await readAttachment({ attachment: 404 }, { home })).refused, 'not_found');
  assert.equal((await readAttachment({ attachment: 9 }, { home })).refused, 'not_on_this_mac');
  assert.equal((await readAttachment({ attachment: 10 }, { home })).refused, 'not_on_this_mac');
  rmSync(home, { recursive: true, force: true });
});

test('refuses an answer for a file over the one-answer limit, and names the smaller JPEG to ask for', async () => {
  const home = makeHome([{ id: 11, guid: 'g11', filename: `~/${ATTACHMENTS}/big/VIDEO.mov`, mime_type: 'video/quicktime' }]);
  putFile(home, `${ATTACHMENTS}/big/VIDEO.mov`, Buffer.alloc(MAX_RAW_BYTES + 1));
  const answer = await readAttachment({ attachment: 11 }, { home });
  assert.equal(answer.refused, 'too_big');
  assert.equal(answer.byte_length, MAX_RAW_BYTES + 1);
  assert.equal(answer.limit_bytes, MAX_RAW_BYTES);
  assert.equal(answer.bytes_base64, undefined);
  rmSync(home, { recursive: true, force: true });
});

test('answers a picture as a JPEG that sips made, with sips given argv items and the largest side', async () => {
  const home = makeHome([photoRow]);
  const source = putFile(home, `${ATTACHMENTS}/ab/01/at_0_AAAA-1111/IMG_0001.HEIC`, PHOTO_BYTES);
  const calls = [];
  const sips = async argv => {
    calls.push(argv);
    writeFileSync(argv[argv.indexOf('--out') + 1], JPEG_BYTES);
    return { code: 0, err: '' };
  };
  const answer = await readAttachment({ attachment: 7, as: 'jpeg', most_px: 1600 }, { home, sips });
  assert.equal(answer.attachment.media_type, 'image/jpeg');
  assert.equal(answer.attachment.as, 'jpeg');
  assert.deepEqual(Buffer.from(answer.bytes_base64, 'base64'), JPEG_BYTES);
  assert.deepEqual(calls[0].slice(0, 6), ['-s', 'format', 'jpeg', '-Z', '1600', realpathSync(source)]);
  assert.equal(calls[0][6], '--out');
  rmSync(home, { recursive: true, force: true });
});

test('uses the default largest side when the JPEG request names none', async () => {
  const home = makeHome([photoRow]);
  putFile(home, `${ATTACHMENTS}/ab/01/at_0_AAAA-1111/IMG_0001.HEIC`, PHOTO_BYTES);
  const calls = [];
  const sips = async argv => {
    calls.push(argv);
    writeFileSync(argv[argv.indexOf('--out') + 1], JPEG_BYTES);
    return { code: 0, err: '' };
  };
  await readAttachment({ attachment: 7, as: 'jpeg' }, { home, sips });
  assert.equal(calls[0][calls[0].indexOf('-Z') + 1], String(DEFAULT_JPEG_PX));
  rmSync(home, { recursive: true, force: true });
});

test('refuses a JPEG request for a video, and a JPEG that sips could not make', async () => {
  const home = makeHome([
    { id: 12, guid: 'g12', filename: `~/${ATTACHMENTS}/v/CLIP.mov`, mime_type: 'video/quicktime' },
    photoRow,
  ]);
  putFile(home, `${ATTACHMENTS}/v/CLIP.mov`, PHOTO_BYTES);
  putFile(home, `${ATTACHMENTS}/ab/01/at_0_AAAA-1111/IMG_0001.HEIC`, PHOTO_BYTES);
  const never = async () => { throw new Error('sips must not run for a video'); };
  assert.equal((await readAttachment({ attachment: 12, as: 'jpeg' }, { home, sips: never })).refused, 'not_an_image');
  const failing = async () => ({ code: 1, err: 'made up failure' });
  assert.equal((await readAttachment({ attachment: 7, as: 'jpeg' }, { home, sips: failing })).refused, 'convert_failed');
  rmSync(home, { recursive: true, force: true });
});

test('reads only a copy of chat.db, with its -wal copied beside it, and removes the copy when done', async () => {
  const home = makeHome([photoRow]);
  putFile(home, `${ATTACHMENTS}/ab/01/at_0_AAAA-1111/IMG_0001.HEIC`, PHOTO_BYTES);
  writeFileSync(join(home, 'Library', 'Messages', 'chat.db-wal'), Buffer.from('made up wal'));
  const opened = [];
  const openDatabase = path => {
    opened.push({ path, wal: existsSync(`${path}-wal`) });
    return new DatabaseSync(path, { readOnly: true });
  };
  const answer = await readAttachment({ attachment: 7 }, { home, openDatabase });
  assert.equal(answer.refused, undefined);
  assert.equal(opened.length, 1);
  assert.notEqual(opened[0].path, join(home, 'Library', 'Messages', 'chat.db'));
  assert.equal(opened[0].wal, true);
  assert.equal(existsSync(dirname(opened[0].path)), false, 'the private copy folder is removed');
  rmSync(home, { recursive: true, force: true });
});

test('refuses when the Messages database cannot be read, naming Full Disk Access', async () => {
  const home = mkdtempSync(join(tmpdir(), 'attachment-test-empty-'));
  const answer = await readAttachment({ attachment: 7 }, { home });
  assert.equal(answer.refused, 'messages_not_readable');
  assert.match(answer.said, /Full Disk Access/);
  rmSync(home, { recursive: true, force: true });
});

test('refuses a request that is not a row id, a guid, or valid options, before touching the database', async () => {
  const touched = [];
  const openDatabase = path => { touched.push(path); throw new Error('must not open'); };
  const bad = [
    { attachment: '../../etc/passwd' },
    { attachment: -1 },
    { attachment: 1.5 },
    { attachment: 'a b' },
    { attachment: 7, as: 'png' },
    { attachment: 7, as: 'jpeg', most_px: 10 },
    { attachment: 7, as: 'jpeg', most_px: 99999 },
    null,
    {},
  ];
  for (const input of bad) {
    const answer = await readAttachment(input, { home: '/nonexistent-home', openDatabase });
    assert.ok(['bad_attachment', 'bad_options'].includes(answer.refused), JSON.stringify(input));
  }
  assert.deepEqual(touched, []);
});
