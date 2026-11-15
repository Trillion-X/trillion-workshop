// A real Chromium run through the installed-browser chooser, launcher and proxy on a deterministic local site.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

test('installed Chromium lists media through the supplied proxy', { timeout: 180000 }, async () => {
  const site = createServer((request, answer) => {
    const url = new URL(request.url);
    if (url.hostname !== 'media-smoke.example') return answer.writeHead(403).end();
    if (url.pathname === '/') return answer.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><html><body><video src="/clip.mp4" muted></video></body></html>');
    if (url.pathname === '/clip.mp4') return answer.writeHead(200, { 'content-type': 'video/mp4' }).end(Buffer.alloc(64));
    answer.writeHead(404).end();
  });
  site.on('connect', (_request, socket) => socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'));
  await new Promise(done => site.listen(0, '127.0.0.1', done));
  const env = { ...process.env, HTTPS_PROXY: `http://127.0.0.1:${site.address().port}` };
  delete env.BROWSER_EXECUTABLE;
  const child = spawn(process.execPath, [resolve(import.meta.dirname, '../do-work/list-the-videos-a-site-plays.mjs'), 'http://media-smoke.example/'], { env });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const deadline = setTimeout(() => child.kill('SIGTERM'), 170000);
  try {
    const status = await new Promise((done, reject) => { child.once('close', done); child.once('error', reject); });
    assert.equal(status, 0, stderr);
    assert.deepEqual(JSON.parse(stdout).result, { origin: 'http://media-smoke.example', pages: ['http://media-smoke.example/'], videos: ['http://media-smoke.example/clip.mp4'], remaining_pages: [] });
  } finally {
    clearTimeout(deadline);
    site.closeAllConnections();
    await new Promise(done => site.close(done));
  }
});
