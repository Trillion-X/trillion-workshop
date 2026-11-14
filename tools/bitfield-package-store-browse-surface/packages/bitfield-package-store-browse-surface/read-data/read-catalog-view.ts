type CatalogRowKind = string;

type CatalogRefList = string[];
type CatalogTrustRoot = Record<string, unknown>;

type CatalogPreviewArt = {
  kind?: string;
  owner_identity?: string;
  source_package?: string;
  stored_bytes_name?: string;
  media_type?: string;
  source_path?: string;
  byte_length?: number;
  material_ref?: string;
  data_url?: string;
};

type CatalogPurchaseOption = {
  amount_due_today_cents?: string;
  cadence?: string;
  contract_ref?: string;
  currency_ref?: string;
  line_item_label?: string;
  package_file_ref?: string;
  provider_ref?: string;
  purchase_option_ref?: string;
  quote_reservation_ref?: string;
  quote_signature_ref?: string;
  recurring_amount_cents?: string;
  resource_ref?: string;
  settlement_amounts?: Record<string, unknown>;
  settlement_policy?: Record<string, unknown>;
  shape_ref?: string;
};

type CatalogFindingFacet = {
  id: string;
  label: string;
  group: string;
  description?: string;
};

type CatalogFindingDetailBlock = {
  id: string;
  title: string;
  body?: string;
  items?: string[];
};

type CatalogPackageFinding = {
  schema?: string;
  row_id?: string;
  title?: string;
  creator_label?: string;
  kind_label?: string;
  summary?: string;
  access_label?: string;
  source_label?: string;
  execution_label?: string;
  cta_label?: string;
  price_label?: string;
  capabilities?: string[];
  facets?: CatalogFindingFacet[];
  shelf_ids?: string[];
  search?: {
    aliases?: string[];
    text?: string;
  };
  ranking?: {
    score?: number;
    signals?: CatalogFindingFacet[];
    result_explanations?: string[];
  };
  detail_blocks?: CatalogFindingDetailBlock[];
};

type CatalogDiscoveryConfig = {
  id: string;
  label: string;
  description?: string;
  filter_id?: string;
  query?: string;
  priority?: number;
};

type CatalogDiscoveryPayload = {
  categories?: unknown;
  shelves?: unknown;
  replacement_catalog?: unknown;
  no_result_recovery?: unknown;
};

type BitfieldPackageCatalogRow = {
  row_kind: CatalogRowKind;
  row_id: string;
  package_identity?: string;
  recipe_identity?: string;
  package_set_identity?: string;
  display_name: string;
  summary: string;
  capability_metadata?: {
    public_capability_summary?: string[];
  };
  install?: {
    install_subject?: Record<string, unknown>;
    target?: string;
  };
  recipe?: {
    package_members?: unknown;
  };
  visibility?: {
    source?: string;
    execution?: string;
  };
  preview_art?: CatalogPreviewArt | null;
  publisher_trust_root_refs?: CatalogRefList;
  publisher_trust_roots?: CatalogTrustRoot[];
  visual_detail_refs?: string[];
  version_lineage?: {
    version?: string | null;
    supersedes?: string | null;
    channel?: string | null;
    compat?: Record<string, unknown> | null;
    updated_at?: string | null;
  };
  package_finding?: CatalogPackageFinding;
  exchange?: {
    package_file_download_pointer_object_keys?: CatalogRefList;
    package_file_metadata_pointer_refs?: CatalogRefList;
    package_use_decision_refs?: CatalogRefList;
    access?: {
      admission_fact_refs?: CatalogRefList;
      product_access_proof_refs?: CatalogRefList;
      required_owner_target_refs?: CatalogRefList;
    };
    offer?: {
      display_ref?: string | null;
      signed_deal_contract_refs?: CatalogRefList;
      quote_reservation_target_refs?: CatalogRefList;
      meter_unit_refs?: CatalogRefList;
      policy_refs?: CatalogRefList;
      purchase_options?: CatalogPurchaseOption[];
    };
    update_policy_refs?: CatalogRefList;
    provenance_refs?: CatalogRefList;
  };
};

type BitfieldPackageCatalog = {
  schema?: string;
  catalog_rows?: unknown;
  discovery?: unknown;
  records?: unknown;
};

type CatalogRowKindConfig = {
  id: string;
  label: string;
  detail?: string;
};

export type BrowseHeroSceneConfig = {
  id: string;
  title: string;
  description: string;
  package_identities: string[];
};

export type BrowseSearchSuggestionConfig = {
  label: string;
  description: string;
  filter_id: string;
  query: string;
  package_identity?: string;
};

export type BrowseSurfaceActionConfig = {
  href: string;
  id: string;
  label: string;
};

export type BrowseLocalPackageFileRequestDefaults = {
  install_destination_options: BrowseInstallDestinationOption[];
  object_store_method: string;
  object_store_settings_json: string;
  target_package_set?: string;
};

export type BrowseInstallDestinationOption = {
  detail: string;
  label: string;
  package_set: string;
};

export type BrowseSurfaceConfig = {
  row_kinds: CatalogRowKindConfig[];
  storefront_filter_groups: string[];
  local_package_file_request_defaults: BrowseLocalPackageFileRequestDefaults;
  popular_searches: string[];
  surface_actions: BrowseSurfaceActionConfig[];
  search_suggestions: BrowseSearchSuggestionConfig[];
  hero_scenes: BrowseHeroSceneConfig[];
};

export type CatalogRefBucket = {
  id: string;
  label: string;
  refs: string[];
  count: number;
  summary: string;
};

export type CatalogInstallActionView = {
  package_identities: string[];
  target: string;
  subject: Record<string, string>;
  exchange_refs: {
    package_file_download_pointer_object_keys: string[];
    package_file_metadata_pointer_refs: string[];
    package_use_decision_refs: string[];
    admission_fact_refs: string[];
    access_proof_refs: string[];
    required_owner_target_refs: string[];
    signed_deal_contract_refs: string[];
    quote_reservation_refs: string[];
    update_policy_refs: string[];
    provenance_refs: string[];
    publisher_trust_root_refs: string[];
    publisher_trust_roots: CatalogTrustRoot[];
  };
};

export type CatalogAcquisitionActionView = {
  amount_due_today_cents: string;
  cadence: string;
  currency: string;
  line_item_label: string;
  meter_unit_refs: string[];
  package_file_ref?: string;
  policy_refs: string[];
  provider_ref?: string;
  purchase_option_ref?: string;
  purchase_label: string;
  quote_reservation_id?: string;
  quote_reservation_refs: string[];
  quote_signature?: string;
  recurring_amount_cents: string;
  requires_payment: boolean;
  resource_ref: string;
  settlement_amounts?: Record<string, unknown>;
  settlement_policy?: Record<string, unknown>;
  shape_ref?: string;
  signed_deal_contract_refs: string[];
};

export type CatalogFilter = {
  id: string;
  label: string;
  count: number;
  group: string;
  description?: string;
};

export type CatalogStat = {
  label: string;
  value: string;
  detail: string;
};

export type MediaItem = {
  src: string;
  alt: string;
  kind?: string;
};

export type PresentationSection = {
  section_kind: 'media_carousel' | 'stat_strip' | 'description' | 'spec_rows' | 'review_summary' | 'capability_badges' | 'supports' | 'featured_in';
  [key: string]: unknown;
};

