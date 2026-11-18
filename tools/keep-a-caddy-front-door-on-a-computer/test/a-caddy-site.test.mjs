// tools/keep-a-caddy-front-door-on-a-computer/test/a-caddy-site.test.mjs
//
// A Caddy unit's `site` made into the files the computer runs: one block per name, or a whole site file (sites/) filled from the
// site, each {{field}} the site's value, {{routes}} its routes, Caddy's own {placeholders} untouched; the pages it answers; the
// pools and inner doors; and how each file is applied (the site file checked by the site's Caddy, then a reload).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { prepare } from '../prepare-a-caddy-site.mjs';

// The pages a request hands in (the person's own folder): this kit holds none.
const PAGES = [
  { name: 'privacy.html', bytes: Buffer.from('<html><body>Example privacy page</body></html>') },
  { name: 'assets/site.css', bytes: Buffer.from('body { margin: 0 }') },
  { name: 'icon.png', bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff]) },
];
const ENGINE = 'tools/keep-a-caddy-front-door-on-a-computer/routes/engine.caddy';
const filesOf = async (site, pages = PAGES) => (await prepare({ unit: 'caddy.service', user: 'caddy', site }, { pages })).unit.files;
const siteFile = async (site, pages) => (await filesOf(site, pages))[0];

const BLOCK = readFileSync(new URL('../sites/one-block-per-name.caddy', import.meta.url), 'utf8').trimEnd();
const names = { site_hosts: ['place.example.test', 'www.example.test'], port: 7199 };
const auth = { auth: { listen: ['127.0.0.1:7201'], health_uri: '/readyz', health_interval: '1s', try_duration: '5s' } };

test('the site file is one block per name, with the port, checked by the site\'s Caddy and applied by a reload', async () => {
  const file = await siteFile(names);
  assert.equal(file.path, '/etc/caddy/Caddyfile');
  const block = host => `${BLOCK.replace('{SITE}', host).replace('{PORT}', '7199')}\n`;
  assert.equal(file.text, block('place.example.test') + block('www.example.test'));
  assert.deepEqual(file.check, ['caddy', 'validate', '--config', '{file}', '--adapter', 'caddyfile']);
  assert.deepEqual(file.then, [['systemctl', 'reload', 'caddy.service']]);
  assert.equal((await siteFile({ ...names, binary: '/opt/example/caddy' })).check[0], '/opt/example/caddy', 'the Caddy that checks is the one the site runs');
});

test('the unit keeps its own fields, and a unit with no site is refused', async () => {
  const { unit } = await prepare({ unit: 'caddy.service', user: 'caddy', drop_ins: ['example.conf'], storage_env: '/etc/example.env', site: names });
  assert.deepEqual(Object.keys(unit).sort(), ['drop_ins', 'files', 'storage_env', 'unit', 'user']);
  await assert.rejects(prepare({ unit: 'caddy.service' }), /unit caddy\.service needs site/);
});

test('the sign-in routes go first inside every block, sent to the pool the site names', async () => {
  const file = await siteFile({ ...names, routes: ['tools/better-auth-official/on-a-computer/caddy-route-better-auth.caddy', 'tools/better-auth-official/on-a-computer/caddy-route-better-auth-discovery.caddy'], pools: auth });
  for (const host of names.site_hosts) {
    const block = file.text.slice(file.text.indexOf(`${host} {`));
    assert.match(block, /^\thandle \/api\/auth\/\* \{\n\t\treverse_proxy 127\.0\.0\.1:7201 \{\n\t\t\tlb_policy first\n[\s\S]*?\n\t\t\}\n\t\}$/m);
    assert.match(block, /^\thandle \/\.well-known\/oauth-authorization-server\* \{\n\t\treverse_proxy 127\.0\.0\.1:7201 \{\n\t\t\tlb_policy first\n[\s\S]*?\n\t\t\}\n\t\}$/m);
    assert.ok(block.indexOf('handle /api/auth/*') < block.indexOf('reverse_proxy 127.0.0.1:7199'), 'the auth routes sit inside the block, before the catch-all');
  }
  assert.doesNotMatch((await siteFile(names)).text, /api\/auth/);
  await assert.rejects(siteFile({ ...names, routes: ['nope'] }), /names a file that does not exist: nope/);
  await assert.rejects(siteFile({ ...names, routes: ['tools/better-auth-official/on-a-computer/caddy-route-better-auth.caddy'] }), /caddy-route-better-auth\.caddy needs auth_proxy/);
});

