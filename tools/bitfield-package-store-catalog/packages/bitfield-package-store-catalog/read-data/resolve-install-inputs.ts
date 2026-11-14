type Row = Record<string, any>;
const object = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const refs = (value: unknown): value is string[] => Array.isArray(value) && value.length > 0 && value.every(text)
  && new Set(value).size === value.length;

/** Prepare exact installer inputs, never grant trust or perform installation. */
export function resolveInstallInputs(catalog: unknown, selection: { package_identity: string; package_set?: string }) {
  const missing = (code: string, missing_fields: string[]) => ({ status: 'unavailable' as const, code, missing_fields,
    message: 'The required package is not ready to install. Your entries have not been submitted.' });
  const missingSelection = ['package_identity'].filter(key => !text(selection[key as keyof typeof selection]));
  // Omission delegates destination resolution to the existing native installer,
  // which requires exactly one configured app package set. Never guess it from
  // a partition, source package set, or caller-supplied runtime context.
  if (selection.package_set !== undefined && !text(selection.package_set)) missingSelection.push('package_set');
  if (missingSelection.length) return missing('missing_selection', missingSelection);
  const data = object(catalog);
  if (data.schema !== 'bitfield.package_store.catalog.v3' || !Array.isArray(data.catalog_rows)) return missing('catalog_unavailable', ['catalog']);
  const rows = data.catalog_rows.filter((row: Row) => row.row_kind === 'package-row' && row.package_identity === selection.package_identity);
  if (rows.length !== 1) return missing(rows.length ? 'ambiguous_package' : 'package_unavailable', ['package_identity']);
  const row = rows[0];
  if (row.revoked === true || row.status === 'revoked') return missing('package_revoked', ['current_package']);
  const source = object(row.source_package);
  const exchange = object(row.exchange);
  const absent = [];
  if (!text(source.source_package_set_context)) absent.push('source_package_set');
  if (!refs(exchange.package_file_download_pointer_object_keys)) absent.push('package_file_download_pointer_object_keys');
  if (!refs(row.publisher_trust_root_refs)) absent.push('publisher_trust_root_refs');
  if (absent.length) return missing('missing_install_inputs', absent);
  return { status: 'prepared' as const, catalog_id: data.catalog_id, row_id: row.row_id,
    message: 'Package details are available. Installation still requires the package installer to verify access and signatures.',
    request: { target: 'package-files.install-packages-from-pointers', payload: {
      ...(selection.package_set === undefined ? {} : { package_set: selection.package_set }),
      source_package_set: source.source_package_set_context,
      package_identities: [selection.package_identity],
      package_file_download_pointer_object_keys: [...exchange.package_file_download_pointer_object_keys],
      publisher_trust_root_refs: [...row.publisher_trust_root_refs],
    } } };
}
