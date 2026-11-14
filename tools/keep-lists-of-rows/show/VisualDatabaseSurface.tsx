//
// Generic record arrangement surface. View shape, record scoping (filters),
// grouping axes, value domains, colors, and mutations are all data. This file
// owns presentation and interaction wiring only:
//
// - Every visible field is editable in place through the shape-keyed editor
//   registry (field-editors.tsx) — zero per-field components.
// - Every mutation is one engine write: field edits and lane moves deep-set
//   along descriptor write paths; drag re-ordering writes fractional order
//   keys (do-work/fractional-order.ts); a lane move + reorder in one drag is
//   ONE write entry (same payload) or one atomic batch (migrate-by-touch).
// - Lanes are not special: columns come from the grouping descriptor's
//   effective domain; an open `view-group` rule makes the board a
//   kanban-by-anything.
// - Link-role descriptors project records into a tree (subtodos) — pure
//   projection, indentation only, no hierarchy stored in the surface.
//
// Design contract (reference: Amie task list; see plan
// 2026-06-10-visual-database-reference-grade-ui): flat quiet rows, hover-reveal
// controls, machine identity never renders as a heading, one-line composer.

import React from 'react';
import type { VisualDatabaseSurfaceState } from '@/packages/visual-database/read-data/visual-database';
import { ArrowRight, Circle, Pin } from 'lucide-react';
import { ExpandableTabs } from '@/packages/ui/show/expandable-tabs';
import { OpenSurfaceAction } from '@/packages/ui/show/open-surface-action/OpenSurfaceAction';
import { recordSurfaceIntentToOpenSurfaceProps } from '@/packages/ui/show/placeable-surface-intent/record-surface-intent';
import { Boxes, CalendarDays, Check, ChevronDown, ChevronRight, EyeOff, Gauge, GitBranch, Grid2x2, ImageOff, Layers3, LayoutGrid, LayoutPanelLeft, ListChecks, Plus, Rows3, Search, Settings2, Table2, Trash2 } from 'lucide-react';
import { AnchoredOverlay, Badge, BulkSelectBar, Button, Card, ColorDot, Container, DatePicker, DragReorderList, DropIndicator, Dropdown, EmptyPlaceholder, HoverRevealGroup, HoverRevealItem, Icon, ImageBlock, Inline, InlineEditText, Input, Kbd, NamedIcon, NativeColorPickerPanel, PropertyControl, SegmentedControl, Table, TableBody, TableCell, TableColumnResizeHandle, TableHead, TableHeader, TableRow, Text, VirtualList, copyTextToClipboard, useControlledTextSelection } from '@/packages/ui';
import {
  beforeIdForTarget,
  REORDER_DRAG_MIME,
  readReorderDragId,
  reorderBeforeId,
  ReorderControl,
  type ReorderPreview,
} from '@/packages/ui/show/reorder-control';
import { MetricView } from '@/packages/visual-database/show/MetricView';
import { NodeGraphView } from '@/packages/visual-database/show/views/NodeGraphView';
import { addressedCellValueLabels, applyFieldWrites, buildAddressedCellValueWrites, buildRecordWrite, canonicalRecordIdentity, nextRecordCreateAttempt, undoLastWrite, type AddressedWrite, type FieldWrite, type RecordCreateAttempt, type RecordWriter } from '@/packages/visual-database/do-work/record-writes';
import {
  decodeMutationSettlementPolicy,
  MutationSettlementCoordinator,
  type MutationSettlementPolicy,
  type MutationSettlementResult,
  type MutationSettlementTransition,
} from '@/packages/visual-database/do-work/mutation-settlement';
import {
  cellRefKey,
  foldAddressedCellExpressions,
  type AddressedCellExpressionInputs,
  type AddressedCellValueRecord,
  type FoldedCellExpression,
} from '@/packages/visual-database/do-work/cell-expression';
import {
  buildCellSourceSettlementAttempt,
  cellSourceMutationResultFromSettlement,
  createCellSourceMutationDraft,
  type CellSourceMutationResult,
} from '@/packages/visual-database/do-work/cell-source-mutation';
import {
  applyColumnState,
  buildFillDownExpressionPlan,
  keyToMove,
  moveCell,
  rangeBounds,
  rangeToTsv,
  resizeColumnState,
  setColumnStyleForScope,
  setGridStyleKey,
  toggleColumnHidden,
  type GridCell,
} from '@/packages/visual-database/show/grid-interaction';
import {
  elementStyle,
  evaluateCellFormat,
  evaluateCellValidation,
  ownGridPropertyValue,
  propertiesForScope,
  resolveGridProperty,
} from '@/packages/visual-database/read-data/grid-style';
import {
  resolveAddressedCells,
  resolutionInputsForFoldedCells,
  type AuthoringEvaluationDispatch,
  type DeriveDispatch,
} from '@/packages/visual-database/do-work/resolve-derived-fields';
import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';
import { AddFieldButton, AddFieldForm } from '@/packages/visual-database/show/add-field';
import {
  CellExpressionEditor,
  type CellEvaluationProjection,
  type ExpressionReferenceSelection,
} from '@/packages/visual-database/show/cell-expression-editor';
import {
  buildExpressionReferenceCatalog,
  mapExpressionEvaluationReads,
  type ExpressionReferenceCatalog,
} from '@/packages/visual-database/show/reference-catalog';
import {
  expressionEvaluationProvenanceLabels,
  expressionEvaluationProvenanceRef,
  readDurableExpressionSource,
} from '@/packages/visual-database/do-work/expression-owner-protocol';
import { ExpressionOwnerSessionFactory } from '@/packages/visual-database/do-work/expression-owner-session';
import { isOrderKey, keyBetween, spreadKeys } from '@/packages/visual-database/do-work/fractional-order';
import { planVisualDatabaseDescriptorIntent } from '@/packages/visual-database/do-work/descriptor-intent';
import {
  buildDescriptorSettlementAttempt,
  descriptorIntegrityGenerationKey,
  materializeDescriptorOperations,
  resolveDescriptorMutationConflictDraft,
  type DescriptorExpectedProjection,
  type DescriptorMutationConflict,
  type DescriptorMutationDraft,
} from '@/packages/visual-database/do-work/descriptor-mutation';
import {
  descriptorAddressFor,
  descriptorFactFromUnknown,
  descriptorKeyIdentity,
  type AddressedDescriptorSnapshot,
  type DescriptorKey,
  type DescriptorOwnerTarget,
} from '@/packages/visual-database/read-data/addressed-descriptors';
import {
  DescriptorConflictRecovery,
  descriptorConflictValuesFromMutation,
  type DescriptorConflictChoice,
} from '@/packages/visual-database/show/descriptor-mutation-recovery';
import {
  CompleteControl,
  ActionPromptModal,
  FieldControl,
  FieldPills,
  OverflowMenu,
  ZoneEditor,
  canEditRecord,
  completionLane,
  displaySubtitle,
  displayTitle,
  fieldEditorRegistry,
  isMachineString,
  registerDomainWriter,
  reportFailure,
  reportSuccess,
  reportSuccessFor,
  shortDate,
  toneColor,
} from '@/packages/visual-database/show/field-editors';
import {
  EMPTY_LANE_ID,
  canvasDefaultPosition,
  effectiveDomain,
  extractFieldText,
  extractFieldValue,
  groupingDescriptorForView,
  groupingRuleForView,
  humanizeSegment,
  lanesForView,
  readAttachmentRefs,
  recordAddress,
  projectResolvedFieldValues,
  recordGroupValues,
  recordsForView,
  searchRecords,
  slugifyDataId,
  syntheticFieldDescriptor,
  treeProjectionForRecords,
  withViewGrouping,
  type VisualDatabaseActionDescriptor,
  type VisualDatabaseAttachmentRef,
  type VisualDatabaseFieldDescriptor,
  type VisualDatabaseElementStyle,
  type VisualDatabaseEvaluatorDescriptor,
  type VisualDatabaseFieldDomainValue,
  type VisualDatabaseGridPropertyDescriptor,
  type VisualDatabaseLaneDescriptor,
  type VisualDatabaseModel,
  type VisualDatabasePaletteColor,
  type VisualDatabaseRecord,
  type VisualDatabaseTreeNode,
  type VisualDatabaseViewColumnState,
  type VisualDatabaseViewDescriptor,
  type VisualDatabaseViewIdentity,
  type VisualDatabaseValueExpression,
} from '@/packages/visual-database/read-data/visual-database';
import { serializePersistableVisualDatabaseFields as serializePersistableFields } from '@/packages/visual-database/read-data/serialize-fields';
export { serializePersistableFields };
import { humanizeTimelineBucket, timelineBucketGroups, timelineBucketKey } from '@/packages/visual-database/show/timeline-grouping';
import { InspectorSidebar } from '@/packages/ui/show/inspector-sidebar';
import {
  createInspectionResolverRegistry,
  resolveInspection,
  stampInspectionRef,
  type InspectionRef,
  type InspectionSource,
} from '@/packages/ui/show/inspection-ref';
import {
  buildRecordInspectionSources,
  makeRecordInspectionDispatch,
  makeRecordInspectionEditor,
  makeRecordInspectionLoader,
} from '@/packages/visual-database/show/record-inspection';
import {
  dispatchVisualDatabaseObservation,
  opaqueVisualDatabaseObservationHash,
} from '@/packages/visual-database/show/visual-database-observation';
import { FloatingPanel } from '@/packages/screen-arrangement/show/FloatingPanel';

/** The inspection family record cards stamp — alt-click resolves it to the record's
 *  editable field sources (the resolver is registered blindly; it names no field). */
const RECORD_INSPECTION_FAMILY = 'visual-database.record';
const EMPTY_EVALUATOR_DESCRIPTORS: readonly VisualDatabaseEvaluatorDescriptor[] = Object.freeze([]);

function addressedInputCellRef(row: AddressedCellValueRecord): { recordRef: string; fieldRef: string } | null {
  if (!row.payload || typeof row.payload !== 'object' || Array.isArray(row.payload)) return null;
  const payload = row.payload as Record<string, unknown>;
  const raw = payload.cell_ref ?? payload.cellRef;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const ref = raw as Record<string, unknown>;
  const recordRef = ref.record_ref ?? ref.recordRef;
  const fieldRef = ref.field_ref ?? ref.fieldRef;
  return typeof recordRef === 'string' && typeof fieldRef === 'string'
    ? { recordRef, fieldRef }
    : null;
}

function addressedSourceForCell(
  inputs: AddressedCellExpressionInputs | undefined,
  ref: { recordRef: string; fieldRef: string },
): AddressedCellValueRecord | null {
  const key = cellRefKey(ref);
  return inputs?.sources.find((row) => {
    const rowRef = addressedInputCellRef(row);
    return rowRef ? cellRefKey(rowRef) === key : false;
  }) ?? null;
}

export interface VisualDatabaseSurfaceProps {
  model: VisualDatabaseModel;
  presentation?: 'surface' | 'section';
  surfaceState?: VisualDatabaseSurfaceState;
  onSurfaceStateAction?: (state: VisualDatabaseSurfaceState) => void;
  /** Generic navigation DATA. The surface validates this opaque view identity
   * against the supplied model and contains no URL/proof vocabulary. */
  initialViewId?: string;
  /** Exact record refs supplied by caller DATA for a quiet latest-run cue. */
  latestRecordRefs?: readonly string[];
  /** Generic integrity identity for an exact DATA-bound view selection. */
  viewIdentity?: VisualDatabaseViewIdentity;
  /** Generic durable record writer; enables every mutation on this surface. */
  writeRecord?: RecordWriter;
  /** Raw owner DATA decoded once at this writable surface boundary. Missing,
   * invalid, unknown, or stale policy fails closed before any owner I/O. */
  mutationSettlementPolicy?: unknown;
  /** The record owner supplies the address family admitted by its feed. The
   * board never invents a package-specific record address. */
  recordTarget?: VisualDatabaseRecordTarget;
  /** The owner supplies descriptor-family destinations. The board never picks
   * a package's address family for a caller. This namespace is the sole
   * writable descriptor authority after migration activation. */
  descriptorOwner?: DescriptorOwnerTarget;
  /** Exact v3 owner snapshots, including their load-time CAS bases. */
  descriptorSnapshots?: readonly AddressedDescriptorSnapshot[];
  /** A malformed active authority is visible and non-writable, never silently
   * replaced by legacy aggregates. */
  descriptorAuthorityError?: string;
  /** Complete caller-ready T6 values. Sources, caches and provenance retain
   * independent identities; this surface never reconstructs them from facts. */
  cellExpressionInputs?: AddressedCellExpressionInputs;
  evaluatorDescriptors?: readonly import('@/packages/visual-database/read-data/visual-database').VisualDatabaseEvaluatorDescriptor[];
  onInvokeAction?: (
    action: VisualDatabaseActionDescriptor,
    context: {
      record: VisualDatabaseRecord;
      selectedRecords?: readonly VisualDatabaseRecord[];
      lane?: VisualDatabaseLaneDescriptor;
      answers?: Readonly<Record<string, string>>;
    },
  ) => void | Promise<unknown>;
  /** Shared action-affordance rows already filtered to this owner's selection
   * channel. Meaning stays in DATA; the surface only renders label + identity. */
  selectionActions?: readonly VisualDatabaseSelectionAction[];
  onInvokeSelectionAction?: (
    action: VisualDatabaseSelectionAction,
    selectedRecords: readonly VisualDatabaseRecord[],
  ) => void | Promise<unknown>;
  /** Optional owner-provided selection effect for topology node identities. */
  onSelectNode?: (nodeRef: string) => void;
}

export interface VisualDatabaseSelectionAction {
  readonly id: string;
  readonly label: string;
  readonly appliesToSelection?: (records: readonly VisualDatabaseRecord[]) => boolean;
}

export interface VisualDatabaseRecordTarget {
  addressPrefix: string;
  pathLabels?: readonly string[];
  /** Owner DATA merged into every newly created payload. This gives scoped
   * feeds a stable, queryable identity after address labels become hashes. */
  payloadDefaults?: Readonly<Record<string, unknown>>;
}

interface VisualDatabaseCreateContextValue {
  target?: VisualDatabaseRecordTarget;
}

const VisualDatabaseCreateContext = React.createContext<VisualDatabaseCreateContextValue>({});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createRecordWrite(target: VisualDatabaseRecordTarget, addressLabel: string, payload: unknown): AddressedWrite {
  return {
    addressLabel,
    payload,
    ...(target.pathLabels ? { pathLabels: target.pathLabels } : {}),
  };
}

/** One draft owns one fact identity until canonical readback succeeds. Exact
 * retries reuse it; changing the draft allocates a new identity. */
function useCreateAttemptAddress() {
  const attempt = React.useRef<RecordCreateAttempt | null>(null);
  const addressFor = React.useCallback((
    target: VisualDatabaseRecordTarget,
    kind: string | null,
    title: string,
    payload: unknown,
  ) => {
    const next = nextRecordCreateAttempt(attempt.current, {
      addressPrefix: target.addressPrefix,
      pathLabels: target.pathLabels,
      kind,
      title,
      payload,
      stamp: Date.now().toString(36),
    });
    attempt.current = next;
    return next.addressLabel;
  }, []);
  const complete = React.useCallback((addressLabel: string) => {
    if (attempt.current?.addressLabel !== addressLabel) return false;
    attempt.current = null;
    return true;
  }, []);
  return { addressFor, complete };
}

/** Projects one already-settled canonical writer result into create UI state.
 * It owns no feed, readback, timeout, resolver, or retry state. */
function projectSettledCreate(
  complete: (addressLabel: string) => boolean,
  addressLabel: string,
  project: () => void = () => {},
): void {
  if (!complete(addressLabel)) return;
  reportSuccess('Created');
  project();
}

export function serializeViews(views: readonly VisualDatabaseViewDescriptor[], palette: readonly VisualDatabasePaletteColor[]): unknown {
  const persistableViews = views.filter((view) => view.visibility !== 'direct');
  return {
    kind: 'visual-database.views',
    version: 2,
    views: persistableViews.map((view) => ({
      id: view.id,
      label: view.label,
      kind: view.kind,
      order: view.order,
      ...(view.visibility ? { visibility: view.visibility } : {}),
      ...(view.sourceDatasetAddress ? { sourceDatasetAddress: view.sourceDatasetAddress } : {}),
      filters: view.filters.map((filter) => ({ field: filter.field, equals: filter.equals, exclude: filter.exclude })),
      ...(view.color ? { color: view.color } : {}),
      ...(view.icon ? { icon: view.icon } : {}),
      ...(view.dateField ? { dateField: view.dateField } : {}),
      ...(view.zoom ? { zoom: view.zoom } : {}),
      ...(view.columns ? { columns: view.columns } : {}),
      ...(view.gridStyle ? { gridStyle: view.gridStyle } : {}),
      ...(view.rowStyle ? { rowStyle: view.rowStyle } : {}),
      ...(view.presentation ? { presentation: view.presentation } : {}),
      ...(view.canvasPositions ? { canvasPositions: view.canvasPositions } : {}),
      ...(view.topology ? { topology: view.topology } : {}),
      ...(view.projectionRules.length > 0 ? { projectionRules: view.projectionRules } : {}),
    })),
    ...(palette.length > 0 ? {
      palette: palette.map((entry) => ({
        id: entry.id,
        label: entry.label,
        color: entry.color,
        order: entry.order,
      })),
    } : {}),
  };
}

function sortDescriptorOf(model: VisualDatabaseModel): VisualDatabaseFieldDescriptor | null {
  return model.fields.find((descriptor) => descriptor.role === 'sort' && descriptor.sortable !== false) ?? null;
}

function lastOrderKey(records: readonly VisualDatabaseRecord[]): string | null {
  let last: string | null = null;
  for (const record of records) {
    if (isOrderKey(record.sort) && (last === null || record.sort > last)) last = record.sort;
  }
  return last;
}

function recordViewKey(record: VisualDatabaseRecord): string {
  return recordAddress(record) ?? record.id;
}

/** Above this many flat list items (headers + rows) the list windows its DOM
 *  through the shared VirtualList; below it, plain rendering — same markup,
 *  none of the windowing machinery. */
const LIST_VIRTUALIZATION_THRESHOLD = 150;

const FALLBACK_PARENT_LINK_DESCRIPTOR: VisualDatabaseFieldDescriptor = {
  id: 'record-parent',
  label: 'Parent',
  role: 'link',
  shape: 'reference',
  paths: [['parent'], ['payload', 'parent'], ['parent_id'], ['payload', 'parent_id']],
  writePath: ['payload', 'parent'],
  emptyLabel: 'No parent',
  source: 'discovered',
};

function isParentLinkDescriptor(descriptor: VisualDatabaseFieldDescriptor): boolean {
  if (descriptor.role === 'link') return true;
  const id = descriptor.id.toLowerCase();
  if (id === 'parent' || id === 'parent_id' || id === 'record-parent') return true;
  return descriptor.paths.some((path) => {
    const tail = path[path.length - 1]?.toLowerCase();
    return tail === 'parent' || tail === 'parent_id';
  });
}

function hierarchyLinkDescriptor(fields: readonly VisualDatabaseFieldDescriptor[]): VisualDatabaseFieldDescriptor {
  return fields.find((descriptor) => descriptor.role === 'link')
    ?? fields.find(isParentLinkDescriptor)
    ?? FALLBACK_PARENT_LINK_DESCRIPTOR;
}

function hierarchyTopLevelRecords(
  records: readonly VisualDatabaseRecord[],
  linkDescriptor: VisualDatabaseFieldDescriptor,
): readonly VisualDatabaseRecord[] {
  return treeProjectionForRecords(records, linkDescriptor).roots.map((node) => node.record);
}

function hierarchyRootRecords(
  records: readonly VisualDatabaseRecord[],
  fields: readonly VisualDatabaseFieldDescriptor[],
): readonly VisualDatabaseRecord[] {
  return hierarchyTopLevelRecords(records, hierarchyLinkDescriptor(fields));
}

function directChildRecordsFor(
  parent: VisualDatabaseRecord,
  records: readonly VisualDatabaseRecord[],
  linkDescriptor: VisualDatabaseFieldDescriptor,
  ancestry: ReadonlySet<string>,
): readonly VisualDatabaseRecord[] {
  // O(1): the projection is memoized on the records array identity and
  // indexed by identity key — recordViewKey and recordIdentityKey are the
  // same derivation (address ?? id), so this lookup replaces a full-forest
  // walk per record (the O(n²) that froze large boards).
  const node = treeProjectionForRecords(records, linkDescriptor).nodeByKey.get(recordViewKey(parent));
  if (!node) return [];
  return node.children
    .map((child) => child.record)
    .filter((record) => !ancestry.has(recordViewKey(record)));
}

/** Plan a manual re-order: one fractional-key write when the neighbors carry
 *  valid keys; otherwise migrate-by-touch — respread the WHOLE sequence as one
 *  atomic batch. `extraForDragged` rides in the dragged record's payload. */
function reorderWrites(
  sequence: readonly VisualDatabaseRecord[],
  dragged: VisualDatabaseRecord,
  insertIndex: number,
  sortDescriptor: VisualDatabaseFieldDescriptor,
  extraForDragged: readonly FieldWrite[],
): readonly AddressedWrite[] {
  const seq = sequence.filter((record) => record.id !== dragged.id);
  const bounded = Math.max(0, Math.min(insertIndex, seq.length));
  const above = seq[bounded - 1] ?? null;
  const below = seq[bounded] ?? null;
  const aboveKey = above === null ? null : isOrderKey(above.sort) ? above.sort : undefined;
  const belowKey = below === null ? null : isOrderKey(below.sort) ? below.sort : undefined;
  const bisectable = aboveKey !== undefined && belowKey !== undefined
    && (aboveKey === null || belowKey === null || aboveKey < belowKey);
  if (bisectable) {
    const entry = buildRecordWrite(dragged, [
      { descriptor: sortDescriptor, value: keyBetween(aboveKey, belowKey) },
      ...extraForDragged,
    ]);
    return entry ? [entry] : [];
  }
  const ordered = [...seq.slice(0, bounded), dragged, ...seq.slice(bounded)];
  const keys = spreadKeys(ordered.length);
  const entries: AddressedWrite[] = [];
  ordered.forEach((record, index) => {
    const writes: FieldWrite[] = [{ descriptor: sortDescriptor, value: keys[index] }];
    if (record.id === dragged.id) writes.push(...extraForDragged);
    const entry = buildRecordWrite(record, writes);
    if (entry) entries.push(entry);
  });
  return entries;
}

function submitWrites(writeRecord: RecordWriter, entries: readonly AddressedWrite[], scope: string): void {
  if (entries.length === 0) return;
  const reportSaved = reportSuccessFor(scope === 'move' ? 'Moved' : 'Saved');
  const submitted = entries.length === 1 ? writeRecord(entries[0]) : writeRecord.batch(entries);
  submitted.then(reportSaved).catch(reportFailure(scope));
}

function DisclosureChevron({ open }: { open: boolean }) {
  return (
    <Icon
      icon={ChevronRight}
      size="xs"
      className={`transition-transform duration-200 ease-out ${open ? 'rotate-90' : ''}`}
    />
  );
}

interface OptimisticRecordPayload {
  addressLabel: string;
  payload: unknown;
  token: number;
  confirmed: boolean;
  /** Earlier staged/confirmed value for the same owner address. Optimistic
   * revisions form a stack so a failed newer edit reveals the last accepted
   * value instead of falling through to a lagging feed projection. */
  previous?: OptimisticRecordPayload;
  /** Retains a newly accepted fact across lagging/regressing feeds. It is
   * released only after owner-current and the feed independently agree on a
   * genuinely newer value. Existing-record updates project over their row. */
  createdRecord?: VisualDatabaseRecord;
}

interface StagedOptimisticRecord {
  key: string;
  token: number;
  addressLabel: string;
  payload: unknown;
  createdRecord?: VisualDatabaseRecord;
}

function confirmOptimisticRevision(
  current: OptimisticRecordPayload,
  token: number,
): OptimisticRecordPayload {
  if (current.token === token) {
    return current.confirmed ? current : { ...current, confirmed: true };
  }
  if (!current.previous) return current;
  const previous = confirmOptimisticRevision(current.previous, token);
  return previous === current.previous ? current : { ...current, previous };
}

function removeOptimisticRevision(
  current: OptimisticRecordPayload,
  token: number,
): OptimisticRecordPayload | undefined {
  if (current.token === token) return current.previous;
  if (!current.previous) return current;
  const previous = removeOptimisticRevision(current.previous, token);
  if (previous === current.previous) return current;
  if (previous) return { ...current, previous };
  const { previous: _removed, ...withoutPrevious } = current;
  return withoutPrevious;
}

const RECORD_PAYLOAD_TOP_LEVEL_RESERVED = new Set(['address', 'payload']);

function isPlainObjectForSurface(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return Object.is(left, right);
  }
}

function carriesExpectedValue(observed: unknown, expected: unknown): boolean {
  if (sameJsonValue(observed, expected)) return true;
  if (!isPlainObjectForSurface(observed) || !isPlainObjectForSurface(expected)) return false;
  return Object.entries(expected).every(([key, value]) => (
    value === undefined
      ? !Object.prototype.hasOwnProperty.call(observed, key) || observed[key] === undefined
      : Object.prototype.hasOwnProperty.call(observed, key)
        && carriesExpectedValue(observed[key], value)
  ));
}

function feedRecordCarriesPayload(record: VisualDatabaseRecord, payload: unknown): boolean {
  const raw = record.raw;
  if (isPlainObjectForSurface(raw) && Object.prototype.hasOwnProperty.call(raw, 'payload')) {
    return carriesExpectedValue(raw.payload, payload);
  }
  return carriesExpectedValue(raw, payload);
}

function feedRecordPayload(record: VisualDatabaseRecord): unknown {
  const raw = record.raw;
  return isPlainObjectForSurface(raw) && Object.prototype.hasOwnProperty.call(raw, 'payload')
    ? raw.payload
    : raw;
}

interface MutationExpectedEntry {
  identity: string;
  payload: unknown;
}

function mutationExpectedEntries(entries: readonly AddressedWrite[]): readonly MutationExpectedEntry[] {
  return entries.map((entry) => ({
    identity: canonicalRecordIdentity(entry.addressLabel),
    payload: entry.payload,
  }));
}

function mutationValuesMatch(
  observed: readonly unknown[],
  expected: readonly MutationExpectedEntry[],
): boolean {
  return observed.length === expected.length && expected.every((entry, index) => (
    entry.payload === null
      ? observed[index] === null
      : carriesExpectedValue(observed[index], entry.payload)
  ));
}

function settlementFailure(result: MutationSettlementResult): Error {
  if (result.error instanceof Error) return result.error;
  if (result.state === 'conflict') {
    return new Error('The owner feed showed the change, but independent readback returned different data.');
  }
  if (result.state === 'timeout') {
    return new Error('The owner accepted the write, but its live feed did not return the saved change.');
  }
  if (result.state === 'stale') {
    return new Error('A newer edit replaced this save attempt.');
  }
  return new Error('The owner could not settle this change.');
}

function optimisticRecordRaw(raw: unknown, payload: unknown): unknown {
  if (!isPlainObjectForSurface(raw)) return { payload };
  if (!isPlainObjectForSurface(payload)) return { ...raw, payload };
  const topLevelShadow = Object.fromEntries(
    Object.entries(payload).filter(([key]) => !RECORD_PAYLOAD_TOP_LEVEL_RESERVED.has(key)),
  );
  return { ...raw, ...topLevelShadow, payload };
}

function displayRecordAddress(value: string): string {
  const identity = canonicalRecordIdentity(value);
  return /^1f20[0-9a-f]{64}$/i.test(identity) ? `1f:${identity.slice(4)}` : identity;
}

function firstRoleTextFromRecord(
  record: VisualDatabaseRecord,
  fields: readonly VisualDatabaseFieldDescriptor[],
  role: string,
): string | null {
  for (const descriptor of fields) {
    if (descriptor.role !== role) continue;
    const text = extractFieldText(record, descriptor)[0];
    if (text) return text;
  }
  return null;
}

function allRoleTextFromRecord(
  record: VisualDatabaseRecord,
  fields: readonly VisualDatabaseFieldDescriptor[],
  role: string,
): readonly string[] {
  const values: string[] = [];
  for (const descriptor of fields) {
    if (descriptor.role !== role) continue;
    values.push(...extractFieldText(record, descriptor));
  }
  return [...new Set(values)];
}

function laneFromText(value: string | null, previous: VisualDatabaseLaneDescriptor): VisualDatabaseLaneDescriptor {
  if (!value) return previous;
  if (value === previous.id) return previous;
  if (value === EMPTY_LANE_ID) return { id: EMPTY_LANE_ID, label: 'Unassigned', order: 100000, tone: 'neutral' };
  return { id: value, label: humanizeSegment(value), order: previous.order, tone: 'neutral' };
}

function applyOptimisticRecordPayload(
  record: VisualDatabaseRecord,
  fields: readonly VisualDatabaseFieldDescriptor[],
  payload: unknown,
): VisualDatabaseRecord {
  const raw = optimisticRecordRaw(record.raw, payload);
  const projected: VisualDatabaseRecord = { ...record, raw };
  const id = firstRoleTextFromRecord(projected, fields, 'id') ?? record.id;
  const title = firstRoleTextFromRecord(projected, fields, 'title') ?? id;
  const body = firstRoleTextFromRecord(projected, fields, 'body') ?? '';
  const kind = firstRoleTextFromRecord(projected, fields, 'kind') ?? 'record';
  const group = firstRoleTextFromRecord(projected, fields, 'group') ?? kind;
  const date = firstRoleTextFromRecord(projected, fields, 'date');
  const sortDescriptor = fields.find((descriptor) => descriptor.role === 'sort') ?? null;
  return {
    ...projected,
    id,
    title,
    body,
    kind,
    group,
    lane: laneFromText(firstRoleTextFromRecord(projected, fields, 'lane'), record.lane),
    date,
    sort: sortDescriptor ? extractFieldValue(projected, sortDescriptor) : record.sort,
    badges: allRoleTextFromRecord(projected, fields, 'badge'),
    links: allRoleTextFromRecord(projected, fields, 'link'),
  };
}

function createOptimisticRecord(
  addressLabel: string,
  payload: unknown,
  fields: readonly VisualDatabaseFieldDescriptor[],
): VisualDatabaseRecord {
  const address = displayRecordAddress(addressLabel);
  return applyOptimisticRecordPayload({
    id: address,
    title: address,
    body: '',
    kind: 'record',
    group: 'record',
    lane: { id: EMPTY_LANE_ID, label: 'Unassigned', order: 100000, tone: 'neutral' },
    date: null,
    sort: null,
    badges: [],
    links: [],
    raw: { address, payload },
  }, fields, payload);
}

// ---------------------------------------------------------------------------
// Rows and cards
// ---------------------------------------------------------------------------

/** Amie expanded-card sub-items (ref 69): the card lists its CHILD records
 *  as indented checkbox rows — each a real record (own address, parent set
 *  through the declared link descriptor) with its own completion ring and
 *  seamless title editing. The composer is one more indented row ("Add
 *  sub-item…"), never a floating chip beside the property pills. Renders
 *  only when the field contract declares a link role. */
function childRecordsFor(
  record: VisualDatabaseRecord,
  model: VisualDatabaseModel,
  linkDescriptor: VisualDatabaseFieldDescriptor,
  ancestry: ReadonlySet<string>,
): readonly VisualDatabaseRecord[] {
  return directChildRecordsFor(record, model.records, linkDescriptor, ancestry);
}

function isEmptyPeopleValue(value: string): boolean {
  return /^(unassigned|un-assigned|none|no-assignee|not-assigned)$/i.test(value.trim());
}

function fieldCarriesValue(record: VisualDatabaseRecord, descriptor: VisualDatabaseFieldDescriptor): boolean {
  const value = extractFieldValue(record, descriptor);
  if (Array.isArray(value)) {
    if (descriptor.role === 'badge' && descriptor.shape === 'multi') {
      return value.map(String).some((entry) => !isEmptyPeopleValue(entry));
    }
    return value.length > 0;
  }
  return value !== null && value !== undefined;
}

function SurfaceActionControl({
  record,
  descriptor,
}: {
  record: VisualDatabaseRecord;
  descriptor: VisualDatabaseFieldDescriptor;
}) {
  const policy = descriptor.surfaceAction;
  const action = policy
    ? recordSurfaceIntentToOpenSurfaceProps(
      extractFieldValue(record, descriptor) ?? policy.payload,
      {
      intentPath: [],
      allowList: policy.allowList,
      label: policy.label ?? descriptor.label,
      detail: policy.detail,
      unavailableMessage: policy.unavailableMessage,
      },
    )
    : null;
  if (!action) {
    return (
      <Text variant="body-xs" color="faint" data-reach-role="surface-action-missing">
        This item is unavailable.
      </Text>
    );
  }
  const title = action.payload.title ?? descriptor.label;
  return (
    <OpenSurfaceAction
      compact
      size="xs"
      variant="ghost"
      payload={action.payload}
      label={action.label}
      detail={action.detail}
      unavailableMessage={action.unavailableMessage}
      ariaLabel={`Open ${title}`}
    />
  );
}

function compactSubItemDescriptors(
  record: VisualDatabaseRecord,
  model: VisualDatabaseModel,
  view: VisualDatabaseViewDescriptor | undefined,
  grouping: VisualDatabaseFieldDescriptor | null,
): readonly VisualDatabaseFieldDescriptor[] {
  const chosen: VisualDatabaseFieldDescriptor[] = [];
  const add = (descriptor: VisualDatabaseFieldDescriptor | null | undefined) => {
    if (!descriptor) return;
    if (chosen.some((candidate) => candidate.id === descriptor.id)) return;
    if (!fieldCarriesValue(record, descriptor)) return;
    chosen.push(descriptor);
  };
  add(model.fields.find((descriptor) => descriptor.role === 'badge' && descriptor.shape === 'multi'));
  add(model.fields.find((descriptor) => descriptor.id === view?.dateField && descriptor.role === 'date')
    ?? model.fields.find((descriptor) => descriptor.role === 'date'));
  add(model.fields.find((descriptor) => (
    descriptor.role === 'badge'
    && descriptor.shape !== 'multi'
    && descriptor.id !== grouping?.id
    && /priority|urgency|importance/i.test(`${descriptor.id} ${descriptor.label}`)
  )) ?? model.fields.find((descriptor) => (
    descriptor.role === 'badge'
    && descriptor.shape !== 'multi'
    && descriptor.id !== grouping?.id
  )));
  add(grouping);
  return chosen;
}

function SubItemNode({ record, model, view, lanes, grouping, linkDescriptor, writeRecord, depth, ancestry, onDeleteStart, onDeleteFailure }: {
  record: VisualDatabaseRecord;
  model: VisualDatabaseModel;
  view?: VisualDatabaseViewDescriptor;
  lanes: readonly VisualDatabaseLaneDescriptor[];
  grouping: VisualDatabaseFieldDescriptor | null;
  linkDescriptor: VisualDatabaseFieldDescriptor;
  writeRecord?: RecordWriter;
  depth: number;
  ancestry: ReadonlySet<string>;
  onDeleteStart?: (record: VisualDatabaseRecord) => void;
  onDeleteFailure?: (record: VisualDatabaseRecord) => void;
  onInvokeAction?: VisualDatabaseSurfaceProps['onInvokeAction'];
}) {
  const [expanded, setExpanded] = React.useState(false);
  const recordKey = recordViewKey(record);
  const nextAncestry = React.useMemo(() => new Set([...ancestry, recordKey]), [ancestry, recordKey]);
  const children = childRecordsFor(record, model, linkDescriptor, nextAncestry);
  const compactDescriptors = compactSubItemDescriptors(record, model, view, grouping);
  const subCountChip = children.length > 0 ? (
    <Badge variant="muted" aria-label={`${children.length} sub-items`}>
      <Icon icon={ListChecks} size="xs" />
      {String(children.length)}
    </Badge>
  ) : null;
  const expandToggle = (
    <Button
      variant="chevron"
      size="icon-xs"
      aria-label={expanded ? 'Collapse subitem' : 'Expand subitem'}
      aria-expanded={expanded}
      onClick={(event: React.MouseEvent) => {
        event.stopPropagation();
        setExpanded((value) => !value);
      }}
    >
      <DisclosureChevron open={expanded} />
    </Button>
  );
  return (
    <Container layout="vertical" gap="xs" padding="none" minHeight="0" minWidth="0">
      <HoverRevealGroup
        layout="horizontal"
        alignItems="center"
        justifyContent="between"
        gap="xs"
        padding="none"
        minHeight="0"
        onClick={() => setExpanded((value) => !value)}
      >
        <Container layout="horizontal" alignItems="center" gap="xs" padding="none" flex="1" minHeight="0" minWidth="0">
          <HoverRevealItem>{expandToggle}</HoverRevealItem>
          <CompleteControl record={record} lanes={lanes} grouping={grouping} fields={model.fields} writeRecord={writeRecord} />
          <Container layout="vertical" gap="none" padding="none" flex="1" minHeight="0" minWidth="0">
            {expanded ? (
              <ZoneEditor record={record} model={model} role="title" writeRecord={writeRecord} />
            ) : (
              <Text variant="body" color="strong" truncate>{displayTitle(record)}</Text>
            )}
          </Container>
        </Container>
        <Container layout="horizontal" gap="xs" padding="none" alignItems="center" wrap="wrap" onClick={stopEvent}>
          {subCountChip}
          {compactDescriptors.map((descriptor) => (
            <FieldControl
              key={descriptor.id}
              record={record}
              descriptor={descriptor}
              model={model}
              view={view}
              lanes={lanes}
              grouping={grouping}
              writeRecord={writeRecord}
            />
          ))}
          <HoverRevealItem>
            <OverflowMenu
              record={record}
              lanes={lanes}
              grouping={grouping}
              writeRecord={writeRecord}
              model={model}
              onDeleteStart={onDeleteStart}
              onDeleteFailure={onDeleteFailure}
            />
          </HoverRevealItem>
        </Container>
      </HoverRevealGroup>
      {expanded ? (
        <Container
          layout="vertical"
          gap="xs"
          padding="none"
          minHeight="0"
          minWidth="0"
          onClick={stopEvent}
          style={{ marginLeft: 48 }}
        >
          <ZoneEditor record={record} model={model} role="body" writeRecord={writeRecord} expanded />
          <SubItemsSection
            record={record}
            model={model}
            view={view}
            lanes={lanes}
            grouping={grouping}
            writeRecord={writeRecord}
            depth={depth + 1}
            ancestry={nextAncestry}
            onDeleteStart={onDeleteStart}
            onDeleteFailure={onDeleteFailure}
          />
          <Container layout="horizontal" gap="xs" padding="none" alignItems="center" wrap="wrap">
            <FieldPills record={record} model={model} view={view} lanes={lanes} grouping={grouping} writeRecord={writeRecord} />
            <OverflowMenu
              record={record}
              lanes={lanes}
              grouping={grouping}
              writeRecord={writeRecord}
              model={model}
              onDeleteStart={onDeleteStart}
              onDeleteFailure={onDeleteFailure}
            />
          </Container>
        </Container>
      ) : null}
    </Container>
  );
}

