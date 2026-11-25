// tools/keep-a-caddy-front-door-on-a-computer/prepare-a-caddy-site.mjs
//
// Caddy's own part of a computer row: a Caddy unit's `site` (the names it answers, the routes it sends on, the pools of slots
// behind them and the pages it answers itself) made into the site file Caddy reads and the pages it serves. start-a-computer
// knows no program; a unit that names this file as its `prepare` is handed to `prepare` before it renders, and gets back the
// unit as the computer runs it with its `files` (moved here from start-a-computer's render-what-a-computer-runs.mjs, Nov 18
// 2026, K3 of the plan that no general tool knows a program). The site file is checked by the Caddy the site names (`binary`)
// before it replaces the live one, and a change is applied by a reload, so no call in flight is dropped; a page that changes
// restarts nothing.
import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { fill } from '../start-a-computer/do-work/fill-fields.mjs';
import { publishedFile } from '../start-a-computer/do-work/render-what-a-computer-runs.mjs';

const CADDYFILE = '/etc/caddy/Caddyfile';
/** Each route a site names is a file its program publishes, named by path like a unit's template (the sign-in tool's routes
 * are tools/better-auth-official/on-a-computer/caddy-route-*): its text, or, for a module (`.mjs`), the text its `route()`
 * answers, so a program that computes its route from its own data keeps that data. This kit names no route of its own. */
const routeTexts = async site => {
  const paths = new Set(Object.entries(site).filter(([key]) => key === 'routes' || key.endsWith('_routes')).flatMap(([, list]) => list ?? []));
  const texts = new Map();
  for (const path of paths) {
    const file = publishedFile(path, `caddy route ${path}`);
    texts.set(path, (path.endsWith('.mjs') ? (await import(pathToFileURL(file).href)).route() : readFileSync(file, 'utf8')).trimEnd());
  }
  return texts;
};

/** Each {{field}} in `text` is the site's own value (a list is joined with spaces); `special` answers a field first (routes). */
const fillFields = (text, site, where, special = () => undefined) => text.replace(/\{\{([a-z_]+)\}\}/g, (_, key) => {
  const value = special(key) ?? site[key];
  if (value === undefined) throw new Error(`${where} needs ${key}`);
  return Array.isArray(value) ? value.join(' ') : String(value);
});
// The pages the site answers itself are the caller's: the request hands them as `pages` (name and bytes of each file of the
// person's own pages folder), and each lands as the file at its address under the site's `pages_root`. A text page is carried
// as its text, any other file as base64 with `binary: true`, so the computer receives the same bytes. This kit holds no page.
const TEXT_PAGE = /\.(?:html|css|svg)$/;
const pageFiles = (site, pages) => {
  if (!Array.isArray(pages) || !pages.length) throw new Error('caddy.pages_root needs the pages the request gives (pages_folder)');
  const names = pages.map(({ name }) => name), twice = names.find((name, at) => names.indexOf(name) !== at);
  if (twice) throw new Error(`caddy.pages_root: ${twice} is given twice (the pages folder and a made page)`);
  return pages.map(({ name, bytes }) => (TEXT_PAGE.test(name) ? { path: `${site.pages_root}/${name}`, text: bytes.toString('utf8') } : { path: `${site.pages_root}/${name}`, text: bytes.toString('base64'), binary: true }))
    .sort((a, b) => (a.path < b.path ? -1 : 1));
};

// Pages a tool makes rather than the person keeps (`made_pages`: each { module, export, arguments }, a module published in this
// Workshop whose export answers [{ page, bytes }] for those arguments): made at every apply from the Workshop the apply runs, so
// they never go stale in the person's folder (finding F5: the site's command-line pages were a day old). A page both the
// person's folder and a made page give is refused: one place says what it is.
const madePages = async site => {
  const made = [];
  for (const { module, export: name, arguments: args = [] } of site.made_pages ?? []) {
    const where = `caddy made page ${module}`;
    const make = (await import(pathToFileURL(publishedFile(module, where)).href))[name];
    if (typeof make !== 'function') throw new Error(`${where} exports no ${name}`);
    made.push(...(await make(...args)).map(({ page, bytes }) => ({ name: page, bytes: Buffer.from(bytes) })));
  }
  return made;
};

/** A route's text filled from the site's fields; each pool the site names (`pools`) is the field `<pool>_proxy`. */
const routeText = (texts, path, site) => fill(texts.get(path), { ...site, ...poolFields(site) }, `caddy route ${path}`);

