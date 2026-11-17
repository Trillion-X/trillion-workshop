// tools/start-a-computer/test/site-file.test.mjs
//
// A computer whose caddy row names a whole site file (read-data/caddy-sites) gets exactly that file filled from the row:
// each {{field}} the row's value, {{routes}} the row's routes, Caddy's own {placeholders} untouched. Applying it validates
// with the Caddy the row names and the storage environment the file reads.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyHostLayout, readPages, SITE_BLOCK } from '../do-work/start-a-computer.mjs';
import { renderLayout } from '../do-work/render-layout.mjs';

const TEMPLATE = readFileSync(new URL('../read-data/caddy-sites/serving-computer-front-door.caddy', import.meta.url), 'utf8');
// The pages a request hands in (the person's own folder, read by readPages): this tool holds none.
const PAGES = [
  { name: 'privacy.html', bytes: Buffer.from('<html><body>Example privacy page</body></html>') },
  { name: 'assets/site.css', bytes: Buffer.from('body { margin: 0 }') },
  { name: 'icon.png', bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff]) },
];
const caddy = {
  site_file: 'serving-computer-front-door', storage_key_prefix: 'caddy', storage_server_cert: '/etc/caddy/storage-server.crt',
  ask_port: 9444, ask_path: '/origins/certificate',
  door_upstream: 'https://127.0.0.1:9443', door_transport_routes: ['door-over-tls'], door_host: 'door.example.test',
  engine_listen: '127.0.0.1:18789', request_max: '4MB', forwarder_paths: ['/mcp', '/sign-up', '/a/*'],
  pages_root: '/var/lib/front-door-pages', downloads_root: '/var/lib/public-downloads', download_default: '/download/App.dmg',
  routes: ['better-auth'], auth_port: 8792, binary: '/opt/caddy/current/caddy', storage_env: '/etc/caddy/storage.env',
};