function SubItemsSection({ record, model, view, lanes, grouping, writeRecord, depth = 0, ancestry, onDeleteStart, onDeleteFailure }: {
  record: VisualDatabaseRecord;
  model: VisualDatabaseModel;
  view?: VisualDatabaseViewDescriptor;
  lanes: readonly VisualDatabaseLaneDescriptor[];
  grouping: VisualDatabaseFieldDescriptor | null;
  writeRecord?: RecordWriter;
  depth?: number;
  ancestry?: ReadonlySet<string>;
  onDeleteStart?: (record: VisualDatabaseRecord) => void;
  onDeleteFailure?: (record: VisualDatabaseRecord) => void;
}) {
  const { target: recordTarget } = React.useContext(VisualDatabaseCreateContext);
  const createAttempt = useCreateAttemptAddress();
  const linkDescriptor = hierarchyLinkDescriptor(model.fields);
  const lineage = ancestry ?? new Set([recordViewKey(record)]);
  const parentAddress = recordAddress(record);
  if (!parentAddress) return null;
  const children = childRecordsFor(record, model, linkDescriptor, lineage);
  const editable = Boolean(writeRecord && canEditRecord(record));
  if (children.length === 0 && !editable) return null;
  return (
    <Container layout="vertical" gap="xs" padding="none" onClick={stopEvent} style={{ marginLeft: depth > 0 ? 12 : 0 }}>
      {children.map((child) => (
        <SubItemNode
          key={recordViewKey(child)}
          record={child}
          model={model}
          view={view}
          lanes={lanes}
          grouping={grouping}
          linkDescriptor={linkDescriptor}
          writeRecord={writeRecord}
          depth={depth}
          ancestry={new Set([...lineage, recordViewKey(child)])}
          onDeleteStart={onDeleteStart}
          onDeleteFailure={onDeleteFailure}
        />
      ))}
      {editable && writeRecord ? (
        <HoverRevealGroup layout="horizontal" alignItems="center" gap="xs" padding="none" minHeight="0">
          <HoverRevealItem>
            <span
              aria-hidden="true"
              className="mr-1 flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-md border-[1.5px] border-white/25 text-white/0 transition-colors duration-150 group-hover:border-white/60 group-hover:text-white/45"
            >
              <Check size={11} strokeWidth={3} />
            </span>
          </HoverRevealItem>
          <Container layout="vertical" gap="none" padding="none" flex="1" minHeight="0">
            <InlineEditText
              aria-label="New sub-task"
              value=""
              variant="body-xs"
              tone="secondary"
              placeholder="Add sub-task…"
              onCommit={(title) => {
                const trimmed = title.trim();
                if (!trimmed) return;
                const writes: FieldWrite[] = [];
                const titleDescriptor = model.fields.find((descriptor) => descriptor.role === 'title')
                  ?? { ...syntheticFieldDescriptor('title'), role: 'title' };
                writes.push({ descriptor: titleDescriptor, value: trimmed });
                writes.push({ descriptor: linkDescriptor, value: parentAddress });
                const kindDescriptor = model.fields.find((descriptor) => descriptor.role === 'kind');
                if (kindDescriptor && record.kind) writes.push({ descriptor: kindDescriptor, value: record.kind });
                const sortDescriptor = sortDescriptorOf(model);
                if (sortDescriptor) writes.push({ descriptor: sortDescriptor, value: keyBetween(lastOrderKey(model.records), null) });
                const payload: Record<string, unknown> = { ...(recordTarget?.payloadDefaults ?? {}) };
                applyFieldWrites(payload, writes);
                if (!recordTarget) {
                  reportFailure('create sub-item')(new Error('No record owner supplied a record target'));
                  return;
                }
                const addressLabel = createAttempt.addressFor(recordTarget, record.kind, trimmed, payload);
                writeRecord(createRecordWrite(recordTarget, addressLabel, payload))
                  .then(() => {
                    projectSettledCreate(createAttempt.complete, addressLabel);
                  })
                  .catch(reportFailure('create sub-item'));
              }}
            />
          </Container>
        </HoverRevealGroup>
      ) : null}
    </Container>
  );
}

function RecordRow({
  record,
  recordKey,
  lanes,
  model,
  view,
  grouping,
  expanded,
  onToggle,
  writeRecord,
  reorderable,
  onDropBefore,
  subCount = 0,
  selected = false,
  onSelectToggle,
  onDeleteStart,
  onDeleteFailure,
}: {
  record: VisualDatabaseRecord;
  recordKey: string;
  lanes: readonly VisualDatabaseLaneDescriptor[];
  model: VisualDatabaseModel;
  view?: VisualDatabaseViewDescriptor;
  grouping: VisualDatabaseFieldDescriptor | null;
  expanded: boolean;
  onToggle: (id: string) => void;
  writeRecord?: RecordWriter;
  reorderable?: boolean;
  onDropBefore?: (draggedId: string, before: VisualDatabaseRecord) => void;
  /** Child-record count — compact rows show it as a quiet indicator chip. */
  subCount?: number;
  /** Multi-select membership (cmd/ctrl-click toggles; batch bar appears). */
  selected?: boolean;
  onSelectToggle?: (id: string) => void;
  onDeleteStart?: (record: VisualDatabaseRecord) => void;
  onDeleteFailure?: (record: VisualDatabaseRecord) => void;
}) {
  const subtitle = displaySubtitle(record);
  const date = shortDate(record.date);
  // Lane E — the row is inspectable too (alt-click → InspectorSidebar), same blind
  // stamp as the kanban card so the inspector reaches records in EVERY view.
  const rowInspectionStamp = (() => {
    const address = recordAddress(record);
    return address ? stampInspectionRef({ family: RECORD_INSPECTION_FAMILY, parts: { address } }) : {};
  })();
  const rawDateDescriptor = model.fields.find((descriptor) => descriptor.role === 'date') ?? null;
  const dateDescriptor = rawDateDescriptor && fieldCarriesValue(record, rawDateDescriptor) ? rawDateDescriptor : null;
  // The people field renders as a live picker chip on the compact row only
  // when someone is assigned (Amie density rule) — assigning the first
  // person happens in the expanded card's pill row.
  const peopleField = model.fields.find((descriptor) => descriptor.shape === 'multi' && descriptor.role === 'badge') ?? null;
  const peopleDescriptor = peopleField && fieldCarriesValue(record, peopleField) ? peopleField : null;
  const surfaceField = model.fields.find((descriptor) => descriptor.role === 'surface-action') ?? null;
  const [dropHover, setDropHover] = React.useState(false);
  const dragProps = reorderable
    ? {
      draggable: true,
      onDragStart: (event: React.DragEvent) => {
        event.dataTransfer.setData('application/x-record-id', record.id);
        event.dataTransfer.effectAllowed = 'move';
      },
      onDragOver: (event: React.DragEvent) => {
        if (!dragCarries(event, 'application/x-record-id')) return;
        event.preventDefault();
        setDropHover(true);
      },
      onDragLeave: (event: React.DragEvent) => {
        if (!(event.currentTarget as HTMLElement).contains(event.relatedTarget as Node | null)) {
          setDropHover(false);
        }
      },
      onDrop: (event: React.DragEvent) => {
        event.preventDefault();
        event.stopPropagation();
        setDropHover(false);
        const draggedId = event.dataTransfer.getData('application/x-record-id');
        if (draggedId && draggedId !== record.id) onDropBefore?.(draggedId, record);
      },
    }
    : {};
  const dropLine = reorderable ? <DropIndicator active={dropHover} /> : null;
  // Compact-row sub-item indicator (Amie): a quiet icon + count chip. The
  // sub-items themselves render only inside the EXPANDED card.
  const subCountChip = subCount > 0 ? (
    <Badge variant="muted" aria-label={`${subCount} sub-items`}>
      <Icon icon={ListChecks} size="xs" />
      {String(subCount)}
    </Badge>
  ) : null;

  // One explicit open/close affordance on BOTH states: a chevron that
  // points down when collapsed and up when expanded. The expanded card's
  // body is full of editors (every click is an edit), so without this the
  // only way back out was clicking a different row.
  const expandToggle = (
    // icon-xs = 18px SQUARE, the checkbox/ring size — the chevron must
    // never outweigh its sibling controls.
    <Button
      variant="chevron"
      size="icon-xs"
      aria-label={expanded ? 'Collapse' : 'Expand'}
      aria-expanded={expanded}
      onClick={(event: React.MouseEvent) => { event.stopPropagation(); onToggle(recordKey); }}
    >
      <DisclosureChevron open={expanded} />
    </Button>
  );

  if (expanded) {
    return (
      <Container layout="vertical" gap="none" padding="none" {...rowInspectionStamp}>
        {dropLine}
        <Card variant="nested" padding="sm" layout="stack" onClick={() => onToggle(recordKey)} {...dragProps}>
        {/* Checkbox TOP-aligns with the title (Amie ref 68) — centering
            drifts it downward as the notes zone grows. */}
        <Container layout="horizontal" alignItems="start" gap="xs" padding="none">
          {expandToggle}
          <CompleteControl record={record} lanes={lanes} grouping={grouping} fields={model.fields} writeRecord={writeRecord} />
          <Container layout="vertical" gap="xs" padding="none" flex="1" minHeight="0">
            <ZoneEditor record={record} model={model} role="title" writeRecord={writeRecord} />
            <ZoneEditor record={record} model={model} role="body" writeRecord={writeRecord} expanded />
            {/* Sub-items live INSIDE the card as indented checkbox rows
                (Amie ref 69) — real records via the link descriptor, each
                with its own completion ring. The composer is one more
                indented row, never a floating chip. */}
            <SubItemsSection
              record={record}
              model={model}
              view={view}
              lanes={lanes}
              grouping={grouping}
              writeRecord={writeRecord}
              onDeleteStart={onDeleteStart}
              onDeleteFailure={onDeleteFailure}
            />
          </Container>
        </Container>
        <Container layout="horizontal" gap="xs" padding="none" alignItems="center" wrap="wrap" onClick={stopEvent}>
          {/* ONE renderer per field: FieldPills covers EVERY field carrying
              a value (status, date, assignee, priority, …) plus the
              add-field door. Any extra explicit chip here doubles a pill. */}
          <FieldPills record={record} model={model} view={view} lanes={lanes} grouping={grouping} writeRecord={writeRecord} />
          <OverflowMenu
            record={record}
            lanes={lanes}
            grouping={grouping}
            writeRecord={writeRecord}
            model={model}
            onDeleteStart={onDeleteStart}
            onDeleteFailure={onDeleteFailure}
          />
        </Container>
        </Card>
      </Container>
    );
  }

  return (
    <Container layout="vertical" gap="none" padding="none" {...rowInspectionStamp}>
      {dropLine}
      {/* Linear/Amie row anatomy: FLAT — no card chrome, hover tint only. */}
      <Card
        variant="ghost"
        padding="xs"
        interactive
        selected={selected}
        // cmd/ctrl-click toggles multi-select membership; plain click expands.
        onClick={(event: React.MouseEvent) => {
          if ((event.metaKey || event.ctrlKey) && onSelectToggle) onSelectToggle(recordKey);
          else onToggle(recordKey);
        }}
        {...dragProps}
      >
      <HoverRevealGroup layout="horizontal" alignItems="center" gap="sm" padding="none" justifyContent="between">
        <Container layout="horizontal" alignItems="center" gap="xs" padding="none" flex="1" minHeight="0">
          <HoverRevealItem>{expandToggle}</HoverRevealItem>
          <CompleteControl record={record} lanes={lanes} grouping={grouping} fields={model.fields} writeRecord={writeRecord} />
          {/* Amie collapsed row = ONE line: ring + regular-weight title as
              plain TEXT — clicking anywhere on it expands the card; title
              editing lives in the expanded card. minWidth 0 lets truncate
              actually truncate — without it a long title widens the row
              past the viewport instead of ellipsizing. */}
          <Container layout="vertical" gap="none" padding="none" flex="1" minHeight="0" minWidth="0">
            <Text variant="body" color="strong" truncate>{displayTitle(record)}</Text>
          </Container>
        </Container>
        {/* The whole trailing chip cluster is CONTROLS, not an expand
            handle — date, avatars, status, sub-count all stop propagation
            (only the row body toggles expansion). */}
        <Container layout="horizontal" alignItems="center" gap="xs" padding="none" onClick={stopEvent}>
          {subCountChip}
          {/* Assignee chips are LIVE pickers, not static tags — clicking one
              opens the same add/remove/action menu the expanded card uses.
              A person you can see but not change is a dead end. */}
          {peopleDescriptor ? (
            <FieldControl
              record={record}
              descriptor={peopleDescriptor}
              model={model}
              view={view}
              lanes={lanes}
              grouping={grouping}
              writeRecord={writeRecord}
            />
          ) : null}
          {surfaceField ? <SurfaceActionControl record={record} descriptor={surfaceField} /> : null}
          {dateDescriptor ? (
            <FieldControl
              record={record}
              descriptor={dateDescriptor}
              model={model}
              view={view}
              lanes={lanes}
              grouping={grouping}
              writeRecord={writeRecord}
            />
          ) : date ? <Badge variant="muted">{date}</Badge> : null}
          {/* Status is ALWAYS visible when set (a state the human chose is
              information, not chrome) — hiding it until hover left a ghost
              gap that misaligned the date column. Only the overflow menu
              stays hover-revealed. */}
          {grouping ? (
            <FieldControl
              record={record}
              descriptor={grouping}
              model={model}
              view={view}
              lanes={lanes}
              grouping={grouping}
              writeRecord={writeRecord}
            />
          ) : null}
          <HoverRevealItem>
            <OverflowMenu
              record={record}
              lanes={lanes}
              grouping={grouping}
              writeRecord={writeRecord}
              model={model}
              onDeleteStart={onDeleteStart}
              onDeleteFailure={onDeleteFailure}
            />
          </HoverRevealItem>
        </Container>
      </HoverRevealGroup>
      </Card>
    </Container>
  );
}

function RecordCard({
  record,
  lanes,
  model,
  view,
  grouping,
  columnId,
  childStats,
  writeRecord,
  onDropBefore,
  onDeleteStart,
  onDeleteFailure,
}: {
  record: VisualDatabaseRecord;
  lanes: readonly VisualDatabaseLaneDescriptor[];
  model: VisualDatabaseModel;
  view?: VisualDatabaseViewDescriptor;
  grouping: VisualDatabaseFieldDescriptor | null;
  columnId: string;
  childStats?: { done: number; total: number };
  writeRecord?: RecordWriter;
  onDropBefore?: (draggedId: string, sourceColumnId: string, before: VisualDatabaseRecord) => void;
  onDeleteStart?: (record: VisualDatabaseRecord) => void;
  onDeleteFailure?: (record: VisualDatabaseRecord) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [dropHover, setDropHover] = React.useState(false);
  const subtitle = displaySubtitle(record);
  const date = shortDate(record.date);
  // Lane E — stamp the card inspectable (alt-click → InspectorSidebar). Blind data:
  // just the record address, resolved by the surface's registered resolver.
  const inspectionAddress = recordAddress(record);
  return (
    <Container
      layout="vertical"
      padding="none"
      minHeight="0"
      data-reorder-target-id={record.id}
      data-reorder-target-label={displayTitle(record)}
      {...(inspectionAddress
        ? stampInspectionRef({ family: RECORD_INSPECTION_FAMILY, parts: { address: inspectionAddress } })
        : {})}
    >
    {/* Insertion line above the card while a drag hovers (same primitive as
        the list rows) — the drop means "place before this card". */}
    <DropIndicator active={dropHover} />
    <Card
      variant="nested"
      padding="sm"
      layout="stack"
      interactive
      draggable
      // Grab cursor signals "this card moves" before any drag begins.
      className="cursor-grab active:cursor-grabbing"
      onClick={() => setOpen((value) => !value)}
      onDragStart={(event: React.DragEvent) => {
        event.dataTransfer.setData('application/x-record-id', record.id);
        event.dataTransfer.setData('application/x-record-source', columnId);
        event.dataTransfer.effectAllowed = 'move';
      }}
      onDragOver={(event: React.DragEvent) => {
        if (!dragCarries(event, 'application/x-record-id')) return;
        event.preventDefault();
        setDropHover(true);
      }}
      onDragLeave={(event: React.DragEvent) => {
        if (!(event.currentTarget as HTMLElement).contains(event.relatedTarget as Node | null)) {
          setDropHover(false);
        }
      }}
      onDrop={(event: React.DragEvent) => {
        event.preventDefault();
        event.stopPropagation();
        setDropHover(false);
        const draggedId = event.dataTransfer.getData('application/x-record-id');
        const source = event.dataTransfer.getData('application/x-record-source');
        if (draggedId && draggedId !== record.id) onDropBefore?.(draggedId, source, record);
      }}
    >
      <Container layout="horizontal" alignItems="center" gap="xs" padding="none">
        <CompleteControl record={record} lanes={lanes} grouping={grouping} fields={model.fields} writeRecord={writeRecord} />
        <ZoneEditor record={record} model={model} role="title" writeRecord={writeRecord} />
      </Container>
      {subtitle && !isMachineString(subtitle) ? (
        <Text variant="caption" color="faint" clamp={2}>{subtitle}</Text>
      ) : null}
      <Container layout="horizontal" gap="xs" wrap="wrap" padding="none" alignItems="center" onClick={stopEvent}>
        {/* Assignee chips on cards are the SAME live picker the list rows
            use — names, never raw machine addresses, and clicking opens the
            add/remove/action menu. */}
        {model.fields
          .filter((descriptor) => descriptor.shape === 'multi' && descriptor.role === 'badge')
          .filter((descriptor) => fieldCarriesValue(record, descriptor))
          .map((descriptor) => (
            <FieldControl
              key={descriptor.id}
              record={record}
              descriptor={descriptor}
              model={model}
              view={view}
              lanes={lanes}
              grouping={grouping}
              writeRecord={writeRecord}
            />
          ))}
        {date ? <Badge variant="muted">{date}</Badge> : null}
        {childStats && childStats.total > 0 ? (
          <Badge variant="muted">{`${childStats.done}/${childStats.total}`}</Badge>
        ) : null}
      </Container>
      {open ? (
        <Container layout="vertical" gap="xs" padding="none">
          <ZoneEditor record={record} model={model} role="body" writeRecord={writeRecord} expanded />
          <SubItemsSection
            record={record}
            model={model}
            view={view}
            lanes={lanes}
            grouping={grouping}
            writeRecord={writeRecord}
            onDeleteStart={onDeleteStart}
            onDeleteFailure={onDeleteFailure}
          />
          <Container layout="horizontal" gap="xs" padding="none" alignItems="center" wrap="wrap">
            <FieldPills record={record} model={model} view={view} lanes={lanes} grouping={grouping} writeRecord={writeRecord} />
            <OverflowMenu
              record={record}
              lanes={lanes}
              grouping={grouping}
              writeRecord={writeRecord}
              model={model}
              onDeleteStart={onDeleteStart}
              onDeleteFailure={onDeleteFailure}
            />
          </Container>
        </Container>
      ) : null}
    </Card>
    </Container>
  );
}

// ---------------------------------------------------------------------------
// Composer — one line, payload assembled from descriptor write paths
// ---------------------------------------------------------------------------

function RecordComposer({
  view,
  lanes,
  records,
  model,
  writeRecord,
}: {
  view: VisualDatabaseViewDescriptor | undefined;
  lanes: readonly VisualDatabaseLaneDescriptor[];
  records: readonly VisualDatabaseRecord[];
  model: VisualDatabaseModel;
  writeRecord: RecordWriter;
}) {
  const { target: recordTarget } = React.useContext(VisualDatabaseCreateContext);
  const createAttempt = useCreateAttemptAddress();
  const [title, setTitle] = React.useState('');
  const [date, setDate] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  // Pending property choices made BEFORE create (Amie property strip):
  // descriptor id → chosen value. Flushed into the create payload.
  const [pending, setPending] = React.useState<Readonly<Record<string, unknown>>>({});
  // Property row disclosure: opens automatically with content, and the
  // chevron toggles it any time — the affordance is always visible.
  const [propsOpen, setPropsOpen] = React.useState(false);
  // Remount epoch: InlineEditText owns its draft, so clearing after create
  // means a fresh mount, not a value prop dance.
  const [composerEpoch, setComposerEpoch] = React.useState(0);
  const inputRef = React.useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  // The N key focuses the composer (Amie binding) — the Kbd hint is honest
  // only because this listener exists. Ignored while any field is focused.
  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'n' && event.key !== 'N') return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const active = document.activeElement;
      if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement
        || (active instanceof HTMLElement && active.isContentEditable)) return;
      event.preventDefault();
      inputRef.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const fields = model.fields;
  const kindDescriptor = fields.find((descriptor) => descriptor.role === 'kind');
  const kindFilter = view?.filters.find((filter) => (
    filter.equals.length > 0 && (filter.field === kindDescriptor?.id || filter.field === 'kind')
  ));
  const kind = kindFilter?.equals[0] ?? null;

  function submit() {
    const trimmed = title.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    const writes: FieldWrite[] = [];
    const put = (descriptor: VisualDatabaseFieldDescriptor | undefined | null, value: unknown) => {
      if (descriptor && value !== null && value !== undefined) writes.push({ descriptor, value });
    };
    const titleDescriptor = fields.find((descriptor) => descriptor.role === 'title')
      ?? { ...syntheticFieldDescriptor('title'), role: 'title' };
    const grouping = view ? groupingDescriptorForView(view, fields) : null;
    const firstLane = lanes.find((lane) => lane.id !== EMPTY_LANE_ID) ?? null;
    put(titleDescriptor, trimmed);
    put(kindDescriptor, kind);
    put(grouping, firstLane ? firstLane.id : null);
    put(fields.find((descriptor) => descriptor.role === 'date'), date);
    put(sortDescriptorOf(model), keyBetween(lastOrderKey(records), null));
    // Property strip choices (priority, status, people, …) override defaults.
    for (const [fieldId, value] of Object.entries(pending)) {
      put(fields.find((descriptor) => descriptor.id === fieldId), value);
    }
    const payload: Record<string, unknown> = { ...(recordTarget?.payloadDefaults ?? {}) };
    applyFieldWrites(payload, writes);
    if (!recordTarget) {
      setBusy(false);
      reportFailure('create')(new Error('No record owner supplied a record target'));
      return;
    }
    const addressLabel = createAttempt.addressFor(recordTarget, kind, trimmed, payload);
    writeRecord(createRecordWrite(recordTarget, addressLabel, payload))
      .then(() => {
        projectSettledCreate(createAttempt.complete, addressLabel, () => {
          setTitle('');
          setDraft('');
          setDate(null);
          setPending({});
          setComposerEpoch((epoch) => epoch + 1);
        });
      })
      .catch(reportFailure('create'))
      .finally(() => setBusy(false));
  }

  const placeholder = kind ? humanizeSegment(kind) : 'record';
  // ---------------------------------------------------------------------
  // @-token autocomplete (Amie ref 01 composer: "New todo @list @2pm"):
  // typing "@" opens a popover of token candidates sourced from DATA — every
  // declared-domain field's values plus the views (lists). Accepting a token
  // strips the "@query" text from the draft and stages the value in the same
  // `pending` map the property chips use — one staging seam, two doors.
  // ---------------------------------------------------------------------
  const tokenQuery = React.useMemo(() => {
    const match = /@([^\s@]*)$/.exec(title);
    return match ? match[1].toLowerCase() : null;
  }, [title]);
  // Amie @-popover anatomy (refs 82-84): GROUPED sections with captions —
  // Lists first (icon + color per list), then one section per value field
  // (Status, Assigned, Priority…), then Date suggestions. Selection stages
  // into the same pending map / schedule state the chips use.
  interface TokenOption { key: string; label: string; tone?: string; icon?: string; color?: string; apply: () => void }
  const tokenGroups = React.useMemo(() => {
    if (tokenQuery === null) return [];
    const strip = () => title.replace(/@[^\s@]*$/, '').trimEnd();
    const accept = (fn: () => void) => () => { fn(); setTitle(strip()); setDraft(strip()); };
    const matches = (label: string, id: string) => (
      !tokenQuery || label.toLowerCase().includes(tokenQuery) || id.toLowerCase().includes(tokenQuery)
    );
    const groups: Array<{ caption: string; options: TokenOption[] }> = [];
    // Lists — switching the target list moves the create into that view's
    // first filter value (the same group write the list filters scope by).
    const groupDescriptor = fields.find((descriptor) => descriptor.role === 'group');
    const listOptions: TokenOption[] = model.views
      .filter((candidate) => candidate.visibility !== 'direct')
      .filter((candidate) => candidate.kind === 'list' && candidate.filters.some((filter) => filter.field === groupDescriptor?.id && filter.equals.length > 0))
      .filter((candidate) => matches(candidate.label, candidate.id))
      .map((candidate) => ({
        key: `list:${candidate.id}`,
        label: candidate.label,
        icon: candidate.icon,
        color: candidate.color,
        apply: accept(() => {
          const target = candidate.filters.find((filter) => filter.field === groupDescriptor?.id && filter.equals.length > 0);
          if (groupDescriptor && target) setPending((current) => ({ ...current, [groupDescriptor.id]: target.equals[0] }));
        }),
      }));
    if (listOptions.length > 0) groups.push({ caption: 'Lists', options: listOptions });
    // Value fields — one section per declared-domain field.
    for (const descriptor of fields) {
      if (descriptor.editable === false || descriptor.domain === undefined) continue;
      if (['id', 'title', 'body', 'sort', 'kind', 'group', 'link'].includes(descriptor.role)) continue;
      const options = effectiveDomain(descriptor, model, view)
        .filter((entry) => matches(entry.label, entry.id))
        .slice(0, 5)
        .map((entry) => ({
          key: `${descriptor.id}:${entry.id}`,
          label: humanizeSegment(entry.label),
          tone: entry.tone,
          apply: accept(() => setPending((current) => ({ ...current, [descriptor.id]: entry.id }))),
        }));
      if (options.length > 0) groups.push({ caption: descriptor.label, options });
    }
    // Date — natural suggestions staged into the schedule control.
    const today = new Date();
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    const tomorrow = new Date(today.getTime() + 86400000);
    const nextWeek = new Date(today.getTime() + 7 * 86400000);
    const dateOptions: TokenOption[] = [
      { key: 'date:today', label: 'Today', apply: accept(() => setDate(iso(today))) },
      { key: 'date:tomorrow', label: 'Tomorrow', apply: accept(() => setDate(iso(tomorrow))) },
      { key: 'date:next-week', label: 'Next week', apply: accept(() => setDate(iso(nextWeek))) },
    ].filter((option) => matches(option.label, option.key));
    if (dateOptions.length > 0) groups.push({ caption: 'Date', options: dateOptions });
    return groups;
  }, [tokenQuery, title, fields, model, view]);
  const tokenOptionCount = tokenGroups.reduce((sum, group) => sum + group.options.length, 0);
  // Controlled draft so accepting a token can REWRITE the input text.
  const [draft, setDraft] = React.useState('');
  // Amie create bar: the row IS a seamless inline text field (the exact
  // record-audio title pattern — ui InlineEditText, zero box chrome).
  // Schedule + N hint sit quietly at the trailing edge; Create appears only
  // once there is content.
  return (
    <Card variant="ghost" padding="xs" interactive>
      <Container layout="horizontal" alignItems="center" gap="sm" padding="none">
        <Container layout="horizontal" padding="none" flex="1" minHeight="0" position="relative">
          <InlineEditText
            key={composerEpoch}
            ref={inputRef}
            aria-label={`New ${placeholder}`}
            data-reach-action="visual-database-new-record"
            variant="body"
            placeholder={`New ${placeholder} — @ for list, status, more`}
            value=""
            draft={draft}
            onDraftChange={(next) => { setDraft(next); setTitle(next); }}
            onCommit={() => submit()}
          />
          {/* Amie @-popover anatomy: a compact LEFT-ALIGNED menu hugging the
              caret column (max-w-sm), scrollable past ~8 rows — never a
              full-width centered sheet. */}
          {tokenQuery !== null && tokenOptionCount > 0 ? (
            <Container layout="vertical" padding="none" position="absolute" zIndex="50" inset="below-left" maxWidth="sm" width="full">
              {/* onMouseDown preventDefault: clicking a row must NOT blur
                  the composer first (blur committed the raw "@…" draft and
                  swallowed the selection — the "does nothing" bug). */}
              <Card
                variant="popover"
                padding="xs"
                layout="stack"
                onMouseDown={(event: React.MouseEvent) => event.preventDefault()}
              >
                <Container layout="vertical" gap="sm" padding="none" overflow="y-auto" maxHeight="320px">
                {tokenGroups.map((group) => (
                  <Container key={group.caption} layout="vertical" gap="none" padding="none">
                    <Text variant="caption" color="faint">{group.caption}</Text>
                    {group.options.map((candidate) => (
                      <Button
                        key={candidate.key}
                        variant="ghost"
                        size="menu"
                        aria-label={candidate.label}
                        onClick={(event: React.MouseEvent) => { event.stopPropagation(); candidate.apply(); inputRef.current?.focus(); }}
                      >
                        {candidate.icon ? <NamedIcon name={candidate.icon} size="xs" /> : candidate.color ? <ColorDot color={candidate.color} size="xs" /> : candidate.tone ? <ColorDot color={toneColor(candidate.tone)} size="xs" /> : null}
                        <Text variant="body-xs" color="muted">{candidate.label}</Text>
                      </Button>
                    ))}
                  </Container>
                ))}
                </Container>
              </Card>
            </Container>
          ) : null}
        </Container>
        <DatePicker aria-label="Due date" placeholder="Schedule" value={date} onChange={setDate} />
        <Button
          variant="ghost"
          size="xs"
          aria-label={propsOpen ? 'Hide details' : 'Add details'}
          aria-expanded={propsOpen}
          onClick={() => setPropsOpen((open) => !open)}
        >
          <Icon icon={ChevronDown} size="xs" className={`transition-transform duration-200 ease-out ${propsOpen ? 'rotate-180' : ''}`} />
        </Button>
        {title.trim() ? (
          <Button variant="primary" size="sm" disabled={busy} onClick={submit}>
            Create
          </Button>
        ) : (
          <Kbd size="sm">N</Kbd>
        )}
      </Container>
      {propsOpen || title.trim() ? (
        // Amie property chips (ref 44/47): each declared-domain field is one
        // ICONED chip — icon + current value (or quiet field name). Clicking
        // opens the value menu. No chevrons, no uniform dropdown row — the
        // chip face itself communicates. Descriptor-driven; icons come from
        // the role/tone, not field names.
        <Container layout="horizontal" gap="xs" padding="none" alignItems="center" wrap="wrap">
          {fields.filter((descriptor) => (
            descriptor.editable !== false
            && descriptor.domain !== undefined
            && !['id', 'title', 'body', 'sort', 'kind', 'group', 'date', 'link'].includes(descriptor.role)
          )).map((descriptor) => {
            const domain = effectiveDomain(descriptor, model, view);
            if (domain.length === 0) return null;
            const chosen = pending[descriptor.id];
            const entry = domain.find((candidate) => candidate.id === chosen);
            return (
              <Dropdown
                key={descriptor.id}
                aria-label={descriptor.label}
                items={domain.map((candidate) => ({ value: candidate.id, label: humanizeSegment(candidate.label) }))}
                value={typeof chosen === 'string' ? chosen : ''}
                align="start"
                customTrigger={(
                  <Badge variant="muted">
                    {entry ? <ColorDot color={optionColor(entry)} size="xs" /> : null}
                    {entry ? humanizeSegment(entry.label) : descriptor.label}
                  </Badge>
                )}
                onValueChange={(next) => setPending((current) => ({ ...current, [descriptor.id]: next }))}
              />
            );
          })}
        </Container>
      ) : null}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// List options — rename / color / icon / delete, writes to the views record
// ---------------------------------------------------------------------------

/** Icon names offered in the list menu — a DATA suggestion list, not a cap:
 *  views carry any icon name and ViewIcon resolves it generically against
 *  the full icon library. */
const LIST_ICON_NAMES: readonly string[] = [
  'list-checks', 'briefcase', 'home', 'heart', 'star', 'flame', 'book-open', 'dumbbell', 'shopping-cart', 'plane',
];

function sameColor(left: string | undefined, right: string | undefined): boolean {
  return (left ?? '').trim().toLowerCase() === (right ?? '').trim().toLowerCase();
}

function paletteChoices(palette: readonly VisualDatabasePaletteColor[]): readonly VisualDatabasePaletteColor[] {
  const byColor = new Map<string, VisualDatabasePaletteColor>();
  for (const entry of palette) byColor.set(entry.color.toLowerCase(), entry);
  return [...byColor.values()].sort((left, right) => left.order - right.order || left.label.localeCompare(right.label));
}

function paletteColorAt(
  palette: readonly VisualDatabasePaletteColor[],
  index: number,
): string | undefined {
  const colors = paletteChoices(palette);
  return colors.length > 0 ? colors[index % colors.length].color : undefined;
}

function namedColorFor(color: string | undefined, palette: readonly VisualDatabasePaletteColor[]): VisualDatabasePaletteColor | null {
  if (!color) return null;
  return paletteChoices(palette).find((entry) => sameColor(entry.color, color)) ?? null;
}

function paletteColorId(label: string, color: string): string {
  return slugifyDataId(`${label}-${color.replace('#', '')}`);
}

function createPaletteColor(label: string, color: string, order: number): VisualDatabasePaletteColor {
  const trimmedLabel = label.trim() || 'Custom color';
  return {
    id: paletteColorId(trimmedLabel, color),
    label: trimmedLabel,
    color,
    order,
  };
}

function upsertPaletteColor(
  palette: readonly VisualDatabasePaletteColor[],
  entry: VisualDatabasePaletteColor,
): readonly VisualDatabasePaletteColor[] {
  const current = paletteChoices(palette);
  const next = current.some((candidate) => sameColor(candidate.color, entry.color))
    ? current.map((candidate) => (sameColor(candidate.color, entry.color) ? { ...candidate, ...entry } : candidate))
    : [...current, entry];
  return next.sort((left, right) => left.order - right.order || left.label.localeCompare(right.label));
}

function optionColor(option: VisualDatabaseLaneDescriptor | undefined): string {
  return option?.color ?? toneColor(option?.tone);
}

function uniqueChoiceId(label: string, values: readonly VisualDatabaseLaneDescriptor[]): string {
  const base = slugifyDataId(label);
  const existing = new Set(values.map((entry) => entry.id.toLocaleLowerCase()));
  if (!existing.has(base.toLocaleLowerCase())) return base;
  let index = 2;
  while (existing.has(`${base}-${index}`.toLocaleLowerCase())) index += 1;
  return `${base}-${index}`;
}

/** Project one complete ordered-ID result back onto the complete domain values.
 *  Every value object survives intact; only its numeric order changes. IDs omitted
 *  by a stale interaction payload are retained after the mentioned IDs so a
 *  concurrent/unknown value can never disappear through reordering. */
export function orderDomainValuesByIds(
  values: readonly VisualDatabaseFieldDomainValue[],
  orderedIds: readonly string[],
): readonly VisualDatabaseFieldDomainValue[] {
  const byId = new Map(values.map((value) => [value.id, value]));
  const seen = new Set<string>();
  const ordered: VisualDatabaseFieldDomainValue[] = [];
  for (const id of orderedIds) {
    const value = byId.get(id);
    if (!value || seen.has(id)) continue;
    seen.add(id);
    ordered.push(value);
  }
  for (const value of values) {
    if (seen.has(value.id)) continue;
    seen.add(value.id);
    ordered.push(value);
  }
  return ordered.map((value, index) => ({ ...value, order: (index + 1) * 10 }));
}

/** Icon NAME (data) → glyph, via the ui NamedIcon resolver (SSOT for name
 *  normalization across the whole product). */
function ViewIcon({ name }: { name: string }) {
  return <NamedIcon name={name} size="xs" />;
}

function NewColorFooter({
  palette,
  onAdd,
}: {
  palette: readonly VisualDatabasePaletteColor[];
  onAdd: (entry: VisualDatabasePaletteColor) => void;
}) {
  const [color, setColor] = React.useState('#38BDF8');
  const [label, setLabel] = React.useState('');
  const [pickerOpen, setPickerOpen] = React.useState(false);
  const add = (nextColor = color) => {
    const entry = createPaletteColor(label, nextColor, Math.max(0, ...paletteChoices(palette).map((item) => item.order)) + 10);
    onAdd(entry);
    setLabel('');
    setColor(nextColor);
    setPickerOpen(false);
  };
  return (
    <Container layout="vertical" gap="xs" padding="xs" minHeight="0" onClick={stopEvent}>
      <Container layout="horizontal" gap="xs" padding="none" alignItems="center" minHeight="0">
        <ColorDot color={color} label={label || 'New color'} size="lg" className="ring-1 ring-[var(--border-primary)]" />
        <Container layout="horizontal" padding="none" minHeight="0" flex="1">
          <Input
            aria-label="New color name"
            borderless
            placeholder="Color name"
            value={label}
            onChange={(event) => setLabel(event.currentTarget.value)}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === 'Enter') add();
            }}
          />
        </Container>
        <ExpandableTabs
          mode="action"
          size="sm"
          ariaLabel="New color"
          items={[
            { id: 'pick', label: 'Pick custom color', icon: 'Palette', pinned: pickerOpen },
            { id: 'add', label: 'Add color', icon: 'Plus' },
          ]}
          onSelect={(id) => (id === 'pick' ? setPickerOpen((open) => !open) : add())}
        />
      </Container>
      {pickerOpen ? (
        <NativeColorPickerPanel
          value={color}
          onValueChange={setColor}
          onSave={add}
          className="w-full justify-start shadow-none"
        />
      ) : null}
    </Container>
  );
}

function ColorPickerDropdown({
  palette,
  value,
  fallbackColor,
  placeholder = 'Color',
  ariaLabel,
  onChange,
  onAddColor,
}: {
  palette: readonly VisualDatabasePaletteColor[];
  value: string | undefined;
  fallbackColor?: string;
  placeholder?: string;
  ariaLabel: string;
  onChange: (color: string) => void;
  onAddColor?: (entry: VisualDatabasePaletteColor) => void;
}) {
  const choices = paletteChoices(palette);
  const selected = namedColorFor(value, choices);
  const visibleColor = value || fallbackColor;
  return (
    <Dropdown
      aria-label={ariaLabel}
      items={choices.map((entry) => ({ value: entry.color, label: entry.label }))}
      value={selected?.color ?? ''}
      align="start"
      scrollable="320px"
      customTrigger={(
        <Button variant="ghost" size="xs" aria-label={ariaLabel}>
          {visibleColor ? <ColorDot color={visibleColor} /> : null}
          {selected?.label ?? placeholder}
          <Icon icon={ChevronDown} size="xs" />
        </Button>
      )}
      renderItem={(item) => {
        const entry = choices.find((candidate) => sameColor(candidate.color, item.value));
        const picked = sameColor(value, item.value);
        return (
          <Container layout="horizontal" justifyContent="between" alignItems="center" gap="md" padding="none" flex="1">
            <Container layout="horizontal" alignItems="center" gap="sm" padding="none" minHeight="0">
              <ColorDot color={item.value} />
              <Text variant="body-xs" color={picked ? 'strong' : 'muted'}>{entry?.label ?? item.label}</Text>
            </Container>
            {picked ? <Icon icon={Check} size="xs" /> : null}
          </Container>
        );
      }}
      footer={onAddColor ? (
        <NewColorFooter
          palette={choices}
          onAdd={(entry) => {
            onAddColor(entry);
            onChange(entry.color);
          }}
        />
      ) : undefined}
      onValueChange={onChange}
    />
  );
}

