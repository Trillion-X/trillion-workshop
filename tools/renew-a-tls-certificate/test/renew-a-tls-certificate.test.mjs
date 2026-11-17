import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { writeShareFiles } from '../../write-public-share-files/do-work/write-share-files.mjs';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import { tmpdir } from 'node:os';
import { checkedHost, checkedTLS, hostCommand, publicProxy, publishDownload, grantedDownloadFile, installHostOwner, hostLayout, layoutFile, pinnedHost, heldValue } from '../do-work/renew-a-tls-certificate.mjs';
import { administrationArguments, proxied } from '../../administer-a-rented-host/do-work/administration-arguments.mjs';

// A made-up server: every fact below is the run's input, none is the tool's.
const host = {
  owner: '/usr/local/lib/example/tls-host-owner.py',
  state: '/etc/example-public-tls',
  downloads: '/var/lib/public-downloads',
  ingress: { service: 'example-public-tls', pid_file: '/run/example-public-tls.pid', error_log: '/var/log/nginx/example-error.log', diagnostics_log: '/var/log/nginx/example-connection-status.log', diagnostics_paths: ['/devices/connections/current', '/mcp/resource-connection'] },
  receptionist: { service: 'example-receptionist', account: 'example-mcp', binary_pattern: '/opt/example/source/[a-f0-9]{40}/target/release/example-receptionist', listen: '127.0.0.1:9443', paths: ['/mcp', '/mcp/resource-connection', '/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-protected-resource'], environment: { EXAMPLE_LISTEN: '{listen}', EXAMPLE_ORIGIN: 'https://{hostname}' } },
};
const c = { hostname: 'app.example.com', address: '192.0.2.34', remotePort: 18789, knownHostsFile: '/private/known-hosts', adminKeyFile: '/private/admin-key', ssh_port: 22, admin_user: 'admin', host };

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

test('the host is reached as the given administrator with one identity and its pinned key, through the run\'s proxy when it has one', () => {
  const direct = administrationArguments(c);
  assert.deepEqual(direct, ['-T', '-p', '22', '-i', '/private/admin-key', '-o', 'IdentitiesOnly=yes', '-o', 'IdentityAgent=none', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'UserKnownHostsFile=/private/known-hosts', '-o', 'GlobalKnownHostsFile=/dev/null', '-o', 'ConnectTimeout=10', 'admin@192.0.2.34']);
  assert.deepEqual(administrationArguments({ ...c, proxy: 'http://127.0.0.1:40123' }).slice(0, 2), ['-o', 'ProxyCommand=/usr/bin/nc -X connect -x 127.0.0.1:40123 %h %p']);
  assert.ok(administrationArguments({ ...c, proxy: null }).includes('ServerAliveInterval=30')); // a quiet DNS-01 wait never looks idle to the proxy
  for (const refused of ['https://127.0.0.1:1', 'http://proxy.example.com:8080', 'http://127.0.0.1:1;touch']) assert.throws(() => proxied(refused), /refused/);
  assert.throws(() => administrationArguments({ ...c, address: 'app..example.com' }), /refused/);
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
  // At any port but 22, ssh looks the host up as [address]:port, so that is how it is pinned.
  assert.equal(readFileSync(pinnedHost({ ...c, ssh_port: 2222, knownHost: line }, key, folder).knownHostsFile, 'utf8'), `[192.0.2.34]:2222 ${line.split(' ').slice(1).join(' ')}\n`);
  for (const knownHost of [undefined, '192.0.2.35 ssh-ed25519 AAAA', '192.0.2.34 ssh-rsa AAAA', `${line}\n192.0.2.34 ssh-ed25519 BBBB`]) {
    assert.throws(() => pinnedHost({ ...c, knownHost }, '/held/admin-key', folder), /pinned key/);
  }
});