export type CatalogCardView = {
  row_kind: string;
  row_id: string;
  package_identity?: string;
  recipe_identity?: string;
  package_set_identity?: string;
  display_name: string;
  summary: string;
  identity: string;
  creator_label: string;
  kind_label: string;
  price_label: string;
  install_label: string;
  install_target: string;
  source_label: string;
  execution_label: string;
  status_label: string;
  requires_account: boolean;
  requires_payment: boolean;
  install_action: CatalogInstallActionView | null;
  acquisition_action: CatalogAcquisitionActionView | null;
  capabilities: string[];
  facets: CatalogFindingFacet[];
  detail_blocks: CatalogFindingDetailBlock[];
  result_explanations: string[];
  shelf_ids: string[];
  ranking_score: number;
  ref_buckets: CatalogRefBucket[];
  ref_count: number;
  preview_art: CatalogPreviewArt | null;
  media_items: MediaItem[];
  presentation_sections: PresentationSection[];
  visual_key: string;
  filter_ids: string[];
  search_text: string;
};

export type CatalogDiscoveryCategoryView = {
  id: string;
  label: string;
  description: string;
  filter_id: string;
  count: number;
};

export type CatalogDiscoveryShelfView = {
  id: string;
  label: string;
  description: string;
  filter_id: string;
  count: number;
  card_ids: string[];
};

export type CatalogReplacementCatalogView = {
  schema: string;
  comparison_policy: {
    non_affiliation_label: string;
    replacement_claim_policy: string;
  };
  competitors: Array<{
    id: string;
    name: string;
    category: string;
    official_url: string;
    official_product_url: string;
    logo_url?: string;
    logo_source_url?: string;
    asset_kind?: string;
    comparison_disclaimer: string;
    source_evidence: string;
  }>;
  request_to_build: {
    id: string;
    label: string;
    description: string;
    target: string;
    fields: Array<{ id: string; label: string; required: boolean }>;
  };
  compositions: CatalogCapabilityCompositionView[];
};

export type CatalogCapabilityCompositionView = {
  id: string;
  label: string;
  founder_problem: string;
  supported_job: string;
  claim: string;
  proof_cards: Array<{
    package_identity: string;
    role: string;
    card: CatalogCardView;
  }>;
  missing_package_identities: string[];
  comparison: {
    competitor_ids: string[];
    comparable_categories: string[];
    included_work: string[];
    excluded_work: string[];
  };
  competitors: CatalogReplacementCatalogView['competitors'];
  integration_requirements: Array<{ kind: string; requirement: string }>;
  economics: {
    cost: { status: string; basis: string; source: string };
    time: { status: string; basis: string };
    compounding_value: { status: string; rationale: string; source: string };
  };
  gaps: string[];
  search_terms: string[];
  migration_path: string[];
  cta: {
    label: string;
    query: string;
  };
  request_to_build: { enabled: boolean };
};

export type CatalogNoResultRecoveryView = {
  id: string;
  label: string;
  description: string;
  filter_id: string;
  query: string;
};

export type CatalogDiscoveryView = {
  category_rails: CatalogDiscoveryCategoryView[];
  shelves: CatalogDiscoveryShelfView[];
  replacement_catalog: CatalogReplacementCatalogView;
  recovery_suggestions: CatalogNoResultRecoveryView[];
};

export type CatalogViewModel = {
  heading: string;
  deck: string;
  entries: BitfieldPackageCatalogRow[];
  cards: CatalogCardView[];
  discovery: CatalogDiscoveryView;
  filters: CatalogFilter[];
  stats: CatalogStat[];
  total_ref_count: number;
};

export function readCatalogView(catalog: unknown, browseConfig?: unknown): CatalogViewModel {
  const config = readBrowseSurfaceConfig(browseConfig);
  const entries = readCatalogRows(catalog);
  const packageMediaData = readPackageMediaData(catalog);
  const cards = entries.map((row) => readCatalogCard(row, config, packageMediaData));
  const totalRefCount = cards.reduce((total, card) => total + card.ref_count, 0);
  const discovery = readCatalogDiscovery(catalog, cards);

  return {
    heading: 'Packages and bundles for products that keep growing.',
    deck: 'Browse package files, prices, access checks, update choices, and why each package is listed without the Store deciding payment or package approval.',
    entries,
    cards,
    discovery,
    filters: readCatalogFilters(cards, config, discovery),
    stats: readCatalogStats(cards, totalRefCount, config),
    total_ref_count: totalRefCount,
  };
}

export function readBrowseSurfaceConfig(value: unknown): BrowseSurfaceConfig {
  if (!value || typeof value !== 'object') {
    return emptyBrowseSurfaceConfig();
  }

  const raw = value as Partial<{
    row_kinds: unknown;
    storefront_filter_groups: unknown;
    local_package_file_request_defaults: unknown;
    popular_searches: unknown;
    surface_actions: unknown;
    search_suggestions: unknown;
    hero_scenes: unknown;
  }>;

  return {
    row_kinds: readRowKindConfigs(raw.row_kinds),
    storefront_filter_groups: cleanStrings(raw.storefront_filter_groups),
    local_package_file_request_defaults: readLocalPackageFileRequestDefaults(
      raw.local_package_file_request_defaults,
    ),
    popular_searches: cleanStrings(raw.popular_searches),
    surface_actions: readSurfaceActionConfigs(raw.surface_actions),
    search_suggestions: readSearchSuggestionConfigs(raw.search_suggestions),
    hero_scenes: readHeroSceneConfigs(raw.hero_scenes),
  };
}

export function filterCatalogCards(
  cards: CatalogCardView[],
  query: string,
  activeFilter: string,
): CatalogCardView[] {
  const normalizedQuery = query.trim().toLowerCase();
  return cards
    .filter((card) => {
      const matchesFilter = activeFilter === 'all' || card.filter_ids.includes(activeFilter);
      const matchesQuery = normalizedQuery.length === 0 || card.search_text.includes(normalizedQuery);
      return matchesFilter && matchesQuery;
    })
    .sort((left, right) => (
      right.ranking_score - left.ranking_score ||
      left.display_name.localeCompare(right.display_name)
    ));
}

export type CatalogReplacementSearchResult = {
  composition: CatalogCapabilityCompositionView;
  score: number;
  matched_terms: string[];
  matched_fields: string[];
};

export function searchReplacementCatalog(
  replacementCatalog: CatalogReplacementCatalogView,
  query: string,
): CatalogReplacementSearchResult[] {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return [];
  const queryTerms = tokenizeSearchText(normalizedQuery);
  if (queryTerms.length === 0) return [];

  return replacementCatalog.compositions
    .map((composition) => {
      const fields: Array<{ name: string; weight: number; value: string }> = [
        { name: 'supported job', weight: 10, value: composition.supported_job },
        { name: 'use case', weight: 9, value: composition.founder_problem },
        { name: 'search terms', weight: 9, value: composition.search_terms.join(' ') },
        { name: 'composition', weight: 8, value: composition.label },
        { name: 'comparison category', weight: 7, value: composition.comparison.comparable_categories.join(' ') },
        { name: 'package proof', weight: 5, value: composition.proof_cards.map(({ package_identity, role }) => package_identity + ' ' + role).join(' ') },
        { name: 'comparison product', weight: 5, value: composition.competitors.map(({ name, category }) => name + ' ' + category).join(' ') },
        { name: 'migration path', weight: 3, value: composition.migration_path.join(' ') },
      ];
      const matchedTerms = new Set<string>();
      const matchedFields = new Set<string>();
      let score = fields.some((field) => normalizeSearchText(field.value).includes(normalizedQuery)) ? 12 : 0;
      for (const term of queryTerms) {
        for (const field of fields) {
          const fieldTerms = tokenizeSearchText(field.value);
          if (fieldTerms.includes(term)) {
            score += field.weight;
            matchedTerms.add(term);
            matchedFields.add(field.name);
          }
        }
      }
      return {
        composition,
        score,
        matched_terms: Array.from(matchedTerms),
        matched_fields: Array.from(matchedFields),
      };
    })
    .filter((result) => result.score > 0 && result.matched_terms.length > 0)
    .sort((left, right) => right.score - left.score || left.composition.label.localeCompare(right.composition.label));
}

