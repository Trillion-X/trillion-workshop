import settings from './crawlers.json' with { type: 'json' };
import { negotiateMarkdown } from '../../ai-readiness/do-work/negotiate-markdown.mjs';
import { isShellPage } from '../parts/ui/show/server-rendered-page/page-egress.mjs';

const textHeaders = { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=300', 'x-content-type-options': 'nosniff' };

/** A robots.txt from one DATA section (`robots`, or `public_app_robots` for an app that wrote none); `sitemaps` are paths on `origin`. */
export const robotsTextOf = (section, origin, sitemaps = section.sitemaps ?? []) => {
  const lines = [];
  if (section.content_signals) lines.push(section.content_signals.trim(), '');
  for (const group of section.groups) {
    for (const agent of group.user_agents) lines.push(`User-agent: ${agent}`);
    for (const path of group.allow) lines.push(`Allow: ${path}`);
    for (const path of group.disallow) lines.push(`Disallow: ${path}`);
    lines.push('');
  }
  for (const path of sitemaps) lines.push(`Sitemap: ${new URL(path, origin).href}`);
  return `${lines.join('\n').trim()}\n`;
};

const robotsText = origin => robotsTextOf(settings.robots, origin);

/** The robots.txt of a public app that has none of its own. */
export const publicAppRobotsText = (origin, sitemaps = [], { aiCrawlers = true } = {}) =>
  robotsTextOf(aiCrawlers ? settings.public_app_robots : settings.public_app_robots.without_ai_crawlers, origin, sitemaps);

const { discovery } = settings;
const linkHeader = discovery.link_header.map(row => `<${row.path}>; rel="${row.rel}"${row.type ? `; type="${row.type}"` : ''}`).join(', ');

/** The API catalog (RFC 9727) as a linkset (RFC 9264): each API's address and the documents that describe it. */
const apiCatalog = origin => ({ linkset: discovery.api_catalog.apis.map(api => ({
  anchor: new URL(api.path, origin).href,
  title: api.title,
  ...Object.fromEntries(Object.entries(api.relations).map(([relation, targets]) => [relation, targets.map(target => ({ href: new URL(target.path, origin).href, type: target.type }))])),
})) });

/**
 * What an agent reads from a page this service draws: a Link header naming the host's discovery documents (unless the
 * page set one), Vary: Accept, and the page as Markdown when the Accept header explicitly asks for text/markdown.
 */
export async function agentReadable(request, response, origin = new URL(request.url).origin) {
  if (!isShellPage(response) || response.status !== 200 || !/^text\/html/i.test(response.headers.get('content-type') ?? '')) return response;
  if (!response.headers.has('link')) { response = new Response(response.body, response); response.headers.set('link', linkHeader); }
  return negotiateMarkdown(request, response, { origin, tokensPerCharacter: settings.markdown.tokens_per_character, mostHtmlCharacters: settings.markdown.most_html_characters });
}

export function crawlerRoute(request, { origin, url = new URL(request.url) } = {}) {
  if (!['GET', 'HEAD'].includes(request.method)) return null;
  if (url.pathname === discovery.api_catalog.path) return new Response(request.method === 'HEAD' ? null : JSON.stringify(apiCatalog(origin)), { headers: { ...textHeaders, 'content-type': `application/linkset+json; profile="${discovery.api_catalog.profile}"` } });
  if (url.pathname === '/robots.txt') return new Response(request.method === 'HEAD' ? null : robotsText(origin), { headers: textHeaders });
  if (url.pathname === `/${settings.indexnow_word}.txt`) return new Response(request.method === 'HEAD' ? null : settings.indexnow_word, { headers: textHeaders });
  return null;
}
