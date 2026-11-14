export type PublicDocumentBlock = {
  id?: string;
  heading?: string;
  body?: string;
  html?: string;
  text?: string;
  items?: string[];
};

export type PublicDocumentFaqPair = {
  question?: string;
  answer?: string;
};

export type PublicDocumentSource = {
  label?: string;
  url?: string;
  citation?: string;
};

export type PublicDocument = {
  id: string;
  title: string;
  slug: string;
  blocks: PublicDocumentBlock[];
  faqPairs: PublicDocumentFaqPair[];
  authorRef?: string;
  schemaType?: string;
  jsonldFragments: unknown[];
  sources: PublicDocumentSource[];
  state: string;
  publishState: string;
  raw: Record<string, unknown>;
};

export type PublicSiteConfig = {
  basePath?: string;
  domain?: string;
  entity?: Record<string, unknown>;
  sameAs: string[];
  botPolicy?: Record<string, unknown>;
  llmsTxt: boolean;
  indexnowKeyRef?: string;
  raw: Record<string, unknown>;
};

export type PublicDocumentSiteModel = {
  documents: PublicDocument[];
  config: PublicSiteConfig | null;
};

export type PublicationSelector =
  | string
  | string[]
  | {
    path?: string | string[];
    column?: number;
    fallback?: unknown;
  };

export type PublicationVisibilityRule = {
  selector: PublicationSelector;
  op?: 'equals' | 'not_equals' | 'in' | 'not_in' | 'exists' | 'missing';
  value?: unknown;
  values?: unknown[];
};

export type PublicationViewConfig = {
  selectors?: Partial<Record<
    | 'id'
    | 'title'
    | 'slug'
    | 'blocks'
    | 'faq_pairs'
    | 'author_ref'
    | 'schema_type'
    | 'jsonld_fragments'
    | 'sources'
    | 'state',
    PublicationSelector
  >>;
  visibility_rules?: PublicationVisibilityRule[];
  order_by?: {
    selector: PublicationSelector;
    direction?: 'asc' | 'desc';
  };
};

const DEFAULT_SELECTORS: Required<NonNullable<PublicationViewConfig['selectors']>> = {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function pathParts(path: string | string[]): string[] {
  return Array.isArray(path) ? path : path.split('.').filter(Boolean);
}

function readPath(value: unknown, path: string | string[]): unknown {
  return pathParts(path).reduce(
    (current, key) => (isRecord(current) ? current[key] : undefined),
    value,
  );
}

function readSelector(row: Record<string, unknown>, selector: PublicationSelector | undefined): unknown {
  if (!selector) return undefined;
  if (typeof selector === 'string' || Array.isArray(selector)) return readPath(row, selector);
  const selected = typeof selector.column === 'number'
    ? row[String(selector.column)]
    : selector.path
      ? readPath(row, selector.path)
      : undefined;
  return selected ?? selector.fallback;
}

function readText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map(readText).filter((item): item is string => item !== null)
    : [];
}

function payloadRows(raw: unknown): Record<string, unknown>[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((row) => (isRecord(row) && isRecord(row.payload) ? row.payload : row))
    .filter((payload): payload is Record<string, unknown> => isRecord(payload));
}

function readViewConfig(raw: unknown): PublicationViewConfig {
  const payload = payloadRows(raw)[0] ?? raw;
  return isRecord(payload) ? payload : {};
}

function readBlocks(value: unknown): PublicDocumentBlock[] {
  if (!Array.isArray(value)) return [];
  return value.filter((block): block is PublicDocumentBlock => isRecord(block));
}

function readFaqPairs(value: unknown): PublicDocumentFaqPair[] {
  if (!Array.isArray(value)) return [];
  return value.filter((pair): pair is PublicDocumentFaqPair => isRecord(pair));
}

function readSources(value: unknown): PublicDocumentSource[] {
  if (!Array.isArray(value)) return [];
  return value.filter((source): source is PublicDocumentSource => isRecord(source));
}

function readJsonldFragments(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function valueMatchesRule(value: unknown, rule: PublicationVisibilityRule): boolean {
  const op = rule.op ?? 'equals';
  const values = rule.values ?? [rule.value];
  if (op === 'exists') return value !== undefined && value !== null && value !== '';
  if (op === 'missing') return value === undefined || value === null || value === '';
  if (op === 'in') return values.includes(value);
  if (op === 'not_in') return !values.includes(value);
  if (op === 'not_equals') return value !== rule.value;
  return value === rule.value;
}

function visibleByRules(row: Record<string, unknown>, rules: PublicationVisibilityRule[] | undefined): boolean {
  return (rules ?? []).every((rule) => valueMatchesRule(readSelector(row, rule.selector), rule));
}

function readDocument(payload: Record<string, unknown>, view: PublicationViewConfig): PublicDocument | null {
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
    blocks: readBlocks(readSelector(payload, selectors.blocks)),
    faqPairs: readFaqPairs(readSelector(payload, selectors.faq_pairs)),
    authorRef: readText(readSelector(payload, selectors.author_ref)) ?? undefined,
    schemaType: readText(readSelector(payload, selectors.schema_type)) ?? undefined,
    jsonldFragments: readJsonldFragments(readSelector(payload, selectors.jsonld_fragments)),
    sources: readSources(readSelector(payload, selectors.sources)),
    state,
    publishState: state,
    raw: payload,
  };
}

function readConfig(payload: Record<string, unknown>): PublicSiteConfig {
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

function compareByOrder(a: PublicDocument, b: PublicDocument, view: PublicationViewConfig): number {
  const order = view.order_by;
  if (!order) return 0;
  const left = String(readSelector(a.raw, order.selector) ?? '');
  const right = String(readSelector(b.raw, order.selector) ?? '');
  const result = left.localeCompare(right);
  return order.direction === 'desc' ? -result : result;
}

export function readPublicDocumentSiteModel(
  documentsRaw: unknown,
  configRaw: unknown,
  publicationViewRaw?: unknown,
): PublicDocumentSiteModel {
  const view = readViewConfig(publicationViewRaw);
  const documents = payloadRows(documentsRaw)
    .filter((row) => visibleByRules(row, view.visibility_rules))
    .map((row) => readDocument(row, view))
    .filter((document): document is PublicDocument => document !== null)
    .sort((a, b) => compareByOrder(a, b, view));
  const configPayload = payloadRows(configRaw)[0];

  return {
    documents,
    config: configPayload ? readConfig(configPayload) : null,
  };
}
