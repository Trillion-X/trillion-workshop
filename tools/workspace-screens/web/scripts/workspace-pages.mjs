// tools/workspace-screens/web/scripts/workspace-pages.mjs
//
// Purpose
//   The pages of the signed-in workspace a site serves at /workspace (src/workspace/account-workspace.ts), for a front door's
//   `made_pages` (keep-a-caddy-front-door-on-a-computer): built from this Workshop at every apply (build-workspace.mjs) for the
//   site's own origin and name, so the page, its sign-in callback, its client document and every file it loads reach the
//   computer from the computer's row, never a copied folder.
//
//   workspacePages(origin, site) -> [{ page, bytes }]   page relative to the pages folder (workspace.html, workspace/...)
//
//   Every screen at its own address (a surface's route_paths outside /workspace: the program's own surfaces in
//   src/workspace/native-screen-program.json and each tool's screen offers in tools/*/part.json) is the same page at that
//   address, so the front door answers it and the page opens that screen (addresses.mjs). Until Nov 20 2026 /menu-bar had no
//   page there and the panel's reload every 31 s got 404; until Nov 21 2026 only screens shown alone had one, so a link to
//   /grants (the owner's grants screen) or a reload of /calendar answered 404.
//
//   Each screen's route_prefix (one or two segments: `/file/`, `/record/about/`) is one more page, `<segments joined by .>.prefix.html`
//   (prefixPage). The front door's prefix rule (keep-a-caddy-front-door-on-a-computer sites/) answers each address under it with that
//   page, so /file/<id> opens the file screen. Until Nov 21 2026 /file/<id> answered 404: no page had that name.

//   A tool's own screen (a row's screen.kind "module") is built into a bundle the page imports from
//   /workshop/modules/<bundle>/<file> (src/workspace/screen-module-address.mjs). A front door serving files has no server to
//   open a bundle by its identity, so each bundle's files are pages at that address.
//
// Non-negotiable invariants
//   1. The origin is an https origin with no path (a loopback http origin is allowed for a test); the name is the site's own.
//   2. A build that fails fails the apply, in the build's own words; no page of an earlier build is handed on.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readScreenModules } from './screen-modules.mjs';
import { moduleAddress } from '../src/workspace/screen-module-address.mjs';
import { untarGz } from '../../../keep-and-wake-ai-sessions-on-this-computer/src/tar-gz.mjs';

const BUILD = join(dirname(fileURLToPath(import.meta.url)), 'build-workspace.mjs');
const PROGRAM = join(dirname(fileURLToPath(import.meta.url)), '../src/workspace/native-screen-program.json');

const TOOLS = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const PLAIN = /^\/[a-z0-9][a-z0-9-]*(\/[a-z0-9][a-z0-9-]*)*$/;
const PREFIX = /^\/[a-z0-9][a-z0-9-]*(\/[a-z0-9][a-z0-9-]*)?\/$/;

/** Each tool's screen surfaces, from its part.json `offers[].screen.surface`. */
export function toolScreenSurfaces(tools = TOOLS) {
  return readdirSync(tools, { withFileTypes: true }).filter(entry => entry.isDirectory()).flatMap(entry => {
    let part; try { part = JSON.parse(readFileSync(join(tools, entry.name, 'part.json'), 'utf8')); } catch { return []; }
    return (part.offers ?? []).map(offer => offer?.screen?.surface).filter(Boolean);
  });
}

/** The addresses outside /workspace where a screen opens, each one plain path segment deep or more. */
export function screenAddresses(program = JSON.parse(readFileSync(PROGRAM, 'utf8')), surfaces = toolScreenSurfaces()) {
  return [...new Set([...(program.surfaces ?? []), ...surfaces].flatMap(surface => surface.route_paths ?? [])
    .filter(path => typeof path === 'string' && PLAIN.test(path) && path !== '/workspace' && !path.startsWith('/workspace/')))];
}

/** The route_prefix addresses of the same surfaces, one or two plain segments each (`/file/`, `/record/about/`); a deeper prefix
 *  is not listed, and the front door has no rule for it (a test holds every real prefix to two segments). */
export function screenPrefixes(program = JSON.parse(readFileSync(PROGRAM, 'utf8')), surfaces = toolScreenSurfaces()) {
  return [...new Set([...(program.surfaces ?? []), ...surfaces].map(surface => surface.route_prefix)
    .filter(prefix => typeof prefix === 'string' && PREFIX.test(prefix)))];
}

/** The page a front door's prefix rule reads for a prefix: `/record/about/` is `record.about.prefix.html`. */
export const prefixPage = prefix => `${prefix.slice(1, -1).replaceAll('/', '.')}.prefix.html`;

/** The workspace's pages for `origin` and its site `{ name }`. */
export function workspacePages(origin, site) {
  const url = URL.canParse(origin) ? new URL(origin) : null;
  const loopback = url && url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (!url || (url.protocol !== 'https:' && !loopback) || url.origin !== origin) throw new Error(`${origin} is not an origin (https://host, no path)`);
  // The build writes its own records two folders above the pages (build-workspace.mjs), so the pages sit two deep in the run's folder.
  const out = join(mkdtempSync(join(tmpdir(), 'workspace-pages-')), 'build', 'pages');
  const built = spawnSync(process.execPath, [BUILD], { env: { ...process.env, WORKSPACE_OUT: out, WORKSPACE_ORIGIN: origin, WORKSPACE_NAME: site?.name ?? '' }, encoding: 'utf8', maxBuffer: 1 << 26 });
  if (built.status !== 0) throw new Error(`the workspace did not build: ${(built.stderr || built.stdout).trim().split('\n').slice(-5).join(' ')}`);
  const pages = readdirSync(out, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => join(entry.parentPath, entry.name))
    .map(file => ({ page: relative(out, file), bytes: readFileSync(file) }));
  // The page asks for a bundle's file at its address with the identity escaped; the front door reads the path unescaped.
  const modules = [...readScreenModules(dirname(out)).values()].flatMap(({ bundle, bytes }) =>
    untarGz(bytes, { withBytes: true }).map(file => ({ page: decodeURIComponent(moduleAddress(bundle, file.name)).slice(1), bytes: Buffer.from(file.bytes) })));
  const workspace = pages.find(({ page }) => page === 'workspace.html');
  const alone = workspace ? screenAddresses().map(path => ({ page: `${path.slice(1)}.html`, bytes: workspace.bytes })) : [];
  const prefixed = workspace ? screenPrefixes().map(prefix => ({ page: prefixPage(prefix), bytes: workspace.bytes })) : [];
  return [...pages, ...alone, ...prefixed, ...modules].sort((a, b) => (a.page < b.page ? -1 : 1));
}
