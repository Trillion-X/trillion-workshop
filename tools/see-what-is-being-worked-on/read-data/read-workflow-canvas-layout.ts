// packages/workflow-canvas/read-data/read-workflow-canvas-layout.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Decode the workflow-canvas addressed feeds into the living definition graph.
//
// THE ONE TRUTH (plan 2026-06-09-workflow-canvas-living-definition-graph):
// a canvas node IS a projection of a record in the real definition store.
// Executable definitions are published complete-definition records at
// `current-item/published-record/workflow-definition` — the exact records the
// workflow owner hydrates and runs. Triggers are trigger facts. Placement is
// a spatial fact on the same record. Saves write the same store. There is no
// second store, and there is NO publish workflow: every feed below is an
// engine-maintained projection that recomputes the moment a matched record
// changes. The read loop is purely reactive.
//
// Feeds consumed (all engine-maintained, decoded locally — no fetching):
//   - `workflow-canvas-definitions` every complete-definition record at the
//                                  EXACT hydration path
//                                  current-item/published-record/workflow-definition
//                                  (projection matching is exact-path, not
//                                  prefix — package-compiler
//                                  write_engine_state.rs `contains(&path_text)`)
//   - `workflow-canvas-triggers`  trigger fact rows {address, payload}
//   - `workflow-canvas-layout`    spatial facts + live runtime facts
//                                  {address, payload}
//
// Edges are derived, never stored:
//   - definition → definition  every `definition_id` referenced by its steps
//   - trigger    → definition  every `definition_id` in the trigger's
//                               output template
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. read-data only decodes and shapes — no requests, no mutation (orientation
//    rule: the four work folders).
// 2. Visible nodes come only from real definition/trigger rows. Layout-only
//    rows never become nodes.
// 3. Engine vocabulary stays in code/state. Visible copy fields produced here
//    (labels, step sentences) speak plain action-authoring language.
// 4. Deterministic output: same feeds in, same graph out — including the
//    auto-layout positions for rows without a saved layout.
// 5. Step kinds are open strings (the engine registry is open, L090). This
//    module summarizes known kinds in plain words and passes unknown kinds
//    through honestly — it never enumerates-to-reject.
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import { readPublishedRecords } from '../../ui/show/placeable-surface-intent/placeable-surface-record';
import type { CanvasNodeFrame } from '../../graph-canvas/show/types';
import { stepKindIconName } from './describe-step-fields';

// ---------------------------------------------------------------------------
// FEED ROW TYPES (decoded from the addressed cell tables)
// ---------------------------------------------------------------------------

/** One action definition row from the `workflow-canvas` feed. */
export interface WorkflowDefinitionRow {
  id: string;
  slug: string;
  description: string | null;
  isActive: boolean;
  /** Latest engine-owned run state projected by the map owner, if one exists. */
  runState?: WorkflowCanvasRunState | null;
  steps: readonly unknown[];
  /** The step DAG: `{from, to, kind, config}` edges. Branching lives here. */
  edges: readonly unknown[];
  layout: Record<string, unknown> | null;
}

/** One trigger row from the `workflow-canvas-triggers` feed. */
export interface WorkflowTriggerRow {
  id: string;
  name: string;
  topic: string | null;
  outputTemplate: Record<string, unknown> | null;
  isActive: boolean;
  layout: Record<string, unknown> | null;
}

/** One participation row from the `workflow-canvas-links` feed. */
export interface WorkflowCanvasLinkRecord {
  workflowId: string;
  nodeId: string;
  roleId: string;
}

/** The decoded feed bundle. */
export interface WorkflowCanvasFeed {
  definitions: WorkflowDefinitionRow[];
  triggers: WorkflowTriggerRow[];
  links: WorkflowCanvasLinkRecord[];
  /** definition id → package name that ships it (rank-1 owner). */
  shippedBy: ReadonlyMap<string, string>;
}

// ---------------------------------------------------------------------------
// DISPLAY TYPES (what the canvas renders)
// ---------------------------------------------------------------------------

/** Plain-language summary of one step inside a definition. */
export interface WorkflowStepSummary {
  /** Plain sentence, e.g. "Ask Find Current Items to do work". */
  sentence: string;
  /** The raw step kind (engine vocabulary — never shown raw in product copy). */
  kind: string;
  /** Definition ids this step runs. */
  referencedDefinitionIds: string[];
  /** Index into the definition's steps array (for editing). */
  stepIndex: number;
}

export type WorkflowCanvasNodeKind = 'action' | 'trigger';
export type WorkflowCanvasRunState = 'running' | 'completed' | 'failed';

export interface WorkflowCanvasNodeDisplay {
  id: string;
  label: string;
  kind: WorkflowCanvasNodeKind;
  enabled: boolean;
  description: string | null;
  /** Raw steps array (actions) — identity-preserved for editing. */
  steps: readonly unknown[];
  /** Raw step-DAG edges — identity-preserved for editing. */
  edges: readonly unknown[];
  stepSummaries: WorkflowStepSummary[];
  /**
   * Primitive presentation, produced here so the card stays a BLIND renderer
   * (L090/L098/Physics-vs-Society): the canvas read-data layer owns the
   * Society→presentation translation, and the card never branches on `kind`
   * or engine step vocabulary. `iconName` is a presentation icon identity
   * (lucide-style name), not a domain word; `accentTone` is a presentation
   * tone, not "trigger vs action".
   */
  iconName: string;
  caption: string | null;
  /** Latest durable run state from the workflow owner; transient pulses may override it. */
  runState?: WorkflowCanvasRunState | null;
  accentTone: 'success' | 'neutral';
  /**
   * True when the node can receive an incoming connection (renders an in-port).
   * A presentation/topology primitive — the card never asks "is this a trigger".
   */
  hasInPort: boolean;
  /** For triggers: the event that starts it. */
  topic: string | null;
  /** For triggers: the definitions this trigger dispatches (from its output template). */
  runsDefinitionIds: string[];
  /** For triggers: the real payload it dispatches (Lindy's "what it sends"). */
  outputTemplate: Record<string, unknown> | null;
  /** Package that ships this definition; null = yours (editable). */
  shippedBy: string | null;
  /** True when edits through the canvas reach execution (no rank-1 owner). */
  editable: boolean;
  /**
   * Self-describing interaction capabilities. The interactive surfaces (canvas,
   * inspector, command palette, context menu) read THESE flags, never the
   * `kind` word (L090/L063/L098): read-data owns the Society→capability
   * translation, so a new engine node kind sets its flags here and every
   * interaction works with ZERO view edits. `kind` survives only as opaque data
   * for the generic filter facets — no view branches on it for behavior.
   */
  /** Fires on its own — drives the inspector's start-event layout + label. */
  isStartEvent: boolean;
  /** Can originate an outgoing next step (has an out-port and is editable). */
  canChain: boolean;
  /** Can be executed on demand ("Run now") and chosen as a run/chain target. */
  runnable: boolean;
  workflowId: string;
}

/**
 * Presentation icon identity for a node — never a domain word. The kind→icon
 * map is the step-kind catalog's `stepKindIconName` (the ONE source shared with
 * the inspector add-step menu + the "Select next step" catalog, L088/L098); the
 * blind card renders the name and never sees this vocabulary.
 */
function nodeIconName(
  kind: WorkflowCanvasNodeKind,
  stepSummaries: readonly WorkflowStepSummary[],
): string {
  if (kind === 'trigger') return 'zap';
  const first = stepSummaries[0]?.kind ?? null;
  return first ? stepKindIconName(first) : 'settings';
}

/** Presentation tone for a node — trigger-like nodes carry the start accent. */
function nodeAccentTone(kind: WorkflowCanvasNodeKind): 'success' | 'neutral' {
  return kind === 'trigger' ? 'success' : 'neutral';
}

/**
 * Human facet label for a node kind — the toolbar filter chip text. read-data
 * owns this Society→label translation (L098); the toolbar renders the resulting
 * facets blindly. A node kind read-data doesn't have a product word for degrades
 * to its humanized id, so a NEW engine kind still gets a usable chip for free.
 */
function nodeKindFacetLabel(kind: string): string {
  if (kind === 'trigger') return 'Starts';
  if (kind === 'action') return 'Does work';
  return humanizeIdentifier(kind);
}

/**
 * The one quiet caption under a node title — produced here so the card stays a
 * blind renderer (no branching on kind/enabled/step vocabulary in the view).
 */
function nodeCaption(
  kind: WorkflowCanvasNodeKind,
  enabled: boolean,
  description: string | null,
  stepSummaries: readonly WorkflowStepSummary[],
): string | null {
  if (!enabled) return 'Paused';
  if (kind === 'trigger') return description;
  const first = stepSummaries[0]?.sentence ?? null;
  if (!first) return description;
  const extra = stepSummaries.length - 1;
  return extra > 0 ? `${first} +${extra}` : first;
}

export interface WorkflowCanvasEdgeDisplay {
  id: string;
  sourceId: string;
  targetId: string;
  label: string;
}

/** One reachable flow: a trigger root and everything it can run. */
export interface WorkflowCanvasFlow {
  id: string;
  label: string;
  rootId: string;
  memberIds: string[];
}

export interface WorkflowCanvasProjection {
  feedFrames: CanvasNodeFrame[];
  nodeDisplayById: Map<string, WorkflowCanvasNodeDisplay>;
  edgeDisplayById: Map<string, WorkflowCanvasEdgeDisplay>;
  /** Stable flow list for wayfinding rails: trigger roots and their reach. */
  flows: WorkflowCanvasFlow[];
  /**
   * Generic filter facets — the distinct node kinds present, each with a human
   * label. The toolbar renders these blindly instead of hardcoding 'trigger'/
   * 'action' chips, so a new engine node kind appears as a facet with zero view
   * edits (L090/L063).
   */
  nodeKindFacets: readonly { value: string; label: string }[];
}

// ---------------------------------------------------------------------------
// GEOMETRY (consumed by graph-canvas frames; world-space pixels)
// ---------------------------------------------------------------------------

export const NODE_WIDTH = 220;
export const NODE_HEIGHT = 76;
// Vertical flow (Lindy/Zapier/n8n anatomy): triggers at the top, work flows
// DOWN. Layers stack vertically; siblings spread horizontally.
const LAYER_GAP_Y = 170;
const SIBLING_GAP_X = 300;
const ORIGIN_X = 80;
const ORIGIN_Y = 80;
const COMPONENT_GAP_X = 140;
/**
 * Library grid columns scale with inventory size so hundreds of unconnected
 * actions form a roughly screen-shaped block instead of a tall thin wall.
 * Width:height of one grid cell is SIBLING_GAP_X:LAYER_GAP_Y ≈ 1.76, so a
 * 16:10-ish world block needs columns ≈ sqrt(count / 1.76 * 1.6).
 */
function libraryColumnsFor(count: number): number {
  return Math.max(4, Math.ceil(Math.sqrt(count * 0.9)));
}
const LIBRARY_GAP_Y = 170;
const DEFAULT_WORKFLOW_ID = 'workflow:default';

// ---------------------------------------------------------------------------
// SMALL DECODE HELPERS
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readText(raw: unknown): string | null {
  return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : null;
}

function readBoolean(raw: unknown, fallback: boolean): boolean {
  if (typeof raw === 'boolean') return raw;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return fallback;
}

function readRunState(raw: unknown): WorkflowCanvasRunState | null {
  return raw === 'running' || raw === 'completed' || raw === 'failed' ? raw : null;
}

function readNumber(raw: unknown, fallback: number): number {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string' && raw.trim().length > 0) {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

/**
 * Seconds → the largest unit that divides evenly, in plain words
 * ("2 hours", "90 seconds"). The reference wait anatomy (HoneyBook,
 * Intercom) never says raw seconds when a bigger unit fits.
 */
function describeWaitDuration(secs: number): string {
  if (secs > 0 && secs % 86400 === 0) {
    const days = secs / 86400;
    return days === 1 ? '1 day' : `${days} days`;
  }
  if (secs > 0 && secs % 3600 === 0) {
    const hours = secs / 3600;
    return hours === 1 ? '1 hour' : `${hours} hours`;
  }
  if (secs > 0 && secs % 60 === 0) {
    const minutes = secs / 60;
    return minutes === 1 ? '1 minute' : `${minutes} minutes`;
  }
  return secs === 1 ? '1 second' : `${secs} seconds`;
}

function readObject(raw: unknown): Record<string, unknown> | null {
  if (isRecord(raw)) return raw;
  if (typeof raw === 'string' && raw.trim().length > 0) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      return isRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

function readArray(raw: unknown): readonly unknown[] {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string' && raw.trim().length > 0) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function rowsFrom(raw: unknown): readonly unknown[] {
  if (Array.isArray(raw)) return raw;
  if (!isRecord(raw)) return [];
  for (const key of ['records', 'items', 'rows', 'value']) {
    const nested = raw[key];
    if (Array.isArray(nested)) return nested;
  }
  return [];
}

/** "save-workflow-canvas-action" → "Save Workflow Canvas Action". */
export function humanizeIdentifier(value: string): string {
  return value
    .replace(/^(action|trigger|workflow):/, '')
    .replace(/[_:./]+/g, '-')
    .split('-')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

// ---------------------------------------------------------------------------
// FEED DECODING
// ---------------------------------------------------------------------------

/**
 * One fact row from a maintained projection: `{address, payload}` where the
 * payload is the fact body `{subject_id, property_id, value_json, ...}`.
 * `value_json` is JSON-encoded text — exactly how the store keeps it.
 */
interface FactRow {
  subjectId: string;
  propertyId: string;
  value: unknown;
}

function decodeFactRows(raw: unknown): FactRow[] {
  return rowsFrom(raw).flatMap((entry): FactRow[] => {
    if (!isRecord(entry)) return [];
    const payload = isRecord(entry.payload) ? entry.payload : readObject(entry.payload);
    if (!payload) return [];
    const subjectId = readText(payload.subject_id);
    const propertyId = readText(payload.property_id);
    if (!subjectId || !propertyId) return [];
    let value: unknown = payload.value_json;
    if (typeof value === 'string') {
      try {
        value = JSON.parse(value) as unknown;
      } catch {
        // Keep the raw text — honest passthrough.
      }
    }
    return [{ subjectId, propertyId, value }];
  });
}

/** subject → property → latest value (later rows win → live edits override). */
function pivotFacts(rows: FactRow[]): Map<string, Map<string, unknown>> {
  const bySubject = new Map<string, Map<string, unknown>>();
  for (const row of rows) {
    if (!bySubject.has(row.subjectId)) bySubject.set(row.subjectId, new Map());
    bySubject.get(row.subjectId)!.set(row.propertyId, row.value);
  }
  return bySubject;
}

/**
 * Definitions come from published complete-definition records — the exact
 * payloads the workflow owner hydrates and executes. Record ids carrying
 * `package::workflow-canvas::` are the canvas's own (every canvas-created or
 * edited action) and stay editable; any other package's record means the
 * definition is shipped — honest read-only with "make a copy".
 */
function decodeDefinitionRecords(
  rawPublishedRecords: unknown,
  layoutById: ReadonlyMap<string, Record<string, unknown>>,
): { definitions: WorkflowDefinitionRow[]; shippedBy: Map<string, string> } {
  const byId = new Map<string, WorkflowDefinitionRow>();
  const shippedBy = new Map<string, string>();
  for (const record of readPublishedRecords([...rowsFrom(rawPublishedRecords)])) {
    if (!record.recordId.includes('::workflow-action::')) continue;
    if (!isRecord(record.payload)) continue;
    const id = readText(record.payload.id);
    if (!id) continue;
    const steps = readArray(
      record.payload.steps ?? record.payload.workflow_steps ?? record.payload.operations,
    );
    const slug = readText(record.payload.name) ?? id.replace(/^action:/, '');
    const isCanvasOwned = record.recordId.startsWith('package::workflow-canvas::');
    if (!isCanvasOwned) {
      shippedBy.set(id, record.sourcePackage ?? record.recordId.split('::')[1] ?? 'a package');
    }
    const existing = byId.get(id);
    // Canvas-owned records carry the user's latest edit — they win the row.
    if (existing && !isCanvasOwned) continue;
    byId.set(id, {
      id,
      slug,
      description: readText(record.payload.description),
      isActive: record.payload.is_active !== false && record.payload.isActive !== false,
      runState: readRunState(record.payload.run_state),
      steps,
      edges: readArray(record.payload.edges),
      layout: layoutById.get(id) ?? null,
    });
  }
  return { definitions: [...byId.values()], shippedBy };
}

function decodeTriggerFacts(
  raw: unknown,
  layoutById: ReadonlyMap<string, Record<string, unknown>>,
): WorkflowTriggerRow[] {
  const bySubject = pivotFacts(decodeFactRows(raw));
  const triggers: WorkflowTriggerRow[] = [];
  for (const [id, properties] of bySubject) {
    const name = readText(properties.get('prop:trigger:name'));
    if (!name) continue;
    triggers.push({
      id,
      name,
      topic: readText(properties.get('prop:trigger:topic')),
      outputTemplate: readObject(properties.get('prop:trigger:output_template')),
      isActive: readBoolean(properties.get('prop:trigger:is_active'), true),
      layout: layoutById.get(id) ?? null,
    });
  }
  return triggers.sort((left, right) => left.id.localeCompare(right.id));
}

/** Spatial facts (package-declared and live runtime writes) by subject. */
function decodeLayoutFacts(raw: unknown): Map<string, Record<string, unknown>> {
  const layoutById = new Map<string, Record<string, unknown>>();
  for (const row of decodeFactRows(raw)) {
    if (row.propertyId !== 'prop:spatial:layout') continue;
    const layout = readObject(row.value);
    if (layout) layoutById.set(row.subjectId, layout);
  }
  return layoutById;
}

export function decodeWorkflowCanvasFeed(
  rawTriggerFacts: unknown,
  rawLayoutFacts: unknown = [],
  rawDefinitionRecords: unknown = [],
): WorkflowCanvasFeed {
  const layoutById = decodeLayoutFacts(rawLayoutFacts);
  const { definitions, shippedBy } = decodeDefinitionRecords(rawDefinitionRecords, layoutById);
  return {
    definitions,
    triggers: decodeTriggerFacts(rawTriggerFacts, layoutById),
    links: [],
    shippedBy,
  };
}

/**
 * The distinct outside-work targets the system already uses — derived from
 * the steps of every definition on the canvas (self-describing data, zero
 * enumeration). Powers click-first pickers: choosing who does the work means
 * choosing from what demonstrably exists, not typing an address.
 */
export function knownWorkTargets(feed: WorkflowCanvasFeed): string[] {
  const targets = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!isRecord(value)) return;
    if (readText(value.kind) === 'ask' && isRecord(value.config)) {
      const name = readText(value.config.name);
      if (name) targets.add(name);
    }
    for (const child of Object.values(value)) visit(child);
  };
  for (const def of feed.definitions) visit(def.steps);
  return [...targets].sort();
}

/** One real outside-work capability, mined from live usage. */
export interface WorkTargetCapability {
  /** The slot target (engine address — never shown raw). */
  target: string;
  /** How many steps across the whole definition store ask this target. */
  usageCount: number;
  /**
   * A real example payload from live usage (most common shape) — the prefill
   * for new steps, so "Ask X" starts from something that demonstrably works.
   */
  examplePayload: unknown;
  /** Distinct top-level payload keys seen across all usages (field hints). */
  payloadKeys: string[];
}

/**
 * The FULL outside-work capability surface, mined from what the definition
 * store actually does: every `ask` step in every definition reveals a real
 * target plus a real working payload. Self-describing data, zero enumeration
 * (L090) — when a new slot starts being asked anywhere, it appears here.
 * Powers the Lindy-style capability picker with honest prefills.
 */
export function knownWorkTargetCapabilities(feed: WorkflowCanvasFeed): WorkTargetCapability[] {
  const byTarget = new Map<string, { count: number; payloads: unknown[]; keys: Set<string> }>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!isRecord(value)) return;
    if (readText(value.kind) === 'ask' && isRecord(value.config)) {
      const name = readText(value.config.name);
      if (name) {
        if (!byTarget.has(name)) byTarget.set(name, { count: 0, payloads: [], keys: new Set() });
        const entry = byTarget.get(name)!;
        entry.count += 1;
        const input = value.config.input;
        if (isRecord(input)) {
          entry.payloads.push(input);
          for (const key of Object.keys(input)) entry.keys.add(key);
        }
      }
    }
    for (const child of Object.values(value)) visit(child);
  };
  for (const def of feed.definitions) visit(def.steps);
  return [...byTarget.entries()]
    .map(([target, entry]) => ({
      target,
      usageCount: entry.count,
      examplePayload: entry.payloads[0] ?? {},
      payloadKeys: [...entry.keys].sort(),
    }))
    .sort((left, right) => right.usageCount - left.usageCount
      || left.target.localeCompare(right.target));
}

