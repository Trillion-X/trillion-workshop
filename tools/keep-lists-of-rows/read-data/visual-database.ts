//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Decode arbitrary addressed record feeds into a generic board model, and own
// the bidirectional field contract: every field descriptor carries read paths,
// a write path, a value shape, a value domain, and capability flags. Editing,
// sorting, grouping, filtering, ordering, and tree projection all DERIVE from
// this one contract.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. No task, idea, project-folder, or fixed state ontology.
// 2. Field meaning comes from descriptor paths, not imported owner types.
// 3. View kinds are strings; lanes are data; unknown lane values are preserved
//    for EVERY choice-shaped field, never dropped.
// 4. Roles are OPEN strings (structural bindings) — preserved, never rejected.
// 5. Value shapes derive from JSON physics; unknown shapes degrade, never error.
// 6. Fields with no descriptor are DISCOVERED from observed payload keys —
//    every field on every record is editable/sortable/groupable/filterable
//    by default (capability flags default true).
// 7. This decoder never mutates state.
//
// =============================================================================

/** One enumerated value of a field's domain. Lanes ARE a domain — the view's
 *  `lanes` array is the view-local domain override of the grouping field. */
export interface VisualDatabaseFieldDomainValue {
  id: string;
  label: string;
  /** Open semantic signal used for behavior and as a legacy color fallback. */
  tone?: string;
  /** Exact data-owned identity color. Every visual marker resolves this first. */
  color?: string;
  /** When true, surfaces may show this option as active (e.g. a pulsing status
   *  dot). A data-owned signal: the option declares it; absent means static. */
  pulse?: boolean;
  order: number;
  /** Durable address of the source record when this value was derived from a
   *  feed record (`domain.fromRecords`) — lets data-defined actions carry the
   *  reference without the board knowing what the record is. */
  ref?: string;
  /** Owner-fed rows projected from the source record. Roles are display hints,
   *  never worker/status enums. */
  details?: readonly VisualDatabaseFieldDomainDetail[];
}

/** A lane is one domain value of the grouping field. Same shape, one truth. */
export type VisualDatabaseLaneDescriptor = VisualDatabaseFieldDomainValue;

export interface VisualDatabaseFieldDomainDetailDescriptor {
  id: string;
  label: string;
  role?: string;
  paths: readonly (readonly string[])[];
}

export interface VisualDatabaseFieldDomainDetail {
  id: string;
  label: string;
  value: string;
  role?: string;
  ref?: string;
}

export interface VisualDatabaseFieldDomain {
  /** Inline enumerated values (the generalization of view lanes). */
  values?: readonly VisualDatabaseFieldDomainValue[];
  /** Derive values from distinct observed values of another descriptor id. */
  fromField?: string;
  /** Derive values from another addressed data record (decoded as values[]). */
  fromAddress?: string;
  /** Derive values from feed RECORDS passing these filters — each matching
   *  record becomes one option (id = its durable address, label = its title,
   *  ref = its address). The filters are data; the board never knows what
   *  kind of record it is offering. */
  fromRecords?: readonly VisualDatabaseViewFilter[];
  /** Optional detail projection rows for each `fromRecords` option. */
  details?: readonly VisualDatabaseFieldDomainDetailDescriptor[];
  /** Humans may type values outside the derived set (free-text entries ride
   *  the same multi-value field — an option list is a suggestion, not a cap). */
  open?: boolean;
}

export interface VisualDatabaseFieldDescriptor {
  id: string;
  label: string;
  /** STRUCTURAL BINDING (open string, preserved verbatim — never rejected).
   *  Bindings consumed by current renderers: 'id' | 'title' | 'body' | 'kind'
   *  | 'group' | 'lane' | 'date' | 'sort' | 'badge' | 'link'. Unknown bindings
   *  flow through untouched for future renderers. */
  role: string;
  /** Read paths, first match wins. */
  paths: readonly (readonly string[])[];
  /** Write path. Default: first `paths` entry whose head is 'payload',
   *  else ['payload', ...paths[0]]. */
  writePath?: readonly string[];
  /** Value shape override. When absent, derived from the value (deriveShape). */
  shape?: string;
  domain?: VisualDatabaseFieldDomain;
  /** Capability flags — ALL default TRUE (on by default). */
  sortable?: boolean;
  groupable?: boolean;
  filterable?: boolean;
  editable?: boolean;
  /** Label for records with no value when this field is the grouping axis. */
  emptyLabel?: string;
  /** Conditional visibility (forms): show this field only when another field's
   *  current value is one of `equals`. Absent = always visible. A data-owned
   *  gate — the surface never branches on field ids to decide visibility. */
  visibleWhen?: VisualDatabaseFieldVisibleWhen;
  /** Derived-value source: when present this field's value is resolved by
   *  dispatching `derive.target`, not typed by a human. See VisualDatabaseFieldDerive. */
  derive?: VisualDatabaseFieldDerive;
  /** Source template used only when a cell has no explicit source. */
  defaultExpression?: VisualDatabaseValueExpression;
  /** Open addressed evaluator choices supplied by data; surfaces must never
   * manufacture a closed source-kind list. */
  evaluatorDescriptorRefs?: readonly VisualDatabaseEvaluatorDescriptorRef[];
  /** Fail-closed policy for a field-carried placeable-surface intent. */
  surfaceAction?: VisualDatabaseFieldSurfaceAction;
  /** Whether this descriptor came from explicit data or key discovery. */
  source?: 'declared' | 'discovered';
}

/** Structural permit data only: Visual Database names no intent payload field,
 * so any nonempty JSON object remains an open policy entry. */
export type VisualDatabaseSurfaceIntentAllowEntry = Readonly<Record<string, unknown>>;

export interface VisualDatabaseFieldSurfaceAction {
  /** Every entry must structurally match at least one intent field. */
  allowList: readonly VisualDatabaseSurfaceIntentAllowEntry[];
  /** Optional owner-configured intent for a record-independent card action. */
  payload?: unknown;
  label?: string;
  detail?: string;
  unavailableMessage?: string;
}

/** The generic derived-value seam: a field whose value is computed by an
 *  addressed capability instead of stored bytes. The discriminant (formula vs
 *  AI vs relation vs anything invented later) is the TARGET ADDRESS — data,
 *  never a code branch. `request` is an opaque template the resolver forwards
 *  verbatim with a `context` map merged in; `contextFromFields` names the
 *  descriptor ids whose values feed that context (stored OR other derived
 *  fields — resolution is a dependency fold). */
export interface VisualDatabaseFieldDerive {
  /** Envelope target the resolver dispatches to (e.g. a slot or action address). */
  target: string;
  /** Opaque request template forwarded to the target with `context` merged in. */
  request?: Readonly<Record<string, unknown>>;
  /** Path into the target's decoded reply where the value lives (e.g.
   *  ["result"] for a binding evaluation). Absent = the whole reply. DATA —
   *  the resolver never sniffs reply shapes per target. */
  resultPath?: readonly string[];
  /** Descriptor ids whose current values populate the request context. */
  contextFromFields: readonly string[];
  /** Payload path where the resolved value lands in the local model (and is
   *  persisted when `persist` is true). Default: the descriptor's write path. */
  cachePath?: readonly string[];
  /** Persist resolved values back to the record (durable, auditable results —
   *  the AI-column law). Default false: display-only resolution. */
  persist?: boolean;
}

/** A durable identity for one value position. Record and field addresses stay
 * explicit so a dependency can cross rows and tables without encoding either
 * assumption in the resolver. */
export interface VisualDatabaseCellRef {
  recordRef: string;
  fieldRef: string;
}

/** Dependency-edge metadata is deliberately distinct from source-cell
 * identity. `contextKey` is the evaluator binding key and never participates
 * in `cellRefKey` or any addressed-value identity. */
export interface VisualDatabaseDependencyRef extends VisualDatabaseCellRef {
  contextKey?: string;
}

/** Open evaluator configuration. The evaluator's meaning remains in its
 * addressed descriptor; Visual Database only preserves this reference. */
export interface VisualDatabaseEvaluatorDescriptorRef {
  ref: string;
  label?: string;
  revision?: string;
}

export type ExpressionRequestSemanticKey =
  | 'source'
  | 'cursor_offset_utf16'
  | 'request_token'
  | 'source_revision'
  | 'catalog_revision'
  | 'registry_revision'
  | 'expected_policy_revision'
  | 'variables'
  | 'legacy_request';

export type ExpressionReplySemanticKey =
  | 'operation'
  | 'request_token'
  | 'source_revision'
  | 'catalog_revision'
  | 'registry_revision'
  | 'policy_revision'
  | 'source'
  | 'canonical_source'
  | 'completion'
  | 'static_dependencies'
  | 'diagnostics'
  | 'functions'
  | 'evaluation_result'
  | 'evaluation_readset'
  | 'legacy_projection';

export type ExpressionOwnerOperation = 'analyze' | 'evaluate' | 'capabilities' | 'project_source';

export interface ExpressionEntryAction {
  id: string;
  label: string;
  /** Open interaction trigger supplied by DATA, for example `action`, `key`,
   * `pointer`, or a future input mechanism. */
  trigger: string;
}

export interface VisualDatabaseExpressionSelectionPolicy {
  serialization: 'explicit-list';
  separator: string;
  deduplicate: boolean;
}

export interface ExpressionOwnerOperationDescriptor {
  requestTemplate: Readonly<Record<string, unknown>>;
  requiredRequestKeys: readonly ExpressionRequestSemanticKey[];
  requiredReplyKeys: readonly ExpressionReplySemanticKey[];
}

export type VisualDatabaseExpressionRequestPaths = Readonly<
  Record<ExpressionRequestSemanticKey, readonly string[]>
>;

export type VisualDatabaseExpressionReplyPaths = Readonly<
  Record<ExpressionReplySemanticKey, readonly string[]>
>;

export interface VisualDatabaseExpressionAuthoringDescriptor {
  /** Version of Visual Database's self-describing authoring contract. This is
   * intentionally independent from the expression owner's wire protocol. */
  schemaVersion: 2;
  protocolVersion: 1;
  revision: string;
  editorRef: string;
  referenceProviderRef: string;
  sourceMode: 'expression';
  sourcePrefix: string;
  interactionPolicy: { idleMs: number; timeoutMs: number };
  entryActions: readonly ExpressionEntryAction[];
  selectionPolicy: VisualDatabaseExpressionSelectionPolicy;
  operations: {
    analyze: ExpressionOwnerOperationDescriptor;
    evaluate: ExpressionOwnerOperationDescriptor;
    capabilities: ExpressionOwnerOperationDescriptor;
    projectSource: ExpressionOwnerOperationDescriptor;
  };
  requestPaths: VisualDatabaseExpressionRequestPaths;
  replyPaths: VisualDatabaseExpressionReplyPaths;
  diagnosticLabels: Readonly<Record<string, string>>;
  explanationSections: readonly string[];
  stateLabels: Readonly<Record<string, string>>;
  readOnlyBehavior: 'inspect';
}

export interface VisualDatabaseEvaluatorDescriptor extends VisualDatabaseEvaluatorDescriptorRef {
  target: string;
  request?: Readonly<Record<string, unknown>>;
  resultPath?: readonly string[];
  /** Generic dependency-context insertion path. Missing preserves the legacy
   * top-level `context` member. */
  contextPath?: readonly string[];
  dependencySelector?: Readonly<Record<string, unknown>>;
  authoring?: VisualDatabaseExpressionAuthoringDescriptor;
}

const EXPRESSION_REQUEST_KEYS: readonly ExpressionRequestSemanticKey[] = [
  'source',
  'cursor_offset_utf16',
  'request_token',
  'source_revision',
  'catalog_revision',
  'registry_revision',
  'expected_policy_revision',
  'variables',
  'legacy_request',
];

const EXPRESSION_REPLY_KEYS: readonly ExpressionReplySemanticKey[] = [
  'operation',
  'request_token',
  'source_revision',
  'catalog_revision',
  'registry_revision',
  'policy_revision',
  'source',
  'canonical_source',
  'completion',
  'static_dependencies',
  'diagnostics',
  'functions',
  'evaluation_result',
  'evaluation_readset',
  'legacy_projection',
];

const OPERATION_REQUIREMENTS: Readonly<Record<ExpressionOwnerOperation, {
  request: readonly ExpressionRequestSemanticKey[];
  reply: readonly ExpressionReplySemanticKey[];
}>> = {
  analyze: {
    request: ['source', 'cursor_offset_utf16', 'request_token', 'source_revision', 'catalog_revision', 'registry_revision', 'expected_policy_revision', 'variables'],
    reply: ['operation', 'request_token', 'source_revision', 'catalog_revision', 'registry_revision', 'policy_revision', 'canonical_source', 'completion', 'static_dependencies', 'diagnostics'],
  },
  evaluate: {
    request: ['source', 'cursor_offset_utf16', 'request_token', 'source_revision', 'catalog_revision', 'registry_revision', 'expected_policy_revision', 'variables'],
    reply: ['operation', 'request_token', 'source_revision', 'catalog_revision', 'registry_revision', 'policy_revision', 'canonical_source', 'static_dependencies', 'diagnostics', 'evaluation_result', 'evaluation_readset'],
  },
  capabilities: {
    request: ['request_token', 'source_revision', 'catalog_revision', 'registry_revision', 'expected_policy_revision'],
    reply: ['operation', 'request_token', 'source_revision', 'catalog_revision', 'registry_revision', 'policy_revision', 'functions'],
  },
  project_source: {
    request: ['request_token', 'source_revision', 'catalog_revision', 'registry_revision', 'expected_policy_revision', 'legacy_request'],
    reply: ['operation', 'request_token', 'source_revision', 'catalog_revision', 'registry_revision', 'policy_revision', 'legacy_projection'],
  },
};

const PATH_PROTOTYPE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const EXPRESSION_EDITOR_REFS = new Set(['ui::expression-composer']);
const EXPRESSION_REFERENCE_PROVIDER_REFS = new Set(['visual-database::visible-cells']);

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function readStrictPath(value: unknown): readonly string[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) return null;
  if (!value.every((segment) => (
    typeof segment === 'string'
    && segment.length > 0
    && segment.trim() === segment
    && !PATH_PROTOTYPE_KEYS.has(segment)
  ))) return null;
  return value as readonly string[];
}

function pathIsPrefix(left: readonly string[], right: readonly string[]): boolean {
  return left.length <= right.length && left.every((segment, index) => segment === right[index]);
}

function pathsAreIndependent(paths: readonly (readonly string[])[]): boolean {
  return paths.every((path, index) => paths.every((other, otherIndex) => (
    index === otherIndex || (!pathIsPrefix(path, other) && !pathIsPrefix(other, path))
  )));
}

function readExactSemanticKeys<K extends string>(
  value: unknown,
  allowed: readonly K[],
  expected: readonly K[],
): readonly K[] | null {
  if (!Array.isArray(value) || value.some((key) => typeof key !== 'string' || !allowed.includes(key as K))) return null;
  const keys = value as K[];
  if (new Set(keys).size !== keys.length || keys.length !== expected.length) return null;
  return expected.every((key) => keys.includes(key)) ? keys : null;
}

function isJsonValue(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
    return typeof value !== 'number' || Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) return false;
    seen.add(value);
    const valid = value.every((entry) => isJsonValue(entry, seen));
    seen.delete(value);
    return valid;
  }
  if (!isRecord(value) || seen.has(value)) return false;
  seen.add(value);
  const valid = Object.entries(value).every(([key, entry]) => (
    !PATH_PROTOTYPE_KEYS.has(key) && entry !== undefined && isJsonValue(entry, seen)
  ));
  seen.delete(value);
  return valid;
}

function readOperationDescriptor(
  value: unknown,
  operation: ExpressionOwnerOperation,
): ExpressionOwnerOperationDescriptor | null {
  if (!isRecord(value) || !exactKeys(value, ['request_template', 'required_request_keys', 'required_reply_keys'])) return null;
  if (!isRecord(value.request_template) || Object.keys(value.request_template).length === 0 || !isJsonValue(value.request_template)) return null;
  const requirement = OPERATION_REQUIREMENTS[operation];
  const requiredRequestKeys = readExactSemanticKeys(value.required_request_keys, EXPRESSION_REQUEST_KEYS, requirement.request);
  const requiredReplyKeys = readExactSemanticKeys(value.required_reply_keys, EXPRESSION_REPLY_KEYS, requirement.reply);
  return requiredRequestKeys && requiredReplyKeys
    ? { requestTemplate: value.request_template, requiredRequestKeys, requiredReplyKeys }
    : null;
}

function readStringMap(value: unknown): Readonly<Record<string, string>> | null {
  if (!isRecord(value) || Object.keys(value).length === 0) return null;
  const entries = Object.entries(value);
  return entries.every(([key, label]) => key.length > 0 && typeof label === 'string' && label.trim().length > 0)
    ? Object.fromEntries(entries) as Readonly<Record<string, string>>
    : null;
}

function decodeSemanticPaths<K extends string>(
  value: unknown,
  keys: readonly K[],
): Readonly<Record<K, readonly string[]>> | null {
  if (!isRecord(value) || !exactKeys(value, keys)) return null;
  const entries = keys.map((key) => [key, readStrictPath(value[key])] as const);
  if (entries.some(([, path]) => path === null)) return null;
  const paths = entries.map(([, path]) => path!);
  return pathsAreIndependent(paths)
    ? Object.fromEntries(entries) as Readonly<Record<K, readonly string[]>>
    : null;
}

/** The one authoritative version-2 authoring decoder. It rejects malformed
 * descriptors as a whole; there is no abbreviated or permissive v2 dialect. */
