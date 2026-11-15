import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { createServer as createTLSServer } from 'node:https';
import { once } from 'node:events';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { publicProxy, checkedHost } from '../do-work/renew-a-tls-certificate.mjs';

const host = {
  owner: '/usr/local/lib/example/tls-host-owner.py', state: '/etc/example-public-tls', downloads: '/var/lib/public-downloads',
  ingress: { service: 'example-public-tls', pid_file: '/run/example-public-tls.pid', error_log: '/var/log/nginx/example-error.log' },
  receptionist: { service: 'example-receptionist', account: 'example-mcp', binary_pattern: '/opt/example/[a-f0-9]+/receptionist',
    listen: '127.0.0.1:9443', paths: ['/mcp', '/enroll'], prefixes: ['/accounts/', '/enroll/'], root_cookie: '__Host-browser-address', environment: {} },
};
const input = { hostname: 'app.example.test', address: '192.0.2.34', remotePort: 18789, knownHostsFile: '/private/known-hosts', adminKeyFile: '/private/admin-key', ssh_port: 22, admin_user: 'admin', host };

test('routing DATA refuses injection, root conflicts, broad prefixes and publication overlap', () => {
  const rows = JSON.parse(readFileSync(new URL('../tool-rows.json', import.meta.url)));
  for (const row of rows.records) {
    const properties = row.payload.input_schema.properties.host.properties;
    assert.ok(properties.receptionist.properties.root_cookie);
    assert.ok(properties.receptionist.properties.prefixes);
    assert.ok(properties.ingress.properties.engine_keepalive);
  }
  for (const root_cookie of ['', 'a.b', 'a b', 'a;return', 'a"', '$host', null]) {
    assert.throws(() => checkedHost({ ...host, receptionist: { ...host.receptionist, root_cookie } }), /refused/);
  }
  for (const prefixes of [['/'], ['/download/'], ['/healthz/'], ['/accounts'], ['/a/../'], ['/a//'], ['/a/;'], 'anything']) {
    assert.throws(() => checkedHost({ ...host, receptionist: { ...host.receptionist, prefixes } }), /refused/);
  }
  assert.throws(() => checkedHost({ ...host, receptionist: { ...host.receptionist, paths: ['/'] } }), /refused/);
  assert.throws(() => checkedHost({ ...host, static_files: [{ path: '/accounts/', folder: '/srv/exports', index: 'index.html', exclude: [] }] }), /refused/);
  assert.throws(() => checkedHost({ ...host, site: { hostname: 'example.org', paths: ['/accounts/page'] } }), /refused/);
  for (const remotePort of [0, 65536, '18789;return 200', undefined]) assert.throws(() => publicProxy({ ...input, remotePort }), /refused/);
  for (const engine_keepalive of [null, {}, { connections: 0, timeout_seconds: 1 }, { connections: 1, timeout_seconds: '1s' }, { connections: 1, timeout_seconds: 1, other: true }]) {
    assert.throws(() => checkedHost({ ...host, ingress: { ...host.ingress, engine_keepalive } }), /refused/);
  }
  const { prefixes, root_cookie, ...prior } = host.receptionist;
  const config = publicProxy({ ...input, host: { ...host, receptionist: prior } });
  assert.ok(!config.includes('$root_upstream'));
  assert.ok(config.includes('location / { proxy_pass http://127.0.0.1:18789; }'));
});

