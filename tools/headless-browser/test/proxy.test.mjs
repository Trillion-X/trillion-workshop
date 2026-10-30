// A browser started for a run that is told a proxy (HTTPS_PROXY, as the engine tells every internet:true run) loads
// pages only through that proxy, loopback and private addresses included. The proxy here stands in for the engine's:
// it carries one public-looking name (site.example) to a page on this computer and refuses every other address, as
// the engine refuses this computer and private networks. Needs Chromium (Playwright's, from devDependencies).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { openBrowser } from '../devtools.mjs';

const listen = server => new Promise(done => server.listen(0, '127.0.0.1', () => done(server.address().port)));

// Navigate and answer the page's words once it loaded (or after 8 s, for a page the proxy refused).
async function visit(browser, url) {
  let loaded;
  const arrived = new Promise(done => { loaded = done; });
  browser.on(event => { if (event.method === 'Page.loadEventFired') loaded(); });
  await browser.send('Page.navigate', { url });
  await Promise.race([arrived, new Promise(done => setTimeout(done, 8000))]);
  const { result } = await browser.send('Runtime.evaluate', { expression: 'document.body ? document.body.textContent : ""', returnByValue: true });
  return result.value;
}

test('a browser told a proxy loads a page through it and reaches no loopback or private address around it', { timeout: 90000 }, async () => {
  const direct = [];
  const local = createServer((request, answer) => { direct.push(request.url); answer.end('reached this computer directly'); });
  const localPort = await listen(local);
  const site = createServer((_, answer) => answer.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>t</title>Loaded through the proxy'));
  const sitePort = await listen(site);
  const asked = [];
  const proxy = createServer((request, answer) => {
    const url = new URL(request.url);
    asked.push(url.host);
    if (url.hostname !== 'site.example') return answer.writeHead(403, { 'content-type': 'text/plain' }).end('refused by the proxy');
    fetch(`http://127.0.0.1:${sitePort}${url.pathname}`).then(async reply => {
      answer.writeHead(reply.status, { 'content-type': reply.headers.get('content-type') ?? 'text/plain' }).end(await reply.text());
    }, () => answer.writeHead(502).end());
  });
  proxy.on('connect', (request, client) => { asked.push(request.url); client.end('HTTP/1.1 403 Forbidden\r\n\r\n'); });
  const proxyPort = await listen(proxy);
  const before = process.env.HTTPS_PROXY;
  process.env.HTTPS_PROXY = `http://127.0.0.1:${proxyPort}`;
  const browser = await openBrowser(chromium.executablePath(), { width: 800, height: 600 });
  try {
    await browser.send('Page.enable');
    assert.match(await visit(browser, 'http://site.example/'), /Loaded through the proxy/);
    for (const address of [`http://127.0.0.1:${localPort}/`, `http://localhost:${localPort}/`, 'http://10.0.0.1/', 'https://169.254.169.254/latest/meta-data/']) {
      assert.doesNotMatch(await visit(browser, address), /reached this computer directly/, address);
    }
    assert.deepEqual(direct, [], 'nothing reached the page on this computer around the proxy');
    // Each address went to the proxy (the browser's own background calls do too, and are refused there).
    for (const host of ['site.example', `127.0.0.1:${localPort}`, `localhost:${localPort}`, '10.0.0.1', '169.254.169.254:443']) assert.ok(asked.includes(host), host);
  } finally {
    browser.close();
    if (before === undefined) delete process.env.HTTPS_PROXY; else process.env.HTTPS_PROXY = before;
    for (const server of [local, site, proxy]) { server.closeAllConnections(); server.close(); }
  }
});
