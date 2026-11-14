export type JsonRecord = Record<string, unknown>;

export interface PublishedRecordRow {
  address?: string;
  payload?: unknown;
}

export interface SettingOptionView {
  id: string;
  label: string;
  description: string;
  iconName: string;
  selected: boolean;
  isCurrent: boolean;
}

export interface SettingActionRouteView {
  id: string;
  target: string;
  valuePath: string[];
  /**
   * The fixed base envelope the owner expects — operation, definition_id, and any
   * fixed response-control or payload fields the action declares (e.g. whether the
   * reply should include step traces / output). The opaque selected option id is
   * inserted at `valuePath` into a CLONE of this template by the send authority.
   *
   * Every routing value lives here as DATA: neither the send authority nor any
   * other consumer names `operation`, `definition_id`, or any payload flag in code.
   * Adding a fixed field (new response flag, extra header) is a record-data edit,
   * not a code change (L090). This is also why the descriptor fallback can no
   * longer be lossy — it carries the descriptor's whole `write.payload` verbatim.
   */
  payloadTemplate: JsonRecord;
}

export interface SettingPolicyView {
  descriptorAddress: string;
  heading: string;
  explanation: string;
  options: SettingOptionView[];
  currentOptionId: string | null;
  selectedOptionId: string | null;
  status: 'empty' | 'ready' | 'dirty' | 'invalid';
  statusCopy: string;
  errorCopy: string | null;
  save: {
    label: string;
    enabled: boolean;
    disabledReason: string | null;
  };
  revert: {
    label: string;
    enabled: boolean;
  };
  actionRoute: SettingActionRouteView | null;
  proofRefs: string[];
}

export interface ReadNotificationsPolicyInput {
  descriptor?: unknown;
  records?: PublishedRecordRow[];
  currentRecords?: unknown[];
  selectedOptionId?: string | null;
}

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Deep clone so a resolved payload template never aliases the source record. */
function cloneJson<T>(value: T): T {
  if (Array.isArray(value)) return value.map(cloneJson) as unknown as T;
  if (isRecord(value)) {
    const out: JsonRecord = {};
    for (const [key, nested] of Object.entries(value)) out[key] = cloneJson(nested);
    return out as unknown as T;
  }
  return value;
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

function textList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function payloadAt(records: PublishedRecordRow[] | undefined, address: string): JsonRecord | null {
  const payload = records?.find((row) => row.address === address)?.payload;
  return isRecord(payload) ? payload : null;
}

function settingDescriptors(records: PublishedRecordRow[] | undefined): Array<{ address: string; payload: JsonRecord }> {
  return (records ?? [])
    .filter((row): row is { address: string; payload: JsonRecord } => (
      typeof row.address === 'string' && isRecord(row.payload) && row.payload.kind === 'setting-control'
    ));
}

function optionId(option: JsonRecord, index: number): string {
  return text(option.id ?? option.value ?? option.key, `option:${index}`);
}

function optionViews(descriptor: JsonRecord, selectedOptionId: string | null, currentOptionId: string | null): SettingOptionView[] {
  return (Array.isArray(descriptor.options) ? descriptor.options : [])
    .filter(isRecord)
    .map((option, index) => {
      const id = optionId(option, index);
      return {
        id,
        label: text(option.label, id),
        description: text(option.description),
        iconName: text(option.icon),
        selected: selectedOptionId === id,
        isCurrent: currentOptionId === id,
      };
    });
}

function nestedValue(value: JsonRecord, valueKeys: string[]): string {
  for (const key of ['id', ...valueKeys]) {
    const found = text(value[key]);
    if (found) return found;
  }
  return '';
}

function currentValueFromRows(rows: unknown[], propertyIds: string[], valueKeys: string[]): string | null {
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const propertyId = text(row.property_id ?? row.propertyId);
    if (propertyIds.length > 0 && !propertyIds.includes(propertyId)) continue;
    const value = row.value;
    if (typeof value === 'string' && value.length > 0) return value;
    if (isRecord(value)) {
      const nested = nestedValue(value, valueKeys);
      if (nested) return nested;
    }
  }
  return null;
}

function descriptorValue(descriptor: JsonRecord): JsonRecord {
  return isRecord(descriptor.value) ? descriptor.value : {};
}

function resolveCurrentOptionId(descriptor: JsonRecord, currentRecords: unknown[]): string | null {
  const value = descriptorValue(descriptor);
  const propertyIds = textList(value.property_ids ?? value.propertyIds);
  const valueKeys = textList(value.keys);
  return currentValueFromRows(currentRecords, propertyIds, valueKeys) ?? (text(value.default, '') || null);
}

