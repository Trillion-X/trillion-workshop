// Anonymous display of the Marketplace for anyone, signed in or not, read by gettrillion.ai's public Marketplace:
//
//   GET /marketplace/catalog?q=&kind=&offset=&limit=   publicToolCatalog: one page of every listing, a card's words each;
//                                                       q holds every one of its words, title matches first
//   GET /marketplace/catalog?ids=<id>,<id>              the named listings only, in the order named (a page that features
//                                                       a few reads their card words from the one kept copy at once)
//   GET /marketplace/listing?id=<tool or workflow id>   publicListing: one of Trillion's own listings whole, for its page
//
// The listings are Trillion's own shared tools and workflows, the same rows the in-app Marketplace reads
// (src/pursuit-plan.mjs sharedMarketplaceRows), and the tools whose maker explicitly chose public website listing.
//
// Invariants:
//   1. A maker's tool shows its display words only: never its maker's identity, its invocation, inputs, runs or
//      held-value names, and it has no page of its own.
//   2. Trillion's own rows also carry their icon, the cover of the recording that shows them and how many steps a
//      workflow walks, so a card leads with them; their page adds what the tool asks for and only actions its descriptor
//      supports: a placed invocation, a real screen route, or a workflow start.
//   3. One page can carry the whole Marketplace (a few hundred rows of display words), so a reader may ask once.
export const MOST_PER_PAGE = 1000;
const clean = value => typeof value === 'string' ? value.trim().slice(0, 240) : '';
const whole = value => typeof value === 'string' ? value.trim().slice(0, 4000) : '';
// A web address a page may draw as a picture or a video; anything else is left off.
const webAddress = value => {
  if (typeof value !== 'string') return null;
  try { return new URL(value).protocol === 'https:' ? value : null; } catch { return null; }
};

export function publicToolCatalog({ shared = { tools: [], workflows: [] }, published = [] } = {}, { q = '', kind = '', offset = 0, limit = 20, ids = [] } = {}) {
  const query = clean(q).toLocaleLowerCase();
  const start = Number.isSafeInteger(offset) ? Math.max(0, offset) : 0;
  const count = Number.isSafeInteger(limit) ? Math.min(MOST_PER_PAGE, Math.max(1, limit)) : 20;
  const own = [...shared.workflows, ...shared.tools].flatMap(row => {
    const title = clean(row.label), job = clean(row.job);
    if (!title || !job) return [];
    const cover = webAddress(row.recording?.cover);
    return [{
      id: row.id, kind: row.kind, title, job, from: 'trillion',
      ...(typeof row.icon === 'string' && row.icon ? { icon: row.icon } : {}),
      ...(cover ? { cover } : {}),
      ...(Array.isArray(row.steps) && row.steps.length ? { steps: row.steps.length } : {}),
    }];
  });
  const makers = published.flatMap(({ row }) => {
    if (row?.show_on_public_site !== true) return [];
    const title = clean(row.label);
    const job = clean(row.job);
    if (!title || !job) return [];
    const amount = row.billing?.payers?.includes('trillion-credit') && Number.isSafeInteger(row.billing.price_micros)
      ? `$${(row.billing.price_micros / 1e6).toFixed(4)}` : null;
    return [{ kind: 'tool', title, job, from: 'maker', ...(amount ? { price: amount, per: row.billing.per ?? 'completed run' } : {}) }];
  });
  // A search holds when every word is in the title or the job; listings with more of the words in their title come
  // first, the rest keep the Marketplace's own order.
  const words = query.split(/\s+/).filter(Boolean);
  const titleHits = item => words.filter(word => item.title.toLocaleLowerCase().includes(word)).length;
  const named = new Map((Array.isArray(ids) ? ids : []).slice(0, MOST_PER_PAGE).map((id, at) => [id, at]));
  const rows = [...own, ...makers]
    .filter(item => !named.size || named.has(item.id))
    .filter(item => !kind || item.kind === kind)
    .filter(item => words.every(word => `${item.title} ${item.job}`.toLocaleLowerCase().includes(word)))
    .map((item, at) => ({ item, at, hits: titleHits(item) }))
    .sort((a, b) => (named.size ? named.get(a.item.id) - named.get(b.item.id) : 0) || b.hits - a.hits || a.at - b.at)
    .map(({ item }) => item);
  return { items: rows.slice(start, start + count), total: rows.length, offset: start, limit: count };
}

// What one input is, in a person's words: a file, a web address, one of a few choices, a list, yes or no, words, a
// number, details (an object) or a value.
const inputKind = property => property?.format === 'namespace-file' ? 'file'
  : property?.format === 'uri' ? 'web address'
  : Array.isArray(property?.enum) ? 'one of'
  : property?.type === 'array' ? 'list'
  : property?.type === 'boolean' ? 'yes or no'
  : property?.type === 'string' ? 'words'
  : property?.type === 'number' || property?.type === 'integer' ? 'number'
  : property?.type === 'object' ? 'details'
  : 'value';

/** One of Trillion's own rows (src/pursuit-plan.mjs marketplaceRow) as its public page reads it, or null. */
export function publicListing(row) {
  const title = clean(row?.label);
  const job = whole(row?.job);
  if (!row || !/^(tool|workflow):[A-Za-z0-9:._-]{1,120}$/.test(row.id ?? '') || !title || !job) return null;
  const schema = row.input_schema && typeof row.input_schema === 'object' ? row.input_schema : {};
  const needed = new Set(Array.isArray(schema.required) ? schema.required : []);
  const inputs = Object.entries(schema.properties && typeof schema.properties === 'object' ? schema.properties : {}).map(([name, property]) => ({
    name,
    kind: inputKind(property),
    says: whole(property?.description ?? property?.title ?? ''),
    needed: needed.has(name),
    ...(Array.isArray(property?.enum) ? { choices: property.enum.slice(0, 24).map(String) } : {}),
  }));
  const recording = row.recording && webAddress(row.recording.video) ? {
    video: row.recording.video,
    ...(webAddress(row.recording.cover) ? { cover: row.recording.cover } : {}),
    ...(clean(row.recording.title) ? { title: clean(row.recording.title) } : {}),
    ...(clean(row.recording.caption) ? { caption: clean(row.recording.caption) } : {}),
  } : null;
  const routePaths = Array.isArray(row.screen?.route_paths)
    ? row.screen.route_paths.filter(path => typeof path === 'string' && path.startsWith('/') && !path.startsWith('//'))
    : [];
  const call = row.kind === 'workflow'
    ? { tool: 'start_workflow', arguments: { workflow_id: row.id } }
    : row.runnable === true ? { tool: 'run_tool', arguments: { tool_id: row.id } } : null;
  return {
    id: row.id,
    kind: row.kind,
    title,
    job,
    ...(whole(row.description) && whole(row.description) !== job ? { about: whole(row.description) } : {}),
    ...(typeof row.icon === 'string' && row.icon ? { icon: row.icon } : {}),
    inputs,
    steps: Array.isArray(row.steps) ? row.steps.map(clean).filter(Boolean) : [],
    ...(!call || routePaths.length ? { open: { route_paths: [...new Set(routePaths)] } } : {}),
    recording,
    ...(call ? { call } : {}),
  };
}