function ChoiceSettings({
  descriptor,
  palette,
  onPaletteChange,
  onChange,
}: {
  descriptor: VisualDatabaseFieldDescriptor;
  palette: readonly VisualDatabasePaletteColor[];
  onPaletteChange: (palette: readonly VisualDatabasePaletteColor[]) => void;
  onChange: (descriptorId: string, values: readonly VisualDatabaseFieldDomainValue[]) => void;
}) {
  if (domainIsSourceOwned(descriptor)) {
    return (
      <Text variant="body-xs" color="faint">
        {descriptor.label} choices come from another data source and are edited there.
      </Text>
    );
  }
  const declaredValues = [...(descriptor.domain?.values ?? [])];
  const exposesEmptyLane = descriptor.role === 'lane' || Boolean(descriptor.emptyLabel);
  const values = (
    exposesEmptyLane && !declaredValues.some((value) => value.id === EMPTY_LANE_ID)
      ? [
          ...declaredValues,
          {
            id: EMPTY_LANE_ID,
            label: descriptor.emptyLabel ?? 'Unassigned',
            order: Math.max(0, ...declaredValues.map((value) => value.order)) + 10,
            tone: 'neutral',
          },
        ]
      : declaredValues
  ).sort((left, right) => left.order - right.order || left.label.localeCompare(right.label));
  const [draft, setDraft] = React.useState('');
  const replace = (next: readonly VisualDatabaseFieldDomainValue[]) => onChange(descriptor.id, next);
  const add = () => {
    const label = draft.trim();
    if (!label) return;
    const color = paletteColorAt(palette, values.length);
    replace([
      ...values,
      {
        id: uniqueChoiceId(label, values),
        label,
        order: (values[values.length - 1]?.order ?? 0) + 10,
        ...(color ? { color } : {}),
      },
    ]);
    setDraft('');
  };
  return (
    <Container layout="vertical" gap="xs" padding="none" minWidth="0">
      <Container layout="horizontal" justifyContent="between" alignItems="center" padding="none">
        <Text variant="heading-xs" color="strong">{descriptor.label}</Text>
        <Text variant="caption" color="faint">{String(values.length)}</Text>
      </Container>
      <DragReorderList
        items={values.map((entry) => ({
          id: entry.id,
          label: entry.label,
          content: (
            <Container
              layout="horizontal"
              gap="xs"
              alignItems="center"
              padding="xs"
              minHeight="0"
              style={{ borderRadius: 8, background: 'var(--glass-bg-subtle)' }}
            >
              <ColorPickerDropdown
                ariaLabel={`${entry.label} color`}
                palette={palette}
                value={entry.color}
                fallbackColor={optionColor(entry)}
                placeholder="Color"
                onAddColor={(colorEntry) => onPaletteChange(upsertPaletteColor(palette, colorEntry))}
                onChange={(color) => replace(values.map((candidate) => (
                  candidate.id === entry.id ? { ...candidate, color } : candidate
                )))}
              />
              <Container layout="horizontal" padding="none" minHeight="0" flex="1">
                <InlineEditText
                  aria-label={`${entry.label} name`}
                  value={entry.label}
                  variant="body-xs"
                  placeholder="Choice name"
                  onCommit={(label) => replace(values.map((candidate) => (
                    candidate.id === entry.id ? { ...candidate, label: label.trim() || candidate.label } : candidate
                  )))}
                />
              </Container>
              {entry.id !== EMPTY_LANE_ID ? (
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`Remove ${entry.label}`}
                  onClick={() => replace(values.filter((candidate) => candidate.id !== entry.id))}
                >
                  <Icon icon={Trash2} size="xs" />
                </Button>
              ) : null}
            </Container>
          ),
        }))}
        onReorder={(orderedIds) => replace(orderDomainValuesByIds(values, orderedIds))}
      />
      <Container layout="horizontal" gap="xs" padding="xs" alignItems="center" minHeight="0" style={{ borderRadius: 8, background: 'var(--glass-bg-subtle)' }}>
        <Container layout="horizontal" padding="none" minHeight="0" flex="1">
          <Input
            aria-label={`Add ${descriptor.label.toLowerCase()} choice`}
            borderless
            placeholder="Add choice"
            value={draft}
            onChange={(event) => setDraft(event.currentTarget.value)}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === 'Enter') add();
            }}
          />
        </Container>
        <Button variant="ghost" size="icon-xs" aria-label="Add choice" onClick={add}>
          <Icon icon={Plus} size="xs" />
        </Button>
      </Container>
    </Container>
  );
}

function domainIsSourceOwned(descriptor: VisualDatabaseFieldDescriptor): boolean {
  return !!descriptor.domain && (
    !!descriptor.domain.fromAddress
    || !!descriptor.domain.fromField
    || (descriptor.domain.fromRecords?.length ?? 0) > 0
  );
}

function fieldSupportsInlineChoices(descriptor: VisualDatabaseFieldDescriptor): boolean {
  return !!descriptor.domain
    || descriptor.shape === 'choice'
    || descriptor.shape === 'multi'
    || descriptor.role === 'lane'
    || descriptor.role === 'badge';
}

function fieldTypeLabel(shape: string | undefined): string {
  const label = humanizeSegment(shape ?? 'automatic');
  return label ? `${label[0].toUpperCase()}${label.slice(1)}` : 'Automatic';
}

/** Complete schema ordering: declared descriptors follow the emitted stable-ID
 * order while discovered fields remain visible after them. The fields document
 * stays the single order authority; no second `fieldOrder` state is created. */
export function orderFieldDescriptorsByIds(
  fields: readonly VisualDatabaseFieldDescriptor[],
  orderedIds: readonly string[],
): readonly VisualDatabaseFieldDescriptor[] {
  const declared = fields.filter((field) => field.source !== 'discovered');
  const discovered = fields.filter((field) => field.source === 'discovered');
  const byId = new Map(declared.map((field) => [field.id, field]));
  const seen = new Set<string>();
  const ordered: VisualDatabaseFieldDescriptor[] = [];
  for (const id of orderedIds) {
    const descriptor = byId.get(id);
    if (!descriptor || seen.has(id)) continue;
    seen.add(id);
    ordered.push(descriptor);
  }
  for (const descriptor of declared) {
    if (seen.has(descriptor.id)) continue;
    seen.add(descriptor.id);
    ordered.push(descriptor);
  }
  return [...ordered, ...discovered];
}

function fieldReferenceReason(
  descriptor: VisualDatabaseFieldDescriptor,
  model: VisualDatabaseModel,
): string | null {
  const usedByView = model.views.some((view) => (
    view.dateField === descriptor.id
    || view.filters.some((filter) => filter.field === descriptor.id || filter.field === descriptor.role)
    || view.projectionRules.some((rule) => (
      rule.sourceFieldId === descriptor.id || rule.sourceRole === descriptor.role
    ))
  ));
  if (usedByView) return 'Used by a list filter, timeline, or grouping';
  if (model.actions.some((action) => action.fieldId === descriptor.id)) return 'Used by an action';
  if (model.fields.some((field) => field.visibleWhen?.field === descriptor.id)) return 'Controls another field';
  if (descriptor.defaultExpression?.derive) return 'Supplies a computed field';
  if (['id', 'title', 'body', 'kind', 'sort', 'group', 'lane', 'link'].includes(descriptor.role)) {
    return 'Structural field';
  }
  return null;
}

function FieldSchemaDetails({
  descriptor,
  model,
  palette,
  deletePending,
  onChange,
  onPaletteChange,
  onChoiceChange,
  onDeleteStart,
  onDeleteCancel,
  onDeleteConfirm,
  allowDelete = true,
}: {
  descriptor: VisualDatabaseFieldDescriptor;
  model: VisualDatabaseModel;
  palette: readonly VisualDatabasePaletteColor[];
  deletePending: boolean;
  onChange: (descriptor: VisualDatabaseFieldDescriptor, scope: string) => void;
  onPaletteChange: (palette: readonly VisualDatabasePaletteColor[]) => void;
  onChoiceChange: (descriptorId: string, values: readonly VisualDatabaseFieldDomainValue[]) => void;
  onDeleteStart: () => void;
  onDeleteCancel: () => void;
  onDeleteConfirm: () => void;
  allowDelete?: boolean;
}) {
  const sourceOwned = domainIsSourceOwned(descriptor);
  const deleteReason = fieldReferenceReason(descriptor, model);
  return (
    <Container layout="vertical" gap="sm" padding="sm" minWidth="0">
      <Container layout="horizontal" gap="sm" padding="none" alignItems="center" justifyContent="between">
        <Text variant="caption" color="faint">Type</Text>
        <Dropdown
          aria-label={`Type of ${descriptor.label}`}
          items={[
            { value: 'auto', label: 'Automatic' },
            ...Object.keys(fieldEditorRegistry).map((shape) => ({
              value: shape,
              label: fieldTypeLabel(shape),
            })),
          ]}
          value={descriptor.shape ?? 'auto'}
          onValueChange={(shape) => onChange(
            shape === 'auto'
              ? { ...descriptor, shape: undefined, source: 'declared' }
              : { ...descriptor, shape, source: 'declared' },
            'field type',
          )}
        />
      </Container>
      {fieldSupportsInlineChoices(descriptor) ? (
        sourceOwned ? (
          <Text variant="body-xs" color="faint">
            {descriptor.label} choices come from another data source and are edited there.
          </Text>
        ) : (
          <ChoiceSettings
            descriptor={descriptor}
            palette={palette}
            onPaletteChange={onPaletteChange}
            onChange={onChoiceChange}
          />
        )
      ) : null}
      {descriptor.source === 'discovered' ? (
        <Text variant="body-xs" color="faint">
          Detected from record data. Renaming it or changing its type adds it to the field schema.
        </Text>
      ) : !allowDelete ? null : deletePending ? (
        <Container layout="vertical" gap="xs" padding="xs" minHeight="0">
          <Text variant="body-xs" color="faint">
            Remove this field from the schema? Existing record values stay in the data.
          </Text>
          <Container layout="horizontal" gap="xs" padding="none">
            <Button variant="danger" size="sm" onClick={onDeleteConfirm}>Remove {descriptor.label}</Button>
            <Button variant="ghost" size="sm" onClick={onDeleteCancel}>Cancel</Button>
          </Container>
        </Container>
      ) : (
        <Button
          variant="ghost"
          size="sm"
          disabled={deleteReason !== null}
          title={deleteReason ?? 'Remove field from schema'}
          onClick={onDeleteStart}
        >
          <Icon icon={Trash2} size="xs" />
          {deleteReason ?? 'Remove field'}
        </Button>
      )}
    </Container>
  );
}

/** Canonical owner-backed field schema editor. Global Fields and a table
 * column's anchored settings compose this exact control; neither owns a
 * parallel name/type draft or mutation path. */
function FieldSchemaEditor({
  descriptor,
  model,
  palette,
  expanded,
  collapsible = true,
  deletePending,
  allowDelete = true,
  onExpandedChange,
  onChange,
  onPaletteChange,
  onChoiceChange,
  onDeleteStart,
  onDeleteCancel,
  onDeleteConfirm,
}: {
  descriptor: VisualDatabaseFieldDescriptor;
  model: VisualDatabaseModel;
  palette: readonly VisualDatabasePaletteColor[];
  expanded: boolean;
  collapsible?: boolean;
  deletePending: boolean;
  allowDelete?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  onChange: (descriptor: VisualDatabaseFieldDescriptor, scope: string) => void;
  onPaletteChange: (palette: readonly VisualDatabasePaletteColor[]) => void;
  onChoiceChange: (descriptorId: string, values: readonly VisualDatabaseFieldDomainValue[]) => void;
  onDeleteStart: () => void;
  onDeleteCancel: () => void;
  onDeleteConfirm: () => void;
}) {
  return (
    <Container
      layout="vertical"
      gap="xs"
      padding="none"
      minWidth="0"
      data-testid={`field-schema-editor-${descriptor.id}`}
      style={{ borderRadius: 8, background: 'var(--glass-bg-subtle)' }}
    >
      <Container layout="horizontal" gap="xs" alignItems="center" padding="xs" minHeight="0">
        <Container layout="horizontal" padding="none" minHeight="0" flex="1">
          <InlineEditText
            aria-label={`Rename ${descriptor.label}`}
            value={descriptor.label}
            variant="body"
            placeholder="Field name"
            onCommit={(label) => onChange(
              { ...descriptor, label: label.trim() || descriptor.label },
              'field name',
            )}
          />
        </Container>
        <Text variant="caption" color="faint">{fieldTypeLabel(descriptor.shape)}</Text>
        {collapsible ? (
          <Button
            variant="ghost"
            size="icon-xs"
            active={expanded}
            aria-label={`${expanded ? 'Collapse' : 'Edit'} ${descriptor.label}`}
            onClick={() => onExpandedChange?.(!expanded)}
          >
            <Icon icon={expanded ? ChevronDown : ChevronRight} size="xs" />
          </Button>
        ) : null}
      </Container>
      {expanded ? (
        <FieldSchemaDetails
          descriptor={descriptor}
          model={model}
          palette={palette}
          deletePending={deletePending}
          allowDelete={allowDelete}
          onChange={onChange}
          onPaletteChange={onPaletteChange}
          onChoiceChange={onChoiceChange}
          onDeleteStart={onDeleteStart}
          onDeleteCancel={onDeleteCancel}
          onDeleteConfirm={onDeleteConfirm}
        />
      ) : null}
    </Container>
  );
}

function FieldsMenu({
  model,
  evaluators,
  onFieldsChange,
  onPaletteChange,
  onChoiceChange,
}: {
  model: VisualDatabaseModel;
  evaluators: readonly import('@/packages/visual-database/read-data/visual-database').VisualDatabaseEvaluatorDescriptor[];
  onFieldsChange: (fields: readonly VisualDatabaseFieldDescriptor[], scope: string) => void;
  onPaletteChange: (palette: readonly VisualDatabasePaletteColor[]) => void;
  onChoiceChange: (descriptorId: string, values: readonly VisualDatabaseFieldDomainValue[]) => void;
}) {
  const [expandedId, setExpandedId] = React.useState<string | null>(null);
  const [adding, setAdding] = React.useState(false);
  const [deletePendingId, setDeletePendingId] = React.useState<string | null>(null);
  const declared = model.fields.filter((descriptor) => descriptor.source !== 'discovered');
  const discovered = model.fields.filter((descriptor) => descriptor.source === 'discovered');
  const replace = (next: VisualDatabaseFieldDescriptor, scope: string) => {
    onFieldsChange(model.fields.map((descriptor) => (
      descriptor.id === next.id ? { ...next, source: 'declared' } : descriptor
    )), scope);
  };
  const fieldContent = (descriptor: VisualDatabaseFieldDescriptor) => {
    const expanded = expandedId === descriptor.id;
    return (
      <FieldSchemaEditor
        descriptor={descriptor}
        model={model}
        palette={model.palette}
        expanded={expanded}
        deletePending={deletePendingId === descriptor.id}
        onExpandedChange={(nextExpanded) => {
          setExpandedId(nextExpanded ? descriptor.id : null);
          setDeletePendingId(null);
        }}
        onChange={replace}
        onPaletteChange={onPaletteChange}
        onChoiceChange={onChoiceChange}
        onDeleteStart={() => setDeletePendingId(descriptor.id)}
        onDeleteCancel={() => setDeletePendingId(null)}
        onDeleteConfirm={() => {
          onFieldsChange(model.fields.filter((field) => field.id !== descriptor.id), 'remove field');
          setDeletePendingId(null);
          setExpandedId(null);
        }}
      />
    );
  };
  return (
    <Dropdown
      aria-label="Fields"
      items={[]}
      value=""
      align="end"
      customTrigger={(
        <Button variant="ghost" size="sm" aria-label={`Fields, ${declared.length}`}>
          <Icon icon={Settings2} size="xs" />
          Fields
          <Text variant="caption" color="faint">{String(declared.length)}</Text>
          <Icon icon={ChevronDown} size="xs" />
        </Button>
      )}
      panel={(
        <Container
          layout="vertical"
          gap="sm"
          padding="sm"
          minWidth="0"
          style={{ width: 'min(440px, calc(100vw - 32px))', maxHeight: '70vh', overflowY: 'auto' }}
          onClick={stopEvent}
        >
          <Container layout="horizontal" justifyContent="between" alignItems="center" padding="none">
            <Container layout="vertical" gap="none" padding="none" minWidth="0">
              <Text variant="heading-xs" color="strong">Fields</Text>
              <Text variant="caption" color="faint">Drag to set the default order everywhere.</Text>
            </Container>
            <Button variant="ghost" size="sm" active={adding} onClick={() => setAdding((value) => !value)}>
              <Icon icon={Plus} size="xs" />
              Add field
            </Button>
          </Container>
          {adding ? (
            <AddFieldForm
              existingFields={model.fields}
              evaluators={evaluators}
              onAdd={(descriptor) => {
                onFieldsChange([...declared, descriptor, ...discovered], 'add field');
                setAdding(false);
                setExpandedId(descriptor.id);
              }}
              onClose={() => setAdding(false)}
            />
          ) : null}
          <DragReorderList
            items={declared.map((descriptor) => ({
              id: descriptor.id,
              label: descriptor.label,
              content: fieldContent(descriptor),
            }))}
            onReorder={(orderedIds) => onFieldsChange(
              orderFieldDescriptorsByIds(model.fields, orderedIds),
              'field order',
            )}
          />
          {declared.length === 0 && !adding ? (
            <Text variant="body-xs" color="faint">No fields have been declared yet.</Text>
          ) : null}
          {discovered.length > 0 ? (
            <Container layout="vertical" gap="xs" padding="none" minWidth="0">
              <Container layout="horizontal" justifyContent="between" alignItems="center" padding="none">
                <Text variant="heading-xs" color="strong">Detected fields</Text>
                <Text variant="caption" color="faint">{String(discovered.length)}</Text>
              </Container>
              {discovered.map((descriptor) => (
                <Container key={descriptor.id} layout="horizontal" gap="xs" padding="none" alignItems="center">
                  <Container layout="horizontal" padding="none" minHeight="0" style={{ width: 28 }} />
                  <Container
                    layout="horizontal"
                    gap="xs"
                    padding="xs"
                    minHeight="0"
                    flex="1"
                    alignItems="center"
                    style={{ borderRadius: 8, background: 'var(--glass-bg-subtle)' }}
                  >
                    <Container layout="horizontal" padding="none" minHeight="0" flex="1">
                      <Text variant="body" color="muted">{descriptor.label}</Text>
                    </Container>
                    <Text variant="caption" color="faint">{fieldTypeLabel(descriptor.shape)}</Text>
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`Add ${descriptor.label} to fields`}
                      onClick={() => onFieldsChange(
                        [
                          ...declared,
                          { ...descriptor, source: 'declared' },
                          ...discovered.filter((candidate) => candidate.id !== descriptor.id),
                        ],
                        'add detected field',
                      )}
                    >
                      Add to fields
                    </Button>
                  </Container>
                </Container>
              ))}
            </Container>
          ) : null}
        </Container>
      )}
      onValueChange={() => undefined}
    />
  );
}

/** Active-view grouping control. It selects only which field groups this view.
 *  Field schema and option order remain in the one canonical Fields surface. */
function GroupByMenu({
  view,
  model,
  onViewChange,
}: {
  view: VisualDatabaseViewDescriptor;
  model: VisualDatabaseModel;
  onViewChange: (view: VisualDatabaseViewDescriptor, scope: string) => void;
}) {
  const grouping = groupingDescriptorForView(view, model.fields);
  const groupable = model.fields.filter((descriptor) => descriptor.groupable !== false);
  const groupingLabel = grouping?.label ?? 'Choose field';
  return (
    <Dropdown
      aria-label={`Group by ${groupingLabel}`}
      align="end"
      scrollable="70vh"
      header="Group records by"
      items={groupable.map((descriptor) => ({
        value: descriptor.id,
        label: descriptor.label,
        description: humanizeSegment(descriptor.shape || descriptor.role || 'field'),
      }))}
      value={grouping?.id ?? ''}
      customTrigger={(
        <Button variant="ghost" size="sm" aria-label={`Group by ${groupingLabel}`}>
          <Icon icon={Layers3} size="xs" />
          Group by {groupingLabel}
          <Icon icon={ChevronDown} size="xs" />
        </Button>
      )}
      footer={grouping ? (
        <Container layout="vertical" gap="xs" padding="sm" minWidth="0" style={{ width: 280 }}>
          <Text variant="caption" color="faint">
            Edit {grouping.label} names, order, and colors from any Board lane or Fields.
          </Text>
        </Container>
      ) : null}
      onValueChange={(descriptorId) => {
        if (!descriptorId || descriptorId === grouping?.id) return;
        onViewChange(withViewGrouping(view, descriptorId), 'grouping');
      }}
    />
  );
}

/** The Amie list menu (ref 04): rename inline, pick a color from the data
 *  palette, delete the list. Pure data operations through persistViewDescriptors —
 *  zero hardcoded lists, zero special cases. */
function ListOptionsMenu({ view, views, palette, onPersist, onDeleted }: {
  view: VisualDatabaseViewDescriptor;
  views: readonly VisualDatabaseViewDescriptor[];
  palette: readonly VisualDatabasePaletteColor[];
  onPersist: (views: readonly VisualDatabaseViewDescriptor[], scope: string, palette?: readonly VisualDatabasePaletteColor[]) => void;
  onDeleted: () => void;
}) {
  const replace = (next: VisualDatabaseViewDescriptor) => (
    views.map((candidate) => (candidate.id === view.id ? next : candidate))
  );
  const colors = paletteChoices(palette);
  return (
    <Dropdown
      aria-label={`${view.label} options`}
      items={[
        { value: 'section-color', label: 'Color', disabled: true },
        ...colors.map((color) => ({ value: `color:${color.color}`, label: color.label })),
        { value: 'clear-color', label: 'No color' },
        { value: 'section-icon', label: 'Icon', disabled: true },
        ...LIST_ICON_NAMES.map((name) => ({ value: `icon:${name}`, label: humanizeSegment(name) })),
        { value: 'clear-icon', label: 'No icon' },
        { value: 'delete', label: 'Delete list' },
      ]}
      value=""
      align="start"
      header={(
        <Container layout="horizontal" padding="none" minHeight="0" onClick={stopEvent}>
          <InlineEditText
            aria-label="List name"
            value={view.label}
            variant="body"
            placeholder="List name"
            onCommit={(next) => onPersist(replace({ ...view, label: next }), 'rename list')}
          />
        </Container>
      )}
      customTrigger={(
        // Badge trigger: it nests INSIDE the tab Button, so it must be an
        // inline element (valid nesting, full tab height, no ghost stub).
        <Badge variant="muted" interactive aria-label={`${view.label} options`} onClick={stopEvent}>
          <Icon icon={ChevronDown} size="xs" />
        </Badge>
      )}
      renderItem={(item) => (
        item.value.startsWith('color:') ? (
          <Container layout="horizontal" justifyContent="between" alignItems="center" gap="md" padding="none" flex="1">
            <Container layout="horizontal" alignItems="center" gap="sm" padding="none">
              <ColorDot color={item.value.slice(6)} />
              <Text variant="body-xs" color={sameColor(view.color, item.value.slice(6)) ? 'strong' : 'muted'}>{item.label}</Text>
            </Container>
            {sameColor(view.color, item.value.slice(6)) ? <Icon icon={Check} size="xs" /> : null}
          </Container>
        ) : item.disabled ? (
          <Text variant="caption" color="faint">{item.label}</Text>
        ) : item.value.startsWith('icon:') ? (
          <Container layout="horizontal" alignItems="center" gap="sm" padding="none">
            <ViewIcon name={item.value.slice(5)} />
            <Text variant="body-xs" color="muted">{view.icon === item.value.slice(5) ? 'Current icon' : item.label}</Text>
          </Container>
        ) : (
          <Text variant="body-xs" color={item.value === 'delete' ? 'error' : 'muted'}>{item.label}</Text>
        )
      )}
      footer={(
        <NewColorFooter
          palette={colors}
          onAdd={(entry) => {
            const nextPalette = upsertPaletteColor(palette, entry);
            onPersist(replace({ ...view, color: entry.color }), 'recolor list', nextPalette);
          }}
        />
      )}
      onValueChange={(value) => {
        if (value.startsWith('color:')) onPersist(replace({ ...view, color: value.slice(6) }), 'recolor list');
        else if (value === 'clear-color') onPersist(replace({ ...view, color: undefined }), 'recolor list');
        else if (value.startsWith('icon:')) onPersist(replace({ ...view, icon: value.slice(5) }), 'list icon');
        else if (value === 'clear-icon') onPersist(replace({ ...view, icon: undefined }), 'list icon');
        else if (value === 'delete') {
          onPersist(views.filter((candidate) => candidate.id !== view.id), 'delete list');
          onDeleted();
        }
      }}
    />
  );
}


/** WebKit-safe drag-type test: in WKWebView (the product presenter)
 *  `dataTransfer.types` is a DOMStringList with no `.includes` — calling it
 *  threw in every onDragOver, so preventDefault never ran, the drop was
 *  never accepted, and cards snapped back. One helper, every handler. */
function dragCarries(event: React.DragEvent, type: string): boolean {
  const types = event.dataTransfer?.types;
  if (!types) return false;
  return Array.prototype.includes.call(types, type);
}

function stopEvent(event: React.SyntheticEvent): void {
  event.stopPropagation();
}

// ---------------------------------------------------------------------------
// New list form — filter chooser over filterable descriptors
// ---------------------------------------------------------------------------