function graphRoute(records: PublishedRecordRow[] | undefined, descriptorAddress: string): SettingActionRouteView | null {
  const graph = (records ?? [])
    .map((row) => row.payload)
    .find((payload): payload is JsonRecord => isRecord(payload)
      && payload.kind === 'record-policy-action-graph'
      && Array.isArray(payload.records)
      && payload.records.some((entry) => isRecord(entry) && entry.address === descriptorAddress));

  const route = Array.isArray(graph?.action_routes) ? graph.action_routes.find(isRecord) : null;
  if (!route) return null;
  const bindings = isRecord(route.bindings) ? route.bindings : {};
  // Assemble the fixed base envelope from the route's machine-readable fields:
  // the method becomes `operation`, the bound definition id becomes `definition_id`,
  // and any declared `payload_defaults` (e.g. response-control flags) merge in as
  // DATA. The selected value is inserted at value_path later by the send authority.
  const operation = text(route.method ?? route.operation);
  const definitionId = text(bindings.definition_id ?? route.definition_id ?? route.definitionId, '');
  const payloadDefaults = isRecord(route.payload_defaults) ? route.payload_defaults : {};
  const payloadTemplate: JsonRecord = { operation };
  if (definitionId) payloadTemplate.definition_id = definitionId;
  for (const [key, value] of Object.entries(cloneJson(payloadDefaults))) payloadTemplate[key] = value;
  return {
    id: text(route.id, 'action-route'),
    target: text(route.target),
    valuePath: textList(bindings.value_path ?? route.value_path ?? route.valuePath),
    payloadTemplate,
  };
}

function descriptorRoute(descriptor: JsonRecord): SettingActionRouteView | null {
  const write = isRecord(descriptor.write) ? descriptor.write : null;
  const payload = isRecord(write?.payload) ? write.payload : {};
  if (!write) return null;
  // The descriptor's `write.payload` already IS the fixed base envelope — carry it
  // verbatim (cloned) so no declared field is dropped on the fallback path. The
  // send authority overwrites only the value at value_path.
  return {
    id: text(payload.definition_id ?? descriptor.id, 'setting-write'),
    target: text(write.target),
    valuePath: textList(write.value_path ?? write.valuePath),
    payloadTemplate: cloneJson(payload),
  };
}

function proofRefs(records: PublishedRecordRow[] | undefined, descriptorAddress: string): string[] {
  return (records ?? [])
    .filter((row) => typeof row.address === 'string' && row.address !== descriptorAddress)
    .filter((row) => isRecord(row.payload) && ['record-policy-action-graph', 'side-effect-intent-route'].includes(text(row.payload.kind)))
    .map((row) => row.address as string);
}

function statusCopy(status: SettingPolicyView['status']): string {
  switch (status) {
    case 'empty':
      return 'No choices are described yet.';
    case 'dirty':
      return 'Unsaved choice.';
    case 'invalid':
      return 'The saved choice is not described by this setting.';
    case 'ready':
    default:
      return 'Current choice is saved.';
  }
}

export function readNotificationsPolicy(input: ReadNotificationsPolicyInput): SettingPolicyView {
  const descriptors = settingDescriptors(input.records);
  const descriptorAddress = descriptors[0]?.address ?? '';
  const descriptor = isRecord(input.descriptor) ? input.descriptor : descriptors[0]?.payload ?? {};
  const heading = text(descriptor.title ?? descriptor.label, text(descriptor.id, 'Setting'));
  const explanation = text(descriptor.description);
  const currentOptionId = resolveCurrentOptionId(descriptor, input.currentRecords ?? []);
  const selectedOptionId = input.selectedOptionId ?? currentOptionId;
  const options = optionViews(descriptor, selectedOptionId, currentOptionId);
  const hasOptions = options.length > 0;
  const currentIsDeclared = currentOptionId === null || options.some((option) => option.id === currentOptionId);
  const selectedIsDeclared = selectedOptionId === null || options.some((option) => option.id === selectedOptionId);
  const dirty = currentOptionId !== selectedOptionId;
  const status: SettingPolicyView['status'] = !hasOptions
    ? 'empty'
    : !currentIsDeclared || !selectedIsDeclared
      ? 'invalid'
      : dirty
        ? 'dirty'
        : 'ready';

  return {
    descriptorAddress,
    heading,
    explanation,
    options,
    currentOptionId,
    selectedOptionId,
    status,
    statusCopy: statusCopy(status),
    errorCopy: status === 'invalid' ? statusCopy(status) : null,
    save: {
      label: 'Save',
      enabled: status === 'dirty',
      disabledReason: status === 'dirty' ? null : statusCopy(status),
    },
    revert: {
      label: 'Revert',
      enabled: dirty && currentIsDeclared,
    },
    actionRoute: graphRoute(input.records, descriptorAddress) ?? descriptorRoute(descriptor),
    proofRefs: proofRefs(input.records, descriptorAddress),
  };
}

export function readNotificationsPolicyFromBoundary(boundary: { things?: PublishedRecordRow[] }, selectedOptionId?: string | null): SettingPolicyView {
  const records = (boundary.things ?? []).map((thing) => ({
    address: thing.address,
    payload: isRecord(thing.payload) ? thing.payload : payloadAt(boundary.things, text(thing.address)),
  }));
  return readNotificationsPolicy({ records, selectedOptionId });
}