// A pool (pools: { <name>: { listen, health_uri, health_interval, try_duration, lines? } }) is every slot of one program:
// Caddy sends each call to the first that answers its health page, so a slot that is stopping (its health page answers 503
// while it finishes what it holds) gets no new call, and a refused connection is tried at the next slot for up to
// try_duration. A call already sent is never sent again. `lines` are the pool's own reverse_proxy lines (a Host header).
const POOL = readFileSync(new URL('./routes/pool.fragment', import.meta.url), 'utf8').trimEnd();
const poolFields = site => Object.fromEntries(Object.entries(site.pools ?? {}).map(([name, pool]) => {
  const where = `caddy.pools ${name}`;
  if (!/^[a-z0-9_]+$/.test(name) || !Array.isArray(pool?.listen) || !pool.listen.length) throw new Error(`${where} needs listen: every slot's address`);
  const lines = (pool.lines ?? []).map(line => `\t\t\t${fill(line, site, where)}\n`).join('');
  return [`${name}_proxy`, fill(POOL, { ...pool, lines }, where)];
}));

// An inner door (inner_doors: [{ listen, pool }]) is a loopback address Caddy holds for the programs on this computer (the
// engine's call to the sign-in tool's own listener), sent to that pool's slots, so a program that calls it never follows a
// slot switch.
const innerDoors = site => (site.inner_doors ?? []).map(({ listen, pool }, at) => {
  const where = `caddy.inner_doors ${at}`;
  if (!/^127\.0\.0\.1:[0-9]+$/.test(listen ?? '')) throw new Error(`${where} listens on a loopback address only`);
  const proxy = poolFields(site)[`${pool}_proxy`];
  if (!proxy) throw new Error(`${where} names no pool of caddy.pools`);
  // The site is the port alone (`http://:<port>`), so a call with any Host reaches the pool: a site named by its address
  // would answer a call naming another Host with Caddy's empty 200, and a health check through it would pass on nothing.
  return `\nhttp://:${listen.split(':')[1]} {\n\tbind 127.0.0.1\n\t${proxy.trim()}\n}\n`;
}).join('');

/** One site block per name (`site_hosts`), each sending to the site's `port` (sites/one-block-per-name.caddy); the site's own
 * routes go first inside each block. */
const BLOCK = readFileSync(new URL('./sites/one-block-per-name.caddy', import.meta.url), 'utf8').trimEnd();
/** The block every site that names its hosts ends with: a Host no block names gets 421 at Caddy, not Caddy's empty 200. */
const REFUSE_OTHER_HOSTS = readFileSync(new URL('./sites/refuse-other-hosts.caddy', import.meta.url), 'utf8').trimEnd();
const blockPerName = (site, texts) => {
  const { site_hosts, port } = site;
  if (!Array.isArray(site_hosts) || !site_hosts.length) throw new Error('caddy.site_hosts needs at least one name');
  const routes = (site.routes ?? []).map(path => routeText(texts, path, site)).join('\n');
  return `${site_hosts.map(host => {
    const block = BLOCK.replaceAll('{SITE}', host).replaceAll('{PORT}', String(port));
    return `${routes ? block.replace('\n', `\n${routes}\n`) : block}\n`;
  }).join('')}${REFUSE_OTHER_HOSTS}\n`;
};

/** A site that names `site_file` gets that whole file (sites/<site_file>.caddy): each {{field}} in it is the site's own value
 * (a list is joined with spaces), and a {{routes}} or {{<name>_routes}} slot is that list of route names in the site, each
 * filled as in a site block. A line that is only a routes slot the site leaves empty is no line at all. Caddy's own
 * {placeholders} are left as they are. */