function NewListForm({
  model,
  onPersist,
  onCreated,
  onClose,
}: {
  model: VisualDatabaseModel;
  onPersist: (
    views: readonly VisualDatabaseViewDescriptor[],
    scope: string,
    palette?: readonly VisualDatabasePaletteColor[],
  ) => void;
  onCreated: (viewId: string) => void;
  onClose: () => void;
}) {
  const filterable = model.fields.filter((descriptor) => descriptor.filterable !== false && descriptor.role !== 'id');
  const [label, setLabel] = React.useState('');
  const [color, setColor] = React.useState('');
  const [palette, setPalette] = React.useState<readonly VisualDatabasePaletteColor[]>(model.palette);
  const [filterFieldId, setFilterFieldId] = React.useState(
    () => (model.fields.find((descriptor) => descriptor.role === 'kind') ?? filterable[0])?.id ?? '',
  );
  const [filterValues, setFilterValues] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => { setPalette(model.palette); }, [model.palette]);
  const chosen = filterable.find((descriptor) => descriptor.id === filterFieldId);
  const suggestions = chosen
    ? effectiveDomain(chosen, model).slice(0, 3).map((value) => value.label)
    : [];
  function submit() {
    if (!label.trim() || busy) return;
    setBusy(true);
    const id = slugifyDataId(label);
    const equals = filterValues.split(',').map((value) => value.trim()).filter(Boolean);
    const nextOrder = Math.max(
      0,
      ...model.views.filter((view) => view.visibility !== 'direct').map((view) => view.order),
    ) + 10;
    const nextView: VisualDatabaseViewDescriptor = {
      id,
      label: label.trim(),
      kind: 'list',
      order: nextOrder,
      filters: equals.length && filterFieldId ? [{ field: filterFieldId, equals, exclude: [] }] : [],
      projectionRules: [],
      ...(color ? { color } : {}),
    };
    const views = [
      ...model.views.filter((view) => view.visibility !== 'direct' && view.id !== id),
      nextView,
    ];
    onPersist(views, 'create list', palette);
    onCreated(id);
    onClose();
    setBusy(false);
  }

  return (
    <Card variant="nested" padding="sm" layout="stack">
      <Container layout="horizontal" alignItems="center" gap="sm" padding="none">
        <ColorPickerDropdown
          ariaLabel="List color"
          palette={palette}
          value={color}
          placeholder="Color"
          onAddColor={(entry) => setPalette(upsertPaletteColor(palette, entry))}
          onChange={(nextColor) => setColor(nextColor)}
        />
        <Container layout="horizontal" padding="none" flex="1" minHeight="0">
          <Input aria-label="List name" borderless placeholder="List name" value={label} onChange={(event) => setLabel(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === 'Enter') submit(); }} />
        </Container>
      </Container>
      <Container layout="horizontal" gap="xs" padding="none" alignItems="center" wrap="wrap">
        <Text variant="caption" color="faint">Show records where</Text>
        <Dropdown
          aria-label="Filter field"
          items={filterable.map((descriptor) => ({ value: descriptor.id, label: descriptor.label }))}
          value={filterFieldId}
          align="start"
          scrollable
          customTrigger={(
            <Button variant="ghost" size="xs">
              <Badge variant="neutral">{chosen?.label ?? 'Field'}</Badge>
            </Button>
          )}
          renderItem={(item, state) => (
            <Container layout="horizontal" justifyContent="between" alignItems="center" gap="md" padding="none" flex="1">
              <Text variant="body-xs" color={state.selected ? 'strong' : 'muted'}>{item.label}</Text>
              {state.selected ? <Icon icon={Check} size="xs" /> : null}
            </Container>
          )}
          onValueChange={setFilterFieldId}
        />
        <Text variant="caption" color="faint">is one of</Text>
        <Container layout="horizontal" padding="none" flex="1" minHeight="0">
          <Input
            aria-label="Filter values"
            borderless
            placeholder={suggestions.length ? `for example: ${suggestions.join(', ')}` : 'comma-separated values'}
            value={filterValues}
            onChange={(event) => setFilterValues(event.currentTarget.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') submit(); }}
          />
        </Container>
      </Container>
      <Container layout="horizontal" gap="xs" padding="none" alignItems="center">
        <Button variant="primary" size="sm" disabled={!label.trim() || busy} onClick={submit}>Create list</Button>
        <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
      </Container>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

interface DerivedCell {
  fieldId: string;
  derived: boolean;
  value?: unknown;
  errorCode?: 'cycle' | 'missing-dependency' | 'evaluator';
  dependencyPath?: readonly string[];
  stale?: {
    acceptedSource: string;
    priorResult: unknown;
    evaluatedDependencyRevision: string;
    currentDependencyRevision: string;
  };
  persist: boolean;
}

interface ViewProps {
  records: readonly VisualDatabaseRecord[];
  lanes: readonly VisualDatabaseLaneDescriptor[];
  view: VisualDatabaseViewDescriptor;
  model: VisualDatabaseModel;
  expandedId: string | null;
  onToggle: (id: string) => void;
  latestRecordRefs?: readonly string[];
  onSelectNode?: (nodeRef: string) => void;
  writeRecord?: RecordWriter;
  onDeleteStart?: (record: VisualDatabaseRecord) => void;
  onDeleteFailure?: (record: VisualDatabaseRecord) => void;
  /** False when the visible order is computed (e.g. timeline) — re-ordering a
   *  computed order would be a lie, so the drag affordance follows the data. */
  manualOrder: boolean;
  /** Persist a mutated view descriptor (column order/widths/hidden — Society
   *  data on the views record). Absent = read-only presentation. */
  onPersistView?: (view: VisualDatabaseViewDescriptor, scope: string) => void;
  /** Canonical field-owner mutation seams composed by contextual table column
   * settings. The table never owns parallel schema state. */
  onPersistField?: (descriptor: VisualDatabaseFieldDescriptor, scope: string) => void;
  onPersistPalette?: (palette: readonly VisualDatabasePaletteColor[]) => void;
  onPersistChoice?: (descriptorId: string, values: readonly VisualDatabaseFieldDomainValue[]) => void;
  /** Resolved derived-field cells (value or honest error) keyed
   *  recordKey → fieldId. Derived columns render from this overlay. */
  derivedCells?: ReadonlyMap<string, ReadonlyMap<string, DerivedCell>>;
  /** Append ONE field descriptor to the board's fields DATA record (the
   *  domain-writer address family — runtime write, never re-admission). */
  onAddField?: (descriptor: VisualDatabaseFieldDescriptor) => void;
  onEditCellExpression?: (
    record: VisualDatabaseRecord,
    field: VisualDatabaseFieldDescriptor,
    entryTrigger?: string,
  ) => void;
  editingExpressionCell?: {
    recordRef: string;
    fieldRef: string;
    source: string;
    selection: readonly [number, number];
    humanLabel: string;
  };
  onEditingExpressionDraftChange?: (
    source: string,
    selection: readonly [number, number],
  ) => void;
  revealExpressionCell?: { recordRef: string; fieldRef: string } | null;
  expressionReferencePicking?: boolean;
  onExpressionReferenceSelection?: (
    refs: readonly { recordRef: string; fieldRef: string }[],
    gesture: ExpressionReferenceSelection['gesture'],
  ) => void;
  cellExpressions?: ReadonlyMap<string, FoldedCellExpression>;
  evaluatorDescriptors?: readonly import('@/packages/visual-database/read-data/visual-database').VisualDatabaseEvaluatorDescriptor[];
  expressionReferenceCatalog?: ExpressionReferenceCatalog;
  onRecalculateCell?: (cellRef: { recordRef: string; fieldRef: string }) => void;
  onInvokeAction?: VisualDatabaseSurfaceProps['onInvokeAction'];
  selectionActions?: readonly VisualDatabaseSelectionAction[];
  onInvokeSelectionAction?: VisualDatabaseSurfaceProps['onInvokeSelectionAction'];
}

function dependencyFreshness(
  cell: FoldedCellExpression | undefined,
  catalog: ExpressionReferenceCatalog,
): {
  stale: boolean;
  evaluatedRevision: string;
  currentRevision: string;
} | null {
  const reads = cell?.provenance?.reads?.variables;
  if (!reads || reads.length === 0) return null;
  const currentById = new Map(catalog.candidates.map((candidate) => [candidate.id, candidate.valueRevision]));
  const evaluatedRevision = JSON.stringify(reads.map((read) => [read.catalogId, read.valueRevision]));
  const currentRevision = JSON.stringify(reads.map((read) => [
    read.catalogId,
    currentById.get(read.catalogId) ?? 'missing',
  ]));
  return {
    stale: evaluatedRevision !== currentRevision,
    evaluatedRevision,
    currentRevision,
  };
}

function durableHumanSource(
  expression: VisualDatabaseValueExpression,
  evaluators: readonly import('@/packages/visual-database/read-data/visual-database').VisualDatabaseEvaluatorDescriptor[],
): string | null {
  if (!expression.derive) return null;
  const evaluator = evaluators.find((candidate) => (
    candidate.ref === expression.derive?.evaluatorRef
    || candidate.target === expression.derive?.target
  ));
  return evaluator?.authoring
    ? readDurableExpressionSource(evaluator.authoring, expression.derive.request)
    : null;
}

function humanFillSource(
  expression: VisualDatabaseValueExpression,
  evaluators: readonly VisualDatabaseEvaluatorDescriptor[],
): { source: string; diagnostics: readonly string[] } {
  if (expression.derive) {
    const source = durableHumanSource(expression, evaluators);
    return source === null
      ? {
          source: 'Formula source unavailable',
          diagnostics: ['Open this formula and save a human-readable source before filling it.'],
        }
      : { source, diagnostics: [] };
  }
  if (expression.literal === undefined || expression.literal === null) {
    return { source: 'Blank', diagnostics: [] };
  }
  if (typeof expression.literal === 'string') {
    return { source: expression.literal, diagnostics: [] };
  }
  if (typeof expression.literal === 'number' || typeof expression.literal === 'boolean') {
    return { source: String(expression.literal), diagnostics: [] };
  }
  try {
    return { source: JSON.stringify(expression.literal), diagnostics: [] };
  } catch {
    return {
      source: 'Value unavailable',
      diagnostics: ['This value cannot be safely copied.'],
    };
  }
}

interface FillPreviewRow {
  sourceCell: { recordRef: string; fieldRef: string };
  destinationCell: { recordRef: string; fieldRef: string };
  sourceLabel: string;
  destinationLabel: string;
  originalSource: string;
  transformedSource: string;
  diagnostics: readonly string[];
}

interface FillPreviewProjection {
  rows: readonly FillPreviewRow[];
  writes: readonly AddressedWrite[];
}

function humanDependencyPath(
  path: readonly string[] | undefined,
  model: VisualDatabaseModel,
): readonly { key: string; label: string }[] {
  return (path ?? []).map((key) => {
    try {
      const tuple = JSON.parse(key) as unknown;
      if (!Array.isArray(tuple) || tuple.length !== 2
        || typeof tuple[0] !== 'string' || typeof tuple[1] !== 'string') {
        return { key, label: 'Unknown value' };
      }
      const record = model.records.find((candidate) => recordViewKey(candidate) === tuple[0]);
      const field = model.fields.find((candidate) => candidate.id === tuple[1]);
      return {
        key,
        label: `${record ? displayTitle(record) : 'Missing record'} · ${field?.label ?? 'Missing field'}`,
      };
    } catch {
      return { key, label: 'Unknown value' };
    }
  });
}

/** Amie date buckets: records group under temporal sections relative to
 *  today, with completed records ALWAYS separated into their own trailing
 *  section (never interleaved). Pure Physics — date math only; the completion
 *  test reuses the tone-driven lane rule. Labels are presentation copy. */
function dateBucketOf(record: VisualDatabaseRecord, todayIso: string): string {
  const match = (record.date ?? '').match(/\d{4}-\d{2}-\d{2}/);
  if (!match) return 'No date';
  const date = match[0];
  if (date === todayIso) return 'Today';
  const dayMs = 86_400_000;
  const diffDays = Math.round((Date.parse(date) - Date.parse(todayIso)) / dayMs);
  if (diffDays === -1) return 'Yesterday';
  if (diffDays === 1) return 'Tomorrow';
  return diffDays < 0 ? 'Earlier' : 'Later';
}

const DATE_BUCKET_ORDER: readonly string[] = ['Earlier', 'Yesterday', 'Today', 'Tomorrow', 'Later', 'No date'];

/** Section header row (Amie anatomy): chevron + label + muted count. */
function BucketHeader({ label, count, collapsed, onToggle }: {
  label: string;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
}) {
  return (
    <Container layout="horizontal" alignItems="center" gap="xs" padding="none">
      <Button variant="ghost" size="xs" aria-label={collapsed ? `Expand ${label}` : `Collapse ${label}`} onClick={onToggle}>
        <Icon icon={ChevronRight} size="xs" className={`transition-transform duration-200 ease-out ${collapsed ? '' : 'rotate-90'}`} />
        <Text variant="heading-xs" color="muted">{label}</Text>
        <Text variant="caption" color="faint">{String(count)}</Text>
      </Button>
    </Container>
  );
}

const SECTION_PRESENTATION_VARIANTS = new Set(['count-rows', 'progress-checklist', 'open-rows']);

function presentationField(
  model: VisualDatabaseModel,
  id: string | undefined,
): VisualDatabaseFieldDescriptor | null {
  return id ? model.fields.find((field) => field.id === id) ?? null : null;
}

function sectionActionProps(
  record: VisualDatabaseRecord,
  descriptor: VisualDatabaseFieldDescriptor | null,
) {
  if (!descriptor?.surfaceAction) return null;
  return recordSurfaceIntentToOpenSurfaceProps(extractFieldValue(record, descriptor), {
    intentPath: [],
    allowList: descriptor.surfaceAction.allowList,
    label: displayTitle(record),
    unavailableMessage: descriptor.surfaceAction.unavailableMessage,
  });
}

function SectionListView(props: ViewProps) {
  const presentation = props.view.presentation!;
  const countField = presentationField(props.model, presentation.countFieldId);
  const statusField = presentationField(props.model, presentation.statusFieldId);
  const completionField = presentationField(props.model, presentation.completionFieldId);
  const iconField = presentationField(props.model, presentation.iconFieldId);
  const actionField = presentationField(props.model, presentation.actionFieldId)
    ?? props.model.fields.find((field) => field.role === 'surface-action' || field.role === 'surface-actions')
    ?? null;
  const completedValues = new Set((presentation.completedValues ?? ['complete', 'completed', 'done', 'true'])
    .map((value) => value.toLowerCase()));
  const isComplete = (record: VisualDatabaseRecord) => {
    const value = completionField ? extractFieldValue(record, completionField) : null;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value > 0;
    return completedValues.has(String(value ?? '').toLowerCase());
  };
  const completed = props.records.filter(isComplete).length;
  const percent = props.records.length === 0 ? 0 : Math.round((completed / props.records.length) * 100);
  const rowRefs = React.useRef<Array<HTMLButtonElement | null>>([]);
  const moveFocus = (index: number, key: string) => {
    const indices = props.records.flatMap((_record, row) => rowRefs.current[row] ? [row] : []);
    const count = indices.length;
    const position = indices.indexOf(index);
    if (count === 0) return;
    const next = key === 'Home' ? 0
      : key === 'End' ? count - 1
        : key === 'ArrowDown' ? (position + 1) % count
          : key === 'ArrowUp' ? (position - 1 + count) % count
            : index;
    rowRefs.current[indices[next]]?.focus();
  };

  return (
    <Container layout="vertical" gap="sm" padding="none">
      {presentation.variant === 'progress-checklist' ? (
        <Container layout="vertical" gap="xs" padding="none" role="status" aria-live="polite">
          <Text variant="heading-xl" color="strong">{percent}%</Text>
          <div
            role="progressbar"
            aria-label={`${props.view.label} progress`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
            className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--glass-bg-subtle)]"
          >
            <div className="h-full bg-status-warning" style={{ width: `${percent}%` }} />
          </div>
          <Text variant="body-sm" color="muted">{completed} / {props.records.length} complete</Text>
        </Container>
      ) : null}
      <div
        role="list"
        aria-label={props.view.label}
        aria-live="polite"
        className="divide-y divide-[var(--border-primary)]"
        data-section-presentation={presentation.variant}
      >
        {props.records.length === 0 ? (
          <div role="listitem" className="py-4">
            <Text variant="body" color="muted">{presentation.emptyLabel ?? 'No active work yet.'}</Text>
          </div>
        ) : props.records.map((record, index) => {
          const action = sectionActionProps(record, actionField);
          const status = statusField ? extractFieldText(record, statusField)[0] : null;
          const countValue = countField ? extractFieldValue(record, countField) : null;
          const iconName = iconField ? extractFieldText(record, iconField)[0] : null;
          const complete = isComplete(record);
          const leading = presentation.variant === 'progress-checklist'
            ? <Icon icon={complete ? Check : Circle} size="sm" />
            : presentation.variant === 'open-rows'
              ? iconName ? <NamedIcon name={iconName} /> : <Icon icon={Pin} size="sm" />
              : <span aria-hidden="true">•</span>;
          const trailing = presentation.variant === 'count-rows'
            ? <span className="font-mono tabular-nums">{countValue == null ? '—' : String(countValue)}</span>
            : presentation.variant === 'progress-checklist'
              ? <Badge variant={complete ? 'success' : 'warning'}>{status ?? (complete ? 'Complete' : 'Not started')}</Badge>
              : <Icon icon={ArrowRight} size="sm" />;
          return (
            <div key={recordViewKey(record)} role="listitem" aria-label={`${displayTitle(record)}${status ? `, ${status}` : ''}`}>
              {action ? (
                <OpenSurfaceAction
                  {...action}
                  appearance="row"
                  leading={leading}
                  trailing={trailing}
                  buttonRef={(node) => { rowRefs.current[index] = node; }}
                  onKeyDown={(event) => {
                    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
                      event.preventDefault();
                      moveFocus(index, event.key);
                    }
                  }}
                />
              ) : (
                <div className="flex min-h-11 items-center gap-2 px-3 py-2">
                  {leading}
                  <Text variant="body" color="strong">{displayTitle(record)}</Text>
                  <span className="ml-auto">{trailing}</span>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </Container>
  );
}

function ListView(props: ViewProps) {
  if (props.view.presentation && SECTION_PRESENTATION_VARIANTS.has(props.view.presentation.variant)) {
    return <SectionListView {...props} />;
  }
  const grouping = groupingDescriptorForView(props.view, props.model.fields);
  const sortDescriptor = sortDescriptorOf(props.model);
  const linkDescriptor = hierarchyLinkDescriptor(props.model.fields);
  // Amie sub-item anatomy: children NEVER render as top-level rows. They
  // live inside the parent's EXPANDED card; the compact parent row shows a
  // count chip. The old tree-replaces-buckets either/or deleted every date
  // grouping the moment one record gained a child — structurally gone now.
  const subCountOf = new Map<string, number>();
  const topLevel = hierarchyTopLevelRecords(props.records, linkDescriptor);
  for (const record of topLevel) {
    const children = directChildRecordsFor(record, props.model.records, linkDescriptor, new Set([recordViewKey(record)]));
    if (children.length > 0) subCountOf.set(recordViewKey(record), children.length);
  }
  // Completed starts collapsed (Amie default); user toggles persist in state.
  const [collapsedBuckets, setCollapsedBuckets] = React.useState<readonly string[]>(['Completed']);
  const reorderable = Boolean(props.writeRecord && sortDescriptor && props.manualOrder);
  // Multi-select: cmd/ctrl-click rows, then the floating batch bar (ClickUp/
  // Amie anatomy) applies ONE field write to every selected record — one
  // atomic engine batch through the same write primitive.
  const [selectedIds, setSelectedIds] = React.useState<readonly string[]>([]);
  const [promptingAction, setPromptingAction] = React.useState<{
    action: VisualDatabaseActionDescriptor;
    selectedRecords: readonly VisualDatabaseRecord[];
  } | null>(null);
  const toggleSelected = React.useCallback((id: string) => {
    setSelectedIds((current) => (current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id]));
  }, []);
  const batchWrite = (descriptor: VisualDatabaseFieldDescriptor | null, value: unknown, scope: string) => {
    if (!props.writeRecord || !descriptor) return;
    const entries = props.records
      .filter((record) => selectedIds.includes(recordViewKey(record)))
      .map((record) => buildRecordWrite(record, [{ descriptor, value }]))
      .filter((entry): entry is AddressedWrite => entry !== null);
    submitWrites(props.writeRecord, entries, scope);
    setSelectedIds([]);
  };
  // The board owns selection identity; the action adapter receives the actual
  // selected records, never a reconstructed or feature-named substitute.
  const selectedRecords = props.records.filter((record) => selectedIds.includes(recordViewKey(record)));
  const selectionActions = (() => {
    const labels = new Set<string>();
    const descriptorActions = props.model.actions.flatMap((action) => {
      if (!props.onInvokeAction || labels.has(action.label)) return [];
      labels.add(action.label);
      return [{ label: action.label, onClick: () => {
        const record = selectedRecords[0];
        if (!record) return;
        if (action.inputPrompts.length > 0) {
          setPromptingAction({ action, selectedRecords });
          return;
        }
        void props.onInvokeAction!(action, { record, selectedRecords });
      } }];
    });
    const affordanceActions = (props.selectionActions ?? []).flatMap((action) => {
      if (!props.onInvokeSelectionAction || labels.has(action.label)
        || (action.appliesToSelection && !action.appliesToSelection(selectedRecords))) return [];
      labels.add(action.label);
      return [{
        label: action.label,
        onClick: () => { void props.onInvokeSelectionAction!(action, selectedRecords); },
      }];
    });
    return [...descriptorActions, ...affordanceActions];
  })();
  const groupDescriptor = props.model.fields.find((descriptor) => descriptor.role === 'group') ?? null;
  const listTargets = props.model.views.filter((candidate) => (
    candidate.visibility !== 'direct'
    &&
    candidate.kind === 'list' && candidate.filters.some((filter) => filter.field === groupDescriptor?.id && filter.equals.length > 0)
  ));

  const dropBefore = (draggedId: string, before: VisualDatabaseRecord) => {
    const dragged = props.records.find((record) => record.id === draggedId);
    if (!dragged || !props.writeRecord || !sortDescriptor) return;
    const insertIndex = props.records.filter((record) => record.id !== draggedId)
      .findIndex((record) => record.id === before.id);
    if (insertIndex < 0) return;
    submitWrites(props.writeRecord, reorderWrites(props.records, dragged, insertIndex, sortDescriptor, []), 'reorder');
  };
  const dropAtEnd = (event: React.DragEvent) => {
    event.preventDefault();
    const draggedId = event.dataTransfer.getData('application/x-record-id');
    const dragged = props.records.find((record) => record.id === draggedId);
    if (!dragged || !props.writeRecord || !sortDescriptor) return;
    submitWrites(
      props.writeRecord,
      reorderWrites(props.records, dragged, props.records.length, sortDescriptor, []),
      'reorder',
    );
  };

  const row = (record: VisualDatabaseRecord) => {
    const key = recordViewKey(record);
    return (
    <RecordRow
      key={key}
      record={record}
      recordKey={key}
      lanes={props.lanes}
      model={props.model}
      view={props.view}
      grouping={grouping}
      expanded={props.expandedId === key}
      onToggle={props.onToggle}
      writeRecord={props.writeRecord}
      reorderable={reorderable}
      onDropBefore={dropBefore}
      subCount={subCountOf.get(recordViewKey(record)) ?? 0}
      selected={selectedIds.includes(key)}
      onSelectToggle={toggleSelected}
      onDeleteStart={props.onDeleteStart}
      onDeleteFailure={props.onDeleteFailure}
    />
    );
  };

  // Bucket assembly over TOP-LEVEL records only (children render inside
  // their parent's expanded card): completed records always separate; the
  // rest group by date relative to today.
  const done = completionLane(props.lanes);
  const isDone = (record: VisualDatabaseRecord) => (
    done !== null && grouping !== null && recordGroupValues(record, grouping).includes(done.id)
  );
  const todayIso = new Date().toISOString().slice(0, 10);
  const buckets: Array<{ label: string; records: VisualDatabaseRecord[] }> = [];
  const open = topLevel.filter((record) => !isDone(record));
  const completed = topLevel.filter(isDone);
  for (const label of DATE_BUCKET_ORDER) {
    const bucketRecords = open.filter((record) => dateBucketOf(record, todayIso) === label);
    // "Today" always renders, even at 0 — structure persists when the list
    // is empty (Amie ref 08); other buckets appear only when populated.
    if (bucketRecords.length > 0 || label === 'Today') buckets.push({ label, records: bucketRecords });
  }
  // Completed always renders (0-count included) so done work has a stable home.
  buckets.push({ label: 'Completed', records: completed });
  const toggleBucket = (label: string) => setCollapsedBuckets((current) => (
    current.includes(label) ? current.filter((entry) => entry !== label) : [...current, label]
  ));

  // Flat item stream (headers interleaved with rows) through the shared
  // VirtualList: DOM stays O(visible) no matter how many records the feed
  // carries — the surface is structurally incapable of freezing on volume.
  // The surface root's overflow container is the scroll viewport
  // (scrollParent='nearest'); below the threshold VirtualList renders the
  // plain path — identical markup, zero windowing machinery.
  type FlatListItem =
    | { kind: 'bucket-header'; label: string; count: number }
    | { kind: 'record'; record: VisualDatabaseRecord };
  const flatItems: FlatListItem[] = [];
  for (const bucket of buckets) {
    flatItems.push({ kind: 'bucket-header', label: bucket.label, count: bucket.records.length });
    if (!collapsedBuckets.includes(bucket.label)) {
      for (const record of bucket.records) flatItems.push({ kind: 'record', record });
    }
  }
  const flatKeyOf = (item: FlatListItem) => (
    item.kind === 'bucket-header' ? `header:${item.label}` : recordViewKey(item.record)
  );
  const flatItemView = (item: FlatListItem) => (
    item.kind === 'bucket-header' ? (
      <BucketHeader
        label={item.label}
        count={item.count}
        collapsed={collapsedBuckets.includes(item.label)}
        onToggle={() => toggleBucket(item.label)}
      />
    ) : row(item.record)
  );

  return (
    <Container
      layout="vertical"
      gap="xs"
      padding="none"
      data-reach-role="record-list"
      onDragOver={reorderable ? (event: React.DragEvent) => {
        if (dragCarries(event, 'application/x-record-id')) event.preventDefault();
      } : undefined}
      onDrop={reorderable ? dropAtEnd : undefined}
    >
      <VirtualList
        items={flatItems}
        itemKey={flatKeyOf}
        renderItem={flatItemView}
        estimateSize={(item) => (item.kind === 'bucket-header' ? 34 : 46)}
        threshold={LIST_VIRTUALIZATION_THRESHOLD}
        scrollParent="nearest"
        rowGap={4}
      />
      {props.writeRecord || selectionActions.length > 0 ? (
        <BulkSelectBar
          selectedCount={selectedIds.length}
          onClearAll={() => setSelectedIds([])}
          placement="floating"
          actions={selectionActions}
        >
          {/* Batch pickers — values from DATA: lists, status, every other
              declared-domain field rides the same seam. */}
          {props.writeRecord ? (
            <>
              {listTargets.length > 0 && groupDescriptor ? (
                <Dropdown
                  aria-label="Move to list"
                  items={listTargets.map((candidate) => ({
                    value: candidate.filters.find((filter) => filter.field === groupDescriptor.id)?.equals[0] ?? '',
                    label: candidate.label,
                  }))}
                  value=""
                  align="center"
                  customTrigger={<Badge variant="muted" interactive>Move to list</Badge>}
                  onValueChange={(target) => { if (target) batchWrite(groupDescriptor, target, 'move'); }}
                />
              ) : null}
              {grouping ? (
                <Dropdown
                  aria-label="Set status"
                  items={props.lanes.filter((lane) => lane.id !== EMPTY_LANE_ID).map((lane) => ({ value: lane.id, label: humanizeSegment(lane.label) }))}
                  value=""
                  align="center"
                  customTrigger={<Badge variant="muted" interactive>Set status</Badge>}
                  onValueChange={(target) => { if (target) batchWrite(grouping, target, 'move'); }}
                />
              ) : null}
            </>
          ) : null}
        </BulkSelectBar>
      ) : null}
      {promptingAction ? (
        <ActionPromptModal
          action={promptingAction.action}
          record={promptingAction.selectedRecords[0]!}
          selectedRecords={promptingAction.selectedRecords}
          model={props.model}
          onClose={() => setPromptingAction(null)}
          onSubmit={async (answers) => {
            await props.onInvokeAction?.(promptingAction.action, {
              record: promptingAction.selectedRecords[0]!,
              selectedRecords: promptingAction.selectedRecords,
              answers,
            });
            setPromptingAction(null);
          }}
        />
      ) : null}
    </Container>
  );
}

/** Notion/Linear column quick add: a quiet "+ New" row at the column bottom
 *  (Notion board ref 19) that flips into a borderless inline input; the per-
 *  column "+" header action (Linear refs 11-18) focuses the same composer.
 *  Creates land in THIS lane with an order key after the column's last row. */
function LaneComposer({ lane, laneRecords, view, model, writeRecord, open, onOpenChange }: {
  lane: VisualDatabaseLaneDescriptor;
  laneRecords: readonly VisualDatabaseRecord[];
  view: VisualDatabaseViewDescriptor;
  model: VisualDatabaseModel;
  writeRecord: RecordWriter;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { target: recordTarget } = React.useContext(VisualDatabaseCreateContext);
  const createAttempt = useCreateAttemptAddress();
  const [title, setTitle] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  React.useEffect(() => { if (open) inputRef.current?.focus(); }, [open]);

  function submit() {
    const trimmed = title.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    const fields = model.fields;
    const writes: FieldWrite[] = [];
    const put = (descriptor: VisualDatabaseFieldDescriptor | undefined | null, value: unknown) => {
      if (descriptor && value !== null && value !== undefined) writes.push({ descriptor, value });
    };
    const kindDescriptor = fields.find((descriptor) => descriptor.role === 'kind');
    const kindFilter = view.filters.find((filter) => (
      filter.equals.length > 0 && (filter.field === kindDescriptor?.id || filter.field === 'kind')
    ));
    const kind = kindFilter?.equals[0] ?? null;
    put(fields.find((descriptor) => descriptor.role === 'title')
      ?? { ...syntheticFieldDescriptor('title'), role: 'title' }, trimmed);
    put(kindDescriptor, kind);
    put(groupingDescriptorForView(view, fields), lane.id === EMPTY_LANE_ID ? null : lane.id);
    put(sortDescriptorOf(model), keyBetween(lastOrderKey(laneRecords), null));
    const payload: Record<string, unknown> = { ...(recordTarget?.payloadDefaults ?? {}) };
    applyFieldWrites(payload, writes);
    if (!recordTarget) {
      setBusy(false);
      reportFailure('create')(new Error('No record owner supplied a record target'));
      return;
    }
    const addressLabel = createAttempt.addressFor(recordTarget, kind, trimmed, payload);
    writeRecord(createRecordWrite(recordTarget, addressLabel, payload))
      .then(() => {
        projectSettledCreate(createAttempt.complete, addressLabel, () => {
          setTitle('');
          onOpenChange(false);
        });
      })
      .catch(reportFailure('create'))
      .finally(() => setBusy(false));
  }

  if (!open) {
    return (
      <Button variant="ghost" size="sm" onClick={() => onOpenChange(true)} data-reach-action="add-record">
        <Icon icon={Plus} size="xs" />
        New
      </Button>
    );
  }
  return (
    <Container layout="horizontal" alignItems="center" gap="xs" padding="none">
      <Input
        ref={inputRef}
        aria-label={`New record in ${humanizeSegment(lane.label)}`}
        borderless
        placeholder={`New in ${humanizeSegment(lane.label)}`}
        value={title}
        onChange={(event) => setTitle(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') submit();
          if (event.key === 'Escape') { setTitle(''); onOpenChange(false); }
        }}
        onBlur={() => { if (!title.trim()) onOpenChange(false); }}
      />
      {title.trim() ? (
        <Button variant="success" size="sm" disabled={busy} onClick={submit}>
          <Icon icon={Check} size="xs" />
        </Button>
      ) : null}
    </Container>
  );
}

/** Table view "+ New" row composer. Creates a new record with title from input,
 *  kind from view filter, and appends it to the end of the table. */
function TableRowComposer({
  records,
  view,
  model,
  writeRecord,
  open,
  onOpenChange,
}: {
  records: readonly VisualDatabaseRecord[];
  view: VisualDatabaseViewDescriptor;
  model: VisualDatabaseModel;
  writeRecord: RecordWriter;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { target: recordTarget } = React.useContext(VisualDatabaseCreateContext);
  const createAttempt = useCreateAttemptAddress();
  const [title, setTitle] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  React.useEffect(() => { if (open) inputRef.current?.focus(); }, [open]);

  function submit() {
    const trimmed = title.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    const fields = model.fields;
    const writes: FieldWrite[] = [];
    const put = (descriptor: VisualDatabaseFieldDescriptor | undefined | null, value: unknown) => {
      if (descriptor && value !== null && value !== undefined) writes.push({ descriptor, value });
    };
    const kindDescriptor = fields.find((descriptor) => descriptor.role === 'kind');
    const kindFilter = view.filters.find((filter) => (
      filter.equals.length > 0 && (filter.field === kindDescriptor?.id || filter.field === 'kind')
    ));
    const kind = kindFilter?.equals[0] ?? null;
    put(fields.find((descriptor) => descriptor.role === 'title')
      ?? { ...syntheticFieldDescriptor('title'), role: 'title' }, trimmed);
    put(kindDescriptor, kind);
    put(sortDescriptorOf(model), keyBetween(lastOrderKey(records), null));
    const payload: Record<string, unknown> = { ...(recordTarget?.payloadDefaults ?? {}) };
    applyFieldWrites(payload, writes);
    if (!recordTarget) {
      setBusy(false);
      reportFailure('create')(new Error('No record owner supplied a record target'));
      return;
    }
    const addressLabel = createAttempt.addressFor(recordTarget, kind, trimmed, payload);
    writeRecord(createRecordWrite(recordTarget, addressLabel, payload))
      .then(() => {
        projectSettledCreate(createAttempt.complete, addressLabel, () => {
          setTitle('');
          onOpenChange(false);
        });
      })
      .catch(reportFailure('create'))
      .finally(() => setBusy(false));
  }

  if (!open) {
    return (
      <TableRow interactive>
        <TableCell colSpan={999}>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(true)} data-reach-action="add-record">
            <Icon icon={Plus} size="xs" />
            New
          </Button>
        </TableCell>
      </TableRow>
    );
  }
  return (
    <TableRow>
      <TableCell colSpan={999}>
        <Container layout="horizontal" alignItems="center" gap="xs" padding="none">
          <Input
            ref={inputRef}
            aria-label="New record"
            borderless
            placeholder="Enter record title…"
            value={title}
            onChange={(event) => setTitle(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') submit();
              if (event.key === 'Escape') { setTitle(''); onOpenChange(false); }
            }}
            onBlur={() => { if (!title.trim()) onOpenChange(false); }}
          />
          {title.trim() ? (
            <Button variant="success" size="sm" disabled={busy} onClick={submit}>
              <Icon icon={Check} size="xs" />
            </Button>
          ) : null}
        </Container>
      </TableCell>
    </TableRow>
  );
}

function BoardView(props: ViewProps) {
  const grouping = groupingDescriptorForView(props.view, props.model.fields);
  const sortDescriptor = sortDescriptorOf(props.model);
  const linkDescriptor = hierarchyLinkDescriptor(props.model.fields);
  const topLevel = hierarchyTopLevelRecords(props.records, linkDescriptor);
  const childStats = React.useMemo(() => {
    const stats = new Map<string, { done: number; total: number }>();
    const done = completionLane(props.lanes);
    for (const record of hierarchyTopLevelRecords(props.records, linkDescriptor)) {
      const children = directChildRecordsFor(record, props.model.records, linkDescriptor, new Set([recordViewKey(record)]));
      if (children.length === 0) continue;
      stats.set(recordViewKey(record), {
        total: children.length,
        done: children.filter((child) => done !== null
          && recordGroupValues(child, grouping).includes(done.id)).length,
      });
    }
    return stats;
  }, [props.records, props.model.records, props.lanes, linkDescriptor, grouping]);

  const drop = (draggedId: string, sourceColumnId: string, lane: VisualDatabaseLaneDescriptor, before: VisualDatabaseRecord | null) => {
    const dragged = props.records.find((record) => record.id === draggedId);
    if (!dragged || !props.writeRecord || !grouping) return;
    const rawValue = extractFieldValue(dragged, grouping);
    const groupValue: unknown = lane.id === EMPTY_LANE_ID
      ? null
      : Array.isArray(rawValue)
        ? [...rawValue.map(String).filter((entry) => entry !== sourceColumnId && entry !== lane.id), lane.id]
        : lane.id;
    const groupWrite: FieldWrite = { descriptor: grouping, value: groupValue };
    const column = props.records.filter((record) => (
      record.id !== draggedId && recordGroupValues(record, grouping).includes(lane.id)
    ));
    if (!sortDescriptor || !props.manualOrder) {
      const entry = buildRecordWrite(dragged, [groupWrite]);
      if (entry) submitWrites(props.writeRecord, [entry], 'move');
      return;
    }
    const insertIndex = before ? Math.max(0, column.findIndex((record) => record.id === before.id)) : column.length;
    submitWrites(props.writeRecord, reorderWrites(column, dragged, insertIndex, sortDescriptor, [groupWrite]), 'move');
  };

  const [dropLaneId, setDropLaneId] = React.useState<string | null>(null);
  const [composerLaneId, setComposerLaneId] = React.useState<string | null>(null);
  const [creatingGroup, setCreatingGroup] = React.useState(false);
  const [groupDraft, setGroupDraft] = React.useState('');
  const declaredGroupValues = grouping?.domain?.values ?? [];
  const groupValues = declaredGroupValues.length > 0
    ? declaredGroupValues
    : props.lanes.filter((lane) => lane.id === EMPTY_LANE_ID);
  const sourceOwnedDomain = !!grouping?.domain && (
    !!grouping.domain.fromAddress
    || !!grouping.domain.fromField
    || (grouping.domain.fromRecords?.length ?? 0) > 0
  );
  const canCreateGroup = !!grouping
    && grouping.editable !== false
    && grouping.groupable !== false
    && !sourceOwnedDomain
    && !!props.onPersistChoice;
  const canEditGroupChoices = canCreateGroup && !!props.onPersistPalette;
  const createGroup = () => {
    const label = groupDraft.trim();
    if (!label || !grouping || !props.onPersistChoice) return;
    if (groupValues.some((value) => value.label.toLocaleLowerCase() === label.toLocaleLowerCase())) {
      setGroupDraft('');
      setCreatingGroup(false);
      return;
    }
    const color = paletteColorAt(props.model.palette, groupValues.length);
    props.onPersistChoice(grouping.id, [
      ...groupValues,
      {
        id: uniqueChoiceId(label, groupValues),
        label,
        order: Math.max(0, ...groupValues.map((value) => value.order)) + 10,
        ...(color ? { color } : {}),
      },
    ]);
    setGroupDraft('');
    setCreatingGroup(false);
  };
  // Amie kanban shape: fixed-width lanes on one horizontal rail that scrolls,
  // never a wrapping grid — every lane is always reachable by scrolling right.
  return (
    <Container layout="horizontal" gap="md" padding="none" alignItems="stretch" overflow="x-auto" minHeight="0" data-reach-role="table-view">
      {props.lanes.map((lane) => {
        const laneRecords = topLevel.filter((record) => recordGroupValues(record, grouping).includes(lane.id));
        return (
          <Container key={lane.id} layout="vertical" padding="none" minWidth="272px" minHeight="0">
          <Card
            variant="surface"
            padding="sm"
            layout="stack"
            minHeight="0"
            height="full"
            selected={dropLaneId === lane.id}
            onDragOver={(event: React.DragEvent) => {
              if (!dragCarries(event, 'application/x-record-id')) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = 'move';
              setDropLaneId(lane.id);
            }}
            onDragLeave={(event: React.DragEvent) => {
              // Only clear when truly leaving the column (not entering a child).
              if (!(event.currentTarget as HTMLElement).contains(event.relatedTarget as Node | null)) {
                setDropLaneId((current) => (current === lane.id ? null : current));
              }
            }}
            onDrop={(event: React.DragEvent) => {
              event.preventDefault();
              setDropLaneId(null);
              const draggedId = event.dataTransfer.getData('application/x-record-id');
              const source = event.dataTransfer.getData('application/x-record-source');
              if (draggedId) drop(draggedId, source, lane, null);
            }}
          >
            {/* One resolved identity marker + readable name + quiet count.
                Exact data color owns identity; Screen Look owns readable text. */}
            <Container layout="horizontal" alignItems="center" gap="sm" padding="none">
              <Container layout="horizontal" alignItems="center" gap="xs" padding="none" minWidth="0" flex="1">
                <ColorDot color={optionColor(lane)} size="xs" />
                <Inline gap="xs" align="baseline" grow data-lane-heading-text="" className="leading-none">
                  <Text
                    as="span"
                    variant="heading"
                    color="strong"
                    weight="semibold"
                    truncate
                    title={humanizeSegment(lane.label)}
                  >
                    {humanizeSegment(lane.label)}
                  </Text>
                  <Text as="span" variant="heading" color="faint" tabular className="shrink-0 font-normal">
                    {String(laneRecords.length)}
                  </Text>
                </Inline>
              </Container>
              {props.writeRecord ? (
                <Button
                  variant="ghost"
                  size="xs"
                  aria-label={`New record in ${humanizeSegment(lane.label)}`}
                  onClick={() => setComposerLaneId(lane.id)}
                >
                  <Icon icon={Plus} size="xs" />
                </Button>
              ) : null}
              {canEditGroupChoices && grouping && props.onPersistChoice && props.onPersistPalette ? (
                <Dropdown
                  aria-label={`Edit ${grouping.label} stages`}
                  items={[]}
                  value=""
                  align="end"
                  customTrigger={(
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label={`Edit ${grouping.label} stages`}
                    >
                      <Icon icon={Settings2} size="xs" />
                    </Button>
                  )}
                  panel={(
                    <Container
                      layout="vertical"
                      gap="sm"
                      padding="sm"
                      minWidth="0"
                      data-contextual-choice-editor={grouping.id}
                      style={{ width: 'min(420px, calc(100vw - 32px))', maxHeight: '70vh', overflowY: 'auto' }}
                      onClick={stopEvent}
                    >
                      <Container layout="vertical" gap="none" padding="none">
                        <Text variant="heading-xs" color="strong">{grouping.label} stages</Text>
                        <Text variant="caption" color="faint">
                          Rename, recolor, add, remove, or reorder the lanes shown on this board.
                        </Text>
                      </Container>
                      <ChoiceSettings
                        descriptor={grouping}
                        palette={props.model.palette}
                        onPaletteChange={props.onPersistPalette}
                        onChange={props.onPersistChoice}
                      />
                    </Container>
                  )}
                />
              ) : null}
            </Container>
            {laneRecords.length ? (
              <Container layout="vertical" gap="sm" padding="none" data-reorder-surface>
                {laneRecords.map((record) => (
                  <RecordCard
                    key={recordViewKey(record)}
                    record={record}
                    lanes={props.lanes}
                    model={props.model}
                    view={props.view}
                    grouping={grouping}
                    columnId={lane.id}
                    childStats={childStats.get(record.id)}
                    writeRecord={props.writeRecord}
                    onDropBefore={(draggedId, source, before) => drop(draggedId, source, lane, before)}
                    onDeleteStart={props.onDeleteStart}
                    onDeleteFailure={props.onDeleteFailure}
                  />
                ))}
              </Container>
            ) : (
              <Text variant="caption" color="faint">Nothing here yet.</Text>
            )}
            {props.writeRecord ? (
              <LaneComposer
                lane={lane}
                laneRecords={laneRecords}
                view={props.view}
                model={props.model}
                writeRecord={props.writeRecord}
                open={composerLaneId === lane.id}
                onOpenChange={(open) => setComposerLaneId(open ? lane.id : null)}
              />
            ) : null}
          </Card>
          </Container>
        );
      })}
      {canCreateGroup ? (
        <Container layout="vertical" padding="none" minWidth="240px" minHeight="0">
          <Card variant="surface" padding="sm" layout="stack" minHeight="0">
            {creatingGroup ? (
              <Container layout="horizontal" alignItems="center" gap="xs" padding="none">
                <Container layout="horizontal" padding="none" minHeight="0" flex="1">
                  <Input
                    autoFocus
                    aria-label={`New ${grouping.label}`}
                    borderless
                    placeholder={`${grouping.label} name`}
                    value={groupDraft}
                    onChange={(event) => setGroupDraft(event.currentTarget.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') createGroup();
                      if (event.key === 'Escape') {
                        setGroupDraft('');
                        setCreatingGroup(false);
                      }
                    }}
                    onBlur={() => {
                      if (!groupDraft.trim()) setCreatingGroup(false);
                    }}
                  />
                </Container>
                <Button
                  variant="success"
                  size="icon-xs"
                  aria-label={`Create ${grouping.label}`}
                  disabled={!groupDraft.trim()}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={createGroup}
                >
                  <Icon icon={Check} size="xs" />
                </Button>
              </Container>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                data-reach-action="add-board-group"
                onClick={() => setCreatingGroup(true)}
              >
                <Icon icon={Plus} size="xs" />
                Add {grouping.label.toLocaleLowerCase()}
              </Button>
            )}
          </Card>
        </Container>
      ) : null}
    </Container>
  );
}

/** kind:'timeline' — a real chronological rail. Records group by their ACTUAL
 *  day (from the view's dateField or the date-role descriptor), each day a
 *  section anchored to a spine node, ordered past→future with undated records
 *  trailing. Structurally different from the list's relative buckets: the list
 *  collapses time into Today/Tomorrow/Earlier; the timeline preserves every
 *  distinct date as its own marker. */
function TimelineView(props: ViewProps) {
  const dateDescriptor = props.view.dateField
    ? (props.model.fields.find((descriptor) => descriptor.id === props.view.dateField)
      ?? syntheticFieldDescriptor(props.view.dateField))
    : props.model.fields.find((descriptor) => descriptor.role === 'date') ?? null;
  const grouping = groupingDescriptorForView(props.view, props.model.fields);
  const zoom = props.view.zoom;
  const groups = timelineBucketGroups(props.records, dateDescriptor, zoom);
  if (groups.length === 0) {
    return <EmptyPlaceholder icon={CalendarDays} message="No records to place on the timeline yet." data-reach-role="empty-state" />;
  }
  const todayIso = new Date().toISOString().slice(0, 10);
  const todayBucket = timelineBucketKey(todayIso, zoom);
  return (
    <Container layout="vertical" gap="lg" padding="none">
      {groups.map(({ bucket, records: dayRecords }) => {
        const isToday = bucket === todayBucket;
        return (
          <Container key={bucket ?? 'no-date'} layout="vertical" gap="xs" padding="none">
            <Container layout="horizontal" alignItems="center" gap="sm" padding="none">
              <ColorDot color={isToday ? 'var(--accent-primary)' : 'var(--border-primary)'} size="sm" />
              <Text variant="heading-xs" color={isToday ? 'accent' : 'strong'}>
                {bucket ? humanizeTimelineBucket(bucket, zoom, todayIso) : 'No date'}
              </Text>
              <Text variant="caption" color="faint">{String(dayRecords.length)}</Text>
            </Container>
            <Container layout="vertical" gap="xs" padding="none">
              {dayRecords.map((record) => {
                const key = recordViewKey(record);
                return (
                  <RecordRow
                    key={key}
                    record={record}
                    recordKey={key}
                    lanes={props.lanes}
                    model={props.model}
                    view={props.view}
                    grouping={grouping}
                    expanded={props.expandedId === key}
                    onToggle={props.onToggle}
                    writeRecord={props.writeRecord}
                    onDeleteStart={props.onDeleteStart}
                    onDeleteFailure={props.onDeleteFailure}
                  />
                );
              })}
            </Container>
          </Container>
        );
      })}
    </Container>
  );
}

function SwimlaneView(props: ViewProps) {
  const groups = [...new Set(props.records.map((record) => record.group))].sort();
  return (
    <Container layout="vertical" gap="lg" padding="none">
      {groups.map((group) => {
        const groupRecords = props.records.filter((record) => record.group === group);
        return (
          <Container key={group} layout="vertical" gap="xs" padding="none">
            <Container layout="horizontal" alignItems="center" gap="sm" padding="none">
              <Text variant="heading-xs" color="strong">{humanizeSegment(group)}</Text>
              <Text variant="caption" color="faint">{String(groupRecords.length)}</Text>
            </Container>
            <ListView {...props} records={groupRecords} />
          </Container>
        );
      })}
    </Container>
  );
}

/** Display columns = the field descriptors meant to be SHOWN, in descriptor
 *  order. Purely structural/relational bindings (the record id, the sort key,
 *  the parent link, the kind discriminant) are never columns; every other field
 *  is. An exclude-list, not an allow-list — any role a board invents (status,
 *  link, …) renders as a column for free, with zero edits here. */
const TABLE_STRUCTURAL_ROLES: ReadonlySet<string> = new Set(['id', 'sort', 'link', 'kind']);

function displayColumnDescriptors(model: VisualDatabaseModel): readonly VisualDatabaseFieldDescriptor[] {
  return model.fields.filter((descriptor) => !TABLE_STRUCTURAL_ROLES.has(descriptor.role));
}

/** One grid cell's face: a derived column renders its resolved overlay value
 *  (or honest pending "…" / error chip); a stored column renders the SAME
 *  generic FieldControl the rows/cards use. Zero field vocabulary — "derived"
 *  is a descriptor property, never a branch on WHAT it derives. */
function GridCellFace({ record, column, derived, viewProps, showStale }: {
  record: VisualDatabaseRecord;
  column: VisualDatabaseFieldDescriptor;
  derived: DerivedCell | undefined;
  viewProps: ViewProps;
  showStale?: boolean;
}) {
  if (column.role === 'title') {
    return <Text variant="body-xs" weight="medium" color="strong" truncate>{displayTitle(record)}</Text>;
  }
  if (derived?.derived) {
    if (derived?.errorCode) {
      return <Badge variant="error">Can't compute</Badge>;
    }
    if (!derived) return <Text variant="caption" color="faint">…</Text>;
    if (showStale && derived.stale) {
      const prior = derived.stale.priorResult === null || derived.stale.priorResult === undefined
        ? ''
        : typeof derived.stale.priorResult === 'object'
          ? JSON.stringify(derived.stale.priorResult)
          : String(derived.stale.priorResult);
      return (
        <Container
          layout="vertical"
          gap="xs"
          padding="xs"
          onClick={(event: React.MouseEvent) => event.stopPropagation()}
        >
          <Input
            role="textbox"
            aria-label={`Saved formula for ${column.label}`}
            data-testid="formula-accepted-source"
            value={derived.stale.acceptedSource}
            readOnly
            borderless
          />
          <Text role="status" data-testid="formula-prior-result" variant="body-xs" color="strong">
            {prior}
          </Text>
          <Text
            role="status"
            data-testid="formula-stale-status"
            data-evaluated-dependency-revision={derived.stale.evaluatedDependencyRevision}
            data-current-dependency-revision={derived.stale.currentDependencyRevision}
            variant="caption"
            color="warning"
          >
            Inputs changed. The saved result is still shown.
          </Text>
          <Button
            variant="ghost"
            size="xs"
            data-testid="formula-recalculate"
            onClick={(event: React.MouseEvent) => {
              event.stopPropagation();
              viewProps.onRecalculateCell?.({
                recordRef: recordViewKey(record),
                fieldRef: column.id,
              });
            }}
          >
            Recalculate
          </Button>
        </Container>
      );
    }
    const face = derived.value === null || derived.value === undefined
      ? ''
      : typeof derived.value === 'object' ? JSON.stringify(derived.value) : String(derived.value);
    return <Text variant="body-xs" color="strong" truncate>{face}</Text>;
  }
  return (
    <FieldControl
      record={record}
      descriptor={column}
      model={viewProps.model}
      view={viewProps.view}
      lanes={viewProps.lanes}
      grouping={null}
      writeRecord={viewProps.writeRecord}
    />
  );
}

/** Default tone-key → visual mapping (L090: the decoder emits a raw tone key;
 *  this DATA-style map turns it into a CSS var — overridable, no closed union,
 *  no `if (tone===)`). Unknown tones degrade to the neutral accent. */
const CELL_TONE_COLOR: Record<string, string> = {
  good: 'var(--status-success, #22c55e)',
  warn: 'var(--status-warning, #f59e0b)',
  bad: 'var(--status-error, #ef4444)',
};

/** Wraps a cell face with its BEHAVIORAL applies (beyond UI) — conditional-format
 *  tone (a left accent bar) and validation (an inset error ring + message title),
 *  both resolved from the SAME grid-property descriptors as the visual styles.
 *  Blind: it never names a rule; format/validate are `apply` capability ids. */
function GridCellBehavior({ columnProps, columnBag, value, children }: {
  columnProps: readonly VisualDatabaseGridPropertyDescriptor[];
  columnBag: VisualDatabaseElementStyle | undefined;
  value: unknown;
  children: React.ReactNode;
}) {
  const chain = [columnBag];
  const tone = evaluateCellFormat(columnProps, chain, value);
  const verdict = evaluateCellValidation(columnProps, chain, value);
  if (!tone && verdict.valid) return <>{children}</>;
  const style: React.CSSProperties = {};
  if (tone) { style.borderLeft = `3px solid ${CELL_TONE_COLOR[tone] ?? 'var(--accent-primary)'}`; style.paddingLeft = '6px'; }
  if (!verdict.valid) style.boxShadow = 'inset 0 0 0 1px var(--status-error, #ef4444)';
  return <span style={style} title={verdict.valid ? undefined : verdict.message}>{children}</span>;
}

/** The blind grid-property panel (Airtable/Notion column menu anatomy): a scope
 *  selector (This column / All / Selected) + one generic `PropertyControl` per
 *  descriptor of the column scope. Every control renders from DATA — a
 *  border-radius slider, a divider-line toggle, a label-size segmented, a
 *  validation rule select — with ZERO per-property code. Writes fan the value
 *  into the chosen columns via `setColumnStyleForScope` → onPersist. The scope
 *  selector is the SAME `SegmentedControl` primitive as a segmented widget. */
function GridPropertyPopover({
  descriptors,
  column,
  model,
  allColumnIds,
  selectedColumnIds,
  columnState,
  open,
  anchorRef,
  onDismiss,
  onPersist,
  onPersistField,
  onPersistPalette,
  onPersistChoice,
}: {
  descriptors: readonly VisualDatabaseGridPropertyDescriptor[];
  column: VisualDatabaseFieldDescriptor;
  model: VisualDatabaseModel;
  allColumnIds: readonly string[];
  selectedColumnIds: readonly string[];
  columnState: VisualDatabaseViewColumnState | undefined;
  open: boolean;
  anchorRef: React.RefObject<HTMLElement | null>;
  onDismiss: () => void;
  onPersist: (next: VisualDatabaseViewColumnState, scope: string) => void;
  onPersistField?: (descriptor: VisualDatabaseFieldDescriptor, scope: string) => void;
  onPersistPalette?: (palette: readonly VisualDatabasePaletteColor[]) => void;
  onPersistChoice?: (descriptorId: string, values: readonly VisualDatabaseFieldDomainValue[]) => void;
}) {
  const [scope, setScope] = React.useState('this');
  const ownBag: VisualDatabaseElementStyle | undefined = columnState?.styles?.[column.id];
  const targetIds = scope === 'all' ? allColumnIds
    : scope === 'selected' ? (selectedColumnIds.length > 0 ? selectedColumnIds : [column.id])
    : [column.id];
  const setKey = (key: string, value: unknown) => {
    onPersist(setColumnStyleForScope(columnState, targetIds, key, value), `column ${key}`);
  };
  return (
    <AnchoredOverlay anchorRef={anchorRef} open={open} placement="below" onDismiss={onDismiss}>
      <Container layout="vertical" gap="sm" padding="md" minWidth="390px" style={{ width: 'min(390px, calc(100vw - 32px))' }}>
        {onPersistField && onPersistPalette && onPersistChoice ? (
          <FieldSchemaEditor
            descriptor={column}
            model={model}
            palette={model.palette}
            expanded
            collapsible={false}
            deletePending={false}
            allowDelete={false}
            onChange={onPersistField}
            onPaletteChange={onPersistPalette}
            onChoiceChange={onPersistChoice}
            onDeleteStart={() => {}}
            onDeleteCancel={() => {}}
            onDeleteConfirm={() => {}}
          />
        ) : (
          <Text variant="heading-xs" color="strong">{column.label} appearance</Text>
        )}
        <Text variant="caption" color="faint">Appearance</Text>
        <SegmentedControl
          items={[{ id: 'this', label: 'This column' }, { id: 'all', label: 'All' }, { id: 'selected', label: 'Selected' }]}
          value={scope}
          aria-label="Apply to which columns"
          onValueChange={setScope}
        />
        {descriptors.map((descriptor) => (
          <PropertyControl
            key={descriptor.key}
            descriptor={descriptor}
            value={ownGridPropertyValue(descriptor.key, ownBag)}
            onSet={setKey}
          />
        ))}
      </Container>
    </AnchoredOverlay>
  );
}

/** Per-view row spacing control for table layouts. The property itself remains
 *  descriptor-driven; the view stores the selected CSS value in gridStyle. */
export function RowDensityControl({
  view,
  descriptors,
  onPersist,
}: {
  view: VisualDatabaseViewDescriptor;
  descriptors: readonly VisualDatabaseGridPropertyDescriptor[];
  onPersist?: ViewProps['onPersistView'];
}) {
  const descriptor = descriptors.find((candidate) => candidate.key === 'rowDensity');
  const anchorRef = React.useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = React.useState(false);
  if (!descriptor || !onPersist) return null;
  const value = String(resolveGridProperty(descriptor.key, [view.gridStyle], descriptor.defaultValue) ?? '');
  return (
    <>
      <Button
        ref={anchorRef}
        variant="ghost"
        size="sm"
        aria-label="Row density"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <Icon icon={Rows3} size="xs" />
        Density
      </Button>
      <AnchoredOverlay anchorRef={anchorRef} open={open} placement="below" onDismiss={() => setOpen(false)}>
        <Container layout="vertical" gap="sm" padding="md" minWidth="280px">
          <PropertyControl
            descriptor={descriptor}
            value={value}
            onSet={(key, nextValue) => {
              onPersist(setGridStyleKey(view, key, nextValue), 'row density');
              setOpen(false);
            }}
          />
        </Container>
      </AnchoredOverlay>
    </>
  );
}

/** One grid header cell: label + drag-reorder + edge resize + hover hide + a
 *  gear that opens the blind grid-property panel. All mutations persist as view
 *  `columns`/`styles` DATA through onPersist — presentation state is Society
 *  data, never component-local truth. Resolved column style (label size,
 *  alignment, weight, radius, divider) is stamped inline from the descriptor DATA. */
function GridColumnHeader({
  column,
  model,
  visibleColumns,
  columnState,
  gridProperties,
  selectedColumnIds,
  canPersist,
  onPersist,
  onPersistField,
  onPersistPalette,
  onPersistChoice,
  reorderPreview,
  onReorderPreviewChange,
}: {
  column: VisualDatabaseFieldDescriptor;
  model: VisualDatabaseModel;
  visibleColumns: readonly VisualDatabaseFieldDescriptor[];
  columnState: VisualDatabaseViewColumnState | undefined;
  gridProperties: readonly VisualDatabaseGridPropertyDescriptor[];
  selectedColumnIds: readonly string[];
  canPersist: boolean;
  onPersist: (next: VisualDatabaseViewColumnState, scope: string) => void;
  onPersistField?: ViewProps['onPersistField'];
  onPersistPalette?: ViewProps['onPersistPalette'];
  onPersistChoice?: ViewProps['onPersistChoice'];
  reorderPreview: ReorderPreview | null;
  onReorderPreviewChange: (preview: ReorderPreview | null) => void;
}) {
  const headRef = React.useRef<HTMLTableCellElement>(null);
  const gearRef = React.useRef<HTMLButtonElement | null>(null);
  const [panelOpen, setPanelOpen] = React.useState(false);
  const [dropHover, setDropHover] = React.useState(false);
  const width = columnState?.widths?.[column.id];
  const columnProps = propertiesForScope(gridProperties, 'column');
  const columnIds = visibleColumns.map((candidate) => candidate.id);
  const commitColumnOrder = (orderedIds: string[]) => {
    onPersist({ ...(columnState ?? {}), order: orderedIds }, 'column order');
  };
  // Resolved header style: cascade the column bag over the width alias. Label
  // size / alignment / weight land on the header cell inline (blind to which key).
  const headerStyle = elementStyle(
    columnProps,
    [columnState?.styles?.[column.id], width ? { width } : undefined],
  );
  return (
    <TableHead
      ref={headRef}
      draggable={canPersist}
      className={canPersist ? 'cursor-grab active:cursor-grabbing' : undefined}
      data-field-id={column.id}
      data-field-label={column.label}
      data-field-shape={column.shape}
      data-value-source-ref={column.defaultExpression?.derive?.evaluatorRef ?? 'literal'}
      data-reorder-target-id={column.id}
      width={width}
      style={headerStyle}
      onDragStart={(event: React.DragEvent) => {
        if (!canPersist) return;
        const origin = event.target as HTMLElement;
        if (origin !== event.currentTarget && origin.closest('button, input, textarea, select, [role="button"]')) {
          event.preventDefault();
          return;
        }
        event.dataTransfer.setData(REORDER_DRAG_MIME, column.id);
        event.dataTransfer.effectAllowed = 'move';
        onReorderPreviewChange({ movedId: column.id, beforeId: column.id });
      }}
      onDragEnd={() => {
        setDropHover(false);
        onReorderPreviewChange(null);
      }}
      onDragOver={(event: React.DragEvent) => {
        const movedId = readReorderDragId(event.dataTransfer);
        if (!canPersist || !movedId) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        setDropHover(true);
        const rect = event.currentTarget.getBoundingClientRect();
        onReorderPreviewChange({
          movedId,
          beforeId: beforeIdForTarget(
            columnIds,
            column.id,
            event.clientX >= rect.left + rect.width / 2,
          ),
        });
      }}
      onDragLeave={(event: React.DragEvent) => {
        if (!(event.currentTarget as HTMLElement).contains(event.relatedTarget as Node | null)) setDropHover(false);
      }}
      onDrop={(event: React.DragEvent) => {
        event.preventDefault();
        event.stopPropagation();
        setDropHover(false);
        const draggedId = readReorderDragId(event.dataTransfer);
        onReorderPreviewChange(null);
        if (!draggedId || draggedId === column.id) return;
        const rect = event.currentTarget.getBoundingClientRect();
        const beforeId = beforeIdForTarget(
          columnIds,
          column.id,
          event.clientX >= rect.left + rect.width / 2,
        );
        commitColumnOrder(reorderBeforeId(columnIds, draggedId, beforeId));
      }}
    >
      <DropIndicator
        active={dropHover && reorderPreview?.beforeId === column.id}
        orientation="vertical"
      />
      <DropIndicator
        active={reorderPreview?.beforeId === null && column.id === columnIds.at(-1)}
        orientation="vertical"
        placement="end"
      />
      <HoverRevealGroup layout="horizontal" alignItems="center" gap="xs" padding="none">
        {canPersist ? (
          <ReorderControl
            ids={columnIds}
            itemId={column.id}
            label={`column ${column.label}`}
            orientation="horizontal"
            onPreviewChange={onReorderPreviewChange}
            onReorder={(orderedIds) => commitColumnOrder(orderedIds)}
            className="inline-flex items-center gap-0.5"
          />
        ) : null}
        {/* Label inherits the resolved header font/align/weight from the th style
            (blind to which key set it) so label-size/alignment/weight are pure DATA. */}
        <Text variant="caption" color="muted" weight="medium" truncate style={{ fontSize: 'inherit', fontWeight: 'inherit', textAlign: 'inherit' }}>{column.label}</Text>
        {canPersist ? (
          <HoverRevealItem>
            <Button
              ref={gearRef}
              variant="ghost"
              size="icon-xs"
              aria-label={`Adjust ${column.label}`}
              onClick={(event: React.MouseEvent) => {
                event.stopPropagation();
                setPanelOpen((o) => !o);
              }}
            >
              <Icon icon={Settings2} size="xs" />
            </Button>
          </HoverRevealItem>
        ) : null}
        {canPersist ? (
          <HoverRevealItem>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={`Hide ${column.label}`}
              onClick={(event: React.MouseEvent) => {
                event.stopPropagation();
                onPersist(toggleColumnHidden(columnState, column.id), 'hide field');
              }}
            >
              <Icon icon={EyeOff} size="xs" />
            </Button>
          </HoverRevealItem>
        ) : null}
      </HoverRevealGroup>
      {canPersist ? (
        <GridPropertyPopover
          descriptors={columnProps}
          column={column}
          model={model}
          allColumnIds={visibleColumns.map((c) => c.id)}
          selectedColumnIds={selectedColumnIds}
          columnState={columnState}
          open={panelOpen}
          anchorRef={gearRef}
          onDismiss={() => setPanelOpen(false)}
          onPersist={onPersist}
          onPersistField={onPersistField}
          onPersistPalette={onPersistPalette}
          onPersistChoice={onPersistChoice}
        />
      ) : null}
      {canPersist ? (
        <TableColumnResizeHandle
          label={`Resize ${column.label}`}
          onResize={(deltaX) => {
            const current = width ?? headRef.current?.getBoundingClientRect().width ?? 160;
            onPersist(resizeColumnState(columnState, column.id, current + deltaX), 'column width');
          }}
        />
      ) : null}
    </TableHead>
  );
}

/** Above this many rows the grid windows its DOM; below it, plain rows. */
const GRID_VIRTUALIZATION_THRESHOLD = 200;
function estimatedGridRowHeight(paddingBlock: unknown): number {
  const padding = typeof paddingBlock === 'number'
    ? paddingBlock
    : Number.parseFloat(String(paddingBlock ?? '8px'));
  return Math.max(24, 16 + 2 * (Number.isFinite(padding) ? padding : 8));
}

function ExpressionCellMirror({
  cellKey,
  humanLabel,
  source,
  selection,
  readOnly,
  onDraftChange,
}: {
  cellKey: string;
  humanLabel: string;
  source: string;
  selection: readonly [number, number];
  readOnly: boolean;
  onDraftChange?: (source: string, selection: readonly [number, number]) => void;
}) {
  const inputRef = useControlledTextSelection<HTMLInputElement>(source, selection);
  return (
    <Input
      ref={inputRef}
      role="textbox"
      aria-label={`Formula cell mirror for ${humanLabel}`}
      data-testid="formula-cell-source"
      data-ui-node="formula-cell-source"
      data-cell-key={cellKey}
      data-human-cell-label={humanLabel}
      borderless
      value={source}
      readOnly={readOnly}
      onClick={(event) => event.stopPropagation()}
      onChange={readOnly ? undefined : (event) => {
        const caret = event.currentTarget.selectionStart ?? event.currentTarget.value.length;
        onDraftChange?.(event.currentTarget.value, [caret, caret]);
      }}
      onSelect={(event) => {
        const sourceInput = event.currentTarget;
        onDraftChange?.(
          sourceInput.value,
          [
            sourceInput.selectionStart ?? sourceInput.value.length,
            sourceInput.selectionEnd ?? sourceInput.value.length,
          ],
        );
      }}
    />
  );
}

/** kind:'table' — the descriptor-driven table at grid grade. Headers come from
 *  each display descriptor's label; every cell renders through the SAME
 *  generic FieldControl (title column shows the human title). The column set
 *  IS the descriptor set, filtered/ordered/sized by the view's `columns` DATA
 *  (persisted via onPersistView): add a column by adding a descriptor,
 *  reorder/resize/hide by writing view DATA — zero code here. Keyboard:
 *  arrows/Tab move the focused cell, Enter/F2 marks editing, Esc clears,
 *  Shift+arrow/Shift-click extends a range, Cmd-C copies TSV, Cmd-D fills the
 *  range down from its top row as ONE atomic write-batch. Derived columns
 *  render the resolver overlay (honest pending/error, never fabricated). */
function TableView(props: ViewProps) {
  const records = hierarchyRootRecords(props.records, props.model.fields);
  const columns = applyColumnState(displayColumnDescriptors(props.model), props.view.columns);
  // Grid element property cascade: descriptors (DATA) resolved per element.
  // The surface is BLIND to which key does what — it folds descriptors → styles.
  const gridProperties = props.model.gridProperties;
  const columnProps = propertiesForScope(gridProperties, 'column');
  const gridProps = propertiesForScope(gridProperties, 'grid');
  const rowDensityProperty = gridProps.find((descriptor) => descriptor.key === 'rowDensity');
  const rowPaddingBlock = resolveGridProperty('rowDensity', [props.view.gridStyle], rowDensityProperty?.defaultValue ?? '8px');
  const rowPaddingVariable = rowDensityProperty?.cssProp ?? '--visual-database-row-padding-block';
  const rowHeightEstimate = estimatedGridRowHeight(rowPaddingBlock);
  const gridStyleObj = elementStyle(gridProps, [props.view.gridStyle]);
  const tableMinWidth = columns.reduce((total, column) => total + (props.view.columns?.widths?.[column.id] ?? 160), props.onAddField ? 56 : 0);
  const cellStyleFor = (columnId: string) => ({
    paddingBlock: `var(${rowPaddingVariable}, 8px)`,
    ...elementStyle(columnProps, [props.view.columns?.styles?.[columnId]]),
  });
  const [focus, setFocus] = React.useState<GridCell | null>(null);
  const [rangeFocus, setRangeFocus] = React.useState<GridCell | null>(null);
  const [referenceRange, setReferenceRange] = React.useState<{
    anchor: GridCell;
    focus: GridCell;
  } | null>(null);
  const [composerOpen, setComposerOpen] = React.useState(false);
  const [fillPreview, setFillPreview] = React.useState<FillPreviewProjection | null>(null);
  const tableOwnerRef = React.useRef<HTMLDivElement | null>(null);
  const pickPointer = React.useRef<{
    anchor: GridCell;
    current: GridCell;
    additive: boolean;
  } | null>(null);
  const suppressPickClick = React.useRef(false);
  const sortDescriptor = sortDescriptorOf(props.model);
  const reorderable = Boolean(props.writeRecord && sortDescriptor && props.manualOrder);
  const rowIds = records.map((record) => record.id);
  const [rowReorderPreview, setRowReorderPreview] = React.useState<ReorderPreview | null>(null);
  const [columnReorderPreview, setColumnReorderPreview] = React.useState<ReorderPreview | null>(null);
  const bounds = { rowCount: records.length, columnCount: columns.length };
  const range = focus && rangeFocus ? { anchor: focus, focus: rangeFocus } : null;
  const selectedBounds = range ? rangeBounds(range) : null;
  const selectedColumnIds = selectedBounds
    ? columns.slice(selectedBounds.left, selectedBounds.right + 1).map((c) => c.id)
    : [];
  const focusedRecord = focus ? records[focus.rowIndex] : undefined;
  const focusedColumn = focus ? columns[focus.columnIndex] : undefined;
  const focusedCellRef = focusedRecord && focusedColumn
    ? { recordRef: recordViewKey(focusedRecord), fieldRef: focusedColumn.id }
    : null;
  const focusedExpression = focusedCellRef
    ? props.cellExpressions?.get(cellRefKey(focusedCellRef))?.expression
      ?? focusedColumn?.defaultExpression
    : undefined;
  const admittedEvaluators = focusedColumn
    ? (props.evaluatorDescriptors ?? []).filter((descriptor) => (
        !focusedColumn.evaluatorDescriptorRefs
        || focusedColumn.evaluatorDescriptorRefs.some((entry) => entry.ref === descriptor.ref)
      ))
    : [];
  const formulaEntry = admittedEvaluators
    .flatMap((descriptor) => descriptor.authoring
      ? descriptor.authoring.entryActions
          .filter((action) => action.trigger === 'action')
          .map((action) => ({ descriptor, action }))
      : [])
    .at(0);
  const focusedHasAuthoredExpression = !!focusedExpression?.derive
    && admittedEvaluators.some((descriptor) => (
      descriptor.ref === focusedExpression.derive?.evaluatorRef && !!descriptor.authoring
    ));
  const inRange = (rowIndex: number, columnIndex: number): boolean => (
    !!selectedBounds
    && rowIndex >= selectedBounds.top && rowIndex <= selectedBounds.bottom
    && columnIndex >= selectedBounds.left && columnIndex <= selectedBounds.right
  );
  const referenceBounds = referenceRange ? rangeBounds(referenceRange) : null;
  const inReferenceRange = (rowIndex: number, columnIndex: number): boolean => (
    !!referenceBounds
    && rowIndex >= referenceBounds.top && rowIndex <= referenceBounds.bottom
    && columnIndex >= referenceBounds.left && columnIndex <= referenceBounds.right
  );
  const referenceRefs = (anchor: GridCell, nextFocus: GridCell) => {
    const selected = rangeBounds({ anchor, focus: nextFocus });
    const refs: Array<{ recordRef: string; fieldRef: string }> = [];
    for (let rowIndex = selected.top; rowIndex <= selected.bottom; rowIndex += 1) {
      for (let columnIndex = selected.left; columnIndex <= selected.right; columnIndex += 1) {
        const record = records[rowIndex];
        const column = columns[columnIndex];
        if (record && column) refs.push({ recordRef: recordViewKey(record), fieldRef: column.id });
      }
    }
    return refs;
  };
  const highlightedReferenceCandidates = props.expressionReferencePicking && referenceRange
    ? referenceRefs(referenceRange.anchor, referenceRange.focus).flatMap((ref) => {
        const candidate = props.expressionReferenceCatalog?.candidates.find((entry) => (
          entry.recordRef === ref.recordRef && entry.fieldRef === ref.fieldRef
        ));
        return candidate ? [candidate] : [];
      })
    : [];
  const referenceGesture = (
    fallback: Exclude<ExpressionReferenceSelection['gesture'], 'replace'>,
  ): ExpressionReferenceSelection['gesture'] => (
    props.editingExpressionCell
    && props.editingExpressionCell.selection[0] !== props.editingExpressionCell.selection[1]
      ? 'replace'
      : fallback
  );
  const restoreExpressionSourceFocus = () => {
    const editing = props.editingExpressionCell;
    if (!editing) return;
    const key = cellRefKey({ recordRef: editing.recordRef, fieldRef: editing.fieldRef });
    window.requestAnimationFrame(() => {
      const owner = tableOwnerRef.current?.closest<HTMLElement>('[data-reach-role="visual-database-list"]');
      const source = [...(owner?.querySelectorAll<HTMLElement>(
        '[data-testid="formula-source"], [data-testid="formula-source-read-only"]',
      ) ?? [])].find((candidate) => candidate.dataset.cellKey === key);
      source?.focus({ preventScroll: true });
    });
  };
  const selectReferences = (
    refs: readonly { recordRef: string; fieldRef: string }[],
    gesture: ExpressionReferenceSelection['gesture'],
  ) => {
    props.onExpressionReferenceSelection?.(refs, gesture);
    restoreExpressionSourceFocus();
  };
  React.useEffect(() => {
    if (!props.expressionReferencePicking) setReferenceRange(null);
  }, [props.expressionReferencePicking]);
  React.useEffect(() => {
    const reveal = props.revealExpressionCell;
    if (!reveal) return;
    const rowIndex = records.findIndex((record) => recordViewKey(record) === reveal.recordRef);
    const columnIndex = columns.findIndex((column) => column.id === reveal.fieldRef);
    if (rowIndex < 0 || columnIndex < 0) return;
    setFocus({ rowIndex, columnIndex });
    setRangeFocus(null);
    const revealMountedCell = () => {
      const target = [...(tableOwnerRef.current?.querySelectorAll<HTMLElement>('[data-record-ref][data-field-ref]') ?? [])]
        .find((cell) => (
          cell.dataset.recordRef === reveal.recordRef
          && cell.dataset.fieldRef === reveal.fieldRef
        ));
      if (typeof target?.scrollIntoView === 'function') {
        target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      }
      target?.focus();
      return !!target;
    };
    window.requestAnimationFrame(() => {
      if (revealMountedCell()) return;
      const scrollOwner = tableOwnerRef.current?.closest<HTMLElement>('[data-reach-role="visual-database-list"]');
      if (scrollOwner) scrollOwner.scrollTop = Math.max(0, rowIndex * rowHeightEstimate);
      window.requestAnimationFrame(revealMountedCell);
    });
  }, [columns, props.revealExpressionCell, records]);
  const persistColumns = (next: VisualDatabaseViewColumnState, scope: string) => {
    props.onPersistView?.({ ...props.view, columns: next }, scope);
  };
  const commitRowOrder = (orderedIds: string[], movedId: string) => {
    if (!props.writeRecord || !sortDescriptor) return;
    const dragged = records.find((candidate) => candidate.id === movedId);
    const insertIndex = orderedIds.indexOf(movedId);
    if (!dragged || insertIndex < 0) return;
    submitWrites(
      props.writeRecord,
      reorderWrites(records, dragged, insertIndex, sortDescriptor, []),
      'reorder',
    );
    setRowReorderPreview(null);
  };
  const onGridKeyDown = (event: React.KeyboardEvent) => {
    if (!focus) return;
    const active = document.activeElement;
    if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement
      || (active instanceof HTMLElement && active.isContentEditable)) return;
    if (event.key === 'Escape') {
      setFocus(null);
      setRangeFocus(null);
      return;
    }
    if ((event.key === 'F2' || event.key === '=') && props.onEditCellExpression) {
      const record = records[focus.rowIndex];
      const column = columns[focus.columnIndex];
      if (record && column) {
        event.preventDefault();
        props.onEditCellExpression(record, column, event.key === '=' ? 'equals' : 'f2');
      }
      return;
    }
    if ((event.metaKey || event.ctrlKey) && (event.key === 'c' || event.key === 'C')) {
      const copyRange = range ?? { anchor: focus, focus };
      const tsv = rangeToTsv(records, columns, copyRange, (record, descriptor) => (
        props.derivedCells?.get(recordViewKey(record))?.get(descriptor.id)?.derived
          ? String(props.derivedCells?.get(recordViewKey(record))?.get(descriptor.id)?.value ?? '')
          : String(props.cellExpressions?.get(JSON.stringify([recordViewKey(record), descriptor.id]))?.expression?.literal ?? extractFieldText(record, descriptor).join(', '))
      ));
      if (tsv) {
        event.preventDefault();
        void copyTextToClipboard(tsv).then((copied) => { if (copied) reportSuccess('Copied'); });
      }
      return;
    }
    // Cmd-D: freeze one addressed preview/commit plan. Nothing writes until
    // the human confirms the exact original/transformed sources and targets.
    if ((event.metaKey || event.ctrlKey) && (event.key === 'd' || event.key === 'D') && range && props.writeRecord) {
      event.preventDefault();
      const plan = buildFillDownExpressionPlan(records, columns, range, (record, descriptor) => {
        const current = props.cellExpressions?.get(JSON.stringify([recordViewKey(record), descriptor.id]));
        return {
          expression: current?.expression ?? descriptor.defaultExpression ?? { literal: extractFieldValue(record, descriptor) },
          sourceExpectedCurrent: current?.sourceExpectedCurrent,
        };
      });
      if (plan.entries.length === 0) return;
      setFillPreview({
        writes: plan.writes,
        rows: plan.entries.map((entry) => {
          const sourceRecord = records.find((record) => (
            recordViewKey(record) === entry.sourceCell.recordRef
          ));
          const destinationRecord = records.find((record) => (
            recordViewKey(record) === entry.destinationCell.recordRef
          ));
          const descriptor = columns.find((candidate) => (
            candidate.id === entry.destinationCell.fieldRef
          ));
          const original = humanFillSource(
            entry.originalExpression,
            props.evaluatorDescriptors ?? [],
          );
          const transformed = humanFillSource(
            entry.transformedExpression,
            props.evaluatorDescriptors ?? [],
          );
          return {
            sourceCell: entry.sourceCell,
            destinationCell: entry.destinationCell,
            sourceLabel: `${sourceRecord ? displayTitle(sourceRecord) : 'Missing record'} · ${descriptor?.label ?? 'Missing field'}`,
            destinationLabel: `${destinationRecord ? displayTitle(destinationRecord) : 'Missing record'} · ${descriptor?.label ?? 'Missing field'}`,
            originalSource: original.source,
            transformedSource: transformed.source,
            diagnostics: [...new Set([...original.diagnostics, ...transformed.diagnostics])],
          };
        }),
      });
      return;
    }
    const move = keyToMove(event.key, event.shiftKey);
    if (!move) return;
    event.preventDefault();
    if (event.shiftKey && move !== 'previous') {
      const next = moveCell(rangeFocus ?? focus, bounds, move);
      if (next) setRangeFocus(next);
      return;
    }
    const next = moveCell(focus, bounds, move);
    if (next) {
      setFocus(next);
      setRangeFocus(null);
    }
  };
  if (columns.length === 0) {
    return <EmptyPlaceholder icon={Table2} message="No fields to show." data-reach-role="empty-state" />;
  }
  const renderRow = (record: VisualDatabaseRecord, rowIndex: number) => {
    const key = recordViewKey(record);
    const derivedForRecord = props.derivedCells?.get(key);
    const latestRecord = Boolean(
      props.latestRecordRefs?.includes(recordAddress(record) ?? '')
      || props.latestRecordRefs?.includes(key),
    );
    return (
      <TableRow
        key={key}
        interactive
        data-reorder-target-id={record.id}
        data-record-highlighted={latestRecord ? 'latest' : undefined}
        aria-description={latestRecord ? 'Produced by the latest run.' : undefined}
        className={[
          rowReorderPreview?.beforeId === record.id ? 'bg-[var(--glass-bg-active)]' : '',
          latestRecord ? 'bg-[color-mix(in_srgb,var(--accent-primary)_10%,transparent)] shadow-[inset_2px_0_0_var(--accent-primary)]' : '',
        ].filter(Boolean).join(' ') || undefined}
        onClick={() => props.onToggle(key)}
        onDragOver={(event: React.DragEvent) => {
          const movedId = readReorderDragId(event.dataTransfer);
          if (!reorderable || !movedId) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = 'move';
          const rect = event.currentTarget.getBoundingClientRect();
          setRowReorderPreview({
            movedId,
            beforeId: beforeIdForTarget(
              rowIds,
              record.id,
              event.clientY >= rect.top + rect.height / 2,
            ),
          });
        }}
        onDrop={(event: React.DragEvent) => {
          event.preventDefault();
          event.stopPropagation();
          const draggedId = readReorderDragId(event.dataTransfer);
          if (!draggedId) return;
          const rect = event.currentTarget.getBoundingClientRect();
          const beforeId = beforeIdForTarget(
            rowIds,
            record.id,
            event.clientY >= rect.top + rect.height / 2,
          );
          commitRowOrder(reorderBeforeId(rowIds, draggedId, beforeId), draggedId);
        }}
      >
        {columns.map((column, columnIndex) => {
          const recordRef = recordViewKey(record);
          const isFocused = focus?.rowIndex === rowIndex && focus?.columnIndex === columnIndex;
          const isEditing = props.editingExpressionCell?.recordRef === recordRef
            && props.editingExpressionCell.fieldRef === column.id;
          const reference = props.expressionReferenceCatalog?.candidates.find((candidate) => (
            candidate.recordRef === recordRef && candidate.fieldRef === column.id
          ));
          const humanLabel = `${displayTitle(record)} · ${column.label}`;
          const isReferenceHighlighted = Boolean(
            props.expressionReferencePicking
            && reference
            && inReferenceRange(rowIndex, columnIndex),
          );
          const isReferenceAnchor = Boolean(
            isReferenceHighlighted
            && referenceRange?.anchor.rowIndex === rowIndex
            && referenceRange.anchor.columnIndex === columnIndex,
          );
          return (
          <TableCell
            key={column.id}
            className={columnIndex === 0 ? 'relative' : undefined}
            role="gridcell"
            aria-rowindex={rowIndex + 2}
            aria-colindex={columnIndex + 1}
            aria-selected={isFocused || inRange(rowIndex, columnIndex)}
            tabIndex={isFocused ? 0 : -1}
            id={isFocused ? 'selected-cell' : undefined}
            data-testid={isFocused ? 'selected-cell' : reference ? `formula-reference-${reference.displayAlias}` : undefined}
            data-ui-node={isFocused ? 'selected-cell' : 'visual-database-cell'}
            data-human-cell-label={humanLabel}
            data-record-ref={recordRef}
            data-field-ref={column.id}
            data-cell-identity={cellRefKey({ recordRef, fieldRef: column.id })}
            data-cell-key={cellRefKey({ recordRef, fieldRef: column.id })}
            data-reference-id={reference?.id}
            data-context-key={reference?.bindingKey}
            data-reference-highlighted={isReferenceHighlighted || undefined}
            coarsePointerTarget={Boolean(props.expressionReferencePicking && reference)}
            width={props.view.columns?.widths?.[column.id]}
            style={cellStyleFor(column.id)}
            focused={isFocused || isReferenceAnchor}
            selected={inRange(rowIndex, columnIndex) || isReferenceHighlighted}
            onFocus={() => {
              setFocus({ rowIndex, columnIndex });
              setRangeFocus(null);
            }}
            onClick={(event: React.MouseEvent) => {
              if (props.expressionReferencePicking) {
                event.preventDefault();
                event.stopPropagation();
                if (suppressPickClick.current) return;
                const target = { rowIndex, columnIndex };
                const anchor = event.shiftKey && referenceRange
                  ? referenceRange.anchor
                  : target;
                selectReferences(
                  referenceRefs(anchor, target),
                  referenceGesture(event.shiftKey && referenceRange
                    ? 'range'
                    : event.metaKey || event.ctrlKey
                      ? 'multiple'
                      : 'single'),
                );
                setReferenceRange({ anchor, focus: target });
                return;
              }
              if (column.role !== 'title') event.stopPropagation();
              if (event.shiftKey && focus) {
                setRangeFocus({ rowIndex, columnIndex });
                return;
              }
              setFocus({ rowIndex, columnIndex });
              setRangeFocus(null);
            }}
            onPointerDown={(event: React.PointerEvent) => {
              if (!props.expressionReferencePicking || event.button !== 0) return;
              event.preventDefault();
              event.stopPropagation();
              const target = { rowIndex, columnIndex };
              pickPointer.current = {
                anchor: event.shiftKey && referenceRange
                  ? referenceRange.anchor
                  : target,
                current: target,
                additive: event.metaKey || event.ctrlKey,
              };
            }}
            onPointerEnter={() => {
              if (!props.expressionReferencePicking || !pickPointer.current) return;
              pickPointer.current.current = { rowIndex, columnIndex };
              setReferenceRange({
                anchor: pickPointer.current.anchor,
                focus: { rowIndex, columnIndex },
              });
            }}
            onPointerUp={(event: React.PointerEvent) => {
              if (!props.expressionReferencePicking || !pickPointer.current) return;
              event.preventDefault();
              event.stopPropagation();
              const transaction = pickPointer.current;
              transaction.current = { rowIndex, columnIndex };
              pickPointer.current = null;
              const isRange = transaction.anchor.rowIndex !== transaction.current.rowIndex
                || transaction.anchor.columnIndex !== transaction.current.columnIndex;
              selectReferences(
                referenceRefs(transaction.anchor, transaction.current),
                referenceGesture(isRange ? 'range' : transaction.additive ? 'multiple' : 'single'),
              );
              setReferenceRange({
                anchor: transaction.anchor,
                focus: transaction.current,
              });
              suppressPickClick.current = true;
              queueMicrotask(() => { suppressPickClick.current = false; });
            }}
            onDoubleClick={(event: React.MouseEvent) => {
              event.stopPropagation();
              setFocus({ rowIndex, columnIndex });
              setRangeFocus(null);
              setReferenceRange(null);
              props.onEditCellExpression?.(record, column, 'double-click');
            }}
          >
            {columnIndex === 0 ? (
              <>
                <DropIndicator active={rowReorderPreview?.beforeId === record.id} />
                <DropIndicator
                  active={rowReorderPreview?.beforeId === null && record.id === rowIds.at(-1)}
                  placement="end"
                />
                {reorderable ? (
                  <ReorderControl
                    ids={rowIds}
                    itemId={record.id}
                    label={`row ${displayTitle(record)}`}
                    orientation="vertical"
                    onPreviewChange={setRowReorderPreview}
                    onReorder={commitRowOrder}
                    className="mr-1 inline-flex items-center gap-0.5 align-middle"
                  />
                ) : null}
              </>
            ) : null}
            {isEditing && props.editingExpressionCell ? (
              <ExpressionCellMirror
                cellKey={cellRefKey({ recordRef, fieldRef: column.id })}
                humanLabel={props.editingExpressionCell.humanLabel}
                source={props.editingExpressionCell.source}
                selection={props.editingExpressionCell.selection}
                readOnly={!props.writeRecord}
                onDraftChange={props.onEditingExpressionDraftChange}
              />
            ) : (
              <GridCellBehavior columnProps={columnProps} columnBag={props.view.columns?.styles?.[column.id]} value={extractFieldValue(record, column)}>
                <GridCellFace
                  record={record}
                  column={column}
                  derived={derivedForRecord?.get(column.id)}
                  viewProps={props}
                  showStale={isFocused}
                />
              </GridCellBehavior>
            )}
          </TableCell>
          );
        })}
      </TableRow>
    );
  };
  const headRows = records.slice(0, GRID_VIRTUALIZATION_THRESHOLD);
  const tailRows = records.slice(GRID_VIRTUALIZATION_THRESHOLD);
  return (
    <Container
      ref={tableOwnerRef}
      layout="vertical"
      padding="none"
      minHeight="0"
      tabIndex={0}
      onKeyDown={onGridKeyDown}
      data-reach-role="table-view"
      data-ui-node="visual-database-table-owner"
    >
      <FloatingPanel
        open={fillPreview !== null}
        onClose={() => setFillPreview(null)}
        title="Review fill"
        description="Check every addressed destination and transformed source before saving."
        width={768}
      >
        {fillPreview ? (
          <Container
            layout="vertical"
            gap="sm"
            padding="none"
            data-testid="fill-preview"
            data-destination-count={fillPreview.rows.length}
          >
            <Container
              role="list"
              aria-label="Fill destinations"
              layout="vertical"
              gap="xs"
              padding="none"
              maxHeight="min(26rem, 55dvh)"
              overflow="y-auto"
            >
              {fillPreview.rows.map((row) => (
                <Container
                  key={cellRefKey(row.destinationCell)}
                  role="listitem"
                  layout="vertical"
                  gap="xs"
                  padding="sm"
                  data-testid="fill-preview-row"
                  data-source-cell-key={cellRefKey(row.sourceCell)}
                  data-destination-cell-key={cellRefKey(row.destinationCell)}
                  style={{ borderRadius: 8, background: 'var(--glass-bg-subtle)' }}
                >
                  <Container layout="horizontal" gap="sm" padding="none" justifyContent="between">
                    <Text variant="body-sm" color="muted">
                      Source: {row.sourceLabel}
                    </Text>
                    <Text variant="body-sm" color="strong">
                      Destination: {row.destinationLabel}
                    </Text>
                  </Container>
                  <Container layout="grid" gridCols="2" gap="sm" padding="none">
                    <Container layout="vertical" gap="none" padding="none" minWidth="0">
                      <Text variant="caption" color="faint">Original</Text>
                      <Text
                        variant="body-sm"
                        data-testid="fill-original-source"
                        style={{ fontFamily: 'var(--font-mono)' }}
                      >
                        {row.originalSource}
                      </Text>
                    </Container>
                    <Container layout="vertical" gap="none" padding="none" minWidth="0">
                      <Text variant="caption" color="faint">Filled</Text>
                      <Text
                        variant="body-sm"
                        data-testid="fill-transformed-source"
                        style={{ fontFamily: 'var(--font-mono)' }}
                      >
                        {row.transformedSource}
                      </Text>
                    </Container>
                  </Container>
                  <Text
                    role={row.diagnostics.length > 0 ? 'alert' : 'status'}
                    variant="body-xs"
                    color={row.diagnostics.length > 0 ? 'danger' : 'muted'}
                    data-testid="fill-diagnostics"
                  >
                    {row.diagnostics.length > 0 ? row.diagnostics.join(' ') : 'Ready to fill'}
                  </Text>
                </Container>
              ))}
            </Container>
            <Container layout="horizontal" gap="xs" padding="none" justifyContent="end">
              <Button variant="ghost" size="sm" onClick={() => setFillPreview(null)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                size="sm"
                data-testid="confirm-fill"
                disabled={fillPreview.rows.some((row) => row.diagnostics.length > 0)}
                onClick={() => {
                  const writes = fillPreview.writes;
                  setFillPreview(null);
                  props.writeRecord?.batch(writes)
                    .then(() => reportSuccess('Saved'))
                    .catch(reportFailure('fill down'));
                }}
              >
                Fill {fillPreview.rows.length}
              </Button>
            </Container>
          </Container>
        ) : null}
      </FloatingPanel>
      {highlightedReferenceCandidates.length > 0 ? (
        <Container
          role="list"
          aria-label="Selected formula references"
          data-testid="formula-reference-highlights"
          data-ui-node="formula-reference-highlights"
          data-reference-ids={JSON.stringify(highlightedReferenceCandidates.map((candidate) => candidate.id))}
          layout="horizontal"
          gap="xs"
          padding="none"
          wrap="wrap"
        >
          {highlightedReferenceCandidates.map((candidate) => (
            <Text
              key={candidate.id}
              role="listitem"
              data-reference-id={candidate.id}
              data-record-ref={candidate.recordRef}
              data-field-ref={candidate.fieldRef}
              data-context-key={candidate.bindingKey}
              data-reference-highlighted="true"
              variant="body-xs"
            >
              ✓ {candidate.displayAlias}
            </Text>
          ))}
        </Container>
      ) : null}
      {focusedRecord && focusedColumn && formulaEntry && props.onEditCellExpression ? (
        <Container layout="horizontal" alignItems="center" gap="xs" padding="none">
          <Button
            variant="ghost"
            size="sm"
            data-testid="formula-entry-action"
            data-ui-node="formula-entry-action"
            onClick={() => props.onEditCellExpression?.(
              focusedRecord,
              focusedColumn,
              formulaEntry.action.id,
            )}
          >
            {focusedHasAuthoredExpression
              ? formulaEntry.action.label.replace(/^add\b/i, 'Edit')
              : formulaEntry.action.label}
          </Button>
        </Container>
      ) : null}
      <Container layout="horizontal" alignItems="center" justifyContent="end" padding="none">
        <RowDensityControl view={props.view} descriptors={gridProps} onPersist={props.onPersistView} />
      </Container>
      <Table
        role="grid"
        aria-label={`${props.view.label} records`}
        data-testid="visual-database-table"
        data-ui-node="visual-database-table"
        style={{ ...gridStyleObj, minWidth: tableMinWidth }}
      >
        <TableHeader>
          <TableRow>
            {columns.map((column) => (
              <GridColumnHeader
                key={column.id}
                column={column}
                model={props.model}
                visibleColumns={columns}
                columnState={props.view.columns}
                gridProperties={gridProperties}
                selectedColumnIds={selectedColumnIds}
                canPersist={!!props.onPersistView}
                onPersist={persistColumns}
                onPersistField={props.onPersistField}
                onPersistPalette={props.onPersistPalette}
                onPersistChoice={props.onPersistChoice}
                reorderPreview={columnReorderPreview}
                onReorderPreviewChange={setColumnReorderPreview}
              />
            ))}
            {props.onAddField ? (
              <TableHead>
                <AddFieldButton existingFields={props.model.fields} evaluators={props.evaluatorDescriptors} onAdd={props.onAddField} />
              </TableHead>
            ) : null}
          </TableRow>
        </TableHeader>
        <TableBody>{headRows.map(renderRow)}</TableBody>
      </Table>
      {tailRows.length > 0 ? (
        // <tbody> can't window block-positioned rows through the shared
        // VirtualList; beyond the threshold each windowed row is its own
        // single-row table with identical cell markup — O(visible) DOM.
        <VirtualList
          items={tailRows}
          itemKey={(record) => recordViewKey(record)}
          estimateSize={() => rowHeightEstimate}
          threshold={0}
          scrollParent="nearest"
          renderItem={(record, index) => (
            <Table style={{ ...gridStyleObj, minWidth: tableMinWidth }}>
              <TableBody>{renderRow(record, GRID_VIRTUALIZATION_THRESHOLD + index)}</TableBody>
            </Table>
          )}
        />
      ) : null}
      {props.writeRecord ? (
        <Table style={{ minWidth: tableMinWidth }}>
          <TableBody>
            <TableRowComposer
              records={records}
              view={props.view}
              model={props.model}
              writeRecord={props.writeRecord}
              open={composerOpen}
              onOpenChange={setComposerOpen}
            />
          </TableBody>
        </Table>
      ) : null}
    </Container>
  );
}

/** Recursive node for the kind:'graph' (tree) view. Renders one record row with
 *  a disclosure chevron when it has children; expanded children nest inside a
 *  nested Card (the Notion toggle-list anatomy — padding gives the indent, no
 *  raw CSS). Depth is unbounded; cycles are already broken upstream by
 *  treeForRecords' visited set. */
function TreeNodeRow({ node, expanded, onToggleExpand, onOpen }: {
  node: VisualDatabaseTreeNode;
  expanded: ReadonlySet<string>;
  onToggleExpand: (key: string) => void;
  onOpen: (key: string) => void;
}) {
  const key = recordViewKey(node.record);
  const hasChildren = node.children.length > 0;
  const isOpen = expanded.has(key);
  return (
    <Container layout="vertical" gap="xs" padding="none">
      <Container layout="horizontal" alignItems="center" gap="sm" padding="none">
        {hasChildren ? (
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={isOpen ? 'Collapse' : 'Expand'}
            onClick={() => onToggleExpand(key)}
          >
            <Icon icon={isOpen ? ChevronDown : ChevronRight} size="xs" />
          </Button>
        ) : (
          <Icon icon={GitBranch} size="xs" />
        )}
        <Container layout="horizontal" alignItems="center" gap="sm" padding="none" onClick={() => onOpen(key)}>
          <Text variant="body-xs" weight="medium" color="strong" clamp={1}>{displayTitle(node.record)}</Text>
          {hasChildren ? <Text variant="caption" color="faint">{String(node.children.length)}</Text> : null}
        </Container>
      </Container>
      {hasChildren && isOpen ? (
        <Card variant="nested" padding="sm" layout="stack">
          {node.children.map((child) => (
            <TreeNodeRow
              key={recordViewKey(child.record)}
              node={child}
              expanded={expanded}
              onToggleExpand={onToggleExpand}
              onOpen={onOpen}
            />
          ))}
        </Card>
      ) : null}
    </Container>
  );
}

/** kind:'graph' — a real relationship tree. The parent→child structure comes
 *  entirely from the link descriptor via treeForRecords (already cycle-safe);
 *  this renders that nesting recursively with expand/collapse. Generic: zero
 *  field vocabulary — the hierarchy is whatever the link field declares. */
function RelationshipView(props: ViewProps) {
  const linkDescriptor = hierarchyLinkDescriptor(props.model.fields);
  const { roots } = treeProjectionForRecords(props.records, linkDescriptor);
  // Default-open the first level so the hierarchy is visible without a click;
  // deeper levels start collapsed (Notion/Linear sub-issue anatomy).
  const [expanded, setExpanded] = React.useState<ReadonlySet<string>>(
    () => new Set(roots.filter((node) => node.children.length > 0).map((node) => recordViewKey(node.record))),
  );
  const toggleExpand = React.useCallback((key: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);
  if (roots.length === 0) {
    return <EmptyPlaceholder icon={GitBranch} message="No records to relate yet." data-reach-role="empty-state" />;
  }
  return (
    <Container layout="vertical" gap="xs" padding="none">
      {roots.map((node) => (
        <TreeNodeRow
          key={recordViewKey(node.record)}
          node={node}
          expanded={expanded}
          onToggleExpand={toggleExpand}
          onOpen={props.onToggle}
        />
      ))}
    </Container>
  );
}

// Canvas card footprint — one shared shape for render AND the deterministic
// default grid, so unsaved cards tile without overlap at exactly their size.
const CANVAS_CARD = { w: 280, h: 76, gap: 16, columns: 4 } as const;

function reachableCanvasPosition(position: { x: number; y: number }): { x: number; y: number } {
  return {
    x: Number.isFinite(position.x) ? Math.max(0, position.x) : 0,
    y: Number.isFinite(position.y) ? Math.max(0, position.y) : 0,
  };
}

export function CanvasView(props: ViewProps) {
  const canvasPositionsFromView = props.view.canvasPositions ?? {};
  const [positions, setPositions] = React.useState<Readonly<Record<string, { x: number; y: number }>>>(canvasPositionsFromView);
  const [dragging, setDragging] = React.useState<string | null>(null);
  const [keyboardPlacement, setKeyboardPlacement] = React.useState<{
    key: string;
    origin: { x: number; y: number };
  } | null>(null);
  const [placementAnnouncement, setPlacementAnnouncement] = React.useState('');
  const containerRef = React.useRef<HTMLDivElement>(null);
  const positionsRef = React.useRef(positions);
  const pointerPlacement = React.useRef<{
    key: string;
    pointerId: number;
    lastX: number;
    lastY: number;
    origin: { x: number; y: number };
  } | null>(null);

  const replacePositions = React.useCallback((
    next: Readonly<Record<string, { x: number; y: number }>>,
  ) => {
    positionsRef.current = next;
    setPositions(next);
  }, []);

  const positionFor = React.useCallback((key: string) => (
    reachableCanvasPosition(positionsRef.current[key]
      ?? canvasDefaultPosition(
        Math.max(0, props.records.findIndex((record) => recordViewKey(record) === key)),
        CANVAS_CARD,
      ))
  ), [props.records]);

  const persistPlacement = React.useCallback((
    next: Readonly<Record<string, { x: number; y: number }>>,
    announcement: string,
  ) => {
    replacePositions(next);
    props.onPersistView?.({ ...props.view, canvasPositions: next }, 'canvas-positions');
    setPlacementAnnouncement(announcement);
  }, [props, replacePositions]);

  /** One input-independent placement operation. Pointer, keyboard, and button
   * controls all reach this exact state transition and persistence seam. */
  const placeBy = React.useCallback((
    key: string,
    delta: { x: number; y: number },
    commit: boolean,
    announcement: string,
  ) => {
    const current = positionFor(key);
    const next = {
      ...positionsRef.current,
      [key]: {
        x: Math.max(0, current.x + delta.x),
        y: Math.max(0, current.y + delta.y),
      },
    };
    if (commit) persistPlacement(next, announcement);
    else replacePositions(next);
  }, [persistPlacement, positionFor, replacePositions]);

  const finishPointerPlacement = React.useCallback((cancelled: boolean) => {
    const active = pointerPlacement.current;
    if (!active) return;
    const record = props.records.find((candidate) => recordViewKey(candidate) === active.key);
    pointerPlacement.current = null;
    setDragging(null);
    if (cancelled) {
      replacePositions({ ...positionsRef.current, [active.key]: active.origin });
      setPlacementAnnouncement(`${record ? displayTitle(record) : 'Card'} move cancelled`);
      return;
    }
    persistPlacement(
      positionsRef.current,
      `${record ? displayTitle(record) : 'Card'} position saved`,
    );
  }, [persistPlacement, props.records, replacePositions]);

  const handlePointerDown = (event: React.PointerEvent, key: string) => {
    if (!containerRef.current || (event.pointerType === 'mouse' && event.button !== 0)) return;
    event.preventDefault();
    containerRef.current.setPointerCapture?.(event.pointerId);
    pointerPlacement.current = {
      key,
      pointerId: event.pointerId,
      lastX: event.clientX,
      lastY: event.clientY,
      origin: positionFor(key),
    };
    setDragging(key);
    setPlacementAnnouncement('Moving card');
  };

  const handlePointerMove = (event: React.PointerEvent) => {
    const active = pointerPlacement.current;
    if (!active || active.pointerId !== event.pointerId) return;
    event.preventDefault();
    placeBy(
      active.key,
      { x: event.clientX - active.lastX, y: event.clientY - active.lastY },
      false,
      '',
    );
    active.lastX = event.clientX;
    active.lastY = event.clientY;
  };

  const handleCardKeyDown = (event: React.KeyboardEvent, key: string, label: string) => {
    if ((event.key === 'Enter' || event.key === ' ') && keyboardPlacement?.key !== key) {
      event.preventDefault();
      setKeyboardPlacement({ key, origin: positionFor(key) });
      setPlacementAnnouncement(`${label} ready to move. Use arrow keys, Enter to save, Escape to cancel.`);
      return;
    }
    if (keyboardPlacement?.key !== key) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      replacePositions({ ...positionsRef.current, [key]: keyboardPlacement.origin });
      setKeyboardPlacement(null);
      setPlacementAnnouncement(`${label} move cancelled`);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      persistPlacement(positionsRef.current, `${label} position saved`);
      setKeyboardPlacement(null);
      return;
    }
    const step = event.shiftKey ? 1 : 16;
    const delta = event.key === 'ArrowLeft' ? { x: -step, y: 0 }
      : event.key === 'ArrowRight' ? { x: step, y: 0 }
        : event.key === 'ArrowUp' ? { x: 0, y: -step }
          : event.key === 'ArrowDown' ? { x: 0, y: step }
            : null;
    if (!delta) return;
    event.preventDefault();
    placeBy(key, delta, false, `${label} moved`);
    const next = positionFor(key);
    setPlacementAnnouncement(`${label} at ${Math.round(next.x)}, ${Math.round(next.y)}`);
  };

  // The feed is durable truth (same posture as the optimistic-views overlay):
  // a views-record delivery with new saved positions replaces the local drag state.
  React.useEffect(() => {
    const reachable = Object.fromEntries(Object.entries(canvasPositionsFromView).map(([key, position]) => [
      key,
      reachableCanvasPosition(position),
    ]));
    replacePositions(reachable);
    if (!sameJsonValue(reachable, canvasPositionsFromView)) {
      props.onPersistView?.(
        { ...props.view, canvasPositions: reachable },
        'canvas-positions',
      );
      setPlacementAnnouncement('Canvas positions repaired and saved');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.view]);

  React.useEffect(() => {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement)) return;
    const card = active.closest<HTMLElement>('[data-canvas-card-key]');
    card?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [positions]);

  if (props.records.length === 0) {
    return <EmptyPlaceholder icon={LayoutPanelLeft} message="No records to display on canvas." data-reach-role="empty-state" />;
  }
  const renderedPositions = Object.fromEntries(props.records.map((record, index) => {
    const key = recordViewKey(record);
    return [key, reachableCanvasPosition(
      positions[key] ?? canvasDefaultPosition(index, CANVAS_CARD),
    )];
  }));
  const contentWidth = Math.max(
    600,
    ...Object.values(renderedPositions).map(({ x }) => x + CANVAS_CARD.w + CANVAS_CARD.gap),
  );
  const contentHeight = Math.max(
    600,
    ...Object.values(renderedPositions).map(({ y }) => y + CANVAS_CARD.h + CANVAS_CARD.gap),
  );

  return (
    <Container
      ref={containerRef}
      layout="vertical"
      gap="none"
      padding="lg"
      style={{
        position: 'relative',
        height: '600px',
        border: '1px solid var(--border-secondary)',
        borderRadius: 'var(--radius-control)',
        backgroundColor: 'var(--surface-primary)',
        overflow: 'auto',
      }}
      data-scroll-owner="canvas-placement"
      onPointerMove={dragging ? handlePointerMove : undefined}
      onPointerUp={() => finishPointerPlacement(false)}
      onPointerCancel={() => finishPointerPlacement(true)}
    >
      <span className="sr-only" role="status" aria-live="polite">{placementAnnouncement}</span>
      <div
        style={{
          position: 'relative',
          width: `${contentWidth}px`,
          height: `${contentHeight}px`,
          minWidth: '100%',
          minHeight: '100%',
        }}
      >
      {props.records.map((record) => {
        const key = recordViewKey(record);
        const pos = renderedPositions[key]!;
        const label = displayTitle(record);
        return (
          <Container
            key={key}
            data-canvas-card-key={key}
            role="group"
            aria-label={`${label} canvas card`}
            tabIndex={0}
            layout="vertical"
            gap="xs"
            padding="md"
            style={{
              position: 'absolute',
              left: `${pos.x}px`,
              top: `${pos.y}px`,
              width: '280px',
              backgroundColor: 'var(--surface-secondary)',
              border: '1px solid var(--border-primary)',
              borderRadius: 'var(--radius-control)',
              cursor: dragging === key ? 'grabbing' : 'grab',
              touchAction: 'none',
              userSelect: 'none',
            }}
            onPointerDown={(event) => handlePointerDown(event, key)}
            onKeyDown={(event) => handleCardKeyDown(event, key, label)}
          >
            <Text variant="body-sm" weight="medium" truncate>{label}</Text>
            <Text variant="caption" color="faint">{record.id}</Text>
            <Inline
              role="group"
              aria-label={`Move ${label}`}
              gap="xs"
              onPointerDown={(event) => event.stopPropagation()}
            >
              {([
                ['left', -16, 0, '←'],
                ['up', 0, -16, '↑'],
                ['down', 0, 16, '↓'],
                ['right', 16, 0, '→'],
              ] as const).map(([direction, x, y, glyph]) => (
                <Button
                  key={direction}
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className="[@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11"
                  aria-label={`Move ${label} ${direction}`}
                  onClick={() => placeBy(
                    key,
                    { x, y },
                    true,
                    `${label} moved ${direction} and saved`,
                  )}
                >
                  {glyph}
                </Button>
              ))}
            </Inline>
          </Container>
        );
      })}
      </div>
    </Container>
  );
}

// ---------------------------------------------------------------------------
// Gallery (poster-grid) view
//
// A GENERIC poster-grid renderer: it shows ANY records as scannable image
// tiles. It carries ZERO media vocabulary. WHICH field is the poster, the
// title, and the subtitle is resolved from FIELD DESCRIPTORS (role / shape),
// with sensible fallbacks. So the same view renders a photo library, a product
// catalog, a people directory, or a video-renders library with no code change
// (L069 / L131 / Physics-vs-Society). Poster values that resolve to a loadable
// URL render as a real lazy image (ImageBlock, the ui-layer img wrapper);
// records with no poster fall back to a monogram tile (never a broken image).
// ---------------------------------------------------------------------------

// Descriptor roles that explicitly declare a field as the tile poster/media.
const GALLERY_POSTER_ROLE_HINTS = [
  'poster', 'media', 'image', 'thumbnail', 'thumb', 'cover', 'photo', 'picture', 'avatar', 'artwork',
];
// Descriptor roles that explicitly declare a field as the tile subtitle.
const GALLERY_SUBTITLE_ROLE_HINTS = ['subtitle', 'caption', 'summary', 'description', 'body'];
// How many cards the grid renders per page. Growing on scroll keeps the DOM
// bounded so a feed of thousands of records never blocks the main thread on
// mount (Google-Photos-style windowing).
const GALLERY_PAGE_SIZE = 120;

function galleryDescriptorRole(descriptor: VisualDatabaseFieldDescriptor): string {
  return (descriptor.role ?? '').toLowerCase();
}

function galleryDescriptorShape(descriptor: VisualDatabaseFieldDescriptor): string {
  return (descriptor.shape ?? '').toLowerCase();
}

function galleryIsImageLikeString(value: string): boolean {
  const text = value.trim();
  if (!text) return false;
  if (/^data:image\//i.test(text)) return true;
  if (/^blob:/i.test(text)) return true;
  return /\.(png|jpe?g|gif|webp|avif|svg|bmp|ico)(\?|#|$)/i.test(text);
}

function galleryIsUrlLikeString(value: string): boolean {
  return /^(https?:\/\/|data:|blob:|\/)/i.test(value.trim());
}

// Turn one attachment ref into a loadable src. An explicit poster field honors
// the author's intent (any non-empty ref candidate); a discovered field is
// conservative (only image/url-like candidates).
function galleryAttachmentSrc(ref: VisualDatabaseAttachmentRef, explicit: boolean): string | null {
  const candidate = ref.url
    ?? ref.filePath
    ?? (explicit ? (ref.contentAddress ?? ref.address ?? ref.id) : null);
  if (!candidate) return null;
  const text = candidate.trim();
  if (!text) return null;
  if (explicit) return text;
  return galleryIsImageLikeString(text) || galleryIsUrlLikeString(text) ? text : null;
}

// Resolve a poster src from an arbitrary field value: a plain string, an array
// of strings/attachments, or an attachment object. When `explicit` is true the
// descriptor declared this the poster field, so its string value is honored as
// the src verbatim (the author is responsible for making it loadable); a
// discovered field only yields image/url-like strings.
function galleryPosterSrcFromValue(value: unknown, explicit: boolean): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return null;
    if (explicit) return text;
    return galleryIsImageLikeString(text) || galleryIsUrlLikeString(text) ? text : null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === 'string') {
        const src = galleryPosterSrcFromValue(item, explicit);
        if (src) return src;
      }
    }
    for (const ref of readAttachmentRefs(value)) {
      const src = galleryAttachmentSrc(ref, explicit);
      if (src) return src;
    }
    return null;
  }
  for (const ref of readAttachmentRefs(value)) {
    const src = galleryAttachmentSrc(ref, explicit);
    if (src) return src;
  }
  return null;
}

function galleryDescriptorIsExplicitPoster(descriptor: VisualDatabaseFieldDescriptor): boolean {
  return GALLERY_POSTER_ROLE_HINTS.includes(galleryDescriptorRole(descriptor))
    || galleryDescriptorShape(descriptor) === 'attachments'
    || galleryDescriptorRole(descriptor) === 'attachment';
}

// Pick the poster field for the whole model: role hint first, then an
// attachments-shaped field, then the first field whose value scans as an
// image/url for any sampled record. Null means no field carries a poster
// (every card falls back to a monogram tile).
function galleryPosterDescriptor(model: VisualDatabaseModel): VisualDatabaseFieldDescriptor | null {
  const byRole = model.fields.find((field) => GALLERY_POSTER_ROLE_HINTS.includes(galleryDescriptorRole(field)));
  if (byRole) return byRole;
  const byShape = model.fields.find((field) => (
    galleryDescriptorShape(field) === 'attachments' || galleryDescriptorRole(field) === 'attachment'
  ));
  if (byShape) return byShape;
  const sample = model.records.slice(0, 24);
  for (const field of model.fields) {
    if (galleryDescriptorRole(field) === 'title') continue;
    for (const record of sample) {
      if (galleryPosterSrcFromValue(extractFieldValue(record, field), false)) return field;
    }
  }
  return null;
}

function galleryTitleDescriptor(model: VisualDatabaseModel): VisualDatabaseFieldDescriptor | null {
  return model.fields.find((field) => galleryDescriptorRole(field) === 'title') ?? null;
}

function gallerySubtitleDescriptor(
  model: VisualDatabaseModel,
  posterId: string | null,
  titleId: string | null,
): VisualDatabaseFieldDescriptor | null {
  const byRole = model.fields.find((field) => GALLERY_SUBTITLE_ROLE_HINTS.includes(galleryDescriptorRole(field)));
  if (byRole) return byRole;
  return model.fields.find((field) => {
    if (field.id === posterId || field.id === titleId) return false;
    if (galleryDescriptorRole(field) === 'title') return false;
    const shape = galleryDescriptorShape(field);
    return shape === '' || shape === 'text' || shape === 'longtext';
  }) ?? null;
}

function galleryTitleText(record: VisualDatabaseRecord, descriptor: VisualDatabaseFieldDescriptor | null): string {
  if (descriptor) {
    const text = extractFieldText(record, descriptor)[0];
    if (text && text.trim()) return text.trim();
  }
  return displayTitle(record);
}

function gallerySubtitleText(record: VisualDatabaseRecord, descriptor: VisualDatabaseFieldDescriptor | null): string {
  if (descriptor) {
    const text = extractFieldText(record, descriptor)[0];
    if (text && text.trim()) return text.trim();
  }
  const body = displaySubtitle(record);
  if (body) return body;
  return shortDate(record.date) ?? '';
}

function galleryMonogram(title: string): string {
  const cleaned = title.trim();
  return (cleaned.charAt(0) || '?').toUpperCase();
}

function GalleryCard(props: {
  recordKey: string;
  title: string;
  subtitle: string;
  posterSrc: string | null;
  selected: boolean;
  onOpen: () => void;
}) {
  const [imageFailed, setImageFailed] = React.useState(false);
  const showImage = Boolean(props.posterSrc) && !imageFailed;
  return (
    <Card
      variant="nested"
      padding="none"
      layout="stack"
      interactive
      selected={props.selected}
      role="button"
      tabIndex={0}
      aria-label={props.title}
      data-reach-role="record-gallery-card"
      style={{ overflow: 'hidden' }}
      onClick={props.onOpen}
      onKeyDown={(event: React.KeyboardEvent) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          props.onOpen();
        }
      }}
    >
      <Container
        padding="none"
        alignItems="center"
        justifyContent="center"
        data-reach-role="record-gallery-poster"
        style={{ aspectRatio: '16 / 9', width: '100%', overflow: 'hidden', background: 'var(--glass-bg-subtle)' }}
      >
        {showImage ? (
          <ImageBlock
            src={props.posterSrc as string}
            alt={props.title}
            loading="lazy"
            objectFit="cover"
            width="full"
            rounded="none"
            style={{ height: '100%', width: '100%' }}
            onError={() => setImageFailed(true)}
            data-reach-role="record-gallery-poster-image"
          />
        ) : (
          <Container
            layout="vertical"
            gap="xs"
            padding="sm"
            alignItems="center"
            justifyContent="center"
            data-reach-role="record-gallery-poster-fallback"
          >
            <Icon icon={ImageOff} size="md" color="muted" />
            <Text variant="heading-md" color="muted" weight="semibold">{galleryMonogram(props.title)}</Text>
          </Container>
        )}
      </Container>
      <Container
        layout="vertical"
        gap="none"
        padding="sm"
        minWidth="0"
        data-reach-role="record-gallery-caption"
      >
        <Text variant="body-xs" weight="medium" truncate>{props.title}</Text>
        {props.subtitle ? (
          <Text variant="caption" color="muted" truncate>{props.subtitle}</Text>
        ) : null}
      </Container>
    </Card>
  );
}

export function GalleryView(props: ViewProps) {
  const { model, records } = props;
  const posterDescriptor = React.useMemo(() => galleryPosterDescriptor(model), [model]);
  const posterExplicit = React.useMemo(
    () => (posterDescriptor ? galleryDescriptorIsExplicitPoster(posterDescriptor) : false),
    [posterDescriptor],
  );
  const titleDescriptor = React.useMemo(() => galleryTitleDescriptor(model), [model]);
  const subtitleDescriptor = React.useMemo(
    () => gallerySubtitleDescriptor(model, posterDescriptor?.id ?? null, titleDescriptor?.id ?? null),
    [model, posterDescriptor, titleDescriptor],
  );

  // Bounded DOM: render up to `visibleCount` cards and grow by a page when a
  // bottom sentinel scrolls into view. Never mount thousands of nodes at once.
  const [visibleCount, setVisibleCount] = React.useState(() => Math.min(records.length, GALLERY_PAGE_SIZE));
  React.useEffect(() => {
    setVisibleCount((current) => Math.min(records.length, Math.max(current, GALLERY_PAGE_SIZE)));
  }, [records.length]);
  const sentinelRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    const node = sentinelRef.current;
    if (!node) return;
    if (typeof IntersectionObserver === 'undefined') return;
    if (visibleCount >= records.length) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setVisibleCount((current) => Math.min(records.length, current + GALLERY_PAGE_SIZE));
      }
    }, { rootMargin: '600px' });
    observer.observe(node);
    return () => observer.disconnect();
  }, [visibleCount, records.length]);

  if (records.length === 0) {
    return (
      <Container padding="none" data-reach-role="empty-state">
        <EmptyPlaceholder
          icon={LayoutGrid}
          message="No records to show in the gallery yet."
        />
      </Container>
    );
  }

  const shown = records.slice(0, visibleCount);
  return (
    <Container layout="vertical" gap="sm" padding="none" data-reach-role="record-gallery">
      <Container
        padding="none"
        data-reach-role="record-gallery-grid"
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))',
          gap: 12,
          alignItems: 'stretch',
        }}
      >
        {shown.map((record) => {
          const key = recordViewKey(record);
          const posterSrc = posterDescriptor
            ? galleryPosterSrcFromValue(extractFieldValue(record, posterDescriptor), posterExplicit)
            : null;
          return (
            <GalleryCard
              key={key}
              recordKey={key}
              title={galleryTitleText(record, titleDescriptor)}
              subtitle={gallerySubtitleText(record, subtitleDescriptor)}
              posterSrc={posterSrc}
              selected={props.expandedId === key}
              onOpen={() => props.onToggle(key)}
            />
          );
        })}
      </Container>
      {visibleCount < records.length ? (
        <Container
          ref={sentinelRef}
          padding="sm"
          alignItems="center"
          justifyContent="center"
          data-reach-role="record-gallery-more"
        >
          <Text variant="caption" color="muted">{`Showing ${visibleCount} of ${records.length}`}</Text>
        </Container>
      ) : null}
    </Container>
  );
}

