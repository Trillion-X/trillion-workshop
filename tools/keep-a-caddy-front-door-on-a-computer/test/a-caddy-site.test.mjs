// tools/keep-a-caddy-front-door-on-a-computer/test/a-caddy-site.test.mjs
//
// A Caddy unit's `site` made into the files the computer runs: one block per name, or a whole site file (sites/) filled from the
// site, each {{field}} the site's value, {{routes}} its routes, Caddy's own {placeholders} untouched; the pages it answers; the
// pools and inner doors; and how each file is applied (the site file checked by the site's Caddy, then a reload).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { prepare } from '../prepare-a-caddy-site.mjs';

// The pages a request hands in (the person's own folder): this kit holds none.
const PAGES = [
  { name: 'privacy.html', bytes: Buffer.from('<html><body>Example privacy page</body></html>') },
  { name: 'assets/site.css', bytes: Buffer.from('body { margin: 0 }') },
  { name: 'icon.png', bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff]) },
];
const ENGINE = 'tools/keep-an-engine-on-a-computer/caddy-route-engine.caddy';
const filesOf = async (site, pages = PAGES) => (await prepare({ unit: 'caddy.service', user: 'caddy', site }, { pages })).unit.files;
const siteFile = async (site, pages) => (await filesOf(site, pages))[0];

const BLOCK = readFileSync(new URL('../sites/one-block-per-name.caddy', import.meta.url), 'utf8').trimEnd();
const REFUSE = readFileSync(new URL('../sites/refuse-other-hosts.caddy', import.meta.url), 'utf8').trimEnd();
const names = { site_hosts: ['place.example.test', 'www.example.test'], port: 7199 };
const auth = { auth: { listen: ['127.0.0.1:7201'], health_uri: '/readyz', health_interval: '1s', try_duration: '5s' } };

test('the site file is one block per name, with the port, checked by the site\'s Caddy and applied by a reload', async () => {
  const file = await siteFile(names);
  assert.equal(file.path, '/etc/caddy/Caddyfile');
  const block = host => `${BLOCK.replace('{SITE}', host).replace('{PORT}', '7199')}\n`;
  assert.equal(file.text, block('place.example.test') + block('www.example.test') + `${REFUSE}\n`);
  assert.deepEqual(file.check, ['caddy', 'validate', '--config', '{file}', '--adapter', 'caddyfile']);
  assert.deepEqual(file.then, [['systemctl', 'reload', 'caddy.service']]);
  assert.equal((await siteFile({ ...names, binary: '/opt/example/caddy' })).check[0], '/opt/example/caddy', 'the Caddy that checks is the one the site runs');
});