/**
 * The distinct event names triggers already listen for — powers the picker
 * for "wait until something happens" steps.
 */
export function knownEventTopics(feed: WorkflowCanvasFeed): string[] {
  const topics = new Set<string>();
  for (const trigger of feed.triggers) {
    if (trigger.topic) topics.add(trigger.topic);
  }
  return [...topics].sort();
}

// ---------------------------------------------------------------------------
// STEP SUMMARIES (plain language for the engine's real step kinds)
// ---------------------------------------------------------------------------

function collectDefinitionIds(value: unknown, out: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectDefinitionIds(item, out);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if ((key === 'definition_id' || key === 'definitionId')
      && typeof child === 'string' && child.length > 0) {
      out.add(child);
    }
    collectDefinitionIds(child, out);
  }
}

function stepKind(step: unknown): string {
  if (!isRecord(step)) return 'step';
  return readText(step.kind) ?? readText(step.step_type) ?? 'step';
}

function stepConfig(step: unknown): Record<string, unknown> {
  return isRecord(step) && isRecord(step.config) ? step.config : {};
}

function plainName(raw: unknown): string | null {
  const text = readText(raw);
  return text ? humanizeIdentifier(text.replace(/^slot::/, '')) : null;
}

/**
 * One plain sentence per step, grounded in the engine's REAL step kinds:
 * ask / write / read / return / action / loop / wait — plus honest passthrough
 * for custom kinds (the registry is open, L090).
 */