/** Table and gallery keep one shared `view-group` axis. Board already presents
 * that same axis as lanes; these views present it as labeled sections. */
export function GroupedCollectionView({
  renderer: Renderer,
  ...props
}: ViewProps & { renderer: (props: ViewProps) => React.ReactElement }) {
  const grouping = groupingRuleForView(props.view)
    ? groupingDescriptorForView(props.view, props.model.fields)
    : null;
  if (!grouping) return <Renderer {...props} />;

  const groups = props.lanes.flatMap((lane) => {
    const grouped = props.records.filter((record) => recordGroupValues(record, grouping).includes(lane.id));
    return grouped.length > 0 ? [{ lane, records: grouped }] : [];
  });
  if (groups.length === 0) return <Renderer {...props} records={[]} />;

  return (
    <Container layout="vertical" gap="lg" padding="none" data-reach-role="grouped-record-view">
      {groups.map(({ lane, records }) => (
        <Container
          key={lane.id}
          layout="vertical"
          gap="sm"
          padding="none"
          role="group"
          aria-label={`${lane.label}, ${records.length} ${records.length === 1 ? 'record' : 'records'}`}
          data-reach-role="record-view-group"
          data-group-id={lane.id}
        >
          <Container layout="horizontal" alignItems="center" gap="sm" padding="none">
            <Text variant="heading-xs" color="strong">{lane.label}</Text>
            <Text variant="caption" color="faint">{String(records.length)}</Text>
          </Container>
          <Renderer {...props} records={records} />
        </Container>
      ))}
    </Container>
  );
}

