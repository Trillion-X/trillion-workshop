type JsonRecord = Record<string, unknown>;

export type ResolveReleaseInputsRequest = {
  schema: 'bitfield-package-store.resolve-release-inputs.request/v1';
  catalog: unknown;
  package_identities: string[];
};

export type ResolvedReleasePackage = {
  package_identity: string;
  row_id: string;
  package_set_relative_path: string;
  contract_path: string;
  contract_hash: string;
  material_hash: string;
};

function record(value: unknown): JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function resolveReleaseInputs(request: ResolveReleaseInputsRequest) {
  if (request?.schema !== 'bitfield-package-store.resolve-release-inputs.request/v1') {
    throw new Error('BPSCAT_RELEASE_001_REQUEST_SCHEMA');
  }
  if (!Array.isArray(request.package_identities) || request.package_identities.length === 0) {
    throw new Error('BPSCAT_RELEASE_002_PACKAGE_IDENTITIES_REQUIRED');
  }
  const duplicateRequests = request.package_identities.filter((value, index, values) => (
    values.indexOf(value) !== index
  ));
  if (duplicateRequests.length > 0) {
    throw new Error(`BPSCAT_RELEASE_003_DUPLICATE_SELECTOR:${duplicateRequests[0]}`);
  }

  const catalog = record(request.catalog);
  const rows = Array.isArray(catalog.catalog_rows) ? catalog.catalog_rows.map(record) : [];
  const resolved_packages: ResolvedReleasePackage[] = [];
  for (const packageIdentity of request.package_identities) {
    const matches = rows.filter((row) => (
      row.row_kind === 'package-row' && row.package_identity === packageIdentity
    ));
    if (matches.length === 0) {
      throw new Error(`BPSCAT_RELEASE_004_PACKAGE_NOT_FOUND:${packageIdentity}`);
    }
    if (matches.length !== 1) {
      throw new Error(`BPSCAT_RELEASE_005_PACKAGE_AMBIGUOUS:${packageIdentity}`);
    }
    const row = matches[0];
    const source = record(row.source_package);
    const resolved = {
      package_identity: packageIdentity,
      row_id: text(row.row_id),
      package_set_relative_path: text(source.package_set_relative_path),
      contract_path: text(source.contract_path),
      contract_hash: text(source.contract_hash),
      material_hash: text(source.material_hash),
    };
    for (const [field, value] of Object.entries(resolved)) {
      if (!value) throw new Error(`BPSCAT_RELEASE_006_SOURCE_FIELD_MISSING:${packageIdentity}:${field}`);
    }
    resolved_packages.push(resolved);
  }

  return {
    schema: 'bitfield-package-store.resolve-release-inputs.response/v1',
    status: 'resolved',
    catalog_id: text(catalog.catalog_id),
    resolved_packages,
  } as const;
}
