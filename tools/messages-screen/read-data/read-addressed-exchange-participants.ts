// PORTED FROM: bitfield-packages/packages/chat/read-data/read-addressed-exchange-participants.ts @ e99ac5976
// Decodes addressed exchange participant and reachability records used by Chat.
// Process-backed participants are one way-to-reach, not the exchange root.

import type { StreamParseSpec } from './stream-parse-spec';

export interface AddressedParticipantModelOption {
  id: string;
  label: string;
  isDefault?: boolean;
  description?: string;
}

export interface AddressedParticipantAccount {
  id: string;
  label: string;
  configDir: string;
}

export interface AddressedParticipantSelector {
  from: 'account';
  path: string[];
}

export type AddressedParticipantLaunchArgument =
  | string
  | {
      literal: string;
      when?: string;
    }
  | {
      value: string;
      when?: string;
      optional?: boolean;
    };

export interface AddressedParticipantEnvironmentBinding {
  name: string;
  source: AddressedParticipantSelector;
}

export interface AddressedParticipantOutputSessionId {
  stream: 'stdout' | 'stderr';
  format: string;
  match?: {
    field: string;
    equals: unknown;
  };
  path: string[];
}

export interface AddressedParticipantLaunchSpec {
  argv: AddressedParticipantLaunchArgument[];
  resumeArgv?: AddressedParticipantLaunchArgument[];
  cwd?: 'projectPath';
  newSessionId?: 'uuid' | null;
  env?: AddressedParticipantEnvironmentBinding[];
  outputSessionId?: AddressedParticipantOutputSessionId | null;
}

export interface AddressedConnectionState {
  connectionStateRef: string | null;
  serviceConnectionRef: string | null;
  statusRef: string | null;
  requiresAuth: boolean | null;
  canConnect: boolean;
  canSend: boolean;
  canRetry: boolean;
  isPending: boolean;
}

export interface AddressedSetupFieldDescriptor {
  id: string;
  label: string;
  required: boolean;
  secret: boolean;
  multiline: boolean;
  placeholder: string | null;
  help: string | null;
  autocomplete: string | null;
  /** Deep link to the provider page where the value is created/copied (data-driven, may be null). */
  guideUrl: string | null;
  /** Numbered, exact steps to obtain the value (banana-level; empty = no guide). */
  guideSteps: string[];
}

export interface ResolvedVerifyCredentialInjection {
  fieldId: string;
  placement: Record<string, unknown>;
}

export interface ResolvedVerifyRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
  credentialInjections: ResolvedVerifyCredentialInjection[];
  expectedStatus: { min: number; max: number } | Record<string, unknown> | null;
  routeRef: string | null;
  requestTemplateRef: string | null;
}

export interface AddressedSetupDescriptor {
  setupDescriptorRef: string | null;
  credentialStoreTargetRef: string | null;
  fields: AddressedSetupFieldDescriptor[];
  inputSchema: Record<string, unknown> | null;
  resolvedVerifyRequest: ResolvedVerifyRequest | null;
}

export interface AddressedRouteDescriptor {
  routeRef: string;
  targetRef: string | null;
  operationRef: string | null;
  definitionId: string | null;
  inputSchemaRef: string | null;
  resultProjectionRef: string | null;
  streamParseSpecRef: string | null;
  setupDescriptor: AddressedSetupDescriptor | null;
}

export interface AddressedWayToReachAdapterDescriptor {
  kind: string;
  sourceAdapterRef: string;
  ownerTargetRef: string | null;
  capabilityRefs: string[];
  routeRefs: string[];
  setupRouteRefs: string[];
  connectionStateRefs: string[];
  ingestionRouteRefs: string[];
  resultProjectionRefs: string[];
  streamParseSpecRefs: string[];
  proofRefs: string[];
  blockerRefs: string[];
  serviceConnectionRefs: string[];
  credentialHandleRefs: string[];
  requiresAuth: boolean | null;
  permissionRef: string | null;
  guardRef: string | null;
  statusRef: string | null;
  metadata: Record<string, unknown>;
  payload: Record<string, unknown>;
  /**
   * How to turn this participant's raw output stream into normalized messages.
   * Pure data (see read-data/stream-parse-spec.ts). Null when the participant
   * does not stream a parseable wire format. The surface code never inspects its
   * contents — it hands the spec to the generic interpreter.
   */
  streamParseSpec: StreamParseSpec | null;
}

export interface AddressedParticipantDisplayMark {
  iconName: string | null;
  /**
   * A logo image carried as a URL or data-URL in the participant's data. When
   * present it is rendered as the participant's mark (a real logo) in place of
   * the glyph. Fully data-driven: any participant — agent, model, human,
   * service, animal, device — supplies its own logo as data, with zero
   * per-participant code. Falls back to `iconName`/`text` when absent.
   */
  logoUrl: string | null;
  text: string | null;
  background: string | null;
  foreground: string | null;
  border: string | null;
}

export interface ProcessAddressedWayToReachAdapter extends AddressedWayToReachAdapterDescriptor {
  kind: 'process-session';
  sourceAdapterRef: string;
  launch: AddressedParticipantLaunchSpec;
}

export interface AiRecordsProducerAddressedWayToReachAdapter extends AddressedWayToReachAdapterDescriptor {
  kind: 'ai-records-producer';
}

export interface AddressedParticipantInfo {
  participantRef: string;
  wayToReachRef: string | null;
  label: string;
  version: string;
  accounts: AddressedParticipantAccount[];
  models: AddressedParticipantModelOption[];
  adapter: AddressedWayToReachAdapterDescriptor | null;
  routeRefs: string[];
  setupRouteRefs: string[];
  connectionStateRefs: string[];
  ingestionRouteRefs: string[];
  resultProjectionRefs: string[];
  streamParseSpecRefs: string[];
  proofRefs: string[];
  blockerRefs: string[];
  routeDescriptors: AddressedRouteDescriptor[];
  connectionStates: AddressedConnectionState[];
  badgeColor: string | null;
  providerRefs: string[];
  capabilityRefs: string[];
  serviceConnectionRefs: string[];
  credentialHandleRefs: string[];
  requiresAuth: boolean;
  permissionRef: string | null;
  guardRef: string | null;
  statusRef: string | null;
  metadata: Record<string, unknown>;
  displayMark: AddressedParticipantDisplayMark;
}

interface AddressedParticipantRow {
  subjectId: string;
  values: Record<string, unknown>;
}

interface AddressedWayToReachRow {
  subjectId: string;
  values: Record<string, unknown>;
}

interface ConnectionStateRow {
  subjectId: string;
  values: Record<string, unknown>;
}

interface AddressedRouteRow {
  subjectId: string;
  values: Record<string, unknown>;
}

interface SetupDescriptorRow {
  subjectId: string;
  values: Record<string, unknown>;
}

interface SetupFieldRow {
  subjectId: string;
  values: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function asRecordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is Record<string, unknown> => isRecord(entry))
    : [];
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
    : [];
}

