// tools/research-a-creator-or-topic/do-work/arc-inspiration-intake.mjs
//
// Reads the Arc browser's saved tabs from its sidebar file and plans the rows the inspiration library needs: one row per
// canonical address, classified by the rules in arc-inspiration-intake.json. Pure: text in, rows out. Nothing here opens
// a page, writes a database or takes a screenshot; the runner that does those is separate.
//
// Every AI chat thread keeps its title, space and provider and is marked for later mining; it is never opened. Mail,
// calendar, document, search, account, own-app and local addresses keep the host and kind only, with no title.
import rules from './arc-inspiration-intake.json' with { type: 'json' };

// Arc stores records as flat id, record pairs. A tab is a record whose data carries a tab with a saved address.
function recordPairs(items) {
  const records = new Map();
  for (let i = 0; i < items.length - 1; i += 2) {
    if (typeof items[i] === 'string' && items[i + 1] && typeof items[i + 1] === 'object') records.set(items[i], items[i + 1]);
  }
  return records;
}

// The space a record sits in: walk parentID until a record names a space container.
function spaceTitleOf(record, records, spaceTitles) {
  let current = record;
  for (let depth = 0; current && depth < 50; depth++) {
    const containerType = current.data?.itemContainer?.containerType ?? {};
    if (containerType.spaceItems) return spaceTitles.get(containerType.spaceItems._0) ?? '';
    current = records.get(current.parentID);
  }
  return '';
}

// Returns { tabs: [{ url, title, space }] } for every saved tab, in file order. Throws on a file that is not Arc's sidebar.
export function readArcTabs(text) {
  let root;
  try { root = JSON.parse(text || '{}'); } catch (problem) { throw new Error(`The file is not valid JSON: ${problem.message}`); }
  const containers = Array.isArray(root?.sidebar?.containers) ? root.sidebar.containers : null;
  if (!containers) throw new Error('The file has no sidebar containers.');
  // Arc moves its item list between containers when it rewrites the file, so take the longest one.
  const lists = containers.map(c => c?.items).filter(Array.isArray);
  if (!lists.length) throw new Error('The sidebar file has no item list.');
  const items = lists.reduce((best, list) => (list.length > best.length ? list : best), []);
  const spaceTitles = new Map();
  for (const container of containers) {
    for (const space of Array.isArray(container?.spaces) ? container.spaces : []) {
      if (space && typeof space === 'object' && typeof space.id === 'string') spaceTitles.set(space.id, space.title || '');
    }
  }
  const records = recordPairs(items);
  const tabs = [];
  for (const record of records.values()) {
    const tab = record.data?.tab;
    if (!tab || typeof tab !== 'object' || typeof tab.savedURL !== 'string' || !tab.savedURL) continue;
    tabs.push({ url: tab.savedURL, title: tab.savedTitle || '', space: spaceTitleOf(record, records, spaceTitles) });
  }
  return { tabs };
}

// Drops utm_ and the tracking parameters, the fragment and a trailing slash. Keeps the parameters that name the thing (a
// YouTube v). youtu.be becomes youtube.com/watch.
export function canonicalUrl(url) {
  const parsed = new URL(url);
  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  if (host === 'youtu.be') return `https://youtube.com/watch?v=${parsed.pathname.replace(/^\/+/, '').split('/')[0]}`;
  const query = [...parsed.searchParams].filter(([key]) => !key.startsWith('utm_') && !rules.tracking_params.includes(key));
  if (host.endsWith('youtube.com')) {
    const video = query.filter(([key]) => key === 'v');
    return `https://youtube.com${parsed.pathname.replace(/\/+$/, '')}${video.length ? `?v=${encodeURIComponent(video[0][1])}` : ''}`;
  }
  const search = new URLSearchParams(query).toString();
  return `https://${host}${parsed.pathname.replace(/\/+$/, '')}${search ? `?${search}` : ''}`;
}

export function hostOf(url) {
  return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
}

const underHost = (host, names) => names.some(name => host === name || host.endsWith(`.${name}`));