const viewIcons: Record<string, React.ElementType> = {
  list: ListChecks,
  board: Boxes,
  timeline: CalendarDays,
  swimlane: Layers3,
  table: Grid2x2,
  graph: GitBranch,
  canvas: LayoutPanelLeft,
  gallery: LayoutGrid,
  metric: Gauge,
  nodegraph: GitBranch,
};

// The `metric` view_kind: adapt the shared ViewProps to the pure MetricView
// renderer, which reads the view's metric-card DATA and composes the ui/show
// atoms through the read-data/metric-aggregation math owner. One map entry, no
// aggregation here (see MetricView.tsx). This is the projection-retirement path
// (#175): the retired projection surface only composed the same atoms.
function MetricViewAdapter(props: ViewProps): React.ReactElement {
  return (
    <MetricView
      metrics={props.view.metrics ?? []}
      records={props.records}
      model={props.model}
    />
  );
}

const viewRenderers: Record<string, typeof ListView> = {
  list: ListView,
  board: BoardView,
  timeline: TimelineView,
  swimlane: SwimlaneView,
  table: TableView,
  graph: RelationshipView,
  canvas: CanvasView,
  gallery: GalleryView,
  metric: MetricViewAdapter,
  nodegraph: NodeGraphView,
};

// ---------------------------------------------------------------------------
// Surface
// ---------------------------------------------------------------------------

const SURFACE_STATE_COPY: Record<VisualDatabaseSurfaceState['kind'], { message: string; action?: string }> = {
  ready: { message: '' },
  loading: { message: 'Getting your work…', action: 'Return home' },
  offline: { message: 'The live connection is unavailable.', action: 'Retry' },
  error: { message: "This part didn't load.", action: 'Retry' },
  missing: { message: "This item isn't available in this app yet.", action: 'Return home' },
  permission: { message: 'This needs your permission.', action: 'Review permission' },
  concurrent: { message: 'Updated with newer work.', action: 'Review change' },
  deleted: { message: 'This item was replaced.', action: 'Open replacement' },
};

function SurfaceStateNotice({ state, onAction }: {
  state: VisualDatabaseSurfaceState;
  onAction?: (state: VisualDatabaseSurfaceState) => void;
}) {
  if (state.kind === 'ready') return null;
  const defaults = SURFACE_STATE_COPY[state.kind];
  const message = state.kind === 'offline' && state.updatedAt
    ? `This was updated at ${state.updatedAt}; the live connection is unavailable.`
    : state.message ?? defaults.message;
  return (
    <Card
      variant={state.kind === 'error' || state.kind === 'permission' ? 'error' : 'surface'}
      padding="sm"
      role={state.kind === 'error' || state.kind === 'missing' || state.kind === 'permission' ? 'alert' : 'status'}
      aria-live={state.kind === 'error' ? 'assertive' : 'polite'}
      data-surface-state={state.kind}
    >
      <Container layout="horizontal" alignItems="center" justifyContent="between" gap="sm" padding="none">
        <Text variant="body" color={state.kind === 'error' || state.kind === 'permission' ? 'error' : 'muted'}>
          {message}
        </Text>
        {onAction && (state.actionLabel ?? defaults.action) ? (
          <Button variant="outline" size="sm" onClick={() => onAction(state)}>
            {state.actionLabel ?? defaults.action}
          </Button>
        ) : null}
      </Container>
    </Card>
  );
}

