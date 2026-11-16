// tools/start-a-computer/test/site-file.test.mjs
//
// A computer whose caddy row names a whole site file (read-data/caddy-sites) gets exactly that file filled from the row:
// each {{field}} the row's value, {{routes}} the row's routes, Caddy's own {placeholders} untouched. Applying it validates
// with the Caddy the row names and the storage environment the file reads.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyHostLayout, SITE_BLOCK } from '../do-work/start-a-computer.mjs';
import { renderLayout } from '../do-work/render-layout.mjs';

const TEMPLATE = readFileSync(new URL('../read-data/caddy-sites/serving-computer-front-door.caddy', import.meta.url), 'utf8');
const caddy = {
  site_file: 'serving-computer-front-door', storage_key_prefix: 'caddy', storage_server_cert: '/etc/caddy/storage-server.crt',
  ask_port: 9444, ask_path: '/origins/certificate',
  door_upstream: 'https://127.0.0.1:9443', door_transport_routes: ['door-over-tls'], door_host: 'door.example.test',
  engine_listen: '127.0.0.1:18789', request_max: '4MB', forwarder_paths: ['/mcp', '/sign-up', '/a/*'],
  pages_root: '/var/lib/front-door-pages', founder_name: 'Example Person', founder_url: 'https://person.example.test', contact_email: 'hello@example.test', downloads_root: '/var/lib/public-downloads', download_default: '/download/App.dmg',
  routes: ['better-auth'], auth_port: 8792, binary: '/opt/caddy/current/caddy', storage_env: '/etc/caddy/storage.env',
};

