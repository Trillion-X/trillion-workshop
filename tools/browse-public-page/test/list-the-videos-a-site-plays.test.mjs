// The site video lister (tool:list-the-videos-a-site-plays in tool-rows.json, do-work/list-the-videos-a-site-plays.mjs):
// every flag the row passes is one the script reads, which addresses count as videos, and the script run from its
// folder on a small made-up site whose name resolves nowhere, reached only through a proxy named the way the engine
// names its public-only proxy to an internet:true run (HTTPS_PROXY). Checks that a video inside a link keeps that link
// and its words, a video fetched only once the page is scrolled and one fetched only once it is played are listed, a
// page reached only through paths is visited, a player frame is listed and a frame that is no player is not.
// Needs Chromium (Playwright's, from devDependencies).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { isPagePath, noteVideo, videoAddress } from '../do-work/list-the-videos-a-site-plays.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tool = JSON.parse(readFileSync(resolve(root, 'tool-rows.json'), 'utf8')).records.map(record => record.payload)
  .find(row => row.id === 'tool:list-the-videos-a-site-plays');
const HOST = 'films.example';

const page = body => ({ type: 'text/html', body: `<!doctype html><html><body>${body}</body></html>` });
const clip = { type: 'video/mp4', body: Buffer.alloc(64) };
const pages = {
  '/': page(`<a href="https://elsewhere.example/post/1"><video src="/media/first.mp4" muted></video> First post</a>
    <a href="/more">More films</a> <iframe src="https://www.youtube.com/embed/made-up"></iframe> <iframe src="/widget"></iframe>
    <div style="height:4000px"></div>
    <script>addEventListener('scroll', () => { if (!window.asked) { window.asked = true; fetch('/media/late.webm'); } });</script>`),
  '/more': page(`<video id="player" muted></video> <a href="/">Home</a> <a href="/media/linked.mp4">Download</a> <a href="/brand/logo.svg">Logo</a>
    <script>document.getElementById('player').addEventListener('play', () => fetch('/stream/played.m3u8?token=one'));</script>`),
  '/hidden': page('<video muted><source src="/media/hidden.mp4" type="video/mp4"></video>'),
  '/widget': page('<p>Not a player</p>'),
  '/media/first.mp4': clip, '/media/late.webm': { type: 'video/webm', body: Buffer.alloc(64) }, '/media/hidden.mp4': clip,
  '/stream/played.m3u8': { type: 'application/vnd.apple.mpegurl', body: '#EXTM3U\n' },
};

// The site on this computer, and a proxy in front of it that carries only the site's name.
async function withProxy(run) {
  const site = createServer((request, answer) => {
    const found = pages[new URL(request.url, 'http://x').pathname];
    if (!found) return answer.writeHead(404).end();
    answer.writeHead(200, { 'content-type': found.type }).end(found.body);
  });
  await new Promise(done => site.listen(0, '127.0.0.1', done));
  const sitePort = site.address().port;
  const proxy = createServer((request, answer) => {
    let url;
    try { url = new URL(request.url); } catch { return answer.writeHead(403).end('only whole addresses'); }
    if (url.hostname !== HOST) return answer.writeHead(403).end('not this site');
    const onward = httpRequest({ host: '127.0.0.1', port: sitePort, path: url.pathname + url.search, method: request.method,
      headers: request.headers }, reply => { answer.writeHead(reply.statusCode, reply.headers); reply.pipe(answer); });
    request.pipe(onward);
  });
  proxy.on('connect', (request, client) => client.end('HTTP/1.1 403 Forbidden\r\n\r\n'));
  await new Promise(done => proxy.listen(0, '127.0.0.1', done));
  try { return await run(`http://127.0.0.1:${proxy.address().port}`); } finally { proxy.closeAllConnections(); proxy.close(); site.closeAllConnections(); site.close(); }
}

async function runTool(input, proxy) {
  const flags = Object.entries(input).flatMap(([name, value]) => [`--${name.replaceAll('_', '-')}`, typeof value === 'object' ? JSON.stringify(value) : String(value)]);
  const child = spawn(process.execPath, ['do-work/list-the-videos-a-site-plays.mjs', ...flags], { cwd: root,
    env: { ...process.env, HTTPS_PROXY: proxy, https_proxy: proxy, HTTP_PROXY: proxy, http_proxy: proxy, BROWSER_EXECUTABLE: chromium.executablePath() } });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const status = await new Promise(done => child.on('close', done));
  return { status, stdout, stderr };
}