export function decodeVisualDatabaseExpressionAuthoringDescriptor(
  value: unknown,
  contextPath?: readonly string[],
): VisualDatabaseExpressionAuthoringDescriptor | null {
  const keys = [
    'schema_version',
    'protocol_version',
    'revision',
    'editor_ref',
    'reference_provider_ref',
    'source_mode',
    'source_prefix',
    'interaction_policy',
    'entry_actions',
    'selection_policy',
    'operations',
    'request_paths',
    'reply_paths',
    'diagnostic_labels',
    'explanation_sections',
    'state_labels',
    'read_only_behavior',
  ] as const;
  if (!isRecord(value) || !exactKeys(value, keys)) return null;
  if (value.schema_version !== 2 || value.protocol_version !== 1
    || value.source_mode !== 'expression' || value.read_only_behavior !== 'inspect') return null;
  const revision = readString(value.revision);
  const editorRef = readString(value.editor_ref);
  const referenceProviderRef = readString(value.reference_provider_ref);
  const sourcePrefix = typeof value.source_prefix === 'string' && value.source_prefix.length > 0 ? value.source_prefix : null;
  if (!revision || !editorRef || !EXPRESSION_EDITOR_REFS.has(editorRef)
    || !referenceProviderRef || !EXPRESSION_REFERENCE_PROVIDER_REFS.has(referenceProviderRef) || !sourcePrefix) return null;

  const interaction = isRecord(value.interaction_policy) && exactKeys(value.interaction_policy, ['idle_ms', 'timeout_ms'])
    ? value.interaction_policy
    : null;
  const idleMs = interaction?.idle_ms;
  const timeoutMs = interaction?.timeout_ms;
  if (!Number.isInteger(idleMs) || (idleMs as number) < 0 || !Number.isInteger(timeoutMs) || (timeoutMs as number) <= 0) return null;

  const entryActions = Array.isArray(value.entry_actions)
    ? value.entry_actions.map((entry) => {
      if (!isRecord(entry) || !exactKeys(entry, ['id', 'label', 'trigger'])) return null;
      const id = readString(entry.id);
      const label = readString(entry.label);
      const trigger = readString(entry.trigger);
      return id && label && trigger ? { id, label, trigger } : null;
    })
    : [];
  if (entryActions.length === 0 || entryActions.some((entry) => entry === null)
    || new Set(entryActions.map((entry) => entry!.id)).size !== entryActions.length) return null;

  const selection = isRecord(value.selection_policy) && exactKeys(value.selection_policy, ['serialization', 'separator', 'deduplicate'])
    ? value.selection_policy
    : null;
  if (!selection || selection.serialization !== 'explicit-list'
    || typeof selection.separator !== 'string' || selection.separator.length === 0
    || typeof selection.deduplicate !== 'boolean') return null;

  if (!isRecord(value.operations) || !exactKeys(value.operations, ['analyze', 'evaluate', 'capabilities', 'project_source'])) return null;
  const analyze = readOperationDescriptor(value.operations.analyze, 'analyze');
  const evaluate = readOperationDescriptor(value.operations.evaluate, 'evaluate');
  const capabilities = readOperationDescriptor(value.operations.capabilities, 'capabilities');
  const projectSource = readOperationDescriptor(value.operations.project_source, 'project_source');
  if (!analyze || !evaluate || !capabilities || !projectSource) return null;
  const templates = [analyze, evaluate, capabilities, projectSource]
    .map((operation) => JSON.stringify(operation.requestTemplate));
  if (new Set(templates).size !== templates.length) return null;

  const requestPaths = decodeSemanticPaths(value.request_paths, EXPRESSION_REQUEST_KEYS);
  const replyPaths = decodeSemanticPaths(value.reply_paths, EXPRESSION_REPLY_KEYS);
  if (!requestPaths || !replyPaths) return null;
  if (contextPath && (
    pathIsPrefix(contextPath, requestPaths.source)
    || pathIsPrefix(requestPaths.source, contextPath)
  )) return null;

  const diagnosticLabels = readStringMap(value.diagnostic_labels);
  const stateLabels = readStringMap(value.state_labels);
  const explanationSections = Array.isArray(value.explanation_sections)
    ? value.explanation_sections.map(readString)
    : [];
  if (!diagnosticLabels || !stateLabels || explanationSections.length === 0
    || explanationSections.some((section) => section === null)) return null;

  return {
    schemaVersion: 2,
    protocolVersion: 1,
    revision,
    editorRef,
    referenceProviderRef,
    sourceMode: 'expression',
    sourcePrefix,
    interactionPolicy: { idleMs: idleMs as number, timeoutMs: timeoutMs as number },
    entryActions: entryActions as ExpressionEntryAction[],
    selectionPolicy: {
      serialization: 'explicit-list',
      separator: selection.separator,
      deduplicate: selection.deduplicate,
    },
    operations: { analyze, evaluate, capabilities, projectSource },
    requestPaths,
    replyPaths,
    diagnosticLabels,
    explanationSections: explanationSections as string[],
    stateLabels,
    readOnlyBehavior: 'inspect',
  };
}

export function decodeVisualDatabaseEvaluatorDescriptors(value: unknown): readonly VisualDatabaseEvaluatorDescriptor[] {
  const source = isRecord(value) && Array.isArray(value.descriptors) ? value.descriptors : Array.isArray(value) ? value : [];
  const version = isRecord(value) && typeof value.version === 'number' ? value.version : 1;
  if (version !== 1 && version !== 2) return [];
  const decoded = source.map((entry) => {
    if (!isRecord(entry)) return null;
    if (version === 2 && !exactKeys(entry, [
      'ref',
      'revision',
      'label',
      'target',
      ...(Object.prototype.hasOwnProperty.call(entry, 'request') ? ['request'] : []),
      ...(Object.prototype.hasOwnProperty.call(entry, 'result_selector') ? ['result_selector'] : []),
      ...(Object.prototype.hasOwnProperty.call(entry, 'context_path') ? ['context_path'] : []),
      ...(Object.prototype.hasOwnProperty.call(entry, 'dependency_selector') ? ['dependency_selector'] : []),
      ...(Object.prototype.hasOwnProperty.call(entry, 'authoring') ? ['authoring'] : []),
    ])) return null;
    const ref = readString(entry.ref ?? entry.address ?? entry.id);
    const target = readString(entry.target);
    if (!ref || !target) return null;
    const label = readString(entry.label);
    const revision = readString(entry.revision);
    if (version === 2 && (!label || !revision)) return null;
    const contextPath = version === 2
      ? readStrictPath(entry.context_path)
      : readStrictPath(entry.contextPath ?? entry.context_path);
    if ((version === 2 && Object.prototype.hasOwnProperty.call(entry, 'context_path') && !contextPath)
      || (version === 1 && (entry.contextPath ?? entry.context_path) !== undefined && !contextPath)) return null;
    const authoring = version === 2 && entry.authoring !== undefined
      ? decodeVisualDatabaseExpressionAuthoringDescriptor(entry.authoring, contextPath ?? undefined)
      : null;
    if (version === 2 && entry.authoring !== undefined && !authoring) return null;
    const rawResultPath = version === 2
      ? entry.result_selector
      : entry.resultPath ?? entry.result_selector ?? entry.result_path;
    const resultPath = version === 2 ? readStrictPath(rawResultPath) : readPath(rawResultPath);
    if (rawResultPath !== undefined && !resultPath) return null;
    if (entry.request !== undefined && (!isRecord(entry.request) || !isJsonValue(entry.request))) return null;
    const rawDependencySelector = version === 2 ? entry.dependency_selector : entry.dependencySelector ?? entry.dependency_selector;
    if (rawDependencySelector !== undefined && !isRecord(rawDependencySelector)) return null;
    return { ref, target, label: label ?? undefined, revision: revision ?? undefined,
      request: isRecord(entry.request) ? entry.request : undefined,
      resultPath: resultPath ?? undefined,
      contextPath: contextPath ?? undefined,
      dependencySelector: isRecord(rawDependencySelector) ? rawDependencySelector : undefined,
      ...(authoring ? { authoring } : {}),
    };
  });
  if (decoded.some((entry) => entry === null)) return [];
  return decoded as readonly VisualDatabaseEvaluatorDescriptor[];
}

/** `dependencyRefs` are canonical cell edges. `dependencySelector` is the
 * field-default template that T7 materializes for a particular cell. */
export interface VisualDatabaseValueDerive {
  target: string;
  evaluatorRef?: string;
  request?: Readonly<Record<string, unknown>>;
  resultPath?: readonly string[];
  dependencyRefs?: readonly VisualDatabaseDependencyRef[];
  dependencySelector?: Readonly<Record<string, unknown>>;
  /** Optional projection policy preserved when a legacy field derive becomes a
   * default cell-expression template. */
  cachePath?: readonly string[];
  persist?: boolean;
}

/** Exactly one of `literal` or `derive` is a cell's source. Cache and
 * provenance are independently addressed projections, outside this object. */
export interface VisualDatabaseValueExpression {
  literal?: unknown;
  derive?: VisualDatabaseValueDerive;
}

export interface VisualDatabaseFieldVisibleWhen {
  /** The id of the field whose value gates this one. */
  field: string;
  /** This field shows when the gating field's value matches ANY entry. */
  equals: readonly string[];
}

export interface VisualDatabaseViewFilter {
  /** Descriptor id (or structural binding name) the filter matches against. */
  field: string;
  /** Record passes when its field value matches ANY entry (case-insensitive). */
  equals: readonly string[];
  /** Record fails when its field value matches ANY entry (case-insensitive). */
  exclude: readonly string[];
}

/** An opaque per-element property bag — the SSOT for one grid element's adjusted
 *  aspects (border-radius, divider line, label size, alignment, a validation
 *  rule, a conditional-format rule, or ANY future aspect). The engine never
 *  enumerates the keys; a `GridPropertyDescriptor` DATA row declares each key and
 *  the cascade resolver + capability-mapped applier interpret it (L090). */
export type VisualDatabaseElementStyle = Readonly<Record<string, unknown>>;

/** Per-view column presentation state — pure Society data persisted on the
 *  views record. Field ids reference descriptors; ids the current fields data
 *  no longer declares are ignored (resurrect-safe). */
export interface VisualDatabaseViewColumnState {
  /** Explicit column order (descriptor ids). Ids not listed trail in descriptor order. */
  order?: readonly string[];
  /** Pixel widths keyed by descriptor id. Compatibility alias of the open
   *  `styles[id].width` property — the cascade resolver reads either. */
  widths?: Readonly<Record<string, number>>;
  /** Descriptor ids hidden in this view. */
  hidden?: readonly string[];
  /** Open per-column property bags keyed by descriptor id — every adjustable
   *  column aspect beyond width/hidden/order lives here as DATA (no new field
   *  per aspect). Ids the current fields no longer declare are ignored. */
  styles?: Readonly<Record<string, VisualDatabaseElementStyle>>;
}

/** Calm section-list presentation selected by view DATA. Field ids bind the
 * generic visual roles; the renderer never branches on view ids or domains. */
export interface VisualDatabaseListPresentation {
  variant: string;
  countFieldId?: string;
  statusFieldId?: string;
  iconFieldId?: string;
  actionFieldId?: string;
  emptyLabel?: string;
}

/** One adjustable grid-element aspect, expressed entirely as self-describing
 *  DATA (address `visual-database.grid-properties`). Extends the shared
 *  `TuningSetting` (widget + control DATA, parts/ui tuning-panel) with the grid-specific
 *  `scope`, the `apply` capability id, and — for style applies — the real CSS
 *  property + unit. Adding an aspect is ONE row; the surface is blind to it. */
export interface VisualDatabaseGridPropertyDescriptor {
  /** Bag key written/read at the element's property bag. */
  key: string;
  /** Human label — the only user-facing string (never `key`/`cssProp`). */
  label: string;
  /** Which element this may be set on. */
  scope: 'grid' | 'row' | 'column';
  /** Capability id selecting how the resolved value is applied — dispatched
   *  through an injected map ('style' | 'format' | 'validate' | future). */
  apply: string;
  /** The shared TuningControl widget id (slider/toggle/segmented/number/select/color/…). */
  widget: string;
  /** apply==='style': the React.CSSProperties key, e.g. 'borderRadius'. */
  cssProp?: string;
  /** Unit appended to numeric style values, e.g. 'px' (''=none). */
  unit?: string;
  valueKind?: 'number' | 'string' | 'boolean';
  min?: number;
  max?: number;
  step?: number;
  options?: readonly { value: string; label: string }[];
  presets?: readonly string[];
  /** Resolved fallback shown when no scope in the chain sets the key. */
  defaultValue?: unknown;
}

export interface VisualDatabaseViewDescriptor {
  id: string;
  label: string;
  kind: string;
  order: number;
  /** Navigation membership is DATA. `direct` views are already-loaded,
   * exact-id destinations but never appear in the ordinary view switcher. */
  visibility?: string;
  /** Optional address of the ordinary dataset this view materializes. The
   * mount resolves the address from its supplied workspace; the renderer
   * never branches on view ids or dataset names. */
  sourceDatasetAddress?: string;
  /** Data-defined record scoping: a view only shows records passing every filter. */
  filters: readonly VisualDatabaseViewFilter[];
  /** Optional accent color for this view (hex or CSS color), shown in the view switcher. */
  color?: string;
  icon?: string;
  /** Descriptor id of the time axis for timeline kinds. Default: 'date' binding. */
  dateField?: string;
  /** Timeline bucket granularity — opaque view DATA ('year'|'quarter'|'month'|'week'|'day'
   *  today; unknown values degrade to day in the grouping leaf, never a renderer branch). */
  zoom?: string;
  /** Per-view column order/widths/hidden + open per-column style bags — table-kind presentation state. */
  columns?: VisualDatabaseViewColumnState;
  /** Grid-scope property bag — aspects applied to the whole table (e.g. row
   *  height, striping). Lowest tier of the cascade (column overrides grid). */
  gridStyle?: VisualDatabaseElementStyle;
  /** Row-scope property bag — aspects applied to every data row. */
  rowStyle?: VisualDatabaseElementStyle;
  presentation?: VisualDatabaseListPresentation;
  /** List kinds: draw how many of the view's records are done (their completion lane) above the list. */
  progress?: boolean;
  /** List kinds: the field ids the list is grouped by, outermost first (the list's own Group by). Present, the list's
   *  records sit under one heading per value of each, nested in this order, each heading saying how many are done;
   *  absent, they sit under date headings with the done ones last. */
  sections?: readonly string[];
  /** Canvas view spatial positions (canvas kind only): x/y pixel coordinates keyed by recordViewKey. */
  canvasPositions?: Readonly<Record<string, { x: number; y: number }>>;
  /** Open projection operations. Operation strings are data; unknown entries
   *  degrade to a generic section instead of becoming renderer branches. */
  projectionRules: readonly VisualDatabaseProjectionRuleDescriptor[];
  /** Record-to-node and record-to-edge paths for topology renderers. All field
   *  meaning remains in DATA and unknown record shapes simply project no rows. */
  topology?: import('../../ui/show/node-graph/project-topology').TopologyDescriptor;
  /** Metric cards for kind:'metric' views. Each reduces the record-set into a
   *  shared ui/show atom. Data only; absent for every other kind. */
  metrics?: readonly VisualDatabaseMetricDescriptor[];
  /** kind:'metric' views: sort the records into sections by this field's declared values (a status, a stage) and draw
   *  them as the shared status overview: a card per value with its count, one strip of how the whole divides, and each
   *  value's newest records. `dateField` dates each record. Absent: the metric cards alone. */
  overview?: { field: string };
}

export type VisualDatabaseSurfaceStateKind =
  | 'ready'
  | 'loading'
  | 'offline'
  | 'error'
  | 'missing'
  | 'permission'
  | 'concurrent'
  | 'deleted';

export interface VisualDatabaseSurfaceState {
  kind: VisualDatabaseSurfaceStateKind;
  message?: string;
  actionLabel?: string;
  updatedAt?: string;
  replacementLabel?: string;
}

/** One aggregation over the record-set. `op` is a key in METRIC_REDUCERS
 *  ('count' | 'sum' | 'average' | 'min' | 'max' | 'latest' | 'first'). `fieldId`
 *  names the descriptor whose value is reduced; omit it for 'count'. */
export interface VisualDatabaseMetricAggregation {
  op: string;
  fieldId?: string;
}

/** A tone grade chosen by where the value lands (first match wins). */
export interface VisualDatabaseMetricToneThreshold {
  min?: number;
  max?: number;
  tone: string;
}

/** A target comparison producing a delta reading. Present only when configured. */
export interface VisualDatabaseMetricDelta {
  baseline: number;
  label?: string;
}

/** One computed value inside a metric card: an aggregation plus its tone,
 *  format, and unit. */
export interface VisualDatabaseMetricValueSpec {
  id: string;
  label: string;
  aggregation: VisualDatabaseMetricAggregation;
  /** A fixed tone key, or derive it from `toneThresholds`. */
  tone?: string;
  toneThresholds?: readonly VisualDatabaseMetricToneThreshold[];
  /** A key in METRIC_FORMATTERS ('integer'|'decimal'|'currency'|'percent'). */
  format?: string;
  /** Unit shown beside the value by the atom (e.g. '%', 'flow'). */
  unit?: string;
  /** Mono/tabular numerals for a metric-row cell. Default true for numbers. */
  mono?: boolean;
  delta?: VisualDatabaseMetricDelta;
}

export interface VisualDatabaseMetricPresentation {
  /** Open hierarchy key interpreted by the selected metric atom. */
  emphasis?: string;
  /** Optional trend value id; defaults to the second computed value. */
  trendValueId?: string;
  trendLabel?: string;
  /** Timestamp and comparison copy remain DATA so an owner derivation can author them. */
  asOf?: string;
  comparison?: string;
  /** Numeric samples for the shared ui chart's sparkline. */
  sparkline?: readonly number[];
}

/** One metric card: a shared ui/show atom fed by 1+ computed values. `atom` is
 *  a key in the atom map (stat-strip / score-ring / metric-row). An unknown key
 *  resolves to the metric-row atom. */
export interface VisualDatabaseMetricDescriptor {
  id: string;
  atom: string;
  /** Card-level label (score-ring ring label / section heading). */
  label?: string;
  /** score-ring only: the gauge scale (default 1 = a 0..1 fraction). */
  max?: number;
  /** score-ring only: a short verdict band + interpretive caption. */
  band?: string;
  caption?: string;
  presentation?: VisualDatabaseMetricPresentation;
  /** Computed values feeding the atom (multi for stat-strip / metric-row). */
  values: readonly VisualDatabaseMetricValueSpec[];
}

export interface VisualDatabaseViewIdentity {
  viewId: string;
  viewRecordSha256: string;
  sourceDatasetAddress: string;
  datasetPayloadSha256: string;
  selectedModelSha256: string;
}

