// tools/start-a-computer/do-work/render-what-a-computer-runs.mjs
//
// Renders the files one computer runs: the Caddy site file, each service unit and its drop-ins. What it runs is the `runs`
// of that computer's own row (request.computer_row, handed in with the request); the templates are read-data/unit-templates,
// the units' own text with a {field} for each value a computer declares. A field the row does not give is refused,
// so a template never renders half-filled. The row's own Caddy routes (caddy.routes) are read-data/caddy-routes files filled
// from its caddy fields, and a unit's settings object is written as JSON to its settings_file. A row whose caddy
// row has `front_door` is a public front door (read-data/caddy-front-door): its certificates live in the shared storage
// every front door reaches, a name no site block names gets one on demand only when the door's ask path says yes, and
// each such name and each of `door_hosts` is carried to `door_upstream`; the Caddy it runs is the row's `binary` (its path) and `binary_files`.
import { existsSync, readFileSync } from 'node:fs';
import { fill } from './fill-fields.mjs';

const TEMPLATE = name => readFileSync(new URL(`../read-data/unit-templates/${name}`, import.meta.url), 'utf8');
// A unit's template is named by its file without the extension.
const UNITS = Object.fromEntries(['serve-computer', 'serve-better-auth', 'serve-door', 'serve-postgres', 'run-a-script', 'restart-a-unit']
  .map(name => [name, TEMPLATE(`${name}.service`)]).concat([['run-on-a-timer', TEMPLATE('run-on-a-timer.timer')], ['watch-a-file', TEMPLATE('watch-a-file.path')]]));
// A script a unit runs (`script`): the program's own text, written at the unit's `script_file`.
const SCRIPT = name => {
  const file = new URL(`../read-data/scripts/${name}.sh`, import.meta.url);
  if (!/^[a-z0-9-]+$/.test(name) || !existsSync(file)) throw new Error(`a unit names an unknown script ${name}`);
  return readFileSync(file, 'utf8');
};
const ROUTE = name => {
  const file = new URL(`../read-data/caddy-routes/${name}.caddy`, import.meta.url);
  if (!/^[a-z0-9-]+$/.test(name) || !existsSync(file)) throw new Error(`caddy.routes names an unknown route ${name}`);
  return readFileSync(file, 'utf8').trimEnd();
};
const DROP_INS = { nofile: TEMPLATE('nofile.conf') };
const SYSTEMD = '/etc/systemd/system';
const FRONT_DOOR = name => readFileSync(new URL(`../read-data/caddy-front-door/${name}.caddy`, import.meta.url), 'utf8').trimEnd();

/** Each {{field}} in `text` is the caddy row's own value (a list is joined with spaces); `special` answers a field first (routes). */
const fillFields = (text, caddy, where, special = () => undefined) => text.replace(/\{\{([a-z_]+)\}\}/g, (_, key) => {
  const value = special(key) ?? caddy[key];
  if (value === undefined) throw new Error(`${where} needs ${key}`);
  return Array.isArray(value) ? value.join(' ') : String(value);
});
// The pages the front door answers itself are the caller's: the request hands them as `pages` (name and bytes of each file of
// the person's own pages folder), and each lands as the file at its address under the row's `caddy.pages_root`. A text page is
// carried as its text, any other file as base64 with `binary: true`, so the computer receives the same bytes. This tool holds no page.
const TEXT_PAGE = /\.(?:html|css|svg)$/;
const pageFiles = (caddy, pages) => {
  if (!Array.isArray(pages) || !pages.length) throw new Error('caddy.pages_root needs the pages the request gives (pages_folder)');
  return pages.map(({ name, bytes }) => (TEXT_PAGE.test(name) ? { path: `${caddy.pages_root}/${name}`, text: bytes.toString('utf8') } : { path: `${caddy.pages_root}/${name}`, text: bytes.toString('base64'), binary: true }))
    .sort((a, b) => (a.path < b.path ? -1 : 1));
};

// The sign-in tool answers the addresses its own pages/routes.json lists (each page, and what is under it, and its assets):
// the front door sends exactly those to it, so a page the tool adds is routed with no copy of the list in a computer's row.
const SIGN_IN_ROUTES = JSON.parse(readFileSync(new URL('../../better-auth-official/pages/routes.json', import.meta.url), 'utf8'));
const signInPaths = () => [...new Set([...SIGN_IN_ROUTES.routes.map(({ path }) => path), SIGN_IN_ROUTES.assets_path.replace(/\/$/, '')])]
  .flatMap(path => [path, `${path}/*`]);