function summarizeStep(
  step: unknown,
  stepIndex: number,
  labelFor: (id: string) => string,
): WorkflowStepSummary {
  const kind = stepKind(step);
  const config = stepConfig(step);
  const referenced = new Set<string>();
  collectDefinitionIds(step, referenced);
  const referencedDefinitionIds = [...referenced].sort();

  let sentence: string;
  switch (kind) {
    case 'ask': {
      const target = plainName(config.name);
      sentence = target ? `Ask ${target} to do work` : 'Ask outside work';
      break;
    }
    case 'write': {
      const items = Array.isArray(config.items) ? config.items.length : 0;
      sentence = items > 1 ? `Write ${items} records` : 'Write a record';
      break;
    }
    case 'read':
      sentence = 'Read a record';
      break;
    case 'return':
      sentence = 'Return a value';
      break;
    case 'action': {
      const target = readText(config.definition_id ?? config.definitionId);
      sentence = target ? `Run ${labelFor(target)}` : 'Run another action';
      break;
    }
    case 'loop': {
      const target = readText(config.definition_id ?? config.definitionId);
      sentence = target ? `For each item, run ${labelFor(target)}` : 'Repeat for each item';
      break;
    }
    case 'wait': {
      const condition = isRecord(config.wait_condition) ? config.wait_condition : {};
      const type = readText(condition.type);
      if (type === 'duration') sentence = `Wait ${describeWaitDuration(readNumber(condition.secs, 0))}`;
      else if (type === 'event') sentence = `Wait for ${readText(condition.event_type) ?? 'an event'}`;
      else if (type === 'until') sentence = 'Wait until a set time';
      else if (type === 'race') sentence = 'Wait for the first of several things';
      else sentence = 'Wait';
      break;
    }
    default:
      sentence = humanizeIdentifier(kind);
  }

  return { sentence, kind, referencedDefinitionIds, stepIndex };
}

