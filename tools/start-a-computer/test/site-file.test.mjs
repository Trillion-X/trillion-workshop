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
import { applyWhatItRuns, readPages, SITE_BLOCK } from '../do-work/start-a-computer.mjs';
import { renderWhatItRuns } from '../do-work/render-what-a-computer-runs.mjs';

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
  routes: ['better-auth'], pools: { auth: { listen: ['127.0.0.1:8792'], health_uri: '/readyz', health_interval: '1s', try_duration: '5s' } }, binary: '/opt/caddy/current/caddy', storage_env: '/etc/caddy/storage.env',
};

test('a caddy row that names a site file renders that whole file from the row, with its routes in their place', () => {
  const [file] = renderWhatItRuns({ caddy, units: [] }, SITE_BLOCK, PAGES);
  assert.equal(file.path, '/etc/caddy/Caddyfile');
  assert.doesNotMatch(file.text, /\{\{/);
  assert.match(file.text, /^door\.example\.test \{$/m);
  assert.match(file.text, /^\t@forwarder path \/mcp \/sign-up \/a\/\*$/m);
  assert.match(file.text, /^\thandle \/api\/auth\/\* \{\n\t\treverse_proxy 127\.0\.0\.1:8792 \{\n\t\t\tlb_policy first\n[\s\S]*?\n\t\t\}\n\t\}$/m);
  assert.doesNotMatch(file.text, /oauth-authorization-server\* \{/, 'discovery stays with the engine unless the row names better-auth-discovery');
  for (const own of ['{args[0]}', '{client_ip}', '{host}', '{uri}', '{$CADDY_STORAGE_PASSWORD}']) assert.ok(file.text.includes(own), `Caddy's ${own} is left as it is`);
  const lines = file.text.split('\n').length, templateLines = TEMPLATE.split('\n').length;
  assert.equal(lines, templateLines + 7, 'the routes slot grows by eight (the route block is nine lines with its pool) and the empty every-name slot line goes');
});

test('every other name\'s routes (every_name_routes) go first in the on-demand block, so an attached name reaches the sign-in tool', () => {
  const [file] = renderWhatItRuns({ caddy: { ...caddy, every_name_routes: ['better-auth'] }, units: [] }, SITE_BLOCK, PAGES);
  const onDemand = file.text.slice(file.text.indexOf('\nhttps:// {') + 1);
  assert.match(onDemand, /^https:\/\/ \{\n\ttls \{\n\t\ton_demand\n\t\}\n\thandle \/api\/auth\/\* \{\n\t\treverse_proxy 127\.0\.0\.1:8792 \{\n\t\t\tlb_policy first\n[\s\S]*?\n\t\t\}\n\t\}\n/);
  const [home] = renderWhatItRuns({ caddy: { ...caddy, routes: ['better-auth', 'better-auth-webauthn'] }, units: [] }, SITE_BLOCK, PAGES);
  assert.match(home.text, /^door\.example\.test \{[\s\S]*\thandle \/\.well-known\/webauthn \{\n\t\treverse_proxy 127\.0\.0\.1:8792 \{\n\t\t\tlb_policy first\n[\s\S]*?\n\t\t\}\n\t\}[\s\S]*\nhttps:\/\/ \{/m);
});

test('a routes slot the row leaves empty is no line at all, so a row without every_name_routes renders the file as before', () => {
  const [without] = renderWhatItRuns({ caddy, units: [] }, SITE_BLOCK, PAGES);
  const [empty] = renderWhatItRuns({ caddy: { ...caddy, every_name_routes: [] }, units: [] }, SITE_BLOCK, PAGES);
  assert.equal(empty.text, without.text);
  assert.doesNotMatch(without.text, /^https:\/\/ \{\n\ttls \{\n\t\ton_demand\n\t\}\n\n/m);
  assert.throws(() => renderWhatItRuns({ caddy: { ...caddy, every_name_routes: ['nope'] }, units: [] }, SITE_BLOCK, PAGES), /caddy\.routes names an unknown route nope/);
});

test('a site file field the row does not give, or an unknown site file, is refused', () => {
  const { door_host, ...noHost } = caddy;
  assert.throws(() => renderWhatItRuns({ caddy: { ...noHost, door_transport_routes: [] }, units: [] }, SITE_BLOCK, PAGES), /caddy site file serving-computer-front-door needs door_host/);
  assert.throws(() => renderWhatItRuns({ caddy: noHost, units: [] }, SITE_BLOCK, PAGES), /caddy route door-over-tls needs door_host/);
  assert.throws(() => renderWhatItRuns({ caddy: { ...caddy, site_file: 'nope' }, units: [] }, SITE_BLOCK, PAGES), /unknown site file nope/);
});

test('applying a site file validates it with the row\'s Caddy and storage environment before it replaces the live one', async () => {
  const commands = [];
  const run = async (_machine, command) => {
    commands.push(command);
    if (command.startsWith('if [ -f ')) throw Object.assign(new Error('absent'), { code: 3 });
    if (command.includes('curl')) return '200';
    return '';
  };
  await applyWhatItRuns({ address: '192.0.2.9', ssh: { known_hosts: '/dev/null' } }, { caddy, units: [], unmanaged: [] }, run, {}, { pages: PAGES });
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
    unit: 'example-sign-in.service', template: 'tools/start-a-computer/read-data/unit-templates/serve-better-auth.service', description: 'Example sign-in', user: 'example-sign-in',
    state: '/var/lib/example-sign-in', workshop: '/opt/example-workshop', repository: 'https://example.test/workshop.git',
    tool_folder: 'tools/better-auth-official', workshop_commit: '7777777777777777777777777777777777777777', node_bin: '/opt/node/bin', settings_file: '/etc/example/settings.json', settings: { port: 8792 },
    secret_vault_key: 'example-secret', secret_name: 'example-secret', secret_file: '/etc/credstore.encrypted/example-secret', credentials: [{ vault_key: 'example-store', name: 'sign-in-store', file: '/etc/credstore.encrypted/sign-in-store', env: 'BETTER_AUTH_STORE_CONNECTION' }], writable: '/var/lib/example-sign-in',
  };
  const runs = { caddy, units: [unit], unmanaged: [], health: { path: '/api/auth/ok', status: 200, where: 'machine' }, health_listen: '127.0.0.1:8792' };
  const answer = await applyWhatItRuns({ address: '192.0.2.9', ssh: { known_hosts: '/dev/null' } }, runs, run, { 'example-secret': 'made-up', 'example-store': 'made-up-store' }, { pages: PAGES });
  assert.deepEqual(answer.booted, ['example-sign-in.service']);
  const health = commands.find(command => command.startsWith('curl '));
  assert.equal(health, "curl -s -o /dev/null -w '%{http_code}' 'http://127.0.0.1:8792/api/auth/ok' || true");
});

test('better-auth-pages sends the sign-in tool every address its own routes file lists, and a row that names the paths is refused', () => {
  const [file] = renderWhatItRuns({ caddy: { ...caddy, routes: ['better-auth', 'better-auth-pages'] }, units: [] }, SITE_BLOCK, PAGES);
  const matcher = file.text.match(/^\t@better_auth_pages path (.*)$/m)[1].split(' ');
  const listed = JSON.parse(readFileSync(new URL('../../better-auth-official/pages/routes.json', import.meta.url), 'utf8')).routes.map(({ path }) => path);
  for (const path of listed) assert.ok(matcher.includes(path) && matcher.includes(`${path}/*`), path);
  for (const path of ['/connected', '/consent', '/device', '/sign-in']) assert.ok(matcher.includes(path), `${path} is routed to the tool`);
  assert.match(file.text, /\n\thandle @better_auth_pages \{\n\t\treverse_proxy 127\.0\.0\.1:8792 \{\n\t\t\tlb_policy first\n[\s\S]*?\n\t\t\}\n\t\}/);
  assert.throws(() => renderWhatItRuns({ caddy: { ...caddy, routes: ['better-auth-pages'], auth_page_paths: ['/sign-in'] }, units: [] }, SITE_BLOCK, PAGES), /auth_page_paths is gone/);
});

test('the door upstream carries TLS and its server name only when the row names door-over-tls, and plain HTTP otherwise', () => {
  const [tls] = renderWhatItRuns({ caddy, units: [] }, SITE_BLOCK, PAGES);
  assert.equal(tls.text.match(/^\t\t\ttls_server_name door\.example\.test$/gm).length, 2, 'the forwarder snippet and the every-name block');
  const [plain] = renderWhatItRuns({ caddy: { ...caddy, door_upstream: 'http://127.0.0.1:9445', door_transport_routes: [] }, units: [] }, SITE_BLOCK, PAGES);
  assert.doesNotMatch(plain.text, /tls_server_name door\.example\.test/);
  assert.match(plain.text, /^\treverse_proxy http:\/\/127\.0\.0\.1:9445 \{[\s\S]*?\t\ttransport http \{\n\t\t\tread_timeout 3600s\n\t\t\twrite_timeout 3600s\n\t\t\}/m);
});

test('the front door names no old site: no proxy to another host, no redirect, and a signed-out marketplace answers 404', () => {
  const [file] = renderWhatItRuns({ caddy, units: [] }, SITE_BLOCK, PAGES);
  assert.doesNotMatch(file.text, /old_site|tls_server_name site\./);
  assert.doesNotMatch(file.text, /redir https?:\/\/(?!\{)/, 'no redirect to a named host');
  assert.match(file.text, /^\thandle \/marketplace \{[\s\S]*?\thandle \{\n\t\t\trespond 404\n\t\t\}\n\t\}$/m);
  assert.match(file.text, /^\t@page file \{\n\t\troot \/var\/lib\/front-door-pages\n\t\ttry_files \{path\} \{path\}\.html\n\t\}$/m);
});

test('a row with pages_root renders every page the request hands in under it, byte for byte, binary ones as base64', () => {
  const files = renderWhatItRuns({ caddy, units: [] }, SITE_BLOCK, PAGES).filter(file => file.path.startsWith('/var/lib/front-door-pages/'));
  assert.deepEqual(files.map(file => file.path), PAGES.map(page => `/var/lib/front-door-pages/${page.name}`).sort());
  for (const file of files) {
    const bytes = PAGES.find(page => file.path.endsWith(`/${page.name}`)).bytes;
    assert.ok((file.binary ? Buffer.from(file.text, 'base64') : Buffer.from(file.text, 'utf8')).equals(bytes), `${file.path} keeps its bytes`);
    assert.equal(Boolean(file.binary), !/\.(?:html|css|svg)$/.test(file.path));
  }
  assert.throws(() => renderWhatItRuns({ caddy, units: [] }, SITE_BLOCK), /needs the pages the request gives/);
  assert.throws(() => renderWhatItRuns({ caddy, units: [] }, SITE_BLOCK, []), /needs the pages the request gives/);
  const { pages_root, ...noRoot } = caddy;
  assert.throws(() => renderWhatItRuns({ caddy: noRoot, units: [] }, SITE_BLOCK, PAGES), /needs pages_root/);
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

test('applying a row with pages writes a binary page through base64 and reads it back as base64', async () => {
  const commands = [];
  const run = async (_machine, command, input) => {
    commands.push({ command, input });
    if (command.startsWith('if [ -f ')) throw Object.assign(new Error('absent'), { code: 3 });
    if (command.includes('curl')) return '200';
    return '';
  };
  await applyWhatItRuns({ address: '192.0.2.9', ssh: { known_hosts: '/dev/null' } }, { caddy, units: [], unmanaged: [] }, run, {}, { pages: PAGES });
  const icon = commands.find(({ command }) => command.includes("/dev/stdin '/var/lib/front-door-pages/icon.png'"));
  assert.match(icon.command, /base64 -d \| install -m 0644 -o root -g root \/dev\/stdin/);
  assert.ok(Buffer.from(icon.input, 'base64').subarray(1, 4).toString() === 'PNG', 'the PNG signature arrives intact');
  assert.ok(commands.some(({ command }) => command === "if [ -f '/var/lib/front-door-pages/icon.png' ]; then base64 -w0 '/var/lib/front-door-pages/icon.png'; else exit 3; fi"));
  const page = commands.find(({ command }) => command.includes("/dev/stdin '/var/lib/front-door-pages/privacy.html'"));
  assert.doesNotMatch(page.command, /base64/);
});

const single = {
  site_file: 'single-name-front-door', door_host: 'door.example.test', engine_paths: ['/a/*'], request_max: '4MB',
  pages_root: '/var/lib/front-door-pages', routes: ['better-auth', 'better-auth-pages', 'better-auth-discovery', 'better-auth-home'], engine_routes: ['engine'],
  grace_period: '150s', pools: { auth: { listen: ['127.0.0.1:8792'], health_uri: '/readyz', health_interval: '1s', try_duration: '5s' },
    engine: { listen: ['127.0.0.1:7199', '127.0.0.1:7198'], health_uri: '/readyz', health_interval: '1s', try_duration: '5s', lines: ['header_up Host {door_host}', 'flush_interval -1'] } },
};

test('a single-name front door renders its own name, pages, sign-in routes and engine paths, and no program, store or other host', () => {
  const [file] = renderWhatItRuns({ caddy: single, units: [] }, SITE_BLOCK, PAGES);
  assert.equal(file.path, '/etc/caddy/Caddyfile');
  assert.doesNotMatch(file.text, /\{\{/);
  assert.match(file.text, /^door\.example\.test \{$/m);
  assert.match(file.text, /^\t\treverse_proxy 127\.0\.0\.1:7199 127\.0\.0\.1:7198 \{\n\t\t\theader_up Host door\.example\.test\n\t\t\tflush_interval -1\n\t\t\tlb_policy first\n\t\t\tlb_try_duration 5s\n\t\t\thealth_uri \/readyz\n\t\t\thealth_interval 1s\n/m,
    'every slot of the engine is an upstream; the first that answers its health page takes each call');
  assert.match(file.text, /^\t@engine path \/a\/\*\n\thandle @engine \{\n/m);
  assert.match(file.text, /^\tgrace_period 150s$/m);
  assert.match(file.text, /^\thandle \/api\/auth\/\* \{\n\t\treverse_proxy 127\.0\.0\.1:8792 \{\n\t\t\tlb_policy first\n[\s\S]*?\n\t\t\}\n\t\}$/m);
  assert.match(file.text, /^\thandle \/\.well-known\/oauth-authorization-server\* \{\n\t\treverse_proxy 127\.0\.0\.1:8792 \{\n\t\t\tlb_policy first\n[\s\S]*?\n\t\t\}\n\t\}$/m);
  assert.doesNotMatch(file.text, /oauth-protected-resource/, 'the protected-resource document is the engine\'s, carried, never the sign-in tool\'s');
  assert.match(file.text, /^\thandle \/ \{\n\t\tredir \* \/sign-in 302\n\t\}$/m);
  assert.doesNotMatch(file.text, /storage|on_demand|forwarder|old_site|trusted_proxies|tls_server_name/);
  assert.match(file.text, /^\t@page file \{\n\t\troot \/var\/lib\/front-door-pages\n/m);
  assert.match(file.text, /^\thandle \{\n\t\trespond "Not found" 404\n\t\}$/m);
  // the access log keeps a request's method, its address without the query and its status, and no header, client address or cookie
  assert.match(file.text, /^\tlog \{\n\t\toutput stdout\n\t\tformat filter \{\n\t\t\twrap json\n/m);
  assert.match(file.text, /request>uri regexp "\\\?\.\*" ""/);
  for (const field of ['request>headers', 'request>remote_ip', 'request>client_ip', 'resp_headers']) assert.match(file.text, new RegExp(`${field} delete`));
});

test('a single-name front door without an engine route has no engine paths, and without its fields or pages root is refused', () => {
  const { engine_paths, ...noPaths } = single;
  assert.throws(() => renderWhatItRuns({ caddy: noPaths, units: [] }, SITE_BLOCK, PAGES), /needs engine_paths/);
  const [noEngine] = renderWhatItRuns({ caddy: { ...noPaths, engine_routes: [] }, units: [] }, SITE_BLOCK, PAGES);
  assert.doesNotMatch(noEngine.text, /@engine|7199/);
  const { pages_root, ...noRoot } = single;
  assert.throws(() => renderWhatItRuns({ caddy: noRoot, units: [] }, SITE_BLOCK, PAGES), /needs pages_root/);
});

test('a meeting point renders its way row\'s host half once for every computer, with the commands that follow a change', () => {
  const runs = { caddy: single, units: [], meeting_point: { way: 'ssh-certificate', values: { ca_public_file: '/var/lib/example/meeting-ca.key.pub', port_min: 20000, port_max: 59999 } } };
  const files = renderWhatItRuns(runs, SITE_BLOCK, PAGES);
  const ssh = files.find(file => file.path === '/etc/ssh/sshd_config.d/carry.conf');
  assert.match(ssh.text, /^Match User carry\n    TrustedUserCAKeys \/var\/lib\/example\/meeting-ca\.key\.pub\n/);
  assert.deepEqual(ssh.then.map(argv => argv[0]), ['sh', '/usr/sbin/sshd', 'systemctl']);
  assert.throws(() => renderWhatItRuns({ ...runs, meeting_point: { way: 'no-such-way' } }, SITE_BLOCK, PAGES), /unknown way no-such-way/);
  assert.throws(() => renderWhatItRuns({ ...runs, meeting_point: { way: 'ssh-certificate', values: {} } }, SITE_BLOCK, PAGES), /needs ca_public_file/);
});
