// tools/start-a-computer/do-work/render-layout.mjs
//
// Renders the files one computer's layout says it runs: the Caddy site file, each service unit and its drop-ins. The
// layout is that computer's row (request.host_layout, read at run time); the templates are read-data/unit-templates,
// the units' own text with a {field} for each value a computer declares. A field the row does not give is refused,
// so a template never renders half-filled.
import { readFileSync } from 'node:fs';

const TEMPLATE = name => readFileSync(new URL(`../read-data/unit-templates/${name}`, import.meta.url), 'utf8');
const UNITS = { 'serve-place': TEMPLATE('serve-place.service'), 'serve-computer': TEMPLATE('serve-computer.service'), 'serve-set-up': TEMPLATE('serve-set-up.service') };
const DROP_INS = { nofile: TEMPLATE('nofile.conf'), 'product-settings': TEMPLATE('product-settings.conf') };
const SYSTEMD = '/etc/systemd/system';

const fill = (template, values, where) => template.replace(/\{([a-z_]+)\}/g, (_, key) => {
  if (values[key] === undefined) throw new Error(`${where} needs ${key}`);
  return Array.isArray(values[key]) ? values[key].join(' ') : String(values[key]);
});

/** The Caddy site file: one site block per name, each with the layout's port. `siteBlock` is the wrapper the set-up tool
 * uses, with {SITE} and {PORT} still to fill. */
export const renderCaddy = (siteBlock, { site_hosts, port, releases }) => {
  if (!Array.isArray(site_hosts) || !site_hosts.length) throw new Error('caddy.site_hosts needs at least one name');
  if (siteBlock.includes('{releases}') && !releases) throw new Error('caddy.releases needs the folder the /engine-releases/ route serves');
  return site_hosts.map(host => `${siteBlock.replaceAll('{SITE}', host).replaceAll('{PORT}', String(port)).replaceAll('{releases}', releases ?? '')}\n`).join('');
};

/** Every file a layout declares: { path, text }. A unit's drop-ins are the names it lists in `drop_ins`. With the product
 * settings' text (the verified product data), each unit that names a `product_settings` file declares that file too. */
export function renderLayout(layout, siteBlock, productSettings) {
  const files = [{ path: '/etc/caddy/Caddyfile', text: renderCaddy(siteBlock, layout.caddy) }];
  for (const unit of layout.units ?? []) {
    const where = `unit ${unit.unit}`;
    const template = UNITS[unit.template];
    if (!template) throw new Error(`${where} names an unknown template ${unit.template}`);
    files.push({ path: `${SYSTEMD}/${unit.unit}`, text: fill(template, unit, where) });
    if (productSettings !== undefined && unit.product_settings) files.push({ path: unit.product_settings, text: productSettings });
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
