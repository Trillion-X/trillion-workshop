// scripts/open-source-notices.mjs
//
// PURPOSE
//   The workspace's open-source notices: every package whose code the workspace's bundles include (read from the
//   bundles' own inputs, so a package added tomorrow is listed with no edit) and every package it serves as its own
//   file (scripts/open-source-notices.json, which also says which of its files are served where). Each is listed with
//   its version, licence and source from its own package.json, and each licence text is served beside the list, at
//   /workspace/open-source/NOTICES.txt and /workspace/open-source/licences/<package>.txt.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Read, never typed: a version, licence or source comes from the package itself; a row names only what to serve.
//   2. Blind: nothing here names a package; which ones are listed is the bundles' inputs plus the DATA rows.
//   3. Plain text: the list is words and addresses, no markup.
import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const settings = JSON.parse(readFileSync(new URL('./open-source-notices.json', import.meta.url), 'utf8'));
const LICENCE_FILE = /^(licen[cs]e|copying|notice)(\.|$)/i;

/** The package a bundle input comes from (`node_modules/<name>` or `node_modules/@scope/name`), or null. */
export function packageOfInput(input) {
  const at = input.lastIndexOf('node_modules/');
  if (at < 0) return null;
  const [first, second] = input.slice(at + 'node_modules/'.length).split('/');
  return first.startsWith('@') ? `${first}/${second}` : first;
}

const sourceOf = found => {
  const repository = typeof found.repository === 'string' ? found.repository : found.repository?.url;
  return repository ? repository.replace(/^git\+/, '').replace(/\.git$/, '').replace(/^git:\/\//, 'https://').replace(/^github:/, 'https://github.com/') : found.homepage ?? null;
};

/**
 * Serves every separately served package's files under `out`, and writes the notices and licence texts under
 * `out`/open-source. `inputs`: the bundles' input paths. Answers the listed packages.
 */
export function writeOpenSourceNotices({ root, out, inputs, modules = join(root, 'node_modules') }) {
  const served = new Map(settings.served_separately.map(row => [row.package, row]));
  for (const row of served.values()) for (const { from, to } of row.served) {
    mkdirSync(join(out, to, '..'), { recursive: true });
    copyFileSync(join(modules, row.package, from), join(out, to));
  }
  const names = [...new Set([...inputs.map(packageOfInput).filter(Boolean), ...served.keys()])].sort();
  mkdirSync(join(out, 'open-source', 'licences'), { recursive: true });
  const listed = names.map(name => {
    const folder = join(modules, name);
    const found = JSON.parse(readFileSync(join(folder, 'package.json'), 'utf8'));
    const texts = readdirSync(folder).filter(file => LICENCE_FILE.test(file)).sort();
    const licenceFile = texts.length ? `licences/${name.replace('/', '__')}.txt` : null;
    if (licenceFile) writeFileSync(join(out, 'open-source', licenceFile), texts.map(file => readFileSync(join(folder, file), 'utf8')).join('\n\n'));
    const row = served.get(name);
    return {
      name, version: found.version ?? null, licence: found.license ?? found.licenses?.map?.(each => each.type).join(' OR ') ?? 'not stated',
      source: row?.source ?? [sourceOf(found)].filter(Boolean), what: row?.what ?? null,
      served: row ? row.served.map(({ to }) => `/workspace/${to}`) : [], licence_text: licenceFile ? `/workspace/open-source/${licenceFile}` : null,
    };
  });
  // Adapted local components no longer appear under node_modules. Keep their
  // upstream notice when any declared consumer is actually in this bundle.
  const prefix = `${root.replace(/\/$/, '')}/`;
  const inputPaths = new Set(inputs.map(input => input.startsWith(prefix) ? input.slice(prefix.length) : input));
  for (const row of settings.adapted_sources ?? []) {
    if (!row.inputs.some(input => inputPaths.has(input))) continue;
    const licenceFile = `licences/${row.name.replace('/', '__')}.txt`;
    copyFileSync(join(root, row.licence_file), join(out, 'open-source', licenceFile));
    listed.push({ name: row.name, version: null, licence: row.licence, source: row.source, what: row.what,
      served: [], licence_text: `/workspace/open-source/${licenceFile}` });
  }
  listed.sort((one, two) => one.name < two.name ? -1 : one.name > two.name ? 1 : 0);
  const lines = [
    'Open-source software in Trillion',
    '',
    'Trillion\'s signed-in workspace includes the open-source software below. Each is used under its own licence; the full',
    'text of each licence is at the address given. A package served as its own file can be replaced with another build',
    'of the same package from its source.',
    '',
    ...listed.flatMap(item => [
      `${item.name}${item.version ? ` ${item.version}` : ''}`,
      ...(item.what ? [`  What it does here: ${item.what}`] : []),
      `  Licence: ${item.licence}`,
      ...(item.licence_text ? [`  Licence text: ${item.licence_text}`] : []),
      ...item.source.map(address => `  Source: ${address}`),
      ...item.served.map(address => `  Served as its own file: ${address}`),
      '',
    ]),
  ];
  writeFileSync(join(out, 'open-source', 'NOTICES.txt'), `${lines.join('\n')}\n`);
  return listed;
}