export interface VisualDatabaseViewDataset {
  address: string;
  payload: Record<string, unknown>;
}

export interface VisualDatabaseViewWorkspace {
  views: readonly VisualDatabaseViewDescriptor[];
  identities: readonly VisualDatabaseViewIdentity[];
  datasets: readonly VisualDatabaseViewDataset[];
}

export interface VisualDatabaseViewWorkspaceSelection {
  view: VisualDatabaseViewDescriptor;
  identity: VisualDatabaseViewIdentity;
  dataset: VisualDatabaseViewDataset;
}

export interface VisualDatabaseProjectionRuleDescriptor {
  id: string;
  operation: string;
  sourceFieldId?: string;
  sourceRole?: string;
  params?: Record<string, unknown>;
  order: number;
  label?: string;
  icon?: string;
  tone?: string;
}

export interface VisualDatabaseActionDescriptor {
  id: string;
  label: string;
  target?: string;
  operation?: string;
  definitionId?: string;
  definitionIds: readonly string[];
  input?: Record<string, unknown>;
  copy: readonly VisualDatabaseActionInputCopy[];
  /** Values the human supplies when invoking; each answer merges into the
   *  action input under its `key`. A prompt with `options` filters offers a
   *  choice sourced from feed records (same blind shape as domain.fromRecords);
   *  without options it is free text. Declared in the actions data record. */
  inputPrompts: readonly VisualDatabaseActionPrompt[];
  /** Descriptor id this action attaches to: it appears on each chosen value
   *  of that field (e.g. on every assignee chip). Absent = record-level action. */
  fieldId?: string;
  /** Input key that receives the invoked context's selected value
   *  (e.g. an assignee's record reference) — set in data, used by the board. */
  valueKey?: string;
  /** Physics-generated input values: 'unique-id' | 'timestamp'. */
  generate: readonly VisualDatabaseActionGeneratedInput[];
  /** Icon name resolved via the shared icon resolver for menu rows. */
  icon?: string;
  viewKinds: readonly string[];
  acceptsLanes: boolean;
  /** Optional record-path gate for generic record-set action buttons. */
  hiddenWhen?: { path: readonly string[]; equals: unknown };
  when?: { path: readonly string[]; equals: unknown };
}

export interface VisualDatabaseActionGeneratedInput {
  key: string;
  method: string;
  params: Readonly<Record<string, unknown>>;
}

export interface VisualDatabaseActionInputCopy {
  key: string;
  from?: string;
  value?: unknown;
}

export interface VisualDatabaseActionPrompt {
  key: string;
  label: string;
  /** Feed-record filters whose matches become the choices for this prompt. */
  options?: readonly VisualDatabaseViewFilter[];
  /** A choice prompt the human may leave unanswered. */
  optional?: boolean;
  /** Shared prompt control kind, for surfaces that render action forms. */
  kind?: string;
  /** Where this answer is written in the action input (for nested owner payloads). */
  inputPath?: readonly string[];
  /** Optional value path on the acted-on record used to prefill the control. */
  startFrom?: string;
  placeholder?: string;
}

/** One human-owned color in the board palette. Older data may still store
 *  palette entries as raw strings; decode normalizes both shapes here so the
 *  UI can rename colors without inventing a second settings store. */
export interface VisualDatabasePaletteColor {
  id: string;
  label: string;
  color: string;
  order: number;
}

export interface VisualDatabaseRecord {
  /** Read-only computed values; never part of the source payload. Presence
   * suppresses raw-path fallback even when a result is unavailable. */
  readonly fieldValues?: ReadonlyMap<string, unknown>;
  id: string;
  title: string;
  body: string;
  kind: string;
  group: string;
  lane: VisualDatabaseLaneDescriptor;
  date: string | null;
  /** Raw sort value: legacy number, fractional order-key string, or absent. */
  sort: unknown;
  badges: readonly string[];
  links: readonly string[];
  raw: unknown;
}

export interface VisualDatabaseAttachmentRef {
  id: string;
  label: string;
  kind: string;
  address?: string;
  filePath?: string;
  url?: string;
  contentAddress?: string;
  content?: string;
  mimeType?: string;
  source?: string;
  raw: unknown;
}

export interface VisualDatabaseModel {
  records: readonly VisualDatabaseRecord[];
  fields: readonly VisualDatabaseFieldDescriptor[];
  views: readonly VisualDatabaseViewDescriptor[];
  actions: readonly VisualDatabaseActionDescriptor[];
  /** Optional list-color palette shipped inside the views data record. */
  palette: readonly VisualDatabasePaletteColor[];
  /** Adjustable grid-element aspects as DATA (address `visual-database.grid-properties`).
   *  DATA overrides the built-in default set (like views override FALLBACK_VIEW). */
  gridProperties: readonly VisualDatabaseGridPropertyDescriptor[];
  /** Pre-read bytes for `domain.fromAddress` sources, keyed by address. */
  domains?: Readonly<Record<string, unknown>>;
}

export interface DecodeVisualDatabaseInput {
  records: unknown;
  fields: unknown;
  views: unknown;
  actions: unknown;
  /** Raw `visual-database.grid-properties` DATA (optional — defaults apply if absent). */
  gridProperties?: unknown;
  domains?: Record<string, unknown>;
}

export interface VisualDatabaseTreeNode {
  record: VisualDatabaseRecord;
  depth: number;
  children: readonly VisualDatabaseTreeNode[];
}

export interface ProjectVisualDatabaseViewOptions {
  view?: string | VisualDatabaseViewDescriptor;
  search?: string;
  projectionRules?: readonly VisualDatabaseProjectionRuleDescriptor[];
}

export interface VisualDatabaseViewProjection {
  view: {
    id: string;
    label: string;
    kind: string;
    icon?: string;
    color?: string;
  };
  sections: readonly VisualDatabaseViewSection[];
  recordsByKey: Readonly<Record<string, VisualDatabaseProjectedRecord>>;
  rootKeys: readonly string[];
  childKeysByParentKey: Readonly<Record<string, readonly string[]>>;
  actionsByRecordKey: Readonly<Record<string, readonly VisualDatabaseProjectedAction[]>>;
  writeTargetsByRecordKey: Readonly<Record<string, readonly VisualDatabaseProjectedWriteTarget[]>>;
  counts: VisualDatabaseProjectionCounts;
  projectionCursor: string;
  diagnostics: readonly VisualDatabaseProjectionDiagnostic[];
}

export interface VisualDatabaseViewSection {
  key: string;
  id: string;
  label: string;
  icon?: string;
  tone?: string;
  order: number;
  recordKeys: readonly string[];
  count: number;
  ruleId: string;
  operation: string;
}

export interface VisualDatabaseProjectedRecord {
  key: string;
  id: string;
  address?: string;
  title: string;
  depth: number;
  childCount: number;
  fields: readonly VisualDatabaseProjectedField[];
  raw: unknown;
}

export interface VisualDatabaseProjectedField {
  fieldId: string;
  label: string;
  role: string;
  shape: string;
  value: unknown;
  text: readonly string[];
  editable: boolean;
  writePath?: readonly string[];
}

export interface VisualDatabaseProjectedWriteTarget {
  fieldId: string;
  label: string;
  addressLabel: string;
  writePath: readonly string[];
}

export interface VisualDatabaseProjectedAction {
  id: string;
  label: string;
  icon?: string;
  target?: string;
  operation?: string;
  fieldId?: string;
  valueKey?: string;
  prompts: readonly VisualDatabaseActionPrompt[];
}

export interface VisualDatabaseProjectionCounts {
  total: number;
  scoped: number;
  visible: number;
  hiddenByViewFilter: number;
  hiddenBySearch: number;
  sections: number;
  roots: number;
}

export interface VisualDatabaseProjectionDiagnostic {
  code: string;
  ruleId?: string;
  operation?: string;
  message: string;
}

/** Physics fallback for "this record has no value on the grouping axis". The
 *  display label is overridable via the grouping descriptor's `emptyLabel`. */
export const EMPTY_LANE_ID = 'unassigned';

const EMPTY_LANE: VisualDatabaseLaneDescriptor = {
  id: EMPTY_LANE_ID,
  label: 'Unassigned',
  order: 100000,
  tone: 'neutral',
  details: [],
};


// -----------------------------------------------------------------------------
// Primitive readers
// -----------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function readNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function readStringArray(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.map(readString).filter((item): item is string => item !== null)
    : [];
}

const NAMED_PALETTE_COLORS: Readonly<Record<string, string>> = {
  '#38bdf8': 'Blue',
  '#3b82f6': 'Blue',
  '#10b981': 'Green',
  '#22c55e': 'Green',
  '#ef4444': 'Red',
  '#eab308': 'Yellow',
  '#ffcc00': 'Yellow',
  '#737373': 'Gray',
  '#6b7280': 'Gray',
  '#f97316': 'Orange',
  '#8b5cf6': 'Purple',
  '#ec4899': 'Pink',
  '#14b8a6': 'Teal',
  '#f59e0b': 'Amber',
  '#84cc16': 'Lime',
  '#f43f5e': 'Rose',
  '#06b6d4': 'Cyan',
  '#6366f1': 'Indigo',
  '#7c3aed': 'Violet',
  '#d946ef': 'Fuchsia',
};

export function slugifyDataId(value: string): string {
  return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'item';
}

function paletteLabel(color: string): string {
  return NAMED_PALETTE_COLORS[color.trim().toLowerCase()] ?? color;
}

function readPaletteColor(value: unknown, index: number): VisualDatabasePaletteColor | null {
  if (typeof value === 'string') {
    const color = readString(value);
    if (!color) return null;
    const label = paletteLabel(color);
    return {
      id: `${slugifyDataId(label)}-${index}`,
      label,
      color,
      order: index * 10,
    };
  }
  if (!isRecord(value)) return null;
  const color = readString(value.color ?? value.hex ?? value.value);
  if (!color) return null;
  const label = readString(value.label ?? value.name) ?? paletteLabel(color);
  return {
    id: readString(value.id) ?? slugifyDataId(label),
    label,
    color,
    order: readNumber(value.order, index * 10),
  };
}

function readPalette(value: unknown): readonly VisualDatabasePaletteColor[] {
  return Array.isArray(value)
    ? value.map(readPaletteColor).filter((item): item is VisualDatabasePaletteColor => item !== null)
    : [];
}

function readPath(value: unknown): readonly string[] | null {
  if (!Array.isArray(value)) return null;
  // An empty path is the record-root identity. It lets one DATA descriptor
  // bind a whole row (for example a field-carried placeable-surface intent)
  // while wrapped `{ address, payload }` feeds keep their ordinary paths.
  if (value.length === 0) return [];
  const path = value.map(readString).filter((part): part is string => part !== null);
  return path.length === value.length ? path : null;
}

function readPathArray(value: unknown): readonly (readonly string[])[] {
  if (!Array.isArray(value)) return [];
  return value.map(readPath).filter((path): path is readonly string[] => path !== null);
}

function readPathValue(source: unknown, path: readonly string[]): unknown {
  let current = source;
  for (const part of path) {
    if (Array.isArray(current)) {
      const index = Number(part);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) return undefined;
      current = current[index];
      continue;
    }
    if (!isRecord(current) || !Object.prototype.hasOwnProperty.call(current, part)) {
      return undefined;
    }
    current = current[part];
  }
  return current;
}

function valueToText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return readString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    const text = value.map(valueToText).filter((item): item is string => item !== null).join(', ');
    return text.length > 0 ? text : null;
  }
  if (isRecord(value)) {
    for (const key of ['label', 'title', 'name', 'id']) {
      const text = valueToText(value[key]);
      if (text) return text;
    }
    return JSON.stringify(value);
  }
  return null;
}

/** Humanize a data segment for display ("in-progress" → "in progress"). */
export function humanizeSegment(segment: string): string {
  return segment.replace(/[-_]+/g, ' ').trim();
}

/** Generic machine-string heuristic — no fixed address prefix. */
export function isMachineToken(value: string): boolean {
  return value.length >= 16 && !/\s/.test(value) && (/[0-9a-f]{12}/i.test(value) || value.includes('::'));
}

/** A record a human authored vs engine/system state that happens to be on the
 *  published feed. Human surfaces render ONLY human records — machine identity
 *  never renders as a row (the category rule, not just the heading rule).
 *  Generic test: a human record carries prose (title or body with real words,
 *  not a machine token). Engine state ("…recording state · 1f:…") does not. */
export function isHumanRecord(record: VisualDatabaseRecord): boolean {
  const prose = (value: string) => {
    const trimmed = value.trim();
    return trimmed.length > 0 && !isMachineToken(trimmed);
  };
  // A title that merely equals the record id is the synthetic fallback for
  // an UNTITLED record (untitled feed rows fall back to `record-${index}` /
  // the address) — fallback identity is not authorship.
  const authoredTitle = record.title !== record.id && prose(record.title);
  return authoredTitle || prose(record.body);
}

// -----------------------------------------------------------------------------
// The field contract: extraction, shape derivation, domains
// -----------------------------------------------------------------------------

function recordReadSource(record: VisualDatabaseRecord): unknown {
  return isRecord(record.raw) ? record.raw : { id: record.id, payload: record.raw };
}

/** The durable address of a record on the published feed, when present. */
export function recordAddress(record: VisualDatabaseRecord): string | null {
  const raw = record.raw;
  return isRecord(raw) ? readString(raw.address) : null;
}

/** A copy of the record's writable payload, or null when the payload exists but
 *  is not an object (bare-value rows are read-only — generic guard). Reading a
 *  record's payload is a read-data concern; write assembly (do-work) consumes
 *  this to build the next payload. */
export function recordPayload(record: VisualDatabaseRecord): Record<string, unknown> | null {
  const raw = record.raw;
  if (!isRecord(raw)) return null;
  if (raw.payload === undefined || raw.payload === null) return {};
  return isRecord(raw.payload) ? { ...raw.payload } : null;
}

/** Stable UI/tree identity. Human ids are useful link/search data, but the
 *  log address is the record that field writes and deletes actually mutate. */
export function recordIdentityKey(record: VisualDatabaseRecord): string {
  return recordAddress(record) ?? record.id;
}

/** Address links can arrive as either the display multihash form (`1f:...`)
 *  or the fact-address wire hex (`1f20...`). They name the same log fact.
 *  Tree projection indexes both so hierarchy is data-derived instead of
 *  depending on one presenter choosing one spelling. */
function recordIdentityAliases(value: string): readonly string[] {
  const aliases = new Set<string>([value]);
  const trimmed = value.trim();
  const displayMatch = /^1f:([0-9a-f]{64})$/i.exec(trimmed);
  if (displayMatch) aliases.add(`1f20${displayMatch[1]}`);
  const wireMatch = /^1f20([0-9a-f]{64})$/i.exec(trimmed);
  if (wireMatch) aliases.add(`1f:${wireMatch[1]}`);
  return [...aliases];
}

/** Project only current resolved values without modifying any durable row. */
export function projectResolvedFieldValues(
  records: readonly VisualDatabaseRecord[],
  cells: ReadonlyMap<string, ReadonlyMap<string, {
    derived: boolean;
    value?: unknown;
    errorCode?: unknown;
    stale?: unknown;
  }>> | undefined,
): readonly VisualDatabaseRecord[] {
  if (!cells?.size) return records;
  return records.map((record) => {
    const resolved = cells.get(recordIdentityKey(record));
    if (!resolved) return record;
    const fieldValues = new Map<string, unknown>();
    for (const [fieldId, cell] of resolved) {
      if (cell.derived) fieldValues.set(fieldId, cell.errorCode || cell.stale ? undefined : cell.value);
    }
    return fieldValues.size ? { ...record, fieldValues } : record;
  });
}

/** First non-empty value found through the descriptor's read paths. */
export function extractFieldValue(record: VisualDatabaseRecord, descriptor: VisualDatabaseFieldDescriptor): unknown {
  if (record.fieldValues?.has(descriptor.id)) return record.fieldValues.get(descriptor.id);
  const source = recordReadSource(record);
  for (const path of descriptor.paths) {
    const value = readPathValue(source, path);
    if (value !== undefined && value !== null && valueToText(value) !== null) return value;
  }
  return null;
}

/** Text projection of a field — one entry per element for array values.
 *  Used by sort, group, filter, and search alike. */
export function extractFieldText(record: VisualDatabaseRecord, descriptor: VisualDatabaseFieldDescriptor): readonly string[] {
  const value = extractFieldValue(record, descriptor);
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) {
    return [...new Set(value.map(valueToText).filter((item): item is string => item !== null))];
  }
  const text = valueToText(value);
  return text ? [text] : [];
}

function extractFieldPathText(record: VisualDatabaseRecord, descriptor: VisualDatabaseFieldDescriptor): readonly string[] {
  if (record.fieldValues?.has(descriptor.id)) return extractFieldText(record, descriptor);
  const source = recordReadSource(record);
  const values: string[] = [];
  for (const path of descriptor.paths) {
    const value = readPathValue(source, path);
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      values.push(...value.map(valueToText).filter((item): item is string => item !== null));
      continue;
    }
    const text = valueToText(value);
    if (text) values.push(text);
  }
  return [...new Set(values)];
}

/** Value shape, derived from the value itself (JSON physics) unless the
 *  descriptor pins it. First match wins; everything degrades to 'text'. */
export function deriveShape(value: unknown, descriptor?: VisualDatabaseFieldDescriptor): string {
  if (descriptor?.shape) return descriptor.shape;
  if (descriptor?.role === 'attachment') return 'attachments';
  if (descriptor?.domain) return Array.isArray(value) ? 'multi' : 'choice';
  if (descriptor?.role === 'link') return 'reference';
  if (typeof value === 'string' && isMachineToken(value)) return 'reference';
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) return 'temporal';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'flag';
  if (Array.isArray(value)) return 'multi';
  if (typeof value === 'string' && (value.includes('\n') || value.length > 120)) return 'longtext';
  return 'text';
}

function firstTextFromRecord(value: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const text = valueToText(value[key]);
    if (text) return text;
  }
  return null;
}

function basename(value: string): string {
  const cleaned = value.replace(/\\/g, '/').replace(/\/+$/g, '');
  const parts = cleaned.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? value;
}