test('public ingress keeps its own paths and forwards every other path to the engine, with normal upstream TLS verification', () => {
  const config = publicProxy(c);
  assert.ok(config.includes('location / { proxy_pass http://127.0.0.1:18789; }'));
  assert.ok(!config.includes('location / { return 404; }')); // what exists is the engine's to say, not the host's
  assert.equal(config.match(/limit_except/g).length, 1); // the downloads folder limits methods; the engine decides the rest
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

test('the public host names no other host: no proxy_pass reaches anything but the engine and the receptionist', () => {
  const config = publicProxy(c);
  assert.ok(!config.includes('location = /privacy') && !config.includes('location = /terms'));
  const targets = [...config.matchAll(/proxy_pass ([^;]+);/g)].map(match => match[1]);
  assert.ok(targets.every(target => /^(?:\$root_upstream|http:\/\/(?:127\.0\.0\.1:\d+|engine_connection)|https:\/\/127\.0\.0\.1:\d+)$/.test(target)), targets.join(' '));
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
  const run = (cmd, args, options) => { calls.push([cmd, args, options?.input?.length]); return '3\n'; };
  assert.deepEqual(publishDownload(c, file, 'App.dmg', { run }), { name: 'App.dmg', kept: 'App-1.dmg', bytes: 3, blake3: makeHashCodeHexFromBytes(Buffer.from('abc')).slice(3) });
  const [cmd, args, sent] = calls.at(-1);
  assert.equal(cmd, '/usr/bin/ssh'); assert.equal(sent, 3);
  assert.equal(calls.length, 1); // shared identity code needs no external b3sum
  assert.deepEqual(args.slice(-4), [host.downloads, 'App-1.dmg', 'App.dmg', '3']);
  assert.ok(args.includes('/usr/bin/python3'));
  for (const name of ["App.dmg'; rm -rf /", '../App.dmg', '', 'App-1.dmg']) assert.throws(() => publishDownload(c, file, name, { run: () => { throw new Error('reached host'); } }), /refused/);
  assert.throws(() => publishDownload(c, file, 'App.dmg', { run: () => '2\n' }), /different size/);
});

// Run the exact command SSH would execute in a local temporary host folder.
// This exercises Python, shell quoting, real bytes, links, and atomic replaces;
// it never reaches a real server, account, credential or public download.
function localDownloadHost(_command, args, options) {
  return execFileSync('/bin/sh', ['-c', args.slice(args.indexOf('/usr/bin/python3')).join(' ')], options);
}

test('the real download helper recovers pointers after a failed redirect and reports failed recovery as unknown', () => {
  const result = spawnSync('/usr/bin/python3', [new URL('./publish-download.test.py', import.meta.url).pathname], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Ran 4 tests/);
});

test('actual download publication preserves immutable bytes, retries identically and refuses same-size collisions before moving its pointer', t => {
  const root = realpathSync(mkdtempSync(`${tmpdir()}/download-host-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = `${root}/App-1.dmg`, downloads = `${root}/public`;
  writeFileSync(file, 'abc');
  const request = { ...c, host: { ...host, downloads } };
  const publish = () => publishDownload(request, file, 'App.dmg', { run: localDownloadHost });
  const first = publish();
  assert.equal(first.blake3, makeHashCodeHexFromBytes(readFileSync(`${downloads}/App.dmg`)).slice(3));
  assert.equal(readFileSync(`${downloads}/App.dmg`, 'utf8'), 'abc');
  assert.equal(readlinkSync(`${downloads}/App.dmg`), 'App-1.dmg');
  assert.equal(readFileSync(`${downloads}/.default-download.conf`, 'utf8'), 'return 302 /download/App.dmg;\n');
  const inode = statSync(`${downloads}/App-1.dmg`).ino;
  assert.deepEqual(publish(), first);
  assert.equal(statSync(`${downloads}/App-1.dmg`).ino, inode);
  writeFileSync(file, 'xyz'); // same length, different identity
  assert.throws(publish, /not published/);
  assert.equal(readFileSync(`${downloads}/App-1.dmg`, 'utf8'), 'abc');
  assert.equal(readlinkSync(`${downloads}/App.dmg`), 'App-1.dmg');
  assert.equal(readFileSync(`${downloads}/.default-download.conf`, 'utf8'), 'return 302 /download/App.dmg;\n');
  assert.deepEqual(readdirSync(downloads).sort(), ['.default-download.conf', '.publish-download.lock', 'App-1.dmg', 'App.dmg']);
});

test('a truncated incoming file and a retained symlink fail without moving existing public pointers; a complete retry recovers', t => {
  const root = realpathSync(mkdtempSync(`${tmpdir()}/download-refusal-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const downloads = `${root}/public`, file = `${root}/App-2.dmg`;
  mkdirSync(downloads);
  writeFileSync(`${downloads}/Old.dmg`, 'old');
  symlinkSync('Old.dmg', `${downloads}/App.dmg`);
  writeFileSync(`${downloads}/.default-download.conf`, 'old config');
  writeFileSync(file, 'abc');
  const request = { ...c, host: { ...host, downloads } };
  const truncated = (cmd, args, options) => localDownloadHost(cmd, args, { ...options, input: options.input.subarray(0, 2) });
  assert.throws(() => publishDownload(request, file, 'App.dmg', { run: truncated }), /not published/);
  assert.ok(!existsSync(`${downloads}/App-2.dmg`));
  assert.equal(readlinkSync(`${downloads}/App.dmg`), 'Old.dmg');
  assert.equal(readFileSync(`${downloads}/.default-download.conf`, 'utf8'), 'old config');
  writeFileSync(`${downloads}/App-2.dmg`, 'xyz'); // same-size retained collision must not select this name
  assert.throws(() => publishDownload(request, file, 'App.dmg', { run: localDownloadHost }), /not published/);
  assert.equal(readlinkSync(`${downloads}/App.dmg`), 'Old.dmg');
  assert.equal(readFileSync(`${downloads}/.default-download.conf`, 'utf8'), 'old config');
  rmSync(`${downloads}/App-2.dmg`);
  symlinkSync(file, `${downloads}/App-2.dmg`);
  assert.throws(() => publishDownload(request, file, 'App.dmg', { run: localDownloadHost }), /not published/);
  assert.equal(readlinkSync(`${downloads}/App.dmg`), 'Old.dmg');
  rmSync(`${downloads}/App-2.dmg`);
  publishDownload(request, file, 'App.dmg', { run: localDownloadHost });
  assert.equal(readFileSync(`${downloads}/App.dmg`, 'utf8'), 'abc');
  assert.ok(!readdirSync(downloads).some(name => name.startsWith('.publish-') && name !== '.publish-download.lock'));
});

test('the computer publication reads only a relative regular file within its granted real folder', t => {
  const root = realpathSync(mkdtempSync(`${tmpdir()}/download-grant-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const folder = `${root}/granted`;
  mkdirSync(folder);
  writeFileSync(`${folder}/App-1.dmg`, 'abc');
  writeFileSync(`${root}/outside.dmg`, 'secret');
  symlinkSync(`${root}/outside.dmg`, `${folder}/escaped.dmg`);
  assert.equal(grantedDownloadFile(folder, 'App-1.dmg'), `${folder}/App-1.dmg`);
  for (const file of ['', '.', '..', '../outside.dmg', `${root}/outside.dmg`, 'escaped.dmg']) {
    assert.throws(() => grantedDownloadFile(folder, file), /outside the granted folder/);
  }
  assert.throws(() => grantedDownloadFile(undefined, 'App-1.dmg'), /granted folder/);
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
  assert.ok(calls[2].command.endsWith("mv '/usr/local/lib/example/tls-host-owner-core.py.next' '/usr/local/lib/example/tls-host-owner-core.py'"));
  assert.match(calls[2].input, /def main\(\):/);
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

// The public share writer already owns admission and writes this tree. The host
// adds the missing filesystem-to-URL mapping, without a second share reader.
test('public export folders use declared mounts and indexes without taking another owner path', () => {
  const static_files = [
    { path: '/share/', folder: '/var/lib/public-shares', index: 'index.html', exclude: ['manifest.json'] },
    { path: '/manuals/', folder: '/srv/public-manuals', index: 'home.html', exclude: ['build.json'] },
  ];
  const config = publicProxy({ ...c, host: { ...host, static_files } });
  for (const row of static_files) {
    const line = config.split('\n').find(line => line.includes(`location ^~ ${row.path} {`));
    assert.ok(line.includes(`root ${row.folder};`));
    assert.ok(line.includes(`rewrite ^${row.path}(.*)$ /$1 break; try_files $uri $uri/${row.index} =404;`));
    for (const guard of ['limit_except GET HEAD { deny all; }', 'disable_symlinks on;', 'autoindex off;', 'include /etc/nginx/mime.types;', 'Cache-Control "no-store"', 'X-Content-Type-Options "nosniff"']) assert.ok(line.includes(guard), guard);
    for (const hidden of row.exclude) assert.ok(config.includes(`location = ${row.path}${hidden} { return 404; }`));
    assert.ok(config.indexOf(`location ^~ ${row.path}`) < config.indexOf('location / {'));
  }
  assert.ok(config.includes('(?:writing|next)$'));
  assert.ok(config.includes('location = /share { return 404; }'));
  assert.ok(config.includes('proxy_pass http://127.0.0.1:18789;'));
});

test('invalid public mounts, shell words, traversal, nested mounts and existing ingress paths are refused before host access', () => {
  const row = { path: '/share/', folder: '/var/lib/public-shares', index: 'index.html', exclude: ['manifest.json'] };
  const refused = [
    null, {}, [null], [{ ...row, path: '/' }], [{ ...row, path: '/share' }],
    [{ ...row, path: '/share//nested/' }], [{ ...row, path: '/share/../private/' }],
    [{ ...row, path: '/sh.are/' }], [{ ...row, path: '/share/{evil}/' }],
    [{ ...row, folder: '/' }], [{ ...row, folder: '/var/lib/../private' }],
    [{ ...row, folder: '/public;echo' }], [{ ...row, folder: '/public/' }],
    [{ ...row, index: '../private' }], [{ ...row, exclude: ['../private'] }],
    [{ ...row, extra: true }], [{ ...row, media_types: { 'files/picture': 'image/png; return 200;' } }],
    [{ ...row, media_types: { '../private': 'text/plain' } }], [{ ...row, media_types: { 'manifest.json': 'text/plain' } }],
    [{ ...row, media_types: { 'file.writing': 'text/plain' } }], [{ ...row, media_types: { 'folder/.hidden': 'text/plain' } }], [row, row], [row, { ...row, path: '/share/nested/' }],
    [{ ...row, path: '/mcp/' }], [{ ...row, path: '/.well-known/' }],
    [{ ...row, path: '/download/' }], [{ ...row, path: '/healthz/' }],
  ];
  for (const static_files of refused) assert.throws(() => publicProxy({ ...c, host: { ...host, static_files } }), /refused/, JSON.stringify(static_files));
  assert.throws(() => publicProxy({ ...c, host: { ...host, receptionist: { ...host.receptionist, paths: ['/a/'] }, static_files: [{ ...row, path: '/a/nested/' }] } }), /refused/);
  assert.equal(publicProxy(c), publicProxy({ ...c, host: { ...host, static_files: [] } }));
});

const nginx = [process.env.NGINX, '/usr/sbin/nginx', '/opt/homebrew/bin/nginx'].find(path => path && existsSync(path));
test('the real share exporter feeds host DATA and nginx for public JSON, pages, sitemap, media, changes and revocation', { skip: !nginx }, async t => {
  const folder = realpathSync(mkdtempSync(`${tmpdir()}/public-export-`));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const publicFolder = `${folder}/exports`;
  const picture = Buffer.from('synthetic image bytes');
  const identity = makeHashCodeHexFromBytes(picture);
  const grant = { share_id: 's1', code: 'k'.repeat(48), scope: { kind: 'public' }, can: ['view'], created_at: '2026-10-01T00:00:00Z', address: 'menu', listed: true, revoked_at: null, expires_at: null };
  const dish = { dish: 'Public dish', photo: '/picture.png', private_cost: 'PRIVATE' };
  const door = {
    async read(type, id) { return type === 'list' && id === 'list:menu' ? { label: 'Menu', row_type: 'dish', title_field: 'dish', fields: [{ id: 'dish', label: 'Dish', kind: 'text' }, { id: 'photo', label: 'Photo', kind: 'file' }] } : null; },
    async *list({ type }) {
      if (type === 'sharing') yield { id: 'sharing:list:menu', type, value: { record: 'list:menu', leave_out: [], match_only: [], link_grants: [grant] } };
      if (type === 'record:dish') yield { id: 'record:dish:d1', type, value: dish };
    },
    async files(method, { offset, length }) { const part = picture.subarray(offset, offset + length); return { identity, byte_length: picture.length, media_type: 'image/png', bytes_returned: part.length, content: part.toString('base64'), encoding: 'base64' }; },
  };
  const input = { input: { origin: 'https://app.example.com', row_kind: 'record:dish' }, folder: publicFolder };
  const exported = await writeShareFiles(input, { door });
  assert.equal(exported.published.length, 1);
  assert.equal(exported.host_files.media_types[`files/${identity}`], 'image/png');
  // Synthetic files outside the admitted export exercise host refusal. No
  // account store or real private material is ever used in this fixture.
  mkdirSync(`${publicFolder}/secret`);
  writeFileSync(`${publicFolder}/secret/index.html`, 'PRIVATE');
  writeFileSync(`${publicFolder}/index.html`, 'PRIVATE');
  writeFileSync(`${publicFolder}/menu.json.writing`, 'INTERNAL');
  writeFileSync(`${publicFolder}/.hidden`, 'PRIVATE');
  symlinkSync(`${publicFolder}/manifest.json`, `${publicFolder}/linked.json`);
  const static_files = [{ ...exported.host_files, exclude: [...exported.host_files.exclude, 'secret/index.html', 'index.html'] }];
  const production = publicProxy({ ...c, host: { ...host, static_files } });
  const descriptors = JSON.parse(readFileSync(new URL('../tool-rows.json', import.meta.url)));
  const configure = descriptors.records.find(record => record.payload?.id === 'tool:write-a-public-hosts-paths').payload;
  assert.ok(configure.input_schema.properties.host.properties.static_files);
  assert.deepEqual(configure.invoke.stdin, { fill: { from: 'input' } }, 'the installed tool passes declared host DATA to the same checked owner');
  const mime = ['/etc/nginx/mime.types', '/opt/homebrew/etc/nginx/mime.types'].find(path => existsSync(path));
  assert.ok(mime, 'the nginx installation supplies its media types');
  // Exercise the exact generated locations on loopback without a certificate,
  // the public listener, a live server config, or an account's real data.
  const locations = production.split('\n').filter(line => /location (?:=|\^~) \/share/.test(line)).join('\n').replaceAll('/etc/nginx/mime.types', mime);
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const config = `${folder}/nginx.conf`;
  writeFileSync(config, `pid ${folder}/nginx.pid; error_log stderr; events {} http { access_log off; server { listen 127.0.0.1:${port}; ${locations} location / { return 418; } } }`);
  const parsed = spawnSync(nginx, ['-t', '-p', folder, '-c', config], { encoding: 'utf8' });
  assert.equal(parsed.status, 0, parsed.stderr);
  const child = spawn(nginx, ['-p', folder, '-c', config, '-g', 'daemon off;'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let errors = ''; child.stderr.on('data', data => { errors += data; });
  t.after(async () => { if (child.exitCode === null) { child.kill('SIGQUIT'); await once(child, 'exit'); } });
  const get = (path, method = 'GET') => fetch(`http://127.0.0.1:${port}${path}`, { method, redirect: 'manual' });
  for (let attempt = 0; ; attempt++) {
    try { await get('/'); break; } catch (error) {
      if (attempt >= 50 || child.exitCode !== null) throw new Error(`nginx did not start: ${errors}`, { cause: error });
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
  for (const [path, expected, type] of [
    ['/share/menu.json', 'Public dish', 'application/json'], ['/share/menu', 'Menu', 'text/html'],
    ['/share/menu/public-dish', 'Public dish', 'text/html'], ['/share/sitemap.xml', 'urlset', 'xml'],
    [`/share/files/${identity}`, 'synthetic image bytes', 'image/png'],
  ]) {
    const answer = await get(path);
    assert.equal(answer.status, 200, `${path}: ${errors}`);
    assert.ok(answer.headers.get('content-type').includes(type));
    assert.equal(answer.headers.get('cache-control'), 'no-store');
    assert.equal(answer.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(answer.headers.get('access-control-allow-origin'), '*');
    const body = await answer.text();
    assert.ok(body.includes(expected));
    assert.ok(!body.includes('PRIVATE'), 'only the real exporter admitted public fields leave');
  }
  const head = await get('/share/menu.json', 'HEAD');
  assert.equal(head.status, 200); assert.equal(await head.text(), '');
  assert.equal((await get('/share/menu.json', 'POST')).status, 403);
  for (const path of ['/share', '/share/', '/share/manifest.json', '/share/menu.json.writing', '/share/.hidden', '/share/secret/index.html', '/share/secret', '/share/secret/', '/share/missing', '/share/missing.json']) {
    assert.equal((await get(path)).status, 404, path);
  }
  assert.ok([403, 404].includes((await get('/share/linked.json')).status));
  dish.dish = 'Changed dish';
  const changed = await writeShareFiles(input, { door });
  assert.deepEqual(changed.host_files.media_types, exported.host_files.media_types, 'unchanged media needs no new host configuration');
  assert.ok((await (await get('/share/menu.json')).text()).includes('Changed dish'));
  grant.revoked_at = new Date().toISOString();
  const revoked = await writeShareFiles(input, { door });
  assert.equal(revoked.published.length, 0);
  assert.deepEqual(revoked.host_files.media_types, {}, 'the next desired host configuration drops ended media');
  for (const path of ['/share/menu.json', '/share/menu', `/share/files/${identity}`]) assert.equal((await get(path)).status, 404, 'revoked public output is removed even before obsolete MIME entries are refreshed');
  assert.equal((await get('/other')).status, 418, 'other paths retain their existing owner');
});

