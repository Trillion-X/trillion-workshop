// One public link read whole (tool:read-a-link, do-work/read_a_link.mjs over do-work/page-facts.mjs): its card, every
// picture and video it declares in its tags and structured data, the structured data itself, and a link that is itself
// a picture or a video.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { extractPage, fileFacts } from '../do-work/page-facts.mjs';
import { readLinkCard, ReadLinkError } from '../do-work/read_a_link.mjs';

const page = `<html><head>
<title>Plain title</title>
<meta property="og:title" content="Lemon &amp; thyme cake">
<meta property="og:site_name" content="Kitchen">
<meta name="description" content="A cake for spring">
<meta property="og:image" content="/pictures/one.jpg">
<meta property="og:image" content="https://cdn.test/two.jpg">
<meta name="twitter:image" content="/pictures/one.jpg">
<meta property="og:image" content="javascript:alert(1)">
<meta property="og:video" content="https://cdn.test/clip.mp4">
<link rel="shortcut icon" href="/favicon.ico">
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[
  {"@type":"Recipe","name":"Lemon cake","recipeYield":"8","image":{"url":"https://cdn.test/recipe.jpg"}},
  {"@type":"VideoObject","contentUrl":"https://cdn.test/how-to.mp4","thumbnailUrl":["https://cdn.test/thumb.jpg"]}
]}</script>
<script type="application/ld+json">{ not json }</script>
<script>var hidden = 1;</script>
</head><body><h1>Lemon cake</h1><p>Mix and bake.</p></body></html>`;

test('a page gives every picture and video it declares, its structured data and its card', () => {
  const read = extractPage(page, new URL('https://kitchen.test/cake'));
  assert.equal(read.title, 'Lemon & thyme cake');
  assert.equal(read.site, 'Kitchen');
  assert.equal(read.description, 'A cake for spring');
  assert.equal(read.icon, 'https://kitchen.test/favicon.ico');
  assert.deepEqual(read.images, ['https://kitchen.test/pictures/one.jpg', 'https://cdn.test/two.jpg', 'https://cdn.test/recipe.jpg', 'https://cdn.test/thumb.jpg']);
  assert.equal(read.image, 'https://kitchen.test/pictures/one.jpg');
  assert.deepEqual(read.videos, ['https://cdn.test/clip.mp4', 'https://cdn.test/how-to.mp4']);
  assert.deepEqual(read.data.map(item => item['@type']), ['Recipe', 'VideoObject']);
  assert.equal(read.data[0].recipeYield, '8');
  assert.equal(read.text, 'Lemon cake\nMix and bake.');
});

test('a page that declares nothing has empty lists, never a guess', () => {
  const read = extractPage('<html><head><title>Bare</title></head><body>Words</body></html>', new URL('https://bare.test/'));
  assert.deepEqual([read.image, read.images, read.videos, read.data], [null, [], [], []]);
  assert.deepEqual(extractPage('just text', new URL('https://bare.test/'), true).images, []);
});

test('a link that is itself a picture or a video is that picture or video', () => {
  assert.deepEqual(fileFacts('https://cdn.test/a.png', 'image/png'), { images: ['https://cdn.test/a.png'], videos: [] });
  assert.deepEqual(fileFacts('https://cdn.test/a.mp4', 'video/mp4'), { images: [], videos: ['https://cdn.test/a.mp4'] });
  assert.deepEqual(fileFacts('https://cdn.test/a.zip', 'application/zip'), { images: [], videos: [] });
});

// A fetch that answers one page, as Node's fetch would.
const answering = (body, contentType, url) => async () => {
  const response = new Response(body, { headers: { 'content-type': contentType } });
  Object.defineProperty(response, 'url', { value: url });
  return response;
};

test('readLinkCard reads a page whole, a picture link as its picture, and says why a link has no card', async () => {
  const card = await readLinkCard('https://kitchen.test/cake', { fetchPage: answering(page, 'text/html; charset=utf-8', 'https://kitchen.test/cake') });
  assert.equal(card.title, 'Lemon & thyme cake');
  assert.equal(card.images.length, 4);
  assert.equal(card.videos.length, 2);
  assert.equal(card.data.length, 2);
  assert.equal(card.unread, null);

  const picture = await readLinkCard('https://cdn.test/photo.jpg', { fetchPage: answering('bytes', 'image/jpeg', 'https://cdn.test/photo.jpg') });
  assert.deepEqual([picture.image, picture.images, picture.unread], ['https://cdn.test/photo.jpg', ['https://cdn.test/photo.jpg'], null]);

  const file = await readLinkCard('https://cdn.test/archive.zip', { fetchPage: answering('bytes', 'application/zip', 'https://cdn.test/archive.zip') });
  assert.equal(file.unread, 'This link is a file, not a page.');
  assert.deepEqual([file.images, file.videos, file.data], [[], [], []]);

  const silent = await readLinkCard('https://down.test/', { fetchPage: async () => { throw new Error('no answer'); } });
  assert.equal(silent.unread, 'The page did not answer.');
});

test('readLinkCard refuses an address that is not a public web page before fetching', async () => {
  let fetched = false;
  const fetchPage = async () => { fetched = true; return new Response(''); };
  for (const address of ['file:///etc/passwd', 'https://user:pass@site.test/', 'https://site.test:8443/']) {
    await assert.rejects(readLinkCard(address, { fetchPage }), ReadLinkError, address);
  }
  assert.equal(fetched, false);
});

