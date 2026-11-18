// tools/better-auth-official/on-a-computer/caddy-route-better-auth-pages.mjs
//
// The web server's route to every address this tool's own pages/routes.json lists (each page, what is under it, and its
// assets), so a page the tool adds is routed with no copy of the list in a computer's row. A site that names this file gets
// its text from `route()`; {auth_proxy} is left for the site to fill with the pool its sign-in slots are in.
import { readFileSync } from 'node:fs';

const ROUTES = JSON.parse(readFileSync(new URL('../pages/routes.json', import.meta.url), 'utf8'));

export function route() {
  const paths = [...new Set([...ROUTES.routes.map(({ path }) => path), ROUTES.assets_path.replace(/\/$/, '')])].flatMap(path => [path, `${path}/*`]);
  return `\t@better_auth_pages path ${paths.join(' ')}\n\thandle @better_auth_pages {\n\t\t{auth_proxy}\n\t}`;
}