function asStringArrayFromFields(record: Record<string, unknown>, ...keys: string[]): string[] {
  for (const key of keys) {
    const values = asStringArray(record[key]);
    if (values.length > 0) return values;
  }
  return [];
}

function asLaunchArgument(value: unknown): AddressedParticipantLaunchArgument | null {
  if (typeof value === 'string') return value;
  if (!isRecord(value)) return null;
  const when = typeof value.when === 'string' && value.when.length > 0 ? value.when : undefined;
  if (typeof value.literal === 'string') {
    return when ? { literal: value.literal, when } : { literal: value.literal };
  }
  if (typeof value.value === 'string' && value.value.length > 0) {
    return {
      value: value.value,
      ...(when ? { when } : {}),
      ...(typeof value.optional === 'boolean' ? { optional: value.optional } : {}),
    };
  }
  return null;
}

function asLaunchArguments(value: unknown): AddressedParticipantLaunchArgument[] {
  return Array.isArray(value)
    ? value.map(asLaunchArgument).filter((entry): entry is AddressedParticipantLaunchArgument => entry !== null)
    : [];
}

function asLaunchEnvBinding(value: unknown): AddressedParticipantEnvironmentBinding | null {
  if (!isRecord(value)) return null;
  if (typeof value.name !== 'string' || value.name.length === 0) return null;
  if (!isRecord(value.source)) return null;
  if (value.source.from !== 'account') return null;
  if (!Array.isArray(value.source.path) || !value.source.path.every((part) => typeof part === 'string')) return null;
  return { name: value.name, source: { from: 'account', path: value.source.path } };
}

function asLaunchOutputSessionId(value: unknown): AddressedParticipantOutputSessionId | null {
  if (!isRecord(value)) return null;
  if (value.stream !== 'stdout' && value.stream !== 'stderr') return null;
  if (typeof value.format !== 'string' || value.format.length === 0) return null;
  if (!Array.isArray(value.path) || !value.path.every((part) => typeof part === 'string')) return null;
  const match = isRecord(value.match) ? value.match : null;
  return {
    stream: value.stream,
    format: value.format,
    path: value.path,
    ...(typeof match?.field === 'string' ? { match: { field: match.field, equals: match.equals } } : {}),
  };
}

function asLaunchSpec(value: unknown): AddressedParticipantLaunchSpec | null {
  if (!isRecord(value)) return null;
  const argv = asLaunchArguments(value.argv);
  if (argv.length === 0) return null;
  const resumeArgv = asLaunchArguments(value.resumeArgv);
  const env = Array.isArray(value.env)
    ? value.env.map(asLaunchEnvBinding).filter((entry): entry is AddressedParticipantEnvironmentBinding => entry !== null)
    : [];
  return {
    argv,
    ...(resumeArgv.length > 0 ? { resumeArgv } : {}),
    ...(value.cwd === 'projectPath' ? { cwd: value.cwd } : {}),
    ...(value.newSessionId === 'uuid' ? { newSessionId: value.newSessionId } : {}),
    ...(env.length > 0 ? { env } : {}),
    outputSessionId: asLaunchOutputSessionId(value.outputSessionId),
  };
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function asBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value === 'true';
  return false;
}

function asOptionalBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (value === 'true') return true;
    if (value === 'false') return false;
  }
  return null;
}