test('readLinkCard slices overlong chunks at the byte cap and reports the partial page', async () => {
  const prefix = '<html><head><title>Useful prefix</title></head><body>';
  const content = new TextEncoder().encode(prefix + 'x'.repeat(2_000_000) + 'BEYOND_LIMIT');
  const response = new Response(new ReadableStream({ start(controller) { controller.enqueue(content); controller.close(); } }), { headers: { 'content-type': 'text/html' } });
  Object.defineProperty(response, 'url', { value: 'https://long.test/' });
  const card = await readLinkCard('https://long.test/', { fetchPage: async () => response });
  assert.equal(card.title, 'Useful prefix', 'the useful prefix survives the cap');
  assert.equal(card.unread, 'The page reached the read limit before it ended.');
  assert.equal(card.text.includes('BEYOND_LIMIT'), false, 'bytes beyond the cap never reach the extractor');
});

test('readLinkCard detects a tail after an exact-limit chunk and reports a body failure after useful text', async () => {
  const exactPrefix = '<html><head><title>Useful prefix</title></head><body>';
  const first = new TextEncoder().encode(exactPrefix + 'x'.repeat(2_000_000 - exactPrefix.length));
  const response = new Response(new ReadableStream({
    start(controller) { controller.enqueue(first); controller.enqueue(new TextEncoder().encode('TAIL_MARKER')); controller.close(); },
  }), { headers: { 'content-type': 'text/html' } });
  Object.defineProperty(response, 'url', { value: 'https://tail.test/' });
  const tailed = await readLinkCard('https://tail.test/', { fetchPage: async () => response });
  assert.equal(tailed.title, 'Useful prefix');
  assert.equal(tailed.unread, 'The page reached the read limit before it ended.');
  assert.equal(tailed.text.includes('TAIL_MARKER'), false);

  const broken = new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('<html><head><title>Still useful</title></head><body>Prefix')); },
    pull(controller) { controller.error(new Error('Synthetic stream failure')); },
  }), { headers: { 'content-type': 'text/html' } });
  Object.defineProperty(broken, 'url', { value: 'https://broken.test/' });
  const partial = await readLinkCard('https://broken.test/', { fetchPage: async () => broken });
  assert.equal(partial.title, 'Still useful');
  assert.equal(partial.unread, 'The page stopped before it finished.');
});

test('readLinkCard applies its deadline while the response body is still arriving', async () => {
  const response = new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('<html><head><title>Still useful</title></head><body>Prefix')); },
  }), { headers: { 'content-type': 'text/html' } });
  Object.defineProperty(response, 'url', { value: 'https://slow.test/' });
  const partial = await readLinkCard('https://slow.test/', { fetchPage: async () => response, waitMs: 25 });
  assert.equal(partial.title, 'Still useful');
  assert.equal(partial.unread, 'The page took too long to finish reading.');
});

test('readLinkCard treats an exact-cap EOF as complete', async () => {
  const prefix = '<html><head><title>Complete page</title></head><body>';
  const content = new TextEncoder().encode(prefix + 'x'.repeat(2_000_000 - prefix.length));
  const response = new Response(new ReadableStream({ start(controller) { controller.enqueue(content); controller.close(); } }), { headers: { 'content-type': 'text/html' } });
  Object.defineProperty(response, 'url', { value: 'https://exact.test/' });
  const card = await readLinkCard('https://exact.test/', { fetchPage: async () => response });
  assert.equal(card.title, 'Complete page');
  assert.equal(card.unread, null, 'the byte cap alone does not mean the page was cut off');
});

test('readLinkCard reports the body deadline when abort rejects the stream first', async () => {
  let bodyController;
  const fetchPage = async (_url, { signal }) => {
    const response = new Response(new ReadableStream({
      start(controller) {
        bodyController = controller;
        controller.enqueue(new TextEncoder().encode('<html><head><title>Useful before abort</title></head><body>Prefix'));
        signal.addEventListener('abort', () => {
          try { controller.error(new DOMException('The operation was aborted.', 'AbortError')); } catch {}
        }, { once: true });
      },
    }), { headers: { 'content-type': 'text/html' } });
    Object.defineProperty(response, 'url', { value: 'https://abort.test/' });
    return response;
  };
  const partial = await readLinkCard('https://abort.test/', { fetchPage, waitMs: 25 });
  assert.ok(bodyController);
  assert.equal(partial.title, 'Useful before abort');
  assert.equal(partial.unread, 'The page took too long to finish reading.');
});

// The row as the container runs it: { url } on standard input, one JSON line out. Which addresses are public is the
// engine's proxy's to judge, so these runs ask nothing of the network.
const script = fileURLToPath(new URL('../do-work/read_a_link.mjs', import.meta.url));
const [row] = JSON.parse(readFileSync(new URL('../tool-rows.json', import.meta.url), 'utf8')).records
  .map(record => record.payload).filter(payload => payload.id === 'tool:read-a-link');

test('the row runs the link reader in an internet container and packs the one page reader with it', () => {
  assert.equal(row.invoke.kind, 'container');
  assert.equal(row.invoke.internet, true);
  assert.equal(row.result_selector, '$.result');
  assert.deepEqual(row.invoke.argv, ['/usr/local/bin/node', '/opt/browse-public-page/do-work/read_a_link.mjs']);
  assert.deepEqual(row.invoke.files.package_files.paths, ['do-work/read_a_link.mjs', 'do-work/page-facts.mjs', 'do-work/page-conventions.json']);
});

test('the container tool answers an address that is not a web page with why, before reading anything', () => {
  for (const [url, said] of [['file:///etc/passwd', /HTTP and HTTPS/], ['https://user:pass@site.test/', /username or password/]]) {
    const ran = spawnSync(process.execPath, [script], { input: JSON.stringify({ url }), encoding: 'utf8', timeout: 5000 });
    assert.equal(ran.status, 2);
    assert.match(JSON.parse(ran.stdout).error, said);
  }
});