function readCatalogRows(value: unknown): BitfieldPackageCatalogRow[] {
  if (!value || typeof value !== 'object') return [];

  const catalog = value as BitfieldPackageCatalog;
  if (catalog.schema === 'generic.record_action_projection.v1') {
    return readCatalogRowsFromGenericProjection(catalog.records);
  }
  if (!Array.isArray(catalog.catalog_rows)) return [];

  return catalog.catalog_rows.filter(isCatalogRow);
}

function readCatalogRowsFromGenericProjection(value: unknown): BitfieldPackageCatalogRow[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => (
      entry && typeof entry === 'object' && !Array.isArray(entry)
        ? (entry as Record<string, unknown>).source
        : undefined
    ))
    .filter(isCatalogRow);
}

function readCatalogCard(row: BitfieldPackageCatalogRow, config: BrowseSurfaceConfig, packageMediaData?: unknown): CatalogCardView {
  const finding = readPackageFinding(row, config);
  const capabilities = finding.capabilities;
  const refBuckets = [
    refBucket('Access', [
      ...cleanStrings(row.exchange?.access?.admission_fact_refs),
      ...cleanStrings(row.exchange?.access?.product_access_proof_refs),
      ...cleanStrings(row.exchange?.access?.required_owner_target_refs),
    ]),
    refBucket('Cost', [
      ...cleanStrings(row.exchange?.offer?.display_ref ? [row.exchange.offer.display_ref] : []),
      ...cleanStrings(row.exchange?.offer?.signed_deal_contract_refs),
      ...cleanStrings(row.exchange?.offer?.quote_reservation_target_refs),
      ...cleanStrings(row.exchange?.offer?.meter_unit_refs),
      ...cleanStrings(row.exchange?.offer?.policy_refs),
    ]),
    refBucket('Updates', cleanStrings(row.exchange?.update_policy_refs)),
    refBucket('Package files', [
      ...cleanStrings(row.exchange?.package_file_metadata_pointer_refs),
      ...cleanStrings(row.exchange?.package_use_decision_refs),
      ...cleanStrings(row.exchange?.provenance_refs),
    ]),
  ];
  const identity = row.package_identity ?? row.recipe_identity ?? row.package_set_identity ?? row.row_id;
  const refCount = refBuckets.reduce((total, bucket) => total + bucket.count, 0);
  const previewArt = isPreviewArt(row.preview_art) ? row.preview_art : null;
  const filterIds = [
    ...finding.facets.map((facet) => facet.id),
    ...finding.shelf_ids.map((shelfId) => `shelf:${shelfId}`),
  ];
  const acquisitionAction = readAcquisitionAction(row, identity);
  const requiresPayment = acquisitionAction?.requires_payment === true;
  const requiresAccount = cleanStrings(row.exchange?.access?.required_owner_target_refs).length > 0;

  // Build media_items: read from package-media.json DATA if available, fallback to single preview_art.
  // Honest empty: no fabricated items. DATA sources: package identity (identity string).
  const media_items = readMediaItems(identity, previewArt, finding.title, packageMediaData);

  // Extract version-lineage facets (D1 task) for stat_strip and spec_rows. Sparse state: omitted when absent.
  const versionLineage = row.version_lineage ?? {};
  const version = typeof versionLineage.version === 'string' ? versionLineage.version : null;
  const updated_at = typeof versionLineage.updated_at === 'string' ? versionLineage.updated_at : null;
  const channel = typeof versionLineage.channel === 'string' ? versionLineage.channel : null;
  const compat = versionLineage.compat && typeof versionLineage.compat === 'object' ? versionLineage.compat : null;

  // Build stat_strip cells for VERSION and UPDATED (sparse: only include when data present)
  const stat_strip_cells: Array<{ label: string; value: string }> = [];
  if (version) {
    stat_strip_cells.push({ label: 'VERSION', value: version });
  }
  if (updated_at) {
    // Format date for display (ISO 8601 → user-facing format)
    const dateObj = new Date(updated_at);
    const formattedDate = dateObj.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
    stat_strip_cells.push({ label: 'UPDATED', value: formattedDate });
  }

  // Build version spec_rows (sparse: only include when data present)
  const version_spec_rows: Array<{ label: string; value: string | Record<string, unknown> }> = [];
  if (version) {
    version_spec_rows.push({ label: 'Version', value: version });
  }
  if (updated_at) {
    const dateObj = new Date(updated_at);
    const formattedDate = dateObj.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    version_spec_rows.push({ label: 'Updated', value: formattedDate });
  }
  if (channel) {
    version_spec_rows.push({ label: 'Channel', value: channel });
  }
  if (compat) {
    version_spec_rows.push({ label: 'Compatibility', value: compat });
  }

  // Build presentation sections from current card data. Sections source: catalog DATA (authored in D1).
  // Order: stat_strip → media_carousel → description → spec_rows → review_summary → capability_badges
  const presentation_sections: PresentationSection[] = [
    { section_kind: 'stat_strip' as const, cells: stat_strip_cells },
    ...(media_items.length > 0 ? [{ section_kind: 'media_carousel' as const, items: media_items }] : []),
    { section_kind: 'description' as const, body: finding.summary },
    ...(finding.detail_blocks.length > 0 ? finding.detail_blocks.map((block) => ({
      section_kind: 'spec_rows' as const,
      title: block.title,
      rows: (block.items ?? []).map((item) => ({ label: '', value: item })),
    })) : []),
    // Add version spec_rows section if any version data is present (sparse state)
    ...(version_spec_rows.length > 0 ? [{
      section_kind: 'spec_rows' as const,
      title: 'Version & Compatibility',
      rows: version_spec_rows.map((item) => ({ label: item.label, value: String(item.value) })),
    }] : []),
    { section_kind: 'review_summary' as const, average: null, count: 0, distribution: [], reviews: [] },
    ...(capabilities.length > 0 ? [{ section_kind: 'capability_badges' as const, badges: capabilities }] : []),
  ];

  return {
    row_kind: row.row_kind,
    row_id: row.row_id,
    package_identity: row.package_identity,
    recipe_identity: row.recipe_identity,
    package_set_identity: row.package_set_identity,
    display_name: finding.title,
    summary: finding.summary,
    identity,
    creator_label: finding.creator_label,
    kind_label: finding.kind_label,
    price_label: finding.price_label,
    install_label: finding.cta_label || readInstallLabel(row.install?.install_subject),
    install_target: row.install?.target ?? 'target-not-declared',
    source_label: finding.source_label,
    execution_label: finding.execution_label,
    status_label: finding.access_label,
    requires_account: requiresAccount,
    requires_payment: requiresPayment,
    install_action: readInstallAction(row),
    acquisition_action: acquisitionAction,
    capabilities,
    facets: finding.facets,
    detail_blocks: finding.detail_blocks,
    result_explanations: finding.result_explanations,
    shelf_ids: finding.shelf_ids,
    ranking_score: finding.ranking_score,
    ref_buckets: refBuckets,
    ref_count: refCount,
    preview_art: previewArt,
    media_items,
    presentation_sections,
    visual_key: previewArt?.material_ref ?? row.visual_detail_refs?.[0] ?? row.row_id,
    filter_ids: unique(filterIds),
    search_text: finding.search_text,
  };
}