// The row id: record:inspiration-item:<16 hex of the BLAKE3 of the canonical address>. BLAKE3 is the declared identity
// owner; this file takes the 16 hex from it through the content-identity owner in the caller.
export function inspirationItemId(canonical, blake3Hex) {
  return `record:inspiration-item:${blake3Hex(canonical).slice(0, 16)}`;
}

// Classifies one tab. Returns { kind, why, showsContent, provider, mineLater, tags }.
export function classifyTab(url, title = '') {
  const host = hostOf(url);
  const provider = Object.entries(rules.ai_chat_hosts).find(([name]) => underHost(host, [name]))?.[1] ?? null;
  if (provider) {
    return { kind: 'ai-chat', why: 'ai chat thread: mine later for content and decisions', showsContent: false, provider, mineLater: true, tags: [] };
  }
  const hostOnly = Object.entries(rules.host_only_hosts).find(([name]) => underHost(host, [name]));
  if (hostOnly) return { kind: 'other', why: `${hostOnly[1]} page, not inspiration`, showsContent: false, provider: null, mineLater: false, tags: [] };
  const first = host.split('.')[0];
  if (rules.skip_host_prefixes.includes(first) || rules.skip_hosts.includes(host) || rules.skip_host_suffixes.some(s => host.endsWith(s))) {
    return { kind: 'other', why: 'account, admin, local or government host', showsContent: false, provider: null, mineLater: false, tags: [] };
  }
  const tags = rules.title_tags.filter(([pattern]) => new RegExp(pattern, 'i').test(title)).map(([, label]) => label);
  const tagWhy = tags.length ? `${tags.join('; ')} (from title); ` : '';
  for (const [kind, hosts] of Object.entries(rules.kind_hosts)) {
    if (underHost(host, hosts)) {
      return { kind, why: `${tagWhy}rule: ${kind} host`, showsContent: true, provider: null, mineLater: false, tags };
    }
  }
  const depth = new URL(url).pathname.split('/').filter(Boolean).length;
  if (depth <= 1) {
    return { kind: rules.kind_default_for_short_paths, why: `${tagWhy}rule: root or one-level page on an unlisted host`, showsContent: true, provider: null, mineLater: false, tags };
  }
  return { kind: rules.kind_default_for_deep_paths, why: `${tagWhy}deep path on an unlisted host, review`, showsContent: true, provider: null, mineLater: false, tags };
}

// Plans the rows for the tabs not already held. One row per canonical address; a repeated address adds to its tab count.
// heldCanonicals is a Set of canonical addresses already in the library tables. Returns { rows, counts }.
export function planIntake({ tabs, heldCanonicals, blake3Hex, firstSeen }) {
  const byCanonical = new Map();
  for (const tab of tabs) {
    const canonical = canonicalUrl(tab.url);
    if (byCanonical.has(canonical)) { byCanonical.get(canonical).tabs += 1; continue; }
    const shown = classifyTab(tab.url, tab.title);
    byCanonical.set(canonical, {
      id: inspirationItemId(canonical, blake3Hex),
      url: tab.url,
      canonical_url: canonical,
      title: shown.showsContent || shown.mineLater ? tab.title : null,
      site: hostOf(tab.url),
      kind: shown.kind,
      why: shown.why,
      shows_content: shown.showsContent,
      space: tab.space,
      tabs: 1,
      provider: shown.provider,
      mine_later: shown.mineLater,
      tags: shown.tags,
      source: 'arc-sidebar',
      first_seen: firstSeen,
    });
  }
  const rows = [...byCanonical.values()].filter(row => !heldCanonicals.has(row.canonical_url));
  const counts = { tabs: tabs.length, unique: byCanonical.size, held: byCanonical.size - rows.length, new: rows.length };
  counts.byKind = Object.fromEntries(Object.keys(rules.kind_hosts).concat(['site', 'ai-chat', 'other']).map(kind => [kind, rows.filter(r => r.kind === kind).length]));
  return { rows, counts };
}

