// tools/publish-content-for-discovery: the read model of a public document site, as data. Pure: the caller passes the
// document rows, the site config rows and the publication view (which fields are which, what makes a row visible, how
// the rows are ordered, the route key and the artifact field names), and gets back the documents a visitor may see, in
// order, with their route, FAQ pairs and sources. Nothing here serves a page or reads a store. Ported from the older package read-data/read-public-document-site.ts
// (bitfield-packages commit d926b7adb8), with its two test cases kept as test/read-published-documents.test.mjs.

import defaultView from '../read-data/publication-view-default.json' with { type: 'json' };

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

// The view row the caller passes, over the default view row's DATA: a field the row does not name (its selectors, say) is
// the default row's, so a view with no selectors reads the document fields as the default row names them.
const readViewConfig = raw => {
  const payload = payloadRows(raw)[0] ?? raw;
  const view = isRecord(payload) ? payload : {};
  return { ...defaultView, ...view, selectors: { ...defaultView.selectors, ...(isRecord(view.selectors) ? view.selectors : {}) } };
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

// The route key is the value of the view's route_key selector; its address prefixes (when the view names them) give the
// route and artifact addresses. A view without route_key, or a row whose key is empty, has no route.
function readRoute(payload, view) {
  const routeKey = view.route_key;
  if (!isRecord(routeKey)) return null;
  const key = readText(readSelector(payload, routeKey.selector));
  if (!key) return null;
  return {
    key,
    routeAddress: typeof routeKey.route_address_prefix === 'string' ? `${routeKey.route_address_prefix}${key}` : null,
    artifactAddress: typeof routeKey.artifact_address_prefix === 'string' ? `${routeKey.artifact_address_prefix}${key}` : null,
  };
}

function readDocument(payload, view) {
  const selectors = view.selectors;
  const id = readText(readSelector(payload, selectors.id));
  const title = readText(readSelector(payload, selectors.title));
  const slug = readText(readSelector(payload, selectors.slug));
  if (!id || !title || !slug) return null;
  const state = readText(readSelector(payload, selectors.state)) ?? '';
  return {
    id,
    title,
    slug,
    route: readRoute(payload, view),
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

// An artifact record's fields, named by the view's artifact_records: each entry maps a field of the artifact row
// (content_address_field, integrity_field, ...) to the row's own field name. The result is keyed by the entry name
// without its _field suffix, each value read as text or null.
export function readArtifactRecord(record, publicationView = {}) {
  const view = readViewConfig(publicationView);
  const fields = isRecord(view.artifact_records) ? view.artifact_records : {};
  return Object.fromEntries(
    Object.entries(fields).map(([entry, selector]) => [entry.replace(/_field$/, ''), readText(readSelector(record, selector))]),
  );
}
