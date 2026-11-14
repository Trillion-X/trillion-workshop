// tools/start-a-computer/do-work/render-layout.mjs
//
// Renders the files one computer's layout says it runs: the Caddy site file, each service unit and its drop-ins. The
// layout is that computer's row (request.host_layout, read at run time); the templates are read-data/unit-templates,
// the units' own text with a {field} for each value a computer declares. A field the row does not give is refused,
// so a template never renders half-filled. A layout's own Caddy routes (caddy.routes) are read-data/caddy-routes files filled
// from the layout's caddy fields, and a unit's settings object is written as JSON to its settings_file. A layout whose caddy
// row has `front_door` is a public front door (read-data/caddy-front-door): its certificates live in the shared storage
// every front door reaches, a name no site block names gets one on demand only when the door's ask path says yes, and
// each such name and each of `door_hosts` is carried to `door_upstream`; Caddy itself is settings.json caddy_front_door.
import { existsSync, readFileSync } from 'node:fs';

const TEMPLATE = name => readFileSync(new URL(`../read-data/unit-templates/${name}`, import.meta.url), 'utf8');
const UNITS = { 'serve-place': TEMPLATE('serve-place.service'), 'serve-computer': TEMPLATE('serve-computer.service'), 'serve-set-up': TEMPLATE('serve-set-up.service'), 'serve-better-auth': TEMPLATE('serve-better-auth.service') };
const ROUTE = name => {
  const file = new URL(`../read-data/caddy-routes/${name}.caddy`, import.meta.url);
  if (!/^[a-z0-9-]+$/.test(name) || !existsSync(file)) throw new Error(`caddy.routes names an unknown route ${name}`);
  return readFileSync(file, 'utf8').trimEnd();
};
const DROP_INS = { nofile: TEMPLATE('nofile.conf'), 'product-settings': TEMPLATE('product-settings.conf') };
const SYSTEMD = '/etc/systemd/system';
const FRONT_DOOR = name => readFileSync(new URL(`../read-data/caddy-front-door/${name}.caddy`, import.meta.url), 'utf8').trimEnd();
const FRONT_DOOR_CADDY = JSON.parse(readFileSync(new URL('../read-data/settings.json', import.meta.url), 'utf8')).caddy_front_door;

const fill = (template, values, where) => template.replace(/\{([a-z_]+)\}/g, (_, key) => {
  if (values[key] === undefined) throw new Error(`${where} needs ${key}`);
  return Array.isArray(values[key]) ? values[key].join(' ') : String(values[key]);
});

/** The Caddy site file: one site block per name, each with the layout's port. `siteBlock` is the wrapper the set-up tool
 * uses, with {SITE} and {PORT} still to fill. The layout's own routes (caddy.routes) go first inside each block. */
export const renderCaddy = (siteBlock, caddy) => {
  if (caddy.site_file) return renderSiteFile(caddy);
  const { site_hosts, port, releases } = caddy;
  if (!Array.isArray(site_hosts) || !site_hosts.length) throw new Error('caddy.site_hosts needs at least one name');
  if (siteBlock.includes('{releases}') && !releases) throw new Error('caddy.releases needs the folder the /engine-releases/ route serves');
  const routes = (caddy.routes ?? []).map(name => fill(ROUTE(name), caddy, `caddy route ${name}`)).join('\n');
  const sites = site_hosts.map(host => {
    const block = siteBlock.replaceAll('{SITE}', host).replaceAll('{PORT}', String(port)).replaceAll('{releases}', releases ?? '');
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
  const routes = key => (caddy[key] ?? []).map(name => fill(ROUTE(name), caddy, `caddy route ${name}`)).join('\n');
  const isRoutes = key => key === 'routes' || key.endsWith('_routes');
  return SITE_FILE(caddy.site_file).replace(/^\{\{([a-z_]+)\}\}\n/gm, (line, key) => isRoutes(key) && !routes(key) ? '' : line).replace(/\{\{([a-z_]+)\}\}/g, (_, key) => {
    if (isRoutes(key)) return routes(key);
    if (caddy[key] === undefined) throw new Error(`${where} needs ${key}`);
    return Array.isArray(caddy[key]) ? caddy[key].join(' ') : String(caddy[key]);
  });
};

/** A front door's whole site file: the shared storage and the on-demand ask (global options), the loopback site the ask
 * goes to, the layout's own sites, each of `door_hosts`, and every other name, on demand, carried to `door_upstream`. */
const renderFrontDoor = (door, sites) => {
  const where = 'caddy.front_door';
  const doorSite = (name, tls) => fill(FRONT_DOOR('door-site').replace('{SITE}', name).replace('{TLS}', tls), door, where);
  return [
    fill(FRONT_DOOR('global'), door, where), fill(FRONT_DOOR('ask'), door, where), sites.trimEnd(),
    ...(door.door_hosts ?? []).map(name => doorSite(name, '')),
    doorSite('https://', '\ttls {\n\t\ton_demand\n\t}\n'),
  ].join('\n\n') + '\n';
};

/** Every file a layout declares: { path, text }. A unit's drop-ins are the names it lists in `drop_ins`. With the product
 * settings' text (the verified product data), each unit that names a `product_settings` file declares that file too. */
export function renderLayout(layout, siteBlock, productSettings) {
  const files = [{ path: '/etc/caddy/Caddyfile', text: renderCaddy(siteBlock, layout.caddy) }];
  const door = layout.caddy?.front_door;
  if (door) files.push({ path: `${SYSTEMD}/caddy.service.d/front-door.conf`, text: fill(TEMPLATE('caddy-front-door.conf'), { ...door, binary: FRONT_DOOR_CADDY.binary }, 'caddy.front_door') });
  for (const unit of layout.units ?? []) {
    const where = `unit ${unit.unit}`;
    const template = UNITS[unit.template];
    if (!template) throw new Error(`${where} names an unknown template ${unit.template}`);
    files.push({ path: `${SYSTEMD}/${unit.unit}`, text: fill(template, unit, where) });
    if (productSettings !== undefined && unit.product_settings) files.push({ path: unit.product_settings, text: productSettings });
    if (unit.settings !== undefined) {
      if (!unit.settings_file) throw new Error(`${where} gives settings and needs settings_file`);
      files.push({ path: unit.settings_file, text: `${JSON.stringify(unit.settings, null, 2)}\n` });
    }
    for (const name of unit.drop_ins ?? []) {
      const dropIn = DROP_INS[name];
      if (!dropIn) throw new Error(`${where} names an unknown drop-in ${name}`);
      files.push({ path: `${SYSTEMD}/${unit.unit}.d/${name}.conf`, text: fill(dropIn, unit, `${where} drop-in ${name}`) });
    }
  }
  return files;
}

/** The files whose live text is not what the layout renders: { path, reason }. Empty means the layout matches. */
export function differences(rendered, live) {
  return rendered.flatMap(({ path, text }) => {
    if (live[path] === undefined) return [{ path, reason: 'missing on the computer' }];
    return live[path] === text ? [] : [{ path, reason: 'differs from the layout' }];
  });
}