test('a caddy row that names a site file renders that whole file from the row, with its routes in their place', () => {
  const [file] = renderLayout({ caddy, units: [] }, SITE_BLOCK, undefined, PAGES);
  assert.equal(file.path, '/etc/caddy/Caddyfile');
  assert.doesNotMatch(file.text, /\{\{/);
  assert.match(file.text, /^door\.example\.test \{$/m);
  assert.match(file.text, /^\t@forwarder path \/mcp \/sign-up \/a\/\*$/m);
  assert.match(file.text, /^\thandle \/api\/auth\/\* \{\n\t\treverse_proxy 127\.0\.0\.1:8792\n\t\}$/m);
  assert.doesNotMatch(file.text, /oauth-authorization-server\* \{/, 'discovery stays with the engine unless the row names better-auth-discovery');
  for (const own of ['{args[0]}', '{client_ip}', '{host}', '{uri}', '{$CADDY_STORAGE_PASSWORD}']) assert.ok(file.text.includes(own), `Caddy's ${own} is left as it is`);
  const lines = file.text.split('\n').length, templateLines = TEMPLATE.split('\n').length;
  assert.equal(lines, templateLines, 'the routes slot grows by two (the route block is three lines) and the empty every-name and carried-computer slot lines go');
});

test('every other name\'s routes (every_name_routes) go first in the on-demand block, so an attached name reaches the sign-in tool', () => {
  const [file] = renderLayout({ caddy: { ...caddy, every_name_routes: ['better-auth'] }, units: [] }, SITE_BLOCK, undefined, PAGES);
  const onDemand = file.text.slice(file.text.indexOf('\nhttps:// {') + 1);
  assert.match(onDemand, /^https:\/\/ \{\n\ttls \{\n\t\ton_demand\n\t\}\n\thandle \/api\/auth\/\* \{\n\t\treverse_proxy 127\.0\.0\.1:8792\n\t\}\n/);
  const [home] = renderLayout({ caddy: { ...caddy, routes: ['better-auth', 'better-auth-webauthn'] }, units: [] }, SITE_BLOCK, undefined, PAGES);
  assert.match(home.text, /^door\.example\.test \{[\s\S]*\thandle \/\.well-known\/webauthn \{\n\t\treverse_proxy 127\.0\.0\.1:8792\n\t\}[\s\S]*\nhttps:\/\/ \{/m);
});

test('a routes slot the row leaves empty is no line at all, so a row without every_name_routes renders the file as before', () => {
  const [without] = renderLayout({ caddy, units: [] }, SITE_BLOCK, undefined, PAGES);
  const [empty] = renderLayout({ caddy: { ...caddy, every_name_routes: [] }, units: [] }, SITE_BLOCK, undefined, PAGES);
  assert.equal(empty.text, without.text);
  assert.doesNotMatch(without.text, /^https:\/\/ \{\n\ttls \{\n\t\ton_demand\n\t\}\n\n/m);
  assert.throws(() => renderLayout({ caddy: { ...caddy, every_name_routes: ['nope'] }, units: [] }, SITE_BLOCK, undefined, PAGES), /caddy\.routes names an unknown route nope/);
});

test('a site file field the row does not give, or an unknown site file, is refused', () => {
  const { door_host, ...noHost } = caddy;
  assert.throws(() => renderLayout({ caddy: { ...noHost, door_transport_routes: [] }, units: [] }, SITE_BLOCK, undefined, PAGES), /caddy site file serving-computer-front-door needs door_host/);
  assert.throws(() => renderLayout({ caddy: noHost, units: [] }, SITE_BLOCK, undefined, PAGES), /caddy route door-over-tls needs door_host/);
  assert.throws(() => renderLayout({ caddy: { ...caddy, site_file: 'nope' }, units: [] }, SITE_BLOCK, undefined, PAGES), /unknown site file nope/);
});

test('applying a site file validates it with the row\'s Caddy and storage environment before it replaces the live one', async () => {
  const commands = [];
  const run = async (_machine, command) => {
    commands.push(command);
    if (command.startsWith('if [ -f ')) throw Object.assign(new Error('absent'), { code: 3 });
    if (command.includes('curl')) return '200';
    return '';
  };
  await applyHostLayout({ address: '192.0.2.9', ssh: { known_hosts: '/dev/null' } }, { caddy, units: [], unmanaged: [] }, run, undefined, {}, { pages: PAGES });
  assert.ok(commands.includes("set -a && . '/etc/caddy/storage.env' && set +a && '/opt/caddy/current/caddy' validate --config '/etc/caddy/Caddyfile.new' --adapter caddyfile >/dev/null && mv '/etc/caddy/Caddyfile.new' '/etc/caddy/Caddyfile'"));
  assert.ok(commands.includes('systemctl reload caddy'));
});

test('a computer whose row names no site host asks its restarted unit\'s health with no Host header of its own', async () => {
  const commands = [];
  const run = async (_machine, command) => {
    commands.push(command);
    if (command.startsWith('if [ -f ') || command.startsWith('test -s ')) throw Object.assign(new Error('absent'), { code: 3 });
    if (command.includes('curl')) return '200';
    return '';
  };
  const unit = {
    unit: 'example-sign-in.service', template: 'serve-better-auth', description: 'Example sign-in', user: 'example-sign-in',
    state: '/var/lib/example-sign-in', workshop: '/opt/example-workshop', repository: 'https://example.test/workshop.git',
    tool_folder: 'tools/better-auth-official', node_bin: '/opt/node/bin', settings_file: '/etc/example/settings.json', settings: { port: 8792 },
    secret_vault_key: 'example-secret', secret_name: 'example-secret', secret_file: '/etc/credstore.encrypted/example-secret', writable: '/var/lib/example-sign-in',
  };
  const layout = { caddy, units: [unit], unmanaged: [], health: { path: '/api/auth/ok', status: 200, where: 'machine' }, health_listen: '127.0.0.1:8792' };
  const answer = await applyHostLayout({ address: '192.0.2.9', ssh: { known_hosts: '/dev/null' } }, layout, run, undefined, { 'example-secret': 'made-up' }, { pages: PAGES });
  assert.deepEqual(answer.booted, ['example-sign-in.service']);
  const health = commands.find(command => command.startsWith('curl '));
  assert.equal(health, "curl -s -o /dev/null -w '%{http_code}' 'http://127.0.0.1:8792/api/auth/ok' || true");
});

test('better-auth-pages sends the paths the row names in auth_page_paths to the sign-in tool, and needs them', () => {
  const paths = ['/sign-in', '/sign-in/*', '/sign-up', '/sign-up/*'];
  const [file] = renderLayout({ caddy: { ...caddy, routes: ['better-auth', 'better-auth-pages'], auth_page_paths: paths }, units: [] }, SITE_BLOCK, undefined, PAGES);
  assert.match(file.text, /^\t@better_auth_pages path \/sign-in \/sign-in\/\* \/sign-up \/sign-up\/\*\n\thandle @better_auth_pages \{\n\t\treverse_proxy 127\.0\.0\.1:8792\n\t\}$/m);
  assert.throws(() => renderLayout({ caddy: { ...caddy, routes: ['better-auth-pages'] }, units: [] }, SITE_BLOCK, undefined, PAGES), /caddy route better-auth-pages needs auth_page_paths/);
});

test('the door upstream carries TLS and its server name only when the row names door-over-tls, and plain HTTP otherwise', () => {
  const [tls] = renderLayout({ caddy, units: [] }, SITE_BLOCK, undefined, PAGES);
  assert.equal(tls.text.match(/^\t\t\ttls_server_name door\.example\.test$/gm).length, 2, 'the forwarder snippet and the every-name block');
  const [plain] = renderLayout({ caddy: { ...caddy, door_upstream: 'http://127.0.0.1:9445', door_transport_routes: [] }, units: [] }, SITE_BLOCK, undefined, PAGES);
  assert.doesNotMatch(plain.text, /tls_server_name door\.example\.test/);
  assert.match(plain.text, /^\treverse_proxy http:\/\/127\.0\.0\.1:9445 \{[\s\S]*?\t\ttransport http \{\n\t\t\tread_timeout 3600s\n\t\t\twrite_timeout 3600s\n\t\t\}/m);
});

test('the front door names no old site: no proxy to another host, no redirect, and a signed-out marketplace answers 404', () => {
  const [file] = renderLayout({ caddy, units: [] }, SITE_BLOCK, undefined, PAGES);
  assert.doesNotMatch(file.text, /old_site|tls_server_name site\./);
  assert.doesNotMatch(file.text, /redir https?:\/\/(?!\{)/, 'no redirect to a named host');
  assert.match(file.text, /^\thandle \/marketplace \{[\s\S]*?\thandle \{\n\t\t\trespond 404\n\t\t\}\n\t\}$/m);
  assert.match(file.text, /^\t@page file \{\n\t\troot \/var\/lib\/front-door-pages\n\t\ttry_files \{path\} \{path\}\.html\n\t\}$/m);
});

test('a row with pages_root renders every page the request hands in under it, byte for byte, binary ones as base64', () => {
  const files = renderLayout({ caddy, units: [] }, SITE_BLOCK, undefined, PAGES).filter(file => file.path.startsWith('/var/lib/front-door-pages/'));
  assert.deepEqual(files.map(file => file.path), PAGES.map(page => `/var/lib/front-door-pages/${page.name}`).sort());
  for (const file of files) {
    const bytes = PAGES.find(page => file.path.endsWith(`/${page.name}`)).bytes;
    assert.ok((file.binary ? Buffer.from(file.text, 'base64') : Buffer.from(file.text, 'utf8')).equals(bytes), `${file.path} keeps its bytes`);
    assert.equal(Boolean(file.binary), !/\.(?:html|css|svg)$/.test(file.path));
  }
  assert.throws(() => renderLayout({ caddy, units: [] }, SITE_BLOCK), /needs the pages the request gives/);
  assert.throws(() => renderLayout({ caddy, units: [] }, SITE_BLOCK, undefined, []), /needs the pages the request gives/);
  const { pages_root, ...noRoot } = caddy;
  assert.throws(() => renderLayout({ caddy: noRoot, units: [] }, SITE_BLOCK, undefined, PAGES), /needs pages_root/);
});

test('readPages reads every file of the folder the request names, and nothing when it names none', () => {
  const folder = mkdtempSync(join(tmpdir(), 'pages-'));
  mkdirSync(join(folder, 'assets'));
  writeFileSync(join(folder, 'privacy.html'), 'one');
  writeFileSync(join(folder, 'assets', 'site.css'), Buffer.from([1, 2, 3]));
  const pages = readPages({ pages_folder: folder }).sort((a, b) => (a.name < b.name ? -1 : 1));
  assert.deepEqual(pages.map(page => [page.name, [...page.bytes]]), [['assets/site.css', [1, 2, 3]], ['privacy.html', [...Buffer.from('one')]]]);
  assert.equal(readPages({}), undefined);
  assert.throws(() => readPages({ pages_folder: 'relative/folder' }), /absolute path/);
});

test('applying a layout with pages writes a binary page through base64 and reads it back as base64', async () => {
  const commands = [];
  const run = async (_machine, command, input) => {
    commands.push({ command, input });
    if (command.startsWith('if [ -f ')) throw Object.assign(new Error('absent'), { code: 3 });
    if (command.includes('curl')) return '200';
    return '';
  };
  await applyHostLayout({ address: '192.0.2.9', ssh: { known_hosts: '/dev/null' } }, { caddy, units: [], unmanaged: [] }, run, undefined, {}, { pages: PAGES });
  const icon = commands.find(({ command }) => command.includes("/dev/stdin '/var/lib/front-door-pages/icon.png'"));
  assert.match(icon.command, /base64 -d \| install -m 0644 -o root -g root \/dev\/stdin/);
  assert.ok(Buffer.from(icon.input, 'base64').subarray(1, 4).toString() === 'PNG', 'the PNG signature arrives intact');
  assert.ok(commands.some(({ command }) => command === "if [ -f '/var/lib/front-door-pages/icon.png' ]; then base64 -w0 '/var/lib/front-door-pages/icon.png'; else exit 3; fi"));
  const page = commands.find(({ command }) => command.includes("/dev/stdin '/var/lib/front-door-pages/privacy.html'"));
  assert.doesNotMatch(page.command, /base64/);
});

test('a computer carried to the door (caddy.carried_computers) gets its /a/<address> routes sent to its tunnel\'s loopback port, ahead of the forwarder paths', () => {
  const carried = [{ address: 'a1b2c3d4e5f60718', port: 18790 }, { address: '0f9e8d7c6b5a4321', port: 18791 }];
  const [file] = renderLayout({ caddy: { ...caddy, carried_computers: carried }, units: [] }, SITE_BLOCK, undefined, PAGES);
  assert.doesNotMatch(file.text, /\{\{/);
  for (const { address, port } of carried) {
    assert.match(file.text, new RegExp(`^\\t@carried_${address} path /a/${address} /a/${address}/\\*\\n\\thandle @carried_${address} \\{\\n\\t\\treverse_proxy 127\\.0\\.0\\.1:${port} \\{\\n\\t\\t\\theader_up Host door\\.example\\.test\\n\\t\\t\\tflush_interval -1\\n\\t\\t\\}\\n\\t\\}$`, 'm'));
  }
  assert.ok(file.text.indexOf('@carried_a1b2c3d4e5f60718') < file.text.indexOf('@forwarder path'), 'a carried computer is routed before the forwarder\'s /a/* paths');
  const [none] = renderLayout({ caddy, units: [] }, SITE_BLOCK, undefined, PAGES);
  const [empty] = renderLayout({ caddy: { ...caddy, carried_computers: [] }, units: [] }, SITE_BLOCK, undefined, PAGES);
  assert.equal(empty.text, none.text);
  assert.doesNotMatch(none.text, /carried/);
  for (const bad of [{ address: 'a1b2c3d4 }\nrespond 200 {', port: 18790 }, { address: 'a1b2c3d4e5f60718', port: 0 }, { address: 'a1b2c3d4e5f60718', port: '18790' }, { address: 'short', port: 18790 }]) {
    assert.throws(() => renderLayout({ caddy: { ...caddy, carried_computers: [bad] }, units: [] }, SITE_BLOCK, undefined, PAGES), /caddy\.carried_computers needs each computer's address/);
  }
});

const single = {
  site_file: 'single-name-front-door', door_host: 'door.example.test', engine_listen: '127.0.0.1:7199', engine_paths: ['/a/*'], request_max: '4MB',
  pages_root: '/var/lib/front-door-pages', routes: ['better-auth', 'better-auth-pages', 'better-auth-well-known', 'better-auth-home'], engine_routes: ['engine'],
  auth_port: 8792, auth_page_paths: ['/sign-in', '/sign-in/*'],
};

test('a single-name front door renders its own name, pages, sign-in routes and engine paths, and no program, store or other host', () => {
  const [file] = renderLayout({ caddy: single, units: [] }, SITE_BLOCK, undefined, PAGES);
  assert.equal(file.path, '/etc/caddy/Caddyfile');
  assert.doesNotMatch(file.text, /\{\{/);
  assert.match(file.text, /^door\.example\.test \{$/m);
  assert.match(file.text, /^\t@engine path \/a\/\*\n\thandle @engine \{\n\t\treverse_proxy 127\.0\.0\.1:7199 \{\n\t\t\theader_up Host door\.example\.test$/m);
  assert.match(file.text, /^\thandle \/api\/auth\/\* \{\n\t\treverse_proxy 127\.0\.0\.1:8792\n\t\}$/m);
  assert.match(file.text, /^\thandle \/\.well-known\/oauth-protected-resource\* \{\n\t\treverse_proxy 127\.0\.0\.1:8792\n\t\}$/m);
  assert.match(file.text, /^\thandle \/ \{\n\t\tredir \* \/sign-in 302\n\t\}$/m);
  assert.doesNotMatch(file.text, /storage|on_demand|forwarder|old_site|trusted_proxies|tls_server_name/);
  assert.match(file.text, /^\t@page file \{\n\t\troot \/var\/lib\/front-door-pages\n/m);
  assert.match(file.text, /^\thandle \{\n\t\trespond "Not found" 404\n\t\}$/m);
});

test('a single-name front door without an engine route has no engine paths, and without its fields or pages root is refused', () => {
  const { engine_paths, ...noPaths } = single;
  assert.throws(() => renderLayout({ caddy: noPaths, units: [] }, SITE_BLOCK, undefined, PAGES), /needs engine_paths/);
  const [noEngine] = renderLayout({ caddy: { ...noPaths, engine_routes: [] }, units: [] }, SITE_BLOCK, undefined, PAGES);
  assert.doesNotMatch(noEngine.text, /@engine|7199/);
  const { pages_root, ...noRoot } = single;
  assert.throws(() => renderLayout({ caddy: noRoot, units: [] }, SITE_BLOCK, undefined, PAGES), /needs pages_root/);
});

test('a single-name front door sends a carried computer\'s /a/<address> to its tunnel port ahead of the engine paths, and a row with none leaves the slot out', () => {
  const [file] = renderLayout({ caddy: { ...single, carried_computers: [{ address: 'a1b2c3d4e5f60718', port: 18790 }] }, units: [] }, SITE_BLOCK, undefined, PAGES);
  assert.match(file.text, /^\t@carried_a1b2c3d4e5f60718 path \/a\/a1b2c3d4e5f60718 \/a\/a1b2c3d4e5f60718\/\*\n\thandle @carried_a1b2c3d4e5f60718 \{\n\t\treverse_proxy 127\.0\.0\.1:18790 \{/m);
  assert.ok(file.text.indexOf('@carried_a1b2c3d4e5f60718') < file.text.indexOf('@engine path'));
  const [none] = renderLayout({ caddy: single, units: [] }, SITE_BLOCK, undefined, PAGES);
  assert.doesNotMatch(none.text, /carried/);
});
