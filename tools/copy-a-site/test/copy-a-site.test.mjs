// The site copier (tools/copy-a-site, tool:copy-a-site in tool-rows.json): every flag the row passes is one the script
// reads, its naming rules, and the script run from its folder as the container runs it from /opt/copy-a-site, on a
// small site (test/site.mjs) whose name resolves nowhere: it is reached only through a proxy named the way the engine
// names its public-only proxy to an internet:true run (HTTP_PROXY, HTTPS_PROXY, NODE_USE_ENV_PROXY), so the copy
// proves that the copier's own fetches and its browser both go through that proxy. Checks that a page keeps what its
// script drew and loses the script, a linked page is kept as a folder index, a picture a style sheet uses is kept,
// every address points at the copy, and another site stays linked. Needs Chromium (Playwright's, from devDependencies).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { assetFile, omittedPages, pageFile, reportedSkipped, rewrite, sitemapPages } from '../do-work/copy-a-site.mjs';
import { pages } from './site.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [tool] = JSON.parse(readFileSync(resolve(root, 'tool-rows.json'), 'utf8')).records.map(record => record.payload);
const HOST = 'copy-a-site.example';

// The site, on this computer, and a proxy in front of it that carries only the site's name: a tunnel (CONNECT, as
// Node's fetch asks a proxy) or a request written with its whole address (as a browser asks one). `asked` lists each
// path the site answered and how it came: `tunnel` or `proxied`.
async function withProxy(run) {
  const asked = [];
  const site = createServer((request, answer) => {
    const path = new URL(request.url, 'http://x').pathname;
    asked.push({ path, via: request.headers['x-came'] ?? 'tunnel' });
    const page = pages[path];
    if (!page) return answer.writeHead(404).end();
    const body = page.type === 'application/xml' ? page.body.replaceAll(`https://${HOST}/`, `http://${HOST}/`) : page.body;
    answer.writeHead(200, { 'content-type': page.type }).end(body);
  });
  await new Promise(done => site.listen(0, '127.0.0.1', done));
  const sitePort = site.address().port;
  const proxy = createServer((request, answer) => {
    let url;
    try { url = new URL(request.url); } catch { return answer.writeHead(403).end('only whole addresses'); }
    if (url.hostname !== HOST) return answer.writeHead(403).end('not this site');
    const onward = httpRequest({ host: '127.0.0.1', port: sitePort, path: url.pathname + url.search, method: request.method,
      headers: { ...request.headers, 'x-came': 'proxied' } }, reply => { answer.writeHead(reply.statusCode, reply.headers); reply.pipe(answer); });
    request.pipe(onward);
  });
  proxy.on('connect', (request, client, head) => {
    if (request.url.split(':')[0] !== HOST) return client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    const server = connect(sitePort, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      server.write(head);
      server.pipe(client);
      client.pipe(server);
    });
    server.on('error', () => client.destroy());
    client.on('error', () => server.destroy());
  });
  await new Promise(done => proxy.listen(0, '127.0.0.1', done));
  try { return await run(`http://127.0.0.1:${proxy.address().port}`, asked); } finally { proxy.closeAllConnections(); proxy.close(); site.closeAllConnections(); site.close(); }
}

// The script with each input field as its --flag (a list as JSON), the output folder, and the proxy settings.
async function runTool(input, out, proxy) {
  const flags = Object.entries(input).flatMap(([name, value]) => [`--${name.replaceAll('_', '-')}`, typeof value === 'object' ? JSON.stringify(value) : String(value)]);
  const reach = { HTTP_PROXY: proxy, HTTPS_PROXY: proxy, http_proxy: proxy, https_proxy: proxy, NO_PROXY: '127.0.0.1,localhost,::1',
    no_proxy: '127.0.0.1,localhost,::1', NODE_USE_ENV_PROXY: '1' };
  const child = spawn(process.execPath, ['do-work/copy-a-site.mjs', ...flags, '--out', out], { cwd: root,
    env: { ...process.env, ...reach, BROWSER_EXECUTABLE: chromium.executablePath() } });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const status = await new Promise(done => child.on('close', done));
  return { status, stdout, stderr };
}

test('every flag the row passes is one the script reads, and the row packs no address code', () => {
  const script = readFileSync(resolve(root, 'do-work/copy-a-site.mjs'), 'utf8');
  for (const flag of tool.invoke.argv.filter(part => typeof part === 'string' && part.startsWith('--'))) {
    assert.ok(script.includes(`args['${flag.slice(2)}']`) || script.includes(`args.${flag.slice(2)}`), `the script reads ${flag}`);
  }
  assert.equal(tool.invoke.internet, true);
  assert.deepEqual(tool.invoke.files.package_files.map(item => item.package), ['copy-a-site', 'headless-browser']);
});

test('page and asset addresses become files the host serves', () => {
  assert.equal(pageFile('/'), 'index.html');
  assert.equal(pageFile('/guides/first'), 'guides/first/index.html');
  assert.equal(pageFile('/about.html'), 'about.html');
  assert.equal(assetFile(new URL('https://x.example/media/photo'), 'image/jpeg'), 'media/photo.jpg');
  assert.equal(assetFile(new URL('https://x.example/p/a.png?w=400'), 'image/png'), 'p/a-w-400.png');
});

