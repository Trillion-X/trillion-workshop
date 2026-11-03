import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { checkedTLS, hostCommand, publicProxy, publishDownload, installHostOwner, hostLayout, layoutFile, pinnedHost, heldValue } from '../do-work/renew-a-tls-certificate.mjs';
import { administrationArguments, proxied } from '../../keep-a-door-tunnel-open/do-work/keep-a-door-tunnel-open.mjs';

// A made-up server: every fact below is the run's input, none is the tool's.
const host = {
  owner: '/usr/local/lib/example/tls-host-owner.py',
  state: '/etc/example-public-tls',
  downloads: '/var/lib/public-downloads',
  ingress: { service: 'example-public-tls', pid_file: '/run/example-public-tls.pid', error_log: '/var/log/nginx/example-error.log', diagnostics_log: '/var/log/nginx/example-connection-status.log', diagnostics_paths: ['/devices/connections/current', '/mcp/resource-connection'] },
  receptionist: { service: 'example-receptionist', account: 'example-mcp', binary_pattern: '/opt/example/source/[a-f0-9]{40}/target/release/example-receptionist', listen: '127.0.0.1:9443', paths: ['/mcp', '/mcp/resource-connection', '/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-protected-resource'], environment: { EXAMPLE_LISTEN: '{listen}', EXAMPLE_ORIGIN: 'https://{hostname}' } },
  site: { hostname: 'example.org', paths: ['/privacy', '/terms'] },
};
const c = { hostname: 'app.example.com', address: '192.0.2.34', remotePort: 18789, knownHostsFile: '/private/known-hosts', adminKeyFile: '/private/admin-key', host };

test('TLS command pins host and passes DNS token on private stdin, never argv or environment', () => {
  const token = 'CANARY_TOKEN_not_for_logs_1234567890';
  let invocation;
  const result = hostCommand(c, 'issue', { hostname: c.hostname, token }, { run: (cmd, args, options) => {
    invocation = { cmd, args, options }; return '{"certificate_present":true}';
  } });
  assert.equal(result.certificate_present, true);
  assert.ok(invocation.args.includes('StrictHostKeyChecking=yes'));
  assert.deepEqual(invocation.args.slice(-3), ['/usr/bin/python3', host.owner, 'issue']);
  assert.ok(!JSON.stringify(invocation.args).includes(token));
  assert.equal(invocation.options.env, undefined);
  assert.equal(JSON.parse(invocation.options.input).token, token);
  assert.deepEqual(invocation.options.stdio, ['pipe', 'pipe', 'pipe']);
  const poisoned = { stdout: Buffer.from(token), stderr: Buffer.from(token), status: 2 };
  assert.throws(() => hostCommand(c, 'issue', {}, { run: () => { throw poisoned; } }), error => !String(error).includes(token));
});