const SITE_FILE = name => {
  const file = new URL(`./sites/${name}.caddy`, import.meta.url);
  if (!/^[a-z0-9-]+$/.test(name) || !existsSync(file)) throw new Error(`caddy.site_file names an unknown site file ${name}`);
  return readFileSync(file, 'utf8');
};
// A name a site file sends to its program's sockets (site_sockets: { <name>: [absolute .sock paths] }): every socket of that
// program, the first that takes the call, and one that refuses is passed over for fail_duration (routes/site-sockets.fragment).
// The names come from the row alone; a name it does not list keeps the one socket programs_root/<name>/http.sock.
const SITE_SOCKETS = readFileSync(new URL('./routes/site-sockets.fragment', import.meta.url), 'utf8').trimEnd();
const HOST_NAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const siteSockets = site => Object.entries(site.site_sockets ?? {}).map(([name, sockets], at) => {
  const where = `caddy.site_sockets ${name}`;
  if (!HOST_NAME.test(name)) throw new Error(`${where}: a name is a host name in small letters`);
  if (!Array.isArray(sockets) || !sockets.length || !sockets.every(path => /^\/[A-Za-z0-9._/-]+\.sock$/.test(path) && !path.includes('..'))) {
    throw new Error(`${where} lists one or more absolute .sock paths`);
  }
  return SITE_SOCKETS.replaceAll('{at}', String(at)).replaceAll('{name}', name).replaceAll('{sockets}', sockets.map(path => `unix/${path}`).join(' '));
}).join('\n');
// A name a site file answers at www.<name> (www_first_names: [bare names]) is its own map lines (routes/www-first-name.fragment):
// www.<name> is the name that answers and the bare name is sent there. A name it does not list keeps <name> as that name.
const WWW_FIRST_NAME = readFileSync(new URL('./routes/www-first-name.fragment', import.meta.url), 'utf8').trimEnd();
const wwwFirstNames = site => {
  const names = site.www_first_names ?? [];
  if (!Array.isArray(names)) throw new Error('caddy.www_first_names lists bare host names');
  return names.map(name => {
    if (typeof name !== 'string' || !HOST_NAME.test(name) || name.startsWith('www.')) throw new Error(`caddy.www_first_names ${name}: a name is a bare host name in small letters`);
    return WWW_FIRST_NAME.replaceAll('{name}', name);
  }).join('\n');
};
// A name whose site moved to another computer (served_elsewhere: { to: "https://<address>", names: [host names] }) is sent
// there whole (routes/served-elsewhere.fragment), with its own Host and its own name for TLS, so a visitor or crawler whose DNS
// still points here gets the live site's answer (Nov 25 2026: two sites moved to another host, and the old
// copy of one here answered a page with 503 to a visitor whose DNS was stale). Each name is its own canonical name in the map, so none is redirected, and the
// certificate question answers 200 for it, so it keeps its certificate here. Absent: no line in any of the three places.
const SERVED_ELSEWHERE = readFileSync(new URL('./routes/served-elsewhere.fragment', import.meta.url), 'utf8').trimEnd();
const servedElsewhereOf = site => {
  const asked = site.served_elsewhere;
  if (asked === undefined) return null;
  const where = 'caddy.served_elsewhere';
  if (asked === null || typeof asked !== 'object' || Array.isArray(asked)) throw new Error(`${where} is { to, names }`);
  if (typeof asked.to !== 'string' || !/^https:\/\/[A-Za-z0-9.-]+(?::[0-9]+)?$/.test(asked.to)) throw new Error(`${where} to is https://<address>, with no path`);
  if (!Array.isArray(asked.names) || !asked.names.length || !asked.names.every(name => typeof name === 'string' && HOST_NAME.test(name))) {
    throw new Error(`${where} names lists one or more host names in small letters`);
  }
  const taken = new Set([...Object.keys(site.site_sockets ?? {}), ...(site.www_first_names ?? []).flatMap(name => [name, `www.${name}`])]);
  const both = asked.names.find(name => taken.has(name));
  if (both) throw new Error(`${where} ${both} is also served here (site_sockets or www_first_names); a name is served in one place`);
  return asked;
};
const servedElsewhere = site => {
  const asked = servedElsewhereOf(site);
  return asked ? SERVED_ELSEWHERE.replaceAll('{names}', asked.names.join(' ')).replaceAll('{to}', asked.to) : '';
};
const servedElsewhereNames = site => (servedElsewhereOf(site)?.names ?? []).map(name => `\t\t${name} ${name} ${name}`).join('\n');
const servedElsewhereAsk = site => {
  const names = servedElsewhereOf(site)?.names ?? [];
  return names.length ? `\t@served_elsewhere expression {query.domain} in [${names.map(name => `'${name}'`).join(', ')}]\n\trespond @served_elsewhere 200` : '';
};
// A site that asks for its request log (access_log: { keep_ip?, file? }) gets one JSON line per request: its method, its address
// without the query, its status and how long it took; no header, cookie, TLS detail or query value. The client address is kept
// only when keep_ip is true. Every line goes to the journal, where start-a-computer's apply-checked fact reads it, and, when the
// row names a file (file: { path, roll_size, roll_keep }), to that file too: Caddy starts a new file past roll_size and keeps
// roll_keep old ones gzipped beside it, so the file never holds more than about roll_size x (roll_keep + 1). Each line is one
// JSON object with its time (ts), so the requests of each second are counted with jq. A site that does not ask gets no log.
// The file is in LOG_FOLDER, the folder Caddy's package makes for its own user. The site file's check (caddy validate, run as
// root) opens the log file and so makes it, owned by root, where Caddy running as the unit's user could not write it; so a
// changed site file gives the folder and the file to the unit's user before the reload.
const ROLL_SIZE = /^[1-9][0-9]*(?:KiB|MiB|GiB|KB|MB|GB)$/;
const LOG_FOLDER = '/var/log/caddy';
const accessLog = site => {
  const asked = site.access_log;
  if (asked === undefined) return '';
  if (asked === null || typeof asked !== 'object' || Array.isArray(asked)) throw new Error('caddy.access_log is { keep_ip?, file? }');
  const { keep_ip = false, file } = asked;
  if (typeof keep_ip !== 'boolean') throw new Error('caddy.access_log keep_ip is true or false');
  const where = 'caddy.access_log file';
  if (file !== undefined) {
    if (file === null || typeof file !== 'object') throw new Error(`${where} is { path, roll_size, roll_keep }`);
    if (typeof file.path !== 'string' || !new RegExp(`^${LOG_FOLDER}/[A-Za-z0-9_-][A-Za-z0-9._-]*\\.log$`).test(file.path)) throw new Error(`${where} path is a .log file in ${LOG_FOLDER}`);
    if (typeof file.roll_size !== 'string' || !ROLL_SIZE.test(file.roll_size)) throw new Error(`${where} roll_size is a size such as 10MiB`);
    if (!Number.isInteger(file.roll_keep) || file.roll_keep < 1) throw new Error(`${where} roll_keep is how many old files are kept, 1 or more`);
  }
  const fields = ['request>uri regexp "\\?.*" ""', 'request>headers delete', 'request>tls delete', 'request>remote_port delete',
    ...(keep_ip ? [] : ['request>remote_ip delete', 'request>client_ip delete']), 'resp_headers delete'];
  const block = (name, output) => [`\tlog ${name} {`, ...output.map(line => `\t\t${line}`), '\t\tformat filter {', '\t\t\twrap json', '\t\t\tfields {',
    ...fields.map(line => `\t\t\t\t${line}`), '\t\t\t}', '\t\t}', '\t}'].join('\n');
  return [block('journal', ['output stdout']),
    ...(file ? [block('file', [`output file ${file.path} {`, `\troll_size ${file.roll_size}`, `\troll_keep ${file.roll_keep}`, '}'])] : [])].join('\n');
};
/** The commands that give the log folder and file to the unit's user, run after a changed site file and before its reload. */
const logFileOwner = (site, unit) => {
  const path = site.access_log?.file?.path;
  if (!path) return [];
  if (!/^[a-z_][a-z0-9_-]*$/.test(unit.user ?? '')) throw new Error(`unit ${unit.unit} names the user Caddy runs as, who writes caddy.access_log file`);
  return [['install', '-d', '-o', unit.user, '-g', unit.user, '-m', '0755', LOG_FOLDER], ['chown', `${unit.user}:${unit.user}`, path]];
};
// The fields a site file fills with lines made from the row: absent or empty, a line that is only the field's slot is no line.
const LINE_FIELDS = { site_sockets: siteSockets, www_first_names: wwwFirstNames, access_log: accessLog, served_elsewhere: servedElsewhere,
  served_elsewhere_names: servedElsewhereNames, served_elsewhere_ask: servedElsewhereAsk };
