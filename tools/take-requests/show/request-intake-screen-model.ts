import {
  readRequestIntakeSurface,
  type RequestIntakeDescriptor,
  type RequestIntakeFieldDescriptor,
  type RequestIntakeProjectionInput,
  type RequestIntakeReceipt,
  type RequestIntakeRecordInstance,
  type RequestIntakeRenderState,
  type RequestIntakeSelectedRecord,
  type RequestIntakeShape,
  type RequestIntakeSurfaceData,
} from '@/packages/request-intake/read-data/request-intake-projection';

// ---------------------------------------------------------------------------
// Translation layer (Society -> human). This is the ONLY place that turns
// projected request-intake data into human-facing view models. The .tsx
// surfaces below it are blind renderers: they receive finished strings and
// never see raw ids, payloads, kinds, or descriptor internals. The same model
// feeds the React surface and the iOS JSCore mount, so there is one screen
// contract, not two.
// ---------------------------------------------------------------------------

export type RequestIntakeLayout = 'desktop' | 'mobile';

// The seven workspaces the surface can show. This is UI navigation chrome
// (which panel is in front), NOT a domain enum — every domain concept
// (status, field kind, action, view) stays open descriptor DATA. Kept as a
// closed set only because it is app structure, exactly like CRM's
// list/board/detail composition.
export type RequestIntakeWorkspace =
  | 'inbox'
  | 'submission'
  | 'builder'
  | 'questions'
  | 'preview'
  | 'share'
  | 'follow-up';

export interface RequestIntakeScreenAction {
  id: string;
  label: string;
  helper: string;
  disabled: boolean;
  // Plain, human reason shown when the control is disabled, so a button is
  // never silently dead (L114/L118). Empty/undefined when the control is usable.
  disabledReason?: string;
  descriptor?: RequestIntakeDescriptor;
}

export interface RequestIntakeScreenView {
  id: string;
  label: string;
  selected: boolean;
  countLabel: string;
}

export interface RequestIntakeScreenColumn {
  id: string;
  label: string;
}

export interface RequestIntakeScreenCell {
  columnId: string;
  value: string;
}

export interface RequestIntakeScreenRow {
  id: string;
  title: string;
  statusLabel: string;
  sourceLabel: string;
  receivedLabel: string;
  cells: RequestIntakeScreenCell[];
  statusLabels: string[];
  selected: boolean;
  issue: string;
}

export interface RequestIntakeScreenInbox {
  columns: RequestIntakeScreenColumn[];
  rows: RequestIntakeScreenRow[];
  emptyCopy: string;
}

export interface RequestIntakeScreenValue {
  id: string;
  label: string;
  value: string;
}

export interface RequestIntakeScreenReceipt {
  id: string;
  title: string;
  summary: string;
  time: string;
  statusLabel: string;
}

export interface RequestIntakeScreenSubmission {
  id: string;
  title: string;
  subtitle: string;
  statusLabel: string;
  values: RequestIntakeScreenValue[];
  actions: RequestIntakeScreenAction[];
  receipts: RequestIntakeScreenReceipt[];
  emptyValuesCopy: string;
  emptyReceiptsCopy: string;
}

export interface RequestIntakeScreenRule {
  id: string;
  label: string;
}

export interface RequestIntakeScreenQuestion {
  id: string;
  label: string;
  valueKindLabel: string;
  requiredLabel: string;
  required: boolean;
  rules: RequestIntakeScreenRule[];
}

export interface RequestIntakeScreenForm {
  id: string;
  label: string;
  versionLabel: string;
  questions: RequestIntakeScreenQuestion[];
  emptyCopy: string;
}

export interface RequestIntakeScreenSharePolicy {
  id: string;
  label: string;
  helper: string;
}

export interface RequestIntakeScreenShare {
  policies: RequestIntakeScreenSharePolicy[];
  actions: RequestIntakeScreenAction[];
  emptyCopy: string;
}

export interface RequestIntakeScreenPreview {
  versionLabel: string;
  questions: RequestIntakeScreenQuestion[];
  actions: RequestIntakeScreenAction[];
  emptyCopy: string;
}

export interface RequestIntakeScreenModel {
  layout: RequestIntakeLayout;
  status: RequestIntakeRenderState;
  statusCopy: string;
  title: string;
  subtitle: string;
  recordCount: number;
  views: RequestIntakeScreenView[];
  globalActions: RequestIntakeScreenAction[];
  inbox: RequestIntakeScreenInbox;
  selected: RequestIntakeScreenSubmission | null;
  form: RequestIntakeScreenForm | null;
  questionSettings: RequestIntakeScreenQuestion[];
  preview: RequestIntakeScreenPreview;
  share: RequestIntakeScreenShare;
  followUp: RequestIntakeScreenAction[];
  issueCopy: string;
}