test('better-auth-pages sends the sign-in tool every address its own routes file lists', async () => {
  const file = await siteFile({ ...names, routes: ['tools/better-auth-official/on-a-computer/caddy-route-better-auth.caddy', 'tools/better-auth-official/on-a-computer/caddy-route-better-auth-pages.mjs'], pools: auth });
  const matcher = file.text.match(/^\t@better_auth_pages path (.*)$/m)[1].split(' ');
  const listed = JSON.parse(readFileSync(new URL('../../better-auth-official/pages/routes.json', import.meta.url), 'utf8')).routes.map(({ path }) => path);
  for (const path of listed) assert.ok(matcher.includes(path) && matcher.includes(`${path}/*`), path);
  for (const path of ['/connected', '/consent', '/device', '/sign-in']) assert.ok(matcher.includes(path), `${path} is routed to the tool`);
});

test('an inner door is a loopback address Caddy holds for programs on this computer, sent to every slot of a pool', async () => {
  const pools = { internal: { listen: ['127.0.0.1:8794', '127.0.0.1:8795'], health_uri: '/readyz', health_interval: '1s', try_duration: '5s' } };
  assert.match((await siteFile({ ...names, pools, inner_doors: [{ listen: '127.0.0.1:8793', pool: 'internal' }] })).text, /\nhttp:\/\/:8793 \{\n\tbind 127\.0\.0\.1\n\treverse_proxy 127\.0\.0\.1:8794 127\.0\.0\.1:8795 \{\n\t\t\tlb_policy first\n/);
  await assert.rejects(siteFile({ ...names, pools, inner_doors: [{ listen: '0.0.0.0:8793', pool: 'internal' }] }), /loopback address only/);
  await assert.rejects(siteFile({ ...names, pools, inner_doors: [{ listen: '127.0.0.1:8793', pool: 'none' }] }), /names no pool/);
});

const single = {
  site_file: 'single-name-front-door', door_host: 'door.example.test', engine_paths: ['/a/*'], request_max: '4MB',
  pages_root: '/var/lib/front-door-pages', routes: ['tools/better-auth-official/on-a-computer/caddy-route-better-auth.caddy', 'tools/better-auth-official/on-a-computer/caddy-route-better-auth-pages.mjs', 'tools/better-auth-official/on-a-computer/caddy-route-better-auth-discovery.caddy', 'tools/better-auth-official/on-a-computer/caddy-route-better-auth-home.caddy'], engine_routes: [ENGINE],
  grace_period: '150s', pools: { auth: { listen: ['127.0.0.1:8792'], health_uri: '/readyz', health_interval: '1s', try_duration: '5s' },
    engine: { listen: ['127.0.0.1:7199', '127.0.0.1:7198'], health_uri: '/readyz', health_interval: '1s', try_duration: '5s', lines: ['header_up Host {door_host}', 'flush_interval -1'] } },
};

test('a single-name front door renders its own name, pages, sign-in routes and engine paths, and no program, store or other host', async () => {
  const file = await siteFile(single);
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

test('a routes slot the site leaves empty is no line at all; a missing field or an unknown site file is refused', async () => {
  const { engine_paths, ...noPaths } = single;
  await assert.rejects(siteFile(noPaths), /routes\/engine\.caddy needs engine_paths/);
  const noEngine = await siteFile({ ...noPaths, engine_routes: [] });
  assert.doesNotMatch(noEngine.text, /@engine|7199/);
  assert.doesNotMatch(noEngine.text, /^\{\{engine_routes\}\}$/m);
  await assert.rejects(siteFile({ ...single, engine_routes: ['nope'] }), /names a file that does not exist: nope/);
  const { door_host, ...noHost } = single;
  await assert.rejects(siteFile({ ...noHost, engine_routes: [], pools: { auth: single.pools.auth } }), /caddy site file single-name-front-door needs door_host/);
  await assert.rejects(siteFile({ ...single, site_file: 'nope' }), /unknown site file nope/);
});

test('every page the request hands in lands under pages_root, byte for byte, binary ones as base64, and restarts nothing', async () => {
  const files = (await filesOf(single)).filter(file => file.path.startsWith('/var/lib/front-door-pages/'));
  assert.deepEqual(files.map(file => file.path), PAGES.map(page => `/var/lib/front-door-pages/${page.name}`).sort());
  for (const file of files) {
    const bytes = PAGES.find(page => file.path.endsWith(`/${page.name}`)).bytes;
    assert.ok((file.binary ? Buffer.from(file.text, 'base64') : Buffer.from(file.text, 'utf8')).equals(bytes), `${file.path} keeps its bytes`);
    assert.equal(Boolean(file.binary), !/\.(?:html|css|svg)$/.test(file.path));
    assert.deepEqual(file.then, [], 'a page is applied by being written');
  }
  await assert.rejects(prepare({ unit: 'caddy.service', site: single }), /needs the pages the request gives/);
  await assert.rejects(filesOf(single, []), /needs the pages the request gives/);
  const { pages_root, ...noRoot } = single;
  await assert.rejects(siteFile(noRoot), /needs pages_root/);
});
