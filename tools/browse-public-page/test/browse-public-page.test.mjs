import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { publicAddress, readPublicPage } from '../do-work/browse_public_page.mjs';
import { checkedUrl, extractPage } from '../do-work/page-facts.mjs';

const script = fileURLToPath(new URL('../do-work/browse_public_page.mjs', import.meta.url));
const toolRecords = JSON.parse(readFileSync(new URL('../tool-rows.json', import.meta.url), 'utf8'));
const run = input => spawnSync('node', [script], { input: JSON.stringify(input), encoding: 'utf8', timeout: 5000 });

test('shared browser tool uses the bundled Node reader in the network-enabled container', () => {
  const row = toolRecords.records[0].payload;
  assert.equal(row.id, 'tool:read-public-web-page');
  assert.equal(row.result_selector, '$.result');
  assert.equal(row.invoke.internet, true);
  assert.deepEqual(row.invoke.argv, ['/usr/local/bin/node', '/opt/browse-public-page/do-work/browse_public_page.mjs']);
  assert.deepEqual(row.invoke.files.package_files.paths, ['do-work/browse_public_page.mjs', 'do-work/page-facts.mjs', 'do-work/page-conventions.json']);
  assert.deepEqual(row.placements, ['placement:small-container']);
});

test('URL and address checks refuse local, private, mapped and reserved targets', () => {
  for (const [url, expected] of [
    ['file:///etc/passwd', /Only public HTTP and HTTPS/],
    ['https://user:pass@example.com/', /cannot include a username or password/],
    ['https://example.com:8443/', /standard HTTP and HTTPS ports/],
  ]) assert.match(JSON.parse(run({ url }).stdout).error, expected);
  for (const address of ['127.0.0.1', '169.254.169.254', '10.0.0.2', '192.168.1.1', '::1', 'fc00::1', '::ffff:127.0.0.1']) assert.equal(publicAddress(address), false, address);
  assert.equal(publicAddress('8.8.8.8'), true);
  assert.equal(publicAddress('2606:4700:4700::1111'), true);
  assert.equal(checkedUrl('https://example.com/').hostname, 'example.com');
});

test('HTML extraction and redirects keep bounded readable output', async () => {
  const html = '<html><head><title>Example &amp; Test</title><script>secret</script></head><body><h1>Hello</h1><p>World &amp; friends</p><a href="/next#part">Next</a></body></html>';
  assert.deepEqual(extractPage(html, 'https://example.com/'), { title: 'Example & Test', text: 'Hello\nWorld & friends\nNext', links: ['https://example.com/next'], description: null, image: null, images: [], videos: [], site: null, icon: null, data: [] });
  const seen = [];
  const result = await readPublicPage('https://example.com/start', async url => {
    seen.push(url.href);
    return seen.length === 1 ? { status: 302, headers: { location: '/next' }, body: Buffer.alloc(0) } : { status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from(html) };
  });
  assert.deepEqual(seen, ['https://example.com/start', 'https://example.com/next']);
  assert.equal(result.title, 'Example & Test');
  assert.equal(result.final_url, 'https://example.com/next');
  await assert.rejects(readPublicPage('https://example.com/', async () => ({ status: 302, headers: { location: 'http://127.0.0.1/' } })), /unencrypted HTTP/);
  await assert.rejects(readPublicPage('https://example.com/', async () => ({ status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.alloc(2_000_001) })), /2 MB limit/);
});
