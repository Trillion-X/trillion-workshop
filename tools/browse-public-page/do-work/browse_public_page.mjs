// Read one public page. DNS is checked before each request and the checked address is pinned to its socket; what the
// page says (title, text, links and its own card) is read by the one page reader, ./page-facts.mjs.
import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { checkedUrl, extractPage } from './page-facts.mjs';

const MAX_BYTES = 2_000_000;
const blocked = new net.BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24],
  ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) blocked.addSubnet(network, prefix, 'ipv4');
for (const [network, prefix] of [
  ['::', 128], ['::1', 128], ['64:ff9b::', 96],
  ['100::', 64], ['2001::', 23], ['2001:db8::', 32], ['2002::', 16],
  ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
]) blocked.addSubnet(network, prefix, 'ipv6');

export function publicAddress(address) {
  const family = net.isIP(address);
  return family !== 0 && !/^::ffff:/i.test(address) && !blocked.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

async function fetchPinned(url) {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const answers = net.isIP(host) ? [{ address: host, family: net.isIP(host) }] : await dns.lookup(host, { all: true, verbatim: true });
  if (!answers.length || answers.some(answer => !publicAddress(answer.address))) throw new Error('The page address resolves to a non-public network address.');
  const chosen = answers.sort((a, b) => a.family - b.family)[0];
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    const request = transport.request(url, {
      method: 'GET',
      lookup: (_hostname, options, callback) => options.all ? callback(null, [chosen]) : callback(null, chosen.address, chosen.family),
      headers: { Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9', 'Accept-Encoding': 'identity', 'User-Agent': 'TrillionPublicPageReader/1.0', Connection: 'close' },
    }, response => {
      const chunks = [];
      let size = 0;
      if (Number(response.headers['content-length']) > MAX_BYTES) { request.destroy(); reject(new Error('The page is larger than the 2 MB limit.')); return; }
      response.on('data', chunk => {
        size += chunk.length;
        if (size > MAX_BYTES) { request.destroy(); reject(new Error('The page is larger than the 2 MB limit.')); }
        else chunks.push(chunk);
      });
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
      response.on('error', reject);
    });
    request.setTimeout(12_000, () => request.destroy(new Error('The public page could not be read.')));
    request.on('error', reject);
    request.end();
  });
}

export async function readPublicPage(input, fetchPage = fetchPinned) {
  let current = checkedUrl(input);
  for (let redirects = 0; redirects <= 5; redirects++) {
    const response = await fetchPage(current);
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (!response.headers.location) throw new Error('The page returned a redirect without a destination.');
      if (redirects === 5) throw new Error('The page redirected too many times.');
      const next = checkedUrl(new URL(response.headers.location, current).href);
      if (current.protocol === 'https:' && next.protocol === 'http:') throw new Error('HTTPS pages cannot redirect to an unencrypted HTTP page.');
      current = next;
      continue;
    }
    if (response.status < 200 || response.status >= 300) throw new Error(`The page returned HTTP ${response.status}.`);
    const contentType = response.headers['content-type'] ?? 'text/html';
    const media = contentType.split(';')[0].trim().toLowerCase();
    if (!['text/html', 'application/xhtml+xml', 'text/plain'].includes(media)) throw new Error('The address did not return an HTML or plain-text page.');
    if (!['', 'identity'].includes((response.headers['content-encoding'] ?? '').toLowerCase())) throw new Error('The page used an unsupported compressed response.');
    if (response.body.length > MAX_BYTES) throw new Error('The page is larger than the 2 MB limit.');
    const charset = /charset\s*=\s*["']?([a-z0-9._-]+)/i.exec(contentType)?.[1] ?? 'utf-8';
    let decoder;
    try { decoder = new TextDecoder(charset, { fatal: false }); } catch { decoder = new TextDecoder(); }
    return { url: input, final_url: current.href, status: response.status, ...extractPage(decoder.decode(response.body), current, media === 'text/plain') };
  }
  throw new Error('The page redirected too many times.');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const input = JSON.parse(readFileSync(0, 'utf8'));
    process.stdout.write(JSON.stringify(await readPublicPage(input.url)) + '\n');
  } catch (error) {
    process.stdout.write(JSON.stringify({ error: error.message }) + '\n');
    process.exitCode = 2;
  }
}
