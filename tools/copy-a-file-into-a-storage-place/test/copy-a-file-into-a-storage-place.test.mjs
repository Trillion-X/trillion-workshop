// The copy into a storage place over a made-up place and source (no network): a folder the account may not add to is refused in
// words and nothing is opened; a copy opens one upload and sends every piece by range, one piece in memory; a source that answers
// short, or a place that refuses a piece, ends the copy with its words; both connection kinds send the credential only where they
// may. Synthetic data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyAFileIntoAStoragePlace, makePlaceRequest } from '../do-work/copy-a-file-into-a-storage-place.mjs';

const SESSION = 'https://upload.example.test/session/abc';
const SOURCE = 'https://files.example.test/share/id/key';
const bytes = Buffer.from(Array.from({ length: 700000 }, (_, n) => n % 251));

/** A place and a source in memory: `mayAdd` is the folder's answer, `refuseAt` the piece number the place refuses. */
function world({ mayAdd = true, refuseAt = 0, shortAt = -1 } = {}) {
  const asked = [], received = [];
  const request = async call => {
    asked.push(call);
    if (call.method === 'GET') return { status: 200, headers: {}, data: { name: 'Clips for Ana', capabilities: { canAddChildren: mayAdd } } };
    return { status: 200, headers: { location: SESSION }, data: '' };
  };
  const send = async (url, options = {}) => {
    if (String(url) === SOURCE) {
      const [from, to] = options.headers.Range.replace('bytes=', '').split('-').map(Number);
      const piece = bytes.subarray(from, from === shortAt ? to : to + 1);
      return new Response(piece, { status: 206 });
    }
    assert.equal(String(url), SESSION);
    received.push({ range: options.headers['Content-Range'], body: Buffer.from(options.body) });
    if (received.length === refuseAt) return new Response('{"error":"quota"}', { status: 403 });
    const last = options.headers['Content-Range'].endsWith(`-${bytes.length - 1}/${bytes.length}`);
    return last ? new Response('{"id":"new-file-id"}', { status: 200 }) : new Response('', { status: 308 });
  };
  return { asked, received, request, send };
}

const input = { from: { url: SOURCE, byte_length: bytes.length }, to: { place: 'google-drive', folder: 'f1', name: 'clip.mp4', media_type: 'video/mp4' }, piece_bytes: 262144 };

test('a copy opens one upload and sends every piece by range until the place answers the new file', async () => {
  const w = world();
  const answer = await copyAFileIntoAStoragePlace(input, null, w);
  assert.deepEqual([answer.copied, answer.id, answer.pieces, answer.folder], [true, 'new-file-id', 3, 'Clips for Ana']);
  assert.deepEqual(w.received.map(piece => piece.range), ['bytes 0-262143/700000', 'bytes 262144-524287/700000', 'bytes 524288-699999/700000']);
  assert.ok(Buffer.concat(w.received.map(piece => piece.body)).equals(bytes), 'the place received the file byte for byte');
  assert.equal(w.asked[1].headers['X-Upload-Content-Length'], '700000');
  assert.deepEqual(w.asked[1].body, { name: 'clip.mp4', parents: ['f1'] });
  assert.ok(!JSON.stringify(answer).includes(SESSION), 'the session address is never answered');
});

test('a folder the account may not add to is refused in words and nothing is opened or sent', async () => {
  const w = world({ mayAdd: false });
  const answer = await copyAFileIntoAStoragePlace(input, null, w);
  assert.equal(answer.copied, false);
  assert.match(answer.said, /You may not add files to "Clips for Ana" in Google Drive/);
  assert.deepEqual([w.asked.length, w.received.length], [1, 0]);
});

test('a source that answers short, or a refused piece, ends the copy with its words', async () => {
  const short = await copyAFileIntoAStoragePlace(input, null, world({ shortAt: 262144 }));
  assert.match(short.said, /stopped answering at byte 262144/);
  const refused = await copyAFileIntoAStoragePlace(input, null, world({ refuseAt: 2 }));
  assert.deepEqual([refused.copied, refused.pieces], [false, 2]);
  assert.match(refused.said, /refused piece 2 \(403\): \{"error":"quota"\}/);
});

test('what is not a copy is refused before anything is sent', async () => {
  const w = world();
  await assert.rejects(copyAFileIntoAStoragePlace({ ...input, to: { ...input.to, place: 'a-place-no-one-described' } }, null, w), /is not described/);
  await assert.rejects(copyAFileIntoAStoragePlace({ ...input, from: { url: 'http://plain.example.test/x', byte_length: 5 } }, null, w), /https address/);
  await assert.rejects(copyAFileIntoAStoragePlace({ ...input, to: { ...input.to, folder: '' } }, null, w), /folder/);
  assert.equal(w.asked.length, 0);
});

test('each connection kind sends its credential only where it may', async () => {
  const sent = [];
  const send = async (url, options) => { sent.push({ url: String(url), options }); return new Response(JSON.stringify({ status: 200, headers: { Location: SESSION }, data: '' }), { status: 200 }); };
  const viaComposio = makePlaceRequest({ connection: { kind: 'composio', account: 'ca_1' }, read: () => 'composio-key\n', send });
  const answer = await viaComposio({ method: 'POST', url: 'https://www.googleapis.com/upload/drive/v3/files', query: { uploadType: 'resumable' }, headers: { 'X-Upload-Content-Length': '5' }, body: { name: 'x' } });
  assert.equal(answer.headers.location, SESSION, 'header names are read without regard to case');
  assert.equal(sent[0].url, 'https://backend.composio.dev/api/v3/tools/execute/proxy');
  assert.equal(sent[0].options.headers['x-api-key'], 'composio-key');
  assert.deepEqual(JSON.parse(sent[0].options.body).parameters, [{ name: 'uploadType', value: 'resumable', type: 'query' }, { name: 'X-Upload-Content-Length', value: '5', type: 'header' }]);
  const bearer = makePlaceRequest({ connection: { kind: 'bearer' }, read: () => 'token', send: async (url, options) => { sent.push({ url: String(url), options }); return new Response('{}', { status: 200 }); } });
  await bearer({ method: 'GET', url: 'https://www.googleapis.com/drive/v3/files/f1', query: { fields: 'name' } });
  assert.equal(sent[1].options.headers.Authorization, 'Bearer token');
  await assert.rejects(bearer({ method: 'GET', url: 'http://www.googleapis.com/x' }), /only over https/);
  assert.throws(() => makePlaceRequest({ connection: { kind: 'composio' } }), /connected account id/);
  assert.throws(() => makePlaceRequest({ connection: null }), /Name the account's connection/);
});