export function summarizeSteps(
  steps: readonly unknown[],
  labelFor: (id: string) => string,
): WorkflowStepSummary[] {
  return steps.map((step, index) => summarizeStep(step, index, labelFor));
}

// ---------------------------------------------------------------------------
// BRANCH CONDITIONS (step-DAG edges → human pill text)
// ---------------------------------------------------------------------------

/**
 * Translate one step-DAG edge condition (`{$kind:"binding", select:{from:
 * "input", path:"output.exit_code"}, transform:[{op:"op:core.equals",
 * args:{value:0}}]}`) into the short human pill the canvas shows on a branch:
 * "if exit code = 0". Lindy labels its branch edges with the condition text;
 * n8n labels IF outputs true/false — both put the WHY on the line itself.
 *
 * Returns null when the config is not a condition binding (always-edges and
 * unknown shapes stay unlabeled — honest passthrough, never invented copy).
 */
export function describeEdgeCondition(config: unknown): string | null {
  if (!isRecord(config)) return null;
  if (readText(config.$kind) !== 'binding') return null;
  const select = isRecord(config.select) ? config.select : {};
  const rawPath = readText(select.path);
  const field = rawPath
    ? (rawPath.replace(/^output\.?/, '') || 'result').replace(/[_.]+/g, ' ')
    : 'result';
  const transforms = Array.isArray(config.transform) ? config.transform : [];
  for (const transform of transforms) {
    if (!isRecord(transform)) continue;
    const op = readText(transform.op);
    const args = isRecord(transform.args) ? transform.args : {};
    if (op === 'op:core.equals') {
      const value = args.value;
      if (value === true) return `if ${field}`;
      if (value === false) return `if not ${field}`;
      const shown = typeof value === 'string' ? value : JSON.stringify(value);
      return `if ${field} = ${shown}`;
    }
    if (op === 'op:core.not_equals') {
      const shown = typeof args.value === 'string' ? args.value : JSON.stringify(args.value);
      return `if ${field} ≠ ${shown}`;
    }
  }
  return `if ${field}`;
}

