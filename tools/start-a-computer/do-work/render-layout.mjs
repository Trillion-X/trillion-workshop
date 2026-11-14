// tools/start-a-computer/do-work/render-layout.mjs
//
// Renders the files one computer's layout says it runs: the Caddy site file, each service unit and its drop-ins. The
// layout is that computer's row (request.host_layout, read at run time); the templates are read-data/unit-templates,
// the units' own text with a {field} for each value a computer declares. A field the row does not give is refused,
// so a template never renders half-filled.
//
// Every file in unit-templates is a template by its name: NAME.service a unit, NAME.conf a drop-in. Every file in caddy-routes
// is a route block a layout may name in `caddy.routes` ({ route: NAME, ...its values }); the site block's {LAYOUT_ROUTES}
// line is where they go, and a layout that names none renders that line away.
import { readdirSync, readFileSync } from 'node:fs';

const folder = name => new URL(`../read-data/${name}/`, import.meta.url);
const byName = (dir, ending) => Object.fromEntries(readdirSync(folder(dir)).filter(file => file.endsWith(ending))
  .map(file => [file.slice(0, -ending.length), readFileSync(new URL(file, folder(dir)), 'utf8')]));
const UNITS = byName('unit-templates', '.service');
const DROP_INS = byName('unit-templates', '.conf');
const ROUTES = byName('caddy-routes', '.caddy');
const SYSTEMD = '/etc/systemd/system';

const fill = (template, values, where) => template.replace(/\{([a-z_]+)\}/g, (_, key) => {
  if (values[key] === undefined) throw new Error(`${where} needs ${key}`);
  return Array.isArray(values[key]) ? values[key].join(' ') : String(values[key]);
});

/** The Caddy site file: one site block per name, each with the layout's port. `siteBlock` is the wrapper the set-up tool
 * uses, with {SITE} and {PORT} still to fill. */
export const renderCaddy = (siteBlock, { site_hosts, port, releases, routes = [] }) => {
  if (!Array.isArray(site_hosts) || !site_hosts.length) throw new Error('caddy.site_hosts needs at least one name');
  if (siteBlock.includes('{releases}') && !releases) throw new Error('caddy.releases needs the folder the /engine-releases/ route serves');
  if (routes.length && !siteBlock.includes('\n{LAYOUT_ROUTES}')) throw new Error("the site block has no place for the layout's routes ({LAYOUT_ROUTES})");
  const blocks = routes.map(values => {
    const where = `caddy route ${values.route}`;
    if (ROUTES[values.route] === undefined) throw new Error(`${where} is an unknown route`);
    return `\n${fill(ROUTES[values.route], values, where).trimEnd()}`;
  }).join('');
  const block = siteBlock.replace('\n{LAYOUT_ROUTES}', () => blocks);
  return site_hosts.map(host => `${block.replaceAll('{SITE}', host).replaceAll('{PORT}', String(port)).replaceAll('{releases}', releases ?? '')}\n`).join('');
};

/** Every file a layout declares: { path, text }. A unit's drop-ins are the names it lists in `drop_ins`. With the product
 * settings' text (the verified product data), each unit that names a `product_settings` file declares that file too. A unit
 * whose row gives `settings` and a `settings_file` declares that file as the row's settings, as JSON. */
export function renderLayout(layout, siteBlock, productSettings) {
  const files = [{ path: '/etc/caddy/Caddyfile', text: renderCaddy(siteBlock, layout.caddy) }];
  for (const unit of layout.units ?? []) {
    const where = `unit ${unit.unit}`;
    const template = UNITS[unit.template];
    if (!template) throw new Error(`${where} names an unknown template ${unit.template}`);
    files.push({ path: `${SYSTEMD}/${unit.unit}`, text: fill(template, unit, where) });
    if (productSettings !== undefined && unit.product_settings) files.push({ path: unit.product_settings, text: productSettings });
    if (unit.settings !== undefined) {
      if (!unit.settings_file) throw new Error(`${where} gives settings but no settings_file`);
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