function classifyAttachmentText(value: string): string {
  if (/^(\/|~\/|\.\.?\/)/.test(value)) return 'file';
  if (/^https?:\/\//i.test(value)) return 'url';
  if (/^(1f:|1f20)/i.test(value) || value.includes('::')) return 'log-ref';
  return 'ref';
}

function attachmentId(value: VisualDatabaseAttachmentRef, index: number): string {
  return value.address ?? value.contentAddress ?? value.filePath ?? value.url ?? value.id ?? `attachment-${index}`;
}

function readAttachmentRef(value: unknown, index: number): VisualDatabaseAttachmentRef | null {
  if (typeof value === 'string') {
    const text = readString(value);
    if (!text) return null;
    const kind = classifyAttachmentText(text);
    return {
      id: text,
      label: kind === 'file' ? basename(text) : text,
      kind,
      ...(kind === 'file' ? { filePath: text } : {}),
      ...(kind === 'log-ref' ? { address: text } : {}),
      ...(kind === 'url' ? { url: text } : {}),
      raw: value,
    };
  }
  if (!isRecord(value)) return null;
  const filePath = firstTextFromRecord(value, ['filePath', 'file_path', 'path', 'local_path']);
  const url = firstTextFromRecord(value, ['url', 'href', 'uri']);
  const address = firstTextFromRecord(value, ['address', 'address_label', 'addressLabel', 'record_address', 'fact_address', 'log_address', 'ref']);
  const contentAddress = firstTextFromRecord(value, ['content_address', 'contentAddress', 'cas', 'hash', 'multihash']);
  const id = firstTextFromRecord(value, ['id', 'attachment_id', 'attachmentId'])
    ?? address
    ?? contentAddress
    ?? filePath
    ?? url
    ?? `attachment-${index}`;
  const label = firstTextFromRecord(value, ['label', 'title', 'name', 'display'])
    ?? (filePath ? basename(filePath) : null)
    ?? address
    ?? contentAddress
    ?? url
    ?? id;
  const explicitKind = firstTextFromRecord(value, ['kind', 'type', 'source']);
  const kind = explicitKind
    ?? (filePath ? 'file'
      : url ? 'url'
      : address ? classifyAttachmentText(address)
        : contentAddress ? 'content'
          : 'ref');
  return {
    id,
    label,
    kind,
    address: address ?? undefined,
    filePath: filePath ?? undefined,
    url: url ?? undefined,
    contentAddress: contentAddress ?? undefined,
    content: firstTextFromRecord(value, ['content', 'text', 'body']) ?? undefined,
    mimeType: firstTextFromRecord(value, ['mime_type', 'mimeType']) ?? undefined,
    source: firstTextFromRecord(value, ['source', 'owner', 'package']) ?? undefined,
    raw: value,
  };
}

export function readAttachmentRefs(value: unknown): readonly VisualDatabaseAttachmentRef[] {
  const raw = Array.isArray(value) ? value : value === null || value === undefined ? [] : [value];
  return raw
    .map(readAttachmentRef)
    .filter((entry): entry is VisualDatabaseAttachmentRef => entry !== null)
    .map((entry, index) => ({ ...entry, id: attachmentId(entry, index) }));
}

/** A complete valid descriptor from nothing but a field name (`{id}` rule). */
export function syntheticFieldDescriptor(id: string): VisualDatabaseFieldDescriptor {
  return { id, label: humanizeSegment(id), role: 'none', paths: [[id], ['payload', id]] };
}

function adHocDomainValue(id: string): VisualDatabaseFieldDomainValue {
  return { id, label: id, tone: 'neutral', order: 1000000, details: [] };
}

function sortDomainValues(values: Iterable<VisualDatabaseFieldDomainValue>): readonly VisualDatabaseFieldDomainValue[] {
  return [...values].sort((left, right) => left.order - right.order || left.label.localeCompare(right.label));
}

function declaredDomainValues(
  descriptor: VisualDatabaseFieldDescriptor,
  records: readonly VisualDatabaseRecord[],
  fields: readonly VisualDatabaseFieldDescriptor[],
  domains?: Readonly<Record<string, unknown>>,
): readonly VisualDatabaseFieldDomainValue[] {
  const domain = descriptor.domain;
  if (!domain) return [];
  if (domain.values && domain.values.length > 0) return domain.values;
  if (domain.fromField) {
    const source = fields.find((field) => field.id === domain.fromField) ?? syntheticFieldDescriptor(domain.fromField);
    const seen = new Map<string, VisualDatabaseFieldDomainValue>();
    for (const record of records) {
      for (const text of extractFieldText(record, source)) {
        if (!seen.has(text)) seen.set(text, { id: text, label: text, tone: 'neutral', order: seen.size, details: [] });
      }
    }
    return [...seen.values()];
  }
  if (domain.fromAddress) {
    return readListContainer(domains?.[domain.fromAddress], 'values')
      .map(readDomainValue)
      .filter((value): value is VisualDatabaseFieldDomainValue => value !== null);
  }
  if (domain.fromRecords && domain.fromRecords.length > 0) {
    // Each feed record passing the data-defined filters becomes one option.
    // The board stays blind: filters say WHICH records; the records say WHO
    // they are (title); the ref carries the durable address for actions.
    return optionsFromRecords(domain.fromRecords, records, fields, domain.details ?? []);
  }
  return [];
}

/** The full value domain of a field: declared values (or derived source),
 *  with every observed-but-undeclared value preserved as an ad-hoc entry. */
export function effectiveDomain(
  descriptor: VisualDatabaseFieldDescriptor,
  model: VisualDatabaseModel,
  view?: VisualDatabaseViewDescriptor,
): readonly VisualDatabaseFieldDomainValue[] {
  if (view && groupingDescriptorForView(view, model.fields)?.id === descriptor.id) {
    return lanesForView(view, model.records, model.fields, model.domains);
  }
  const values = new Map<string, VisualDatabaseFieldDomainValue>();
  for (const value of declaredDomainValues(descriptor, model.records, model.fields, model.domains)) {
    values.set(value.id, value);
  }
  for (const record of model.records) {
    for (const text of extractFieldText(record, descriptor)) {
      if (!values.has(text)) values.set(text, adHocDomainValue(text));
    }
  }
  return sortDomainValues(values.values());
}

// -----------------------------------------------------------------------------
// Descriptor decoding (data → contract; preserve, never reject)
// -----------------------------------------------------------------------------

function readDomainValue(value: unknown, index = 0): VisualDatabaseFieldDomainValue | null {
  if (!isRecord(value)) return null;
  const id = readString(value.id);
  if (!id) return null;
  const color = readString(value.color) ?? undefined;
  return {
    id,
    label: readString(value.label) ?? id,
    order: readNumber(value.order, index),
    tone: readString(value.tone) ?? toneFromColor(color) ?? undefined,
    color,
    pulse: typeof value.pulse === 'boolean' ? value.pulse : undefined,
    ref: readString(value.ref) ?? undefined,
    details: readDomainDetails(value.details),
  };
}

function toneFromColor(color: string | undefined): string | null {
  if (!color) return null;
  switch (color.trim().toLowerCase()) {
    case '#10b981':
    case '#34c759':
      return 'success';
    case '#ef4444':
    case '#ff3b30':
      return 'error';
    case '#f59e0b':
    case '#ffcc00':
      return 'warning';
    case '#3b82f6':
    case '#0a84ff':
      return 'info';
    case '#8b5cf6':
    case '#af52de':
      return 'accent';
    default:
      return null;
  }
}

function readDomain(value: unknown): VisualDatabaseFieldDomain | undefined {
  if (!isRecord(value)) return undefined;
  const values = Array.isArray(value.values)
    ? value.values.map(readDomainValue).filter((entry): entry is VisualDatabaseFieldDomainValue => entry !== null)
    : undefined;
  const fromField = readString(value.fromField ?? value.from_field) ?? undefined;
  const fromAddress = readString(value.fromAddress ?? value.from_address) ?? undefined;
  const fromRecordsRaw = value.fromRecords ?? value.from_records;
  const fromRecords = Array.isArray(fromRecordsRaw)
    ? fromRecordsRaw.map(readViewFilter).filter((filter): filter is VisualDatabaseViewFilter => filter !== null)
    : undefined;
  const detailsRaw = value.details ?? value.detail_descriptors;
  const details = Array.isArray(detailsRaw)
    ? detailsRaw
      .map(readDomainDetailDescriptor)
      .filter((detail): detail is VisualDatabaseFieldDomainDetailDescriptor => detail !== null)
    : undefined;
  const open = value.open === true ? true : undefined;
  if ((!values || values.length === 0) && !fromField && !fromAddress && (!fromRecords || fromRecords.length === 0)) {
    return open ? { open } : undefined;
  }
  return { values, fromField, fromAddress, fromRecords, details, open };
}

function readDomainDetailDescriptor(value: unknown): VisualDatabaseFieldDomainDetailDescriptor | null {
  if (!isRecord(value)) return null;
  const id = readString(value.id);
  if (!id) return null;
  const paths = readPathArray(value.paths);
  if (paths.length === 0) return null;
  return {
    id,
    label: readString(value.label) ?? humanizeSegment(id),
    role: readString(value.role) ?? undefined,
    paths,
  };
}

function readDomainDetails(value: unknown): readonly VisualDatabaseFieldDomainDetail[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry): VisualDatabaseFieldDomainDetail | null => {
      if (!isRecord(entry)) return null;
      const id = readString(entry.id);
      const detailValue = valueToText(entry.value);
      if (!id || !detailValue) return null;
      return {
        id,
        label: readString(entry.label) ?? humanizeSegment(id),
        value: detailValue,
        role: readString(entry.role) ?? undefined,
        ref: readString(entry.ref) ?? undefined,
      };
    })
    .filter((entry): entry is VisualDatabaseFieldDomainDetail => entry !== null);
}

/** Decode a field's conditional-visibility gate, accepting camelCase or snake_case
 *  keys (`visibleWhen`/`visible_when`). Returns undefined when absent/malformed —
 *  an undefined gate means always visible. */
function readVisibleWhen(value: unknown): VisualDatabaseFieldVisibleWhen | undefined {
  const raw = isRecord(value) ? value : null;
  const source = isRecord((raw as { visibleWhen?: unknown })?.visibleWhen)
    ? (raw as { visibleWhen: Record<string, unknown> }).visibleWhen
    : isRecord((raw as { visible_when?: unknown })?.visible_when)
      ? (raw as { visible_when: Record<string, unknown> }).visible_when
      : null;
  if (!source) return undefined;
  const field = readString(source.field);
  const equals = (Array.isArray(source.equals) ? source.equals : [])
    .map(readString)
    .filter((entry): entry is string => entry !== null);
  return field && equals.length > 0 ? { field, equals } : undefined;
}

function readCellRef(value: unknown): VisualDatabaseCellRef | null {
  if (!isRecord(value)) return null;
  const recordRef = readString(value.recordRef ?? value.record_ref);
  const fieldRef = readString(value.fieldRef ?? value.field_ref);
  return recordRef && fieldRef ? { recordRef, fieldRef } : null;
}

function readDependencyRef(value: unknown): VisualDatabaseDependencyRef | null {
  const ref = readCellRef(value);
  if (!ref || !isRecord(value)) return null;
  const rawContextKey = value.contextKey ?? value.context_key;
  if (rawContextKey !== undefined) {
    const contextKey = readString(rawContextKey);
    if (!contextKey) return null;
    return { ...ref, contextKey };
  }
  return ref;
}

function readValueDerive(value: unknown): VisualDatabaseValueDerive | undefined {
  if (!isRecord(value)) return undefined;
  const target = readString(value.target);
  if (!target) return undefined;
  const rawDependencies = value.dependencyRefs ?? value.dependency_refs;
  const dependencyMemberPresent = Object.prototype.hasOwnProperty.call(value, 'dependencyRefs')
    || Object.prototype.hasOwnProperty.call(value, 'dependency_refs');
  if (dependencyMemberPresent && (!Array.isArray(rawDependencies) || rawDependencies.some((entry) => readDependencyRef(entry) === null))) {
    return undefined;
  }
  const dependencyRefs = Array.isArray(rawDependencies)
    ? rawDependencies.map(readDependencyRef) as VisualDatabaseDependencyRef[]
    : [];
  if (new Set(dependencyRefs.map((dependency) => JSON.stringify([
    dependency.recordRef,
    dependency.fieldRef,
    dependency.contextKey ?? null,
  ]))).size !== dependencyRefs.length) return undefined;
  const rawSelector = value.dependencySelector ?? value.dependency_selector;
  const rawLegacyContext = value.contextFromFields ?? value.context_from_fields;
  const legacyContext = Array.isArray(rawLegacyContext) && rawLegacyContext.every((entry) => typeof entry === 'string')
    ? rawLegacyContext as string[]
    : null;
  const rawResultPath = value.resultPath ?? value.result_path;
  const resultPath = rawResultPath === undefined ? undefined : readStrictPath(rawResultPath);
  const rawCachePath = value.cachePath ?? value.cache_path;
  const cachePath = rawCachePath === undefined ? undefined : readStrictPath(rawCachePath);
  if ((rawResultPath !== undefined && !resultPath) || (rawCachePath !== undefined && !cachePath)) return undefined;
  if (value.request !== undefined && (!isRecord(value.request) || !isJsonValue(value.request))) return undefined;
  return {
    target,
    evaluatorRef: readString(value.evaluatorRef ?? value.evaluator_ref) ?? undefined,
    request: isRecord(value.request) ? value.request : undefined,
    resultPath: resultPath ?? undefined,
    dependencyRefs: dependencyRefs.length > 0 ? dependencyRefs : undefined,
    // Stored migration moves legacy derive data verbatim under
    // `default_expression`. Preserve its context policy at that boundary rather
    // than rewriting the source record or silently losing the selector.
    dependencySelector: isRecord(rawSelector)
      ? rawSelector
      : legacyContext ? { contextFromFields: legacyContext } : undefined,
    cachePath: cachePath ?? undefined,
    persist: typeof value.persist === 'boolean' ? value.persist : undefined,
  };
}

function readValueExpression(value: unknown): VisualDatabaseValueExpression | undefined {
  if (!isRecord(value)) return undefined;
  const hasLiteral = Object.prototype.hasOwnProperty.call(value, 'literal');
  const derive = readValueDerive(value.derive);
  if (hasLiteral === Boolean(derive)) return undefined;
  return hasLiteral ? { literal: value.literal } : { derive };
}

function readEvaluatorDescriptorRefs(value: unknown): readonly VisualDatabaseEvaluatorDescriptorRef[] | undefined {
  const refs = (Array.isArray(value) ? value : []).flatMap((entry) => {
    if (typeof entry === 'string' && entry.trim()) return [{ ref: entry }];
    if (!isRecord(entry)) return [];
    const ref = readString(entry.ref ?? entry.address ?? entry.evaluator_ref);
    return ref ? [{
      ref,
      label: readString(entry.label) ?? undefined,
      revision: readString(entry.revision) ?? undefined,
    }] : [];
  });
  return refs.length > 0 ? refs : undefined;
}

function readFieldSurfaceAction(value: unknown): VisualDatabaseFieldSurfaceAction | undefined {
  if (!isRecord(value)) return undefined;
  const rawAllowList = value.allowList ?? value.allow_list;
  if (!Array.isArray(rawAllowList) || rawAllowList.length === 0) return undefined;
  const allowList: VisualDatabaseSurfaceIntentAllowEntry[] = [];
  for (const entry of rawAllowList) {
    if (
      !isRecord(entry)
      || !isJsonValue(entry)
      || !Object.values(entry).some((policyValue) => policyValue !== null && policyValue !== undefined)
    ) return undefined;
    allowList.push({ ...entry });
  }
  return {
    allowList,
    ...(isRecord(value.payload) && isJsonValue(value.payload) ? { payload: value.payload } : {}),
    label: readString(value.label) ?? undefined,
    detail: readString(value.detail) ?? undefined,
    unavailableMessage: readString(value.unavailableMessage ?? value.unavailable_message) ?? undefined,
  };
}

function readFieldDescriptor(value: unknown, index: number): VisualDatabaseFieldDescriptor | null {
  if (!isRecord(value)) return null;
  const id = readString(value.id);
  const role = readString(value.role) ?? 'none';
  let paths = readPathArray(value.paths);
  if (paths.length === 0 && id) paths = [[id], ['payload', id]];
  if (paths.length === 0) return null;
  return {
    id: id ?? `field-${index}`,
    label: readString(value.label) ?? (id ? humanizeSegment(id) : role),
    role,
    paths,
    writePath: readPath(value.writePath ?? value.write_path) ?? undefined,
    shape: readString(value.shape) ?? undefined,
    domain: readDomain(value.domain),
    sortable: readBoolean(value.sortable, true),
    groupable: readBoolean(value.groupable, true),
    filterable: readBoolean(value.filterable, true),
    editable: readBoolean(value.editable, true),
    emptyLabel: readString(value.emptyLabel ?? value.empty_label) ?? undefined,
    visibleWhen: readVisibleWhen(value),
    defaultExpression: readValueExpression(value.defaultExpression ?? value.default_expression),
    evaluatorDescriptorRefs: readEvaluatorDescriptorRefs(
      value.evaluatorDescriptorRefs ?? value.evaluator_descriptor_refs,
    ),
    surfaceAction: readFieldSurfaceAction(value.surfaceAction ?? value.surface_action),
    source: 'declared',
  };
}

function readViewFilter(value: unknown): VisualDatabaseViewFilter | null {
  if (!isRecord(value)) return null;
  const field = readString(value.field);
  if (!field) return null;
  const equals = readStringArray(value.equals ?? value.is ?? value.in);
  const exclude = readStringArray(value.exclude ?? value.not ?? value.not_in);
  if (equals.length === 0 && exclude.length === 0) return null;
  return { field, equals, exclude };
}