function readPackageFinding(row: BitfieldPackageCatalogRow, config: BrowseSurfaceConfig) {
  const finding = isPackageFinding(row.package_finding) ? row.package_finding : null;
  const identity = row.package_identity ?? row.recipe_identity ?? row.package_set_identity ?? row.row_id;
  const source = row.visibility?.source ?? 'source-unknown';
  const execution = row.visibility?.execution ?? 'execution-unknown';
  const rawCapabilities = cleanStrings(row.capability_metadata?.public_capability_summary);
  const capabilities = (cleanStrings(finding?.capabilities).length > 0
    ? cleanStrings(finding?.capabilities)
    : rawCapabilities)
    .map(publicCatalogText);
  const sourceLabel = publicCatalogText(textOr(finding?.source_label, labelize(source)));
  const executionLabel = publicCatalogText(textOr(finding?.execution_label, labelize(execution)));
  const kindLabel = publicCatalogLabel(row.row_kind, textOr(finding?.kind_label, rowKindLabel(row.row_kind, config)));
  const accessLabel = publicCatalogText(textOr(finding?.access_label, cleanStrings(row.exchange?.access?.required_owner_target_refs).length > 0
    ? 'Needs account'
    : 'Free'));
  const facets = publicFindingFacets(cleanFindingFacets(finding?.facets));
  const fallbackFacets = facets.length > 0
    ? facets
    : [
      { id: 'all', label: 'All', group: 'all' },
      { id: row.row_kind, label: kindLabel, group: 'kind' },
      { id: `source:${source}`, label: sourceLabel, group: 'source' },
      { id: `execution:${execution}`, label: executionLabel, group: 'runtime' },
      ...capabilities.map((capability) => ({
        id: `capability:${slug(capability)}`,
        label: capability,
        group: 'capability',
      })),
    ];
  const detailBlocks = cleanDetailBlocks(finding?.detail_blocks);
  const searchAliases = cleanStrings(finding?.search?.aliases);
  const searchText = textOr(finding?.search?.text, [
    row.display_name,
    row.summary,
    identity,
    row.row_kind,
    source,
    execution,
    ...capabilities,
    ...fallbackFacets.map((facet) => facet.label),
  ].join(' ')).toLowerCase();

  return {
    title: publicCatalogText(textOr(finding?.title, row.display_name)),
    creator_label: textOr(finding?.creator_label, 'Bitfield'),
    kind_label: kindLabel,
    summary: publicCatalogText(textOr(finding?.summary, row.summary)),
    access_label: accessLabel,
    source_label: sourceLabel,
    execution_label: executionLabel,
    cta_label: publicCatalogText(textOr(finding?.cta_label, readInstallLabel(row.install?.install_subject))),
    price_label: textOr(finding?.price_label, accessLabel),
    capabilities,
    facets: fallbackFacets,
    detail_blocks: detailBlocks.length > 0
      ? publicDetailBlocks(detailBlocks)
      : [
        { id: 'what-it-does', title: 'What it does', body: publicCatalogText(row.summary) },
        { id: 'before-install', title: 'Before you install', items: [sourceLabel, executionLabel, accessLabel] },
      ],
    result_explanations: cleanStrings(finding?.ranking?.result_explanations).map(publicCatalogText),
    shelf_ids: cleanStrings(finding?.shelf_ids),
    ranking_score: typeof finding?.ranking?.score === 'number' ? finding.ranking.score : 0,
    search_text: unique([...searchAliases, searchText.split(/\s+/).join(' ')]).join(' ').toLowerCase(),
  };
}

function isPackageFinding(value: unknown): value is CatalogPackageFinding {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function cleanFindingFacets(value: unknown): CatalogFindingFacet[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is CatalogFindingFacet => (
    item != null &&
    typeof item === 'object' &&
    !Array.isArray(item) &&
    typeof (item as CatalogFindingFacet).id === 'string' &&
    typeof (item as CatalogFindingFacet).label === 'string' &&
    typeof (item as CatalogFindingFacet).group === 'string'
  ));
}

function publicFindingFacets(facets: CatalogFindingFacet[]): CatalogFindingFacet[] {
  return facets.map((facet) => ({
    ...facet,
    label: publicCatalogLabel(facet.id, facet.label),
    description: publicCatalogText(facet.description),
  }));
}

function cleanDetailBlocks(value: unknown): CatalogFindingDetailBlock[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is CatalogFindingDetailBlock => (
    item != null &&
    typeof item === 'object' &&
    !Array.isArray(item) &&
    typeof (item as CatalogFindingDetailBlock).id === 'string' &&
    typeof (item as CatalogFindingDetailBlock).title === 'string'
  )).map((item) => ({
    id: item.id,
    title: item.title,
    ...(typeof item.body === 'string' ? { body: item.body } : {}),
    ...(Array.isArray(item.items) ? { items: cleanStrings(item.items) } : {}),
  }));
}

function publicDetailBlocks(blocks: CatalogFindingDetailBlock[]): CatalogFindingDetailBlock[] {
  return blocks.map((block) => ({
    ...block,
    title: publicCatalogText(block.title),
    body: block.body == null ? undefined : publicCatalogText(block.body),
    items: block.items?.map(publicCatalogText),
  }));
}

function readAcquisitionAction(
  row: BitfieldPackageCatalogRow,
  identity: string,
): CatalogAcquisitionActionView | null {
  const signedDealContractRefs = cleanStrings(row.exchange?.offer?.signed_deal_contract_refs);
  const quoteReservationRefs = cleanStrings(row.exchange?.offer?.quote_reservation_target_refs);
  const policyRefs = cleanStrings(row.exchange?.offer?.policy_refs);
  const purchaseOption = readPurchaseOption(row.exchange?.offer?.purchase_options);
  const resourceRef = readResourceRef(row, identity);
  if (!resourceRef) return null;

  const optionAmount = moneyString(purchaseOption?.amount_due_today_cents);
  const requiresPayment = optionAmount !== undefined
    ? BigInt(optionAmount) > 0n
    : signedDealContractRefs.length > 0 || quoteReservationRefs.length > 0;
  return {
    amount_due_today_cents: optionAmount ?? (requiresPayment ? '' : '0'),
    cadence: textOr(purchaseOption?.cadence, 'one-time'),
    currency: currencyCode(purchaseOption?.currency_ref),
    line_item_label: textOr(purchaseOption?.line_item_label, row.display_name),
    meter_unit_refs: cleanStrings(row.exchange?.offer?.meter_unit_refs),
    package_file_ref: textOrNull(purchaseOption?.package_file_ref) ?? readPackageFileRef(row),
    policy_refs: policyRefs,
    provider_ref: textOrNull(purchaseOption?.provider_ref) ?? undefined,
    purchase_option_ref: textOrNull(purchaseOption?.purchase_option_ref) ?? undefined,
    purchase_label: requiresPayment ? 'Continue to checkout' : 'Get free package',
    quote_reservation_id: textOrNull(purchaseOption?.quote_reservation_ref) ?? undefined,
    quote_reservation_refs: quoteReservationRefs,
    quote_signature: textOrNull(purchaseOption?.quote_signature_ref) ?? undefined,
    recurring_amount_cents: moneyString(purchaseOption?.recurring_amount_cents) ?? (requiresPayment ? '' : '0'),
    requires_payment: requiresPayment,
    resource_ref: textOrNull(purchaseOption?.resource_ref) ?? resourceRef,
    settlement_amounts: purchaseOption?.settlement_amounts,
    settlement_policy: purchaseOption?.settlement_policy,
    shape_ref: textOrNull(purchaseOption?.shape_ref) ?? undefined,
    signed_deal_contract_refs: signedDealContractRefs,
  };
}

