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
//   A screen shown alone at its own address (a surface with shown_alone and route_paths outside /workspace in
//   src/workspace/native-screen-program.json, such as the Mac menu bar panel's /menu-bar) is the same page at that address,
//   so the front door answers it: until Nov 20 2026 /menu-bar had no page there, and the panel's reload every 31 s got 404.
//
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

/** The addresses outside /workspace where a screen is shown alone, each one plain path segment deep or more. */
export function aloneAddresses(program = JSON.parse(readFileSync(PROGRAM, 'utf8'))) {
  return [...new Set((program.surfaces ?? []).filter(surface => surface.shown_alone === true)
    .flatMap(surface => surface.route_paths ?? [])
    .filter(path => /^\/[a-z0-9][a-z0-9-]*(\/[a-z0-9][a-z0-9-]*)*$/.test(path) && path !== '/workspace' && !path.startsWith('/workspace/')))];
}

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
  const alone = workspace ? aloneAddresses().map(path => ({ page: `${path.slice(1)}.html`, bytes: workspace.bytes })) : [];
  return [...pages, ...alone, ...modules].sort((a, b) => (a.page < b.page ? -1 : 1));
}