function readProjectionRuleDescriptor(value: unknown, index: number): VisualDatabaseProjectionRuleDescriptor | null {
  if (!isRecord(value)) return null;
  const operation = readString(value.operation);
  if (!operation) return null;
  const id = readString(value.id) ?? `${operation}-${index}`;
  return {
    id,
    operation,
    sourceFieldId: readString(value.sourceFieldId ?? value.source_field_id ?? value.fieldId ?? value.field_id) ?? undefined,
    sourceRole: readString(value.sourceRole ?? value.source_role ?? value.role) ?? undefined,
    params: isRecord(value.params) ? value.params : undefined,
    order: readNumber(value.order, index),
    label: readString(value.label) ?? undefined,
    icon: readString(value.icon) ?? undefined,
    tone: readString(value.tone) ?? undefined,
  };
}

/** Decode per-view column state. Malformed entries drop silently — a broken
 *  widths map never breaks the view. */
function readViewColumnState(value: unknown): VisualDatabaseViewColumnState | undefined {
  const source = isRecord(value) ? value : null;
  if (!source) return undefined;
  const order = readStringArray(source.order);
  const hidden = readStringArray(source.hidden);
  const widthsRaw = isRecord(source.widths) ? source.widths : null;
  const widths: Record<string, number> = {};
  if (widthsRaw) {
    for (const [key, width] of Object.entries(widthsRaw)) {
      if (typeof width === 'number' && Number.isFinite(width) && width > 0) widths[key] = width;
    }
  }
  const hasWidths = Object.keys(widths).length > 0;
  const styles = readElementStyleMap(source.styles);
  const hasStyles = styles !== undefined;
  if (order.length === 0 && hidden.length === 0 && !hasWidths && !hasStyles) return undefined;
  return {
    ...(order.length > 0 ? { order } : {}),
    ...(hasWidths ? { widths } : {}),
    ...(hidden.length > 0 ? { hidden } : {}),
    ...(hasStyles ? { styles } : {}),
  };
}

function readListPresentation(value: unknown): VisualDatabaseListPresentation | undefined {
  if (!isRecord(value)) return undefined;
  const variant = readString(value.variant);
  if (!variant) return undefined;
  return {
    variant,
    countFieldId: readString(value.countFieldId ?? value.count_field_id) ?? undefined,
    statusFieldId: readString(value.statusFieldId ?? value.status_field_id) ?? undefined,
    iconFieldId: readString(value.iconFieldId ?? value.icon_field_id) ?? undefined,
    actionFieldId: readString(value.actionFieldId ?? value.action_field_id) ?? undefined,
    emptyLabel: readString(value.emptyLabel ?? value.empty_label) ?? undefined,
  };
}

/** A single element property bag — any JSON object of opaque key→value pairs.
 *  Never inspects the keys (L090); non-objects degrade to undefined. */
function readElementStyle(value: unknown): VisualDatabaseElementStyle | undefined {
  if (!isRecord(value)) return undefined;
  const bag: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    if (v !== null && v !== undefined) bag[key] = v;
  }
  return Object.keys(bag).length > 0 ? bag : undefined;
}

/** A map of element id → property bag (per-column styles). */
function readElementStyleMap(value: unknown): Readonly<Record<string, VisualDatabaseElementStyle>> | undefined {
  if (!isRecord(value)) return undefined;
  const map: Record<string, VisualDatabaseElementStyle> = {};
  for (const [id, bag] of Object.entries(value)) {
    const parsed = readElementStyle(bag);
    if (parsed) map[id] = parsed;
  }
  return Object.keys(map).length > 0 ? map : undefined;
}

/** Parse one grid-property descriptor row (address `visual-database.grid-properties`).
 *  Blind pass-through of DATA — the surface interprets `apply`/`widget`/`cssProp`
 *  via capability maps, never a branch here. Requires only key+label+scope+apply+widget. */
export function readGridPropertyDescriptor(value: unknown): VisualDatabaseGridPropertyDescriptor | null {
  if (!isRecord(value)) return null;
  const key = readString(value.key);
  const label = readString(value.label);
  const scopeRaw = readString(value.scope) ?? 'column';
  const apply = readString(value.apply) ?? 'style';
  const widget = readString(value.widget) ?? 'number';
  if (!key || !label) return null;
  const scope = scopeRaw === 'grid' || scopeRaw === 'row' ? scopeRaw : 'column';
  const optionsRaw = Array.isArray(value.options) ? value.options : [];
  const options = optionsRaw
    .map((o): { value: string; label: string } | null => {
      if (!isRecord(o)) return null;
      const v = readString(o.value);
      const l = readString(o.label);
      return v !== null && l !== null ? { value: v, label: l } : null;
    })
    .filter((o): o is { value: string; label: string } => o !== null);
  const presets = readStringArray(value.presets);
  return {
    key,
    label,
    scope,
    apply,
    widget,
    cssProp: readString(value.cssProp ?? value.css_prop) ?? undefined,
    unit: readString(value.unit) ?? undefined,
    valueKind: ((): VisualDatabaseGridPropertyDescriptor['valueKind'] => {
      const vk = readString(value.valueKind ?? value.value_kind);
      return vk === 'number' || vk === 'boolean' || vk === 'string' ? vk : undefined;
    })(),
    min: typeof value.min === 'number' ? value.min : undefined,
    max: typeof value.max === 'number' ? value.max : undefined,
    step: typeof value.step === 'number' ? value.step : undefined,
    ...(options.length > 0 ? { options } : {}),
    ...(presets.length > 0 ? { presets } : {}),
    defaultValue: value.defaultValue ?? value.default_value ?? undefined,
  };
}

/** Read the full grid-property descriptor set from the raw DATA array. */
export function readGridPropertyDescriptors(value: unknown): readonly VisualDatabaseGridPropertyDescriptor[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(readGridPropertyDescriptor)
    .filter((d): d is VisualDatabaseGridPropertyDescriptor => d !== null);
}

function readViewDescriptor(value: unknown, index: number): VisualDatabaseViewDescriptor | null {
  if (!isRecord(value)) return null;
  const kind = readString(value.kind);
  if (!kind) return null;
  const id = readString(value.id) ?? kind;
  const filters = Array.isArray(value.filters)
    ? value.filters.map(readViewFilter).filter((filter): filter is VisualDatabaseViewFilter => filter !== null)
    : [];
  const rulesRaw = value.projectionRules ?? value.projection_rules ?? value.sections ?? value.rules;
  const decodedProjectionRules = Array.isArray(rulesRaw)
    ? rulesRaw.map(readProjectionRuleDescriptor).filter((rule): rule is VisualDatabaseProjectionRuleDescriptor => rule !== null)
    : [];
  // Historical view descriptors stored grouping twice (`groupBy` + `lanes`).
  // Normalize that shape once at the read boundary. Every downstream reader
  // and every new write uses the single open `view-group` projection rule.
  const legacyGroupBy = readString(value.groupBy ?? value.group_by);
  const legacyLanes = Array.isArray(value.lanes)
    ? value.lanes.map(readDomainValue).filter((lane): lane is VisualDatabaseLaneDescriptor => lane !== null)
    : [];
  const hasCanonicalGrouping = decodedProjectionRules.some((rule) => rule.operation === 'view-group');
  const projectionRules = hasCanonicalGrouping || (!legacyGroupBy && legacyLanes.length === 0)
    ? decodedProjectionRules
    : [
        ...decodedProjectionRules,
        {
          id: 'grouping',
          operation: 'view-group',
          ...(legacyGroupBy ? { sourceFieldId: legacyGroupBy } : { sourceRole: 'lane' }),
          ...(legacyLanes.length > 0 ? { params: { valueOverrides: legacyLanes } } : {}),
          order: decodedProjectionRules.length,
        },
      ];
  return {
    id,
    label: readString(value.label) ?? id,
    kind,
    order: readNumber(value.order, index),
    visibility: readString(value.visibility) ?? undefined,
    sourceDatasetAddress: readString(value.sourceDatasetAddress ?? value.source_dataset_address) ?? undefined,
    filters,
    color: readString(value.color) ?? undefined,
    icon: readString(value.icon) ?? undefined,
    dateField: readString(value.dateField ?? value.date_field) ?? undefined,
    zoom: readString(value.zoom) ?? undefined,
    columns: readViewColumnState(value.columns),
    gridStyle: readElementStyle(value.gridStyle ?? value.grid_style),
    rowStyle: readElementStyle(value.rowStyle ?? value.row_style),
    presentation: readListPresentation(value.presentation),
    ...(value.progress === true ? { progress: true } : {}),
    ...(readStringArray(value.sections).length ? { sections: readStringArray(value.sections) } : {}),
    canvasPositions: readCanvasPositions(value.canvasPositions ?? value.canvas_positions),
    projectionRules,
    topology: readTopologyDescriptor(value.topology ?? value.linkDescriptors ?? value.link_descriptors),
    metrics: readMetricDescriptors(value.metrics),
    ...(isRecord(value.overview) && readString(value.overview.field) ? { overview: { field: readString(value.overview.field)! } } : {}),
  };
}

export function decodeVisualDatabaseSurfaceState(raw: unknown): VisualDatabaseSurfaceState {
  if (!isRecord(raw)) return { kind: raw == null ? 'loading' : 'error' };
  const kind = readString(raw.kind);
  const admitted: readonly VisualDatabaseSurfaceStateKind[] = [
    'ready', 'loading', 'offline', 'error', 'missing', 'permission', 'concurrent', 'deleted',
  ];
  return {
    kind: admitted.includes(kind as VisualDatabaseSurfaceStateKind)
      ? kind as VisualDatabaseSurfaceStateKind
      : 'error',
    message: readString(raw.message) ?? undefined,
    actionLabel: readString(raw.actionLabel ?? raw.action_label) ?? undefined,
    updatedAt: readString(raw.updatedAt ?? raw.updated_at) ?? undefined,
    replacementLabel: readString(raw.replacementLabel ?? raw.replacement_label) ?? undefined,
  };
}

function readTopologyMatch(value: unknown): import('../../ui/show/node-graph/project-topology').FieldMatch | null {
  if (!isRecord(value)) return null;
  const field = readString(value.field);
  if (!field) return null;
  const members = readStringArray(value.in);
  return {
    field,
    ...(members.length > 0 ? { in: members } : {}),
    ...(readString(value.equals) ? { equals: readString(value.equals)! } : {}),
    ...(typeof value.exists === 'boolean' ? { exists: value.exists } : {}),
  };
}

function readTopologySource(
  value: unknown,
  kind: 'node' | 'edge',
): import('../../ui/show/node-graph/project-topology').NodeSource
  | import('../../ui/show/node-graph/project-topology').EdgeSource
  | null {
  if (!isRecord(value)) return null;
  const where = Array.isArray(value.where)
    ? value.where.map(readTopologyMatch).filter((entry): entry is NonNullable<ReturnType<typeof readTopologyMatch>> => entry !== null)
    : [];
  if (kind === 'node') {
    const id = readString(value.id);
    if (!id) return null;
    return {
      id,
      ...(where.length > 0 ? { where } : {}),
      ...(readString(value.label) ? { label: readString(value.label)! } : {}),
      ...(readString(value.subtitle) ? { subtitle: readString(value.subtitle)! } : {}),
      ...(readString(value.status) ? { status: readString(value.status)! } : {}),
      ...(typeof value.width === 'number' && Number.isFinite(value.width) ? { width: value.width } : {}),
      ...(typeof value.height === 'number' && Number.isFinite(value.height) ? { height: value.height } : {}),
    };
  }
  const from = readString(value.from);
  const to = readString(value.to);
  if (!from || !to) return null;
  return {
    from,
    to,
    ...(where.length > 0 ? { where } : {}),
    ...(readString(value.id) ? { id: readString(value.id)! } : {}),
    ...(readString(value.activity) ? { activity: readString(value.activity)! } : {}),
  };
}

function readTopologyDescriptor(
  value: unknown,
): import('../../ui/show/node-graph/project-topology').TopologyDescriptor | undefined {
  if (!isRecord(value) || !Array.isArray(value.nodeSources)) return undefined;
  const nodeSources = value.nodeSources
    .map((entry) => readTopologySource(entry, 'node'))
    .filter((entry): entry is import('../../ui/show/node-graph/project-topology').NodeSource => entry !== null);
  if (nodeSources.length === 0) return undefined;
  const edgeSources = Array.isArray(value.edgeSources)
    ? value.edgeSources
      .map((entry) => readTopologySource(entry, 'edge'))
      .filter((entry): entry is import('../../ui/show/node-graph/project-topology').EdgeSource => entry !== null)
    : [];
  return { nodeSources, ...(edgeSources.length > 0 ? { edgeSources } : {}) };
}

function readMetricAggregation(value: unknown): VisualDatabaseMetricAggregation | null {
  if (!isRecord(value)) return null;
  const op = readString(value.op ?? value.operation);
  if (!op) return null;
  const fieldId = readString(value.fieldId ?? value.field_id);
  return fieldId ? { op, fieldId } : { op };
}

function readMetricToneThreshold(value: unknown): VisualDatabaseMetricToneThreshold | null {
  if (!isRecord(value)) return null;
  const tone = readString(value.tone);
  if (!tone) return null;
  const hasMin = typeof value.min === 'number' && Number.isFinite(value.min);
  const hasMax = typeof value.max === 'number' && Number.isFinite(value.max);
  return {
    tone,
    ...(hasMin ? { min: value.min as number } : {}),
    ...(hasMax ? { max: value.max as number } : {}),
  };
}

function readMetricDelta(value: unknown): VisualDatabaseMetricDelta | null {
  if (!isRecord(value)) return null;
  if (typeof value.baseline !== 'number' || !Number.isFinite(value.baseline)) return null;
  const label = readString(value.label);
  return label ? { baseline: value.baseline, label } : { baseline: value.baseline };
}

function readMetricValueSpec(value: unknown, index: number): VisualDatabaseMetricValueSpec | null {
  if (!isRecord(value)) return null;
  const aggregation = readMetricAggregation(value.aggregation);
  if (!aggregation) return null;
  const id = readString(value.id) ?? `value-${index}`;
  const thresholdsRaw = value.toneThresholds ?? value.tone_thresholds;
  const toneThresholds = Array.isArray(thresholdsRaw)
    ? thresholdsRaw
        .map(readMetricToneThreshold)
        .filter((threshold): threshold is VisualDatabaseMetricToneThreshold => threshold !== null)
    : [];
  const delta = readMetricDelta(value.delta);
  return {
    id,
    label: readString(value.label) ?? id,
    aggregation,
    tone: readString(value.tone) ?? undefined,
    ...(toneThresholds.length > 0 ? { toneThresholds } : {}),
    format: readString(value.format) ?? undefined,
    unit: readString(value.unit) ?? undefined,
    ...(typeof value.mono === 'boolean' ? { mono: value.mono } : {}),
    ...(delta ? { delta } : {}),
  };
}

function readMetricPresentation(value: unknown): VisualDatabaseMetricPresentation | undefined {
  if (!isRecord(value)) return undefined;
  const sparklineRaw = Array.isArray(value.sparkline) ? value.sparkline : [];
  const sparkline = sparklineRaw.filter((point): point is number => (
    typeof point === 'number' && Number.isFinite(point)
  ));
  const presentation: VisualDatabaseMetricPresentation = {
    emphasis: readString(value.emphasis) ?? undefined,
    trendValueId: readString(value.trendValueId ?? value.trend_value_id) ?? undefined,
    trendLabel: readString(value.trendLabel ?? value.trend_label) ?? undefined,
    asOf: readString(value.asOf ?? value.as_of) ?? undefined,
    comparison: readString(value.comparison) ?? undefined,
    ...(sparkline.length > 1 ? { sparkline } : {}),
  };
  return Object.values(presentation).some((entry) => entry !== undefined) ? presentation : undefined;
}

function readMetricDescriptor(value: unknown, index: number): VisualDatabaseMetricDescriptor | null {
  if (!isRecord(value)) return null;
  const atom = readString(value.atom);
  if (!atom) return null;
  const valuesRaw = Array.isArray(value.values) ? value.values : [];
  const values = valuesRaw
    .map(readMetricValueSpec)
    .filter((spec): spec is VisualDatabaseMetricValueSpec => spec !== null);
  if (values.length === 0) return null;
  return {
    id: readString(value.id) ?? `metric-${index}`,
    atom,
    label: readString(value.label) ?? undefined,
    ...(typeof value.max === 'number' && Number.isFinite(value.max) ? { max: value.max } : {}),
    band: readString(value.band) ?? undefined,
    caption: readString(value.caption) ?? undefined,
    presentation: readMetricPresentation(value.presentation),
    values,
  };
}

/** Decode a view's metric cards. Non-conforming entries drop at the boundary
 *  (same posture as every other view-state decoder). */
function readMetricDescriptors(value: unknown): readonly VisualDatabaseMetricDescriptor[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const metrics = value
    .map(readMetricDescriptor)
    .filter((metric): metric is VisualDatabaseMetricDescriptor => metric !== null);
  return metrics.length > 0 ? metrics : undefined;
}

/** Decode canvas-view spatial positions: an open map of recordViewKey → {x,y}.
 *  Entries with non-finite coordinates are dropped at the boundary (same
 *  posture as every other view-state decoder — never let bad data reach render). */
function readCanvasPositions(value: unknown): Readonly<Record<string, { x: number; y: number }>> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, { x: number; y: number }> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!isRecord(raw)) continue;
    const x = typeof raw.x === 'number' && Number.isFinite(raw.x) ? raw.x : null;
    const y = typeof raw.y === 'number' && Number.isFinite(raw.y) ? raw.y : null;
    if (x === null || y === null) continue;
    out[key] = { x, y };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Deterministic default placement for the Nth record on a canvas view: a
 *  reading-order grid derived from the card footprint. Pure — the same records
 *  always land in the same spots (no per-render scatter), so an unsaved board
 *  is stable and a saved position simply overrides its grid slot. */
export function canvasDefaultPosition(
  index: number,
  footprint: { w: number; h: number; gap: number; columns: number },
): { x: number; y: number } {
  const column = index % footprint.columns;
  const row = Math.floor(index / footprint.columns);
  return { x: column * (footprint.w + footprint.gap), y: row * (footprint.h + footprint.gap) };
}