test('a Host no block names is refused at Caddy with 421, not answered by its empty 200, in the one-block and single-name shapes', async () => {
  const block = await siteFile(names);
  assert.match(block.text, /\nhttps:\/\/ \{\n\trespond 421\n\}\n$/, 'the catch-all is the last block of the one-block site');
  const single = await siteFile({ site_file: 'single-name-front-door', door_host: 'door.example.test', engine_paths: [], request_max: '4MB', upload_max: '32MiB', pages_root: '/var/lib/front-door-pages', routes: [], engine_routes: [], grace_period: '150s', pools: {} });
  assert.match(single.text, /^door\.example\.test \{$/m);
  assert.ok(single.text.endsWith(`}\n${REFUSE}\n`), 'the catch-all follows the front door block, so a stranger Host gets 421');
  assert.doesNotMatch(single.text, /\{\{/);
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
  site_file: 'single-name-front-door', door_host: 'door.example.test', engine_paths: ['/a/*'], request_max: '4MB', upload_max: '32MiB',
  pages_root: '/var/lib/front-door-pages', routes: ['tools/better-auth-official/on-a-computer/caddy-route-better-auth.caddy', 'tools/better-auth-official/on-a-computer/caddy-route-better-auth-pages.mjs', 'tools/better-auth-official/on-a-computer/caddy-route-better-auth-discovery.caddy', 'tools/better-auth-official/on-a-computer/caddy-route-better-auth-home.caddy'], engine_routes: [ENGINE],
  grace_period: '150s', home_page: '/workspace', pools: { auth: { listen: ['127.0.0.1:8792'], health_uri: '/readyz', health_interval: '1s', try_duration: '5s' },
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
  assert.match(file.text, /^\t\tencode zstd gzip$/m, 'pages are sent compressed');
  assert.match(file.text, /^\t\theader @named Cache-Control "public, max-age=31536000, immutable"$/m, 'a content-named file is kept for good');
  assert.match(file.text, /^\t\theader @not_named Cache-Control "public, max-age=300"$/m, 'any other page is asked again after 300 s');
  assert.match(file.text, /^\tlog default \{\n\t\texclude http\.handlers\.reverse_proxy\.health_checker\.active\n\t\}$/m, 'an idle slot\'s failing health page fills no journal');
  assert.match(file.text, /^\thandle \/api\/auth\/\* \{\n\t\treverse_proxy 127\.0\.0\.1:8792 \{\n\t\t\tlb_policy first\n[\s\S]*?\n\t\t\}\n\t\}$/m);
  assert.match(file.text, /^\thandle \/\.well-known\/oauth-authorization-server\* \{\n\t\treverse_proxy 127\.0\.0\.1:8792 \{\n\t\t\tlb_policy first\n[\s\S]*?\n\t\t\}\n\t\}$/m);
  assert.doesNotMatch(file.text, /oauth-protected-resource/, 'the protected-resource document is the engine\'s, carried, never the sign-in tool\'s');
  // The front page is the signed-in person's own page, the site's `home_page`: a sign-in that ends at / lands there, and a
  // signed-out visit is sent on to sign in and back (sign-in-client.mjs toSignIn). It went to /sign-in until Nov 20 2026, so a
  // finished sign-in landed on the email form again and the Mac app's window looped; then to /account, fixed in this file.
  assert.match(file.text, /^\thandle \/ \{\n\t\tredir \* \/workspace 302\n\t\}$/m);
  await assert.rejects(siteFile({ ...single, home_page: undefined }), /caddy-route-better-auth-home\.caddy needs home_page/);
  assert.doesNotMatch(file.text, /storage|on_demand|forwarder|old_site|trusted_proxies|tls_server_name/);
  assert.match(file.text, /^\t@page file \{\n\t\troot \/var\/lib\/front-door-pages\n/m);
  assert.match(file.text, /^\thandle \{\n\t\trespond "Not found" 404\n\t\}$/m);
  // the access log keeps a request's method, its address without the query and its status, and no header, client address or cookie
  assert.match(file.text, /^\tlog \{\n\t\toutput stdout\n\t\tformat filter \{\n\t\t\twrap json\n/m);
  assert.match(file.text, /request>uri regexp "\\\?\.\*" ""/);
  for (const field of ['request>headers', 'request>remote_ip', 'request>client_ip', 'resp_headers']) assert.match(file.text, new RegExp(`${field} delete`));
});

test('a screen\'s route_prefix address is answered by its prefix page, after the exact page and before the page handler', async () => {
  const text = (await siteFile(single)).text;
  const deep = text.indexOf('\t@prefix_deep {\n'), one = text.indexOf('\t@prefix_one {\n'), page = text.indexOf('\t@page file {\n');
  assert.ok(deep > 0 && one > deep && page > one, 'the two-segment prefix rule, then the one-segment rule, then the page matcher');
  assert.match(text, /^\t\tpath_regexp \^\/\[\^\/\]\+\/\[\^\/\]\+\/\[\^\/\]$/m, 'a third segment under two prefix segments');
  assert.match(text, /^\t\tpath_regexp \^\/\[\^\/\]\+\/\[\^\/\]$/m, 'a second segment under one prefix segment');
  assert.match(text, /^\trewrite @prefix_deep \/\{http\.request\.uri\.path\.0\}\.\{http\.request\.uri\.path\.1\}\.prefix\.html$/m);
  assert.match(text, /^\trewrite @prefix_one \/\{http\.request\.uri\.path\.0\}\.prefix\.html$/m);
  assert.equal((text.match(/^\t\tnot file \{$/gm) ?? []).length, 2, 'a page the path names exactly is never rewritten to a prefix page');
});

test('a routes slot the site leaves empty is no line at all; a missing field or an unknown site file is refused', async () => {
  const { engine_paths, ...noPaths } = single;
  await assert.rejects(siteFile(noPaths), /caddy-route-engine\.caddy needs engine_paths/);
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

test('a certificate-only site keeps the certificate of its name or address with its profile and serves nothing', async () => {
  const file = await siteFile({ site_file: 'certificate-only', door_host: '192.0.2.10', certificate_profile: 'shortlived', grace_period: '5s' });
  assert.match(file.text, /^192\.0\.2\.10 \{\n\ttls \{\n\t\tissuer acme \{\n\t\t\tprofile shortlived\n\t\t\}\n\t\}\n\trespond 404\n\}$/m);
  assert.doesNotMatch(file.text, /\{\{|reverse_proxy|file_server/);
  await assert.rejects(siteFile({ site_file: 'certificate-only', door_host: '192.0.2.10', grace_period: '5s' }), /certificate_profile/);
});

test('a made page is made at the apply by the module the site names, from this Workshop, and a page given twice is refused', async () => {
  const made = { module: 'tools/use-your-tools-from-a-shell/do-work/write-site-pages.mjs', export: 'sitePages', arguments: ['https://example.test', { name: 'Example', cli: 'example' }] };
  const files = (await filesOf({ ...single, made_pages: [made] })).filter(file => file.path.startsWith('/var/lib/front-door-pages/cli/'));
  const install = files.find(file => file.path === '/var/lib/front-door-pages/cli/install');
  assert.match(Buffer.from(install.text, 'base64').toString('utf8'), /https:\/\/example\.test\/cli\/install/, 'the install page is filled for the site');
  assert.ok(files.some(file => file.path === '/var/lib/front-door-pages/cli/program/command.mjs'), 'the program the command line runs is served');
  const twice = [...PAGES, { name: 'cli/install', bytes: Buffer.from('a kept copy') }];
  await assert.rejects(filesOf({ ...single, made_pages: [made] }, twice), /cli\/install is given twice/);
});

test('each name its own folder: the site file names no site, asks before each certificate, and serves pages_root/<name>', async () => {
  const pages = [{ name: 'place.example.test/index.html', bytes: Buffer.from('<p>place</p>') }];
  const files = await filesOf({ site_file: 'each-name-its-own-folder', door_host: '192.0.2.10', certificate_profile: 'shortlived', grace_period: '5s', pages_root: '/var/lib/example-sites', programs_root: '/run/example-sites' }, pages);
  const text = files[0].text;
  assert.match(text, /on_demand_tls \{\n\t\task http:\/\/127\.0\.0\.1:5601\/\n\t\}/);
  assert.match(text, /@has_folder file \/var\/lib\/example-sites\/\{site\}\/index\.html/);
  assert.match(text, /@has_program file \{\n\t\troot \/run\/example-sites\n\t\ttry_files \/\{site\}\/ \/\{site\}-slots\/\n\t\}\n\trespond @has_program 200/, 'a name whose program answers its first page, or runs in slots (<name>-slots), gets its certificate too');
  assert.match(text, /^192\.0\.2\.10 \{$/m);
  assert.match(text, /@program file \{\n\t\troot \/run\/example-sites\n\t\ttry_files \/\{site\}\/\n\t\}/, 'a site has a program when its folder exists under programs_root');
  assert.match(text, /reverse_proxy unix\/\/run\/example-sites\/\{site\}\/http\.sock/);
  // A request waits for a restarting program instead of failing.
  assert.match(text, /http\.sock \{\n\t+lb_try_duration 15s\n\t+lb_try_interval 250ms\n/);
  assert.doesNotMatch(text, /place\.example\.test|\{\{/, 'no site is named in the file');
  assert.ok(files.some(file => file.path === '/var/lib/example-sites/place.example.test/index.html'), 'a site is its folder');
  const https = text.slice(text.indexOf('https:// {'));
  assert.match(https, /^\tencode zstd gzip$/m, 'every page and program answer is sent compressed');
});

// A name the row's site_sockets lists goes to each of its program's sockets, the first that takes the call, after its pages and
// before the one-socket program route; a name it does not list keeps http.sock (Nov 21 2026: a site restarted in place stalled).
test('each name its own folder: a name the row lists in site_sockets is sent to every socket of its program, first that answers', async () => {
  const folders = { site_file: 'each-name-its-own-folder', door_host: '192.0.2.10', certificate_profile: 'shortlived', grace_period: '5s', pages_root: '/var/lib/example-sites', programs_root: '/run/example-sites' };
  const plain = (await siteFile(folders)).text;
  assert.doesNotMatch(plain, /@sockets_|site_sockets\}\}/, 'no listed name: no line at all');
  const text = (await siteFile({ ...folders, site_sockets: { 'place.example.test': ['/run/example-sites/place.example.test/http-a.sock', '/run/example-sites/place.example.test/http-b.sock'] } })).text;
  const https = text.slice(text.indexOf('https:// {'));
  assert.match(https, /\t@sockets_0 host place\.example\.test\n\thandle @sockets_0 \{\n\t\treverse_proxy unix\/\/run\/example-sites\/place\.example\.test\/http-a\.sock unix\/\/run\/example-sites\/place\.example\.test\/http-b\.sock \{\n\t\t\tlb_policy first\n/);
  assert.match(https, /lb_policy first\n\t\t\tlb_try_duration 15s\n\t\t\tlb_try_interval 250ms\n\t\t\tfail_duration 2s\n/);
  assert.ok(https.indexOf('handle @page') < https.indexOf('handle @sockets_0') && https.indexOf('handle @sockets_0') < https.indexOf('handle @program'), 'pages first, then a listed name\'s sockets, then the one-socket program');
  assert.match(https, /reverse_proxy unix\/\/run\/example-sites\/\{site\}\/http\.sock/, 'every other name keeps its one socket');
  for (const bad of [{ 'Place.Example': ['/run/x/http.sock'] }, { 'place.example.test': [] }, { 'place.example.test': ['relative/http.sock'] }, { 'place.example.test': ['/run/../etc/http.sock'] }]) {
    await assert.rejects(siteFile({ ...folders, site_sockets: bad }), /caddy\.site_sockets/);
  }
});

test('each name its own folder: a route_prefix address is answered by its prefix page in that name\'s folder, after the exact page', async () => {
  const folders = { site_file: 'each-name-its-own-folder', door_host: '192.0.2.10', certificate_profile: 'shortlived', grace_period: '5s', pages_root: '/var/lib/example-sites', programs_root: '/run/example-sites' };
  const text = (await siteFile(folders, [{ name: 'place.example.test/index.html', bytes: Buffer.from('<p>place</p>') }])).text;
  const https = text.slice(text.indexOf('https:// {'));
  const deep = https.indexOf('\t@prefix_deep {\n'), one = https.indexOf('\t@prefix_one {\n'), page = https.indexOf('\t@page {\n');
  assert.ok(deep > 0 && one > deep && page > one, 'the prefix rules come before the page matcher');
  assert.match(https, /^\trewrite @prefix_deep \/\{http\.request\.uri\.path\.0\}\.\{http\.request\.uri\.path\.1\}\.prefix\.html$/m);
  assert.match(https, /^\trewrite @prefix_one \/\{http\.request\.uri\.path\.0\}\.prefix\.html$/m);
  assert.equal((https.slice(deep, page).match(/^\t\t\troot \/var\/lib\/example-sites\/\{site\}$/gm) ?? []).length, 4, 'each prefix rule reads the folder of the name it is asked for');
  assert.doesNotMatch(https, /\{\{/);
});

test('each name its own folder: the engine answers some paths of some names first, and every other path stays the site\'s', async () => {
  const folders = { site_file: 'each-name-its-own-folder', door_host: '192.0.2.10', certificate_profile: 'shortlived', grace_period: '5s', pages_root: '/var/lib/example-sites', programs_root: '/run/example-sites' };
  const engine = { engine: { listen: ['127.0.0.1:7199', '127.0.0.1:7198'], health_uri: '/readyz', health_interval: '1s', try_duration: '5s' } };
  const text = (await siteFile({ ...folders, routes: ['tools/keep-an-engine-on-a-computer/caddy-route-engine-at-names.caddy'], engine_hosts: ['app.place.example.test'], engine_paths: ['/mcp', '/.well-known/oauth-protected-resource*'], pools: engine })).text;
  assert.match(text, /@engine_at_names \{\n\t\thost app\.place\.example\.test\n\t\tpath \/mcp \/\.well-known\/oauth-protected-resource\*\n\t\}/);
  const https = text.slice(text.indexOf('https:// {'));
  assert.ok(https.indexOf('handle @engine_at_names') > https.indexOf('redir @not_canonical') && https.indexOf('handle @engine_at_names') < https.indexOf('handle @page'), 'the engine route goes after the www redirect and before every page and program');
  assert.match(https, /handle @engine_at_names \{[\s\S]*reverse_proxy 127\.0\.0\.1:7199 127\.0\.0\.1:7198/);
  const none = (await siteFile({ ...folders, routes: [] })).text;
  assert.doesNotMatch(none, /engine_at_names|\{\{/, 'a site with no routes renders as before');
  await assert.rejects(siteFile({ ...folders, routes: ['tools/keep-an-engine-on-a-computer/caddy-route-engine-at-names.caddy'], engine_paths: ['/mcp'], pools: engine }), /needs engine_hosts/);
});

// A name the row's www_first_names lists answers at www.<name>, and its bare name is sent there; every other www.<name> is still
// sent to <name>. Both forms keep one folder and one program ({site} is the bare name) and both still get their certificate.
const wwwFolders = { site_file: 'each-name-its-own-folder', door_host: '192.0.2.10', certificate_profile: 'shortlived', grace_period: '5s', pages_root: '/var/lib/example-sites', programs_root: '/run/example-sites' };
const wwwCases = async () => ({
  absent: (await siteFile(wwwFolders)).text,
  empty: (await siteFile({ ...wwwFolders, www_first_names: [] })).text,
  one: (await siteFile({ ...wwwFolders, www_first_names: ['place.example.test'] })).text,
});
const canonicalLines = text => text.slice(text.indexOf('https:// {')).match(/\tmap \{host\} \{site\} \{canonical\} \{\n[\s\S]*?\n\t\}\n\t@not_canonical \{\n[\s\S]*?\n\t\}\n\tredir .*\n/)[0];
const askBlock = text => text.slice(text.indexOf(':5601 {'), text.indexOf('\n}\n', text.indexOf(':5601 {')));

test('each name its own folder: a name the row lists in www_first_names answers at www.<name>, and its bare name is sent there', async () => {
  const { absent, empty, one } = await wwwCases();
  assert.equal(empty, absent, 'an empty list is the same file as no list');
  assert.equal(canonicalLines(absent), [
    '\tmap {host} {site} {canonical} {',
    '\t\t~^www\\.(.+)$ ${1} ${1}',
    '\t\tdefault {host} {host}',
    '\t}',
    '\t@not_canonical {',
    "\t\t# An ACME HTTP-01 check is never sent on: Let's Encrypt asks it at the name it validates, and a check this computer",
    '\t\t# forwards (acme_challenge_elsewhere) must reach the other computer at that same name.',
    '\t\texpression {host} != {canonical}',
    '\t\tnot path /.well-known/acme-challenge/*',
    '\t}',
    '\tredir @not_canonical https://{canonical}{uri} 308',
    '',
  ].join('\n'), 'no listed name: every www.<name> is sent to <name>, path and query kept');
  assert.equal(canonicalLines(one), [
    '\tmap {host} {site} {canonical} {',
    '\t\tplace.example.test place.example.test www.place.example.test',
    '\t\twww.place.example.test place.example.test www.place.example.test',
    '\t\t~^www\\.(.+)$ ${1} ${1}',
    '\t\tdefault {host} {host}',
    '\t}',
    '\t@not_canonical {',
    "\t\t# An ACME HTTP-01 check is never sent on: Let's Encrypt asks it at the name it validates, and a check this computer",
    '\t\t# forwards (acme_challenge_elsewhere) must reach the other computer at that same name.',
    '\t\texpression {host} != {canonical}',
    '\t\tnot path /.well-known/acme-challenge/*',
    '\t}',
    '\tredir @not_canonical https://{canonical}{uri} 308',
    '',
  ].join('\n'), 'a listed name: its lines go first, so its bare name is sent to www.<name> and www.<name> answers from <name>');
  assert.equal(askBlock(one), askBlock(absent), 'the certificate question is the same for both forms of every name');
  assert.match(askBlock(absent), /^\t\t~\^www\\\.\(\.\+\)\$ \$\{1\}$/m);
  assert.doesNotMatch(absent + one, /\{\{/);
  assert.equal((one.match(/place\.example\.test/g) ?? []).length, 6, 'the listed name is named in its two map lines only');
  for (const bad of [['Place.Example.test'], ['www.place.example.test'], ['place'], [7], 'place.example.test']) {
    await assert.rejects(siteFile({ ...wwwFolders, www_first_names: bad }), /caddy\.www_first_names/);
  }
});

test('each name its own folder: Caddy reads the file with www_first_names absent, empty and holding one name', { skip: spawnSync('caddy', ['version']).status !== 0 && 'caddy is not installed' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'www-first-names-'));
  for (const [name, text] of Object.entries(await wwwCases())) {
    const file = join(dir, `${name}.caddyfile`);
    writeFileSync(file, text);
    const adapted = spawnSync('caddy', ['adapt', '--config', file, '--adapter', 'caddyfile'], { encoding: 'utf8' });
    assert.equal(adapted.status, 0, `${name}: ${adapted.stderr}`);
  }
});

const logFolders = { site_file: 'each-name-its-own-folder', door_host: '192.0.2.10', certificate_profile: 'shortlived', grace_period: '5s', pages_root: '/var/lib/example-sites', programs_root: '/run/example-sites' };
const logFile = { path: '/var/log/caddy/example-access.log', roll_size: '10MiB', roll_keep: 10 };
const httpsOf = text => text.slice(text.indexOf('https:// {'));

test('each name its own folder: a site that asks for its request log gets one journal log in its https block, and a site that does not gets none', async () => {
  const absent = await siteFile(logFolders);
  assert.doesNotMatch(absent.text, /\tlog |access_log\}\}/, 'no access_log: no log and no leftover slot');
  assert.deepEqual(absent.then, [['systemctl', 'reload', 'caddy.service']]);
  const https = httpsOf((await siteFile({ ...logFolders, access_log: { keep_ip: true } })).text);
  assert.equal(https.split('\n').filter(line => /^\tlog /.test(line)).length, 1, 'one log, the journal');
  assert.match(https, /\tlog journal \{\n\t\toutput stdout\n\t\tformat filter \{\n\t\t\twrap json\n\t\t\tfields \{\n\t\t\t\trequest>uri regexp "\\\?\.\*" ""\n\t\t\t\trequest>headers delete\n/, 'the query and headers are removed');
  assert.doesNotMatch(https, /remote_ip delete|client_ip delete/, 'keep_ip keeps the client address');
  assert.ok(https.indexOf('encode zstd gzip') < https.indexOf('\tlog journal') && https.indexOf('\tlog journal') < https.indexOf('handle @page'), 'the log is in the https block before its handlers');
});

test('each name its own folder: a request log names its file, rolled at roll_size with roll_keep old files, and the client address is removed unless keep_ip', async () => {
  const file = await siteFile({ ...logFolders, access_log: { file: logFile } });
  const https = httpsOf(file.text);
  assert.match(https, /\tlog file \{\n\t\toutput file \/var\/log\/caddy\/example-access\.log \{\n\t\t\troll_size 10MiB\n\t\t\troll_keep 10\n\t\t\}\n\t\tformat filter \{\n\t\t\twrap json\n/);
  assert.match(https, /\tlog journal \{\n\t\toutput stdout\n/, 'the journal keeps its lines too, for the apply-checked fact');
  assert.equal((https.match(/request>remote_ip delete\n\t\t\t\trequest>client_ip delete/g) ?? []).length, 2, 'no keep_ip: both logs remove the client address');
  // caddy validate, run as root by the apply, makes the file owned by root; the unit's user gets the folder and file before the reload.
  assert.deepEqual(file.then, [['install', '-d', '-o', 'caddy', '-g', 'caddy', '-m', '0755', '/var/log/caddy'], ['chown', 'caddy:caddy', '/var/log/caddy/example-access.log'], ['systemctl', 'reload', 'caddy.service']]);
  const kept = httpsOf((await siteFile({ ...logFolders, access_log: { keep_ip: true, file: logFile } })).text);
  assert.doesNotMatch(kept, /remote_ip delete|client_ip delete/);
});

test('a request log that is not bounded, not in the log folder or not plainly asked is refused', async () => {
  const bad = [
    null, [], 'yes', { keep_ip: 'yes' }, { file: null },
    { file: { ...logFile, path: '/etc/caddy/access.log' } }, { file: { ...logFile, path: '/var/log/caddy/../access.log' } },
    { file: { ...logFile, path: '/var/log/caddy/access.txt' } }, { file: { ...logFile, path: '/var/log/caddy/sub/access.log' } },
    { file: { ...logFile, roll_size: undefined } }, { file: { ...logFile, roll_size: '10' } }, { file: { ...logFile, roll_size: '0MiB' } },
    { file: { ...logFile, roll_keep: 0 } }, { file: { ...logFile, roll_keep: 2.5 } }, { file: { ...logFile, roll_keep: undefined } },
  ];
  for (const access_log of bad) await assert.rejects(siteFile({ ...logFolders, access_log }), /caddy\.access_log/, JSON.stringify(access_log));
  await assert.rejects(prepare({ unit: 'caddy.service', site: { ...logFolders, access_log: { file: logFile } } }, { pages: PAGES }), /names the user Caddy runs as/);
});

test('each name its own folder: Caddy reads a request log to the journal and to a rolled file, each its own logger', { skip: spawnSync('caddy', ['version']).status !== 0 && 'caddy is not installed' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'access-log-'));
  const path = join(dir, 'Caddyfile');
  writeFileSync(path, (await siteFile({ ...logFolders, access_log: { keep_ip: false, file: logFile } })).text);
  // adapt reads the file without opening the log file, so the folder need not exist here.
  const adapted = spawnSync('caddy', ['adapt', '--config', path, '--adapter', 'caddyfile'], { encoding: 'utf8' });
  assert.equal(adapted.status, 0, adapted.stderr);
  const { logs } = JSON.parse(adapted.stdout).logging;
  assert.deepEqual(logs.file.writer, { filename: '/var/log/caddy/example-access.log', output: 'file', roll_keep: 10, roll_size_mb: 10 });
  assert.deepEqual(logs.journal.writer, { output: 'stdout' });
  for (const name of ['file', 'journal']) {
    assert.deepEqual(logs[name].include, [`http.log.access.${name}`]);
    assert.equal(logs[name].encoder.fields['request>remote_ip'].filter, 'delete');
  }
});

// A name whose site moved to another computer (served_elsewhere) is sent there whole, with its own Host and TLS name, keeps its
// certificate here and is never redirected (Nov 25 2026: an old copy answered a page with 503 to stale-DNS visitors).
const elsewhereFolders = { site_file: 'each-name-its-own-folder', door_host: '192.0.2.10', certificate_profile: 'shortlived', grace_period: '5s', pages_root: '/var/lib/example-sites', programs_root: '/run/example-sites' };
const elsewhere = { to: 'https://192.0.2.20', names: ['moved.example.test', 'www.moved.example.test'] };
test('each name its own folder: a name served elsewhere is sent there whole, keeps its certificate and is never redirected', async () => {
  const plain = (await siteFile(elsewhereFolders)).text;
  assert.doesNotMatch(plain, /@served_elsewhere|moved\.example/, 'absent: no line in any of the three places');
  const text = (await siteFile({ ...elsewhereFolders, served_elsewhere: elsewhere })).text;
  const ask = text.slice(text.indexOf('http://127.0.0.1:5601 {'), text.indexOf('192.0.2.10 {'));
  assert.match(ask, /\t@served_elsewhere expression \{query\.domain\} in \['moved\.example\.test', 'www\.moved\.example\.test'\]\n\trespond @served_elsewhere 200\n/);
  const https = text.slice(text.indexOf('https:// {'));
  assert.match(https, /map \{host\} \{site\} \{canonical\} \{\n\t\tmoved\.example\.test moved\.example\.test moved\.example\.test\n\t\twww\.moved\.example\.test www\.moved\.example\.test www\.moved\.example\.test\n/, 'each name is its own canonical name, so the www redirect never sends it on');
  assert.match(https, /\t@served_elsewhere host moved\.example\.test www\.moved\.example\.test\n\thandle @served_elsewhere \{\n\t\treverse_proxy https:\/\/192\.0\.2\.20 \{\n\t\t\theader_up Host \{http\.request\.host\}\n\t\t\ttransport http \{\n\t\t\t\ttls_server_name \{http\.request\.host\}\n/);
  assert.ok(https.indexOf('handle @served_elsewhere') < https.indexOf('handle @page'), 'before any page or program of this computer');
  assert.doesNotMatch(text, /\{\{/);
});

test('a served_elsewhere that is not one https address and host names, or names a name also served here, is refused', async () => {
  const bad = [null, [], { names: elsewhere.names }, { to: 'http://192.0.2.20', names: elsewhere.names }, { to: 'https://192.0.2.20/path', names: elsewhere.names },
    { to: elsewhere.to }, { to: elsewhere.to, names: [] }, { to: elsewhere.to, names: ['Moved.Example'] }];
  for (const served_elsewhere of bad) await assert.rejects(siteFile({ ...elsewhereFolders, served_elsewhere }), /caddy\.served_elsewhere/, JSON.stringify(served_elsewhere));
  await assert.rejects(siteFile({ ...elsewhereFolders, served_elsewhere: elsewhere, site_sockets: { 'moved.example.test': ['/run/example-sites/moved.example.test/http.sock'] } }), /served in one place/);
  await assert.rejects(siteFile({ ...elsewhereFolders, served_elsewhere: elsewhere, www_first_names: ['moved.example.test'] }), /served in one place/);
});

test('each name its own folder: Caddy reads a site with a name served elsewhere', { skip: spawnSync('caddy', ['version']).status !== 0 && 'caddy is not installed' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'served-elsewhere-'));
  const path = join(dir, 'Caddyfile');
  writeFileSync(path, (await siteFile({ ...elsewhereFolders, served_elsewhere: elsewhere })).text);
  const adapted = spawnSync('caddy', ['adapt', '--config', path, '--adapter', 'caddyfile'], { encoding: 'utf8' });
  assert.equal(adapted.status, 0, adapted.stderr);
  const json = adapted.stdout;
  assert.match(json, /"tls":\{"server_name":"\{http\.request\.host\}"\}/);
  assert.match(json, /"dial":"192\.0\.2\.20:443"/);
});

// A name about to move (acme_challenge_elsewhere) sends only its ACME HTTP-01 check path to the other computer, with its own
// Host, so that computer gets its certificate while DNS still points here (Nov 25 2026: a name moved before its new host had a
// certificate and was locked out of new ones for an hour). Every other request is served here as before.
const challengeTo = { to: 'http://192.0.2.30', names: ['www.moving.example.test'] };
test('each name its own folder: a name about to move sends only its ACME check path there, before any page or program', async () => {
  const plain = (await siteFile(elsewhereFolders)).text;
  assert.doesNotMatch(plain, /@acme_challenge_elsewhere/, 'absent: no line');
  const text = (await siteFile({ ...elsewhereFolders, www_first_names: ['moving.example.test'], acme_challenge_elsewhere: challengeTo })).text;
  const https = text.slice(text.indexOf('https:// {'));
  assert.match(https, /\t@acme_challenge_elsewhere \{\n\t\thost www\.moving\.example\.test\n\t\tpath \/\.well-known\/acme-challenge\/\*\n\t\}\n\thandle @acme_challenge_elsewhere \{\n\t\treverse_proxy http:\/\/192\.0\.2\.30 \{\n\t\t\theader_up Host \{http\.request\.host\}\n/);
  assert.ok(https.indexOf('handle @acme_challenge_elsewhere') < https.indexOf('handle @page'), 'before any page or program of this computer');
  assert.doesNotMatch(text.slice(0, text.indexOf('https:// {')), /@acme_challenge_elsewhere/, 'the certificate question and the door address are unchanged');
  assert.doesNotMatch(text, /\{\{/);
});

test('an acme_challenge_elsewhere that is not one http address and host names, or names a name sent on or sent elsewhere, is refused', async () => {
  const bad = [null, [], { names: challengeTo.names }, { to: 'https://192.0.2.30', names: challengeTo.names }, { to: 'http://192.0.2.30/path', names: challengeTo.names },
    { to: challengeTo.to }, { to: challengeTo.to, names: [] }, { to: challengeTo.to, names: ['WWW.Moving.Example'] }];
  for (const acme_challenge_elsewhere of bad) await assert.rejects(siteFile({ ...elsewhereFolders, acme_challenge_elsewhere }), /caddy\.acme_challenge_elsewhere/, JSON.stringify(acme_challenge_elsewhere));
  await assert.rejects(siteFile({ ...elsewhereFolders, served_elsewhere: { to: 'https://192.0.2.20', names: ['www.moving.example.test'] }, acme_challenge_elsewhere: challengeTo }), /served_elsewhere/);
});

test('each name its own folder: Caddy reads a site with a name about to move, the check path proxied over plain HTTP', { skip: spawnSync('caddy', ['version']).status !== 0 && 'caddy is not installed' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'acme-challenge-elsewhere-'));
  const path = join(dir, 'Caddyfile');
  writeFileSync(path, (await siteFile({ ...elsewhereFolders, www_first_names: ['moving.example.test'], acme_challenge_elsewhere: challengeTo })).text);
  const adapted = spawnSync('caddy', ['adapt', '--config', path, '--adapter', 'caddyfile'], { encoding: 'utf8' });
  assert.equal(adapted.status, 0, adapted.stderr);
  const json = adapted.stdout;
  assert.match(json, /"path":\["\/\.well-known\/acme-challenge\/\*"\]/);
  assert.match(json, /"dial":"192\.0\.2\.30:80"/);
});

test('each name its own folder: the www redirect never takes an ACME check, so a name it sends on can have its check forwarded at its own name', async () => {
  const text = (await siteFile({ ...elsewhereFolders, acme_challenge_elsewhere: challengeTo })).text;
  const https = text.slice(text.indexOf('https:// {'));
  assert.match(https, /\t@not_canonical \{\n\t\t# An ACME[^\n]*\n\t\t# forwards[^\n]*\n\t\texpression \{host\} != \{canonical\}\n\t\tnot path \/\.well-known\/acme-challenge\/\*\n\t\}\n\tredir @not_canonical https:\/\/\{canonical\}\{uri\} 308/);
  assert.match(https, /host www\.moving\.example\.test\n\t\tpath \/\.well-known\/acme-challenge\/\*/, 'www.<name> of a bare name that answers itself is listed');
});

test('each name its own folder: Caddy reads the redirect that leaves out the ACME path', { skip: spawnSync('caddy', ['version']).status !== 0 && 'caddy is not installed' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'acme-not-redirected-'));
  const path = join(dir, 'Caddyfile');
  writeFileSync(path, (await siteFile({ ...elsewhereFolders, acme_challenge_elsewhere: challengeTo })).text);
  const adapted = spawnSync('caddy', ['adapt', '--config', path, '--adapter', 'caddyfile'], { encoding: 'utf8' });
  assert.equal(adapted.status, 0, adapted.stderr);
  assert.match(adapted.stdout, /"not":\[\{"path":\["\/\.well-known\/acme-challenge\/\*"\]\}\]/);
});
