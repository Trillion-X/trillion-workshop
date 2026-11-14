export type CloudFileOperationKey =
  | 'list_directory'
  | 'read_file_bytes'
  | 'write_file'
  | 'create_folder'
  | 'rename_path'
  | 'delete_path';

export interface CloudFileOperationRoute {
  target: string;
  definition_id?: string;
  operation?: string;
  payload?: Record<string, unknown>;
  include_output?: boolean;
}

export interface CloudFileSource {
  id: string;
  name: string;
  provider: string;
  rootPath: string;
  serviceConnectionRef?: string;
  credentialHandle?: string;
  connectionEnabled?: boolean;
  operations: Partial<Record<CloudFileOperationKey, CloudFileOperationRoute>>;
}

const CLOUD_FILE_SOURCE_KIND = 'cloud-file-source';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readPayload(row: Record<string, unknown>): unknown {
  return row.payload;
}

function readText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readOperationRoute(value: unknown): CloudFileOperationRoute | null {
  if (!isRecord(value)) return null;
  const target = readText(value.target);
  if (!target) return null;
  const definitionId = readText(value.definition_id ?? value.definitionId);
  const operation = readText(value.operation);
  const payload = isRecord(value.payload) ? value.payload : undefined;
  return {
    target,
    definition_id: definitionId || undefined,
    operation: operation || undefined,
    payload,
    include_output: typeof value.include_output === 'boolean'
      ? value.include_output
      : typeof value.includeOutput === 'boolean'
        ? value.includeOutput
        : undefined,
  };
}

function readOperations(value: unknown): CloudFileSource['operations'] {
  if (!isRecord(value)) return {};
  const operations: CloudFileSource['operations'] = {};
  for (const key of [
    'list_directory',
    'read_file_bytes',
    'write_file',
    'create_folder',
    'rename_path',
    'delete_path',
  ] satisfies CloudFileOperationKey[]) {
    const route = readOperationRoute(value[key]);
    if (route) operations[key] = route;
  }
  return operations;
}

function readSource(payload: Record<string, unknown>, fallbackId: string): CloudFileSource | null {
  const kind = readText(payload.kind ?? payload.type);
  if (kind !== CLOUD_FILE_SOURCE_KIND) return null;

  const id = readText(payload.id ?? payload.source_id ?? payload.sourceId) || fallbackId;
  if (!id) return null;

  return {
    id,
    name: readText(payload.name) || id,
    provider: readText(payload.provider ?? payload.vendor),
    rootPath: readText(payload.root_path ?? payload.rootPath),
    serviceConnectionRef: readText(payload.service_connection_ref ?? payload.serviceConnectionRef) || undefined,
    credentialHandle: readText(
      payload.credential_handle_ref ?? payload.credentialHandleRef ?? payload.credential_handle ?? payload.credentialHandle,
    ) || undefined,
    connectionEnabled: typeof payload.connection_enabled === 'boolean' ? payload.connection_enabled : undefined,
    operations: readOperations(payload.operations),
  };
}

function readFallbackId(row: Record<string, unknown>, index: number): string {
  for (const key of ['address', 'id', 'recordId', 'record_id']) {
    const value = readText(row[key]);
    if (value) return value;
  }
  return `cloud-file-source:${index}`;
}

export function decodeCloudFileSources(raw: unknown): CloudFileSource[] {
  const rows = Array.isArray(raw) ? raw : [];
  const sources = new Map<string, CloudFileSource>();

  rows.forEach((row, index) => {
    if (!isRecord(row)) return;
    const payload = readPayload(row);
    if (!isRecord(payload)) return;
    const source = readSource(payload, readFallbackId(row, index));
    if (source) sources.set(source.id, source);
  });

  return [...sources.values()].sort((left, right) =>
    left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
  );
}

export function requireCloudFileOperation(
  source: CloudFileSource,
  key: CloudFileOperationKey,
): CloudFileOperationRoute {
  const route = source.operations[key];
  if (!route) {
    throw new Error(`Cloud file source "${source.name}" does not publish ${key}`);
  }
  return route;
}

function mergeInputPayload(
  payload: Record<string, unknown> | undefined,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const baseInput = isRecord(payload?.input) ? payload.input : {};
  return { ...baseInput, ...input };
}

export function buildCloudFileOperationPayload(
  route: CloudFileOperationRoute,
  input: Record<string, unknown>,
  includeOutput: boolean,
): Record<string, unknown> {
  if (route.definition_id) {
    return {
      operation: route.operation || 'execute_definition',
      definition_id: route.definition_id,
      include_steps: false,
      include_output: route.include_output ?? includeOutput,
      input: mergeInputPayload(route.payload, input),
    };
  }

  return {
    ...(route.payload ?? {}),
    input: mergeInputPayload(route.payload, input),
  };
}
