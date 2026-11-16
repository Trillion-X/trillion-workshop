// Every Trillion page as one response: the shared page shell (packages/ui server-rendered-page) with the app's
// language, look, icons and page script. Callers hand a page description; this is the one place those defaults live.
import { pageShellHtml } from '../../../ui/show/server-rendered-page/page-sections-html.mjs';
import { markShellPage } from '../../../ui/show/server-rendered-page/page-egress.mjs';
import { PAGE_LOOK } from './page-look.mjs';

// The tab icon is the white needle with its red thread; the home-screen icon is the same needle on a dark square.
const ICONS = [
  { rel: 'manifest', href: '/trillion.webmanifest', type: 'application/manifest+json' },
  { rel: 'icon', href: '/favicon.ico', sizes: '16x16 32x32 48x48' },
  { rel: 'icon', href: '/favicon.svg', type: 'image/svg+xml' },
  { rel: 'apple-touch-icon', href: '/apple-touch-icon.png', sizes: '180x180' },
];
const PAGE_SCRIPT = { bundle_url: '/client.js', mount_element_id: 'root' };

/** A page with the app defaults; `description` may override any of them and carries its own `share` (how the page looks when shared; the caller's words, none by default) (a page with no script passes `island: null`).
 *  `status` is the answer's own status, so a page saying a link expired or a page is missing says it to programs too.
 *  Every page is marked as drawn by the shell (page-egress.mjs), so the check at the Worker's edge leaves it alone. */
export const htmlPage = (description, headers = {}, status = 200) => new Response(pageShellHtml({ language: 'en', theme: 'paper', look: PAGE_LOOK, island: { ...PAGE_SCRIPT, ...(description?.inline_css ? { inline_css: description.inline_css } : {}) }, icons: ICONS, ...description }), {
  status,
  headers: markShellPage({ 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...headers }),
});