function asRecordFromJson(value: unknown): Record<string, unknown> | null {
  if (isRecord(value)) return value;
  if (typeof value !== 'string' || value.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function readRecordField(record: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    if (record[key] !== undefined) return record[key];
  }
  return undefined;
}

function asAdapterPayload(value: unknown): Record<string, unknown> {
  return isRecord(value) ? { ...value } : {};
}

function readMetadataString(record: Record<string, unknown>, ...keys: string[]): string | null {
  return asString(readRecordField(record, ...keys));
}

function readDisplayMark(metadata: Record<string, unknown>): AddressedParticipantDisplayMark {
  return {
    iconName: readMetadataString(metadata, 'iconName', 'icon_name', 'icon'),
    logoUrl: readMetadataString(metadata, 'logoUrl', 'logo_url', 'logo', 'iconUrl', 'icon_url', 'avatarUrl', 'avatar_url'),
    text: readMetadataString(metadata, 'markText', 'mark_text', 'glyph', 'initials'),
    background: readMetadataString(metadata, 'markBackground', 'mark_background', 'background'),
    foreground: readMetadataString(metadata, 'markForeground', 'mark_foreground', 'foreground'),
    border: readMetadataString(metadata, 'markBorder', 'mark_border', 'border'),
  };
}

function dedupeRefs(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function readRefsFromRawAndRow(
  raw: Record<string, unknown> | null,
  row: Record<string, unknown>,
  camelKey: string,
  snakeKey: string,
): string[] {
  return dedupeRefs([
    ...(raw ? asStringArray(readRecordField(raw, camelKey, snakeKey)) : []),
    ...asStringArray(readRecordField(row, snakeKey, camelKey)),
  ]);
}

function decodeSetupFieldDescriptor(value: unknown): AddressedSetupFieldDescriptor | null {
  if (!isRecord(value)) return null;
  const id = asString(readRecordField(value, 'id', 'fieldId', 'field_id', 'name'));
  if (!id) return null;
  return {
    id,
    label: asString(readRecordField(value, 'label', 'title')) ?? id,
    required: asBoolean(readRecordField(value, 'required', 'isRequired', 'is_required')),
    secret: asBoolean(readRecordField(value, 'secret', 'isSecret', 'is_secret')),
    multiline: asBoolean(readRecordField(value, 'multiline', 'multiLine', 'multi_line')),
    placeholder: asString(readRecordField(value, 'placeholder')),
    help: asString(readRecordField(value, 'help', 'description')),
    autocomplete: asString(readRecordField(value, 'autocomplete', 'autoComplete', 'auto_complete')),
    guideUrl: asString(readRecordField(value, 'guideUrl', 'guide_url')),
    guideSteps: asStringArray(readRecordField(value, 'guideSteps', 'guide_steps')),
  };
}

function decodeFieldsFromInputSchema(inputSchema: Record<string, unknown> | null): AddressedSetupFieldDescriptor[] {
  if (!inputSchema) return [];
  const properties = readRecordField(inputSchema, 'properties', 'fields');
  const required = asStringArray(readRecordField(inputSchema, 'required'));
  if (!isRecord(properties)) return [];
  return Object.entries(properties)
    .map(([id, value]) => {
      const fieldRecord = isRecord(value) ? value : {};
      return decodeSetupFieldDescriptor({
        id,
        label: readRecordField(fieldRecord, 'label', 'title') ?? id,
        required: required.includes(id) || readRecordField(fieldRecord, 'required'),
        secret: readRecordField(fieldRecord, 'secret', 'isSecret', 'is_secret'),
        multiline: readRecordField(fieldRecord, 'multiline', 'multiLine', 'multi_line'),
        placeholder: readRecordField(fieldRecord, 'placeholder'),
        help: readRecordField(fieldRecord, 'help', 'description'),
        autocomplete: readRecordField(fieldRecord, 'autocomplete', 'autoComplete', 'auto_complete'),
      });
    })
    .filter((entry): entry is AddressedSetupFieldDescriptor => entry !== null);
}

function decodeResolvedVerifyCredentialInjection(value: unknown): ResolvedVerifyCredentialInjection | null {
  if (!isRecord(value)) return null;
  const fieldId = asString(readRecordField(value, 'fieldId', 'field_id'));
  if (!fieldId) return null;
  return {
    fieldId,
    placement: isRecord(value.placement) ? value.placement : {},
  };
}

function decodeResolvedVerifyRequest(value: unknown): ResolvedVerifyRequest | null {
  const request = asRecordFromJson(value);
  if (!request) return null;
  const url = asString(request.url);
  if (!url) return null;
  const method = asString(request.method) ?? 'GET';
  const headersRaw = readRecordField(request, 'headers');
  const headers = isRecord(headersRaw)
    ? Object.fromEntries(
        Object.entries(headersRaw).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
      )
    : {};
  const credentialInjectionsRaw = readRecordField(request, 'credentialInjections', 'credential_injections');
  const credentialInjections = Array.isArray(credentialInjectionsRaw)
    ? credentialInjectionsRaw
        .map(decodeResolvedVerifyCredentialInjection)
        .filter((entry): entry is ResolvedVerifyCredentialInjection => entry !== null)
    : [];
  const expectedStatusRaw = readRecordField(request, 'expectedStatus', 'expected_status');
  return {
    url,
    method,
    headers,
    body: readRecordField(request, 'body') ?? null,
    credentialInjections,
    expectedStatus: isRecord(expectedStatusRaw) ? expectedStatusRaw : null,
    routeRef: asString(readRecordField(request, 'routeRef', 'route_ref')),
    requestTemplateRef: asString(readRecordField(request, 'requestTemplateRef', 'request_template_ref')),
  };
}

function decodeSetupDescriptor(value: unknown): AddressedSetupDescriptor | null {
  if (!isRecord(value)) return null;
  const setupDescriptorRef = asString(readRecordField(value, 'setupDescriptorRef', 'setup_descriptor_ref', 'descriptorRef', 'descriptor_ref'));
  const inputSchemaRaw = readRecordField(value, 'inputSchema', 'input_schema');
  const inputSchema = isRecord(inputSchemaRaw) ? inputSchemaRaw : null;
  const fieldsRaw = readRecordField(value, 'fields', 'fieldRefs', 'field_refs');
  const explicitFields = Array.isArray(fieldsRaw)
    ? fieldsRaw
        .map((entry) => typeof entry === 'string' ? { id: entry, label: entry } : entry)
        .map(decodeSetupFieldDescriptor)
        .filter((entry): entry is AddressedSetupFieldDescriptor => entry !== null)
    : [];
  return {
    setupDescriptorRef,
    credentialStoreTargetRef: asString(readRecordField(value, 'credentialStoreTargetRef', 'credential_store_target_ref')),
    fields: explicitFields.length > 0 ? explicitFields : decodeFieldsFromInputSchema(inputSchema),
    inputSchema,
    resolvedVerifyRequest: decodeResolvedVerifyRequest(readRecordField(value, 'resolvedVerifyRequest', 'resolved_verify_request')),
  };
}

function decodeSetupFieldFromRow(field: SetupFieldRow): AddressedSetupFieldDescriptor | null {
  return decodeSetupFieldDescriptor({
    id: readRecordField(field.values, 'id') ?? field.subjectId,
    label: readRecordField(field.values, 'label') ?? readRecordField(field.values, 'id') ?? field.subjectId,
    required: readRecordField(field.values, 'required'),
    secret: readRecordField(field.values, 'secret'),
    multiline: readRecordField(field.values, 'multiline'),
    placeholder: readRecordField(field.values, 'placeholder'),
    help: readRecordField(field.values, 'help'),
    autocomplete: readRecordField(field.values, 'autocomplete'),
    guide_url: readRecordField(field.values, 'guide_url'),
    guide_steps: readRecordField(field.values, 'guide_steps'),
  });
}

function decodeSetupDescriptorFromRows(
  subjectId: string | null,
  setupDescriptorRows: Map<string, SetupDescriptorRow>,
  setupFieldRows: Map<string, SetupFieldRow>,
): AddressedSetupDescriptor | null {
  if (!subjectId) return null;
  const row = setupDescriptorRows.get(subjectId);
  if (!row) return null;
  const fieldRefs = asStringArray(readRecordField(row.values, 'field_refs', 'fieldRefs'));
  return {
    setupDescriptorRef: subjectId,
    credentialStoreTargetRef: asString(readRecordField(row.values, 'credential_store_target_ref', 'credentialStoreTargetRef')),
    fields: fieldRefs
      .map((fieldRef) => {
        const fieldRow = setupFieldRows.get(fieldRef);
        return fieldRow ? decodeSetupFieldFromRow(fieldRow) : decodeSetupFieldDescriptor({ id: fieldRef, label: fieldRef });
      })
      .filter((entry): entry is AddressedSetupFieldDescriptor => entry !== null),
    inputSchema: null,
    resolvedVerifyRequest: decodeResolvedVerifyRequest(readRecordField(row.values, 'resolved_verify_request', 'resolvedVerifyRequest')),
  };
}

function decodeRouteDescriptor(value: unknown): AddressedRouteDescriptor | null {
  if (!isRecord(value)) return null;
  const routeRef = asString(readRecordField(value, 'routeRef', 'route_ref', 'id'));
  if (!routeRef) return null;
  return {
    routeRef,
    targetRef: asString(readRecordField(value, 'targetRef', 'target_ref', 'target')),
    operationRef: asString(readRecordField(value, 'operationRef', 'operation_ref')),
    definitionId: asString(readRecordField(value, 'definitionId', 'definition_id')),
    inputSchemaRef: asString(readRecordField(value, 'inputSchemaRef', 'input_schema_ref')),
    resultProjectionRef: asString(readRecordField(value, 'resultProjectionRef', 'result_projection_ref')),
    streamParseSpecRef: asString(readRecordField(value, 'streamParseSpecRef', 'stream_parse_spec_ref')),
    setupDescriptor: decodeSetupDescriptor(readRecordField(value, 'setupDescriptor', 'setup_descriptor')),
  };
}

function decodeRouteDescriptorFromRow(
  route: AddressedRouteRow,
  setupDescriptorRows: Map<string, SetupDescriptorRow>,
  setupFieldRows: Map<string, SetupFieldRow>,
): AddressedRouteDescriptor | null {
  const routeRef = asString(readRecordField(route.values, 'route_ref', 'routeRef')) ?? route.subjectId;
  if (!routeRef) return null;
  const setupDescriptorRef = asString(readRecordField(route.values, 'setup_descriptor_ref', 'setupDescriptorRef'));
  return {
    routeRef,
    targetRef: asString(readRecordField(route.values, 'target_ref', 'targetRef')),
    operationRef: asString(readRecordField(route.values, 'operation_ref', 'operationRef')),
    definitionId: asString(readRecordField(route.values, 'definition_id', 'definitionId')),
    inputSchemaRef: asString(readRecordField(route.values, 'input_schema_ref', 'inputSchemaRef')),
    resultProjectionRef: asString(readRecordField(route.values, 'result_projection_ref', 'resultProjectionRef')),
    streamParseSpecRef: asString(readRecordField(route.values, 'stream_parse_spec_ref', 'streamParseSpecRef')),
    setupDescriptor: decodeSetupDescriptorFromRows(setupDescriptorRef, setupDescriptorRows, setupFieldRows),
  };
}

function decodeRouteDescriptors(
  row: Record<string, unknown>,
  routeRows: Map<string, AddressedRouteRow> = new Map(),
  setupDescriptorRows: Map<string, SetupDescriptorRow> = new Map(),
  setupFieldRows: Map<string, SetupFieldRow> = new Map(),
): AddressedRouteDescriptor[] {
  const direct = readRecordField(row, 'routeDescriptors', 'route_descriptors', 'addressedRoutes', 'addressed_routes');
  const descriptors = Array.isArray(direct)
    ? direct.map(decodeRouteDescriptor).filter((entry): entry is AddressedRouteDescriptor => entry !== null)
    : [];
  const routeRefs = [
    ...asStringArrayFromFields(row, 'route_refs', 'routeRefs'),
    ...asStringArrayFromFields(row, 'setup_route_refs', 'setupRouteRefs'),
    ...asStringArrayFromFields(row, 'ingestion_route_refs', 'ingestionRouteRefs'),
  ];
  for (const ref of routeRefs) {
    const route = routeRows.get(ref);
    const descriptor = route ? decodeRouteDescriptorFromRow(route, setupDescriptorRows, setupFieldRows) : null;
    if (descriptor && !descriptors.some((entry) => entry.routeRef === descriptor.routeRef)) descriptors.push(descriptor);
  }
  const routeRef = asString(readRecordField(row, 'route_ref', 'routeRef'));
  const targetRef = asString(readRecordField(row, 'target_ref', 'targetRef'));
  if (routeRef && !descriptors.some((descriptor) => descriptor.routeRef === routeRef)) {
    descriptors.push({
      routeRef,
      targetRef,
      operationRef: asString(readRecordField(row, 'operation_ref', 'operationRef')),
      definitionId: asString(readRecordField(row, 'definition_id', 'definitionId')),
      inputSchemaRef: asString(readRecordField(row, 'input_schema_ref', 'inputSchemaRef')),
      resultProjectionRef: asString(readRecordField(row, 'result_projection_ref', 'resultProjectionRef')),
      streamParseSpecRef: asString(readRecordField(row, 'stream_parse_spec_ref', 'streamParseSpecRef')),
      setupDescriptor: decodeSetupDescriptor(readRecordField(row, 'setup_descriptor', 'setupDescriptor')),
    });
  }
  return descriptors;
}

function decodeConnectionState(value: unknown, subjectId: string | null = null): AddressedConnectionState | null {
  if (!isRecord(value)) return null;
  return {
    connectionStateRef: asString(readRecordField(value, 'connectionStateRef', 'connection_state_ref', 'stateRef', 'state_ref')) ?? subjectId,
    serviceConnectionRef: asString(readRecordField(value, 'serviceConnectionRef', 'service_connection_ref', 'connectionRef', 'connection_ref')),
    statusRef: asString(readRecordField(value, 'statusRef', 'status_ref')),
    requiresAuth: asOptionalBoolean(readRecordField(value, 'requiresAuth', 'requires_auth')),
    canConnect: asBoolean(readRecordField(value, 'canConnect', 'can_connect')),
    canSend: asBoolean(readRecordField(value, 'canSend', 'can_send')),
    canRetry: asBoolean(readRecordField(value, 'canRetry', 'can_retry')),
    isPending: asBoolean(readRecordField(value, 'isPending', 'is_pending')),
  };
}

function decodeConnectionStates(row: Record<string, unknown>): AddressedConnectionState[] {
  const direct = readRecordField(row, 'connectionStates', 'connection_states', 'connectionState', 'connection_state');
  const decoded = Array.isArray(direct)
    ? direct
      .map((entry) => decodeConnectionState(entry))
      .filter((entry): entry is AddressedConnectionState => entry !== null)
    : [decodeConnectionState(direct)].filter((entry): entry is AddressedConnectionState => entry !== null);
  const flat = decodeConnectionState({
    connection_state_ref: readRecordField(row, 'connection_state_ref', 'connectionStateRef'),
    service_connection_ref: readRecordField(row, 'service_connection_ref', 'serviceConnectionRef', 'connection_ref', 'connectionRef'),
    status_ref: readRecordField(row, 'status_ref', 'statusRef'),
    requires_auth: readRecordField(row, 'requires_auth', 'requiresAuth'),
    can_connect: readRecordField(row, 'can_connect', 'canConnect'),
    can_send: readRecordField(row, 'can_send', 'canSend'),
    can_retry: readRecordField(row, 'can_retry', 'canRetry'),
    is_pending: readRecordField(row, 'is_pending', 'isPending'),
  });
  return flat && (
    flat.connectionStateRef
    || flat.serviceConnectionRef
    || flat.statusRef
    || flat.canConnect
    || flat.canSend
    || flat.canRetry
    || flat.isPending
  )
    ? [...decoded, flat]
    : decoded;
}

function decodeAdapterDescriptor(
  value: unknown,
  subjectId: string,
  row: Record<string, unknown>,
): AddressedWayToReachAdapterDescriptor | null {
  const raw = isRecord(value) ? value : null;
  const launch = asLaunchSpec(
    raw ? readRecordField(raw, 'launch', 'processSessionLaunch', 'process_session_launch') ?? value : value,
  );
  const kind =
    asString(raw && readRecordField(raw, 'kind', 'adapterKind', 'adapter_kind'))
    ?? (launch ? 'process-session' : null);
  if (!kind) return null;

  const sourceAdapterRef =
    asString(raw && readRecordField(raw, 'sourceAdapterRef', 'source_adapter_ref'))
    ?? asString(readRecordField(row, 'source_adapter_ref', 'sourceAdapterRef'))
    ?? subjectId;
  const ownerTargetRef =
    asString(raw && readRecordField(raw, 'ownerTargetRef', 'owner_target_ref', 'target', 'target_ref'))
    ?? asString(readRecordField(row, 'owner_target_ref', 'ownerTargetRef'))
    ?? (kind === 'process-session' ? 'slot::process-session' : null);
  const capabilityRefs = asStringArray(
    (raw && readRecordField(raw, 'capabilityRefs', 'capability_refs'))
    ?? readRecordField(row, 'capability_refs', 'capabilityRefs'),
  );
  const routeRefs = readRefsFromRawAndRow(raw, row, 'routeRefs', 'route_refs');
  const setupRouteRefs = readRefsFromRawAndRow(raw, row, 'setupRouteRefs', 'setup_route_refs');
  const connectionStateRefs = readRefsFromRawAndRow(raw, row, 'connectionStateRefs', 'connection_state_refs');
  const ingestionRouteRefs = readRefsFromRawAndRow(raw, row, 'ingestionRouteRefs', 'ingestion_route_refs');
  const resultProjectionRefs = readRefsFromRawAndRow(raw, row, 'resultProjectionRefs', 'result_projection_refs');
  const streamParseSpecRefs = readRefsFromRawAndRow(raw, row, 'streamParseSpecRefs', 'stream_parse_spec_refs');
  const proofRefs = readRefsFromRawAndRow(raw, row, 'proofRefs', 'proof_refs');
  const blockerRefs = readRefsFromRawAndRow(raw, row, 'blockerRefs', 'blocker_refs');
  const serviceConnectionRefs = asStringArray(
    (raw && readRecordField(raw, 'serviceConnectionRefs', 'service_connection_refs'))
    ?? readRecordField(row, 'service_connection_refs', 'serviceConnectionRefs'),
  );
  const credentialHandleRefs = asStringArray(
    (raw && readRecordField(raw, 'credentialHandleRefs', 'credential_handle_refs'))
    ?? readRecordField(row, 'credential_handle_refs', 'credentialHandleRefs'),
  );
  const requiresAuth =
    asOptionalBoolean(raw && readRecordField(raw, 'requiresAuth', 'requires_auth'))
    ?? asOptionalBoolean(readRecordField(row, 'requires_auth', 'requiresAuth'));
  const permissionRef =
    asString(raw && readRecordField(raw, 'permissionRef', 'permission_ref'))
    ?? asString(readRecordField(row, 'permission_ref', 'permissionRef'));
  const guardRef =
    asString(raw && readRecordField(raw, 'guardRef', 'guard_ref'))
    ?? asString(readRecordField(row, 'guard_ref', 'guardRef'));
  const statusRef =
    asString(raw && readRecordField(raw, 'statusRef', 'status_ref'))
    ?? asString(readRecordField(row, 'status_ref', 'statusRef'));
  const metadata = asAdapterPayload(
    (raw && readRecordField(raw, 'metadata'))
    ?? readRecordField(row, 'metadata'),
  );
  const nestedPayload = raw && readRecordField(raw, 'payload');
  const payload = asAdapterPayload(nestedPayload ?? raw ?? value);
  const streamParseSpecRaw =
    (raw && readRecordField(raw, 'streamParseSpec', 'stream_parse_spec'))
    ?? readRecordField(row, 'stream_parse_spec', 'streamParseSpec');
  const streamParseSpec: StreamParseSpec | null =
    isRecord(streamParseSpecRaw) && Array.isArray((streamParseSpecRaw as Record<string, unknown>).events)
      ? (streamParseSpecRaw as unknown as StreamParseSpec)
      : null;

  if (kind === 'process-session') {
    if (!launch) return null;
    return {
      kind,
      sourceAdapterRef,
      ownerTargetRef,
      capabilityRefs,
      routeRefs,
      setupRouteRefs,
      connectionStateRefs,
      ingestionRouteRefs,
      resultProjectionRefs,
      streamParseSpecRefs,
      proofRefs,
      blockerRefs,
      serviceConnectionRefs,
      credentialHandleRefs,
      requiresAuth,
      permissionRef,
      guardRef,
      statusRef,
      metadata,
      payload: { ...payload, launch },
      streamParseSpec,
      launch,
    };
  }

  return {
    kind,
    sourceAdapterRef,
    ownerTargetRef,
    capabilityRefs,
    routeRefs,
    setupRouteRefs,
    connectionStateRefs,
    ingestionRouteRefs,
    resultProjectionRefs,
    streamParseSpecRefs,
    proofRefs,
    blockerRefs,
    serviceConnectionRefs,
    credentialHandleRefs,
    requiresAuth,
    permissionRef,
    guardRef,
    statusRef,
    metadata,
    payload,
    streamParseSpec,
  };
}

export function isProcessAddressedWayToReachAdapter(
  adapter: AddressedWayToReachAdapterDescriptor | null | undefined,
): adapter is ProcessAddressedWayToReachAdapter {
  return adapter?.kind === 'process-session'
    && isRecord(adapter)
    && isRecord((adapter as Record<string, unknown>).launch);
}

/** A participant-selected request/reply transport. This is intentionally a
 * protocol check, never a participant-kind or participant-id check. */
export function isAiRecordsProducerAddressedWayToReachAdapter(
  adapter: AddressedWayToReachAdapterDescriptor | null | undefined,
): adapter is AiRecordsProducerAddressedWayToReachAdapter {
  return adapter?.kind === 'ai-records-producer';
}

function normalizeParticipantRef(row: Record<string, unknown>, subjectId: string): string {
  if (typeof row.participant_ref === 'string' && row.participant_ref.length > 0) return row.participant_ref;
  if (typeof row.participantRef === 'string' && row.participantRef.length > 0) return row.participantRef;
  return subjectId;
}

function resolveWayToReach(
  participant: AddressedParticipantRow,
  waysBySubject: Map<string, AddressedWayToReachRow>,
): AddressedWayToReachRow | null {
  const defaultWayRef =
    asString(readRecordField(participant.values, 'default_way_to_reach_ref', 'defaultWayToReachRef'))
    ?? asString(readRecordField(participant.values, 'way_to_reach_ref', 'wayToReachRef'));
  if (defaultWayRef && waysBySubject.has(defaultWayRef)) return waysBySubject.get(defaultWayRef) ?? null;

  const participantRef =
    asString(readRecordField(participant.values, 'participant_ref', 'participantRef'))
    ?? participant.subjectId;
  for (const way of waysBySubject.values()) {
    const wayParticipantRef = asString(readRecordField(way.values, 'participant_ref', 'participantRef'));
    if (wayParticipantRef === participantRef || wayParticipantRef === participant.subjectId) return way;
  }
  return null;
}

function convertRowToParticipantInfo(
  subjectId: string,
  row: Record<string, unknown>,
  way: AddressedWayToReachRow | null = null,
  joinedConnectionStates: AddressedConnectionState[] = [],
  routeRows: Map<string, AddressedRouteRow> = new Map(),
  setupDescriptorRows: Map<string, SetupDescriptorRow> = new Map(),
  setupFieldRows: Map<string, SetupFieldRow> = new Map(),
): AddressedParticipantInfo {
  const mergedRow = way ? { ...row, ...way.values } : row;
  const participantRef = normalizeParticipantRef(row, subjectId);
  const wayToReachRef =
    (way && (asString(readRecordField(way.values, 'way_ref', 'wayRef')) ?? way.subjectId))
    ?? asString(readRecordField(row, 'default_way_to_reach_ref', 'defaultWayToReachRef'))
    ?? null;
  const label =
    typeof row.label === 'string'
      ? row.label
      : typeof row.display_name === 'string'
        ? row.display_name
        : typeof row.displayName === 'string'
          ? row.displayName
          : participantRef;
  const adapter = decodeAdapterDescriptor(
    readRecordField(mergedRow, 'adapter', 'launch'),
    wayToReachRef ?? subjectId,
    mergedRow,
  );
  const capabilityRefs = [
    ...asStringArray(row.capability_refs ?? row.capabilityRefs),
    ...(way ? asStringArray(way.values.capability_refs ?? way.values.capabilityRefs) : []),
    ...(adapter?.capabilityRefs ?? []),
  ];
  const routeRefs = [
    ...asStringArrayFromFields(row, 'route_refs', 'routeRefs'),
    ...(way ? asStringArrayFromFields(way.values, 'route_refs', 'routeRefs') : []),
    ...(adapter?.routeRefs ?? []),
  ];
  const setupRouteRefs = [
    ...asStringArrayFromFields(row, 'setup_route_refs', 'setupRouteRefs'),
    ...(way ? asStringArrayFromFields(way.values, 'setup_route_refs', 'setupRouteRefs') : []),
    ...(adapter?.setupRouteRefs ?? []),
  ];
  const connectionStateRefs = [
    ...asStringArrayFromFields(row, 'connection_state_refs', 'connectionStateRefs'),
    ...(way ? asStringArrayFromFields(way.values, 'connection_state_refs', 'connectionStateRefs') : []),
    ...(adapter?.connectionStateRefs ?? []),
  ];
  const ingestionRouteRefs = [
    ...asStringArrayFromFields(row, 'ingestion_route_refs', 'ingestionRouteRefs'),
    ...(way ? asStringArrayFromFields(way.values, 'ingestion_route_refs', 'ingestionRouteRefs') : []),
    ...(adapter?.ingestionRouteRefs ?? []),
  ];
  const resultProjectionRefs = [
    ...asStringArrayFromFields(row, 'result_projection_refs', 'resultProjectionRefs'),
    ...(way ? asStringArrayFromFields(way.values, 'result_projection_refs', 'resultProjectionRefs') : []),
    ...(adapter?.resultProjectionRefs ?? []),
  ];
  const streamParseSpecRefs = [
    ...asStringArrayFromFields(row, 'stream_parse_spec_refs', 'streamParseSpecRefs'),
    ...(way ? asStringArrayFromFields(way.values, 'stream_parse_spec_refs', 'streamParseSpecRefs') : []),
    ...(adapter?.streamParseSpecRefs ?? []),
  ];
  const proofRefs = [
    ...asStringArrayFromFields(row, 'proof_refs', 'proofRefs'),
    ...(way ? asStringArrayFromFields(way.values, 'proof_refs', 'proofRefs') : []),
    ...(adapter?.proofRefs ?? []),
  ];
  const blockerRefs = [
    ...asStringArrayFromFields(row, 'blocker_refs', 'blockerRefs'),
    ...(way ? asStringArrayFromFields(way.values, 'blocker_refs', 'blockerRefs') : []),
    ...(adapter?.blockerRefs ?? []),
  ];
  const serviceConnectionRefs = [
    ...asStringArray(row.service_connection_refs ?? row.serviceConnectionRefs),
    ...(way ? asStringArray(way.values.service_connection_refs ?? way.values.serviceConnectionRefs) : []),
    ...(adapter?.serviceConnectionRefs ?? []),
  ];
  const credentialHandleRefs = [
    ...asStringArray(row.credential_handle_refs ?? row.credentialHandleRefs),
    ...(way ? asStringArray(way.values.credential_handle_refs ?? way.values.credentialHandleRefs) : []),
    ...(adapter?.credentialHandleRefs ?? []),
  ];
  const explicitRequiresAuth =
    asOptionalBoolean(readRecordField(mergedRow, 'requires_auth', 'requiresAuth'))
    ?? adapter?.requiresAuth
    ?? null;
  const permissionRef =
    adapter?.permissionRef
    ?? asString(readRecordField(mergedRow, 'permission_ref', 'permissionRef'));
  const guardRef =
    adapter?.guardRef
    ?? asString(readRecordField(mergedRow, 'guard_ref', 'guardRef'));
  const statusRef =
    adapter?.statusRef
    ?? asString(readRecordField(mergedRow, 'status_ref', 'statusRef'));
  const metadata = {
    ...asAdapterPayload(row.metadata),
    ...(way ? asAdapterPayload(way.values.metadata) : {}),
    ...(adapter?.metadata ?? {}),
  };
  const routeDescriptors = decodeRouteDescriptors(mergedRow, routeRows, setupDescriptorRows, setupFieldRows);
  const connectionStates = [
    ...decodeConnectionStates(mergedRow),
    ...joinedConnectionStates,
  ].filter((state, index, states) => (
    states.findIndex((candidate) => (
      (candidate.connectionStateRef ?? '') === (state.connectionStateRef ?? '')
      && (candidate.serviceConnectionRef ?? '') === (state.serviceConnectionRef ?? '')
    )) === index
  ));
  const hasSecretSetupField = routeDescriptors.some((route) => (
    route.setupDescriptor?.fields.some((field) => field.secret) ?? false
  ));
  const requiresAuth =
    explicitRequiresAuth
    ?? connectionStates.find((state) => state.requiresAuth !== null)?.requiresAuth
    ?? hasSecretSetupField;

  return {
    participantRef,
    wayToReachRef,
    label,
    version: typeof row.version === 'string' ? row.version : '',
    accounts: asRecordArray(row.accounts).map((account) => ({
      id: typeof account.id === 'string' ? account.id : '',
      label: typeof account.label === 'string' ? account.label : '',
      configDir: typeof account.configDir === 'string' ? account.configDir : '',
    })),
    models: asRecordArray(row.models).map((model) => ({
      id: typeof model.id === 'string' ? model.id : '',
      label: typeof model.label === 'string' ? model.label : '',
      isDefault: typeof model.isDefault === 'boolean' ? model.isDefault : undefined,
      description:
        typeof model.description === 'string' && model.description.trim() !== ''
          ? model.description
          : undefined,
    })),
    adapter,
    routeRefs: dedupeRefs(routeRefs),
    setupRouteRefs: dedupeRefs(setupRouteRefs),
    connectionStateRefs: dedupeRefs(connectionStateRefs),
    ingestionRouteRefs: dedupeRefs(ingestionRouteRefs),
    resultProjectionRefs: dedupeRefs(resultProjectionRefs),
    streamParseSpecRefs: dedupeRefs(streamParseSpecRefs),
    proofRefs: dedupeRefs(proofRefs),
    blockerRefs: dedupeRefs(blockerRefs),
    routeDescriptors,
    connectionStates,
    badgeColor: typeof row.badge_color === 'string' ? row.badge_color : null,
    providerRefs: asStringArray(row.provider_refs ?? row.providerRefs),
    capabilityRefs: Array.from(new Set(capabilityRefs)),
    serviceConnectionRefs: Array.from(new Set(serviceConnectionRefs)),
    credentialHandleRefs: Array.from(new Set(credentialHandleRefs)),
    requiresAuth,
    permissionRef,
    guardRef,
    statusRef,
    metadata,
    displayMark: readDisplayMark(metadata),
  };
}

function assignParticipantField(row: Record<string, unknown>, propertyId: string, value: unknown): boolean {
  if (propertyId === 'prop:addressed_participant:participant_ref') row.participant_ref = value;
  else if (propertyId === 'prop:addressed_participant:label') row.label = value;
  else if (propertyId === 'prop:addressed_participant:display_name') row.display_name = value;
  else if (propertyId === 'prop:addressed_participant:default_way_to_reach_ref') row.default_way_to_reach_ref = value;
  else if (propertyId === 'prop:addressed_participant:provider_refs') row.provider_refs = value;
  else if (propertyId === 'prop:addressed_participant:accounts') row.accounts = value;
  else if (propertyId === 'prop:addressed_participant:models') row.models = value;
  else if (propertyId === 'prop:addressed_participant:capability_refs') row.capability_refs = value;
  else if (propertyId === 'prop:addressed_participant:role_refs') row.role_refs = value;
  else if (propertyId === 'prop:addressed_participant:source_refs') row.source_refs = value;
  else if (propertyId === 'prop:addressed_participant:metadata') row.metadata = value;
  else if (propertyId === 'prop:addressed_participant:version') row.version = value;
  else if (propertyId === 'prop:addressed_participant:badge_color') row.badge_color = value;
  else if (propertyId === 'prop:addressed_participant:requires_auth') row.requires_auth = value;
  else return false;
  return true;
}

function assignWayToReachField(row: Record<string, unknown>, propertyId: string, value: unknown): boolean {
  if (propertyId === 'prop:addressed_way_to_reach:way_ref') row.way_ref = value;
  else if (propertyId === 'prop:addressed_way_to_reach:participant_ref') row.participant_ref = value;
  else if (propertyId === 'prop:addressed_way_to_reach:label') row.label = value;
  else if (propertyId === 'prop:addressed_way_to_reach:adapter') row.adapter = value;
  else if (propertyId === 'prop:addressed_way_to_reach:adapter_kind') row.adapter_kind = value;
  else if (propertyId === 'prop:addressed_way_to_reach:source_adapter_ref') row.source_adapter_ref = value;
  else if (propertyId === 'prop:addressed_way_to_reach:owner_target_ref') row.owner_target_ref = value;
  else if (propertyId === 'prop:addressed_way_to_reach:capability_refs') row.capability_refs = value;
  else if (propertyId === 'prop:addressed_way_to_reach:route_refs') row.route_refs = value;
  else if (propertyId === 'prop:addressed_way_to_reach:setup_route_refs') row.setup_route_refs = value;
  else if (propertyId === 'prop:addressed_way_to_reach:connection_state_refs') row.connection_state_refs = value;
  else if (propertyId === 'prop:addressed_way_to_reach:ingestion_route_refs') row.ingestion_route_refs = value;
  else if (propertyId === 'prop:addressed_way_to_reach:result_projection_refs') row.result_projection_refs = value;
  else if (propertyId === 'prop:addressed_way_to_reach:stream_parse_spec_refs') row.stream_parse_spec_refs = value;
  else if (propertyId === 'prop:addressed_way_to_reach:proof_refs') row.proof_refs = value;
  else if (propertyId === 'prop:addressed_way_to_reach:blocker_refs') row.blocker_refs = value;
  else if (propertyId === 'prop:addressed_way_to_reach:route_descriptors') row.route_descriptors = value;
  else if (propertyId === 'prop:addressed_way_to_reach:service_connection_refs') row.service_connection_refs = value;
  else if (propertyId === 'prop:addressed_way_to_reach:credential_handle_refs') row.credential_handle_refs = value;
  else if (propertyId === 'prop:addressed_way_to_reach:requires_auth') row.requires_auth = value;
  else if (propertyId === 'prop:addressed_way_to_reach:permission_ref') row.permission_ref = value;
  else if (propertyId === 'prop:addressed_way_to_reach:guard_ref') row.guard_ref = value;
  else if (propertyId === 'prop:addressed_way_to_reach:status_ref') row.status_ref = value;
  else if (propertyId === 'prop:addressed_way_to_reach:metadata') row.metadata = value;
  else return false;
  return true;
}

function assignConnectionStateField(row: Record<string, unknown>, propertyId: string, value: unknown): boolean {
  if (propertyId === 'prop:connection_state:connection_state_ref') row.connection_state_ref = value;
  else if (propertyId === 'prop:connection_state:connection_ref') row.connection_ref = value;
  else if (propertyId === 'prop:connection_state:service_connection_ref') row.service_connection_ref = value;
  else if (propertyId === 'prop:connection_state:status_ref') row.status_ref = value;
  else if (propertyId === 'prop:connection_state:can_connect') row.can_connect = value;
  else if (propertyId === 'prop:connection_state:can_send') row.can_send = value;
  else if (propertyId === 'prop:connection_state:can_retry') row.can_retry = value;
  else if (propertyId === 'prop:connection_state:is_pending') row.is_pending = value;
  else if (propertyId === 'prop:connection_state:requires_auth') row.requires_auth = value;
  else return false;
  return true;
}

function assignAddressedRouteField(row: Record<string, unknown>, propertyId: string, value: unknown): boolean {
  if (propertyId === 'prop:addressed_route:route_ref') row.route_ref = value;
  else if (propertyId === 'prop:addressed_route:target_ref') row.target_ref = value;
  else if (propertyId === 'prop:addressed_route:operation_ref') row.operation_ref = value;
  else if (propertyId === 'prop:addressed_route:definition_id') row.definition_id = value;
  else if (propertyId === 'prop:addressed_route:input_schema_ref') row.input_schema_ref = value;
  else if (propertyId === 'prop:addressed_route:result_projection_ref') row.result_projection_ref = value;
  else if (propertyId === 'prop:addressed_route:stream_parse_spec_ref') row.stream_parse_spec_ref = value;
  else if (propertyId === 'prop:addressed_route:setup_descriptor_ref') row.setup_descriptor_ref = value;
  else return false;
  return true;
}

function assignSetupDescriptorField(row: Record<string, unknown>, propertyId: string, value: unknown): boolean {
  if (propertyId === 'prop:setup_descriptor:credential_store_target_ref') row.credential_store_target_ref = value;
  else if (propertyId === 'prop:setup_descriptor:field_refs') row.field_refs = value;
  else if (propertyId === 'prop:setup_descriptor:resolved_verify_request') row.resolved_verify_request = value;
  else return false;
  return true;
}

function assignSetupField(row: Record<string, unknown>, propertyId: string, value: unknown): boolean {
  if (propertyId === 'prop:setup_field:id') row.id = value;
  else if (propertyId === 'prop:setup_field:label') row.label = value;
  else if (propertyId === 'prop:setup_field:required') row.required = value;
  else if (propertyId === 'prop:setup_field:secret') row.secret = value;
  else if (propertyId === 'prop:setup_field:multiline') row.multiline = value;
  else if (propertyId === 'prop:setup_field:placeholder') row.placeholder = value;
  else if (propertyId === 'prop:setup_field:help') row.help = value;
  else if (propertyId === 'prop:setup_field:autocomplete') row.autocomplete = value;
  else if (propertyId === 'prop:setup_field:guide_url') row.guide_url = value;
  else if (propertyId === 'prop:setup_field:guide_steps') row.guide_steps = value;
  else return false;
  return true;
}

export function decodeAddressedParticipantsFeed(raw: unknown): AddressedParticipantInfo[] {
  if (!Array.isArray(raw)) return [];

  const participantsBySubject = new Map<string, AddressedParticipantRow>();
  const waysBySubject = new Map<string, AddressedWayToReachRow>();
  const connectionStatesBySubject = new Map<string, ConnectionStateRow>();
  const routesBySubject = new Map<string, AddressedRouteRow>();
  const setupDescriptorsBySubject = new Map<string, SetupDescriptorRow>();
  const setupFieldsBySubject = new Map<string, SetupFieldRow>();

  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const subjectId = typeof entry.subject_id === 'string' ? entry.subject_id : null;
    const propertyId = typeof entry.property_id === 'string' ? entry.property_id : null;
    if (!subjectId || !propertyId) continue;

    const value = entry.value;

    if (propertyId.startsWith('prop:addressed_participant:')) {
      const current = participantsBySubject.get(subjectId) ?? { subjectId, values: {} };
      assignParticipantField(current.values, propertyId, value);
      participantsBySubject.set(subjectId, current);
      continue;
    }

    if (propertyId.startsWith('prop:addressed_way_to_reach:')) {
      const current = waysBySubject.get(subjectId) ?? { subjectId, values: {} };
      assignWayToReachField(current.values, propertyId, value);
      waysBySubject.set(subjectId, current);
      continue;
    }

    if (propertyId.startsWith('prop:connection_state:')) {
      const current = connectionStatesBySubject.get(subjectId) ?? { subjectId, values: {} };
      assignConnectionStateField(current.values, propertyId, value);
      connectionStatesBySubject.set(subjectId, current);
      continue;
    }

    if (propertyId.startsWith('prop:addressed_route:')) {
      const current = routesBySubject.get(subjectId) ?? { subjectId, values: {} };
      assignAddressedRouteField(current.values, propertyId, value);
      routesBySubject.set(subjectId, current);
      continue;
    }

    if (propertyId.startsWith('prop:setup_descriptor:')) {
      const current = setupDescriptorsBySubject.get(subjectId) ?? { subjectId, values: {} };
      assignSetupDescriptorField(current.values, propertyId, value);
      setupDescriptorsBySubject.set(subjectId, current);
      continue;
    }

    if (propertyId.startsWith('prop:setup_field:')) {
      const current = setupFieldsBySubject.get(subjectId) ?? { subjectId, values: {} };
      assignSetupField(current.values, propertyId, value);
      setupFieldsBySubject.set(subjectId, current);
    }
  }

  const decodedConnectionStates = Array.from(connectionStatesBySubject.values())
    .map((row) => decodeConnectionState(row.values, row.subjectId))
    .filter((entry): entry is AddressedConnectionState => entry !== null);

  return Array.from(participantsBySubject.values()).map((participant) => {
    const way = resolveWayToReach(participant, waysBySubject);
    const joinedConnectionStateRefs = dedupeRefs([
      ...asStringArrayFromFields(participant.values, 'connection_state_refs', 'connectionStateRefs'),
      ...(way ? asStringArrayFromFields(way.values, 'connection_state_refs', 'connectionStateRefs') : []),
    ]);
    const joinedServiceConnectionRefs = dedupeRefs([
      ...asStringArrayFromFields(participant.values, 'service_connection_refs', 'serviceConnectionRefs'),
      ...(way ? asStringArrayFromFields(way.values, 'service_connection_refs', 'serviceConnectionRefs') : []),
    ]);
    const joinedConnectionStates = decodedConnectionStates.filter((state) => (
      (state.connectionStateRef && joinedConnectionStateRefs.includes(state.connectionStateRef))
      || (state.serviceConnectionRef && joinedServiceConnectionRefs.includes(state.serviceConnectionRef))
    ));
    return convertRowToParticipantInfo(
      participant.subjectId,
      participant.values,
      way,
      joinedConnectionStates,
      routesBySubject,
      setupDescriptorsBySubject,
      setupFieldsBySubject,
    );
  });
}

const EMPTY_MODELS: AddressedParticipantModelOption[] = [];

export function getAddressedParticipantModels(
  participants: readonly AddressedParticipantInfo[],
  participantRef: string,
): readonly AddressedParticipantModelOption[] {
  return participants.find((participant) => participant.participantRef === participantRef)?.models ?? EMPTY_MODELS;
}

export function getAddressedParticipantDefaultModelId(
  participants: readonly AddressedParticipantInfo[],
  participantRef: string,
): string | null {
  const models = getAddressedParticipantModels(participants, participantRef);
  if (models.length === 0) return null;
  return models.find((model) => model.isDefault)?.id ?? models[0]?.id ?? null;
}

// ---------------------------------------------------------------------------
// Pure participant-account + path helpers (relocated from the deleted
// run-live-chat-turn.ts when chat's AI invocation moved to ai-records-producer).
// These stay with participant reading because they resolve participant accounts.
// ---------------------------------------------------------------------------

/** Last path segment of a "/"-separated path (config dir / project path). */
export function basename(value: string): string {
  const parts = value.split('/').filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : value;
}

/** Resolve the account for a participant: prefer dir match, then id, then first. */
export function findAddressedParticipantAccount(
  participantInfo: AddressedParticipantInfo | undefined,
  preferredAccountId: string | null,
  preferredAccountDir: string | null,
): AddressedParticipantAccount | null {
  const accounts = participantInfo?.accounts ?? [];
  if (preferredAccountDir) {
    const byDir = accounts.find((account) => basename(account.configDir) === preferredAccountDir);
    if (byDir) return byDir;
  }
  if (preferredAccountId) {
    const byId = accounts.find((account) => account.id === preferredAccountId);
    if (byId) return byId;
  }
  return accounts[0] ?? null;
}