/** A Caddy route file filled from the row's caddy fields; the sign-in pages' paths are the tool's own. */
const routeText = (name, caddy, where) => {
  if (caddy.auth_page_paths !== undefined) throw new Error(`${where}: caddy.auth_page_paths is gone; the sign-in paths are the tool's own pages/routes.json`);
  return fill(ROUTE(name), { ...caddy, auth_page_paths: signInPaths() }, where);
};

/** The Caddy site file: one site block per name, each with the row's port. `siteBlock` is the wrapper the set-up tool
 * uses, with {SITE} and {PORT} still to fill. The row's own routes (caddy.routes) go first inside each block. */
export const renderCaddy = (siteBlock, caddy) => {
  if (caddy.site_file) return renderSiteFile(caddy);
  const { site_hosts, port } = caddy;
  if (!Array.isArray(site_hosts) || !site_hosts.length) throw new Error('caddy.site_hosts needs at least one name');
  const routes = (caddy.routes ?? []).map(name => routeText(name, caddy, `caddy route ${name}`)).join('\n');
  const sites = site_hosts.map(host => {
    const block = siteBlock.replaceAll('{SITE}', host).replaceAll('{PORT}', String(port));
    return `${routes ? block.replace('\n', `\n${routes}\n`) : block}\n`;
  }).join('');
  return caddy.front_door ? renderFrontDoor(caddy.front_door, sites) : sites;
};

/** A computer whose caddy row names `site_file` gets that whole file (read-data/caddy-sites/<site_file>.caddy): each
 * {{field}} in it is the row's own value (a list is joined with spaces), and a {{routes}} or {{<name>_routes}} slot is that
 * list of route names in the row (caddy.routes, caddy.every_name_routes), each filled as in a site block. A line that is
 * only a routes slot the row leaves empty is no line at all. Caddy's own {placeholders} are left as they are. */
const SITE_FILE = name => {
  const file = new URL(`../read-data/caddy-sites/${name}.caddy`, import.meta.url);
  if (!/^[a-z0-9-]+$/.test(name) || !existsSync(file)) throw new Error(`caddy.site_file names an unknown site file ${name}`);
  return readFileSync(file, 'utf8');
};
/** A computer carried to the door (caddy.carried_computers: { address, port }): its /a/<address> routes go to the loopback
 * port its outbound tunnel (tools/carry-a-computer-to-a-meeting-point) listens on at this computer. The carrier passes bytes; the
 * engine behind the tunnel alone checks who calls. */