test('every flag the row passes is one the script reads, and the row packs the browser part', () => {
  const script = readFileSync(resolve(root, 'do-work/list-the-videos-a-site-plays.mjs'), 'utf8');
  for (const flag of tool.invoke.argv.filter(part => typeof part === 'string' && part.startsWith('--'))) {
    assert.ok(script.includes(`args['${flag.slice(2)}']`) || script.includes(`args.${flag.slice(2)}`), `the script reads ${flag}`);
  }
  assert.equal(tool.invoke.internet, true);
  assert.deepEqual(tool.invoke.files.package_files.map(item => item.package), ['browse-public-page', 'headless-browser']);
});

test('video files, streams and hosted players are videos; a signed stream loses its one-time query', () => {
  assert.equal(videoAddress('https://a.example/clip.mp4?v=2'), 'https://a.example/clip.mp4?v=2');
  assert.equal(videoAddress('https://stream.mux.com/made-up.m3u8?token=abc'), 'https://stream.mux.com/made-up.m3u8');
  assert.equal(videoAddress('https://a.example/stream', 'Media'), 'https://a.example/stream');
  assert.equal(videoAddress('https://www.youtube.com/embed/made-up', 'Document'), 'https://www.youtube.com/embed/made-up');
  assert.equal(videoAddress('https://a.example/picture.png', 'Image'), null);
  assert.equal(videoAddress('data:video/mp4;base64,AAAA', 'Media'), null);
});

test('a video seen twice is one entry with both pages, keeping how it was shown and its link', () => {
  const videos = new Map();
  noteVideo(videos, { address: 'https://a.example/clip.mp4', found: 'requested' }, '/');
  noteVideo(videos, { address: 'https://a.example/clip.mp4', found: 'shown', link: 'https://b.example/post', words: 'A post' }, '/');
  noteVideo(videos, { address: 'https://a.example/clip.mp4', found: 'requested' }, '/more');
  assert.deepEqual([...videos.values()], [{ address: 'https://a.example/clip.mp4', found: 'shown', pages: ['/', '/more'],
    link: 'https://b.example/post', words: 'A post' }]);
});

test('a site\'s videos are listed through the proxy: linked, scrolled into, played, and on a page only paths reaches', { timeout: 120000 }, async () => {
  await withProxy(async proxy => {
    const origin = `http://${HOST}`;
    const { status, stdout, stderr } = await runTool({ url: `${origin}/`, paths: ['/hidden'], scrolls: 2 }, proxy);
    assert.equal(status, 0, stderr);
    const result = JSON.parse(stdout.trim().split('\n').at(-1));
    assert.equal(result.origin, origin);
    assert.deepEqual([...result.pages].sort(), ['/', '/hidden', '/more']);
    const byAddress = Object.fromEntries(result.videos.map(video => [video.address, video]));
    assert.deepEqual(Object.keys(byAddress).sort(), [`${origin}/media/first.mp4`, `${origin}/media/hidden.mp4`, `${origin}/media/late.webm`,
      `${origin}/stream/played.m3u8?token=one`, `${origin}/media/linked.mp4`, 'https://www.youtube.com/embed/made-up'].sort());
    assert.equal(byAddress[`${origin}/media/linked.mp4`].found, 'linked');
    assert.equal(byAddress[`${origin}/media/first.mp4`].link, 'https://elsewhere.example/post/1');
    assert.equal(byAddress[`${origin}/media/first.mp4`].words, 'First post');
    assert.equal(byAddress[`${origin}/media/first.mp4`].found, 'shown');
    assert.equal(byAddress['https://www.youtube.com/embed/made-up'].found, 'frame');
    assert.deepEqual(byAddress[`${origin}/stream/played.m3u8?token=one`].pages, ['/more']);
    assert.deepEqual(byAddress[`${origin}/media/hidden.mp4`].pages, ['/hidden']);
    assert.deepEqual(result.remaining_paths, []);
  });
});

test('a start address that is not a web address, and limits out of range, are refused before anything is asked', async () => {
  for (const [input, words] of [[{ url: 'file:///etc/passwd' }, /web address/], [{ url: 'https://user:pass@example.com/' }, /web address/],
    [{ url: 'https://example.com/', max_pages: 0 }, /max-pages/], [{ url: 'https://example.com/', paths: ['no-slash'] }, /--paths/]]) {
    const { status, stderr } = await runTool(input, 'http://127.0.0.1:9');
    assert.equal(status, 1);
    assert.match(stderr, words);
  }
});

test('a path with a file extension is a file, not a page to visit, unless it is HTML', () => {
  assert.equal(isPagePath('/films/one'), true);
  assert.equal(isPagePath('/about.html'), true);
  assert.equal(isPagePath('/brand/logo.svg'), false);
  assert.equal(isPagePath('/assets/back.webp'), false);
});