/**
 * Map each definition the steps run → the human condition gating that run.
 *
 * The step DAG is `def.edges` rows `{from, to, kind, config}` between step
 * ids. A canvas edge action→target exists because some STEP references the
 * target; when that step is itself the `to` of an `on_result` edge, the
 * canvas edge is a BRANCH — the condition is the reason that path runs.
 * This resolves: target definition id → condition pill text (or 'otherwise'
 * for an explicit always-edge that has a conditional sibling from the same
 * source step — the Zapier Paths fallback lane).
 */
export function branchLabelsForDefinition(
  steps: readonly unknown[],
  dagEdges: readonly unknown[],
): Map<string, string> {
  const labels = new Map<string, string>();
  if (dagEdges.length === 0) return labels;
  // Step id resolution mirrors the inspector: explicit id, else positional.
  const stepIdAt = (step: unknown, index: number): string =>
    (isRecord(step) && readText(step.id)) || `step_${index}`;
  // Which definitions does each step run?
  const referencedByStep = new Map<string, string[]>();
  steps.forEach((step, index) => {
    const out = new Set<string>();
    collectDefinitionIds(step, out);
    if (out.size > 0) referencedByStep.set(stepIdAt(step, index), [...out]);
  });
  // Inbound DAG edges per step, plus conditional-sibling detection.
  const conditionalSources = new Set<string>();
  const decoded = dagEdges.flatMap((edge) => {
    if (!isRecord(edge)) return [];
    const from = readText(edge.from);
    const to = readText(edge.to);
    if (!from || !to) return [];
    const kind = readText(edge.kind) ?? 'always';
    if (kind === 'on_result') conditionalSources.add(from);
    return [{ from, to, kind, config: edge.config }];
  });
  for (const edge of decoded) {
    const runs = referencedByStep.get(edge.to);
    if (!runs) continue;
    let label: string | null = null;
    if (edge.kind === 'on_result') {
      label = describeEdgeCondition(edge.config) ?? 'if condition holds';
    } else if (edge.kind === 'always' && conditionalSources.has(edge.from)) {
      label = 'otherwise';
    }
    if (!label) continue;
    for (const definitionId of runs) {
      if (!labels.has(definitionId)) labels.set(definitionId, label);
    }
  }
  return labels;
}

// ---------------------------------------------------------------------------
// BINDING TRANSLATION (engine binding ASTs → one plain sentence)
// ---------------------------------------------------------------------------

/** Human name for a binding source. */
function bindingSourceName(from: string | null, key: string | null): string {
  if (from === 'input') return 'what was sent in';
  if (from === 'steps') return key ? `the result of "${humanizeIdentifier(key)}"` : 'an earlier step';
  if (from === 'ambient') return 'the workspace';
  return from ? humanizeIdentifier(from) : 'somewhere';
}

/**
 * Translate one engine binding AST (`{$kind: "binding", select: {from, key?,
 * path?}, transform?: [...]}`) into a single plain-language sentence —
 * "Uses prompt text from what was sent in" — so binding internals NEVER
 * surface as $kind/Select/From/Path rows in product UI (L114/L118).
 *
 * Returns null when the value is not a binding (callers fall through to
 * their default rendering).
 */