const carriedRoutes = caddy => (caddy.carried_computers ?? []).map(({ address, paths, port }) => {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('caddy.carried_computers needs each computer\'s address (lowercase letters and digits) or its paths, and a loopback port');
  if (paths !== undefined) {
    if (!Array.isArray(paths) || !paths.length || !paths.every(path => /^\/[A-Za-z0-9._~\/*-]*$/.test(path))) throw new Error('caddy.carried_computers paths must be a list of paths that start with /');
    return fill(ROUTE('carried-paths'), { ...caddy, carried_paths: paths, carried_port: port }, `carried computer at port ${port}`);
  }
  if (!/^[a-z0-9]{8,128}$/.test(address)) throw new Error('caddy.carried_computers needs each computer\'s address (lowercase letters and digits) and a loopback port');
  return fill(ROUTE('carried-computer'), { ...caddy, carried_address: address, carried_port: port }, `carried computer ${address}`);
}).join('\n');
const renderSiteFile = caddy => {
  const where = `caddy site file ${caddy.site_file}`;
  const routes = key => key === 'carried_computer_routes' ? carriedRoutes(caddy) : (caddy[key] ?? []).map(name => routeText(name, caddy, `caddy route ${name}`)).join('\n');
  const isRoutes = key => key === 'routes' || key.endsWith('_routes');
  const text = SITE_FILE(caddy.site_file).replace(/^\{\{([a-z_]+)\}\}\n/gm, (line, key) => isRoutes(key) && !routes(key) ? '' : line);
  return fillFields(text, caddy, where, key => (isRoutes(key) ? routes(key) : undefined));
};

/** A front door's whole site file: the shared storage and the on-demand ask (global options), the loopback site the ask
 * goes to, the row's own sites, each of `door_hosts`, and every other name, on demand, carried to `door_upstream`. */
const renderFrontDoor = (door, sites) => {
  const where = 'caddy.front_door';
  const doorSite = (name, tls) => fill(FRONT_DOOR('door-site').replace('{SITE}', name).replace('{TLS}', tls), door, where);
  return [
    fill(FRONT_DOOR('global'), door, where), fill(FRONT_DOOR('ask'), door, where), sites.trimEnd(),
    ...(door.door_hosts ?? []).map(name => doorSite(name, '')),
    doorSite('https://', '\ttls {\n\t\ton_demand\n\t}\n'),
  ].join('\n\n') + '\n';
};

/** A unit's settings as the file it reads at its `settings_file`: its `settings_lines`, one line each, or its `settings` object as JSON
 * (an engine's computer config is one: trillion-rust src/native_entry/computer.rs). */
const unitSettings = (unit, where) => {
  if (typeof unit.settings_file !== 'string') throw new Error(`${where} gives settings and needs settings_file`);
  return { path: unit.settings_file, text: unit.settings_lines ? `${unit.settings_lines.join('\n')}\n` : `${JSON.stringify(unit.settings, null, 2)}\n` };
};

// A database unit's `reach` (who may reach the store, and over what), made into the lines and files it renders. Without it a
// database unit keeps the server's own defaults.
const POSTGRES_WORD = /^[A-Za-z0-9_.:/,@+-]+$/;
/** One `pg_hba.conf` line from a reach entry's `hba` row, in the server's own words: type, database, user, address (none
 * for a local socket) and method. Each word is one token with no space, so a row cannot add a line. */
const hbaLine = (row, where) => {
  const words = [row?.type, row?.database, row?.user, ...(row?.address === undefined ? [] : [row.address]), row?.method];
  if (!words.every(word => typeof word === 'string' && POSTGRES_WORD.test(word))) throw new Error(`${where} hba rows need type, database, user, method and, for a host line, address, each one word`);
  return words.join(' ');
};

/** A database unit with `reach`: the address list it listens on (every entry's `listen`; none is no network listener), the
 * access file at its `hba_file` (every entry's `hba` rows, and nothing else, so who may connect is only what the entries
 * say), and the ports and Caddy routes the entries open (`firewall_allow`, `routes`). */
const reachOf = (unit, where) => {
  if (!Array.isArray(unit.reach) || typeof unit.hba_file !== 'string' || !unit.hba_file.startsWith('/')) throw new Error(`${where} reach is a list of entries, and needs hba_file: the path of the access file the server reads`);
  if ((unit.settings_lines ?? []).some(line => /^\s*(listen_addresses|hba_file)\s*=/.test(line))) throw new Error(`${where} settings_lines must not set listen_addresses or hba_file: its reach renders them`);
  const listen = [...new Set(unit.reach.map(entry => entry.listen).filter(address => address !== undefined))];
  if (!listen.every(address => typeof address === 'string' && POSTGRES_WORD.test(address))) throw new Error(`${where} reach listen must be one address`);
  return {
    settings_lines: [`listen_addresses = '${listen.join(',')}'`, `hba_file = '${unit.hba_file}'`],
    hba_lines: unit.reach.flatMap((entry, at) => (entry.hba ?? []).map(row => hbaLine(row, `${where} reach ${at}`))),
    firewall_allow: unit.reach.flatMap(entry => entry.firewall_allow ?? []),
    routes: unit.reach.flatMap(entry => entry.routes ?? []),
  };
};

/** A computer's `runs` with each database unit's `reach` made into the listen line, the access file, the ports and the routes it renders. */
export function withReach(runs) {
  const units = [], firewall = [], routes = [];
  for (const given of runs.units) {
    if (given.reach === undefined) { units.push(given); continue; }
    const { reach, ...unit } = given;
    const rendered = reachOf(given, `unit ${given.unit}`);
    units.push({ ...unit, settings_lines: [...(unit.settings_lines ?? []), ...rendered.settings_lines], hba_lines: rendered.hba_lines });
    firewall.push(...rendered.firewall_allow);
    routes.push(...rendered.routes);
  }
  const machine = { ...runs.machine };
  if (firewall.length) {
    if (machine.firewall_allow === null) throw new Error('a reach entry opens a port, and this computer\'s firewall is kept by another program (machine.firewall_allow null)');
    machine.firewall_allow = [...(machine.firewall_allow ?? []), ...firewall];
  }
  const caddy = routes.length ? { ...runs.caddy, routes: [...(runs.caddy.routes ?? []), ...routes] } : runs.caddy;
  return { ...runs, units, caddy, machine };
}

/** A unit's `credentials` ({ vault_key, name, file, env? }) as its template's fields: `credential_lines`, one
 * LoadCredentialEncrypted line each, and `credential_env`, each one that names an `env` read into that variable before the
 * program starts. A credential with no `env` is read by the program itself from its credentials folder, by its name.
 * A unit's `files_read_at_start` ({ name, file }) are files another program on this computer keeps (the front door's
 * certificate and key): `file_lines`, one LoadCredential line each, so systemd copies each into the unit's credentials
 * folder at its start (/run/credentials/<unit>/<name>, readable by the unit's user only) and the unit's user needs no
 * right to the owner's folder. A file that changes later reaches the unit at its next start. */
const NAME = /^[A-Za-z0-9._-]+$/, ENV = /^[A-Z][A-Z0-9_]*$/;
const withCredentials = (unit, where) => {
  const credentials = unit.credentials ?? [], files = unit.files_read_at_start ?? [];
  for (const { name, file, env } of credentials) {
    if (!NAME.test(name ?? '') || !String(file ?? '').startsWith('/') || (env !== undefined && !ENV.test(env))) throw new Error(`${where} credentials need a name, an absolute file and, when given, an env of capitals`);
  }
  for (const { name, file } of files) {
    if (!NAME.test(name ?? '') || !/^\/[A-Za-z0-9._/-]+$/.test(file ?? '')) throw new Error(`${where} files_read_at_start need a name and an absolute file`);
  }
  return {
    ...unit,
    credential_lines: credentials.map(({ name, file }) => `LoadCredentialEncrypted=${name}:${file}`).join('\n'),
    credential_env: credentials.filter(({ env }) => env).map(({ name, env }) => `${env}="$(cat "$CREDENTIALS_DIRECTORY/${name}")" && export ${env} && `).join(''),
    file_lines: files.map(({ name, file }) => `LoadCredential=${name}:${file}`).join('\n'),
  };
};

/** Every file a computer's `runs` declares: { path, text }. A unit's drop-ins are the names it lists in `drop_ins`. */
export function renderWhatItRuns(runs, siteBlock, pages) {
  const files = [{ path: '/etc/caddy/Caddyfile', text: renderCaddy(siteBlock, runs.caddy) }];
  if (runs.caddy?.pages_root) files.push(...pageFiles(runs.caddy, pages));
  const door = runs.caddy?.front_door;
  if (door) files.push({ path: `${SYSTEMD}/caddy.service.d/front-door.conf`, text: fill(TEMPLATE('caddy-front-door.conf'), door, 'caddy.front_door') });
  for (const unit of runs.units ?? []) {
    const where = `unit ${unit.unit}`;
    const template = UNITS[unit.template];
    if (!template) throw new Error(`${where} names an unknown template ${unit.template}`);
    if (unit.workshop_commit !== undefined && !/^[0-9a-f]{40}$/.test(unit.workshop_commit)) throw new Error(`${where} workshop_commit must be a full commit id`);
    files.push({ path: `${SYSTEMD}/${unit.unit}`, text: fill(template, withCredentials(unit, where), where) });
    if (unit.settings !== undefined || unit.settings_lines !== undefined) files.push(unitSettings(unit, where));
    if (unit.script !== undefined) files.push({ path: fill('{script_file}', unit, where), text: SCRIPT(unit.script) });
    if (unit.hba_lines !== undefined) files.push({ path: unit.hba_file, text: unit.hba_lines.map(line => `${line}\n`).join('') });
    for (const name of unit.drop_ins ?? []) {
      const dropIn = DROP_INS[name];
      if (!dropIn) throw new Error(`${where} names an unknown drop-in ${name}`);
      files.push({ path: `${SYSTEMD}/${unit.unit}.d/${name}.conf`, text: fill(dropIn, unit, `${where} drop-in ${name}`) });
    }
  }
  // A file several units name (one script two jobs run) is one file; two different texts for one path are refused.
  const byPath = new Map();
  for (const file of files) {
    const seen = byPath.get(file.path);
    if (seen && seen.text !== file.text) throw new Error(`two units render different text at ${file.path}`);
    if (!seen) byPath.set(file.path, file);
  }
  return [...byPath.values()];
}

/** The files whose live text is not what the computer row renders: { path, reason }. Empty means the computer matches. */
export function differences(rendered, live) {
  return rendered.flatMap(({ path, text }) => {
    if (live[path] === undefined) return [{ path, reason: 'missing on the computer' }];
    return live[path] === text ? [] : [{ path, reason: 'differs from the computer row' }];
  });
}
