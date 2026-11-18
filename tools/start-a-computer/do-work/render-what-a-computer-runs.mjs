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
import { isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fill } from './fill-fields.mjs';
import { WAYS, renderMeetingPoint } from '../../carry-a-computer-to-a-meeting-point/do-work/carry-a-computer.mjs';

const TEMPLATE = name => readFileSync(new URL(`../read-data/unit-templates/${name}`, import.meta.url), 'utf8');
// The Workshop this tool runs from: a path a row names is read inside it, at the commit the tool runs at.
const WORKSHOP = fileURLToPath(new URL('../../../', import.meta.url));
/** The text of a file a row names (a unit's `template`, `script` or `drop_ins`): the program's own file, published by its
 *  owner. A relative path is read inside this Workshop (it may not leave it); an absolute path is the person's own file. The
 *  tool keeps no list of programs: whatever file a row names is what the computer runs. */
const published = (path, where) => {
  if (typeof path !== 'string' || !path) throw new Error(`${where} names no file`);
  const file = isAbsolute(path) ? path : resolve(WORKSHOP, path);
  if (!isAbsolute(path) && (relative(WORKSHOP, file).startsWith('..') || isAbsolute(relative(WORKSHOP, file)))) throw new Error(`${where} names a file outside the Workshop: ${path}`);
  if (!existsSync(file)) throw new Error(`${where} names a file that does not exist: ${path}`);
  return readFileSync(file, 'utf8');
};
const ROUTE = name => {
  const file = new URL(`../read-data/caddy-routes/${name}.caddy`, import.meta.url);
  if (!/^[a-z0-9-]+$/.test(name) || !existsSync(file)) throw new Error(`caddy.routes names an unknown route ${name}`);
  return readFileSync(file, 'utf8').trimEnd();
};
// The values a unit's template reads when its row gives none (read-data/settings.json `unit_defaults`): the build link it
// runs (`current`) and how long its stop may take (`stop_seconds`).
const UNIT_DEFAULTS = JSON.parse(readFileSync(new URL('../read-data/settings.json', import.meta.url), 'utf8')).unit_defaults;
const SYSTEMD = '/etc/systemd/system';
/** The name a drop-in file a unit lists is written under: its file's name without the extension. */
export const dropInName = path => path.split('/').pop().replace(/\.[^.]*$/, '');
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
/** A Caddy route file filled from the row's caddy fields; the sign-in pages' paths are the tool's own, and each pool the
 * row names (`pools`) is the field `<pool>_proxy`. */
const routeText = (name, caddy, where) => {
  if (caddy.auth_page_paths !== undefined) throw new Error(`${where}: caddy.auth_page_paths is gone; the sign-in paths are the tool's own pages/routes.json`);
  return fill(ROUTE(name), { ...caddy, ...poolFields(caddy), auth_page_paths: signInPaths() }, where);
};

// A pool (caddy.pools: { <name>: { listen, health_uri, health_interval, try_duration, lines? } }) is every slot of one
// program: Caddy sends each call to the first that answers its health page, so a slot that is stopping (its health page
// answers 503 while it finishes what it holds) gets no new call, and a refused connection is tried at the next slot for up
// to try_duration. A call already sent is never sent again. `lines` are the pool's own reverse_proxy lines (a Host header).
const POOL = readFileSync(new URL('../read-data/caddy-routes/pool.fragment', import.meta.url), 'utf8').trimEnd();
const poolFields = caddy => Object.fromEntries(Object.entries(caddy.pools ?? {}).map(([name, pool]) => {
  const where = `caddy.pools ${name}`;
  if (!/^[a-z0-9_]+$/.test(name) || !Array.isArray(pool?.listen) || !pool.listen.length) throw new Error(`${where} needs listen: every slot's address`);
  const lines = (pool.lines ?? []).map(line => `\t\t\t${fill(line, caddy, where)}\n`).join('');
  return [`${name}_proxy`, fill(POOL, { ...pool, lines }, where)];
}));

// An inner door (caddy.inner_doors: [{ listen, pool }]) is a loopback address Caddy holds for the programs on this computer
// (the engine's call to the sign-in tool's own listener), sent to that pool's slots, so a program that calls it never
// follows a slot switch.
const innerDoors = caddy => (caddy.inner_doors ?? []).map(({ listen, pool }, at) => {
  const where = `caddy.inner_doors ${at}`;
  if (!/^127\.0\.0\.1:[0-9]+$/.test(listen ?? '')) throw new Error(`${where} listens on a loopback address only`);
  const proxy = poolFields(caddy)[`${pool}_proxy`];
  if (!proxy) throw new Error(`${where} names no pool of caddy.pools`);
  // The site is the port alone (`http://:<port>`), so a call with any Host reaches the pool: a site named by its address
  // would answer a call naming another Host with Caddy's empty 200, and a health check through it would pass on nothing.
  return `\nhttp://:${listen.split(':')[1]} {\n\tbind 127.0.0.1\n\t${proxy.trim()}\n}\n`;
}).join('');

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
const renderSiteFile = caddy => {
  const where = `caddy site file ${caddy.site_file}`;
  const routes = key => (caddy[key] ?? []).map(name => routeText(name, caddy, `caddy route ${name}`)).join('\n');
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
  if (routes.length && !runs.caddy) throw new Error('a reach entry adds a Caddy route, and this computer\'s row names no caddy');
  const caddy = routes.length ? { ...runs.caddy, routes: [...(runs.caddy.routes ?? []), ...routes] } : runs.caddy;
  return { ...runs, units, caddy, machine };
}

