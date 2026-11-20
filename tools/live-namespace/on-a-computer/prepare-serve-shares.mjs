// The share route's own step before start-a-computer renders a computer row (a unit's `prepare`): when the unit's settings name the
// share's page folder (`settings.share_bytes.page`, an absolute path on the computer), every file of the page folder the unit names
// in `share_page` (a folder of the person's own, an absolute path, or a folder published in this Workshop; none: the shipped
// on-a-computer/share-page) becomes one of the unit's `files` under that path. A changed page file restarts the route, which reads its
// page once as it starts. The unit names no file of the page here and the row carries no copy of them.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const workshop = resolve(here, '../../..');

/** Every file under `folder`, as paths relative to it, in a steady order. */
function filesUnder(folder) {
  return readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) return filesUnder(path).map(inner => join(entry.name, inner));
    return entry.isFile() ? [entry.name] : [];
  });
}

export async function prepare(given) {
  const { share_page: named, ...unit } = given;
  const page = unit.settings?.share_bytes?.page;
  if (page === undefined) {
    if (named !== undefined) throw new Error(`unit ${unit.unit}: share_page names a page folder, and settings.share_bytes.page names no place for it`);
    return { unit };
  }
  if (typeof page !== 'string' || !isAbsolute(page) || page.split('/').includes('..')) throw new Error(`unit ${unit.unit}: settings.share_bytes.page is an absolute path with no ..`);
  const folder = named === undefined ? join(here, 'share-page') : isAbsolute(named) ? named : resolve(workshop, named);
  if (named !== undefined && !isAbsolute(named) && relative(workshop, folder).startsWith('..')) throw new Error(`unit ${unit.unit}: share_page ${named} leaves the Workshop`);
  if (!statSync(folder, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`unit ${unit.unit}: share_page ${folder} is not a folder`);
  const files = filesUnder(folder).map(path => {
    const bytes = readFileSync(join(folder, path));
    const text = bytes.toString('utf8');
    const plain = !bytes.includes(0) && Buffer.from(text, 'utf8').equals(bytes);
    return plain ? { path: join(page, path), text } : { path: join(page, path), text: bytes.toString('base64'), binary: true };
  });
  if (!files.some(file => file.path === join(page, 'page.html')) || !files.some(file => file.path === join(page, 'items.json'))) {
    throw new Error(`unit ${unit.unit}: the share page folder ${folder} holds no page.html and items.json`);
  }
  return { unit: { ...unit, files: [...(unit.files ?? []), ...files] } };
}
