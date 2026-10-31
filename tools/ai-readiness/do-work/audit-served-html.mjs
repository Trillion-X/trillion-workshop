// Reads a page the way an answer engine does: the HTML it is served with, no script run. The checks are the rows of
// ../read-data/ai-readiness-checks.json; this file only knows how to read a row's shape (elements, each, count, text,
// words, head, headings_in_order, dates, robots, links, any_of, all_of, applies_when), never what a check is about.
import rows from '../read-data/ai-readiness-checks.json' with { type: 'json' };

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const RAW = new Set(['script', 'style', 'textarea', 'title']);
const ENDS_ON_OPEN = new Set(['p', 'li', 'option', 'tr', 'td', 'th', 'dt', 'dd']);
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '-', ndash: '-', hellip: '...' };
const decode = text => text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name) => {
  if (name[0] === '#') { const code = name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10); return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : ' '; }
  return ENTITIES[name.toLowerCase()] ?? whole;
});
const words = text => text.split(/\s+/).filter(Boolean);
const regexOf = (pattern, flags = 'i') => new RegExp(pattern, flags);

function attributesOf(raw) {
  const attrs = {};
  for (const [, name, double, single, bare] of raw.matchAll(/([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) {
    const key = name.toLowerCase();
    if (!(key in attrs)) attrs[key] = decode(double ?? single ?? bare ?? '');
  }
  return attrs;
}

/** The page as a flat list of elements in document order, each knowing where its content sits in the source. */
export function parseHtml(html) {
  const source = String(html ?? '').replace(/<!--[\s\S]*?-->/g, '');
  const elements = [];
  const stack = [];
  const tags = /<(\/?)([a-zA-Z][\w:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
  const closeTop = at => { const top = stack.pop(); top.contentEnd = at; };
  for (let match = tags.exec(source); match; match = tags.exec(source)) {
    const [whole, closing, rawName, rawAttrs] = match;
    const tag = rawName.toLowerCase();
    if (closing) {
      const open = stack.map(element => element.tag).lastIndexOf(tag);
      while (open >= 0 && stack.length > open) closeTop(match.index);
      continue;
    }
    if (ENDS_ON_OPEN.has(tag) && stack.at(-1)?.tag === tag) closeTop(match.index);
    const element = { tag, attrs: attributesOf(rawAttrs), start: match.index, contentStart: tags.lastIndex, contentEnd: source.length };
    elements.push(element);
    if (RAW.has(tag)) {
      const end = source.toLowerCase().indexOf(`</${tag}`, tags.lastIndex);
      element.contentEnd = end < 0 ? source.length : end;
      tags.lastIndex = end < 0 ? source.length : source.indexOf('>', end) + 1 || source.length;
    } else if (!VOID.has(tag) && !/\/\s*$/.test(rawAttrs)) stack.push(element);
    void whole;
  }
  const page = { source, elements };
  page.textOf = element => textBetween(source, element.contentStart, element.contentEnd);
  const main = elements.find(element => element.tag === 'main');
  page.mainText = main ? page.textOf(main) : null;
  page.main = main ?? null;
  page.visibleText = textBetween(source.replace(/<head[\s>][\s\S]*?<\/head>/i, ''), 0, source.length);
  page.structuredData = elements.filter(element => element.tag === 'script' && /ld\+json/i.test(element.attrs.type ?? ''))
    .map(element => source.slice(element.contentStart, element.contentEnd)).join('\n');
  return page;
}

function textBetween(source, from, to) {
  return decode(source.slice(from, to)
    .replace(/<(script|style|noscript|template)[\s>][\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

const inside = (outer, inner) => inner.start >= outer.contentStart && inner.start < outer.contentEnd;
const attr = (element, name) => (element.attrs[name] ?? '').trim();

function nameOf(page, element) {
  if (attr(element, 'aria-label') || attr(element, 'title')) return true;
  const by = attr(element, 'aria-labelledby');
  if (by && by.split(/\s+/).some(id => { const target = page.elements.find(other => other.attrs.id === id); return target && page.textOf(target); })) return true;
  if (element.tag === 'input' && attr(element, 'value')) return true;
  if (VOID.has(element.tag)) return false;
  if (page.textOf(element)) return true;
  return page.elements.some(other => inside(element, other) && (attr(other, 'aria-label') || (other.tag === 'img' && attr(other, 'alt')) || (other.tag === 'svg' && page.textOf(other))));
}

function labelled(page, element) {
  if (attr(element, 'aria-label') || attr(element, 'aria-labelledby') || attr(element, 'title')) return true;
  const id = attr(element, 'id');
  return page.elements.some(other => other.tag === 'label' && ((id && other.attrs.for === id && page.textOf(other)) || (inside(other, element) && page.textOf(other))));
}

const matchesAny = (element, names, pattern) => names.split('|').some(name => name in element.attrs && regexOf(pattern).test(element.attrs[name]));

function selects(page, element, selector) {
  if (selector.tags && !selector.tags.includes(element.tag)) return false;
  if (selector.within_main && page.main && !inside(page.main, element)) return false;
  if (selector.attr_present?.some(name => !(name in element.attrs))) return false;
  if (selector.attr_absent?.some(name => name in element.attrs)) return false;
  for (const [names, pattern] of Object.entries(selector.attr_matches ?? {})) if (!matchesAny(element, names, pattern)) return false;
  for (const [name, pattern] of Object.entries(selector.attr_absent_values ?? {})) if (regexOf(pattern).test(element.attrs[name] ?? '')) return false;
  if (selector.text_pattern && !regexOf(selector.text_pattern).test(page.textOf(element))) return false;
  return true;
}

function nextParagraph(page, element) {
  return page.elements.find(other => other.tag === 'p' && other.start >= element.contentEnd);
}

function holds(page, element, predicates) {
  for (const [name, value] of Object.entries(predicates)) {
    if (name === 'named' && nameOf(page, element) !== value) return false;
    if (name === 'labelled' && labelled(page, element) !== value) return false;
    if (name === 'attr_present' && !(value in element.attrs)) return false;
    if (name === 'attr_not_matches' && Object.entries(value).some(([key, pattern]) => key in element.attrs && regexOf(pattern).test(element.attrs[key].trim()))) return false;
    if (name === 'text_pattern' && !regexOf(value).test(page.textOf(element))) return false;
    if (name === 'text_words') { const count = words(page.textOf(element)).length; if (count < (value.min ?? 0) || count > (value.max ?? Infinity)) return false; }
    if (name === 'following_paragraph_words') {
      const paragraph = nextParagraph(page, element);
      const count = paragraph ? words(page.textOf(paragraph)).length : 0;
      if (count < (value.min ?? 0) || count > (value.max ?? Infinity)) return false;
    }
  }
  return true;
}

const within = (count, bounds) => count >= (bounds.min ?? 0) && count <= (bounds.max ?? Infinity);
const example = (page, element, limits) => page.source.slice(element.start, element.start + limits.example_characters * 2).replace(/\s+/g, ' ').slice(0, limits.example_characters);

const DATE_FIELDS = {
  published: { names: /^(article:published_time|date|pubdate|datepublished|og:published_time)$/i, ld: /"datePublished"\s*:\s*"([^"]+)"/g },
  modified: { names: /^(article:modified_time|og:updated_time|datemodified|last-modified)$/i, ld: /"dateModified"\s*:\s*"([^"]+)"/g },
};

function datesOf(page, role) {
  const field = DATE_FIELDS[role];
  const found = page.elements.filter(element => (element.tag === 'meta' || element.tag === 'time') && field.names.test(element.attrs.property ?? element.attrs.name ?? element.attrs.itemprop ?? ''))
    .map(element => element.attrs.content ?? element.attrs.datetime);
  return [...found, ...[...page.structuredData.matchAll(field.ld)].map(match => match[1])]
    .map(value => Date.parse(value)).filter(Number.isFinite);
}

/** The rules of a robots.txt that apply to one agent (its own group, else `*`), and whether a path is allowed. */
export function robotsAllows(robotsTxt, agent, path = '/') {
  const groups = [];
  let current = null;
  let lastWasAgent = false;
  for (const raw of String(robotsTxt).split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    const split = line.indexOf(':');
    if (split < 0) continue;
    const key = line.slice(0, split).trim().toLowerCase();
    const value = line.slice(split + 1).trim();
    if (key === 'user-agent') { if (!lastWasAgent) { current = { agents: [], rules: [] }; groups.push(current); } current.agents.push(value.toLowerCase()); lastWasAgent = true; continue; }
    lastWasAgent = false;
    if (current && (key === 'allow' || key === 'disallow')) current.rules.push({ allow: key === 'allow', path: value });
  }
  const group = groups.find(candidate => candidate.agents.includes(agent.toLowerCase())) ?? groups.find(candidate => candidate.agents.includes('*'));
  if (!group) return true;
  let best = null;
  for (const rule of group.rules) {
    if (!rule.path || !path.startsWith(rule.path.replace(/\*.*$/, '').replace(/\$$/, ''))) continue;
    if (!best || rule.path.length > best.path.length || (rule.path.length === best.path.length && rule.allow)) best = rule;
  }
  return best ? best.allow : true;
}

function linksOf(page, pageUrl) {
  const found = new Map();
  for (const element of page.elements) {
    if (element.tag !== 'a' || !element.attrs.href) continue;
    const href = element.attrs.href.trim();
    if (/^(#|mailto:|tel:|javascript:|data:)/i.test(href)) continue;
    let url;
    try { url = new URL(href, pageUrl ?? undefined); } catch { continue; }
    if (!/^https?:$/.test(url.protocol)) continue;
    url.hash = '';
    found.set(url.href, url);
  }
  return [...found.values()];
}

async function evaluate(page, check, context) {
  const { limits } = rows;
  if (check.applies_when && (await evaluate(page, check.applies_when, context)).status !== 'pass') return { status: 'not_applicable' };
  if (check.all_of) {
    const parts = await Promise.all(check.all_of.map(part => evaluate(page, part, context)));
    const failed = parts.find(part => part.status === 'fail');
    return failed ?? parts.find(part => part.status === 'not_checked') ?? { status: 'pass' };
  }
  if (check.any_of) {
    const parts = await Promise.all(check.any_of.map(part => evaluate(page, part, context)));
    return parts.some(part => part.status === 'pass') ? { status: 'pass' } : { status: 'fail' };
  }
  if (check.robots) {
    if (context.robotsTxt === null) return { status: 'not_checked' };
    return { status: robotsAllows(context.robotsTxt, check.robots.agent, check.robots.path) ? 'pass' : 'fail' };
  }
  if (check.links) {
    const links = linksOf(page, context.pageUrl);
    if (check.links.external_min !== undefined) {
      const host = context.pageUrl ? new URL(context.pageUrl).host : null;
      return { status: links.filter(url => url.host !== host).length >= check.links.external_min ? 'pass' : 'fail' };
    }
    if (!context.resolveLink) return { status: 'not_checked' };
    const asked = links.slice(0, limits.most_links_asked);
    const broken = [];
    for (let at = 0; at < asked.length; at += 5) {
      await Promise.all(asked.slice(at, at + 5).map(async url => {
        const status = await context.resolveLink(url.href).catch(() => 0);
        if (status === 0 || status === 404 || status === 410 || status >= 500) broken.push(url.href);
      }));
    }
    return broken.length ? { status: 'fail', examples: broken.slice(0, limits.most_examples) } : { status: 'pass' };
  }
  if (check.head) {
    const title = page.elements.find(element => element.tag === 'title');
    const description = page.elements.find(element => element.tag === 'meta' && element.attrs.name?.toLowerCase() === 'description');
    const ok = (title ? page.textOf(title).length : 0) >= (check.head.title_min_characters ?? 0) && attr(description ?? { attrs: {} }, 'content').length >= (check.head.meta_description_min_characters ?? 0);
    return { status: ok ? 'pass' : 'fail' };
  }
  if (check.headings_in_order) {
    const levels = page.elements.filter(element => /^h[1-6]$/.test(element.tag));
    const jumps = levels.filter((element, at) => at > 0 && Number(element.tag[1]) > Number(levels[at - 1].tag[1]) + 1);
    return jumps.length ? { status: 'fail', examples: jumps.slice(0, limits.most_examples).map(element => example(page, element, limits)) } : { status: 'pass' };
  }
  if (check.dates) {
    const times = datesOf(page, check.dates.role);
    if (!times.length) return { status: 'fail' };
    return { status: check.dates.within_days === undefined || Math.max(...times) >= context.now - check.dates.within_days * 86_400_000 ? 'pass' : 'fail' };
  }
  if (check.words) return { status: within(words(page.visibleText).length, check.words) ? 'pass' : 'fail' };
  if (check.text) {
    const haystack = check.text.source === 'structured_data' ? page.structuredData : words(page.mainText ?? page.visibleText).slice(0, check.text.first_words ?? Infinity).join(' ');
    const matches = haystack.match(new RegExp(check.text.pattern, `${check.text.flags ?? ''}g`)) ?? [];
    return { status: matches.length >= (check.text.min_matches ?? 1) ? 'pass' : 'fail' };
  }
  if (check.elements) {
    const selectors = [].concat(check.elements);
    let matched = page.elements.filter(element => selectors.some(selector => selects(page, element, selector)));
    if (check.nth !== undefined) matched = matched.slice(check.nth, check.nth + 1);
    if (check.count && !within(matched.length, check.count)) return { status: 'fail', examples: matched.slice(0, limits.most_examples).map(element => example(page, element, limits)) };
    const failing = check.each ? matched.filter(element => !holds(page, element, check.each)) : [];
    return failing.length ? { status: 'fail', examples: failing.slice(0, limits.most_examples).map(element => example(page, element, limits)), count: failing.length } : { status: 'pass' };
  }
  throw new Error('This check names nothing the audit can read.');
}

/**
 * Audits one page's served HTML. `robotsTxt` is the host's robots.txt text (null when it was not read);
 * `resolveLink(url) => status` answers a link (omit it and the link check is not run); `pageUrl` resolves relative links.
 * The score is the share of scored checks that pass, among those that apply and could be run.
 */
export async function auditServedHtml({ html, robotsTxt = null, resolveLink = null, pageUrl = null, now = Date.now(), checks = rows.checks, skip = [] } = {}) {
  const page = parseHtml(html);
  // A page that asks not to be indexed is not meant to be found, so there is nothing to score.
  const keptOut = page.elements.some(element => element.tag === 'meta' && /^(robots|googlebot)$/i.test(element.attrs.name ?? '') && /\bnoindex\b/i.test(element.attrs.content ?? ''));
  if (keptOut) return { indexable: false, score: null, passed: 0, failed: 0, missing: [], suggestions: [], not_checked: [], results: [] };
  const context = { robotsTxt, resolveLink, pageUrl, now };
  const results = [];
  for (const row of checks) {
    const outcome = skip.includes(row.id) ? { status: 'not_applicable' } : row.skip_when && (await evaluate(page, row.skip_when, context)).status === 'pass'
      ? { status: 'not_applicable' }
      : await evaluate(page, row.applies_when ? { ...row.check, applies_when: row.applies_when } : row.check, context);
    results.push({ id: row.id, area: row.area, scored: row.scored !== false, says: row.says, fix: row.fix, from: row.from, ...outcome });
  }
  const scored = results.filter(result => result.scored && (result.status === 'pass' || result.status === 'fail'));
  const passed = scored.filter(result => result.status === 'pass').length;
  return {
    indexable: true,
    score: scored.length ? Math.round(100 * passed / scored.length) : null,
    passed,
    failed: scored.length - passed,
    missing: results.filter(result => result.scored && result.status === 'fail'),
    suggestions: results.filter(result => !result.scored && result.status === 'fail'),
    not_checked: results.filter(result => result.status === 'not_checked').map(result => result.id),
    results,
  };
}

export const aiReadinessAreas = rows.areas;