const wholeFile = (site, texts) => {
  const where = `caddy site file ${site.site_file}`;
  const routes = key => (site[key] ?? []).map(path => routeText(texts, path, site)).join('\n');
  const isRoutes = key => key === 'routes' || key.endsWith('_routes');
  const lines = Object.fromEntries(Object.entries(LINE_FIELDS).map(([key, make]) => [key, make(site)]));
  const text = SITE_FILE(site.site_file).replace(/^\{\{([a-z_]+)\}\}\n/gm, (line, key) => (isRoutes(key) && !routes(key)) || lines[key] === '' ? '' : line);
  return fillFields(text, site, where, key => (isRoutes(key) ? routes(key) : key === 'refuse_other_hosts' ? REFUSE_OTHER_HOSTS : lines[key]));
};

/** The Caddy unit as the computer runs it: its `files` are the site file (checked by the site's Caddy, `binary`, and applied by
 * a reload of the unit) and every page under `pages_root` (applied by being written), and `pages_root` is a folder it owns whole
 * (`owned_folders`: a file there that is not one of the pages is removed). The unit's other fields are its own. */
export async function prepare(given, { pages } = {}) {
  const { site, ...unit } = given;
  if (site === null || typeof site !== 'object') throw new Error(`unit ${given.unit} needs site: the names, routes and pools Caddy serves`);
  const texts = await routeTexts(site);
  const text = (site.site_file ? wholeFile(site, texts) : blockPerName(site, texts)) + innerDoors(site);
  const caddyfile = { path: CADDYFILE, text, check: [site.binary ?? 'caddy', 'validate', '--config', '{file}', '--adapter', 'caddyfile'], then: [...logFileOwner(site, unit), ['systemctl', 'reload', unit.unit]] };
  const served = site.pages_root ? pageFiles(site, [...(pages ?? []), ...await madePages(site)]).map(file => ({ ...file, then: [] })) : [];
  // The pages folder is the site's whole: a page that left the person's pages folder leaves the computer too (owned_folders).
  return { unit: { ...unit, files: [...(unit.files ?? []), caddyfile, ...served], ...(site.pages_root ? { owned_folders: [...(unit.owned_folders ?? []), site.pages_root] } : {}) } };
}