export function VisualDatabaseSurface({
  model: feedModel,
  presentation = 'surface',
  surfaceState = { kind: 'ready' },
  onSurfaceStateAction,
  initialViewId,
  latestRecordRefs,
  viewIdentity,
  writeRecord,
  mutationSettlementPolicy: mutationSettlementPolicyInput,
  recordTarget,
  descriptorOwner,
  descriptorSnapshots = [],
  descriptorAuthorityError,
  cellExpressionInputs,
  evaluatorDescriptors = EMPTY_EVALUATOR_DESCRIPTORS,
  onInvokeAction,
  selectionActions,
  onInvokeSelectionAction,
  onSelectNode,
}: VisualDatabaseSurfaceProps) {
  // Optimistic views overlay: a rename/recolor/delete shows INSTANTLY while
  // the engine write round-trips; the next feed delivery (new views array
  // identity) clears the overlay so the log stays the only durable truth.
  const [optimisticViews, setOptimisticViews] = React.useState<readonly VisualDatabaseViewDescriptor[] | null>(null);
  const [optimisticPalette, setOptimisticPalette] = React.useState<readonly VisualDatabasePaletteColor[] | null>(null);
  const [optimisticFields, setOptimisticFields] = React.useState<readonly VisualDatabaseFieldDescriptor[] | null>(null);
  const [acceptedDescriptorProjections, setAcceptedDescriptorProjections] = React.useState<{
    fields?: readonly DescriptorExpectedProjection[];
    views?: readonly DescriptorExpectedProjection[];
  }>({});
  const [optimisticDeletedKeys, setOptimisticDeletedKeys] = React.useState<readonly string[]>([]);
  const [optimisticRecordPayloads, setOptimisticRecordPayloads] = React.useState<Readonly<Record<string, OptimisticRecordPayload>>>({});
  const confirmedRecordPayloadsRef = React.useRef(new Map<string, OptimisticRecordPayload>());
  const [descriptorConflict, setDescriptorConflict] = React.useState<{
    kind: 'fields' | 'views';
    scope: string;
    draft: DescriptorMutationDraft;
    conflicts: readonly DescriptorMutationConflict[];
    current: readonly AddressedDescriptorSnapshot[];
    choices: ReadonlyMap<number, DescriptorConflictChoice>;
    busyConflictIndex: number | null;
    announcement?: string;
  } | null>(null);
  const [descriptorUncertain, setDescriptorUncertain] = React.useState<{
    kind: 'fields' | 'views';
    scope: string;
    draft: DescriptorMutationDraft;
    busy: boolean;
    message: string;
  } | null>(null);
  const descriptorSaveTokens = React.useRef({ fields: 0, views: 0 });
  const optimisticRecordToken = React.useRef(0);
  const mutationAttemptCounter = React.useRef(0);
  const mutationSettlement = React.useRef(new MutationSettlementCoordinator()).current;
  const mutationSettlementPolicy = React.useMemo<MutationSettlementPolicy | null>(() => (
    writeRecord ? decodeMutationSettlementPolicy(mutationSettlementPolicyInput) : null
  ), [mutationSettlementPolicyInput, writeRecord]);
  const feedModelRef = React.useRef(feedModel);
  feedModelRef.current = feedModel;
  const descriptorSnapshotsRef = React.useRef(descriptorSnapshots);
  descriptorSnapshotsRef.current = descriptorSnapshots;
  React.useEffect(() => {
    setOptimisticDeletedKeys((current) => current.filter((key) => (
      feedModel.records.some((record) => recordViewKey(record) === key)
    )));
  }, [feedModel.records]);
  const modelWithViews = optimisticViews || optimisticPalette || optimisticFields
    ? {
      ...feedModel,
      views: optimisticViews ?? feedModel.views,
      palette: optimisticPalette ?? feedModel.palette,
      fields: optimisticFields ?? feedModel.fields,
    }
    : feedModel;
  const modelWithRecordPayloads = React.useMemo(() => {
    if (Object.keys(optimisticRecordPayloads).length === 0) return modelWithViews;
    const feedIdentities = new Set(
      modelWithViews.records
        .map((record) => recordAddress(record))
        .filter((address): address is string => address !== null)
        .map(canonicalRecordIdentity),
    );
    const projectedRecords = modelWithViews.records.map((record) => {
      const address = recordAddress(record);
      const optimistic = address ? optimisticRecordPayloads[canonicalRecordIdentity(address)] : undefined;
      return optimistic ? applyOptimisticRecordPayload(record, modelWithViews.fields, optimistic.payload) : record;
    });
    const pendingCreates = Object.entries(optimisticRecordPayloads)
      .filter(([identity, optimistic]) => optimistic.createdRecord && !feedIdentities.has(identity))
      .map(([, optimistic]) => applyOptimisticRecordPayload(
        optimistic.createdRecord!,
        modelWithViews.fields,
        optimistic.payload,
      ));
    return {
      ...modelWithViews,
      records: [...projectedRecords, ...pendingCreates],
    };
  }, [modelWithViews, optimisticRecordPayloads]);
  const deletedKeys = React.useMemo(() => new Set(optimisticDeletedKeys), [optimisticDeletedKeys]);
  const model = deletedKeys.size > 0
    ? { ...modelWithRecordPayloads, records: modelWithRecordPayloads.records.filter((record) => !deletedKeys.has(recordViewKey(record))) }
    : modelWithRecordPayloads;
  const foldedCells = React.useMemo(() => foldAddressedCellExpressions(model.fields, cellExpressionInputs ?? { sources: [], caches: [], provenances: [] }), [model.fields, cellExpressionInputs]);
  const foldedByKey = React.useMemo(() => new Map(foldedCells.map((cell) => [JSON.stringify([cell.cellRef.recordRef, cell.cellRef.fieldRef]), cell])), [foldedCells]);
  const cellExpressionInputsRef = React.useRef(cellExpressionInputs);
  cellExpressionInputsRef.current = cellExpressionInputs;
  const cellSourceRevisionCounter = React.useRef(0);
  const foregroundProjectionRevisions = React.useRef(new Map<string, string>());
  const [editingCell, setEditingCell] = React.useState<{
    record: VisualDatabaseRecord;
    field: VisualDatabaseFieldDescriptor;
    cell?: FoldedCellExpression;
    entryTrigger?: string;
  } | null>(null);
  const [editingExpressionDraft, setEditingExpressionDraft] = React.useState<{
    recordRef: string;
    fieldRef: string;
    source: string;
    selection: readonly [number, number];
    humanLabel: string;
  } | null>(null);
  const [formulaSavedStatus, setFormulaSavedStatus] = React.useState<{
    cellKey: string;
    humanLabel: string;
    sourceRevision: string;
    source: string;
    observedAt: string;
  } | null>(null);
  const [expressionReferencePicking, setExpressionReferencePicking] = React.useState(false);
  const [externalReferenceSelection, setExternalReferenceSelection] = React.useState<ExpressionReferenceSelection | null>(null);
  const [revealExpressionCell, setRevealExpressionCell] = React.useState<{
    recordRef: string;
    fieldRef: string;
  } | null>(null);
  const [recalculationRevision, setRecalculationRevision] = React.useState(0);
  const [derivedResolution, setDerivedResolution] = React.useState<{
    generation: object;
    cells: ReadonlyMap<string, ReadonlyMap<string, DerivedCell>>;
  } | undefined>(undefined);
  const selectedInitialViewId = model.views.some((candidate) => candidate.id === initialViewId)
    ? initialViewId!
    : model.views[0]?.id ?? 'list';
  const [activeViewId, setActiveViewId] = React.useState(selectedInitialViewId);
  React.useEffect(() => {
    setActiveViewId((current) => (
      model.views.some((candidate) => candidate.id === current)
        ? current
        : model.views.some((candidate) => candidate.id === initialViewId)
          ? initialViewId!
          : model.views[0]?.id ?? 'list'
    ));
  }, [initialViewId, model.views]);
  const [query, setQuery] = React.useState('');
  const [expandedId, setExpandedId] = React.useState<string | null>(null);
  const [creatingList, setCreatingList] = React.useState(false);
  const view = model.views.find((candidate) => candidate.id === activeViewId) ?? model.views[0];
  const navigationViews = model.views.filter((candidate) => candidate.visibility !== 'direct');
  const activeViewIdentity = viewIdentity?.viewId === view?.id ? viewIdentity : undefined;
  // Human gating happens once at the decode boundary (decodeVisualDatabaseModel)
  // — model.records is already human-only.
  const derivationGeneration = React.useMemo(() => ({}), [
    model.records, model.fields, foldedCells, evaluatorDescriptors, recalculationRevision, view,
  ]);
  const pendingDerivedCells = React.useMemo(() => {
    const pending = new Map<string, Map<string, DerivedCell>>();
    for (const record of model.records) {
      const byField = new Map<string, DerivedCell>();
      for (const field of model.fields) {
        const folded = foldedByKey.get(JSON.stringify([recordViewKey(record), field.id]));
        const expression = folded ? folded.expression : field.defaultExpression;
        if (expression?.derive || (folded && !folded.expression)) {
          byField.set(field.id, { fieldId: field.id, derived: true, persist: false });
        }
      }
      if (byField.size) pending.set(recordViewKey(record), byField);
    }
    return pending;
  }, [model.records, model.fields, foldedByKey]);
  const derivedCells = derivedResolution?.generation === derivationGeneration
    ? derivedResolution.cells : pendingDerivedCells;
  const projectionRecords = React.useMemo(
    () => projectResolvedFieldValues(model.records, derivedCells),
    [model.records, derivedCells],
  );
  const scoped = view ? recordsForView(view, projectionRecords, model.fields) : projectionRecords;
  const records = searchRecords(scoped, query, model.fields);
  const rootRecordCount = hierarchyRootRecords(records, model.fields).length;
  const lanes = view ? lanesForView(view, records, model.fields, model.domains) : [];
  const expressionReferenceColumnsForView = React.useMemo(
    () => (view?.kind === 'table'
      ? applyColumnState(displayColumnDescriptors(model), view.columns)
      : undefined),
    [model, view],
  );
  const expressionReferenceCatalogFor = React.useCallback((
    currentRecordRef?: string,
  ): ExpressionReferenceCatalog => buildExpressionReferenceCatalog(
    { ...model, records: model.records },
    {
      ...(currentRecordRef ? { currentRecordRef } : {}),
      ...(expressionReferenceColumnsForView ? { columns: expressionReferenceColumnsForView } : {}),
    },
  ), [expressionReferenceColumnsForView, model]);
  const expressionReferenceCatalog = React.useMemo<ExpressionReferenceCatalog>(() => (
    expressionReferenceCatalogFor(editingCell ? recordViewKey(editingCell.record) : undefined)
  ), [editingCell, expressionReferenceCatalogFor]);
  const openExpressionEditor = React.useCallback((
    record: VisualDatabaseRecord,
    field: VisualDatabaseFieldDescriptor,
    entryTrigger?: string,
  ) => {
    setFormulaSavedStatus(null);
    const recordRef = recordViewKey(record);
    const cell = foldedByKey.get(cellRefKey({ recordRef, fieldRef: field.id }));
    const expression = cell?.expression ?? field.defaultExpression ?? { literal: extractFieldValue(record, field) };
    const admitted = evaluatorDescriptors.filter((descriptor) => (
      !field.evaluatorDescriptorRefs
      || field.evaluatorDescriptorRefs.some((entry) => entry.ref === descriptor.ref)
    ));
    const current = expression.derive
      ? admitted.find((descriptor) => descriptor.ref === expression.derive?.evaluatorRef)
      : undefined;
    const selected = current?.authoring
      ? current
      : admitted.find((descriptor) => (
          !!descriptor.authoring
          && (!entryTrigger || descriptor.authoring.entryActions.some((action) => (
            action.id === entryTrigger || action.trigger === entryTrigger
          )))
        ));
    const source = selected?.authoring
      ? readDurableExpressionSource(selected.authoring, expression.derive?.request)
        ?? selected.authoring.sourcePrefix
      : '';
    const humanLabel = `${displayTitle(record)} · ${field.label}`;
    setEditingCell({
      record,
      field,
      cell,
      ...(entryTrigger ? { entryTrigger } : {}),
    });
    setEditingExpressionDraft({
      recordRef,
      fieldRef: field.id,
      source,
      selection: [source.length, source.length],
      humanLabel,
    });
  }, [evaluatorDescriptors, foldedByKey]);
  const expressionSelectionCounter = React.useRef(0);
  const selectExpressionReferences = React.useCallback((
    refs: readonly { recordRef: string; fieldRef: string }[],
    gesture: ExpressionReferenceSelection['gesture'],
  ) => {
    const candidates = refs.flatMap((ref) => {
      const candidate = expressionReferenceCatalog.candidates.find((entry) => (
        entry.recordRef === ref.recordRef && entry.fieldRef === ref.fieldRef
      ));
      return candidate ? [candidate] : [];
    });
    if (candidates.length !== refs.length || candidates.length === 0) {
      reportFailure('pick values')(new Error('One or more selected values are not in the current expression catalog.'));
      return;
    }
    expressionSelectionCounter.current += 1;
    setExternalReferenceSelection({
      id: `selection-${expressionSelectionCounter.current}`,
      candidates,
      gesture,
    });
  }, [expressionReferenceCatalog]);
  const Renderer = view ? (viewRenderers[view.kind] ?? ListView) : ListView;
  const onToggle = React.useCallback((id: string) => {
    setExpandedId((current) => (current === id ? null : id));
  }, []);
  const hideRecord = React.useCallback((record: VisualDatabaseRecord) => {
    const key = recordViewKey(record);
    setOptimisticDeletedKeys((current) => (current.includes(key) ? current : [...current, key]));
    setExpandedId((current) => (current === key ? null : current));
  }, []);
  const restoreRecord = React.useCallback((record: VisualDatabaseRecord) => {
    const key = recordViewKey(record);
    setOptimisticDeletedKeys((current) => current.filter((candidate) => candidate !== key));
  }, []);
  const knownRecordIdentities = React.useMemo(() => new Set(
    feedModel.records
      .map((record) => recordAddress(record))
      .filter((address): address is string => address !== null)
      .map(canonicalRecordIdentity),
  ), [feedModel.records]);
  const stageOptimisticRecordPayload = React.useCallback((
    addressLabel: string,
    key: string,
    payload: unknown,
    createdRecord?: VisualDatabaseRecord,
  ): StagedOptimisticRecord => {
    const token = optimisticRecordToken.current + 1;
    optimisticRecordToken.current = token;
    setOptimisticRecordPayloads((current) => ({
      ...current,
      [key]: {
        addressLabel,
        payload,
        token,
        confirmed: false,
        createdRecord: createdRecord ?? current[key]?.createdRecord,
        previous: current[key] ?? confirmedRecordPayloadsRef.current.get(key),
      },
    }));
    return { key, token, addressLabel, payload, ...(createdRecord ? { createdRecord } : {}) };
  }, []);
  const confirmOptimisticRecordPayloads = React.useCallback((staged: readonly StagedOptimisticRecord[]) => {
    if (staged.length === 0) return;
    for (const entry of staged) {
      confirmedRecordPayloadsRef.current.set(entry.key, {
        addressLabel: entry.addressLabel,
        payload: entry.payload,
        token: entry.token,
        confirmed: true,
        ...(entry.createdRecord ? { createdRecord: entry.createdRecord } : {}),
      });
    }
    setOptimisticRecordPayloads((current) => {
      let changed = false;
      const next = { ...current };
      for (const entry of staged) {
        const optimistic = next[entry.key];
        if (!optimistic) continue;
        const confirmed = confirmOptimisticRevision(optimistic, entry.token);
        if (confirmed === optimistic) continue;
        next[entry.key] = confirmed;
        changed = true;
      }
      return changed ? next : current;
    });
  }, []);
  const rollbackOptimisticRecordPayloads = React.useCallback((staged: readonly StagedOptimisticRecord[]) => {
    if (staged.length === 0) return;
    setOptimisticRecordPayloads((current) => {
      let changed = false;
      const next = { ...current };
      for (const entry of staged) {
        const optimistic = next[entry.key];
        if (!optimistic) continue;
        const remaining = removeOptimisticRevision(optimistic, entry.token);
        if (remaining === optimistic) continue;
        if (remaining) next[entry.key] = remaining;
        else delete next[entry.key];
        changed = true;
      }
      return changed ? next : current;
    });
  }, []);
  const observeSettlementTransition = React.useCallback((
    transition: MutationSettlementTransition,
    identity: {
      attemptHash: string;
      addressedIdentityHash: string;
      expectedRevisionHash: string;
      currentRevisionHash: string;
    },
  ) => {
    dispatchVisualDatabaseObservation('visual-database:mutation-settlement', {
      attempt_hash: identity.attemptHash,
      owner_family: 'visual-database',
      addressed_identity_hash: identity.addressedIdentityHash,
      expected_revision_hash: identity.expectedRevisionHash,
      current_revision_hash: identity.currentRevisionHash,
      stage: transition.phase,
      elapsed_ms: transition.elapsedMs,
      observed_at: new Date().toISOString(),
    });
  }, []);
  const settleAddressedMutation = React.useCallback(async (
    entries: readonly AddressedWrite[],
    scope: string,
    observeFeed: (
      expected: readonly MutationExpectedEntry[],
    ) => readonly unknown[] | null | Promise<readonly unknown[] | null>,
    forceBatch = false,
    throwOnFailure = true,
  ): Promise<MutationSettlementResult> => {
    if (!writeRecord) throw new Error('No owner write path was supplied.');
    if (!mutationSettlementPolicy) {
      throw new Error('Mutation settlement policy DATA is required.');
    }
    if (!writeRecord.readCurrent) {
      throw new Error('The owner writer did not expose independent current-value readback.');
    }
    mutationAttemptCounter.current += 1;
    const expected = mutationExpectedEntries(entries);
    const attemptId = `mutation-${Date.now().toString(36)}-${mutationAttemptCounter.current.toString(36)}`;
    const observationIdentity = {
      attemptHash: opaqueVisualDatabaseObservationHash('attempt', attemptId),
      addressedIdentityHash: opaqueVisualDatabaseObservationHash(
        'addressed-identities',
        expected.map((entry) => entry.identity).sort().join('\0'),
      ),
      expectedRevisionHash: opaqueVisualDatabaseObservationHash(
        'expected-revision',
        JSON.stringify(expected.map((entry) => entry.payload)),
      ),
    };
    let currentRevisionHash = opaqueVisualDatabaseObservationHash('current-revision', 'unobserved');
    const result = await mutationSettlement.settle({
      attemptId,
      scope,
      authorityKeys: expected.map((entry) => entry.identity),
      policy: mutationSettlementPolicy,
      expected,
      write: () => (
        !forceBatch && entries.length === 1 ? writeRecord(entries[0]) : writeRecord.batch(entries)
      ),
      observeFeed: () => observeFeed(expected),
      readCurrent: async () => {
        const current = await Promise.all(entries.map(async (entry) => (
          (await writeRecord.readCurrent!(entry.addressLabel))?.payload ?? null
        )));
        currentRevisionHash = opaqueVisualDatabaseObservationHash(
          'current-revision',
          JSON.stringify(current),
        );
        return current;
      },
      matches: mutationValuesMatch,
      onTransition: (transition) => observeSettlementTransition(transition, {
        ...observationIdentity,
        currentRevisionHash,
      }),
    });
    if (throwOnFailure && result.state !== 'saved') throw settlementFailure(result);
    return result;
  }, [mutationSettlement, mutationSettlementPolicy, observeSettlementTransition, writeRecord]);
  const observeAddressedFeed = React.useCallback((
    expected: readonly MutationExpectedEntry[],
  ): readonly unknown[] | null => {
    const currentRecords = feedModelRef.current.records;
    const cellInputs = cellExpressionInputsRef.current;
    const values: unknown[] = [];
    for (const row of expected) {
      const cellRef = addressedInputCellRef({ payload: row.payload });
      if (cellRef) {
        const payload = row.payload as Record<string, unknown>;
        const family = Object.prototype.hasOwnProperty.call(payload, 'expression')
          ? cellInputs?.sources
          : Object.prototype.hasOwnProperty.call(payload, 'cached_value')
            ? cellInputs?.caches
            : cellInputs?.provenances;
        const match = family?.find((candidate) => {
          const candidateRef = addressedInputCellRef(candidate);
          return candidateRef !== null
            && cellRefKey(candidateRef) === cellRefKey(cellRef)
            && carriesExpectedValue(candidate.payload, row.payload);
        });
        if (row.payload === null) {
          if (match) return null;
          values.push(null);
          continue;
        }
        if (!match) return null;
        values.push(match.payload);
        continue;
      }
      const record = currentRecords.find((candidate) => {
        const address = recordAddress(candidate);
        return address !== null && canonicalRecordIdentity(address) === row.identity;
      });
      if (row.payload === null) {
        if (record) return null;
        values.push(null);
        continue;
      }
      if (!record || !feedRecordCarriesPayload(record, row.payload)) return null;
      values.push(feedRecordPayload(record));
    }
    return values;
  }, []);
  const commitCellExpression = React.useCallback(async (next: {
    cellRef: { recordRef: string; fieldRef: string };
    expression: VisualDatabaseFieldDescriptor['defaultExpression'];
    expectedRevision?: string;
    evaluationProjection?: CellEvaluationProjection;
  }): Promise<CellSourceMutationResult> => {
    const current = foldedByKey.get(cellRefKey(next.cellRef));
    if (!writeRecord || !next.expression) throw new Error('No owner write path was supplied for this cell.');
    if (!writeRecord.readCurrent) throw new Error('The record owner did not expose independent readback.');
    if (!mutationSettlementPolicy) throw new Error('Mutation settlement policy DATA is required.');
    const draft = createCellSourceMutationDraft({
      cellRef: next.cellRef,
      expression: next.expression,
      sourceExpectedCurrent: current?.sourceExpectedCurrent ?? null,
      allocateRevision: () => {
        cellSourceRevisionCounter.current += 1;
        return `source-${Date.now().toString(36)}-${cellSourceRevisionCounter.current.toString(36)}`;
      },
    });
    const key = cellRefKey(next.cellRef);
    const sourceAddress = addressedCellValueLabels(draft.cellRef).expression;
    if (next.evaluationProjection) foregroundProjectionRevisions.current.set(key, draft.sourceRevision);
    mutationAttemptCounter.current += 1;
    const attemptId = `cell-source-${Date.now().toString(36)}-${mutationAttemptCounter.current.toString(36)}`;
    const observationIdentity = {
      attemptHash: opaqueVisualDatabaseObservationHash('attempt', attemptId),
      addressedIdentityHash: opaqueVisualDatabaseObservationHash('addressed-identity', sourceAddress),
      expectedRevisionHash: opaqueVisualDatabaseObservationHash(
        'expected-revision',
        draft.sourceRevision,
      ),
    };
    let currentRevisionHash = opaqueVisualDatabaseObservationHash('current-revision', 'unobserved');
    const settlement = await mutationSettlement.settle(buildCellSourceSettlementAttempt(draft, {
      write: (entries) => writeRecord.batch(entries),
      read: async () => {
        const readback = await writeRecord.readCurrent!(sourceAddress);
        const observed = readback
          ? {
              payload: readback.payload,
              expectedCurrent: { payloadHash: readback.payloadHash },
            }
          : null;
        currentRevisionHash = opaqueVisualDatabaseObservationHash(
          'current-revision',
          JSON.stringify(observed?.payload ?? null),
        );
        return observed;
      },
      waitForFeed: async (cellRef) => (
        addressedSourceForCell(cellExpressionInputsRef.current, cellRef)
      ),
    }, {
      attemptId,
      scope: `cell-source:${key}`,
      policy: mutationSettlementPolicy,
      onTransition: (transition) => observeSettlementTransition(transition, {
        ...observationIdentity,
        currentRevisionHash,
      }),
    }));
    const result = cellSourceMutationResultFromSettlement(draft, settlement);
    const sourceSaved = result.state === 'saved';
    if (!sourceSaved) {
      if (foregroundProjectionRevisions.current.get(key) === draft.sourceRevision) {
        foregroundProjectionRevisions.current.delete(key);
      }
      return result;
    }

    const settledExpression = result.draft.expression;
    const authoredEvaluator = settledExpression.derive
      ? evaluatorDescriptors.find((descriptor) => (
          descriptor.ref === settledExpression.derive?.evaluatorRef && descriptor.authoring
        ))
      : undefined;
    const savedSource = authoredEvaluator?.authoring && settledExpression.derive
      ? readDurableExpressionSource(authoredEvaluator.authoring, settledExpression.derive.request) ?? ''
      : '';
    const observedAt = new Date().toISOString();
    setFormulaSavedStatus({
      cellKey: key,
      humanLabel: editingExpressionDraft?.humanLabel ?? next.cellRef.fieldRef,
      sourceRevision: draft.sourceRevision,
      source: savedSource,
      observedAt,
    });
    reportSuccess('Saved cell');

    if (next.evaluationProjection) {
      const projectionRevision = `projection-${Date.now().toString(36)}-${cellSourceRevisionCounter.current.toString(36)}`;
      const projectionEntries = buildAddressedCellValueWrites({
        cellRef: next.cellRef,
        cachedValue: {
          value: next.evaluationProjection.value,
          revision: projectionRevision,
          sourceRevision: draft.sourceRevision,
          observedAt,
        },
        cacheExpectedCurrent: current?.cacheExpectedCurrent ?? null,
        provenance: {
          ref: expressionEvaluationProvenanceRef({
            family: next.evaluationProjection.provenanceRefFamily,
            sourceRevision: draft.sourceRevision,
            evaluatorRevision: next.evaluationProjection.evaluatorRevision,
          }),
          revision: projectionRevision,
          sourceRevision: draft.sourceRevision,
          evaluatorRef: next.evaluationProjection.evaluatorRef,
          evaluatorTarget: next.evaluationProjection.evaluatorTarget,
          evaluatorRevision: next.evaluationProjection.evaluatorRevision,
          policyRevision: next.evaluationProjection.policyRevision,
          displayLabel: next.evaluationProjection.provenanceDisplayLabel,
          reads: next.evaluationProjection.reads,
        },
        provenanceExpectedCurrent: current?.provenanceExpectedCurrent ?? null,
      });
      // Source acceptance is the user-visible commit boundary. Cache and
      // provenance are independent projections: settle them in the
      // background so delayed projection feeds cannot hold the accepted
      // source editor open.
      void settleAddressedMutation(
        projectionEntries,
        `cell-projection:${key}:${draft.sourceRevision}`,
        observeAddressedFeed,
        true,
        false,
      ).then((projectionSettlement) => {
        if (projectionSettlement.state !== 'saved') {
          reportFailure('computed cell projection')(settlementFailure(projectionSettlement));
        }
      }).catch(reportFailure('computed cell projection')).finally(() => {
        if (foregroundProjectionRevisions.current.get(key) === draft.sourceRevision) {
          foregroundProjectionRevisions.current.delete(key);
        }
      });
    }
    return result;
  }, [
    editingExpressionDraft,
    evaluatorDescriptors,
    foldedByKey,
    mutationSettlement,
    mutationSettlementPolicy,
    observeAddressedFeed,
    observeSettlementTransition,
    settleAddressedMutation,
    writeRecord,
  ]);
  const optimisticWriteRecord = React.useMemo<RecordWriter | undefined>(() => {
    if (!writeRecord) return undefined;
    const stageEntries = (entries: readonly AddressedWrite[]) => entries
      .filter((entry) => entry.payload !== null)
      .map((entry) => {
        const key = canonicalRecordIdentity(entry.addressLabel);
        const createdRecord = knownRecordIdentities.has(key)
          ? undefined
          : createOptimisticRecord(entry.addressLabel, entry.payload, modelWithViews.fields);
        return stageOptimisticRecordPayload(entry.addressLabel, key, entry.payload, createdRecord);
      });
    const writer = (async (entry: AddressedWrite) => {
      const staged = stageEntries([entry]);
      try {
        await settleAddressedMutation(
          [entry],
          `records:${canonicalRecordIdentity(entry.addressLabel)}`,
          observeAddressedFeed,
        );
        confirmOptimisticRecordPayloads(staged);
      } catch (error) {
        rollbackOptimisticRecordPayloads(staged);
        throw error;
      }
    }) as RecordWriter;
    writer.batch = async (entries: readonly AddressedWrite[]) => {
      const staged = stageEntries(entries);
      try {
        await settleAddressedMutation(
          entries,
          `records:${entries.map((entry) => canonicalRecordIdentity(entry.addressLabel)).sort().join('|')}`,
          observeAddressedFeed,
          true,
        );
        confirmOptimisticRecordPayloads(staged);
      } catch (error) {
        rollbackOptimisticRecordPayloads(staged);
        throw error;
      }
    };
    if (writeRecord.partitionLabel) {
      Object.defineProperty(writer, 'partitionLabel', {
        configurable: false,
        enumerable: true,
        value: writeRecord.partitionLabel,
        writable: false,
      });
    }
    if (writeRecord.readCurrent) {
      Object.defineProperty(writer, 'readCurrent', {
        configurable: false,
        enumerable: true,
        value: writeRecord.readCurrent,
        writable: false,
      });
    }
    return writer;
  }, [
    writeRecord,
    knownRecordIdentities,
    modelWithViews.fields,
    stageOptimisticRecordPayload,
    confirmOptimisticRecordPayloads,
    settleAddressedMutation,
    observeAddressedFeed,
    rollbackOptimisticRecordPayloads,
  ]);
  React.useEffect(() => {
    if (!writeRecord?.readCurrent) return undefined;
    let cancelled = false;
    const reconcile = async () => {
      for (const [identity, optimistic] of Object.entries(optimisticRecordPayloads)) {
        if (!optimistic.confirmed) continue;
        const feedRecord = feedModel.records.find((record) => {
          const address = recordAddress(record);
          return address !== null && canonicalRecordIdentity(address) === identity;
        });
        if (feedRecord && feedRecordCarriesPayload(feedRecord, optimistic.payload)) continue;
        const current = await writeRecord.readCurrent!(optimistic.addressLabel);
        if (cancelled) return;
        if (current && carriesExpectedValue(current.payload, optimistic.payload)) continue;
        const feedIsCurrent = current === null
          ? feedRecord === undefined
          : feedRecord !== undefined && carriesExpectedValue(feedRecordPayload(feedRecord), current.payload);
        if (!feedIsCurrent) continue;
        confirmedRecordPayloadsRef.current.delete(identity);
        setOptimisticRecordPayloads((entries) => {
          if (entries[identity]?.token !== optimistic.token) return entries;
          const next = { ...entries };
          delete next[identity];
          return next;
        });
      }
    };
    void reconcile().catch(reportFailure('record owner reconciliation'));
    return () => { cancelled = true; };
  }, [feedModel.records, optimisticRecordPayloads, writeRecord]);
  const recordWriter = optimisticWriteRecord ?? writeRecord;
  // ── Lane E — the visual-database inspector (alt-click any card → the shared ui
  // InspectorSidebar over that record's editable fields, edited live through
  // visual-database's OWN writer). One editor mechanism, a second gesture (L069);
  // no god package — the sidebar is blind, this mount only wires the bridge.
  const [inspectSources, setInspectSources] = React.useState<readonly InspectionSource[] | null>(null);
  const findRecordByAddress = React.useCallback(
    (address: string) => model.records.find((record) => recordAddress(record) === address) ?? null,
    [model.records],
  );
  const descriptorById = React.useCallback(
    (id: string) => model.fields.find((field) => field.id === id) ?? null,
    [model.fields],
  );
  const inspectionRegistry = React.useMemo(() => {
    const registry = createInspectionResolverRegistry();
    registry.register(RECORD_INSPECTION_FAMILY, (ref: InspectionRef) => {
      const address = ref.parts.address;
      const record = address ? findRecordByAddress(address) : null;
      return record ? buildRecordInspectionSources(record, model) : null;
    });
    return registry;
  }, [findRecordByAddress, model]);
  const loadInspectionRecord = React.useMemo(() => {
    const loader = makeRecordInspectionLoader(findRecordByAddress);
    return (address: string) =>
      loader(address).then((snapshot) => snapshot ?? { record: undefined, basis: undefined });
  }, [findRecordByAddress]);
  const dispatchInspectionWrite = React.useMemo(
    () =>
      makeRecordInspectionDispatch({
        findRecord: findRecordByAddress,
        descriptorById,
        // No writer on this surface → an edit fails honestly (the sidebar shows it),
        // never silently no-ops. Reads still work without a writer.
        writer:
          recordWriter ??
          (Object.assign(
            async () => {
              throw new Error('record inspector: this board has no record writer');
            },
            {
              batch: async () => {
                throw new Error('record inspector: this board has no record writer');
              },
            },
          ) as RecordWriter),
      }),
    [findRecordByAddress, descriptorById, recordWriter],
  );
  const inspectorRenderFieldEditor = React.useMemo(
    () => makeRecordInspectionEditor({ model, findRecord: findRecordByAddress }),
    [model, findRecordByAddress],
  );
  const handleInspectClick = React.useCallback(
    (event: React.MouseEvent) => {
      if (!event.altKey) return;
      const sources = resolveInspection(event.target as Element, inspectionRegistry);
      if (sources.length === 0) return;
      // Alt-click inspects instead of toggling the card open (capture phase).
      event.preventDefault();
      event.stopPropagation();
      setInspectSources(sources);
    },
    [inspectionRegistry],
  );
  // Cmd-Z: undo the last durable mutation (field edit, complete, move,
  // reorder, delete) by rewriting its captured pre-write payload. Skipped
  // while an editable element is focused — the browser owns text undo there.
  React.useEffect(() => {
    if (!recordWriter) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'z' && event.key !== 'Z') return;
      if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey) return;
      const active = document.activeElement;
      if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement
        || (active instanceof HTMLElement && active.isContentEditable)) return;
      event.preventDefault();
      undoLastWrite(recordWriter)
        .then((undone) => {
          if (undone) {
            setOptimisticDeletedKeys([]);
            reportSuccess('Undone');
          }
        })
        .catch(reportFailure('undo'));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [recordWriter]);
  // The overflow menu shows "Mark as done  D" — this listener makes that
  // hint honest: D completes the EXPANDED record (no field focused).
  React.useEffect(() => {
    if (!recordWriter) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'd' && event.key !== 'D') return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (!expandedId) return;
      const active = document.activeElement;
      if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement
        || (active instanceof HTMLElement && active.isContentEditable)) return;
      const record = records.find((candidate) => recordViewKey(candidate) === expandedId);
      const grouping = view ? groupingDescriptorForView(view, model.fields) : null;
      const done = completionLane(lanes);
      if (!record || !grouping || !done) return;
      event.preventDefault();
      submitWrites(recordWriter, [buildRecordWrite(record, [{ descriptor: grouping, value: done.id }])].filter(
        (entry): entry is AddressedWrite => entry !== null,
      ), 'complete');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [recordWriter, expandedId, records, view, model.fields, lanes]);
  // ── Derived values: addressed cell expressions enter one blind Envelope
  // resolver. Field defaults merely materialize cells; they are never a
  // field-wide evaluator path and explicit cell sources remain authoritative.
  const explicitRecalculationRequests = React.useRef(new Set<string>());
  const requestCellRecalculation = React.useCallback((cellRef: {
    recordRef: string;
    fieldRef: string;
  }) => {
    explicitRecalculationRequests.current.add(cellRefKey(cellRef));
    setRecalculationRevision((revision) => revision + 1);
  }, []);
  const latestSourceRevisions = React.useRef(new Map<string, string | undefined>());
  latestSourceRevisions.current = new Map((cellExpressionInputs?.sources ?? []).flatMap((source) => {
    const payload = source.payload as { cell_ref?: { record_ref?: unknown; field_ref?: unknown } };
    const ref = payload?.cell_ref;
    return typeof ref?.record_ref === 'string' && typeof ref?.field_ref === 'string'
      ? [[JSON.stringify([ref.record_ref, ref.field_ref]), source.revision] as const]
      : [];
  }));
  const hasDerivedFields = foldedCells.some((cell) => !!cell.expression?.derive)
    || model.fields.some((descriptor) => descriptor.defaultExpression?.derive);
  const deriveDispatch = React.useMemo<DeriveDispatch>(() => async (target, request) => {
    const reply = await sendRequestToBitfieldTarget({ target, payload: request });
    const bytes = (reply as { payload?: Uint8Array })?.payload;
    if (!bytes || bytes.length === 0) return null;
    try {
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      return null;
    }
  }, []);
  const expressionOwnerSessionFactory = React.useMemo(
    () => new ExpressionOwnerSessionFactory(deriveDispatch),
    [deriveDispatch],
  );
  const evaluateAuthoredExpression = React.useCallback<AuthoringEvaluationDispatch>(async ({
    cell,
    evaluator,
    context,
  }) => {
    const authoring = evaluator.authoring;
    if (!authoring || !cell.expression.derive) {
      throw new Error('The addressed expression has no authoring contract.');
    }
    const source = readDurableExpressionSource(authoring, cell.expression.derive.request);
    if (source === null) throw new Error('The addressed expression has no durable human source.');
    const sourceRevision = cell.revision ?? `default:${cellRefKey(cell.cellRef)}`;
    const catalog = expressionReferenceCatalogFor(cell.cellRef.recordRef);
    const ownerSession = expressionOwnerSessionFactory.create({
      target: evaluator.target,
      descriptor: authoring,
      sourceRevision,
      catalogRevision: catalog.revision,
    });
    try {
      const evaluationReply = await ownerSession.evaluate({
          source,
          cursor_offset_utf16: source.length,
          variables: context,
      });
      const diagnostics = evaluationReply.values.diagnostics;
      if (Array.isArray(diagnostics) && diagnostics.some((diagnostic) => (
        !!diagnostic
        && typeof diagnostic === 'object'
        && !Array.isArray(diagnostic)
        && (diagnostic as { severity?: unknown }).severity === 'error'
      ))) {
        throw new Error('The expression owner rejected the durable source during recomputation.');
      }
      const mapped = mapExpressionEvaluationReads(
        evaluationReply.values.evaluation_readset,
        catalog,
      );
      if (mapped.issues.length > 0) {
        throw new Error(`The expression owner returned ${mapped.issues.length} unresolved read reference${mapped.issues.length === 1 ? '' : 's'}.`);
      }
      const labels = expressionEvaluationProvenanceLabels(evaluator);
      return {
        value: evaluationReply.values.evaluation_result,
        projection: {
          evaluatorRef: evaluator.ref,
          evaluatorTarget: evaluator.target,
          evaluatorRevision: evaluator.revision ?? authoring.revision,
          policyRevision: evaluationReply.policyRevision,
          provenanceRefFamily: labels.family,
          provenanceDisplayLabel: labels.displayLabel,
          reads: mapped.reads,
        },
      };
    } finally {
      ownerSession.close();
    }
  }, [expressionOwnerSessionFactory, expressionReferenceCatalogFor]);
  React.useEffect(() => {
    if (!hasDerivedFields) {
      setDerivedResolution(undefined);
      return undefined;
    }
    let cancelled = false;
    const defaults = model.records.flatMap((record) => model.fields.flatMap((field) => {
      const cellRef = { recordRef: recordViewKey(record), fieldRef: field.id };
      return [{ cellRef, expression: field.defaultExpression
        ? field.defaultExpression
        : { literal: extractFieldValue(record, field) } }];
    }));
    // `resolutionInputsForFoldedCells` is the fail-closed admission boundary:
    // malformed/duplicate explicit sources occupy their cell and cannot be
    // replaced by the field default, evaluated, or projected back as cache.
    const inputs = resolutionInputsForFoldedCells(foldedCells, defaults).map((cell) => ({
      ...cell,
      revision: cellExpressionInputs?.sources.find((source) => JSON.stringify((source.payload as { cell_ref?: unknown })?.cell_ref) === JSON.stringify({ record_ref: cell.cellRef.recordRef, field_ref: cell.cellRef.fieldRef }))?.revision,
    }));
    resolveAddressedCells(
      inputs,
      deriveDispatch,
      undefined,
      evaluatorDescriptors,
      evaluateAuthoredExpression,
    )
      .then((resolution) => {
        if (cancelled) return;
        const next = new Map<string, ReadonlyMap<string, DerivedCell>>(
          [...pendingDerivedCells].map(([recordRef, fields]) => [recordRef, new Map(fields)]),
        );
        const projectionWrites: AddressedWrite[] = [];
        for (const resolved of resolution.cells.values()) {
          const byField = next.get(resolved.cellRef.recordRef) ?? new Map<string, DerivedCell>();
          const key = JSON.stringify([resolved.cellRef.recordRef, resolved.cellRef.fieldRef]);
          const evaluatedSource = inputs.find((input) => JSON.stringify([input.cellRef.recordRef, input.cellRef.fieldRef]) === key);
          const folded = foldedByKey.get(key);
          const freshness = dependencyFreshness(
            folded,
            expressionReferenceCatalogFor(resolved.cellRef.recordRef),
          );
          const acceptedSource = evaluatedSource
            ? durableHumanSource(evaluatedSource.expression, evaluatorDescriptors)
            : null;
          const dependencyStale = !!freshness?.stale
            && acceptedSource !== null
            && folded?.cachedValue !== undefined;
          const forceRecalculation = explicitRecalculationRequests.current.delete(key);
          byField.set(resolved.cellRef.fieldRef, {
            fieldId: resolved.cellRef.fieldRef,
            derived: !!evaluatedSource?.expression.derive,
            value: dependencyStale ? folded?.cachedValue?.value : resolved.value,
            errorCode: resolved.error?.code,
            dependencyPath: resolved.error?.dependencyPath,
            ...(dependencyStale && freshness && acceptedSource !== null ? {
              stale: {
                acceptedSource,
                priorResult: folded?.cachedValue?.value,
                evaluatedDependencyRevision: freshness.evaluatedRevision,
                currentDependencyRevision: freshness.currentRevision,
              },
            } : {}),
            persist: false,
          });
          next.set(resolved.cellRef.recordRef, byField);
          // Evaluation output is a projection. A source edit while an Envelope
          // reply is in flight invalidates that reply, so it cannot write a
          // cache/provenance record for a newer expression.
          if (!resolved.evaluated || resolved.error || !evaluatedSource || latestSourceRevisions.current.get(key) !== evaluatedSource.revision) continue;
          if (dependencyStale && !forceRecalculation) continue;
          // A field default is template policy, not cell source truth. Without
          // an explicit source there is no source CAS basis to guard a durable
          // projection, and the default must never be copied into a cell source.
          if (folded?.source !== 'cell') continue;
          // A foreground save already owns this source revision's first exact
          // projection. Background recomputation must not race its independent
          // cache/provenance CAS batch.
          if (foregroundProjectionRevisions.current.get(key) === evaluatedSource.revision) continue;
          if (folded.cachedValue?.sourceRevision === evaluatedSource.revision
            && JSON.stringify(folded.cachedValue.value) === JSON.stringify(resolved.value)
            && folded.provenance?.sourceRevision === evaluatedSource.revision) continue;
          // Durable projections require the evaluator owner's exact revision,
          // policy, and mapped read evidence. Legacy evaluator replies remain
          // display-only because they cannot satisfy that proof contract.
          if (!resolved.evaluationProjection) continue;
          cellSourceRevisionCounter.current += 1;
          const projectionRevision = `projection-${Date.now().toString(36)}-${cellSourceRevisionCounter.current.toString(36)}`;
          projectionWrites.push(...buildAddressedCellValueWrites({
            cellRef: resolved.cellRef,
            cachedValue: {
              value: resolved.value,
              revision: projectionRevision,
              sourceRevision: evaluatedSource.revision,
              observedAt: new Date().toISOString(),
            },
            cacheExpectedCurrent: folded?.cacheExpectedCurrent ?? null,
            provenance: {
              ref: expressionEvaluationProvenanceRef({
                family: resolved.evaluationProjection.provenanceRefFamily,
                sourceRevision: evaluatedSource.revision,
                evaluatorRevision: resolved.evaluationProjection.evaluatorRevision,
              }),
              revision: projectionRevision,
              sourceRevision: evaluatedSource.revision,
              evaluatorRef: resolved.evaluationProjection.evaluatorRef,
              evaluatorTarget: resolved.evaluationProjection.evaluatorTarget,
              evaluatorRevision: resolved.evaluationProjection.evaluatorRevision,
              policyRevision: resolved.evaluationProjection.policyRevision,
              displayLabel: resolved.evaluationProjection.provenanceDisplayLabel,
              reads: resolved.evaluationProjection.reads,
            },
            provenanceExpectedCurrent: folded?.provenanceExpectedCurrent ?? null,
          }));
        }
        setDerivedResolution({ generation: derivationGeneration, cells: next });
        if (projectionWrites.length > 0 && writeRecord) {
          void settleAddressedMutation(
            projectionWrites,
            `cell-projections:${projectionWrites.map((entry) => canonicalRecordIdentity(entry.addressLabel)).sort().join('|')}`,
            observeAddressedFeed,
            true,
          ).catch(reportFailure('computed cell projections'));
        }
      })
      .catch(() => { /* per-cell errors are already honest; a fold-level crash leaves cells pending */ });
    return () => { cancelled = true; };
  }, [
    hasDerivedFields,
    derivationGeneration,
    pendingDerivedCells,
    model.records,
    model.fields,
    foldedCells,
    foldedByKey,
    cellExpressionInputs?.sources,
    deriveDispatch,
    evaluateAuthoredExpression,
    evaluatorDescriptors,
    expressionReferenceCatalogFor,
    recalculationRevision,
    observeAddressedFeed,
    settleAddressedMutation,
    writeRecord,
  ]);
  const observeDescriptorProjection = React.useCallback((
    expected: readonly DescriptorExpectedProjection[],
  ): readonly DescriptorExpectedProjection[] | null => {
    const byAddress = new Map(
      descriptorSnapshotsRef.current.map((snapshot) => [
        snapshot.addressLabel,
        snapshot.payload,
      ]),
    );
    const observed: DescriptorExpectedProjection[] = [];
    for (const row of expected) {
      if (row.payload === null) {
        if (byAddress.has(row.addressLabel)) return null;
        observed.push(row);
        continue;
      }
      const payload = byAddress.get(row.addressLabel);
      if (!payload || !sameJsonValue(payload, row.payload)) return null;
      observed.push({ addressLabel: row.addressLabel, payload });
    }
    return observed;
  }, []);
  const readDescriptorProjection = React.useCallback(async (
    expected: readonly DescriptorExpectedProjection[],
  ): Promise<readonly DescriptorExpectedProjection[] | null> => {
    if (!writeRecord?.readCurrent) return null;
    const observed: DescriptorExpectedProjection[] = [];
    for (const row of expected) {
      const current = await writeRecord.readCurrent(row.addressLabel);
      if (!current) {
        observed.push({ addressLabel: row.addressLabel, payload: null });
        continue;
      }
      const payload = descriptorFactFromUnknown(current.payload);
      if (!payload) return null;
      observed.push({ addressLabel: row.addressLabel, payload });
    }
    return observed;
  }, [writeRecord]);
  React.useEffect(() => {
    let cancelled = false;
    const reconcile = async (
      kind: 'fields' | 'views',
      expected: readonly DescriptorExpectedProjection[] | undefined,
    ) => {
      if (!expected || observeDescriptorProjection(expected) !== null) return;
      const current = await readDescriptorProjection(expected);
      if (cancelled || current === null || sameJsonValue(current, expected)) return;
      if (observeDescriptorProjection(current) === null) return;
      setAcceptedDescriptorProjections((accepted) => {
        if (accepted[kind] !== expected) return accepted;
        const next = { ...accepted };
        delete next[kind];
        return next;
      });
      if (kind === 'fields') {
        setOptimisticFields(null);
      } else {
        setOptimisticViews(null);
        setOptimisticPalette(null);
      }
    };
    void Promise.all([
      reconcile('fields', acceptedDescriptorProjections.fields),
      reconcile('views', acceptedDescriptorProjections.views),
    ]).catch(reportFailure('descriptor owner reconciliation'));
    return () => { cancelled = true; };
  }, [
    acceptedDescriptorProjections,
    descriptorSnapshots,
    observeDescriptorProjection,
    readDescriptorProjection,
  ]);
  const readFreshDescriptorSnapshots = React.useCallback(async (
    draft: DescriptorMutationDraft,
  ): Promise<readonly AddressedDescriptorSnapshot[]> => {
    if (!descriptorOwner || !writeRecord?.readCurrent) {
      throw new Error('The descriptor owner did not expose independent current-value readback.');
    }
    const byIdentity = new Map(
      descriptorSnapshotsRef.current.map((snapshot) => [
        descriptorKeyIdentity(snapshot.key),
        snapshot,
      ]),
    );
    const dependencies = new Map<string, DescriptorKey>();
    const includeDependency = (key: DescriptorKey) => {
      dependencies.set(descriptorKeyIdentity(key), key);
      for (const parent of key.parent ?? []) {
        const parentKey = { family: parent.family, id: parent.id };
        dependencies.set(descriptorKeyIdentity(parentKey), parentKey);
      }
    };
    draft.operations.forEach((operation) => includeDependency(operation.key));
    draft.integrityScopes.forEach((scope) => {
      includeDependency(descriptorIntegrityGenerationKey(scope));
    });
    draft.requiredCurrentKeys.forEach(includeDependency);
    draft.forbiddenCurrentKeys.forEach(includeDependency);

    // Authority dependencies must never be inherited from a lagging feed.
    // Remove all of them before independent reads so authoritative absence is
    // preserved and a failed/malformed read aborts instead of returning stale
    // bytes for that key.
    dependencies.forEach((_key, identity) => byIdentity.delete(identity));
    for (const [identity, key] of dependencies) {
      const addressLabel = descriptorAddressFor(descriptorOwner, key);
      const current = await writeRecord.readCurrent(addressLabel);
      if (!current) continue;
      const payload = descriptorFactFromUnknown(current.payload);
      if (!payload || descriptorKeyIdentity(payload.key) !== identity) {
        throw new Error('The descriptor owner returned malformed current data.');
      }
      byIdentity.set(identity, {
        key: payload.key,
        addressLabel,
        pathLabels: descriptorOwner.pathLabels,
        payload,
        payloadHash: new Uint8Array(current.payloadHash),
      });
    }
    return [...byIdentity.values()];
  }, [descriptorOwner, writeRecord]);
  const settleDescriptorDraft = React.useCallback(async (
    kind: 'fields' | 'views',
    scope: string,
    draft: DescriptorMutationDraft,
  ): Promise<boolean> => {
    if (!descriptorOwner || !writeRecord || !mutationSettlementPolicy || !writeRecord.readCurrent) {
      throw new Error('The independently addressed descriptor owner is not writable.');
    }
    const reportSaved = reportSuccessFor('Saved');
    const observationStartedAt = typeof performance === 'undefined'
      ? Date.now()
      : performance.now();
    const touchedIdentities = new Set(
      draft.operations.map((operation) => descriptorKeyIdentity(operation.key)),
    );
    const snapshotRevisionHash = (
      snapshots: readonly AddressedDescriptorSnapshot[],
    ) => opaqueVisualDatabaseObservationHash(
      'descriptor-current-revision',
      JSON.stringify(
        snapshots
          .filter((snapshot) => touchedIdentities.has(descriptorKeyIdentity(snapshot.key)))
          .map((snapshot) => [
            descriptorKeyIdentity(snapshot.key),
            [...snapshot.payloadHash],
          ])
          .sort(([left], [right]) => String(left).localeCompare(String(right))),
      ),
    );
    const draftHash = opaqueVisualDatabaseObservationHash(
      'descriptor-draft',
      JSON.stringify(draft),
    );
    const operationSetHash = opaqueVisualDatabaseObservationHash(
      'descriptor-operation-set',
      JSON.stringify(draft.operations),
    );
    const ownerNamespaceHash = opaqueVisualDatabaseObservationHash(
      'descriptor-owner-namespace',
      JSON.stringify([descriptorOwner.addressPrefix, descriptorOwner.pathLabels]),
    );
    const addressedIdentityHash = opaqueVisualDatabaseObservationHash(
      'descriptor-addressed-identities',
      JSON.stringify(
        draft.operations
          .map((operation) => descriptorAddressFor(descriptorOwner, operation.key))
          .sort(),
      ),
    );
    const baseRevisionHash = opaqueVisualDatabaseObservationHash(
      'descriptor-base-revisions',
      JSON.stringify(
        draft.bases
          .map((base) => [descriptorKeyIdentity(base.key), [...base.payloadHash]])
          .sort(([left], [right]) => String(left).localeCompare(String(right))),
      ),
    );
    let currentRevisionHash = snapshotRevisionHash(descriptorSnapshotsRef.current);
    let resultRevisionHash = opaqueVisualDatabaseObservationHash(
      'descriptor-result-revision',
      'unmaterialized',
    );
    const observeDescriptorPhase = (
      phase: import('@/packages/visual-database/show/visual-database-observation')
        .VisualDatabaseObservationMap['visual-database:descriptor-mutation']['phase'],
      elapsedMs?: number,
    ) => {
      const now = typeof performance === 'undefined' ? Date.now() : performance.now();
      dispatchVisualDatabaseObservation('visual-database:descriptor-mutation', {
        draft_hash: draftHash,
        operation_set_hash: operationSetHash,
        owner_namespace_hash: ownerNamespaceHash,
        addressed_identity_hash: addressedIdentityHash,
        base_revision_hash: baseRevisionHash,
        current_revision_hash: currentRevisionHash,
        result_revision_hash: resultRevisionHash,
        phase,
        elapsed_ms: elapsedMs ?? Math.max(0, now - observationStartedAt),
        observed_at: new Date().toISOString(),
      });
    };
    setDescriptorUncertain(null);
    observeDescriptorPhase('draft-created');
    let activeDraft = draft;
    let integrityRefreshUsed = false;
    let current = descriptorSnapshotsRef.current;
    let materialized = materializeDescriptorOperations({
      target: descriptorOwner,
      draft: activeDraft,
      current,
    });
    const observeMaterialization = () => {
      currentRevisionHash = snapshotRevisionHash(current);
      resultRevisionHash = opaqueVisualDatabaseObservationHash(
        'descriptor-result-revision',
        JSON.stringify(materialized),
      );
      observeDescriptorPhase('materialized');
      if (materialized.rebasedKeys.length > 0) observeDescriptorPhase('rebased');
      if (materialized.state === 'conflict') observeDescriptorPhase('conflicted');
      if (materialized.state === 'deduplicated') observeDescriptorPhase('deduplicated');
    };
    observeMaterialization();
    const refreshInfrastructureConflict = () => {
      if (
        integrityRefreshUsed
        || materialized.state !== 'conflict'
        || materialized.conflicts.length === 0
        || materialized.conflicts.some(({ reason }) => reason !== 'integrity-generation-changed')
      ) return false;
      const refreshed = resolveDescriptorMutationConflictDraft({
        draftId: `${activeDraft.draftId}:integrity-refresh`,
        draft: activeDraft,
        conflicts: materialized.conflicts,
        current,
        choices: new Map(),
      });
      if (!refreshed) return false;
      integrityRefreshUsed = true;
      activeDraft = refreshed;
      materialized = materializeDescriptorOperations({
        target: descriptorOwner,
        draft: activeDraft,
        current,
      });
      observeMaterialization();
      return materialized.state !== 'conflict';
    };
    if (materialized.state === 'conflict') {
      current = await readFreshDescriptorSnapshots(activeDraft);
      materialized = materializeDescriptorOperations({
        target: descriptorOwner,
        draft: activeDraft,
        current,
      });
      observeMaterialization();
      refreshInfrastructureConflict();
    }
    if (materialized.state === 'conflict') {
      setDescriptorConflict({
        kind,
        scope,
        draft: activeDraft,
        conflicts: materialized.conflicts,
        current,
        choices: new Map(),
        busyConflictIndex: null,
      });
      return false;
    }
    const settle = async () => {
      mutationAttemptCounter.current += 1;
      const attemptId = `descriptor-${Date.now().toString(36)}-${mutationAttemptCounter.current.toString(36)}`;
      const observationIdentity = {
        attemptHash: opaqueVisualDatabaseObservationHash('attempt', attemptId),
        addressedIdentityHash: opaqueVisualDatabaseObservationHash(
          'addressed-identities',
          materialized.expected.map(({ addressLabel }) => addressLabel).sort().join('\0'),
        ),
        expectedRevisionHash: opaqueVisualDatabaseObservationHash(
          'expected-revision',
          JSON.stringify(materialized.expected.map(({ payload }) => payload)),
        ),
      };
      const attempt = buildDescriptorSettlementAttempt({
        attemptId,
        scope: `descriptor:${scope}`,
        materialization: materialized,
        writer: writeRecord,
        observeFeed: () => observeDescriptorProjection(materialized.expected),
        readCurrent: async () => {
          const currentProjection = await readDescriptorProjection(materialized.expected);
          currentRevisionHash = opaqueVisualDatabaseObservationHash(
            'current-revision',
            JSON.stringify(currentProjection),
          );
          return currentProjection;
        },
        policy: mutationSettlementPolicy,
        onTransition: (transition) => observeSettlementTransition(transition, {
          ...observationIdentity,
          currentRevisionHash,
        }),
      });
      attempt.onTransition = (transition) => {
        observeSettlementTransition(transition, {
          ...observationIdentity,
          currentRevisionHash,
        });
        if (transition.phase === 'transport-accepted') {
          observeDescriptorPhase('transported', transition.elapsedMs);
        } else if (transition.phase === 'feed-observed') {
          observeDescriptorPhase('feed-observed', transition.elapsedMs);
        } else if (transition.phase === 'direct-readback') {
          observeDescriptorPhase('current-observed', transition.elapsedMs);
        } else if (transition.phase === 'deduplicated') {
          observeDescriptorPhase('deduplicated', transition.elapsedMs);
        } else if (transition.phase === 'conflict') {
          observeDescriptorPhase('conflicted', transition.elapsedMs);
        } else if (transition.phase === 'saved') {
          observeDescriptorPhase('settled', transition.elapsedMs);
        }
      };
      return mutationSettlement.settle(attempt);
    };

    let result = await settle();
    if (result.state === 'conflict') {
      current = await readFreshDescriptorSnapshots(activeDraft);
      materialized = materializeDescriptorOperations({
        target: descriptorOwner,
        draft: activeDraft,
        current,
      });
      observeMaterialization();
      refreshInfrastructureConflict();
      if (materialized.state === 'conflict') {
        setDescriptorConflict({
          kind,
          scope,
          draft: activeDraft,
          conflicts: materialized.conflicts,
          current,
          choices: new Map(),
          busyConflictIndex: null,
        });
        return false;
      }
      if (materialized.state === 'deduplicated') {
        result = await settle();
        if (result.state === 'saved') {
          setDescriptorConflict(null);
          setAcceptedDescriptorProjections((accepted) => ({
            ...accepted,
            [kind]: materialized.expected,
          }));
          reportSaved();
          return true;
        }
      } else {
        result = await settle();
        if (result.state === 'saved') {
          setDescriptorConflict(null);
          setAcceptedDescriptorProjections((accepted) => ({
            ...accepted,
            [kind]: materialized.expected,
          }));
          reportSaved();
          return true;
        }
        if (result.state === 'conflict') {
          current = await readFreshDescriptorSnapshots(activeDraft);
          materialized = materializeDescriptorOperations({
            target: descriptorOwner,
            draft: activeDraft,
            current,
          });
          observeMaterialization();
          if (materialized.state === 'conflict') {
            setDescriptorConflict({
              kind,
              scope,
              draft: activeDraft,
              conflicts: materialized.conflicts,
              current,
              choices: new Map(),
              busyConflictIndex: null,
            });
            return false;
          }
        }
      }
    }
    if (result.state === 'saved') {
      setDescriptorConflict(null);
      setAcceptedDescriptorProjections((accepted) => ({
        ...accepted,
        [kind]: materialized.expected,
      }));
      reportSaved();
      return true;
    }
    setDescriptorUncertain({
      kind,
      scope,
      draft: activeDraft,
      busy: false,
      message: result.state === 'timeout'
        ? 'The owner did not return both the live update and independent readback before the save window ended.'
        : 'The owner could not confirm this save. The exact draft has been preserved.',
    });
    return false;
  }, [
    descriptorOwner,
    mutationSettlement,
    mutationSettlementPolicy,
    observeSettlementTransition,
    observeDescriptorProjection,
    readDescriptorProjection,
    readFreshDescriptorSnapshots,
    writeRecord,
  ]);
  const persistDescriptorOperations = React.useCallback(async (
    kind: 'fields' | 'views',
    desiredPayload: unknown,
    scope: string,
  ): Promise<boolean> => {
    if (!descriptorOwner || descriptorAuthorityError) {
      const error = new Error(
        descriptorAuthorityError
          ?? 'The independently addressed descriptor owner is not active.',
      );
      reportFailure(scope)(error);
      return false;
    }
    const plan = planVisualDatabaseDescriptorIntent({
      target: descriptorOwner,
      kind,
      current: descriptorSnapshotsRef.current,
      desiredPayload,
      draftId: `${kind}-${Date.now().toString(36)}-${scope}`,
    });
    if (plan.state === 'unchanged') return true;
    if (plan.state === 'conflict') {
      reportFailure(scope)(new Error(
        `Cannot delete ${plan.blockedKey.id}; ${plan.referencingKeys.length} saved descriptor${plan.referencingKeys.length === 1 ? '' : 's'} still reference it.`,
      ));
      return false;
    }
    try {
      return await settleDescriptorDraft(kind, scope, plan.draft);
    } catch (error) {
      setDescriptorUncertain({
        kind,
        scope,
        draft: plan.draft,
        busy: false,
        message: error instanceof Error
          ? error.message
          : 'The owner could not confirm this save. The exact draft has been preserved.',
      });
      reportFailure(scope)(error);
      return false;
    }
  }, [
    descriptorAuthorityError,
    descriptorOwner,
    settleDescriptorDraft,
  ]);
  const persistViewDescriptors = (
    views: readonly VisualDatabaseViewDescriptor[],
    scope: string,
    palette: readonly VisualDatabasePaletteColor[] = model.palette,
  ) => {
    if (!writeRecord || !descriptorOwner) return reportFailure(scope)(new Error('No view descriptor owner was supplied'));
    const persistableViews = views.filter((candidate) => candidate.visibility !== 'direct');
    const loadedDirectViews = model.views.filter((candidate) => candidate.visibility === 'direct');
    setOptimisticViews([...persistableViews, ...loadedDirectViews]);
    setOptimisticPalette(palette);
    const value = serializeViews(persistableViews, palette);
    const token = ++descriptorSaveTokens.current.views;
    void persistDescriptorOperations('views', value, scope).then((saved) => {
      if (descriptorSaveTokens.current.views !== token) return;
      if (!saved) return;
    });
  };
  const persistPaletteDescriptors = (palette: readonly VisualDatabasePaletteColor[]) => {
    persistViewDescriptors(model.views, 'colors', palette);
  };
  const persistFieldDescriptors = (
    fields: readonly VisualDatabaseFieldDescriptor[],
    scope: string,
    createdFieldId?: string,
  ) => {
    if (!writeRecord || !descriptorOwner) return reportFailure(scope)(new Error('No field descriptor owner was supplied'));
    setOptimisticFields(fields);
    const value = serializePersistableFields(fields);
    const token = ++descriptorSaveTokens.current.fields;
    void persistDescriptorOperations('fields', value, scope).then((saved) => {
      if (descriptorSaveTokens.current.fields !== token) return;
      const createdField = saved && createdFieldId
        ? feedModelRef.current.fields.find((field) => field.id === createdFieldId)
        : undefined;
      if (createdField) {
        dispatchVisualDatabaseObservation('visual-database:owner-reply', {
          kind: 'field-direct-readback',
          state: 'verified',
          field_count: 1,
          observed_at: new Date().toISOString(),
        });
      }
    });
  };
  const persistChoiceDescriptors = (descriptorId: string, values: readonly VisualDatabaseFieldDomainValue[]) => {
    const next = model.fields.map((field) => (
      field.id === descriptorId
        ? {
            ...field,
            // Once the empty bucket is an ordered domain value, the legacy
            // out-of-band label dies. One ordered value list is the SSOT.
            ...(values.some((value) => value.id === EMPTY_LANE_ID) ? { emptyLabel: undefined } : {}),
            domain: { ...field.domain, open: field.domain?.open ?? true, values },
          }
        : field
    ));
    persistFieldDescriptors(next, 'choices');
  };
  // Custom domain options (statuses, priorities, …) persist to the FIELDS
  // data record through one registered seam — editors stay write-agnostic.
  React.useEffect(() => {
    if (!writeRecord) return undefined;
    registerDomainWriter((descriptorId, values) => {
      persistChoiceDescriptors(descriptorId, values);
    });
    return () => registerDomainWriter(null);
  }, [writeRecord, model.fields]);

  const clearDescriptorOptimism = React.useCallback((kind: 'fields' | 'views') => {
    if (kind === 'fields') {
      setOptimisticFields(null);
    } else {
      setOptimisticViews(null);
      setOptimisticPalette(null);
    }
  }, []);
  const resolveVisibleDescriptorConflict = React.useCallback(async (
    index: number,
    choice: DescriptorConflictChoice,
  ) => {
    const pending = descriptorConflict;
    if (!pending) return;
    const choices = new Map(pending.choices);
    choices.set(index, choice);
    if (choices.size < pending.conflicts.length) {
      setDescriptorConflict({
        ...pending,
        choices,
        announcement: `${choices.size} of ${pending.conflicts.length} conflicts reviewed.`,
      });
      return;
    }
    setDescriptorConflict({
      ...pending,
      choices,
      busyConflictIndex: index,
      announcement: 'Applying your choices…',
    });
    const resolved = resolveDescriptorMutationConflictDraft({
      draftId: `${pending.draft.draftId}-resolved-${Date.now().toString(36)}`,
      draft: pending.draft,
      conflicts: pending.conflicts,
      current: pending.current,
      choices,
    });
    if (!resolved) {
      setDescriptorConflict(null);
      clearDescriptorOptimism(pending.kind);
      return;
    }
    try {
      const saved = await settleDescriptorDraft(pending.kind, pending.scope, resolved);
      if (saved) clearDescriptorOptimism(pending.kind);
    } catch (error) {
      setDescriptorConflict(null);
      setDescriptorUncertain({
        kind: pending.kind,
        scope: pending.scope,
        draft: resolved,
        busy: false,
        message: error instanceof Error
          ? error.message
          : 'The owner could not confirm this save. The exact draft has been preserved.',
      });
    }
  }, [
    clearDescriptorOptimism,
    descriptorConflict,
    settleDescriptorDraft,
  ]);
  const retryUncertainDescriptorDraft = React.useCallback(async () => {
    const pending = descriptorUncertain;
    if (!pending || pending.busy) return;
    setDescriptorUncertain({ ...pending, busy: true });
    try {
      const saved = await settleDescriptorDraft(pending.kind, pending.scope, pending.draft);
      if (saved) {
        setDescriptorUncertain(null);
        clearDescriptorOptimism(pending.kind);
      } else {
        setDescriptorUncertain((current) => current ? { ...current, busy: false } : current);
      }
    } catch (error) {
      setDescriptorUncertain({
        ...pending,
        busy: false,
        message: error instanceof Error
          ? error.message
          : 'The owner could not confirm this save. The exact draft has been preserved.',
      });
    }
  }, [
    clearDescriptorOptimism,
    descriptorUncertain,
    settleDescriptorDraft,
  ]);

  // minWidth=0 clamps the surface to its parent: wide content (kanban rail,
  // tables, long rows) scrolls INSIDE its own container — the page itself
  // never grows past the viewport, on ANY view kind.
  if (!['ready', 'offline', 'concurrent'].includes(surfaceState.kind)) {
    return (
      <Card variant="surface" padding="lg" role="region" aria-label={view?.label ?? 'Visual database'}>
        <Text variant="heading-lg" color="strong">{view?.label ?? 'All'}</Text>
        <SurfaceStateNotice state={surfaceState} onAction={onSurfaceStateAction} />
        {surfaceState.kind === 'loading' ? <div aria-busy="true" aria-label="Getting your work" /> : null}
      </Card>
    );
  }
  const rendererProps: ViewProps | null = view ? {
    records,
    lanes,
    view,
    model,
    expandedId,
    onToggle,
    latestRecordRefs,
    onSelectNode,
    writeRecord: recordWriter,
    onDeleteStart: hideRecord,
    onDeleteFailure: restoreRecord,
    onInvokeAction,
    selectionActions,
    onInvokeSelectionAction,
    manualOrder: view.kind !== 'timeline',
    derivedCells,
    onPersistView: writeRecord ? (nextView, scope) => {
      persistViewDescriptors(model.views.map((candidate) => (candidate.id === nextView.id ? nextView : candidate)), scope);
    } : undefined,
    onPersistField: writeRecord && descriptorOwner ? (nextField, scope) => {
      persistFieldDescriptors(model.fields.map((field) => (
        field.id === nextField.id ? { ...nextField, source: 'declared' } : field
      )), scope);
    } : undefined,
    onPersistPalette: writeRecord && descriptorOwner ? persistPaletteDescriptors : undefined,
    onPersistChoice: writeRecord ? persistChoiceDescriptors : undefined,
    onAddField: writeRecord ? (descriptor) => {
      // ONE runtime descriptor append to the fields DATA record —
      // the same writer seam the domain editor uses (never re-admission).
      persistFieldDescriptors(
        [...model.fields.filter((field) => field.source !== 'discovered'), descriptor],
        'add field',
        descriptor.id,
      );
    } : undefined,
    onEditCellExpression: openExpressionEditor,
    editingExpressionCell: editingExpressionDraft ?? undefined,
    onEditingExpressionDraftChange: (source, selection) => setEditingExpressionDraft((current) => current
      ? { ...current, source, selection }
      : current),
    revealExpressionCell,
    expressionReferencePicking,
    onExpressionReferenceSelection: selectExpressionReferences,
    cellExpressions: foldedByKey,
    evaluatorDescriptors,
    expressionReferenceCatalog,
    onRecalculateCell: requestCellRecalculation,
  } : null;
  const renderedView = rendererProps ? (
    (view?.kind === 'table' || view?.kind === 'gallery') && groupingRuleForView(view)
      ? <GroupedCollectionView renderer={Renderer} {...rendererProps} />
      : <Renderer {...rendererProps} />
  ) : null;
  return (
    <VisualDatabaseCreateContext.Provider value={{ target: recordTarget }}>
    <Card
      variant={presentation === 'section' ? 'ghost' : 'surface'}
      padding={presentation === 'section' ? 'none' : 'lg'}
      layout="stack"
      height="full"
      minWidth="0"
      onClickCapture={handleInspectClick}
      data-visual-database-view-id={view?.id}
      data-visual-database-presentation={presentation}
      data-view-record-sha256={activeViewIdentity?.viewRecordSha256}
      data-source-dataset-address={activeViewIdentity?.sourceDatasetAddress}
      data-dataset-payload-sha256={activeViewIdentity?.datasetPayloadSha256}
      data-selected-model-sha256={activeViewIdentity?.selectedModelSha256}
      role={presentation === 'section' ? 'region' : undefined}
      aria-label={presentation === 'section' ? view?.label ?? 'Visual database' : undefined}
    >
      <Container layout="horizontal" alignItems="center" justifyContent="between" gap="md" padding="none">
        <Container layout="horizontal" alignItems="center" gap="sm" padding="none">
          {view?.icon ? <ViewIcon name={view.icon} /> : view?.color ? <ColorDot color={view.color} /> : <Icon icon={Rows3} size="sm" />}
          <Text variant="heading-lg" color="strong">{view?.label ?? 'All'}</Text>
          <Text variant="caption" color="faint">{String(rootRecordCount)}</Text>
        </Container>
        <Container layout="horizontal" padding="none" minHeight="0">
          {presentation !== 'section' && <Input
            aria-label="Search records"
            icon={<Search size={14} aria-hidden="true" />}
            placeholder="Search"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
          />}
        </Container>
      </Container>

      <SurfaceStateNotice state={surfaceState} onAction={onSurfaceStateAction} />
      {descriptorAuthorityError ? (
        <Card variant="error" padding="sm" role="alert">
          <Text variant="body" color="error">
            This board’s saved setup could not be verified. Editing is disabled so no data can be overwritten.
          </Text>
        </Card>
      ) : null}

      {descriptorConflict || descriptorUncertain ? (
        <DescriptorConflictRecovery
          conflicts={descriptorConflict
            ? descriptorConflictValuesFromMutation(descriptorConflict.conflicts)
            : []}
          busyConflictId={descriptorConflict?.busyConflictIndex === null
            || descriptorConflict?.busyConflictIndex === undefined
            ? null
            : `conflict-${descriptorConflict.busyConflictIndex}`}
          announcement={descriptorConflict?.announcement}
          onResolve={(conflict, choice) => {
            const index = Number(conflict.id.replace(/^conflict-/u, ''));
            if (Number.isInteger(index)) void resolveVisibleDescriptorConflict(index, choice);
          }}
          onReviewEach={() => {
            const first = document.querySelector<HTMLElement>(
              '[data-testid="descriptor-conflict-conflict-0"] button',
            );
            first?.focus();
          }}
          uncertain={descriptorUncertain ? {
            message: descriptorUncertain.message,
            busy: descriptorUncertain.busy,
            onRetry: retryUncertainDescriptorDraft,
          } : undefined}
        />
      ) : null}

      {presentation !== 'section' && <Container layout="horizontal" gap="xs" padding="none" alignItems="center" wrap="wrap" justifyContent="between">
        <Container layout="horizontal" gap="xs" padding="none" alignItems="center" wrap="wrap">
          {navigationViews.map((candidate) => {
            return (
              <Container
                key={candidate.id}
                layout="horizontal"
                padding="none"
                draggable
                onDragStart={(event: React.DragEvent) => {
                  event.dataTransfer.setData('application/x-view-id', candidate.id);
                  event.dataTransfer.effectAllowed = 'move';
                }}
                onDragOver={(event: React.DragEvent) => {
                  if (dragCarries(event, 'application/x-view-id')) event.preventDefault();
                }}
                onDrop={(event: React.DragEvent) => {
                  event.preventDefault();
                  const draggedId = event.dataTransfer.getData('application/x-view-id');
                  if (!draggedId || draggedId === candidate.id || !writeRecord) return;
                  const ordered = navigationViews.filter((entry) => entry.id !== draggedId);
                  const targetIndex = ordered.findIndex((entry) => entry.id === candidate.id);
                  const dragged = navigationViews.find((entry) => entry.id === draggedId);
                  if (!dragged || targetIndex < 0) return;
                  ordered.splice(targetIndex, 0, dragged);
                  persistViewDescriptors(ordered.map((entry, index) => ({ ...entry, order: (index + 1) * 10 })), 'reorder');
                }}
              >
                {/* Amie tab anatomy (ref 03: "Work list 3 ˅"): ONE chip —
                    the options chevron lives INSIDE the active tab, hover-
                    revealed, full tab height. Never a separate stub button. */}
                <HoverRevealGroup layout="horizontal" alignItems="center" gap="none" padding="none">
                  <Button
                    variant="ghost"
                    size="sm"
                    active={candidate.id === view?.id}
                    onClick={() => setActiveViewId(candidate.id)}
                  >
                    {candidate.icon ? <ViewIcon name={candidate.icon} /> : null}
                    {candidate.color ? <ColorDot color={candidate.color} /> : null}
                    {candidate.label}
                    {writeRecord && candidate.id === view?.id ? (
                      <HoverRevealItem>
                        <ListOptionsMenu
                          view={candidate}
                          views={navigationViews}
                          palette={model.palette}
                          onPersist={persistViewDescriptors}
                          onDeleted={() => setActiveViewId(navigationViews.find((entry) => entry.id !== candidate.id)?.id ?? '')}
                        />
                      </HoverRevealItem>
                    ) : null}
                  </Button>
                </HoverRevealGroup>
              </Container>
            );
          })}
          {writeRecord && descriptorOwner ? (
            <Button variant="ghost" size="sm" aria-label="New list" active={creatingList} onClick={() => setCreatingList((value) => !value)} data-reach-action="create-table">
              <Icon icon={Plus} size="xs" />
            </Button>
          ) : null}
        </Container>
        {writeRecord && view && view.visibility !== 'direct' ? (
          <Container layout="horizontal" gap="xs" padding="none" alignItems="center">
            {descriptorOwner ? (
              <FieldsMenu
                model={model}
                evaluators={evaluatorDescriptors}
                onFieldsChange={persistFieldDescriptors}
                onPaletteChange={persistPaletteDescriptors}
                onChoiceChange={persistChoiceDescriptors}
              />
            ) : null}
            {['board', 'table', 'gallery'].includes(view.kind) ? (
              <GroupByMenu
                view={view}
                model={model}
                onViewChange={(nextView, scope) => {
                  persistViewDescriptors(model.views.map((candidate) => (
                    candidate.id === nextView.id ? nextView : candidate
                  )), scope);
                }}
              />
            ) : null}
            {Object.keys(viewRenderers).map((layout) => (
              <Button
                key={layout}
                variant="ghost"
                size="xs"
                active={view.kind === layout}
                aria-label={`${layout} layout`}
                onClick={() => {
                  if (view.kind === layout) return;
                  persistViewDescriptors(
                    model.views.map((candidate) => {
                      if (candidate.id !== view.id) return candidate;
                      const grouping = layout === 'board'
                        ? groupingDescriptorForView(candidate, model.fields)
                        : null;
                      const next = { ...candidate, kind: layout };
                      return layout === 'board' && grouping
                        ? withViewGrouping(next, grouping.id)
                        : next;
                    }),
                    'layout change',
                  );
                }}
              >
                <Icon icon={viewIcons[layout] ?? Rows3} size="xs" />
              </Button>
            ))}
          </Container>
        ) : null}
      </Container>}

      {creatingList && writeRecord && descriptorOwner ? (
        <NewListForm model={model} onPersist={persistViewDescriptors} onCreated={setActiveViewId} onClose={() => setCreatingList(false)} />
      ) : null}

      {/* Creation is a surface capability, not a view-specific capability.
          Every writable view gets the same descriptor-driven composer when its
          records are empty; table keeps its inline row composer so it does not
          render two creation controls. */}
      {recordWriter && view && view.kind !== 'table' ? (
        <RecordComposer view={view} lanes={lanes} records={records} model={model} writeRecord={recordWriter} />
      ) : null}

      {formulaSavedStatus ? (
        <Text
          role="status"
          data-testid="formula-saved-status"
          data-ui-node="formula-saved-status"
          data-cell-key={formulaSavedStatus.cellKey}
          data-source-revision={formulaSavedStatus.sourceRevision}
          data-saved-observed-at={formulaSavedStatus.observedAt}
          variant="body-sm"
          color="muted"
        >
          Saved {formulaSavedStatus.humanLabel}
        </Text>
      ) : null}

      <Container
        layout="vertical"
        gap="md"
        padding="none"
        overflow="auto"
        minHeight="0"
        flex="1"
        data-testid="visual-database-scroll-owner"
        data-ui-node="visual-database-scroll-owner"
        tabIndex={0}
        data-scroll-owner="visual-database-scroll-owner"
        data-reach-role="visual-database-list"
      >
      {editingCell && editingExpressionDraft ? (
        <Container
          id="formula-composer"
          role="group"
          aria-label={`Formula for ${editingExpressionDraft.humanLabel}`}
          layout="vertical"
          gap="xs"
          padding="none"
          data-testid="formula-composer"
          data-ui-node="formula-composer"
          data-cell-key={cellRefKey({
            recordRef: editingExpressionDraft.recordRef,
            fieldRef: editingExpressionDraft.fieldRef,
          })}
          style={{
            position: 'sticky',
            top: 0,
            zIndex: 2,
          }}
        >
          <CellExpressionEditor
            cellRef={{ recordRef: recordViewKey(editingCell.record), fieldRef: editingCell.field.id }}
            expression={editingCell.cell?.expression ?? editingCell.field.defaultExpression ?? { literal: extractFieldValue(editingCell.record, editingCell.field) }}
            cellLabel={editingExpressionDraft.humanLabel}
            evaluators={evaluatorDescriptors.filter((descriptor) => {
              const admitted = editingCell.field.evaluatorDescriptorRefs;
              return !admitted || admitted.some((entry) => entry.ref === descriptor.ref);
            })}
            revision={addressedSourceForCell(cellExpressionInputs, {
              recordRef: recordViewKey(editingCell.record),
              fieldRef: editingCell.field.id,
            })?.revision}
            entryTrigger={editingCell.entryTrigger}
            sourceTestId={writeRecord ? 'formula-source' : 'formula-source-read-only'}
            controlledDraft={editingExpressionDraft}
            onDraftChange={(draft) => setEditingExpressionDraft((current) => current
              ? { ...current, source: draft.source, selection: draft.selection }
              : current)}
            referenceCatalog={expressionReferenceCatalog}
            externalReferenceSelection={externalReferenceSelection}
            dispatch={deriveDispatch}
            ownerSessionFactory={expressionOwnerSessionFactory}
            readOnly={!writeRecord}
            cachedValue={editingCell.cell?.cachedValue?.value}
            provenanceDisplayLabel={editingCell.cell?.provenance?.displayLabel}
            projectionState={editingCell.cell?.projectionState}
            onRevealReference={(ref) => {
              setRevealExpressionCell(null);
              window.requestAnimationFrame(() => setRevealExpressionCell(ref));
            }}
            onReferencePickingChange={setExpressionReferencePicking}
            error={editingCell.cell?.issues.length ? 'source-error' : undefined}
            resolutionErrorCode={derivedCells
              ?.get(recordViewKey(editingCell.record))
              ?.get(editingCell.field.id)
              ?.errorCode}
            dependencyPath={humanDependencyPath(
              derivedCells
                ?.get(recordViewKey(editingCell.record))
                ?.get(editingCell.field.id)
                ?.dependencyPath,
              model,
            )}
            onCommit={commitCellExpression}
            onMoveAfterCommit={(intent, acceptance) => {
              if (!acceptance.accepted || !acceptance.readbackIdentity || view?.kind !== 'table') return;
              const tableRecords = hierarchyRootRecords(records, model.fields);
              const tableColumns = applyColumnState(displayColumnDescriptors(model), view.columns);
              const current = {
                rowIndex: tableRecords.findIndex((record) => (
                  recordViewKey(record) === editingExpressionDraft.recordRef
                )),
                columnIndex: tableColumns.findIndex((column) => (
                  column.id === editingExpressionDraft.fieldRef
                )),
              };
              if (current.rowIndex < 0 || current.columnIndex < 0) return;
              const destination = moveCell(current, {
                rowCount: tableRecords.length,
                columnCount: tableColumns.length,
              }, intent);
              if (!destination) return;
              const destinationRecord = tableRecords[destination.rowIndex];
              const destinationField = tableColumns[destination.columnIndex];
              if (!destinationRecord || !destinationField) return;
              setEditingCell(null);
              setEditingExpressionDraft(null);
              setExpressionReferencePicking(false);
              setExternalReferenceSelection(null);
              setRevealExpressionCell(null);
              window.requestAnimationFrame(() => setRevealExpressionCell({
                recordRef: recordViewKey(destinationRecord),
                fieldRef: destinationField.id,
              }));
            }}
            onDismiss={() => {
              setEditingCell(null);
              setEditingExpressionDraft(null);
              setExpressionReferencePicking(false);
              setExternalReferenceSelection(null);
              setRevealExpressionCell(null);
            }}
          />
        </Container>
      ) : null}

        {view && (records.length > 0 || view.kind === 'table' || view.kind === 'board' || view.kind === 'metric' || (view.presentation && SECTION_PRESENTATION_VARIANTS.has(view.presentation.variant))) ? (
          renderedView
        ) : (
          <EmptyPlaceholder icon={Rows3} message={query ? 'No records match your search.' : 'No records in this view yet.'} data-reach-role="empty-state" />
        )}
      </Container>
      {inspectSources ? (
        <InspectorSidebar
          sources={inspectSources}
          loadRecord={loadInspectionRecord}
          dispatchWrite={dispatchInspectionWrite}
          renderFieldEditor={inspectorRenderFieldEditor}
          onClose={() => setInspectSources(null)}
          title="Inspect record"
        />
      ) : null}
    </Card>
    </VisualDatabaseCreateContext.Provider>
  );
}