function readActionDescriptor(value: unknown): VisualDatabaseActionDescriptor | null {
  if (!isRecord(value)) return null;
  const id = readString(value.id);
  const label = readString(value.label);
  if (!id || !label) return null;
  const promptsRaw = value.inputPrompts ?? value.input_prompts;
  const inputPrompts = Array.isArray(promptsRaw)
    ? promptsRaw
      .map((entry): VisualDatabaseActionPrompt | null => {
        if (!isRecord(entry)) return null;
        const key = readString(entry.key);
        if (!key) return null;
        const inputPathRaw = entry.inputPath ?? entry.input_path;
        let inputPath: string[] | undefined;
        if (entry.inputPath !== undefined || entry.input_path !== undefined) {
          const validPath = (path: unknown): path is string[] => Array.isArray(path) && path.length > 0
            && path.every(part => typeof part === 'string' && part.length > 0
              && !['__proto__', 'prototype', 'constructor'].includes(part));
          if (!validPath(inputPathRaw)
            || entry.inputPath !== undefined && !validPath(entry.inputPath)
            || entry.input_path !== undefined && !validPath(entry.input_path)
            || entry.inputPath !== undefined && entry.input_path !== undefined
              && JSON.stringify(entry.inputPath) !== JSON.stringify(entry.input_path)) {
            throw new TypeError(`Action prompt ${key} has an invalid input_path.`);
          }
          inputPath = [...inputPathRaw];
        }
        const optionsRaw = entry.options;
        const options = Array.isArray(optionsRaw)
          ? optionsRaw.map(readViewFilter).filter((filter): filter is VisualDatabaseViewFilter => filter !== null)
          : undefined;
        return {
          key,
          label: readString(entry.label) ?? humanizeSegment(key),
          options: options && options.length > 0 ? options : undefined,
          optional: entry.optional === true ? true : undefined,
          kind: readString(entry.kind) ?? undefined,
          inputPath,
          startFrom: readString(entry.startFrom ?? entry.start_from) ?? undefined,
          placeholder: readString(entry.placeholder) ?? undefined,
        };
      })
      .filter((entry): entry is VisualDatabaseActionPrompt => entry !== null)
    : [];
  const generateRaw = value.generate;
  const generate = Array.isArray(generateRaw)
    ? generateRaw
      .map((entry) => {
        if (!isRecord(entry)) return null;
        const key = readString(entry.key);
        const method = readString(entry.method ?? entry.kind);
        const params = isRecord(entry.params) ? entry.params : {};
        const prefix = readString(entry.prefix) ?? undefined;
        const normalizedParams = prefix && !Object.hasOwn(params, 'prefix') ? { ...params, prefix } : params;
        return key && method ? { key, method, params: normalizedParams } : null;
      })
      .filter((entry): entry is VisualDatabaseActionGeneratedInput => entry !== null)
    : [];
  const definitionIds = readStringArray(value.definitionIds ?? value.definition_ids);
  const copyRaw = value.copy ?? value.input_copy;
  const copy = Array.isArray(copyRaw)
    ? copyRaw
      .map((entry): VisualDatabaseActionInputCopy | null => {
        if (!isRecord(entry)) return null;
        const key = readString(entry.key);
        if (!key) return null;
        const from = readString(entry.from) ?? undefined;
        return {
          key,
          from,
          value: Object.hasOwn(entry, 'value') ? entry.value : undefined,
        };
      })
      .filter((entry): entry is VisualDatabaseActionInputCopy => entry !== null)
    : [];
  const hiddenWhenRaw = value.hiddenWhen ?? value.hidden_when;
  const hiddenWhenPath = isRecord(hiddenWhenRaw) && Array.isArray(hiddenWhenRaw.path)
    ? hiddenWhenRaw.path.filter((part): part is string => typeof part === 'string') : null;
  const whenRaw = value.when;
  const whenPath = isRecord(whenRaw) && Array.isArray(whenRaw.path)
    ? whenRaw.path.filter((part): part is string => typeof part === 'string') : null;
  return {
    id,
    label,
    target: readString(value.target) ?? undefined,
    operation: readString(value.operation) ?? undefined,
    definitionId: readString(value.definitionId ?? value.definition_id) ?? undefined,
    definitionIds,
    input: isRecord(value.input) ? value.input : undefined,
    copy,
    inputPrompts,
    fieldId: readString(value.fieldId ?? value.field_id) ?? undefined,
    valueKey: readString(value.valueKey ?? value.value_key) ?? undefined,
    generate,
    icon: readString(value.icon) ?? undefined,
    viewKinds: readStringArray(value.viewKinds ?? value.view_kinds ?? value.visible_in),
    acceptsLanes: readBoolean(value.acceptsLanes ?? value.accepts_lanes, true),
    hiddenWhen: hiddenWhenPath ? { path: hiddenWhenPath, equals: (hiddenWhenRaw as Record<string, unknown>).equals } : undefined,
    when: whenPath ? { path: whenPath, equals: (whenRaw as Record<string, unknown>).equals } : undefined,
  };
}

function readListContainer(value: unknown, key: string): readonly unknown[] {
  if (Array.isArray(value)) return value;
  if (isRecord(value) && Array.isArray(value[key])) return value[key] as readonly unknown[];
  return [];
}

/** Explicit descriptors come ONLY from the fields data record. With no data
 *  present the Physics fallback is shape discovery (`discoverFieldDescriptors`
 *  via the model merge) — code ships zero field vocabulary. */
export function decodeVisualDatabaseFields(raw: unknown): readonly VisualDatabaseFieldDescriptor[] {
  return readListContainer(raw, 'descriptors')
    .map(readFieldDescriptor)
    .filter((descriptor): descriptor is VisualDatabaseFieldDescriptor => descriptor !== null);
}

/** Views come ONLY from the views data record. With no data present the
 *  Physics fallback is a single unscoped list — the honest empty state. */
const FALLBACK_VIEW: VisualDatabaseViewDescriptor = {
  id: 'all',
  label: 'All Records',
  kind: 'list',
  order: 0,
  filters: [],
  projectionRules: [],
};

export function decodeVisualDatabaseViews(raw: unknown): readonly VisualDatabaseViewDescriptor[] {
  const descriptors = readListContainer(raw, 'views')
    .map(readViewDescriptor)
    .filter((descriptor): descriptor is VisualDatabaseViewDescriptor => descriptor !== null)
    .sort((left, right) => left.order - right.order || left.label.localeCompare(right.label));
  return descriptors.length > 0 ? descriptors : [FALLBACK_VIEW];
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

function readViewIdentity(value: unknown): VisualDatabaseViewIdentity | null {
  if (!isRecord(value)) return null;
  const viewId = readString(value.viewId ?? value.view_id);
  const viewRecordSha256 = readString(value.viewRecordSha256 ?? value.view_record_sha256);
  const sourceDatasetAddress = readString(value.sourceDatasetAddress ?? value.source_dataset_address);
  const datasetPayloadSha256 = readString(value.datasetPayloadSha256 ?? value.dataset_payload_sha256);
  const selectedModelSha256 = readString(value.selectedModelSha256 ?? value.selected_model_sha256);
  return viewId
    && sourceDatasetAddress
    && viewRecordSha256 && SHA256_HEX.test(viewRecordSha256)
    && datasetPayloadSha256 && SHA256_HEX.test(datasetPayloadSha256)
    && selectedModelSha256 && SHA256_HEX.test(selectedModelSha256)
    ? {
        viewId,
        viewRecordSha256,
        sourceDatasetAddress,
        datasetPayloadSha256,
        selectedModelSha256,
      }
    : null;
}

function readViewDataset(value: unknown): VisualDatabaseViewDataset | null {
  if (!isRecord(value)) return null;
  const address = readString(value.address);
  return address && isRecord(value.payload) ? { address, payload: value.payload } : null;
}

/** Decode one ordinary DATA workspace. It is an open container: view identity,
 * source-dataset membership, and integrity all come from DATA, while invalid
 * rows are dropped at the read boundary. */
export function decodeVisualDatabaseViewWorkspace(raw: unknown): VisualDatabaseViewWorkspace {
  return {
    views: readListContainer(raw, 'views')
      .map(readViewDescriptor)
      .filter((view): view is VisualDatabaseViewDescriptor => view !== null),
    identities: readListContainer(raw, 'identities')
      .map(readViewIdentity)
      .filter((identity): identity is VisualDatabaseViewIdentity => identity !== null),
    datasets: readListContainer(raw, 'datasets')
      .map(readViewDataset)
      .filter((dataset): dataset is VisualDatabaseViewDataset => dataset !== null),
  };
}

/** Resolve only an exact, already-loaded direct view. Duplicate identities,
 * missing datasets, fuzzy kind matches, and ordinary navigation views all fail
 * closed instead of selecting an unintended model. */
export function selectVisualDatabaseViewWorkspace(
  workspace: VisualDatabaseViewWorkspace,
  requestedViewId: string | undefined,
): VisualDatabaseViewWorkspaceSelection | null {
  if (!requestedViewId) return null;
  const views = workspace.views.filter((view) => view.id === requestedViewId && view.visibility === 'direct');
  if (views.length !== 1) return null;
  const view = views[0]!;
  if (!view.sourceDatasetAddress) return null;
  const identities = workspace.identities.filter((identity) => (
    identity.viewId === view.id
    && identity.sourceDatasetAddress === view.sourceDatasetAddress
  ));
  const datasets = workspace.datasets.filter((dataset) => dataset.address === view.sourceDatasetAddress);
  return identities.length === 1 && datasets.length === 1
    ? { view, identity: identities[0]!, dataset: datasets[0]! }
    : null;
}

/** Build the model-view input for one exact direct selection. Ordinary views
 * remain loaded by their own input but do not cross the selected dataset
 * boundary; ordinary palette DATA is preserved. */
export function visualDatabaseViewsWithSelection(
  raw: unknown,
  selectedView: VisualDatabaseViewDescriptor | undefined,
): unknown {
  if (!selectedView) return raw;
  return {
    kind: 'visual-database.views',
    version: 2,
    views: [selectedView],
    ...(isRecord(raw) && Array.isArray(raw.palette) ? { palette: raw.palette } : {}),
  };
}

function datasetRows(raw: unknown): readonly unknown[] {
  return readListContainer(raw, 'records');
}

function datasetRowAddress(value: unknown): string | null {
  return isRecord(value) ? readString(value.address ?? value.address_label ?? value.addressLabel) : null;
}

function datasetRowCellRef(value: unknown): { recordRef: string; fieldRef: string; family: string } | null {
  if (!isRecord(value) || !isRecord(value.payload)) return null;
  const payload = value.payload;
  const ref = isRecord(payload.cell_ref) ? payload.cell_ref : isRecord(payload.cellRef) ? payload.cellRef : null;
  if (!ref) return null;
  const recordRef = readString(ref.record_ref ?? ref.recordRef);
  const fieldRef = readString(ref.field_ref ?? ref.fieldRef);
  const family = Object.prototype.hasOwnProperty.call(payload, 'expression')
    ? 'source'
    : Object.prototype.hasOwnProperty.call(payload, 'cached_value')
      || Object.prototype.hasOwnProperty.call(payload, 'cachedValue')
      ? 'cache'
      : Object.prototype.hasOwnProperty.call(payload, 'provenance_ref')
        || Object.prototype.hasOwnProperty.call(payload, 'provenanceRef')
        ? 'provenance'
        : 'value';
  return recordRef && fieldRef ? { recordRef, fieldRef, family } : null;
}

function datasetRowKey(value: unknown, index: number): string {
  const address = datasetRowAddress(value);
  if (address) return `address:${address}`;
  const ref = datasetRowCellRef(value);
  return ref ? `cell:${JSON.stringify([ref.recordRef, ref.fieldRef, ref.family])}` : `row:${index}:${JSON.stringify(value)}`;
}

/** Materialize a dataset's static rows plus matching live owner rows. Exact
 * addresses and member record refs are ordinary membership DATA. Unrelated
 * global records never leak into a bound dataset; matching live rows replace
 * their static baseline by durable identity. */
export function recordsForVisualDatabaseDataset(
  dataset: VisualDatabaseViewDataset,
  liveRecords: unknown,
): readonly unknown[] {
  const baseRows = datasetRows(dataset.payload);
  const members = isRecord(dataset.payload.members) ? dataset.payload.members : null;
  const addresses = new Set(readStringArray(members?.addresses));
  const recordRefs = new Set(readStringArray(members?.recordRefs ?? members?.record_refs));
  const liveRows = datasetRows(liveRecords).filter((row) => {
    const address = datasetRowAddress(row);
    if (address && addresses.has(address)) return true;
    const ref = datasetRowCellRef(row);
    return !!ref && recordRefs.has(ref.recordRef);
  });
  const merged = new Map<string, unknown>();
  baseRows.forEach((row, index) => merged.set(datasetRowKey(row, index), row));
  liveRows.forEach((row, index) => merged.set(datasetRowKey(row, baseRows.length + index), row));
  return [...merged.values()];
}

export function decodeVisualDatabaseActions(raw: unknown): readonly VisualDatabaseActionDescriptor[] {
  return readListContainer(raw, 'actions')
    .map(readActionDescriptor)
    .filter((descriptor): descriptor is VisualDatabaseActionDescriptor => descriptor !== null);
}

/** The built-in maximally-capable default grid-property set (L083). This is the
 *  code fallback exactly like FALLBACK_VIEW — the SSOT is the DATA at address
 *  `visual-database.grid-properties`, which overrides these rows when present. Each
 *  row is self-describing DATA the blind surface renders; adding an aspect adds a
 *  row here or in DATA, ZERO surface code. Deletion test: replace this array with
 *  a totally different set (row-height, box-shadow, freeze) → grid works unchanged. */
export const DEFAULT_GRID_PROPERTIES: readonly VisualDatabaseGridPropertyDescriptor[] = [
  // ---- the user's 3 examples, now pure DATA rows ----
  { key: 'width', label: 'Column width', scope: 'column', apply: 'style', widget: 'slider', cssProp: 'width', unit: 'px', valueKind: 'number', min: 60, max: 640, step: 8 },
  { key: 'borderRight', label: 'Column divider line', scope: 'column', apply: 'style', widget: 'toggle', cssProp: 'borderRight', options: [{ value: 'none', label: 'Off' }, { value: '1px solid var(--border-primary)', label: 'On' }] },
  { key: 'borderRadius', label: 'Cell corner radius', scope: 'column', apply: 'style', widget: 'slider', cssProp: 'borderRadius', unit: 'px', valueKind: 'number', min: 0, max: 24, step: 1 },
  // ---- emergent aspects the SAME primitive unlocks (fixes "labels are small") ----
  { key: 'headerFontSize', label: 'Header label size', scope: 'column', apply: 'style', widget: 'segmented', cssProp: 'fontSize', valueKind: 'string', options: [{ value: '11px', label: 'S' }, { value: '13px', label: 'M' }, { value: '15px', label: 'L' }] },
  { key: 'textAlign', label: 'Column alignment', scope: 'column', apply: 'style', widget: 'segmented', cssProp: 'textAlign', valueKind: 'string', options: [{ value: 'left', label: 'Left' }, { value: 'center', label: 'Center' }, { value: 'right', label: 'Right' }] },
  { key: 'fontWeight', label: 'Column text weight', scope: 'column', apply: 'style', widget: 'segmented', cssProp: 'fontWeight', valueKind: 'string', options: [{ value: '400', label: 'Normal' }, { value: '600', label: 'Bold' }] },
  { key: 'rowDensity', label: 'Row density', scope: 'grid', apply: 'style', widget: 'segmented', cssProp: '--visual-database-row-padding-block', valueKind: 'string', defaultValue: '8px', options: [{ value: '3px', label: 'Compact' }, { value: '8px', label: 'Comfortable' }, { value: '14px', label: 'Spacious' }] },
  { key: 'rowHeight', label: 'Row height', scope: 'grid', apply: 'style', widget: 'slider', cssProp: 'lineHeight', unit: 'px', valueKind: 'number', min: 24, max: 72, step: 2 },
  // ---- BEYOND-UI behavioral aspects (same primitive, apply != 'style') ----
  { key: 'formatWhen', label: 'Highlight cells that are…', scope: 'column', apply: 'format', widget: 'select', valueKind: 'string', options: [{ value: 'empty', label: 'Empty → warn' }, { value: 'nonempty', label: 'Filled → good' }] },
  { key: 'validate', label: 'Cells must be…', scope: 'column', apply: 'validate', widget: 'select', valueKind: 'string', options: [{ value: 'nonempty', label: 'Required (not empty)' }, { value: 'number', label: 'A number' }] },
];

/** Grid-property descriptors come from DATA (address `visual-database.grid-properties`);
 *  absent DATA falls back to the built-in default set (FALLBACK_VIEW pattern).
 *  The view-level row-density property remains available as a core table control. */
export function decodeVisualDatabaseGridProperties(raw: unknown): readonly VisualDatabaseGridPropertyDescriptor[] {
  const descriptors = readGridPropertyDescriptors(readListContainer(raw, 'gridProperties'));
  if (descriptors.length === 0) return DEFAULT_GRID_PROPERTIES;
  // The view-level row-density control is a core Library affordance. Keep its
  // generic property descriptor available when a package supplies a narrower
  // grid-properties set, while allowing that package to replace its DATA row.
  if (descriptors.some((descriptor) => descriptor.key === 'rowDensity')) return descriptors;
  const rowDensity = DEFAULT_GRID_PROPERTIES.find((descriptor) => descriptor.key === 'rowDensity');
  return rowDensity ? [...descriptors, rowDensity] : descriptors;
}

// -----------------------------------------------------------------------------
// Field discovery — the no-descriptor default
// -----------------------------------------------------------------------------

/** Union of observed value keys (depth 1), each emitted as a complete
 *  descriptor with shape derived per value. Records carrying a `payload`
 *  object contribute its keys (read at ['payload', key]); records without one
 *  contribute their own top-level keys (read at [key]). Nothing is read-only
 *  by default. */
export function discoverFieldDescriptors(records: readonly VisualDatabaseRecord[]): readonly VisualDatabaseFieldDescriptor[] {
  const payloadKeys = new Set<string>();
  const rowKeys = new Set<string>();
  for (const record of records) {
    const source = recordReadSource(record);
    if (!isRecord(source)) continue;
    const payload = source.payload;
    if (isRecord(payload)) {
      for (const key of Object.keys(payload)) payloadKeys.add(key);
    } else {
      for (const key of Object.keys(source)) {
        if (key !== 'payload') rowKeys.add(key);
      }
    }
  }
  return [...new Set([...payloadKeys, ...rowKeys])].sort().map((key) => ({
    id: key,
    label: humanizeSegment(key),
    role: 'none',
    paths: [
      ...(payloadKeys.has(key) ? [['payload', key] as const] : []),
      ...(rowKeys.has(key) ? [[key] as const] : []),
    ],
    source: 'discovered',
  }));
}

function pathCoversKey(path: readonly string[], key: string): boolean {
  return (path.length === 1 && path[0] === key)
    || (path.length === 2 && path[0] === 'payload' && path[1] === key);
}

/** Deterministic merge: explicit descriptors first; discovered descriptors
 *  appended only for keys no explicit descriptor already reads. */
export function mergeFieldDescriptors(
  explicit: readonly VisualDatabaseFieldDescriptor[],
  discovered: readonly VisualDatabaseFieldDescriptor[],
): readonly VisualDatabaseFieldDescriptor[] {
  const extras = discovered.filter((candidate) => !explicit.some((descriptor) => (
    descriptor.id === candidate.id || descriptor.paths.some((path) => pathCoversKey(path, candidate.id))
  )));
  return extras.length === 0 ? explicit : [...explicit, ...extras];
}

// -----------------------------------------------------------------------------
// Filters and search — any descriptor is a filter target
// -----------------------------------------------------------------------------

function descriptorsForFilterField(
  field: string,
  fields: readonly VisualDatabaseFieldDescriptor[],
): readonly VisualDatabaseFieldDescriptor[] {
  const byId = fields.find((descriptor) => descriptor.id === field);
  if (byId) return [byId];
  const byRole = fields.filter((descriptor) => descriptor.role === field);
  if (byRole.length > 0) return byRole;
  return [syntheticFieldDescriptor(field)];
}

function matchesFilter(
  record: VisualDatabaseRecord,
  filter: VisualDatabaseViewFilter,
  fields: readonly VisualDatabaseFieldDescriptor[],
): boolean {
  const values = descriptorsForFilterField(filter.field, fields)
    .flatMap((descriptor) => extractFieldText(record, descriptor))
    .map((value) => value.toLowerCase());
  if (filter.exclude.length > 0 && filter.exclude.some((entry) => values.includes(entry.toLowerCase()))) {
    return false;
  }
  if (filter.equals.length > 0 && !filter.equals.some((entry) => values.includes(entry.toLowerCase()))) {
    return false;
  }
  return true;
}

/** Feed records passing a set of data-defined filters, projected as domain
 *  values (id/ref = durable address, label = title). One blind shape serves
 *  domain.fromRecords, action prompt options, and anything data invents next. */
export function optionsFromRecords(
  filters: readonly VisualDatabaseViewFilter[],
  records: readonly VisualDatabaseRecord[],
  fields: readonly VisualDatabaseFieldDescriptor[],
  detailDescriptors: readonly VisualDatabaseFieldDomainDetailDescriptor[] = [],
): readonly VisualDatabaseFieldDomainValue[] {
  return records
    .filter((record) => filters.every((filter) => matchesFilter(record, filter, fields)))
    .map((record, index) => ({
      id: record.id,
      label: record.title,
      tone: 'neutral',
      order: index,
      ref: record.id,
      details: projectDomainDetails(record, detailDescriptors),
    }));
}

function projectDomainDetails(
  record: VisualDatabaseRecord,
  descriptors: readonly VisualDatabaseFieldDomainDetailDescriptor[],
): readonly VisualDatabaseFieldDomainDetail[] {
  if (descriptors.length === 0) return [];
  const details: VisualDatabaseFieldDomainDetail[] = [];
  for (const descriptor of descriptors) {
    const value = descriptor.paths
      .map((path) => valueToText(readPathValue(record.raw, path)))
      .find((entry): entry is string => Boolean(entry));
    if (!value) continue;
    details.push({
      id: descriptor.id,
      label: descriptor.label,
      value,
      role: descriptor.role,
      ref: record.id,
    });
  }
  return details;
}

/** Records scoped to a view by its data-defined filters. No filters = all records. */
export function recordsForView(
  view: VisualDatabaseViewDescriptor,
  records: readonly VisualDatabaseRecord[],
  fields: readonly VisualDatabaseFieldDescriptor[] = [],
): readonly VisualDatabaseRecord[] {
  if (view.filters.length === 0) return records;
  return records.filter((record) => view.filters.every((filter) => matchesFilter(record, filter, fields)));
}

/** Search ranges over every descriptor's extracted text. */
export function searchRecords(
  records: readonly VisualDatabaseRecord[],
  query: string,
  fields: readonly VisualDatabaseFieldDescriptor[],
): readonly VisualDatabaseRecord[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return records;
  return records.filter((record) => (
    record.id.toLowerCase().includes(normalized)
    || record.title.toLowerCase().includes(normalized)
    || fields.some((descriptor) => extractFieldText(record, descriptor)
      .some((text) => text.toLowerCase().includes(normalized)))
  ));
}

// -----------------------------------------------------------------------------
// Ordering — total deterministic comparator over mixed legacy/new sort values
// -----------------------------------------------------------------------------

/** Numbers sort first (numeric), strings second (lexicographic — fractional
 *  order keys live here), missing values last. Total and deterministic. */
export function compareSortValues(a: unknown, b: unknown): number {
  const aNumber = typeof a === 'number' && Number.isFinite(a);
  const bNumber = typeof b === 'number' && Number.isFinite(b);
  if (aNumber && bNumber) return (a as number) - (b as number);
  if (aNumber) return -1;
  if (bNumber) return 1;
  const aText = typeof a === 'string' && a.length > 0;
  const bText = typeof b === 'string' && b.length > 0;
  if (aText && bText) return a === b ? 0 : (a as string) < (b as string) ? -1 : 1;
  if (aText) return -1;
  if (bText) return 1;
  return 0;
}

// -----------------------------------------------------------------------------
// Record normalization and model decode
// -----------------------------------------------------------------------------

/** A scoped `record_from_matching_records` json_array feed emits rows shaped
 *  `{record:{address,source_package}, payload}`; the `published-records`
 *  aggregate (cell_table) emits `{address, payload}`. Flatten the former to the
 *  latter so a board fed by EITHER a scoped per-board feed (e.g.
 *  `address contains "crm::record"`) or the global aggregate decodes identically
 *  — one row shape downstream (SSOT, L098). This is the L126 enabling change:
 *  each board embedder can now point its `records` input at a scoped per-board
 *  feed instead of the 34.7MB aggregate, with zero change to the rest of the
 *  decode. */
export function flattenScopedFeedRow(row: unknown): unknown {
  if (
    isRecord(row)
    && !('address' in row)
    && isRecord(row.record)
    && typeof row.record.address === 'string'
  ) {
    return { address: row.record.address, payload: (row as { payload?: unknown }).payload };
  }
  return row;
}

function readRawRecordRows(raw: unknown): readonly unknown[] {
  let rows: readonly unknown[];
  if (Array.isArray(raw)) rows = raw;
  else if (!isRecord(raw)) return [];
  else if (Array.isArray(raw.records)) rows = raw.records;
  else if (Array.isArray(raw.items)) rows = raw.items;
  else if (Array.isArray(raw.rows)) rows = raw.rows;
  else return [];
  return rows.map(flattenScopedFeedRow);
}

const UNREADABLE_RECORD_ROW = Symbol('unreadable-record-row');

function materializeRecordValue(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;
  if (depth > 8) return value;
  if (Array.isArray(value)) {
    const entries: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const materialized = materializeRecordValue(value[index], depth + 1);
      if (materialized === UNREADABLE_RECORD_ROW) return UNREADABLE_RECORD_ROW;
      entries.push(materialized);
    }
    return entries;
  }
  if (!isRecord(value)) return value;
  const plain: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    let entry: unknown;
    try {
      entry = value[key];
    } catch {
      return UNREADABLE_RECORD_ROW;
    }
    const materialized = materializeRecordValue(entry, depth + 1);
    if (materialized === UNREADABLE_RECORD_ROW) return UNREADABLE_RECORD_ROW;
    plain[key] = materialized;
  }
  return plain;
}