function readPurchaseOption(value: unknown) {
  if (!Array.isArray(value)) return null;
  return value.find((item): item is CatalogPurchaseOption => (
    item != null &&
    typeof item === 'object' &&
    !Array.isArray(item) &&
    typeof (item as CatalogPurchaseOption).purchase_option_ref === 'string'
  )) ?? null;
}

function textOrNull(value: unknown) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function textOr(value: unknown, fallback: string) {
  return textOrNull(value) ?? fallback;
}

function moneyString(value: unknown) {
  const text = textOrNull(value);
  return text && /^\d+$/.test(text) ? text : undefined;
}

function currencyCode(value: unknown) {
  const text = textOrNull(value);
  if (!text) return 'usd';
  return text.startsWith('currency:') ? text.slice('currency:'.length).toLowerCase() : text.toLowerCase();
}

function readInstallAction(row: BitfieldPackageCatalogRow): CatalogInstallActionView | null {
  const target = row.install?.target;
  const subject = readInstallSubject(row.install?.install_subject);
  if (!target || !subject) return null;

  return {
    package_identities: readInstallPackageIdentities(row, subject),
    target,
    subject,
    exchange_refs: {
      package_file_metadata_pointer_refs: cleanStrings(row.exchange?.package_file_metadata_pointer_refs),
      package_file_download_pointer_object_keys: cleanStrings(row.exchange?.package_file_download_pointer_object_keys),
      package_use_decision_refs: cleanStrings(row.exchange?.package_use_decision_refs),
      admission_fact_refs: cleanStrings(row.exchange?.access?.admission_fact_refs),
      access_proof_refs: cleanStrings(row.exchange?.access?.product_access_proof_refs),
      required_owner_target_refs: cleanStrings(row.exchange?.access?.required_owner_target_refs),
      signed_deal_contract_refs: cleanStrings(row.exchange?.offer?.signed_deal_contract_refs),
      quote_reservation_refs: cleanStrings(row.exchange?.offer?.quote_reservation_target_refs),
      update_policy_refs: cleanStrings(row.exchange?.update_policy_refs),
      provenance_refs: cleanStrings(row.exchange?.provenance_refs),
      publisher_trust_root_refs: cleanStrings(row.publisher_trust_root_refs),
      publisher_trust_roots: cleanRecords(row.publisher_trust_roots),
    },
  };
}

function readInstallPackageIdentities(
  row: BitfieldPackageCatalogRow,
  subject: Record<string, string>,
): string[] {
  return unique([
    ...cleanStrings([row.package_identity, subject.package_identity]),
    ...readRecipePackageIdentities(row.recipe?.package_members),
  ]);
}

function readRecipePackageIdentities(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return cleanStrings(value.map((item) => (
    item && typeof item === 'object' && !Array.isArray(item)
      ? (item as Record<string, unknown>).package_identity
      : undefined
  )));
}

function readInstallSubject(value: unknown): Record<string, string> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const subject: Record<string, string> = {};
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === 'string' && child.length > 0) {
      subject[key] = child;
    }
  }
  return typeof subject.subject_ref === 'string' ? subject : null;
}

function readResourceRef(row: BitfieldPackageCatalogRow, identity: string) {
  return cleanStrings(row.exchange?.provenance_refs).find((ref) => ref.startsWith('resource:'))
    ?? `resource:${identity}`;
}

function readPackageFileRef(row: BitfieldPackageCatalogRow) {
  const subject = readInstallSubject(row.install?.install_subject);
  if (subject?.subject_ref) return subject.subject_ref;
  return cleanStrings(row.exchange?.provenance_refs).find((ref) => (
    ref.startsWith('package-file:') ||
    ref.startsWith('contract:') ||
    ref.startsWith('material:')
  ));
}

function readInstallLabel(value: unknown): string {
  const subject = readInstallSubject(value);
  return subject?.action_label ?? 'Install';
}

function isPreviewArt(value: unknown): value is CatalogPreviewArt {
  if (!value || typeof value !== 'object') return false;
  const previewArt = value as CatalogPreviewArt;
  return (
    typeof previewArt.material_ref === 'string' &&
    typeof previewArt.media_type === 'string' &&
    typeof previewArt.source_path === 'string' &&
    typeof previewArt.data_url === 'string'
  );
}

function readCatalogDiscovery(catalog: unknown, cards: CatalogCardView[]): CatalogDiscoveryView {
  const payload = readCatalogDiscoveryPayload(catalog);
  const categoryItems = readDiscoveryItems(payload?.categories);
  const shelfItems = readDiscoveryItems(payload?.shelves);
  const fallbackCategories = readCategoryItemsFromCards(cards);
  const fallbackShelves = readShelfItemsFromCards(cards);
  const categories = (categoryItems.length > 0 ? categoryItems : fallbackCategories)
    .map((item) => readCategoryRail(item, cards))
    .filter((category) => category.count > 0);
  const shelves = (shelfItems.length > 0 ? shelfItems : fallbackShelves)
    .map((item) => readShelfSection(item, cards))
    .filter((shelf) => shelf.count > 0);

  return {
    category_rails: categories,
    shelves,
    replacement_catalog: readReplacementCatalog(payload?.replacement_catalog, cards),
    recovery_suggestions: readRecoverySuggestions(payload?.no_result_recovery, categories, shelves),
  };
}

function readCatalogDiscoveryPayload(catalog: unknown): CatalogDiscoveryPayload | null {
  if (!isRecord(catalog) || !isRecord(catalog.discovery)) return null;
  return catalog.discovery as CatalogDiscoveryPayload;
}

function readReplacementCatalog(
  value: unknown,
  cards: CatalogCardView[],
): CatalogReplacementCatalogView {
  if (!isRecord(value)) return emptyReplacementCatalog();

  const cardsByIdentity = new Map<string, CatalogCardView>();
  for (const card of cards) {
    for (const identity of [card.package_identity, card.recipe_identity, card.package_set_identity, card.identity]) {
      if (identity) cardsByIdentity.set(identity, card);
    }
  }

  const compositions = Array.isArray(value.compositions) ? value.compositions
    .filter((item): item is Record<string, unknown> => isRecord(item))
    .map((item) => {
      const proofCards: CatalogCapabilityCompositionView['proof_cards'] = [];
      const missingPackageIdentities: string[] = [];
      for (const proof of Array.isArray(item.package_entries) ? item.package_entries : []) {
        if (!isRecord(proof)) continue;
        const packageIdentity = textOr(proof.package_id, '');
        const role = textOr(proof.role, '');
        if (!packageIdentity || !role) continue;
        const card = cardsByIdentity.get(packageIdentity);
        if (card) {
          proofCards.push({ package_identity: packageIdentity, role, card });
        } else {
          missingPackageIdentities.push(packageIdentity);
        }
      }

      return {
        id: textOr(item.id, ''),
        label: textOr(item.label, ''),
        founder_problem: textOr(item.founder_problem, ''),
        supported_job: textOr(item.supported_job, ''),
        claim: textOr(item.claim, ''),
        proof_cards: proofCards,
        missing_package_identities: unique(missingPackageIdentities),
        comparison: readComparison(item.comparison),
        competitors: readCompetitors(item.comparison, value.competitors),
        integration_requirements: readRequirements(item.integration_requirements),
        economics: readEconomics(item.economics),
        gaps: cleanStrings(item.gaps),
        search_terms: cleanStrings(item.search_terms),
        migration_path: cleanStrings(item.migration_path),
        cta: {
          label: textOr(isRecord(item.cta) ? item.cta.label : '', 'Explore packages'),
          query: textOr(isRecord(item.cta) ? item.cta.query : '', ''),
        },
        request_to_build: {
          enabled: isRecord(item.request_to_build) ? item.request_to_build.enabled !== false : true,
        },
      };
    })
    .filter((composition) => (
      composition.id.length > 0 &&
      composition.label.length > 0 &&
      composition.founder_problem.length > 0 &&
      composition.supported_job.length > 0 &&
      composition.proof_cards.length > 0
    )) : [];

  return {
    schema: textOr(value.schema, 'bitfield.package_store.replacement_catalog.v1'),
    comparison_policy: {
      non_affiliation_label: textOr(isRecord(value.comparison_policy) ? value.comparison_policy.non_affiliation_label : '', 'Shown for comparison only; no affiliation or endorsement is implied.'),
      replacement_claim_policy: textOr(isRecord(value.comparison_policy) ? value.comparison_policy.replacement_claim_policy : '', 'Claims are limited to the named supported job.'),
    },
    competitors: readCompetitors(undefined, value.competitors),
    request_to_build: readRequestToBuild(value.request_to_build),
    compositions,
  };
}

