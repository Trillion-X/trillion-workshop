export type CatalogExchangeAccess = {
  admission_fact_refs: string[];
  product_access_proof_refs: string[];
  required_owner_target_refs: string[];
};

export type CatalogExchangeOffer = {
  display_ref: string | null;
  signed_deal_contract_refs: string[];
  quote_reservation_target_refs: string[];
  meter_unit_refs: string[];
  policy_refs: string[];
};

export type CatalogExchange = {
  package_file_download_pointer_object_keys: string[];
  package_file_metadata_pointer_refs: string[];
  package_use_decision_refs: string[];
  access: CatalogExchangeAccess;
  offer: CatalogExchangeOffer;
  update_policy_refs: string[];
  provenance_refs: string[];
};

export type CatalogPreviewArt = {
  kind: string;
  owner_identity: string;
  source_package: string;
  stored_bytes_name: string;
  media_type: string;
  source_path: string;
  byte_length: number;
  material_ref: string;
  data_url: string;
};

export type CatalogInstallSubject = Record<string, string>;

export type CatalogFindingFacet = {
  id: string;
  label: string;
  group: string;
  description?: string;
};

export type CatalogFindingDetailBlock = {
  id: string;
  title: string;
  body?: string;
  items?: string[];
};

export type CatalogFindingBlock = {
  id: string;
  render_kind: string;
  role: string;
  label?: string;
  value?: unknown;
  values?: unknown[];
  tone_key?: string;
  owner_ref?: string;
};

export type CatalogPackageFinding = {
  schema: string;
  row_id: string;
  title: string;
  summary: string;
  blocks: CatalogFindingBlock[];
  categories: Array<{
    id: string;
    label: string;
    description: string;
  }>;
  capabilities: string[];
  facets: CatalogFindingFacet[];
  shelf_ids: string[];
  search: {
    aliases: string[];
    text: string;
  };
  ranking: {
    score: number;
    signals: CatalogFindingFacet[];
    result_explanations: string[];
  };
  detail_blocks: CatalogFindingDetailBlock[];
};

export type BitfieldPackageCatalogRow = {
  row_kind: string;
  row_id: string;
  package_identity?: string;
  recipe_identity?: string;
  package_set_identity?: string;
  display_name: string;
  summary: string;
  capability_metadata: {
    capability_ids: string[];
    public_capability_summary: string[];
  };
  exchange: CatalogExchange;
  visibility: {
    source: string;
    execution: string;
  };
  remote_surface_descriptor_refs: string[];
  preview_art: CatalogPreviewArt | null;
  visual_detail_refs: string[];
  publisher_trust_root_refs: string[];
  package_finding: CatalogPackageFinding;
  source_package?: {
    package_set_relative_path: string;
    contract_path: string;
    contract_hash: string;
    material_hash: string;
    source_package_set_context: string;
  };
  recipe?: {
    package_members: Array<{
      package_identity: string;
      required_capability_ids: string[];
    }>;
    initial_config_refs: string[];
  };
  source_package_set?: {
    package_set_relative_path: string;
    material_hash_ref: string;
    package_use_decision_ref: string;
  };
  install: {
    install_subject: CatalogInstallSubject;
    target: string;
  };
};

export type BitfieldPackageCatalog = {
  schema: 'bitfield.package_store.catalog.v3';
  schema_version: number;
  catalog_id: string;
  catalog_rows: BitfieldPackageCatalogRow[];
  discovery?: Record<string, unknown>;
};

export function readBitfieldPackageCatalog(value: unknown): BitfieldPackageCatalog {
  if (!value || typeof value !== 'object') {
    return {
      schema: 'bitfield.package_store.catalog.v3',
      schema_version: 3,
      catalog_id: 'bitfield-package-store:empty',
      catalog_rows: [],
    };
  }
  const catalog = value as Partial<BitfieldPackageCatalog>;
  const discovery = catalog.discovery && typeof catalog.discovery === 'object' && !Array.isArray(catalog.discovery)
    ? catalog.discovery as Record<string, unknown>
    : undefined;
  return {
    schema: 'bitfield.package_store.catalog.v3',
    schema_version: Number(catalog.schema_version ?? 3),
    catalog_id: String(catalog.catalog_id ?? 'bitfield-package-store:catalog'),
    catalog_rows: Array.isArray(catalog.catalog_rows)
      ? catalog.catalog_rows.filter(isCatalogRow)
      : [],
    ...(discovery ? { discovery } : {}),
  };
}

function isCatalogRow(value: unknown): value is BitfieldPackageCatalogRow {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const row = value as Partial<BitfieldPackageCatalogRow>;
  if (
    typeof row.row_id !== 'string' ||
    typeof row.display_name !== 'string' ||
    typeof row.summary !== 'string' ||
    typeof row.row_kind !== 'string' ||
    !isCatalogPackageFinding(row.package_finding) ||
    !isCatalogExchange(row.exchange) ||
    !isCatalogInstallSubject(row.install?.install_subject)
  ) {
    return false;
  }

  return true;
}

function isCatalogPackageFinding(value: unknown): value is CatalogPackageFinding {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const finding = value as Partial<CatalogPackageFinding>;
  return (
    typeof finding.schema === 'string' &&
    typeof finding.title === 'string' &&
    typeof finding.summary === 'string' &&
    Array.isArray(finding.blocks) &&
    finding.blocks.every(isCatalogFindingBlock) &&
    Array.isArray(finding.facets) &&
    Array.isArray(finding.detail_blocks) &&
    typeof finding.search?.text === 'string'
  );
}

function isCatalogFindingBlock(value: unknown): value is CatalogFindingBlock {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const block = value as Partial<CatalogFindingBlock>;
  const hasValue = 'value' in block || Array.isArray(block.values);
  return (
    typeof block.id === 'string' &&
    typeof block.render_kind === 'string' &&
    typeof block.role === 'string' &&
    hasValue
  );
}

function isCatalogInstallSubject(value: unknown): value is CatalogInstallSubject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const subject = value as Record<string, unknown>;
  return (
    typeof subject.subject_ref === 'string' &&
    typeof subject.subject_type_ref === 'string' &&
    typeof subject.subject_label === 'string' &&
    Object.values(subject).every((child) => typeof child === 'string')
  );
}

function isCatalogExchange(value: unknown): value is CatalogExchange {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const exchange = value as Partial<CatalogExchange>;
  return (
    stringArray(exchange.package_file_download_pointer_object_keys) &&
    stringArray(exchange.package_file_metadata_pointer_refs) &&
    stringArray(exchange.package_use_decision_refs) &&
    isCatalogExchangeAccess(exchange.access) &&
    isCatalogExchangeOffer(exchange.offer) &&
    stringArray(exchange.update_policy_refs) &&
    stringArray(exchange.provenance_refs)
  );
}

function isCatalogExchangeAccess(value: unknown): value is CatalogExchangeAccess {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const access = value as Partial<CatalogExchangeAccess>;
  return (
    stringArray(access.admission_fact_refs) &&
    stringArray(access.product_access_proof_refs) &&
    stringArray(access.required_owner_target_refs)
  );
}

function isCatalogExchangeOffer(value: unknown): value is CatalogExchangeOffer {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const offer = value as Partial<CatalogExchangeOffer>;
  return (
    (offer.display_ref === null || typeof offer.display_ref === 'string') &&
    stringArray(offer.signed_deal_contract_refs) &&
    stringArray(offer.quote_reservation_target_refs) &&
    stringArray(offer.meter_unit_refs) &&
    stringArray(offer.policy_refs)
  );
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}