test('a live site copies through the proxy: drawn words kept, scripts gone, links and pictures point at the copy', { timeout: 120000 }, async () => {
  const out = mkdtempSync(join(tmpdir(), 'copy-a-site-test-'));
  try {
    await withProxy(async (proxy, asked) => {
      const origin = `http://${HOST}`;
      const { status, stdout, stderr } = await runTool({ url: `${origin}/`, max_pages: 10 }, out, proxy);
      assert.equal(status, 0, stderr);
      const result = JSON.parse(stdout.trim().split('\n').at(-1));
      assert.deepEqual(result.pages.sort(), ['/', '/guides/first', '/listed-only']);
      const { files } = JSON.parse(readFileSync(join(out, 'site.json'), 'utf8'));
      assert.deepEqual(Object.keys(files).sort(), ['favicon.ico', 'guides/first/index.html', 'index.html', 'listed-only/index.html', 'look/site.css', 'pictures/ball.png', 'pictures/court.png']);
      assert.match(files['favicon.ico'], /^data:image\/x-icon;base64,/);
      assert.match(files['listed-only/index.html'], /Only in the sitemap/);
      assert.match(files['index.html'], /Drawn by the page/);
      assert.doesNotMatch(files['index.html'], /<script|onclick|app\.js/);
      assert.match(files['index.html'], /href="\/guides\/first"/);
      assert.match(files['index.html'], /https:\/\/elsewhere\.example\//);
      assert.match(files['index.html'], /data-site-copy-original=""/);
      assert.ok(files['index.html'].includes(`href="${origin}/"`));
      assert.match(files['index.html'], /Ask on the original site/);
      assert.match(files['index.html'], /Choose on the original site/);
      assert.doesNotMatch(files['index.html'], /<form|<button|<input/);
      assert.match(files['look/site.css'], /url\('\/pictures\/ball\.png'\)/);
      assert.match(files['pictures/court.png'], /^data:image\/png;base64,/);
      // The site's name resolves nowhere, so everything came through the proxy: the copier's own fetches (the sitemap,
      // page heads, files) as tunnels, and the browser's page loads written with their whole address.
      const came = path => new Set(asked.filter(item => item.path === path).map(item => item.via));
      for (const path of ['/sitemap.xml', '/look/site.css', '/pictures/ball.png']) assert.ok(came(path).has('tunnel'), `${path} came through a tunnel`);
      for (const path of ['/', '/app.js']) assert.ok(came(path).has('proxied'), `the browser asked ${path} through the proxy`);
    });
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test('a start address that is not a web address is refused before anything is asked', async () => {
  const out = mkdtempSync(join(tmpdir(), 'copy-a-site-test-'));
  try {
    for (const url of ['file:///etc/passwd', 'https://user:pass@example.com/', 'not an address']) {
      const { status, stderr } = await runTool({ url }, out, 'http://127.0.0.1:9');
      assert.equal(status, 1);
      assert.match(stderr, /web address/);
    }
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test('a sitemap index admits only bounded same-origin pages', async () => {
  const origin = 'https://site.example';
  const documents = new Map([
    [`${origin}/sitemap.xml`, '<sitemapindex><sitemap><loc>https://site.example/pages.xml</loc></sitemap><sitemap><loc>https://other.example/pages.xml</loc></sitemap></sitemapindex>'],
    [`${origin}/pages.xml`, '<urlset><url><loc>https://site.example/pricing</loc></url><url><loc>https://site.example/draft?from=sitemap</loc></url><url><loc>https://other.example/private</loc></url></urlset>'],
  ]);
  const paths = await sitemapPages(origin, async address => new Response(documents.get(address) ?? '', {
    status: documents.has(address) ? 200 : 404,
    headers: { 'content-type': 'application/xml' },
  }));
  assert.deepEqual(paths, ['/pricing']);
});

test('a page cap reports unvisited routes and keeps their links on the original site', () => {
  const origin = 'https://source.example';
  const skipped = omittedPages(['/guides/first', '/guides/first', '/already'], new Set(['/already']), origin, 1);
  assert.deepEqual(skipped, [{ address: origin + '/guides/first',
    reason: 'not copied because the 1-page limit was reached; its link stays on the original site' }]);
  const html = '<a href="/guides/first">Uncopied</a><a href="/already">Copied</a><img src="/missing.png">';
  const result = rewrite(html, origin, path => path === '/already' ? '/already' : null);
  assert.ok(result.includes('href="' + origin + '/guides/first"'));
  assert.ok(result.includes('href="/already"'));
  assert.ok(result.includes('src="' + origin + '/missing.png"'));
});

test('many omitted routes stay within the findings limit without claiming they were copied', () => {
  const rows = Array.from({ length: 102 }, (_, index) => ({ address: 'https://source.example/' + index, reason: 'not copied' }));
  const result = reportedSkipped(rows, 'https://source.example');
  assert.equal(result.length, 100);
  assert.equal(result.at(-1).address, 'https://source.example');
  assert.match(result.at(-1).reason, /^3 more pages or files were not copied/);
});