function emptyReplacementCatalog(): CatalogReplacementCatalogView {
  return {
    schema: 'bitfield.package_store.replacement_catalog.v1',
    comparison_policy: {
      non_affiliation_label: 'Shown for comparison only; no affiliation or endorsement is implied.',
      replacement_claim_policy: 'Claims are limited to the named supported job.',
    },
    competitors: [],
    request_to_build: {
      id: 'request-to-build:replacement-composition',
      label: 'Request a composition',
      description: 'Tell us what is missing.',
      target: 'data://package-store/replacement-catalog/request-to-build',
      fields: [],
    },
    compositions: [],
  };
}

function readComparison(value: unknown): CatalogCapabilityCompositionView['comparison'] {
  const item = isRecord(value) ? value : {};
  return {
    competitor_ids: cleanStrings(item.competitor_ids),
    comparable_categories: cleanStrings(item.comparable_categories),
    included_work: cleanStrings(item.included_work),
    excluded_work: cleanStrings(item.excluded_work),
  };
}

function readCompetitors(comparison: unknown, value: unknown): CatalogReplacementCatalogView['competitors'] {
  const ids = isRecord(comparison) ? new Set(cleanStrings(comparison.competitor_ids)) : null;
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map((item) => ({
    id: textOr(item.id, ''),
    name: textOr(item.name, ''),
    category: textOr(item.category, ''),
    official_url: textOr(item.official_url, ''),
    official_product_url: textOr(item.official_product_url, ''),
    ...(textOr(item.logo_url, '') ? { logo_url: textOr(item.logo_url, '') } : {}),
    ...(textOr(item.logo_source_url, '') ? { logo_source_url: textOr(item.logo_source_url, '') } : {}),
    ...(textOr(item.asset_kind, '') ? { asset_kind: textOr(item.asset_kind, '') } : {}),
    comparison_disclaimer: textOr(item.comparison_disclaimer, ''),
    source_evidence: textOr(item.source_evidence, ''),
  })).filter((item) => item.id && item.name && (!ids || ids.has(item.id)));
}

function readRequirements(value: unknown): Array<{ kind: string; requirement: string }> {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map((item) => ({
    kind: textOr(item.kind, 'integration'),
    requirement: textOr(item.requirement, ''),
  })).filter((item) => item.requirement);
}

function readEconomics(value: unknown): CatalogCapabilityCompositionView['economics'] {
  const item = isRecord(value) ? value : {};
  const cost = isRecord(item.cost) ? item.cost : {};
  const time = isRecord(item.time) ? item.time : {};
  const compounding = isRecord(item.compounding_value) ? item.compounding_value : {};
  return {
    cost: {
      status: textOr(cost.status, 'not-estimated'),
      basis: textOr(cost.basis, 'No supportable estimate is available.'),
      source: textOr(cost.source, ''),
    },
    time: {
      status: textOr(time.status, 'not-estimated'),
      basis: textOr(time.basis, 'No supportable estimate is available.'),
    },
    compounding_value: {
      status: textOr(compounding.status, 'not-estimated'),
      rationale: textOr(compounding.rationale, ''),
      source: textOr(compounding.source, ''),
    },
  };
}

function readRequestToBuild(value: unknown): CatalogReplacementCatalogView['request_to_build'] {
  const item = isRecord(value) ? value : {};
  return {
    id: textOr(item.id, 'request-to-build:replacement-composition'),
    label: textOr(item.label, 'Request a composition'),
    description: textOr(item.description, 'Tell us what is missing.'),
    target: textOr(item.target, 'data://package-store/replacement-catalog/request-to-build'),
    fields: Array.isArray(item.fields) ? item.fields.filter(isRecord).map((field) => ({
      id: textOr(field.id, ''),
      label: textOr(field.label, ''),
      required: field.required === true,
    })).filter((field) => field.id && field.label) : [],
  };
}

function readDiscoveryItems(value: unknown): CatalogDiscoveryConfig[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => isRecord(item))
    .map((item) => ({
      id: textOr(item.id, ''),
      label: textOr(item.label, ''),
      description: textOr(item.description, ''),
      filter_id: textOrNull(item.filter_id) ?? undefined,
      query: textOrNull(item.query) ?? undefined,
      priority: typeof item.priority === 'number' ? item.priority : undefined,
    }))
    .filter((item) => item.id.length > 0 && item.label.length > 0)
    .sort((left, right) => (left.priority ?? 0) - (right.priority ?? 0) || left.label.localeCompare(right.label));
}

function readCategoryItemsFromCards(cards: CatalogCardView[]): CatalogDiscoveryConfig[] {
  const itemsById = new Map<string, CatalogDiscoveryConfig>();
  for (const facet of cards.flatMap((card) => card.facets)) {
    if (facet.group !== 'category') continue;
    const id = facet.id.startsWith('category:') ? facet.id.slice('category:'.length) : facet.id;
    if (!itemsById.has(id)) {
      itemsById.set(id, {
        id,
        label: publicCatalogLabel(id, facet.label),
        description: publicCatalogText(facet.description ?? ''),
        filter_id: facet.id,
      });
    }
  }
  return Array.from(itemsById.values());
}

function readShelfItemsFromCards(cards: CatalogCardView[]): CatalogDiscoveryConfig[] {
  const shelfIds = unique(cards.flatMap((card) => card.shelf_ids));
  return shelfIds.map((id, index) => ({
    id,
    label: labelize(id),
    description: '',
    filter_id: `shelf:${id}`,
    priority: index * 10,
  }));
}

function readCategoryRail(item: CatalogDiscoveryConfig, cards: CatalogCardView[]): CatalogDiscoveryCategoryView {
  const filterId = item.filter_id ?? `category:${item.id}`;
  return {
    id: item.id,
    label: publicCatalogLabel(item.id, item.label),
    description: publicCatalogText(item.description ?? ''),
    filter_id: filterId,
    count: cards.filter((card) => card.filter_ids.includes(filterId)).length,
  };
}

function readShelfSection(item: CatalogDiscoveryConfig, cards: CatalogCardView[]): CatalogDiscoveryShelfView {
  const filterId = item.filter_id ?? `shelf:${item.id}`;
  const shelfCards = cards
    .filter((card) => card.filter_ids.includes(filterId))
    .sort((left, right) => (
      right.ranking_score - left.ranking_score ||
      left.display_name.localeCompare(right.display_name)
    ));

  return {
    id: item.id,
    label: item.label,
    description: item.description ?? '',
    filter_id: filterId,
    count: shelfCards.length,
    card_ids: shelfCards.map((card) => card.row_id),
  };
}