test('a caddy row that names a site file renders that whole file from the row, with its routes in their place', () => {
  const [file] = renderLayout({ caddy, units: [] }, SITE_BLOCK);
  assert.equal(file.path, '/etc/caddy/Caddyfile');
  assert.doesNotMatch(file.text, /\{\{/);
  assert.match(file.text, /^door\.example\.test \{$/m);
  assert.match(file.text, /^\t@forwarder path \/mcp \/sign-up \/a\/\*$/m);
  assert.match(file.text, /^\thandle \/api\/auth\/\* \{\n\t\treverse_proxy 127\.0\.0\.1:8792\n\t\}$/m);
  assert.doesNotMatch(file.text, /oauth-authorization-server\* \{/, 'discovery stays with the engine unless the row names better-auth-discovery');
  for (const own of ['{args[0]}', '{client_ip}', '{host}', '{uri}', '{$CADDY_STORAGE_PASSWORD}']) assert.ok(file.text.includes(own), `Caddy's ${own} is left as it is`);
  const lines = file.text.split('\n').length, templateLines = TEMPLATE.split('\n').length;
  assert.equal(lines, templateLines + 1, 'the routes slot grows by two (the route block is three lines) and the empty every-name slot line goes');
});

test('every other name\'s routes (every_name_routes) go first in the on-demand block, so an attached name reaches the sign-in tool', () => {
  const [file] = renderLayout({ caddy: { ...caddy, every_name_routes: ['better-auth'] }, units: [] }, SITE_BLOCK);
  const onDemand = file.text.slice(file.text.indexOf('\nhttps:// {') + 1);
  assert.match(onDemand, /^https:\/\/ \{\n\ttls \{\n\t\ton_demand\n\t\}\n\thandle \/api\/auth\/\* \{\n\t\treverse_proxy 127\.0\.0\.1:8792\n\t\}\n/);
  const [home] = renderLayout({ caddy: { ...caddy, routes: ['better-auth', 'better-auth-webauthn'] }, units: [] }, SITE_BLOCK);
  assert.match(home.text, /^door\.example\.test \{[\s\S]*\thandle \/\.well-known\/webauthn \{\n\t\treverse_proxy 127\.0\.0\.1:8792\n\t\}[\s\S]*\nhttps:\/\/ \{/m);
});

test('a routes slot the row leaves empty is no line at all, so a row without every_name_routes renders the file as before', () => {
  const [without] = renderLayout({ caddy, units: [] }, SITE_BLOCK);
  const [empty] = renderLayout({ caddy: { ...caddy, every_name_routes: [] }, units: [] }, SITE_BLOCK);
  assert.equal(empty.text, without.text);
  assert.doesNotMatch(without.text, /^https:\/\/ \{\n\ttls \{\n\t\ton_demand\n\t\}\n\n/m);
  assert.throws(() => renderLayout({ caddy: { ...caddy, every_name_routes: ['nope'] }, units: [] }, SITE_BLOCK), /caddy\.routes names an unknown route nope/);
});

test('a site file field the row does not give, or an unknown site file, is refused', () => {
  const { door_host, ...noHost } = caddy;
  assert.throws(() => renderLayout({ caddy: { ...noHost, door_transport_routes: [] }, units: [] }, SITE_BLOCK), /caddy site file serving-computer-front-door needs door_host/);
  assert.throws(() => renderLayout({ caddy: noHost, units: [] }, SITE_BLOCK), /caddy route door-over-tls needs door_host/);
  assert.throws(() => renderLayout({ caddy: { ...caddy, site_file: 'nope' }, units: [] }, SITE_BLOCK), /unknown site file nope/);
});

test('applying a site file validates it with the row\'s Caddy and storage environment before it replaces the live one', async () => {
  const commands = [];
  const run = async (_machine, command) => {
    commands.push(command);
    if (command.startsWith('if [ -f ')) throw Object.assign(new Error('absent'), { code: 3 });
    if (command.includes('curl')) return '200';
    return '';
  };
  await applyHostLayout({ address: '192.0.2.9', ssh: { known_hosts: '/dev/null' } }, { caddy, units: [], unmanaged: [] }, run);
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
  const answer = await applyHostLayout({ address: '192.0.2.9', ssh: { known_hosts: '/dev/null' } }, layout, run, undefined, { 'example-secret': 'made-up' });
  assert.deepEqual(answer.booted, ['example-sign-in.service']);
  const health = commands.find(command => command.startsWith('curl '));
  assert.equal(health, "curl -s -o /dev/null -w '%{http_code}' 'http://127.0.0.1:8792/api/auth/ok' || true");
});

test('better-auth-pages sends the paths the row names in auth_page_paths to the sign-in tool, and needs them', () => {
  const paths = ['/sign-in', '/sign-in/*', '/sign-up', '/sign-up/*'];
  const [file] = renderLayout({ caddy: { ...caddy, routes: ['better-auth', 'better-auth-pages'], auth_page_paths: paths }, units: [] }, SITE_BLOCK);
  assert.match(file.text, /^\t@better_auth_pages path \/sign-in \/sign-in\/\* \/sign-up \/sign-up\/\*\n\thandle @better_auth_pages \{\n\t\treverse_proxy 127\.0\.0\.1:8792\n\t\}$/m);
  assert.throws(() => renderLayout({ caddy: { ...caddy, routes: ['better-auth-pages'] }, units: [] }, SITE_BLOCK), /caddy route better-auth-pages needs auth_page_paths/);
});

test('the door upstream carries TLS and its server name only when the row names door-over-tls, and plain HTTP otherwise', () => {
  const [tls] = renderLayout({ caddy, units: [] }, SITE_BLOCK);
  assert.equal(tls.text.match(/^\t\t\ttls_server_name door\.example\.test$/gm).length, 2, 'the forwarder snippet and the every-name block');
  const [plain] = renderLayout({ caddy: { ...caddy, door_upstream: 'http://127.0.0.1:9445', door_transport_routes: [] }, units: [] }, SITE_BLOCK);
  assert.doesNotMatch(plain.text, /tls_server_name door\.example\.test/);
  assert.match(plain.text, /^\treverse_proxy http:\/\/127\.0\.0\.1:9445 \{[\s\S]*?\t\ttransport http \{\n\t\t\tread_timeout 3600s\n\t\t\twrite_timeout 3600s\n\t\t\}/m);
});

test('the front door names no old site: no proxy to another host, no redirect, and a signed-out marketplace answers 404', () => {
  const [file] = renderLayout({ caddy, units: [] }, SITE_BLOCK);
  assert.doesNotMatch(file.text, /old_site|gettrillion\.ai|tls_server_name site\./);
  assert.doesNotMatch(file.text, /redir https?:\/\/(?!\{)/, 'no redirect to a named host');
  assert.match(file.text, /^\thandle \/marketplace \{[\s\S]*?\thandle \{\n\t\t\trespond 404\n\t\t\}\n\t\}$/m);
  assert.match(file.text, /^\t@page file \{\n\t\troot \/var\/lib\/front-door-pages\n\t\ttry_files \{path\} \{path\}\.html\n\t\}$/m);
});

test('a row with pages_root renders every page file of read-data/old-trillion-pages under it, byte for byte, binary ones as base64', () => {
  const folder = new URL('../read-data/old-trillion-pages/', import.meta.url);
  const names = readdirSync(folder, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile())
    .map(entry => relative(fileURLToPath(folder), `${entry.parentPath}/${entry.name}`)).sort();
  const files = renderLayout({ caddy, units: [] }, SITE_BLOCK).filter(file => file.path.startsWith('/var/lib/front-door-pages/'));
  assert.deepEqual(files.map(file => file.path), names.map(name => `/var/lib/front-door-pages/${name}`).sort());
  for (const name of ['privacy.html', 'terms.html', 'assets/build/index-Bt5gR37j.css', 'icon.png', 'features/tools.jpg']) assert.ok(names.includes(name), `${name} is taken over`);
  for (const file of files) {
    const bytes = readFileSync(new URL(file.path.slice('/var/lib/front-door-pages/'.length), folder));
    const rendered = file.binary ? Buffer.from(file.text, 'base64') : Buffer.from(file.text.replace('Example Person', '{{founder_name}}').replace('https://person.example.test', '{{founder_url}}').replace('hello@example.test', '{{contact_email}}'), 'utf8');
    assert.ok(rendered.equals(bytes), `${file.path} keeps its bytes`);
    assert.equal(Boolean(file.binary), !/\.(?:html|css|svg)$/.test(file.path));
  }
  assert.throws(() => renderLayout({ caddy: { ...caddy, pages_root: undefined }, units: [] }, SITE_BLOCK), /needs pages_root/);
  const privacy = files.find(file => file.path.endsWith('/privacy.html')).text;
  assert.ok(privacy.includes('"name":"Example Person","url":"https://person.example.test"') && privacy.includes('hello@example.test'), 'the names and the contact address are the row\'s, filled into the pages');
  assert.doesNotMatch(privacy, /\{\{/);
  const { contact_email, ...noContact } = caddy;
  assert.throws(() => renderLayout({ caddy: noContact, units: [] }, SITE_BLOCK), /page privacy\.html needs contact_email/);
});

test('applying a layout with pages writes a binary page through base64 and reads it back as base64', async () => {
  const commands = [];
  const run = async (_machine, command, input) => {
    commands.push({ command, input });
    if (command.startsWith('if [ -f ')) throw Object.assign(new Error('absent'), { code: 3 });
    if (command.includes('curl')) return '200';
    return '';
  };
  await applyHostLayout({ address: '192.0.2.9', ssh: { known_hosts: '/dev/null' } }, { caddy, units: [], unmanaged: [] }, run);
  const icon = commands.find(({ command }) => command.includes("/dev/stdin '/var/lib/front-door-pages/icon.png'"));
  assert.match(icon.command, /base64 -d \| install -m 0644 -o root -g root \/dev\/stdin/);
  assert.ok(Buffer.from(icon.input, 'base64').subarray(1, 4).toString() === 'PNG', 'the PNG signature arrives intact');
  assert.ok(commands.some(({ command }) => command === "if [ -f '/var/lib/front-door-pages/icon.png' ]; then base64 -w0 '/var/lib/front-door-pages/icon.png'; else exit 3; fi"));
  const page = commands.find(({ command }) => command.includes("/dev/stdin '/var/lib/front-door-pages/privacy.html'"));
  assert.doesNotMatch(page.command, /base64/);
});