test('the host is reached as root with one identity and its pinned key, through the run\'s proxy when it has one', () => {
  const direct = administrationArguments(c);
  assert.deepEqual(direct.slice(-14), ['-T', '-i', '/private/admin-key', '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'UserKnownHostsFile=/private/known-hosts', '-o', 'ConnectTimeout=10', 'root@192.0.2.34']);
  assert.deepEqual(proxied('http://127.0.0.1:40123').slice(0, 2), ['-o', 'ProxyCommand=/usr/bin/nc -X connect -x 127.0.0.1:40123 %h %p']);
  assert.ok(proxied(undefined).includes('ServerAliveInterval=30')); // a quiet DNS-01 wait never looks idle to the proxy
  for (const refused of ['https://127.0.0.1:1', 'http://proxy.example.com:8080', 'http://127.0.0.1:1;touch']) assert.throws(() => proxied(refused), /refused/);
  assert.throws(() => administrationArguments({ ...c, address: 'app.example.com' }), /refused/);
  assert.throws(() => administrationArguments({ ...c, adminKeyFile: undefined }), /identity was refused/);
});

test('the pinned key is the one known host, for the address asked, in the run\'s own folder', () => {
  const folder = mkdtempSync(`${tmpdir()}/known-host-test-`);
  const line = '192.0.2.34 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleExampleExampleExampleExample0';
  const key = `${folder}/admin-key`;
  writeFileSync(key, 'made-up key text', { mode: 0o600 }); // as the vault keeps a value: without its last newline
  const pinned = pinnedHost({ ...c, knownHostsFile: undefined, adminKeyFile: undefined, knownHost: line }, key, folder);
  assert.equal(pinned.adminKeyFile, key);
  assert.equal(readFileSync(key, 'utf8'), 'made-up key text\n'); // ssh refuses a key without it
  pinnedHost({ ...c, knownHost: line }, key, folder);
  assert.equal(readFileSync(key, 'utf8'), 'made-up key text\n');
  assert.equal(readFileSync(pinned.knownHostsFile, 'utf8'), `${line}\n`);
  assert.equal(statSync(pinned.knownHostsFile).mode & 0o777, 0o600);
  for (const knownHost of [undefined, '192.0.2.35 ssh-ed25519 AAAA', '192.0.2.34 ssh-rsa AAAA', `${line}\n192.0.2.34 ssh-ed25519 BBBB`]) {
    assert.throws(() => pinnedHost({ ...c, knownHost }, '/held/admin-key', folder), /pinned key/);
  }
});

test('public ingress keeps its own paths and forwards every other path to the engine, with normal upstream TLS verification', () => {
  const config = publicProxy(c);
  assert.ok(config.includes('location / { proxy_pass http://127.0.0.1:18789; }'));
  assert.ok(!config.includes('location / { return 404; }')); // what exists is the engine's to say, not the host's
  assert.equal(config.match(/limit_except/g).length, 3); // the downloads folder and the two legal pages limit methods; the engine decides the rest
  for (const path of host.receptionist.paths) assert.ok(config.includes(`location = ${path} { proxy_pass https://127.0.0.1:9443;`));
  assert.ok(config.indexOf('location = /mcp ') < config.indexOf('location / {'));
  assert.ok(config.includes('proxy_ssl_verify on'));
  assert.ok(config.includes('proxy_ssl_verify_depth 4')); // LE YE2 -> Root YE -> Root X2 -> trusted Root X1.
  assert.ok(config.includes('proxy_ssl_name app.example.com'));
  assert.ok(config.includes('proxy_set_header Host app.example.com'));
  assert.ok(config.includes('proxy_set_header CF-Connecting-IP $remote_addr;')); // a caller-supplied peer address is replaced at this edge
  assert.ok(config.includes('proxy_set_header Upgrade $http_upgrade'));
  assert.ok(config.includes('pid /run/example-public-tls.pid;') && config.includes('error_log /var/log/nginx/example-error.log warn;'));
  assert.ok(!config.includes('proxy_hide_header'));
  for (const hostname of ['app.example.com;return 200', '../etc', 'app.example.com\n']) assert.throws(() => checkedTLS({ ...c, hostname }), /refused/);
  assert.throws(() => checkedTLS({ ...c, receptionistBinary: '/tmp/unowned' }), /refused/);
  assert.doesNotThrow(() => checkedTLS({ ...c, receptionistBinary: `/opt/example/source/${'a'.repeat(40)}/target/release/example-receptionist` }));
});

test('/privacy and /terms are handed to the site by GET and HEAD, not to the engine, and the site is never asked for anything else', () => {
  const config = publicProxy(c);
  for (const path of host.site.paths) {
    const line = config.split('\n').find(l => l.includes(`location = ${path} {`));
    assert.ok(line.includes('limit_except GET HEAD { deny all; }'));
    assert.ok(line.includes('proxy_pass https://example.org;')); // no URI part: the request address is sent as it came
    assert.ok(line.includes('proxy_set_header Host example.org;'));
    assert.ok(line.includes('proxy_set_header Cookie "";')); // the site never needs the app's cookies
    assert.ok(line.includes('proxy_ssl_name example.org;') && line.includes('proxy_ssl_verify on;') && line.includes('proxy_ssl_server_name on;'));
    assert.ok(config.indexOf(`location = ${path} `) < config.indexOf('location / {')); // before the engine's catch-all
  }
  assert.ok(!config.includes('location = /privacy/'));
  assert.ok(!publicProxy({ ...c, hostname: 'example.org' }).includes('location = /privacy')); // the site itself would loop
  const { site, ...noSite } = host;
  assert.equal(publicProxy({ ...c, host: noSite }).match(/limit_except/g).length, 1); // no site named, no pages handed on
});

test('downloads are served by GET/HEAD from the kept folder, before the engine', () => {
  const config = publicProxy(c);
  assert.ok(config.includes(`location ^~ /download/ { limit_except GET HEAD { deny all; } types { } default_type application/octet-stream;`));
  assert.ok(config.includes(`alias ${host.downloads}/; location`));
  assert.ok(config.indexOf('location ^~ /download/') < config.indexOf('location / {'));
  for (const path of ['/download', '/download/']) assert.ok(config.includes(`location = ${path} { include ${host.downloads}/.default-download*.conf; return 404; }`));
  assert.ok(!config.includes('autoindex on'));
  assert.ok(config.includes('location ~ ^/download/\\. { return 404; }')); // the pointer's include and partial uploads stay unserved
});

test('publishing keeps a file once under its own name and moves only the pointer; bad names never reach the host', () => {
  const file = `${mkdtempSync(`${tmpdir()}/download-`)}/App-1.dmg`;
  writeFileSync(file, 'abc');
  const calls = [];
  const run = (cmd, args, options) => { calls.push([cmd, args.at(-1), options?.input?.length]); return cmd === 'b3sum' ? `${'a'.repeat(64)}\n` : '3\n'; };
  assert.deepEqual(publishDownload(c, file, 'App.dmg', { run }), { name: 'App.dmg', kept: 'App-1.dmg', bytes: 3, blake3: 'a'.repeat(64) });
  const [cmd, script, sent] = calls.at(-1);
  assert.equal(cmd, '/usr/bin/ssh'); assert.equal(sent, 3);
  assert.ok(script.includes("if [ ! -f '/var/lib/public-downloads/App-1.dmg' ]"));
  assert.ok(script.includes("ln -sfn 'App-1.dmg' '/var/lib/public-downloads/.App.dmg.next'; mv -T"));
  assert.ok(script.includes("printf 'return 302 /download/%s;\\n' 'App.dmg' > '/var/lib/public-downloads/.default-download.conf.next'"));
  for (const name of ["App.dmg'; rm -rf /", '../App.dmg', '', 'App-1.dmg']) assert.throws(() => publishDownload(c, file, name, { run: () => { throw new Error('reached host'); } }), /refused/);
  const short = (cmd) => cmd === 'b3sum' ? 'x\n' : '2\n';
  assert.throws(() => publishDownload(c, file, 'App.dmg', { run: short }), /different size/);
});

test('the host owner is installed with its layout beside it, the layout first, holding only the facts the owner reads', () => {
  const calls = [];
  const run = (cmd, args, options) => { calls.push({ command: args.at(-1), input: String(options?.input ?? '') }); return '{"packages_installed":true}'; };
  assert.deepEqual(installHostOwner(c, { run, prepare: false }), { tls_owner_installed: true });
  assert.equal(layoutFile(host.owner), '/usr/local/lib/example/tls-host-owner.json');
  assert.ok(calls[0].command.startsWith("install -d -m 0755 '/usr/local/lib/example' && cat > '/usr/local/lib/example/tls-host-owner.json.next'"));
  assert.deepEqual(JSON.parse(calls[0].input), hostLayout(host));
  assert.deepEqual(Object.keys(JSON.parse(calls[0].input)).sort(), ['ingress', 'receptionist', 'state']);
  assert.ok(calls[1].command.endsWith("mv '/usr/local/lib/example/tls-host-owner.py.next' '/usr/local/lib/example/tls-host-owner.py'"));
  assert.ok(calls[1].input.startsWith('#!/usr/bin/python3'));
  assert.equal(installHostOwner(c, { run }).packages_installed, true);
  for (const owner of ["/usr/local/lib/x'; rm -rf /.py", '/usr/local/lib/example/owner.sh', 'relative/owner.py']) {
    assert.throws(() => installHostOwner({ ...c, host: { ...host, owner } }, { run: () => { throw new Error('reached host'); } }), /layout \(host\) was refused/);
  }
});

test('the DNS key may be held as text or as fields', () => {
  assert.equal(heldValue('abcdefghijklmnopqrstuvwxyz\n'), 'abcdefghijklmnopqrstuvwxyz');
  assert.deepEqual(heldValue('{"token":"abc"}'), { token: 'abc' });
});

test('optional connection diagnostics log only exact path and status, never headers or query credentials', () => {
  const config = publicProxy({ ...c, connectionDiagnostics: true });
  assert.match(config, /log_format connection_status '\$msec \$uri \$status \$upstream_status \$request_time'/);
  assert.match(config, /default 0; \/devices\/connections\/current 1; \/mcp\/resource-connection 1; \}/);
  assert.ok(config.includes('access_log /var/log/nginx/example-connection-status.log connection_status if=$connection_status_log;'));
  const logFormat = config.match(/log_format connection_status ([^;]+);/)[1];
  for (const unsafe of ['$request ', '$args', '$request_uri', '$http_authorization', '$remote_addr', '$request_body']) assert.ok(!logFormat.includes(unsafe));
  assert.ok(publicProxy(c).includes('access_log off;'));
  const { diagnostics_log, ...quiet } = host.ingress;
  assert.throws(() => publicProxy({ ...c, connectionDiagnostics: true, host: { ...host, ingress: quiet } }), /refused/);
});

test('the host owner\'s own tests pass here (the Linux-only descriptor tests run on the server, by host-test)', () => {
  const ran = spawnSync('python3', ['-I', new URL('./tls-host-owner.test.py', import.meta.url).pathname], { encoding: 'utf8' });
  assert.equal(ran.status, 0, ran.stderr);
});