/** A computer's `runs` with each unit that names `slots` made into one unit per slot, so a new release starts beside the
 * running one and takes over only once it answers (start-a-computer's apply switches between them; plan "a deploy never drops
 * anything"). `slots` maps each slot's name to the values that slot has of its own, each at its dotted path in the unit
 * (`settings.listen`, `health_listen`): the port it serves on, say. Each slot's unit is the unit's name with `-<slot>` before
 * its extension, its settings file the same, and the build it runs is `current-<slot>` in the unit's builds folder; every
 * other value is the one unit's. Each slot unit carries `slot`: the unit it came from (`of`) and the units of every slot (`units`). */
export function withSlots(runs) {
  const units = [];
  const named = (path, slot) => path.replace(/(\.[A-Za-z0-9]+)?$/, ext => `-${slot}${ext}`);
  for (const given of runs.units ?? []) {
    if (given.slots === undefined) { units.push(given); continue; }
    const where = `unit ${given.unit} slots`;
    const names = Object.keys(given.slots ?? {});
    if (given.slots === null || typeof given.slots !== 'object' || names.length < 2 || !names.every(name => /^[a-z0-9]{1,8}$/.test(name))) {
      throw new Error(`${where} names two or more slots, each a short word of small letters and digits, with the values that slot has of its own`);
    }
    const { slots, ...unit } = given;
    const unitsOf = names.map(name => named(unit.unit, name));
    for (const name of names) {
      const slot = structuredClone(unit);
      Object.assign(slot, { unit: named(unit.unit, name), current: `current-${name}`, slot: { of: unit.unit, units: unitsOf } });
      if (typeof unit.settings_file === 'string') slot.settings_file = named(unit.settings_file, name);
      for (const [path, value] of Object.entries(slots[name] ?? {})) {
        const keys = path.split('.');
        if (keys.some(key => !/^[A-Za-z0-9_]+$/.test(key)) || ['unit', 'slot', 'current'].includes(keys[0])) throw new Error(`${where} ${name} sets ${path}, which is not a value of the unit a slot may have of its own`);
        let at = slot;
        for (const key of keys.slice(0, -1)) {
          if (at[key] === null || typeof at[key] !== 'object') at[key] = {};
          at = at[key];
        }
        at[keys.at(-1)] = value;
      }
      units.push(slot);
    }
  }
  return { ...runs, units };
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
export function renderWhatItRuns(given, siteBlock, pages) {
  const runs = withSlots(given);
  // A computer that serves no web pages names no `caddy`: no Caddy file is written for it.
  const files = runs.caddy ? [{ path: '/etc/caddy/Caddyfile', text: renderCaddy(siteBlock, runs.caddy) + innerDoors(runs.caddy) }] : [];
  if (runs.caddy?.pages_root) files.push(...pageFiles(runs.caddy, pages));
  const door = runs.caddy?.front_door;
  if (door) files.push({ path: `${SYSTEMD}/caddy.service.d/front-door.conf`, text: fill(TEMPLATE('caddy-front-door.conf'), door, 'caddy.front_door') });
  // A meeting point (`meeting_point`: { way, values }) runs the host half of that way row
  // (tools/carry-a-computer-to-a-meeting-point read-data/ways.json), the same for every computer carried to it: its files are
  // written like every other, and its commands (`then`) run, in order, after one of them changed.
  if (runs.meeting_point) {
    const way = WAYS.find(row => row.id === runs.meeting_point.way);
    if (!way) throw new Error(`meeting_point names an unknown way ${runs.meeting_point.way}`);
    const { steps } = renderMeetingPoint({ way, relay_host: { hostname: runs.meeting_point.values?.host ?? 'localhost' }, computers: [], values: runs.meeting_point.values ?? {} });
    const then = steps.filter(step => step.run).map(step => step.run);
    files.push(...steps.filter(step => step.file).map(step => ({ path: step.file.path, text: step.file.text, then })));
  }
  for (const unit of runs.units ?? []) {
    const where = `unit ${unit.unit}`;
    const template = published(unit.template, `${where} template`);
    if (unit.workshop_commit !== undefined && !/^[0-9a-f]{40}$/.test(unit.workshop_commit)) throw new Error(`${where} workshop_commit must be a full commit id`);
    files.push({ path: `${SYSTEMD}/${unit.unit}`, text: fill(template, withCredentials({ ...UNIT_DEFAULTS, ...unit }, where), where) });
    if (unit.settings !== undefined || unit.settings_lines !== undefined) files.push(unitSettings(unit, where));
    if (unit.script !== undefined) files.push({ path: fill('{script_file}', unit, where), text: published(unit.script, `${where} script`) });
    if (unit.hba_lines !== undefined) files.push({ path: unit.hba_file, text: unit.hba_lines.map(line => `${line}\n`).join('') });
    for (const path of unit.drop_ins ?? []) {
      const name = dropInName(path);
      files.push({ path: `${SYSTEMD}/${unit.unit}.d/${name}.conf`, text: fill(published(path, `${where} drop-in`), unit, `${where} drop-in ${path}`) });
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
