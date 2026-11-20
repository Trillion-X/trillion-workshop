// tools/workspace-screens/web/members-page/build.mjs
//
// Builds the generic members page for one site: the Workshop's page (entry.ts) with the screen modules of the packages the site
// names, its host block (the addresses it answers on and its placement) and the site's own page shell. The output is a static
// folder the site serves at its members address; nothing in it is site-specific except the host block and the shell. The
// separately served packages (the PDF reader) and the open-source notices are under its workspace/ folder.
//   import { buildMembersPage } from 'workshop/tools/workspace-screens/web/members-page/build.mjs';
//   await buildMembersPage({ out, host, packages, shell })
// host: { placement, subject, records, door_record, door_list, door_write } (members-page/host.ts HostConfig).
// packages: the tool folders whose screen modules the page carries. shell(html): the page's html as the site wants it.

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPage } from '../examples/standalone-workspace/build.mjs';
import { screenModulesOf } from './registry.mjs';
import { writeOpenSourceNotices } from '../scripts/open-source-notices.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const tools = resolve(here, '../../..');
const workshop = resolve(tools, '..');
const REGISTRY = 'members-screen-registry';

/** The module that exports every screen module of the packages, keyed as the rows name them. */
export function registryTextOf(modules) {
  const imports = modules.map((module, index) => `import * as screen${index} from ${JSON.stringify(module.path)};`);
  const entries = modules.map((module, index) => `  ${JSON.stringify(module.key)}: screen${index},`);
  return `${imports.join('\n')}\nexport const SCREEN_MODULES = {\n${entries.join('\n')}\n};\n`;
}

export async function buildMembersPage({ out, host, packages, shell = html => html }) {
  const work = mkdtempSync(join(tmpdir(), 'members-page-'));
  const registry = join(work, 'registry.ts');
  writeFileSync(registry, registryTextOf(screenModulesOf(tools, packages)));
  const template = join(work, 'index.html');
  const hostBlock = JSON.stringify(host).replace(/</g, '\\u003c');
  writeFileSync(template, readFileSync(join(here, 'index.html'), 'utf8').replace('{}</script>', `${hostBlock}</script>`));
  const registryPlugin = { name: 'members-screen-registry', setup(builder) { builder.onResolve({ filter: new RegExp(`^${REGISTRY}$`) }, () => ({ path: registry })); } };
  const metafile = await buildPage({ entry: join(here, 'entry.ts'), out, html: template, files: [], plugins: [registryPlugin] });
  // The packages served as their own files (the PDF page reader a lesson's PDF is drawn with, the HEIF decoder) at the address the
  // page asks them from (/workspace/<file>, src/workspace/pdf-reader-served.ts), with the notices for every package the page ships.
  writeOpenSourceNotices({ root: workshop, out: join(out, 'workspace'), inputs: Object.keys(metafile.inputs) });
  const page = join(out, 'index.html');
  writeFileSync(page, shell(readFileSync(page, 'utf8')));
}
