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
import { fill } from '../start-a-computer/do-work/fill-fields.mjs';

const CADDYFILE = '/etc/caddy/Caddyfile';
const ROUTE = name => {
  const file = new URL(`./routes/${name}.caddy`, import.meta.url);
  if (!/^[a-z0-9-]+$/.test(name) || !existsSync(file)) throw new Error(`caddy.routes names an unknown route ${name}`);
  return readFileSync(file, 'utf8').trimEnd();
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
  return pages.map(({ name, bytes }) => (TEXT_PAGE.test(name) ? { path: `${site.pages_root}/${name}`, text: bytes.toString('utf8') } : { path: `${site.pages_root}/${name}`, text: bytes.toString('base64'), binary: true }))
    .sort((a, b) => (a.path < b.path ? -1 : 1));
};

// The sign-in tool answers the addresses its own pages/routes.json lists (each page, and what is under it, and its assets):
// the site sends exactly those to it, so a page the tool adds is routed with no copy of the list in a computer's row.
const SIGN_IN_ROUTES = JSON.parse(readFileSync(new URL('../better-auth-official/pages/routes.json', import.meta.url), 'utf8'));
const signInPaths = () => [...new Set([...SIGN_IN_ROUTES.routes.map(({ path }) => path), SIGN_IN_ROUTES.assets_path.replace(/\/$/, '')])]
  .flatMap(path => [path, `${path}/*`]);
/** A route file filled from the site's fields; the sign-in pages' paths are the tool's own, and each pool the site names
 * (`pools`) is the field `<pool>_proxy`. */
const routeText = (name, site, where) => {
  if (site.auth_page_paths !== undefined) throw new Error(`${where}: caddy.auth_page_paths is gone; the sign-in paths are the tool's own pages/routes.json`);
  return fill(ROUTE(name), { ...site, ...poolFields(site), auth_page_paths: signInPaths() }, where);
};

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
const blockPerName = site => {
  const { site_hosts, port } = site;
  if (!Array.isArray(site_hosts) || !site_hosts.length) throw new Error('caddy.site_hosts needs at least one name');
  const routes = (site.routes ?? []).map(name => routeText(name, site, `caddy route ${name}`)).join('\n');
  return site_hosts.map(host => {
    const block = BLOCK.replaceAll('{SITE}', host).replaceAll('{PORT}', String(port));
    return `${routes ? block.replace('\n', `\n${routes}\n`) : block}\n`;
  }).join('');
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
const wholeFile = site => {
  const where = `caddy site file ${site.site_file}`;
  const routes = key => (site[key] ?? []).map(name => routeText(name, site, `caddy route ${name}`)).join('\n');
  const isRoutes = key => key === 'routes' || key.endsWith('_routes');
  const text = SITE_FILE(site.site_file).replace(/^\{\{([a-z_]+)\}\}\n/gm, (line, key) => isRoutes(key) && !routes(key) ? '' : line);
  return fillFields(text, site, where, key => (isRoutes(key) ? routes(key) : undefined));
};

/** The Caddy unit as the computer runs it: its `files` are the site file (checked by the site's Caddy, `binary`, and applied by
 * a reload of the unit) and every page under `pages_root` (applied by being written). The unit's other fields are its own. */
export function prepare(given, { pages } = {}) {
  const { site, ...unit } = given;
  if (site === null || typeof site !== 'object') throw new Error(`unit ${given.unit} needs site: the names, routes and pools Caddy serves`);
  const text = (site.site_file ? wholeFile(site) : blockPerName(site)) + innerDoors(site);
  const caddyfile = { path: CADDYFILE, text, check: [site.binary ?? 'caddy', 'validate', '--config', '{file}', '--adapter', 'caddyfile'], then: [['systemctl', 'reload', unit.unit]] };
  const served = site.pages_root ? pageFiles(site, pages).map(file => ({ ...file, then: [] })) : [];
  return { unit: { ...unit, files: [...(unit.files ?? []), caddyfile, ...served] } };
}
