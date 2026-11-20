// tools/publish-content-for-discovery: the read model of a public document site, as data. Pure: the caller passes the
// document rows, the site config rows and the publication view (which fields are which, what makes a row visible, and
// how the rows are ordered), and gets back the documents a visitor may see, in order, with their FAQ pairs and sources.
// Nothing here serves a page or reads a store. Ported from the older package read-data/read-public-document-site.ts
// (bitfield-packages commit d926b7adb8), with its two test cases kept as test/read-published-documents.test.mjs.

const DEFAULT_SELECTORS = {
  id: 'id',
  title: 'title',
  slug: 'slug',
  blocks: 'blocks',
  faq_pairs: 'faq_pairs',
  author_ref: 'author_ref',
  schema_type: 'schema_type',
  jsonld_fragments: 'jsonld_fragments',
  sources: 'sources',
  state: 'publish_state',
};

const isRecord = value => !!value && typeof value === 'object' && !Array.isArray(value);
const pathParts = path => (Array.isArray(path) ? path : String(path).split('.').filter(Boolean));
const readPath = (value, path) => pathParts(path).reduce((current, key) => (isRecord(current) ? current[key] : undefined), value);

// A selector is a path ('a.b' or ['a','b']), or { path } / { column } with a fallback.
function readSelector(row, selector) {
  if (!selector) return undefined;
  if (typeof selector === 'string' || Array.isArray(selector)) return readPath(row, selector);
  const selected = typeof selector.column === 'number' ? row[String(selector.column)] : selector.path ? readPath(row, selector.path) : undefined;
  return selected ?? selector.fallback;
}

const readText = value => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const readStringArray = value => (Array.isArray(value) ? value.map(readText).filter(item => item !== null) : []);
const readList = (value, keep) => (Array.isArray(value) ? value.filter(keep) : []);

// Rows are either { payload } records (what the store returns) or the payloads themselves.
function payloadRows(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map(row => (isRecord(row) && isRecord(row.payload) ? row.payload : row)).filter(isRecord);
}

const readViewConfig = raw => {
  const payload = payloadRows(raw)[0] ?? raw;
  return isRecord(payload) ? payload : {};
};

// One visibility rule: op is equals (the default), not_equals, in, not_in, exists or missing.
function valueMatchesRule(value, rule) {
  const op = rule.op ?? 'equals';
  const values = rule.values ?? [rule.value];
  if (op === 'exists') return value !== undefined && value !== null && value !== '';
  if (op === 'missing') return value === undefined || value === null || value === '';
  if (op === 'in') return values.includes(value);
  if (op === 'not_in') return !values.includes(value);
  if (op === 'not_equals') return value !== rule.value;
  return value === rule.value;
}

const visibleByRules = (row, rules) => (rules ?? []).every(rule => valueMatchesRule(readSelector(row, rule.selector), rule));

function readDocument(payload, view) {
  const selectors = { ...DEFAULT_SELECTORS, ...(view.selectors ?? {}) };
  const id = readText(readSelector(payload, selectors.id));
  const title = readText(readSelector(payload, selectors.title));
  const slug = readText(readSelector(payload, selectors.slug));
  if (!id || !title || !slug) return null;
  const state = readText(readSelector(payload, selectors.state)) ?? '';
  return {
    id,
    title,
    slug,
    blocks: readList(readSelector(payload, selectors.blocks), isRecord),
    faqPairs: readList(readSelector(payload, selectors.faq_pairs), isRecord),
    authorRef: readText(readSelector(payload, selectors.author_ref)) ?? undefined,
    schemaType: readText(readSelector(payload, selectors.schema_type)) ?? undefined,
    jsonldFragments: Array.isArray(readSelector(payload, selectors.jsonld_fragments)) ? readSelector(payload, selectors.jsonld_fragments) : [],
    sources: readList(readSelector(payload, selectors.sources), isRecord),
    state,
    publishState: state,
    raw: payload,
  };
}

function readConfig(payload) {
  return {
    basePath: readText(payload.base_path) ?? undefined,
    domain: readText(payload.domain) ?? undefined,
    entity: isRecord(payload.entity) ? payload.entity : undefined,
    sameAs: readStringArray(payload.sameAs ?? payload.same_as),
    botPolicy: isRecord(payload.bot_policy) ? payload.bot_policy : undefined,
    llmsTxt: payload.llms_txt === true || (isRecord(payload.llms_txt) && payload.llms_txt.enabled === true),
    indexnowKeyRef: readText(payload.indexnow_key_ref) ?? undefined,
    raw: payload,
  };
}

function compareByOrder(a, b, view) {
  const order = view.order_by;
  if (!order) return 0;
  const left = String(readSelector(a.raw, order.selector) ?? '');
  const right = String(readSelector(b.raw, order.selector) ?? '');
  const result = left.localeCompare(right);
  return order.direction === 'desc' ? -result : result;
}

// The documents a visitor may see (rules decide; with no rules every valid row is visible), in the view's order, and the site config.
export function readPublishedModel(documentRows, configRows, publicationView = {}) {
  const view = readViewConfig(publicationView);
  const documents = payloadRows(documentRows)
    .filter(row => visibleByRules(row, view.visibility_rules))
    .map(row => readDocument(row, view))
    .filter(document => document !== null)
    .sort((a, b) => compareByOrder(a, b, view));
  const configPayload = payloadRows(configRows)[0];
  return { documents, config: configPayload ? readConfig(configPayload) : null };
}
