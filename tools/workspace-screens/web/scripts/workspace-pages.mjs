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
// Non-negotiable invariants
//   1. The origin is an https origin with no path (a loopback http origin is allowed for a test); the name is the site's own.
//   2. A build that fails fails the apply, in the build's own words; no page of an earlier build is handed on.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const BUILD = join(dirname(fileURLToPath(import.meta.url)), 'build-workspace.mjs');

/** The workspace's pages for `origin` and its site `{ name }`. */
export function workspacePages(origin, site) {
  const url = URL.canParse(origin) ? new URL(origin) : null;
  const loopback = url && url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (!url || (url.protocol !== 'https:' && !loopback) || url.origin !== origin) throw new Error(`${origin} is not an origin (https://host, no path)`);
  // The build writes its own records two folders above the pages (build-workspace.mjs), so the pages sit two deep in the run's folder.
  const out = join(mkdtempSync(join(tmpdir(), 'workspace-pages-')), 'build', 'pages');
  const built = spawnSync(process.execPath, [BUILD], { env: { ...process.env, WORKSPACE_OUT: out, WORKSPACE_ORIGIN: origin, WORKSPACE_NAME: site?.name ?? '' }, encoding: 'utf8', maxBuffer: 1 << 26 });
  if (built.status !== 0) throw new Error(`the workspace did not build: ${(built.stderr || built.stdout).trim().split('\n').slice(-5).join(' ')}`);
  return readdirSync(out, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => join(entry.parentPath, entry.name))
    .map(file => ({ page: relative(out, file), bytes: readFileSync(file) }))
    .sort((a, b) => (a.page < b.page ? -1 : 1));
}