test('real nginx dispatches cookie boundaries and declared prefixes through verified TLS without changing requests', async t => {
  const nginx = [process.env.NGINX, '/usr/sbin/nginx', '/opt/homebrew/bin/nginx'].find(path => path && existsSync(path));
  assert.ok(nginx, 'install nginx to run this integration test; the test is never skipped');
  const folder = realpathSync(mkdtempSync(`${tmpdir()}/root-dispatch-`));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const key = `${folder}/test.key`, cert = `${folder}/test.crt`;
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1',
    '-subj', `/CN=${input.hostname}`, '-addext', `subjectAltName=DNS:${input.hostname}`], { stdio: 'ignore' });
  const hits = { engine: [], receptionist: [] };
  const answer = name => async (ask, reply) => {
    let body = ''; for await (const part of ask) body += part;
    hits[name].push({ method: ask.method, url: ask.url, body });
    reply.setHeader('Content-Type', 'application/json'); reply.end(JSON.stringify({ owner: name, method: ask.method, url: ask.url, body }));
  };
  const engine = createServer(answer('engine'));
  const receptionist = createTLSServer({ key: readFileSync(key), cert: readFileSync(cert) }, answer('receptionist'));
  for (const server of [engine, receptionist]) {
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  }
  const reservation = createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  const production = publicProxy({ ...input, remotePort: engine.address().port, host: { ...host,
    ingress: { ...host.ingress, pid_file: `${folder}/nginx.pid`, error_log: `${folder}/error.log`, engine_keepalive: { connections: 4, timeout_seconds: 5 } },
    receptionist: { ...host.receptionist, listen: `127.0.0.1:${receptionist.address().port}` } } });
  const config = production.replace('user www-data;\n', '').replace('listen 443 ssl;', `listen 127.0.0.1:${port};`)
    .replace(/^ ssl_certificate(?:_key)? .*;\n/gm, '').replaceAll('/etc/ssl/certs/ca-certificates.crt', cert);
  const path = `${folder}/nginx.conf`; writeFileSync(path, config);
  const parsed = spawnSync(nginx, ['-t', '-p', folder, '-c', path], { encoding: 'utf8' });
  assert.equal(parsed.status, 0, parsed.stderr);
  const child = spawn(nginx, ['-p', folder, '-c', path, '-g', 'daemon off;'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let errors = ''; child.stderr.on('data', data => { errors += data; });
  t.after(async () => { if (child.exitCode === null) { child.kill('SIGQUIT'); await once(child, 'exit'); } });
  const ask = (target = '/', cookies = [], method = 'GET', body = '') => new Promise((resolve, reject) => {
    const headers = ['Host', input.hostname, ...cookies.flatMap(cookie => ['Cookie', cookie])];
    const call = request({ hostname: '127.0.0.1', port, path: target, method, headers }, response => {
      let text = ''; response.on('data', part => { text += part; });
      response.on('end', () => resolve({ status: response.statusCode, text }));
    });
    call.on('error', reject); call.end(body);
  });
  for (let attempt = 0; ; attempt++) {
    try { await ask('/healthz'); break; } catch (error) {
      if (attempt >= 50 || child.exitCode !== null) throw new Error(`nginx did not start: ${errors}`, { cause: error });
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
  for (const [cookies, owner] of [
    [[], 'receptionist'], [['session=synthetic'], 'engine'], [['__Host-browser-address=valid'], 'receptionist'],
    [['__Host-browser-address='], 'receptionist'], [['__Host-browser-address'], 'receptionist'],
    [['other=x; __Host-browser-address =bad'], 'receptionist'], [['__Host-browser-address=one; __Host-browser-address=two'], 'receptionist'],
    [['other=x', '__Host-browser-address=bad'], 'receptionist'],
    [['x__Host-browser-address=bad'], 'engine'], [['__Host-browser-address-extra=bad'], 'engine'],
    [['other=__Host-browser-address=bad'], 'engine'],
  ]) {
    const response = await ask('/?next=kept', cookies);
    assert.equal(response.status, 200, response.text);
    assert.equal(JSON.parse(response.text).owner, owner, JSON.stringify(cookies));
    assert.equal(JSON.parse(response.text).url, '/?next=kept');
  }
  for (const target of ['/accounts/one/rows?x=1', '/enroll', '/enroll/options']) {
    const response = await ask(target, ['session=synthetic'], 'POST', 'synthetic-body');
    assert.deepEqual(JSON.parse(response.text), { owner: 'receptionist', method: 'POST', url: target, body: 'synthetic-body' });
  }
  const head = await ask('/', ['__Host-browser-address=bad'], 'HEAD');
  assert.equal(head.status, 200); assert.equal(head.text, '');
  const post = await ask('/', ['__Host-browser-address=bad'], 'POST', 'kept-body');
  assert.equal(JSON.parse(post.text).body, 'kept-body');
  assert.equal(JSON.parse((await ask('/accounts-other')).text).owner, 'engine');
  assert.ok(hits.engine.length > 0 && hits.receptionist.length > 0);
  await new Promise(resolve => receptionist.close(resolve));
  const before = hits.engine.length;
  assert.equal((await ask('/', ['__Host-browser-address=bad'])).status, 502);
  assert.equal(hits.engine.length, before, 'unavailable routing owner never falls back to the engine');
});
