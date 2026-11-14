const routeOf = (page) => typeof page?.route_path === 'string' && /^\/[a-z0-9/-]+$/.test(page.route_path)
  ? page.route_path.replace(/\/+$/, '') || '/' : null;

const isArticle = (page) => page?.schema?.['@type'] === 'Article'
  || page?.schema?.type === 'Article'
  || page?.schema?.['@graph']?.some((node) => node?.['@type'] === 'Article');

function cardFor(page) {
  const href = routeOf(page);
  return {
    id: page.id ?? `article-${href.split('/').at(-1)}`,
    title: page.title,
    ...(page.discovery_description || page.meta_description
      ? { text: page.discovery_description || page.meta_description } : {}),
    ...(page.discovery_eyebrow || page.eyebrow
      ? { eyebrow: page.discovery_eyebrow || page.eyebrow } : {}),
    href, action: 'Read article',
    ...(page.image_url ? { thumbnail_url: page.image_url } : {}),
  };
}

function validArticles(archive) {
  const routes = new Set();
  return archive.filter((page) => {
    const route = routeOf(page);
    if (!isArticle(page) || !route || !page.title || routes.has(route)) return false;
    routes.add(route);
    return true;
  });
}

function relatedScore(current, candidate) {
  const refs = new Set(Array.isArray(current.source_refs) ? current.source_refs : []);
  const sharedSources = (Array.isArray(candidate.source_refs) ? candidate.source_refs : [])
    .filter((ref) => refs.has(ref)).length;
  const sharedTopics = Array.isArray(current.topics) && Array.isArray(candidate.topics)
    ? candidate.topics.filter((topic) => current.topics.includes(topic)).length : 0;
  return sharedSources * 4 + sharedTopics * 2
    + (current.eyebrow && current.eyebrow === candidate.eyebrow ? 1 : 0);
}

function replaceCardGrid(page, cards) {
  const blocks = Array.isArray(page.blocks) ? page.blocks : [];
  let inserted = false;
  const updated = blocks.map((block) => {
    if (block?.kind !== 'card-grid') return block;
    if (inserted) return null;
    inserted = true;
    return { ...block, items: cards };
  }).filter(Boolean);
  if (!inserted && cards.length) updated.push({ kind: 'card-grid', items: cards });
  return { ...page, blocks: updated };
}

function composeRawArticleDiscovery(page, articles) {
  if (page?.article_discovery?.kind !== 'published-articles'
    || typeof page.body_text !== 'string') return page;
  const origin = (/<urlset\b/i.test(page.body_text)
    ? page.body_text.match(/<loc>(https?:\/\/[^/<]+)[^<]*<\/loc>/)?.[1]
    : page.body_text.match(/^\s*-\s+(https?:\/\/[^/\s]+)\//m)?.[1]);
  if (!origin) return page;
  const articleRoutes = new Set(articles.map(routeOf));
  const articlePrefix = typeof page.article_discovery.route_prefix === 'string'
    ? page.article_discovery.route_prefix : null;
  const isManagedRoute = (path) => articleRoutes.has(path)
    || (articlePrefix && path.startsWith(articlePrefix));
  if (/xml/i.test(page.content_type ?? '') || /<urlset\b/i.test(page.body_text)) {
    const baseLines = page.body_text.split('\n').filter((line) => {
      const match = line.match(/<loc>(https?:\/\/[^<]+)<\/loc>/);
      if (!match) return true;
      try { return !isManagedRoute(new URL(match[1]).pathname); } catch { return true; }
    });
    const articleLines = articles.map((article) => `  <url><loc>${origin}${routeOf(article)}</loc></url>`);
    const closing = baseLines.findIndex((line) => /<\/urlset>/.test(line));
    if (closing >= 0) baseLines.splice(closing, 0, ...articleLines);
    return { ...page, body_text: baseLines.join('\n') };
  }
  const lines = page.body_text.split('\n').filter((line) => {
    const match = line.match(/^\s*-\s+(https?:\/\/\S+)/);
    if (!match) return true;
    try { return !isManagedRoute(new URL(match[1]).pathname); } catch { return true; }
  });
  const articleLines = articles.map((article) => `- ${origin}${routeOf(article)} — ${article.title}`);
  const section = lines.findIndex((line) => /^##\s+Public pages\s*$/.test(line));
  if (section >= 0) {
    let end = section + 1;
    while (end < lines.length && /^\s*-\s+https?:\/\//.test(lines[end])) end += 1;
    lines.splice(end, 0, ...articleLines);
  } else lines.push(...articleLines);
  return { ...page, body_text: lines.join('\n') };
}

/** One reviewed archive supplies both normal and recovery article discovery. */
export function composeArchiveArticleDiscovery(selectedPages, archivedPages, pathname) {
  if (!Array.isArray(selectedPages) || !Array.isArray(archivedPages)) return selectedPages;
  const articles = validArticles(archivedPages);
  return selectedPages.map((page) => {
    const archivedRoute = archivedPages.find((candidate) => candidate?.route_path === page?.route_path);
    const effective = typeof page?.body_text === 'string' && !page?.article_discovery
      && archivedRoute?.article_discovery?.kind === 'published-articles'
      ? { ...page, article_discovery: archivedRoute.article_discovery } : page;
    const isMarkedRawRoute = effective?.article_discovery?.kind === 'published-articles'
      && typeof effective.body_text === 'string' && effective.route_path === pathname;
    if (routeOf(effective) !== pathname && !isMarkedRawRoute) return page;
    if (effective?.article_discovery?.kind === 'published-articles'
      && typeof effective.body_text === 'string') return composeRawArticleDiscovery(effective, articles);
    if (page?.schema?.['@type'] === 'CollectionPage' && page.article_discovery?.kind === 'published-articles') {
      return replaceCardGrid(page, articles.map(cardFor));
    }
    if (!isArticle(page)) return page;
    const limit = Number.isSafeInteger(page.related_article_limit) && page.related_article_limit >= 0
      ? page.related_article_limit : 3;
    const related = articles.filter((article) => routeOf(article) !== routeOf(page))
      .sort((a, b) => relatedScore(page, b) - relatedScore(page, a)
        || routeOf(a).localeCompare(routeOf(b)))
      .slice(0, limit).map(cardFor);
    return replaceCardGrid(page, related);
  });
}