function readRecoverySuggestions(
  value: unknown,
  categories: CatalogDiscoveryCategoryView[],
  shelves: CatalogDiscoveryShelfView[],
): CatalogNoResultRecoveryView[] {
  const configured = Array.isArray(value)
    ? value
      .filter((item): item is Record<string, unknown> => isRecord(item))
      .map((item) => ({
        id: textOr(item.id, ''),
        label: textOr(item.label, ''),
        description: textOr(item.description, ''),
        filter_id: textOr(item.filter_id, ''),
        query: textOr(item.query, ''),
      }))
      .filter((item) => item.id && item.label && item.filter_id)
    : [];
  if (configured.length > 0) return configured;

  return [
    {
      id: 'browse-all',
      label: 'Browse all packages',
      description: 'Clear search and scan every package.',
      filter_id: 'all',
      query: '',
    },
    ...categories.slice(0, 1).map((category) => ({
      id: `category:${category.id}`,
      label: category.label,
      description: category.description,
      filter_id: category.filter_id,
      query: '',
    })),
    ...shelves.slice(0, 1).map((shelf) => ({
      id: `shelf:${shelf.id}`,
      label: shelf.label,
      description: shelf.description,
      filter_id: shelf.filter_id,
      query: '',
    })),
  ];
}

function readCatalogFilters(
  cards: CatalogCardView[],
  config: BrowseSurfaceConfig,
  discovery: CatalogDiscoveryView,
): CatalogFilter[] {
  const filtersById = new Map<string, CatalogFilter>();
  filtersById.set('all', { id: 'all', label: 'All', count: cards.length, group: 'all' });
  for (const rowKind of config.row_kinds) {
    if (!cards.some((card) => card.row_kind === rowKind.id)) continue;
    filtersById.set(rowKind.id, {
      id: rowKind.id,
      label: rowKind.label,
      count: cards.filter((card) => card.row_kind === rowKind.id).length,
      group: 'kind',
      description: rowKind.detail,
    });
  }

  for (const facet of cards.flatMap((card) => card.facets)) {
    if (filtersById.has(facet.id)) continue;
    filtersById.set(facet.id, {
      id: facet.id,
      label: publicCatalogLabel(facet.id, facet.label),
      count: cards.filter((card) => card.filter_ids.includes(facet.id)).length,
      group: facet.group,
      description: publicCatalogText(facet.description),
    });
  }

  for (const shelf of discovery.shelves) {
    if (filtersById.has(shelf.filter_id)) continue;
    filtersById.set(shelf.filter_id, {
      id: shelf.filter_id,
      label: shelf.label,
      count: shelf.count,
      group: 'shelf',
      description: shelf.description,
    });
  }

  return Array.from(filtersById.values());
}

function readCatalogStats(
  cards: CatalogCardView[],
  totalRefCount: number,
  config: BrowseSurfaceConfig,
): CatalogStat[] {
  const accountStepCount = cards.filter((card) => card.requires_account || card.requires_payment).length;
  const rowKinds = readVisibleRowKinds(cards, config);

  return [
    ...rowKinds.map((rowKind) => ({
      label: rowKind.label,
      value: String(cards.filter((card) => card.row_kind === rowKind.id).length),
      detail: rowKind.detail ?? `${labelize(rowKind.id).toLowerCase()} rows`,
    })),
    {
      label: 'Records',
      value: String(totalRefCount),
      detail: 'package records',
    },
    {
      label: 'Account steps',
      value: String(accountStepCount),
      detail: 'account checks',
    },
  ];
}

function refBucket(label: string, refs: string[]): CatalogRefBucket {
  const cleanRefs = unique(cleanStrings(refs));
  return {
    id: slug(label),
    label,
    refs: cleanRefs,
    count: cleanRefs.length,
    summary: cleanRefs.length > 0 ? summarizeRefs(cleanRefs) : 'None needed',
  };
}

function summarizeRefs(refs: string[]) {
  return refs.slice(0, 2).map(publicRefLabel).join(' + ');
}

function publicRefLabel(ref: string) {
  const parts = ref.split(/[:/]/).filter(Boolean);
  const [kind = '', first = '', second = ''] = parts;

  if (kind === 'package-use' && first === 'public') return 'free to use';
  if (kind === 'policy') return publicPolicyLabel(parts.slice(1).join('-'));
  if (kind === 'update-policy') return publicUpdateLabel(parts.slice(1).join('-'));
  if (kind === 'signed-deal') return 'deal record';
  if (kind === 'offer-display') return 'price shown';
  if (kind === 'product-access-proof') return 'account access';
  if (kind === 'owner-target') return publicOwnerTargetLabel(parts.slice(1).join('-'));
  if (kind === 'package-set') return `${labelize(first)} package set`;
  if (kind === 'resource') return labelize(first || second);
  if (kind === 'source-material') return 'source files';
  if (kind === 'contract') return 'package file';
  if (kind === 'material') return 'package files';
  if (kind === 'emitted-record-count') return `${first} records`;
  if (kind === 'package-preview-art') return 'preview image';

  return labelize(parts.slice(-2).join(' ')) || ref;
}

function rowKindLabel(rowKind: string, config: BrowseSurfaceConfig) {
  return config.row_kinds.find((candidate) => candidate.id === rowKind)?.label ?? labelize(rowKind);
}

function readVisibleRowKinds(cards: CatalogCardView[], config: BrowseSurfaceConfig) {
  const configured = config.row_kinds.filter((rowKind) => (
    cards.some((card) => card.row_kind === rowKind.id)
  ));
  const configuredIds = new Set(configured.map((rowKind) => rowKind.id));
  const unconfigured = unique(cards.map((card) => card.row_kind))
    .filter((rowKind) => !configuredIds.has(rowKind))
    .map((rowKind) => ({
      id: rowKind,
      label: rowKindLabel(rowKind, config),
      detail: `${labelize(rowKind).toLowerCase()} rows`,
    }));

  return [...configured, ...unconfigured];
}

function publicPolicyLabel(value: string) {
  if (value === 'public-package-use') return 'free to use';
  if (value === 'transaction-fee-marketplace-owner') return 'marketplace fee';
  if (value === 'marketplace-fee-deducted-or-added') return 'marketplace fee setting';
  if (value === 'royalty-publisher') return 'publisher royalty';
  if (value === 'discount-time-window') return 'time-limited discount';
  if (value === 'referral-reward') return 'referral reward';
  if (value.endsWith('specific-override')) return labelize(value.replace(/-specific-override$/, ' setting'));
  return labelize(value);
}

function publicUpdateLabel(value: string) {
  if (value === 'manual-approval') return 'ask before updating';
  if (value === 'trusted-publisher-auto-accept') return 'trusted publisher updates';
  if (value === 'pinned-version-supported') return 'can pin a version';
  if (value === 'rollback-supported') return 'can roll back';
  return labelize(value);
}

function publicOwnerTargetLabel(value: string) {
  if (value.includes('reserve-quote')) return 'price quote';
  if (value.includes('account-portal')) return 'account check';
  return labelize(value);
}

function publicCatalogLabel(id: string, label: string) {
  const normalized = `${id} ${label}`.toLowerCase();
  if (normalized.includes('recipe')) return 'Bundle';
  if (normalized.includes('workflow')) return 'Automation';
  if (normalized.includes('slot')) return 'Capability';
  return label;
}