const STATUS_COPY: Record<RequestIntakeRenderState, string> = {
  empty: 'No requests yet. Share your intake form or add the first request to get started.',
  sparse: 'A few requests are waiting on you.',
  dense: 'Requests are grouped so you can scan them quickly.',
  loading: 'Loading requests...',
  error: 'Requests did not load. Nothing was changed.',
  offline: 'Saved requests are visible. New changes wait until the connection returns.',
  conflict: 'One saved change needs review before it can continue.',
};

const TITLE = 'Requests';
const SUBTITLE = 'Receive requests, shape your intake form, and act on what comes in.';

// ---------------------------------------------------------------------------
// Total functions: every branch returns a finished human string. Null,
// objects, and raw references can never reach the view.
// ---------------------------------------------------------------------------

function displayText(value: unknown, fallback = ''): string {
  if (typeof value === 'string' && value.trim().length > 0) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return fallback;
}

function valueText(value: unknown): string {
  if (value == null || value === '') return 'Not set';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return displayText(value, 'Not set');
  }
  if (Array.isArray(value)) return value.length === 1 ? '1 value' : `${value.length} values`;
  return 'Available';
}

// Turns an open Society key (e.g. "short-text", "long_text") into a readable
// label. Pure generic transform — no per-kind branch, so a new value kind
// needs zero code (L090).
function humanize(value: string | undefined, fallback: string): string {
  const trimmed = (value ?? '').trim();
  if (trimmed.length === 0) return fallback;
  const words = trimmed
    .replace(/[:_-]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return fallback;
  return words
    .map((word, index) => (index === 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word))
    .join(' ');
}

// Status label comes from the state descriptors (DATA), never from the raw
// state id. Unknown / missing -> a neutral human label, so an internal id like
// "state:ready-for-review" can never leak into the product UI.
function statusLabel(
  stateId: string | undefined,
  statesById: Map<string, RequestIntakeDescriptor>,
): string {
  if (!stateId) return 'New';
  return statesById.get(stateId)?.label ?? 'Open';
}

function copyValue(descriptor: RequestIntakeDescriptor, key: string, fallback: string): string {
  const entry = descriptor.copy.find((row) => row.key === key);
  if (!entry) return fallback;
  return displayText(entry.value, fallback);
}

function actionHelper(descriptor: RequestIntakeDescriptor): string {
  return copyValue(descriptor, 'helper', 'Owner-backed action');
}

function descriptorAction(descriptor: RequestIntakeDescriptor): RequestIntakeScreenAction {
  return {
    id: descriptor.id,
    label: descriptor.label,
    helper: actionHelper(descriptor),
    disabled: false,
    descriptor,
  };
}

// Maps a configured descriptor list to action rows; if none are configured the
// surface still shows one disabled row that explains why, so the panel is never
// an empty dead zone.
function actionRows(
  descriptors: RequestIntakeDescriptor[],
  emptyId: string,
  emptyLabel: string,
  emptyHelper: string,
  emptyReason: string,
): RequestIntakeScreenAction[] {
  if (descriptors.length > 0) return descriptors.map(descriptorAction);
  return [{
    id: emptyId,
    label: emptyLabel,
    helper: emptyHelper,
    disabled: true,
    disabledReason: emptyReason,
  }];
}

function question(field: RequestIntakeFieldDescriptor): RequestIntakeScreenQuestion {
  return {
    id: field.id,
    label: field.label,
    valueKindLabel: humanize(field.valueKind, 'Text'),
    requiredLabel: field.required ? 'Required' : 'Optional',
    required: field.required === true,
    rules: field.rules.map((rule) => ({ id: rule.id, label: rule.label })),
  };
}

function viewRow(view: RequestIntakeDescriptor, selectedId: string | null): RequestIntakeScreenView {
  return {
    id: view.id,
    label: view.label,
    selected: selectedId === view.id,
    countLabel: typeof view.count === 'number' ? String(view.count) : '',
  };
}

function columns(shape: RequestIntakeShape | null): RequestIntakeScreenColumn[] {
  if (!shape) return [];
  return shape.fields.map((field) => ({ id: field.id, label: field.label }));
}

function rowStatusLabels(record: RequestIntakeRecordInstance, statusText: string): string[] {
  return [
    statusText,
    record.sourceLabel ?? '',
    record.issue ? 'Needs review' : '',
  ].filter(Boolean);
}

function recordRow(
  record: RequestIntakeRecordInstance,
  cols: RequestIntakeScreenColumn[],
  statesById: Map<string, RequestIntakeDescriptor>,
  selectedId: string | null,
): RequestIntakeScreenRow {
  const valueByField = new Map(record.values.map((value) => [value.fieldId, value.valueText]));
  const statusText = statusLabel(record.stateId, statesById);
  return {
    id: record.id,
    title: record.title,
    statusLabel: statusText,
    sourceLabel: record.sourceLabel || 'Direct',
    receivedLabel: record.receivedAt || 'No date set',
    cells: cols.map((column) => ({
      columnId: column.id,
      value: valueByField.get(column.id) ?? 'Not set',
    })),
    statusLabels: rowStatusLabels(record, statusText),
    selected: selectedId === record.id,
    issue: record.issue || '',
  };
}

function submissionReceipt(receipt: RequestIntakeReceipt): RequestIntakeScreenReceipt {
  return {
    id: receipt.ref,
    title: receipt.title,
    summary: receipt.summary || 'Linked activity',
    time: receipt.time || 'No time set',
    statusLabel: receipt.state ? humanize(receipt.state, 'Saved') : 'Saved',
  };
}

function submissionModel(
  selected: RequestIntakeSelectedRecord | null,
  statesById: Map<string, RequestIntakeDescriptor>,
): RequestIntakeScreenSubmission | null {
  if (!selected) return null;
  const statusText = statusLabel(selected.stateId, statesById);
  return {
    id: selected.id,
    title: selected.title,
    subtitle: selected.sourceLabel || 'Direct request',
    statusLabel: statusText,
    values: selected.values.map((value) => ({
      id: value.fieldId,
      label: value.label,
      value: value.valueText,
    })),
    actions: actionRows(
      selected.actions,
      'add-next-action',
      'Add next action',
      'Set up what owners can do with this request.',
      'No next step is set up for this request yet.',
    ),
    receipts: selected.linkedReceipts.map(submissionReceipt),
    emptyValuesCopy: 'This request has no answers yet.',
    emptyReceiptsCopy: 'No linked activity yet.',
  };
}

function formModel(shape: RequestIntakeShape | null): RequestIntakeScreenForm | null {
  if (!shape) return null;
  return {
    id: shape.id,
    label: shape.label,
    versionLabel: shape.versionRef ? humanize(shape.versionRef, 'Draft') : 'Draft',
    questions: shape.fields.map(question),
    emptyCopy: 'No questions yet. Add the first question people will answer.',
  };
}

export function createRequestIntakeScreenModel(
  input: RequestIntakeProjectionInput | RequestIntakeSurfaceData,
  options: { layout?: RequestIntakeLayout } = {},
): RequestIntakeScreenModel {
  const surface = 'shapes' in input && 'selectedRecord' in input
    ? input as RequestIntakeSurfaceData
    : readRequestIntakeSurface(input as RequestIntakeProjectionInput);

  const statesById = new Map(surface.states.map((entry) => [entry.id, entry]));
  const selectedRecordId = surface.selectedRecord?.id ?? null;
  const selectedViewId = surface.views.find((view) => view.selected)?.id
    ?? surface.views[0]?.id
    ?? null;
  const shape = surface.selectedShape;
  const cols = columns(shape);
  const rows = surface.records.map((record) => recordRow(record, cols, statesById, selectedRecordId));

  const shareActions = shape?.actions ?? surface.actions;
  const sharePolicies = shape?.sharePolicies ?? [];

  return {
    layout: options.layout ?? 'desktop',
    status: surface.status,
    statusCopy: STATUS_COPY[surface.status],
    title: TITLE,
    subtitle: SUBTITLE,
    recordCount: rows.length,
    views: surface.views.map((view) => viewRow(view, selectedViewId)),
    globalActions: actionRows(
      surface.actions,
      'add-request',
      'Add request',
      'Add a request to your inbox.',
      'No request action is set up yet.',
    ),
    inbox: {
      columns: cols,
      rows,
      emptyCopy: 'No requests have come in yet.',
    },
    selected: submissionModel(surface.selectedRecord, statesById),
    form: formModel(shape),
    questionSettings: (shape?.fields ?? []).map(question),
    preview: {
      versionLabel: shape?.versionRef ? humanize(shape.versionRef, 'Draft') : 'Draft',
      questions: (shape?.fields ?? []).map(question),
      actions: actionRows(
        shape?.actions ?? surface.actions,
        'publish-form',
        'Publish form',
        'Make this form available to share.',
        'No publish action is set up yet.',
      ),
      emptyCopy: 'Add questions before publishing this form.',
    },
    share: {
      policies: sharePolicies.map((policy) => ({
        id: policy.id,
        label: policy.label,
        helper: copyValue(policy, 'helper', 'Controls who can send this request.'),
      })),
      actions: actionRows(
        shareActions,
        'share-form',
        'Share form',
        'Share your intake form to start receiving requests.',
        'No sharing action is set up yet.',
      ),
      emptyCopy: 'No sharing rules yet. Add one to control who can send a request.',
    },
    followUp: actionRows(
      surface.selectedRecord?.actions ?? [],
      'add-follow-up',
      'Add follow-up',
      'Set up the next step for this request.',
      'No follow-up step is set up for this request yet.',
    ),
    issueCopy: surface.issues.filter(Boolean).join(' '),
  };
}