export function describeBinding(value: unknown): string | null {
  if (!isRecord(value)) return null;
  if (readText(value.$kind) !== 'binding') return null;
  const select = isRecord(value.select) ? value.select : {};
  const from = readText(select.from);
  const key = readText(select.key);
  const rawPath = readText(select.path);
  const fieldName = rawPath
    ? humanizeIdentifier(rawPath.replace(/^output\.?/, '').replace(/\./g, ' ') || 'result')
    : null;
  const source = bindingSourceName(from, key);
  const transforms = Array.isArray(value.transform) ? value.transform : [];
  const transformed = transforms.length > 0 ? ', adjusted along the way' : '';
  return fieldName
    ? `Uses ${fieldName} from ${source}${transformed}`
    : `Uses ${source}${transformed}`;
}

// ---------------------------------------------------------------------------
// DETERMINISTIC AUTO-LAYOUT (layered by call depth, components stacked)
// ---------------------------------------------------------------------------

interface LayoutInput {
  ids: string[];
  edges: ReadonlyMap<string, WorkflowCanvasEdgeDisplay>;
  savedLayoutById: ReadonlyMap<string, Record<string, unknown>>;
  labelById: ReadonlyMap<string, string>;
}

/**
 * Positions every node deterministically:
 * - connected components are laid out as left-to-right layered flows
 *   (layer = longest path from the component's roots), stacked vertically,
 *   larger components first;
 * - nodes with no edges form a compact library grid below the flows;
 * - a saved layout (the record's own spatial fact) always wins.
 *
 * Cycle-safe: layer promotion is capped at component size.
 */