function publicCatalogText(value = '') {
  if (!value) return '';
  return value
    .replace(/\brecipes\b/gi, 'bundles')
    .replace(/\brecipe\b/gi, 'bundle')
    .replace(/\bworkflows\b/gi, 'automations')
    .replace(/\bworkflow\b/gi, 'automation')
    .replace(/\bslots\b/gi, 'capabilities')
    .replace(/\bslot\b/gi, 'capability');
}

function labelize(value: string) {
  return value
    .replace(/[_:-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function slug(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function cleanStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
}

function cleanRecords(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function emptyBrowseSurfaceConfig(): BrowseSurfaceConfig {
  return {
    row_kinds: [],
    storefront_filter_groups: [],
    local_package_file_request_defaults: readLocalPackageFileRequestDefaults(null),
    popular_searches: [],
    surface_actions: [],
    search_suggestions: [],
    hero_scenes: [],
  };
}

function readLocalPackageFileRequestDefaults(value: unknown): BrowseLocalPackageFileRequestDefaults {
  const candidate = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Partial<BrowseLocalPackageFileRequestDefaults>
    : {};
  return {
    install_destination_options: readInstallDestinationOptions(candidate.install_destination_options),
    object_store_method: textOr(candidate.object_store_method, ''),
    object_store_settings_json: textOr(candidate.object_store_settings_json, ''),
    target_package_set: textOr(candidate.target_package_set, ''),
  };
}

function readInstallDestinationOptions(value: unknown): BrowseInstallDestinationOption[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isRecord)
    .map((candidate) => ({
      detail: textOr(candidate.detail, ''),
      label: textOr(candidate.label, ''),
      package_set: textOr(candidate.package_set, ''),
    }))
    .filter((candidate) => candidate.package_set.length > 0)
    .map((candidate) => ({
      ...candidate,
      label: candidate.label || displayLabelFromPackageSet(candidate.package_set),
    }));
}

function displayLabelFromPackageSet(value: string): string {
  return value
    .split(/[-_\s]+/u)
    .filter(Boolean)
    .map((part) => part.toLowerCase() === 'bitfield'
      ? 'Bitfield'
      : `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(' ');
}

function readRowKindConfigs(value: unknown): CatalogRowKindConfig[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRowKindConfig);
}

function isRowKindConfig(value: unknown): value is CatalogRowKindConfig {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<CatalogRowKindConfig>;
  return (
    typeof candidate.id === 'string' &&
    candidate.id.length > 0 &&
    typeof candidate.label === 'string' &&
    candidate.label.length > 0 &&
    (candidate.detail == null || typeof candidate.detail === 'string')
  );
}

function readSurfaceActionConfigs(value: unknown): BrowseSurfaceActionConfig[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isSurfaceActionConfig);
}

function isSurfaceActionConfig(value: unknown): value is BrowseSurfaceActionConfig {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<BrowseSurfaceActionConfig>;
  return (
    typeof candidate.id === 'string' &&
    candidate.id.length > 0 &&
    typeof candidate.label === 'string' &&
    candidate.label.length > 0 &&
    typeof candidate.href === 'string' &&
    candidate.href.length > 0
  );
}

function readSearchSuggestionConfigs(value: unknown): BrowseSearchSuggestionConfig[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isSearchSuggestionConfig);
}

function isSearchSuggestionConfig(value: unknown): value is BrowseSearchSuggestionConfig {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<BrowseSearchSuggestionConfig>;
  return (
    typeof candidate.label === 'string' &&
    candidate.label.length > 0 &&
    typeof candidate.description === 'string' &&
    candidate.description.length > 0 &&
    typeof candidate.filter_id === 'string' &&
    candidate.filter_id.length > 0 &&
    typeof candidate.query === 'string' &&
    candidate.query.length > 0 &&
    (candidate.package_identity == null || typeof candidate.package_identity === 'string')
  );
}

function readHeroSceneConfigs(value: unknown): BrowseHeroSceneConfig[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isHeroSceneConfig);
}

function isHeroSceneConfig(value: unknown): value is BrowseHeroSceneConfig {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<BrowseHeroSceneConfig>;
  return (
    typeof candidate.id === 'string' &&
    candidate.id.length > 0 &&
    typeof candidate.title === 'string' &&
    candidate.title.length > 0 &&
    typeof candidate.description === 'string' &&
    candidate.description.length > 0 &&
    cleanStrings(candidate.package_identities).length > 0
  );
}

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}

function normalizeSearchText(value: string): string {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenizeSearchText(value: string): string[] {
  const stopWords = new Set(['a', 'an', 'and', 'for', 'from', 'in', 'of', 'on', 'or', 'the', 'to', 'with']);
  return unique(normalizeSearchText(value).split(' ').filter((term) => term.length > 1 && !stopWords.has(term)));
}

/**
 * readPackageMediaData: Extract package-media DATA from catalog.
 * Looks for package_media array in the passed catalog data structure.
 * Returns the array if present, otherwise undefined (fallback to preview_art logic).
 */
function readPackageMediaData(value: unknown): Array<{ identity: string; media_items: MediaItem[] }> | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const catalog = value as Record<string, unknown>;
  // Check if catalog has embedded package-media data (from catalog.json or combined load)
  if (Array.isArray(catalog.package_media)) {
    return catalog.package_media.filter((entry): entry is { identity: string; media_items: MediaItem[] } => {
      return (
        entry &&
        typeof entry === 'object' &&
        typeof (entry as Record<string, unknown>).identity === 'string' &&
        Array.isArray((entry as Record<string, unknown>).media_items)
      );
    });
  }
  return undefined;
}

/**
 * readMediaItems: Build the carousel media list from package-media DATA.
 * Priority: (1) multi-item list from packageMediaData if entry exists, (2) fallback to single preview_art, (3) empty (honest — no fabricated items).
 * Each item: { src, alt, kind? }. Kind is OPEN string ('screenshot' | 'generated' etc), not a closed enum.
 * Identity: package_identity string (e.g., "account-dashboard").
 * Called from readCatalogCard; media_items → presentation_sections.media_carousel.
 * packageMediaData comes from catalog (embedded or loaded from package-media.json during catalog composition).
 */
function readMediaItems(
  identity: string,
  previewArt: CatalogPreviewArt | null,
  title: string,
  packageMediaData?: unknown,
): MediaItem[] {
  // Priority 1: Look up identity in package-media DATA
  if (Array.isArray(packageMediaData)) {
    const mediaEntry = packageMediaData.find(
      (entry): entry is { identity: string; media_items: MediaItem[] } =>
        entry &&
        typeof entry === 'object' &&
        typeof (entry as Record<string, unknown>).identity === 'string' &&
        (entry as Record<string, unknown>).identity === identity,
    );
    if (mediaEntry && Array.isArray(mediaEntry.media_items) && mediaEntry.media_items.length > 0) {
      return mediaEntry.media_items;
    }
  }

  // Priority 2: Fallback to single preview_art item
  if (previewArt && previewArt.data_url) {
    return [{ src: previewArt.data_url, alt: title || 'Package screenshot', kind: 'screenshot' }];
  }

  // Priority 3: Honest empty (no fabricated items)
  return [];
}

function isCatalogRow(value: unknown): value is BitfieldPackageCatalogRow {
  if (!value || typeof value !== 'object') return false;
  const row = value as Partial<BitfieldPackageCatalogRow>;
  if (
    typeof row.row_kind !== 'string' ||
    row.row_kind.length === 0
  ) {
    return false;
  }

  return (
    typeof row.row_id === 'string' &&
    typeof row.display_name === 'string' &&
    typeof row.summary === 'string'
  );
}