function recordSource(row: unknown, index: number): Record<string, unknown> {
  const materialized = materializeRecordValue(row);
  if (materialized === UNREADABLE_RECORD_ROW) {
    throw new Error('record row is unreadable');
  }
  if (!isRecord(materialized)) {
    return { id: `record-${index}`, payload: materialized };
  }
  return materialized;
}

function firstRoleValue(
  source: unknown,
  descriptors: readonly VisualDatabaseFieldDescriptor[],
  role: string,
): unknown {
  for (const descriptor of descriptors) {
    if (descriptor.role !== role) continue;
    for (const path of descriptor.paths) {
      const value = readPathValue(source, path);
      if (value !== undefined && value !== null && valueToText(value) !== null) return value;
    }
  }
  return null;
}

function allRoleText(
  source: unknown,
  descriptors: readonly VisualDatabaseFieldDescriptor[],
  role: string,
): readonly string[] {
  const values: string[] = [];
  for (const descriptor of descriptors) {
    if (descriptor.role !== role) continue;
    for (const path of descriptor.paths) {
      const text = valueToText(readPathValue(source, path));
      if (text) values.push(text);
    }
  }
  return [...new Set(values)];
}

function laneFromValue(value: unknown): VisualDatabaseLaneDescriptor {
  const id = valueToText(value) ?? EMPTY_LANE.id;
  return id === EMPTY_LANE.id
    ? EMPTY_LANE
    : { id, label: id, order: 1000, tone: 'neutral', details: [] };
}

function normalizeRecord(
  row: unknown,
  index: number,
  fields: readonly VisualDatabaseFieldDescriptor[],
): VisualDatabaseRecord | null {
  let source: Record<string, unknown>;
  try {
    source = recordSource(row, index);
  } catch {
    return null;
  }
  const id = valueToText(firstRoleValue(source, fields, 'id')) ?? `record-${index}`;
  const title = valueToText(firstRoleValue(source, fields, 'title')) ?? id;
  const body = valueToText(firstRoleValue(source, fields, 'body')) ?? '';
  const kind = valueToText(firstRoleValue(source, fields, 'kind')) ?? 'record';
  const group = valueToText(firstRoleValue(source, fields, 'group')) ?? kind;
  const lane = laneFromValue(firstRoleValue(source, fields, 'lane'));
  const date = valueToText(firstRoleValue(source, fields, 'date'));
  const sort = firstRoleValue(source, fields, 'sort');
  return {
    id,
    title,
    body,
    kind,
    group,
    lane,
    date,
    sort,
    badges: allRoleText(source, fields, 'badge'),
    links: allRoleText(source, fields, 'link'),
    raw: source,
  };
}

// -----------------------------------------------------------------------------
// Grouping axis — lanes dissolve into "group-by any descriptor"
// -----------------------------------------------------------------------------

/** The canonical grouping projection rule for this view. The operation is
 * open DATA; the renderer only interprets the generic `view-group` operation. */
export function groupingRuleForView(
  view: VisualDatabaseViewDescriptor,
): VisualDatabaseProjectionRuleDescriptor | null {
  return [...view.projectionRules]
    .sort((a, b) => a.order - b.order)
    .find((rule) => rule.operation === 'view-group') ?? null;
}

/** Replace the grouping source without carrying value overrides from a
 * different field. Unrelated projection rules and open params are preserved. */
export function withViewGrouping(
  view: VisualDatabaseViewDescriptor,
  descriptorId: string,
): VisualDatabaseViewDescriptor {
  const current = groupingRuleForView(view);
  const { valueOverrides: _valueOverrides, value_overrides: _snakeOverrides, ...remainingParams } = current?.params ?? {};
  const replacement: VisualDatabaseProjectionRuleDescriptor = {
    ...(current ?? { id: 'grouping', operation: 'view-group', order: view.projectionRules.length }),
    operation: 'view-group',
    sourceFieldId: descriptorId,
    sourceRole: undefined,
    params: Object.keys(remainingParams).length > 0 ? remainingParams : undefined,
  };
  return {
    ...view,
    projectionRules: current
      ? view.projectionRules.map((rule) => (rule === current ? replacement : rule))
      : [...view.projectionRules, replacement],
  };
}

function groupingValueOverrides(view: VisualDatabaseViewDescriptor): readonly VisualDatabaseLaneDescriptor[] {
  const rule = groupingRuleForView(view);
  const raw = rule?.params?.valueOverrides ?? rule?.params?.value_overrides;
  return Array.isArray(raw)
    ? raw.map(readDomainValue).filter((value): value is VisualDatabaseLaneDescriptor => value !== null)
    : [];
}

/** The descriptor currently bound as the grouping axis. The canonical
 * `view-group` rule can name any field id or semantic field role. */
export function groupingDescriptorForView(
  view: VisualDatabaseViewDescriptor,
  fields: readonly VisualDatabaseFieldDescriptor[],
): VisualDatabaseFieldDescriptor | null {
  const rule = groupingRuleForView(view);
  if (rule?.sourceFieldId) {
    return fields.find((descriptor) => descriptor.id === rule.sourceFieldId)
      ?? syntheticFieldDescriptor(rule.sourceFieldId);
  }
  const role = rule?.sourceRole ?? 'lane';
  return fields.find((descriptor) => descriptor.role === role) ?? null;
}

/** Which grouping column(s) a record belongs to. Multi-valued fields place the
 *  record in the column of EACH value; no value = the empty column. */
export function recordGroupValues(
  record: VisualDatabaseRecord,
  grouping: VisualDatabaseFieldDescriptor | null,
): readonly string[] {
  if (!grouping || grouping.role === 'lane') return [record.lane.id];
  const texts = extractFieldText(record, grouping);
  return texts.length > 0 ? texts : [EMPTY_LANE_ID];
}

/** Domain resolution for the grouping axis: declared domain, then canonical
 *  rule value overrides (which win on label/tone/order), then every observed
 *  value preserved as an ad-hoc entry. */
export function lanesForView(
  view: VisualDatabaseViewDescriptor,
  records: readonly VisualDatabaseRecord[],
  fields: readonly VisualDatabaseFieldDescriptor[] = [],
  domains?: Readonly<Record<string, unknown>>,
): readonly VisualDatabaseLaneDescriptor[] {
  const grouping = groupingDescriptorForView(view, fields);
  const lanes = new Map<string, VisualDatabaseLaneDescriptor>();
  if (grouping) {
    for (const value of declaredDomainValues(grouping, records, fields, domains)) {
      lanes.set(value.id, value);
    }
  }
  for (const lane of groupingValueOverrides(view)) {
    lanes.set(lane.id, lane);
  }
  for (const record of records) {
    if (!grouping || grouping.role === 'lane') {
      if (!lanes.has(record.lane.id)) lanes.set(record.lane.id, record.lane);
      continue;
    }
    for (const id of recordGroupValues(record, grouping)) {
      if (lanes.has(id)) continue;
      lanes.set(id, id === EMPTY_LANE_ID ? EMPTY_LANE : adHocDomainValue(id));
    }
  }
  if (lanes.size === 0) lanes.set(EMPTY_LANE.id, EMPTY_LANE);
  const empty = lanes.get(EMPTY_LANE_ID);
  if (empty && grouping?.emptyLabel) {
    lanes.set(EMPTY_LANE_ID, { ...empty, label: grouping.emptyLabel });
  }
  return sortDomainValues(lanes.values());
}

// -----------------------------------------------------------------------------
// Trees from link fields — hierarchy as pure projection
// -----------------------------------------------------------------------------

/** Tree projection plus an O(1) node index. `nodeByKey` is keyed by
 *  `recordIdentityKey` (address ?? id) — the same key every consumer derives
 *  for a record, so child lookups never walk the forest. */
export interface VisualDatabaseTreeProjection {
  roots: readonly VisualDatabaseTreeNode[];
  nodeByKey: ReadonlyMap<string, VisualDatabaseTreeNode>;
}

/** Identity-keyed memo: one projection per (records array, link descriptor)
 *  pair. Consumers call per-record helpers (sub-counts, child lists) N times
 *  per render; without this memo each call rebuilt the whole forest — O(n²)
 *  at list scale (4418 records ≈ 19.5M map operations = a frozen tab). The
 *  records array reference rotates iff content changed (decode is memoized on
 *  store revision), so identity is a correct cache key. */
const treeProjectionMemo = new WeakMap<object, WeakMap<VisualDatabaseFieldDescriptor, VisualDatabaseTreeProjection>>();

export function treeProjectionForRecords(
  records: readonly VisualDatabaseRecord[],
  linkDescriptor: VisualDatabaseFieldDescriptor,
): VisualDatabaseTreeProjection {
  let byDescriptor = treeProjectionMemo.get(records);
  if (!byDescriptor) {
    byDescriptor = new WeakMap();
    treeProjectionMemo.set(records, byDescriptor);
  }
  const cached = byDescriptor.get(linkDescriptor);
  if (cached) return cached;
  const built = buildTreeProjection(records, linkDescriptor);
  byDescriptor.set(linkDescriptor, built);
  return built;
}

/** Project flat records into a forest through a link descriptor. Orphans
 *  (parent outside the scoped set) root themselves; cycles of any length are
 *  cut at revisit and their members lift to root. */
export function treeForRecords(
  records: readonly VisualDatabaseRecord[],
  linkDescriptor: VisualDatabaseFieldDescriptor,
): { roots: readonly VisualDatabaseTreeNode[] } {
  return { roots: treeProjectionForRecords(records, linkDescriptor).roots };
}