function computeFrames(input: LayoutInput): CanvasNodeFrame[] {
  const { ids, edges, savedLayoutById, labelById } = input;
  const idSet = new Set(ids);
  const out = new Map<string, CanvasNodeFrame>();

  const frameFromSaved = (id: string): CanvasNodeFrame | null => {
    const saved = savedLayoutById.get(id);
    if (!saved) return null;
    const x = readNumber(saved.x, Number.NaN);
    const y = readNumber(saved.y, Number.NaN);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return {
      id,
      x,
      y,
      width: readNumber(saved.w, NODE_WIDTH),
      height: readNumber(saved.h, NODE_HEIGHT),
    };
  };

  const outgoing = new Map<string, string[]>();
  const incoming = new Map<string, string[]>();
  const neighbors = new Map<string, string[]>();
  for (const id of ids) {
    outgoing.set(id, []);
    incoming.set(id, []);
    neighbors.set(id, []);
  }
  for (const edge of edges.values()) {
    if (!idSet.has(edge.sourceId) || !idSet.has(edge.targetId)) continue;
    outgoing.get(edge.sourceId)!.push(edge.targetId);
    incoming.get(edge.targetId)!.push(edge.sourceId);
    neighbors.get(edge.sourceId)!.push(edge.targetId);
    neighbors.get(edge.targetId)!.push(edge.sourceId);
  }

  const sortByLabel = (a: string, b: string) =>
    (labelById.get(a) ?? a).localeCompare(labelById.get(b) ?? b) || a.localeCompare(b);

  const seen = new Set<string>();
  const components: string[][] = [];
  const singles: string[] = [];
  for (const id of [...ids].sort(sortByLabel)) {
    if (seen.has(id)) continue;
    if ((neighbors.get(id)?.length ?? 0) === 0) {
      seen.add(id);
      singles.push(id);
      continue;
    }
    const component: string[] = [];
    const queue = [id];
    seen.add(id);
    while (queue.length > 0) {
      const current = queue.shift()!;
      component.push(current);
      for (const next of neighbors.get(current) ?? []) {
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    components.push(component);
  }
  components.sort((left, right) =>
    right.length - left.length || sortByLabel(left[0]!, right[0]!));

  // Components stand side by side; inside each, the flow runs DOWN
  // (trigger at the top — the Lindy/Zapier/n8n vertical anatomy).
  let cursorX = ORIGIN_X;
  let maxFlowBottom = ORIGIN_Y;

  for (const component of components) {
    const memberSet = new Set(component);
    const layerById = new Map<string, number>();
    const roots = component.filter((id) =>
      (incoming.get(id) ?? []).every((parent) => !memberSet.has(parent)));
    const startIds = roots.length > 0
      ? roots
      : [component.slice().sort(sortByLabel)[0]!];
    for (const root of startIds) layerById.set(root, 0);
    const cap = component.length + 1;
    let frontier = [...startIds];
    let depth = 0;
    while (frontier.length > 0 && depth < cap) {
      const next: string[] = [];
      for (const id of frontier) {
        const layer = layerById.get(id) ?? 0;
        for (const target of outgoing.get(id) ?? []) {
          if (!memberSet.has(target)) continue;
          const proposed = layer + 1;
          if (proposed > (layerById.get(target) ?? -1) && proposed < cap) {
            layerById.set(target, proposed);
            next.push(target);
          }
        }
      }
      frontier = next;
      depth += 1;
    }
    for (const id of component) {
      if (!layerById.has(id)) layerById.set(id, 0);
    }

    const byLayer = new Map<number, string[]>();
    for (const id of component) {
      const layer = layerById.get(id)!;
      if (!byLayer.has(layer)) byLayer.set(layer, []);
      byLayer.get(layer)!.push(id);
    }
    // Layer 0 (trigger/roots) at the top; deeper layers further down.
    // Siblings inside a layer spread horizontally, centered on the
    // component's widest layer so the flow reads as a centered column.
    const layerWidths = new Map<number, number>();
    for (const [layer, members] of byLayer) {
      layerWidths.set(layer, members.length * SIBLING_GAP_X);
    }
    const componentWidth = Math.max(...layerWidths.values(), SIBLING_GAP_X);
    let componentBottom = ORIGIN_Y;
    for (const [layer, members] of [...byLayer.entries()].sort((a, b) => a[0] - b[0])) {
      members.sort(sortByLabel);
      const layerWidth = members.length * SIBLING_GAP_X;
      const layerStartX = cursorX + (componentWidth - layerWidth) / 2;
      members.forEach((id, index) => {
        out.set(id, frameFromSaved(id) ?? {
          id,
          x: Math.round(layerStartX + index * SIBLING_GAP_X),
          y: ORIGIN_Y + layer * LAYER_GAP_Y,
          width: NODE_WIDTH,
          height: NODE_HEIGHT,
        });
      });
      componentBottom = Math.max(componentBottom, ORIGIN_Y + layer * LAYER_GAP_Y + NODE_HEIGHT);
    }
    maxFlowBottom = Math.max(maxFlowBottom, componentBottom);
    cursorX += componentWidth + COMPONENT_GAP_X;
  }

  // Unconnected actions form a compact library BELOW the flows.
  singles.sort(sortByLabel);
  const libraryColumns = libraryColumnsFor(singles.length);
  const libraryTop = maxFlowBottom + LIBRARY_GAP_Y;
  singles.forEach((id, index) => {
    out.set(id, frameFromSaved(id) ?? {
      id,
      x: ORIGIN_X + (index % libraryColumns) * SIBLING_GAP_X,
      y: libraryTop + Math.floor(index / libraryColumns) * LAYER_GAP_Y,
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
    });
  });

  return ids.map((id) => out.get(id)!).filter(Boolean);
}

// ---------------------------------------------------------------------------
// PROJECTION
// ---------------------------------------------------------------------------

function setEdge(
  edges: Map<string, WorkflowCanvasEdgeDisplay>,
  edge: WorkflowCanvasEdgeDisplay,
): void {
  if (!edges.has(edge.id)) edges.set(edge.id, edge);
}

export interface WorkflowCanvasProjectionOptions {
  /** Filter to one node's reachable neighborhood (a flow). */
  focusId?: string;
  /** Plain-text label filter (case-insensitive substring). */
  query?: string;
  /** Filter to one node kind — a facet value from `nodeKindFacets` (generic;
   *  the projection matches it by equality, never by an enumerated literal). */
  kind?: string;
}

/**
 * Project the decoded feed into renderable frames + display + edges.
 *
 * `focusId` optionally filters to one node's reachable neighborhood (a flow):
 * everything the focus can start, plus everything that can start the focus.
 * `query` further narrows visible nodes by label.
 */
export function projectWorkflowCanvasFeed(
  feed: WorkflowCanvasFeed,
  options: WorkflowCanvasProjectionOptions = {},
): WorkflowCanvasProjection {
  const { query, kind } = options;
  // Search is GLOBAL: typing a query escapes any flow focus — the user is
  // looking for something, not narrowing within the current flow.
  const focusId = query?.trim() ? undefined : options.focusId;
  const labelById = new Map<string, string>();
  for (const def of feed.definitions) labelById.set(def.id, humanizeIdentifier(def.slug));
  for (const trigger of feed.triggers) labelById.set(trigger.id, humanizeIdentifier(trigger.name));
  const kindById = new Map<string, WorkflowCanvasNodeKind>();
  for (const def of feed.definitions) kindById.set(def.id, 'action');
  for (const trigger of feed.triggers) kindById.set(trigger.id, 'trigger');
  const labelFor = (id: string) => labelById.get(id) ?? humanizeIdentifier(id);

  // Filter facets from the FULL feed (independent of the active filter) — the
  // distinct node kinds present, translated to chip labels here so the toolbar
  // never enumerates 'trigger'/'action' itself.
  const nodeKindFacets: { value: string; label: string }[] = [];
  const seenFacetKinds = new Set<string>();
  for (const facetKind of kindById.values()) {
    if (seenFacetKinds.has(facetKind)) continue;
    seenFacetKinds.add(facetKind);
    nodeKindFacets.push({ value: facetKind, label: nodeKindFacetLabel(facetKind) });
  }

  // ---- edges (derived, full graph) ----
  const edgeDisplayById = new Map<string, WorkflowCanvasEdgeDisplay>();
  for (const def of feed.definitions) {
    const called = new Set<string>();
    collectDefinitionIds(def.steps, called);
    called.delete(def.id);
    // Branch pills: when the step running the target sits behind an
    // on_result DAG edge, the canvas edge carries the CONDITION ("if exit
    // code = 0" / "otherwise") instead of the generic "runs" — the Lindy/
    // Zapier Paths anatomy where the WHY lives on the line.
    const branchLabels = branchLabelsForDefinition(def.steps, def.edges);
    for (const targetId of [...called].sort()) {
      if (!labelById.has(targetId)) continue;
      setEdge(edgeDisplayById, {
        id: `edge:${def.id}:${targetId}`,
        sourceId: def.id,
        targetId,
        // The relationship in one word (Zapier/HoneyBook edge-label anatomy):
        // an action edge means "this runs that" — unless a branch condition
        // gates it, in which case the condition IS the label.
        label: branchLabels.get(targetId) ?? 'runs',
      });
    }
  }
  for (const trigger of feed.triggers) {
    const dispatched = new Set<string>();
    collectDefinitionIds(trigger.outputTemplate, dispatched);
    for (const targetId of [...dispatched].sort()) {
      if (!labelById.has(targetId)) continue;
      setEdge(edgeDisplayById, {
        id: `edge:${trigger.id}:${targetId}`,
        sourceId: trigger.id,
        targetId,
        // A trigger edge means "this starts that".
        label: 'starts',
      });
    }
  }
  const nodesByWorkflow = new Map<string, string[]>();
  for (const link of feed.links) {
    if (!labelById.has(link.nodeId)) continue;
    if (!nodesByWorkflow.has(link.workflowId)) nodesByWorkflow.set(link.workflowId, []);
    nodesByWorkflow.get(link.workflowId)!.push(link.nodeId);
  }
  for (const [workflowKey, members] of nodesByWorkflow) {
    members.sort();
    for (let index = 0; index < members.length - 1; index += 1) {
      setEdge(edgeDisplayById, {
        id: `edge:${workflowKey}:${index}`,
        sourceId: members[index]!,
        targetId: members[index + 1]!,
        label: '',
      });
    }
  }

  // ---- focus filter (reachable both directions from focusId) ----
  const allIds = [...labelById.keys()];
  let visibleIds = allIds;
  if (focusId && labelById.has(focusId)) {
    const forwardAdjacency = new Map<string, string[]>();
    const backwardAdjacency = new Map<string, string[]>();
    for (const edge of edgeDisplayById.values()) {
      if (!forwardAdjacency.has(edge.sourceId)) forwardAdjacency.set(edge.sourceId, []);
      forwardAdjacency.get(edge.sourceId)!.push(edge.targetId);
      if (!backwardAdjacency.has(edge.targetId)) backwardAdjacency.set(edge.targetId, []);
      backwardAdjacency.get(edge.targetId)!.push(edge.sourceId);
    }
    const reach = (start: string, adjacency: ReadonlyMap<string, string[]>): Set<string> => {
      const found = new Set<string>([start]);
      const queue = [start];
      while (queue.length > 0) {
        const current = queue.shift()!;
        for (const next of adjacency.get(current) ?? []) {
          if (!found.has(next)) {
            found.add(next);
            queue.push(next);
          }
        }
      }
      return found;
    };
    const visible = new Set([
      ...reach(focusId, forwardAdjacency),
      ...reach(focusId, backwardAdjacency),
    ]);
    visibleIds = allIds.filter((id) => visible.has(id));
  }
  const trimmedQuery = query?.trim().toLowerCase();
  if (trimmedQuery) {
    visibleIds = visibleIds.filter((id) =>
      (labelById.get(id) ?? id).toLowerCase().includes(trimmedQuery));
  }
  if (kind) {
    visibleIds = visibleIds.filter((id) => kindById.get(id) === kind);
  }
  const visibleSet = new Set(visibleIds);

  // ---- node display ----
  const nodeDisplayById = new Map<string, WorkflowCanvasNodeDisplay>();
  for (const def of feed.definitions) {
    if (!visibleSet.has(def.id)) continue;
    const shippedBy = feed.shippedBy.get(def.id) ?? null;
    const stepSummaries = summarizeSteps(def.steps, labelFor);
    nodeDisplayById.set(def.id, {
      id: def.id,
      label: labelFor(def.id),
      kind: 'action',
      enabled: def.isActive,
      description: def.description,
      steps: def.steps,
      edges: def.edges,
      stepSummaries,
      iconName: nodeIconName('action', stepSummaries),
      caption: nodeCaption('action', def.isActive, def.description, stepSummaries),
      runState: def.runState ?? null,
      accentTone: nodeAccentTone('action'),
      hasInPort: true,
      topic: null,
      runsDefinitionIds: [],
      outputTemplate: null,
      shippedBy,
      editable: shippedBy === null,
      isStartEvent: false,
      canChain: shippedBy === null,
      runnable: true,
      workflowId: DEFAULT_WORKFLOW_ID,
    });
  }
  for (const trigger of feed.triggers) {
    if (!visibleSet.has(trigger.id)) continue;
    const triggerDescription = trigger.topic
      ? `Starts when ${humanizeIdentifier(trigger.topic)} happens`
      : null;
    nodeDisplayById.set(trigger.id, {
      id: trigger.id,
      label: labelFor(trigger.id),
      kind: 'trigger',
      enabled: trigger.isActive,
      description: triggerDescription,
      steps: [],
      edges: [],
      stepSummaries: [],
      iconName: nodeIconName('trigger', []),
      caption: nodeCaption('trigger', trigger.isActive, triggerDescription, []),
      runState: null,
      accentTone: nodeAccentTone('trigger'),
      hasInPort: false,
      topic: trigger.topic,
      runsDefinitionIds: (() => {
        const dispatched = new Set<string>();
        collectDefinitionIds(trigger.outputTemplate, dispatched);
        return [...dispatched].filter((id) => labelById.has(id)).sort();
      })(),
      outputTemplate: trigger.outputTemplate,
      shippedBy: null,
      editable: false,
      isStartEvent: true,
      canChain: false,
      runnable: false,
      workflowId: DEFAULT_WORKFLOW_ID,
    });
  }

  // ---- visible edges only ----
  const visibleEdges = new Map<string, WorkflowCanvasEdgeDisplay>();
  for (const edge of edgeDisplayById.values()) {
    if (visibleSet.has(edge.sourceId) && visibleSet.has(edge.targetId)) {
      visibleEdges.set(edge.id, edge);
    }
  }

  // ---- frames (saved layout wins; otherwise deterministic layered layout) ----
  const savedLayoutById = new Map<string, Record<string, unknown>>();
  for (const def of feed.definitions) {
    if (def.layout) savedLayoutById.set(def.id, def.layout);
  }
  for (const trigger of feed.triggers) {
    if (trigger.layout) savedLayoutById.set(trigger.id, trigger.layout);
  }
  const orderedVisible = visibleIds.filter((id) => nodeDisplayById.has(id));
  const feedFrames = computeFrames({
    ids: orderedVisible,
    edges: visibleEdges,
    savedLayoutById,
    labelById,
  });

  // ---- flows (trigger roots → reachable members) for wayfinding rails ----
  const forwardAll = new Map<string, string[]>();
  for (const edge of edgeDisplayById.values()) {
    if (!forwardAll.has(edge.sourceId)) forwardAll.set(edge.sourceId, []);
    forwardAll.get(edge.sourceId)!.push(edge.targetId);
  }
  const flows: WorkflowCanvasFlow[] = feed.triggers
    .slice()
    .sort((a, b) => labelFor(a.id).localeCompare(labelFor(b.id)))
    .map((trigger) => {
      const members = new Set<string>([trigger.id]);
      const queue = [trigger.id];
      while (queue.length > 0) {
        const current = queue.shift()!;
        for (const next of forwardAll.get(current) ?? []) {
          if (!members.has(next)) {
            members.add(next);
            queue.push(next);
          }
        }
      }
      return {
        id: `flow:${trigger.id}`,
        label: labelFor(trigger.id),
        rootId: trigger.id,
        memberIds: [...members],
      };
    })
    .filter((flow) => flow.memberIds.length > 1);

  return { feedFrames, nodeDisplayById, edgeDisplayById: visibleEdges, flows, nodeKindFacets };
}