function buildTreeProjection(
  records: readonly VisualDatabaseRecord[],
  linkDescriptor: VisualDatabaseFieldDescriptor,
): VisualDatabaseTreeProjection {
  const byKey = new Map<string, VisualDatabaseRecord>();
  const indexKey = (key: string, record: VisualDatabaseRecord) => {
    for (const alias of recordIdentityAliases(key)) {
      if (!byKey.has(alias)) byKey.set(alias, record);
    }
  };
  for (const record of records) {
    indexKey(recordIdentityKey(record), record);
    indexKey(record.id, record);
    const address = recordAddress(record);
    if (address) indexKey(address, record);
  }
  const childrenOf = new Map<string, VisualDatabaseRecord[]>();
  const hasParent = new Set<string>();
  for (const record of records) {
    const recordKey = recordIdentityKey(record);
    const parent = extractFieldPathText(record, linkDescriptor)
      .map((link) => byKey.get(link))
      .find((candidate): candidate is VisualDatabaseRecord => candidate !== undefined);
    if (!parent || recordIdentityKey(parent) === recordKey) continue;
    hasParent.add(recordKey);
    const parentKey = recordIdentityKey(parent);
    const siblings = childrenOf.get(parentKey);
    if (siblings) siblings.push(record);
    else childrenOf.set(parentKey, [record]);
  }
  const visited = new Set<string>();
  const nodeByKey = new Map<string, VisualDatabaseTreeNode>();
  function build(record: VisualDatabaseRecord, depth: number): VisualDatabaseTreeNode {
    const recordKey = recordIdentityKey(record);
    visited.add(recordKey);
    const children = (childrenOf.get(recordKey) ?? [])
      .filter((child) => !visited.has(recordIdentityKey(child)))
      .map((child) => build(child, depth + 1));
    const node = { record, depth, children };
    nodeByKey.set(recordKey, node);
    return node;
  }
  const roots: VisualDatabaseTreeNode[] = [];
  for (const record of records) {
    const recordKey = recordIdentityKey(record);
    if (!hasParent.has(recordKey) && !visited.has(recordKey)) roots.push(build(record, 0));
  }
  for (const record of records) {
    if (!visited.has(recordIdentityKey(record))) roots.push(build(record, 0));
  }
  return { roots, nodeByKey };
}

// -----------------------------------------------------------------------------
// Model decode — pure, memoized on input identity
// -----------------------------------------------------------------------------
//
// Reference-identity memo is CORRECT here: `useBitfieldData` now returns a
// per-revision PUBLIC value identity (Runtime Kit address-value-store
// `snapshotValueIdentity` / `readPublicValue` — see the reactive-read-identity
// primitive). The retained cell_table rows projection still mutates its internal
// array in place for zero-alloc, but the value handed to this decode rotates its
// reference iff the store revision advanced. So `memoInput.records === input.records`
// busts on real content change (re-decode) and hits on unrelated re-renders (skip
// the full decode) — fast AND correct. Previously this memo froze the open tab
// because the SDK handed back a stable reference for changed content.

let memoInput: DecodeVisualDatabaseInput | null = null;
let memoModel: VisualDatabaseModel | null = null;

export function decodeVisualDatabaseModel(input: DecodeVisualDatabaseInput): VisualDatabaseModel {
  if (
    memoInput && memoModel
    && memoInput.records === input.records
    && memoInput.fields === input.fields
    && memoInput.views === input.views
    && memoInput.actions === input.actions
    && memoInput.gridProperties === input.gridProperties
    && memoInput.domains === input.domains
  ) {
    return memoModel;
  }
  const explicit = decodeVisualDatabaseFields(input.fields);
  const views = decodeVisualDatabaseViews(input.views);
  const actions = decodeVisualDatabaseActions(input.actions);
  const gridProperties = decodeVisualDatabaseGridProperties(input.gridProperties);
  // The model holds ONLY human records. Engine/system state on the published
  // feed never enters: not as rows, not as discovered fields, not as ad-hoc
  // domain values. One gate at the decode boundary covers the whole category.
  const records = readRawRecordRows(input.records)
    .map((row, index) => normalizeRecord(row, index, explicit))
    .filter((record): record is VisualDatabaseRecord => record !== null)
    .filter(isHumanRecord)
    .sort((left, right) => compareSortValues(left.sort, right.sort)
      || left.title.localeCompare(right.title)
      || left.id.localeCompare(right.id));
  const fields = mergeFieldDescriptors(explicit, discoverFieldDescriptors(records));
  const palette = isRecord(input.views) ? readPalette(input.views.palette) : [];
  const model: VisualDatabaseModel = { records, fields, views, actions, palette, gridProperties, domains: input.domains };
  memoInput = { ...input };
  memoModel = model;
  return model;
}

export function actionVisibleForView(action: VisualDatabaseActionDescriptor, view: VisualDatabaseViewDescriptor): boolean {
  return action.viewKinds.length === 0 || action.viewKinds.includes(view.kind) || action.viewKinds.includes(view.id);
}

// -----------------------------------------------------------------------------
// Record-view projection — one renderer-agnostic surface for every view shape
// -----------------------------------------------------------------------------

function selectedViewForProjection(
  model: VisualDatabaseModel,
  requested: string | VisualDatabaseViewDescriptor | undefined,
): VisualDatabaseViewDescriptor {
  if (typeof requested === 'string') {
    return model.views.find((view) => view.id === requested || view.kind === requested) ?? model.views[0] ?? FALLBACK_VIEW;
  }
  return requested ?? model.views[0] ?? FALLBACK_VIEW;
}

function descriptorForProjectionRule(
  rule: VisualDatabaseProjectionRuleDescriptor,
  model: VisualDatabaseModel,
  view: VisualDatabaseViewDescriptor,
): VisualDatabaseFieldDescriptor | null {
  if (rule.sourceFieldId) {
    return model.fields.find((descriptor) => descriptor.id === rule.sourceFieldId)
      ?? syntheticFieldDescriptor(rule.sourceFieldId);
  }
  if (rule.sourceRole) {
    return model.fields.find((descriptor) => descriptor.role === rule.sourceRole)
      ?? syntheticFieldDescriptor(rule.sourceRole);
  }
  if (rule.operation === 'view-group' || rule.operation === 'field-domain') {
    return groupingDescriptorForView(view, model.fields);
  }
  return null;
}

function projectionWritePath(descriptor: VisualDatabaseFieldDescriptor): readonly string[] | null {
  const raw = descriptor.writePath
    ?? descriptor.paths.find((path) => path[0] === 'payload')
    ?? (descriptor.paths[0] ? ['payload', ...descriptor.paths[0]] : null);
  return raw && raw.length > 0 ? raw : null;
}

function sectionKey(rule: VisualDatabaseProjectionRuleDescriptor, id: string): string {
  return `${rule.id}::${id}`;
}

function allRecordsSection(
  rule: VisualDatabaseProjectionRuleDescriptor,
  records: readonly VisualDatabaseRecord[],
  label: string,
): readonly VisualDatabaseViewSection[] {
  return [{
    key: sectionKey(rule, 'all'),
    id: 'all',
    label: rule.label ?? label,
    icon: rule.icon,
    tone: rule.tone,
    order: rule.order,
    recordKeys: records.map(recordIdentityKey),
    count: records.length,
    ruleId: rule.id,
    operation: rule.operation,
  }];
}

function sectionByDomain(
  rule: VisualDatabaseProjectionRuleDescriptor,
  records: readonly VisualDatabaseRecord[],
  descriptor: VisualDatabaseFieldDescriptor,
  domain: readonly VisualDatabaseFieldDomainValue[],
): readonly VisualDatabaseViewSection[] {
  const sections = new Map<string, VisualDatabaseViewSection>();
  const ensure = (value: VisualDatabaseFieldDomainValue): VisualDatabaseViewSection => {
    const existing = sections.get(value.id);
    if (existing) return existing;
    const section: VisualDatabaseViewSection = {
      key: sectionKey(rule, value.id),
      id: value.id,
      label: value.label,
      icon: rule.icon,
      tone: value.tone ?? rule.tone,
      order: value.order,
      recordKeys: [],
      count: 0,
      ruleId: rule.id,
      operation: rule.operation,
    };
    sections.set(value.id, section);
    return section;
  };
  for (const value of domain) ensure(value);
  for (const record of records) {
    const memberships = descriptor.role === 'lane'
      ? recordGroupValues(record, descriptor)
      : extractFieldText(record, descriptor);
    const values = memberships.length > 0 ? memberships : [EMPTY_LANE_ID];
    for (const id of values) {
      const known = sections.get(id);
      const section = known ?? ensure(id === EMPTY_LANE_ID ? EMPTY_LANE : adHocDomainValue(id));
      const recordKeys = [...section.recordKeys, recordIdentityKey(record)];
      sections.set(id, { ...section, recordKeys, count: recordKeys.length });
    }
  }
  return [...sections.values()]
    .filter((section) => section.count > 0 || domain.some((value) => value.id === section.id))
    .sort((left, right) => left.order - right.order || left.label.localeCompare(right.label));
}

function sectionByDeclaredBuckets(
  rule: VisualDatabaseProjectionRuleDescriptor,
  records: readonly VisualDatabaseRecord[],
  descriptor: VisualDatabaseFieldDescriptor,
): readonly VisualDatabaseViewSection[] {
  const rawBuckets = Array.isArray(rule.params?.buckets) ? rule.params.buckets : [];
  const buckets = rawBuckets
    .map(readDomainValue)
    .filter((bucket): bucket is VisualDatabaseFieldDomainValue => bucket !== null);
  if (buckets.length === 0) return sectionByDomain(rule, records, descriptor, []);
  const equalsByBucket = new Map<string, readonly string[]>();
  rawBuckets.forEach((bucket) => {
    if (!isRecord(bucket)) return;
    const id = readString(bucket.id);
    if (!id) return;
    equalsByBucket.set(id, readStringArray(bucket.equals ?? bucket.values ?? bucket.in));
  });
  const sections = new Map<string, VisualDatabaseViewSection>();
  for (const bucket of buckets) {
    sections.set(bucket.id, {
      key: sectionKey(rule, bucket.id),
      id: bucket.id,
      label: bucket.label,
      icon: rule.icon,
      tone: bucket.tone ?? rule.tone,
      order: bucket.order,
      recordKeys: [],
      count: 0,
      ruleId: rule.id,
      operation: rule.operation,
    });
  }
  for (const record of records) {
    const values = extractFieldText(record, descriptor).map((value) => value.toLowerCase());
    const bucket = buckets.find((entry) => {
      const equals = equalsByBucket.get(entry.id);
      return equals && equals.some((value) => values.includes(value.toLowerCase()));
    });
    const target = bucket ? sections.get(bucket.id) : undefined;
    if (!target) continue;
    const recordKeys = [...target.recordKeys, recordIdentityKey(record)];
    sections.set(target.id, { ...target, recordKeys, count: recordKeys.length });
  }
  return [...sections.values()].sort((left, right) => left.order - right.order || left.label.localeCompare(right.label));
}

function projectSections(
  model: VisualDatabaseModel,
  view: VisualDatabaseViewDescriptor,
  records: readonly VisualDatabaseRecord[],
  rules: readonly VisualDatabaseProjectionRuleDescriptor[],
  diagnostics: VisualDatabaseProjectionDiagnostic[],
): readonly VisualDatabaseViewSection[] {
  const rule = [...rules].sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))[0]
    ?? { id: 'all-records', operation: 'all-records', order: 0 };
  if (rule.operation === 'all-records') return allRecordsSection(rule, records, view.label);
  const descriptor = descriptorForProjectionRule(rule, model, view);
  if (rule.operation === 'view-group') {
    const grouping = descriptor ?? groupingDescriptorForView(view, model.fields);
    return grouping
      ? sectionByDomain(rule, records, grouping, lanesForView(view, records, model.fields, model.domains))
      : allRecordsSection(rule, records, view.label);
  }
  if (rule.operation === 'field-domain' && descriptor) {
    return sectionByDomain(rule, records, descriptor, effectiveDomain(descriptor, model, view));
  }
  if (rule.operation === 'field-value' && descriptor) {
    return sectionByDomain(rule, records, descriptor, []);
  }
  if (rule.operation === 'declared-bucket' && descriptor) {
    return sectionByDeclaredBuckets(rule, records, descriptor);
  }
  diagnostics.push({
    code: 'unknown-projection-operation',
    ruleId: rule.id,
    operation: rule.operation,
    message: 'Projection rule operation is not registered; records were emitted as one generic section.',
  });
  return allRecordsSection(rule, records, view.label);
}

function flattenTree(nodes: readonly VisualDatabaseTreeNode[]): readonly VisualDatabaseTreeNode[] {
  return nodes.flatMap((node) => [node, ...flattenTree(node.children)]);
}

function hierarchyForProjection(
  records: readonly VisualDatabaseRecord[],
  fields: readonly VisualDatabaseFieldDescriptor[],
): {
  rootKeys: readonly string[];
  childKeysByParentKey: Readonly<Record<string, readonly string[]>>;
  depthByRecordKey: Readonly<Record<string, number>>;
  childCountByRecordKey: Readonly<Record<string, number>>;
} {
  const link = fields.find((descriptor) => descriptor.role === 'link');
  if (!link) {
    return {
      rootKeys: records.map(recordIdentityKey),
      childKeysByParentKey: {},
      depthByRecordKey: Object.fromEntries(records.map((record) => [recordIdentityKey(record), 0])),
      childCountByRecordKey: Object.fromEntries(records.map((record) => [recordIdentityKey(record), 0])),
    };
  }
  const roots = treeForRecords(records, link).roots;
  const flat = flattenTree(roots);
  const childKeysByParentKey: Record<string, readonly string[]> = {};
  const depthByRecordKey: Record<string, number> = {};
  const childCountByRecordKey: Record<string, number> = {};
  for (const node of flat) {
    const key = recordIdentityKey(node.record);
    depthByRecordKey[key] = node.depth;
    childKeysByParentKey[key] = node.children.map((child) => recordIdentityKey(child.record));
    childCountByRecordKey[key] = node.children.length;
  }
  return {
    rootKeys: roots.map((node) => recordIdentityKey(node.record)),
    childKeysByParentKey,
    depthByRecordKey,
    childCountByRecordKey,
  };
}

function projectRecord(
  record: VisualDatabaseRecord,
  model: VisualDatabaseModel,
  depthByRecordKey: Readonly<Record<string, number>>,
  childCountByRecordKey: Readonly<Record<string, number>>,
): VisualDatabaseProjectedRecord {
  const key = recordIdentityKey(record);
  return {
    key,
    id: record.id,
    address: recordAddress(record) ?? undefined,
    title: record.title,
    depth: depthByRecordKey[key] ?? 0,
    childCount: childCountByRecordKey[key] ?? 0,
    fields: model.fields.map((descriptor) => {
      const value = extractFieldValue(record, descriptor);
      return {
        fieldId: descriptor.id,
        label: descriptor.label,
        role: descriptor.role,
        shape: deriveShape(value, descriptor),
        value,
        text: extractFieldText(record, descriptor),
        editable: descriptor.editable !== false,
        writePath: projectionWritePath(descriptor) ?? undefined,
      };
    }),
    raw: record.raw,
  };
}

function projectActions(
  actions: readonly VisualDatabaseActionDescriptor[],
  view: VisualDatabaseViewDescriptor,
): readonly VisualDatabaseProjectedAction[] {
  return actions.filter((action) => actionVisibleForView(action, view)).map((action) => ({
    id: action.id,
    label: action.label,
    icon: action.icon,
    target: action.target,
    operation: action.operation,
    fieldId: action.fieldId,
    valueKey: action.valueKey,
    prompts: action.inputPrompts,
  }));
}

function projectedWriteTargets(
  record: VisualDatabaseRecord,
  fields: readonly VisualDatabaseFieldDescriptor[],
): readonly VisualDatabaseProjectedWriteTarget[] {
  const address = recordAddress(record);
  if (!address || !recordPayload(record)) return [];
  return fields.flatMap((descriptor) => {
    if (descriptor.editable === false) return [];
    const writePath = projectionWritePath(descriptor);
    return writePath ? [{ fieldId: descriptor.id, label: descriptor.label, addressLabel: address, writePath }] : [];
  });
}

function projectionCursor(
  view: VisualDatabaseViewDescriptor,
  records: readonly VisualDatabaseRecord[],
  rules: readonly VisualDatabaseProjectionRuleDescriptor[],
  search: string,
): string {
  return JSON.stringify({
    view: view.id,
    search,
    records: records.map(recordIdentityKey),
    rules: rules.map((rule) => [rule.id, rule.operation, rule.sourceFieldId, rule.sourceRole, rule.order]),
  });
}

export function projectVisualDatabaseView(
  model: VisualDatabaseModel,
  options: ProjectVisualDatabaseViewOptions = {},
): VisualDatabaseViewProjection {
  const view = selectedViewForProjection(model, options.view);
  const rules = options.projectionRules ?? view.projectionRules;
  const scoped = recordsForView(view, model.records, model.fields);
  const visible = searchRecords(scoped, options.search ?? '', model.fields);
  const diagnostics: VisualDatabaseProjectionDiagnostic[] = [];
  const hierarchy = hierarchyForProjection(visible, model.fields);
  const sections = projectSections(model, view, visible, rules, diagnostics);
  const visibleKeys = new Set(visible.map(recordIdentityKey));
  const recordsByKey = Object.fromEntries(visible.map((record) => [
    recordIdentityKey(record),
    projectRecord(record, model, hierarchy.depthByRecordKey, hierarchy.childCountByRecordKey),
  ]));
  const actionsForView = projectActions(model.actions, view);
  const actionsByRecordKey = Object.fromEntries(visible.map((record) => [recordIdentityKey(record), actionsForView]));
  const writeTargetsByRecordKey = Object.fromEntries(visible.map((record) => [
    recordIdentityKey(record),
    projectedWriteTargets(record, model.fields),
  ]));
  return {
    view: {
      id: view.id,
      label: view.label,
      kind: view.kind,
      icon: view.icon,
      color: view.color,
    },
    sections: sections.map((section) => {
      const recordKeys = section.recordKeys.filter((key) => visibleKeys.has(key));
      return { ...section, recordKeys, count: recordKeys.length };
    }),
    recordsByKey,
    rootKeys: hierarchy.rootKeys,
    childKeysByParentKey: hierarchy.childKeysByParentKey,
    actionsByRecordKey,
    writeTargetsByRecordKey,
    counts: {
      total: model.records.length,
      scoped: scoped.length,
      visible: visible.length,
      hiddenByViewFilter: model.records.length - scoped.length,
      hiddenBySearch: scoped.length - visible.length,
      sections: sections.length,
      roots: hierarchy.rootKeys.length,
    },
    projectionCursor: projectionCursor(view, visible, rules, options.search ?? ''),
    diagnostics,
  };
}
