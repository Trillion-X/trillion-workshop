// packages/workflow-canvas/show/NodeInspector.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The behavior-first inspector for one selected canvas node. It answers, in
// plain language: What is this? What starts it? What does it run, step by
// step? — and lets the user change the work, pause/resume it, run it now,
// and read the real run report.
//
// Editing speaks the engine's REAL step vocabulary (ask / write / read /
// return / action / loop / wait — open registry, custom kinds pass through
// honestly as advanced steps). There is no fictional vocabulary here: no
// "switch" step (branching is edge conditions), no "listen" step (starting
// is a trigger record).
//
// Shipped actions (rank-1 package ownership) are shown honestly as shipped
// and offer "Make my copy" instead of a lying edit.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. ui primitives + tokens only; inline style limited to geometry.
// 2. Plain visible copy — engine words (definition, slot, binding) never
//    appear in product copy.
// 3. Steps are edited by identity: untouched steps pass through byte-equal.
// 4. The inspector renders display data and emits edit/run intents — the
//    do-work layer owns request building; owners own the work.
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ChevronDown as ChevronDownIcon,
  ChevronRight as ChevronRightIcon,
  Copy as CopyIcon,
  PenLine as PenLineIcon,
  Play as PlayIcon,
  Plus as PlusIcon,
  Trash2 as TrashIcon,
  X as CloseIcon,
} from 'lucide-react';
import {
  Button,
  Card,
  Container,
  Dropdown,
  ExpandableTabs,
  Icon,
  Input,
  StatusDot,
  StructuredValueEditor,
  Text,
  Textarea,
} from '../../ui';
import { InspectorHeader } from './InspectorHeader';
import { type NodeMenuAction } from './NodeActionMenu';
import { DELETE_SELECTED_NODE_SHORTCUT } from './canvas-shortcuts';
import {
  describeBinding,
  humanizeIdentifier,
  summarizeSteps,
} from '../read-data/read-workflow-canvas-layout';
import {
  describeStepFields,
  emptyStepOfKind,
  stepKindCatalog,
  type DescribeStepCtx,
} from '../read-data/describe-step-fields';
import {
  StepFieldRenderer,
  type StepFieldExample,
} from './StepFieldRenderer';
import type { CanvasNode } from './workflow-canvas-types';
import type { WorkflowRunResult } from '../do-work/run-workflow-canvas-definition';
import type { WorkflowRunReceiptRow } from '../do-work/list-workflow-canvas-runs';
import {
  NextStepCatalog,
  type NextStepWorkCapability,
} from './NextStepPopover';

// ---------------------------------------------------------------------------
// DRAFT MODEL
// ---------------------------------------------------------------------------

export interface SelectedActionDraft {
  id: string;
  /** Display name — editable in place; the id stays stable on rename. */
  name: string;
  enabled: boolean;
  description: string;
  steps: readonly unknown[];
  /** Step-DAG edges — branching IS edge conditions in this engine. */
  edges: readonly unknown[];
}

interface NodeInspectorProps {
  node: CanvasNode | null;
  availableActions?: readonly CanvasNode[];
  /** Outside-work targets the system already uses — click to choose. */
  workTargets?: readonly string[];
  /** Full mined capability surface with real example payloads (preferred). */
  workCapabilities?: readonly NextStepWorkCapability[];
  onClose: () => void;
  onSave?: (draft: SelectedActionDraft) => void | Promise<void>;
  onRun?: (definitionId: string) => Promise<WorkflowRunResult>;
  onNavigate?: (nodeId: string) => void;
  onFork?: (node: CanvasNode) => void | Promise<void>;
  /** Remove a canvas-owned action entirely (only offered when editable). */
  onDelete?: (node: CanvasNode) => void | Promise<void>;
  /** Load the durable run trail for a definition (newest first). */
  onListRuns?: (definitionId: string) => Promise<WorkflowRunReceiptRow[]>;
  /**
   * Monotonic rename signal: each bump opens the click-to-edit title editor
   * (the canvas context menu's Rename lands here). 0 = no request.
   */
  renameRequestId?: number;
  /**
   * Individual fields the dispatching trigger sends to this action (Lindy's
   * per-field inject list). Derived by the canvas from trigger output
   * templates; plumbing fields already filtered.
   */
  inputFields?: readonly { key: string; label: string }[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Translation hook for StructuredValueEditor: engine binding ASTs render as
 * ONE plain sentence ("Uses Prompt Text from what was sent in") instead of
 * $kind/Select/From/Path internals (L114/L118). Everything else keeps the
 * editor's default field anatomy.
 */
function renderWorkflowValue(value: unknown, label: string | null): React.ReactNode | null {
  const sentence = describeBinding(value);
  if (sentence) {
    return (
      <Container layout="vertical" gap="xs" data-workflow-binding-sentence="true">
        {label && <Text variant="caption" color="muted">{label}</Text>}
        <Text variant="caption">{sentence}</Text>
      </Container>
    );
  }
  // Transform op rows (`{op: "op:core.concat", args: …}`) read as one plain
  // verb instead of an op-id field row.
  if (isRecord(value) && typeof value.op === 'string' && value.op.startsWith('op:')) {
    const verb = humanizeIdentifier(value.op.replace(/^op:[a-z]+\./, ''));
    return (
      <Container layout="vertical" gap="xs" data-workflow-binding-sentence="true">
        {label && <Text variant="caption" color="muted">{label}</Text>}
        <Text variant="caption">Then: {verb}</Text>
      </Container>
    );
  }
  // Raw definition ids read as the action's human name ("Runs Publish
  // Composer Materialize Draft"), never `action:…` (L118).
  if (typeof value === 'string' && /^(action|trigger|workflow):/.test(value)) {
    return (
      <Container layout="vertical" gap="xs" data-workflow-binding-sentence="true">
        {label && <Text variant="caption" color="muted">{label === 'Definition Id' ? 'Runs' : label}</Text>}
        <Text variant="caption">{humanizeIdentifier(value)}</Text>
      </Container>
    );
  }
  return null;
}

function readText(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function draftFromNode(node: CanvasNode | null): SelectedActionDraft {
  return {
    id: node?.id ?? '',
    name: node?.label ?? '',
    enabled: node?.data.enabled ?? true,
    description: node?.data.description ?? '',
    steps: node?.data.steps ?? [],
    edges: node?.data.edges ?? [],
  };
}

/**
 * Every step needs a stable id before edges can point at it. Existing ids are
 * preserved; missing ids get positional ones. Identity rule: if nothing needed
 * an id, the array is returned untouched.
 */
function withStepIds(steps: readonly unknown[]): readonly unknown[] {
  if (steps.every((step) => isRecord(step) && readText(step.id))) return steps;
  return steps.map((step, index) => {
    if (isRecord(step) && readText(step.id)) return step;
    return { ...(isRecord(step) ? step : { kind: 'custom', config: step }), id: `step_${index}` };
  });
}

function stepIdOf(step: unknown, index: number): string {
  return (isRecord(step) && readText(step.id)) || `step_${index}`;
}

// ---------------------------------------------------------------------------
// STEP EDITING — the engine's real, open vocabulary
// ---------------------------------------------------------------------------

// Step kinds + labels (add-step menu) and empty shapes (factory) live in
// read-data/describe-step-fields — the step-kind SSOT. Read via stepKindCatalog()
// + emptyStepOfKind().

function stepConfigOf(step: unknown): Record<string, unknown> {
  return isRecord(step) && isRecord(step.config) ? step.config : {};
}

interface ActionOption {
  value: string;
  label: string;
}

interface StepEditorProps {
  step: unknown;
  actionOptions: readonly ActionOption[];
  workTargetOptions: readonly ActionOption[];
  /** Mined capability surface — example payloads prefill on target change. */
  workCapabilities?: readonly NextStepWorkCapability[];
  /** Earlier steps in this action, as data sources for the picker. */
  priorSteps?: readonly { stepId: string; sentence: string }[];
  /** Individual fields of what the trigger sends in (Lindy's field list). */
  inputFields?: readonly { key: string; label: string }[];
  onChange: (step: unknown) => void;
}

/**
 * Build the step-field translation ctx from the live option surfaces. Shared by
 * the editor and the read-only detail so both speak the same descriptors.
 */
function buildStepCtx(
  actionOptions: readonly ActionOption[],
  workTargetOptions: readonly ActionOption[],
  workCapabilities: readonly NextStepWorkCapability[],
): DescribeStepCtx {
  return {
    actions: actionOptions,
    workTargets: workTargetOptions.map((option) => {
      const capability = workCapabilities.find((entry) => entry.target === option.value);
      if (!capability) return option;
      return {
        ...option,
        examplePayload: isRecord(capability.examplePayload) ? capability.examplePayload : undefined,
        payloadKeys: capability.payloadKeys,
      };
    }),
  };
}

/**
 * The step editor: a BLIND field stack. read-data's describeStepFields maps
 * the step's engine kind + config into self-describing descriptors; the
 * generic StepFieldRenderer paints them. No step-kind branch lives here
 * (L090 / enum dissolution) — the inject + wait-duration controls now live
 * in their own files, composed by the renderer.
 */
function StepEditor({
  step,
  actionOptions,
  workTargetOptions,
  workCapabilities = [],
  priorSteps = [],
  inputFields = [],
  onChange,
}: StepEditorProps): React.ReactElement {
  // Build the translation ctx from the live option surfaces; describeStepFields
  // (read-data) maps the step into self-describing descriptors that the blind
  // StepFieldRenderer paints. No step-kind branch lives here (L090).
  const descriptors = describeStepFields(step, buildStepCtx(actionOptions, workTargetOptions, workCapabilities));
  // Cross-field working example for an injectable structured field, resolved
  // from the step's current target capability (the renderer stays blind).
  const exampleFor = (candidate: unknown): StepFieldExample | null => {
    const name = readText(stepConfigOf(candidate).name);
    const capability = workCapabilities.find((entry) => entry.target === name);
    if (!capability) return null;
    return {
      payload: isRecord(capability.examplePayload) ? capability.examplePayload : {},
      keys: capability.payloadKeys,
    };
  };
  return (
    <StepFieldRenderer
      step={step}
      descriptors={descriptors}
      onChange={onChange}
      priorSteps={priorSteps}
      inputFields={inputFields}
      renderValue={renderWorkflowValue}
      exampleFor={exampleFor}
    />
  );
}

// ---------------------------------------------------------------------------
// STEP DETAIL (read-only) — the full nitty-gritty of one step, in plain
// labeled field rows (the same anatomy n8n/Retool use for parameters).
// Every node, shipped or yours, shows exactly what each step does: who is
// asked, what is sent, which records are written. Never a raw JSON dump.
// ---------------------------------------------------------------------------

function StepDetail({
  step,
  actionOptions,
  workTargetOptions,
  workCapabilities,
}: {
  step: unknown;
  actionOptions: readonly ActionOption[];
  workTargetOptions: readonly ActionOption[];
  workCapabilities: readonly NextStepWorkCapability[];
}): React.ReactElement {
  // The SAME describeStepFields translation as the editor, rendered read-only —
  // one blind renderer, two modes (L069). No step-kind branch here either; the
  // shipped detail view stays consistent with the editable field stack.
  const descriptors = describeStepFields(step, buildStepCtx(actionOptions, workTargetOptions, workCapabilities));
  return (
    <StepFieldRenderer
      step={step}
      descriptors={descriptors}
      onChange={() => {}}
      readOnly
      renderValue={renderWorkflowValue}
      formatId={humanizeIdentifier}
    />
  );
}

// ---------------------------------------------------------------------------
// PATHS (the engine's real branching: edges with conditions between steps).
// "If" and "otherwise" are edges — n8n's IF outputs and Zapier's paths are
// this exact shape. An edge is `{from, to, kind: "always" | "on_result",
// config: <condition binding>}`.
// ---------------------------------------------------------------------------

interface PathRow {
  from: string;
  to: string;
  kind: string;
  conditionPath: string | null;
  conditionValue: string | null;
}

function decodeEdge(edge: unknown): PathRow | null {
  if (!isRecord(edge)) return null;
  const from = readText(edge.from);
  const to = readText(edge.to);
  if (!from || !to) return null;
  const kind = readText(edge.kind) || 'always';
  let conditionPath: string | null = null;
  let conditionValue: string | null = null;
  if (isRecord(edge.config) && isRecord(edge.config.select)) {
    const path = readText(edge.config.select.path);
    conditionPath = path ? path.replace(/^output\.?/, '') || 'result' : null;
    const transforms = Array.isArray(edge.config.transform) ? edge.config.transform : [];
    for (const transform of transforms) {
      if (isRecord(transform) && readText(transform.op) === 'op:core.equals' && isRecord(transform.args)) {
        // Strings read bare ("completed"), structures read as JSON — no
        // quote noise in the human row.
        const value = transform.args.value;
        conditionValue = typeof value === 'string' ? value : JSON.stringify(value);
      }
    }
  }
  return { from, to, kind, conditionPath, conditionValue };
}

function buildConditionEdge(
  fromId: string,
  toId: string,
  conditionPath: string,
  conditionValueText: string,
): unknown {
  let value: unknown = conditionValueText;
  try {
    value = JSON.parse(conditionValueText) as unknown;
  } catch {
    // Plain text compares as a string.
  }
  const path = conditionPath.trim();
  return {
    from: fromId,
    to: toId,
    kind: 'on_result',
    config: {
      $kind: 'binding',
      select: { from: 'steps', key: fromId, path: path ? `output.${path}` : 'output' },
      transform: [{ op: 'op:core.equals', args: { value } }],
    },
  };
}

interface PathsSectionProps {
  steps: readonly unknown[];
  edges: readonly unknown[];
  summaries: readonly { sentence: string }[];
  editable: boolean;
  onChange: (edges: readonly unknown[]) => void;
}

function PathsSection({ steps, edges, summaries, editable, onChange }: PathsSectionProps): React.ReactElement | null {
  const [isAdding, setIsAdding] = useState(false);
  const [fromId, setFromId] = useState('');
  const [toId, setToId] = useState('');
  const [edgeKind, setEdgeKind] = useState<'always' | 'on_result'>('on_result');
  const [conditionPath, setConditionPath] = useState('');
  const [conditionValue, setConditionValue] = useState('');

  const stepItems = useMemo(
    () => steps.map((step, index) => ({
      value: stepIdOf(step, index),
      label: `${index + 1}. ${summaries[index]?.sentence ?? 'Step'}`,
    })),
    [steps, summaries],
  );
  const labelForStep = useCallback((id: string) => {
    const found = stepItems.find((item) => item.value === id);
    return found?.label ?? id;
  }, [stepItems]);

  const rows = useMemo(
    () => edges.map((edge, index) => ({ edge, row: decodeEdge(edge), index })),
    [edges],
  );

  if (!editable && rows.length === 0) return null;
  if (steps.length < 2 && rows.length === 0) return null;

  // Lindy's branch ledger reads each path as one sentence; the condition is
  // the headline, the route is the quiet second line.
  return (
    <Container layout="vertical" gap="sm" data-workflow-paths-section="true">
      <Text variant="caption" color="muted">
        {rows.length === 0 ? 'Branches' : rows.length === 1 ? '1 branch' : `${rows.length} branches`}
      </Text>

      {rows.map(({ row, index }) => row && (
        <Card key={index} variant="nested" padding="sm" data-workflow-branch-row="true">
          <Container layout="horizontal" gap="xs" alignItems="center">
            <Container layout="vertical" gap="xs" flex={1} style={{ minWidth: 0 }}>
              <Text variant="body-xs" weight="medium" truncate>
                {row.kind === 'on_result' && row.conditionPath
                  ? `If ${row.conditionPath.replace(/[_.]+/g, ' ')} is ${row.conditionValue ?? '…'}`
                  : 'Otherwise'}
              </Text>
              <Text variant="caption" color="muted" truncate>
                {labelForStep(row.from)} → {labelForStep(row.to)}
              </Text>
            </Container>
            {editable && (
              <Button
                variant="ghost"
                size="sm"
                aria-label="Remove branch"
                onClick={() => onChange(edges.filter((_, edgeIndex) => edgeIndex !== index))}
              >
                <Icon icon={TrashIcon} size="xs" />
              </Button>
            )}
          </Container>
        </Card>
      ))}

      {editable && !isAdding && steps.length >= 2 && (
        <Button variant="ghost" size="sm" data-workflow-add-branch="true" onClick={() => {
          setFromId(stepItems[0]?.value ?? '');
          setToId(stepItems[1]?.value ?? '');
          setIsAdding(true);
        }}>
          <Container layout="horizontal" gap="sm" alignItems="center">
            <Icon icon={PlusIcon} size="xs" color="secondary" />
            <Text variant="body-xs">Add a branch</Text>
          </Container>
        </Button>
      )}

      {editable && isAdding && (
        <Card variant="nested" padding="sm" data-workflow-branch-editor="true">
          <Container layout="vertical" gap="sm">
            <Dropdown
              label="After this step"
              items={stepItems}
              value={fromId}
              onValueChange={setFromId}
              scrollable
            />
            <Dropdown
              label="Go to"
              items={stepItems.filter((item) => item.value !== fromId)}
              value={toId}
              onValueChange={setToId}
              scrollable
            />
            <Dropdown
              label="When"
              items={[
                { value: 'on_result', label: 'Go down this path if…' },
                { value: 'always', label: 'Otherwise (always continue)' },
              ]}
              value={edgeKind}
              onValueChange={(kind) => setEdgeKind(kind === 'always' ? 'always' : 'on_result')}
            />
            {edgeKind === 'on_result' && (
              <Container layout="horizontal" gap="sm">
                <Container flex={1} style={{ minWidth: 0 }}>
                  <Input
                    label="The result's…"
                    placeholder="status"
                    value={conditionPath}
                    onChange={(event) => setConditionPath(event.target.value)}
                  />
                </Container>
                <Container flex={1} style={{ minWidth: 0 }}>
                  <Input
                    label="…is"
                    placeholder="completed"
                    value={conditionValue}
                    onChange={(event) => setConditionValue(event.target.value)}
                  />
                </Container>
              </Container>
            )}
            <Container layout="horizontal" gap="sm" justifyContent="end">
              <Button variant="ghost" size="sm" onClick={() => setIsAdding(false)}>
                Close
              </Button>
              <Button
                variant="primary"
                size="sm"
                disabled={!fromId || !toId || (edgeKind === 'on_result' && !conditionValue.trim())}
                onClick={() => {
                  const edge = edgeKind === 'always'
                    ? { from: fromId, to: toId, kind: 'always', config: null }
                    : buildConditionEdge(fromId, toId, conditionPath, conditionValue.trim());
                  onChange([...edges, edge]);
                  setIsAdding(false);
                  setConditionPath('');
                  setConditionValue('');
                }}
              >
                Add branch
              </Button>
            </Container>
          </Container>
        </Card>
      )}
    </Container>
  );
}

// ---------------------------------------------------------------------------
// RUN REPORT
// ---------------------------------------------------------------------------

function runStatusDot(status: string): 'success' | 'error' | 'info' | 'idle' {
  if (status === 'completed') return 'success';
  if (status === 'failed') return 'error';
  if (status === 'running') return 'info';
  return 'idle';
}

/**
 * One run-report step row: status, name, duration — and the step's REAL
 * output payload behind a disclosure (n8n's per-step OUTPUT panel anatomy).
 */
function RunReportStep({ step, label, maxDurationMs = 0 }: {
  step: WorkflowRunResult['steps'][number];
  /** The step's plain sentence ("Asks Find Current Items…") — never step_N. */
  label?: string;
  /** Slowest step in this run — scales the duration bar (timeline anatomy). */
  maxDurationMs?: number;
}): React.ReactElement {
  const [showOutput, setShowOutput] = useState(false);
  const hasOutput = step.output !== null && step.output !== undefined;
  // Run-details timeline (StackAI/n8n): a quiet bar under each row shows
  // where the time went, scaled to the run's slowest step. Min 2% so even
  // instant steps read as "ran".
  const barFraction = maxDurationMs > 0
    ? Math.max(0.02, Math.min(1, step.durationMs / maxDurationMs))
    : 0;
  return (
    <Container layout="vertical" gap="xs">
      <Container layout="horizontal" gap="sm" alignItems="center">
        <StatusDot status={runStatusDot(step.status)} size="sm" />
        <Container flex={1} style={{ minWidth: 0 }}>
          <Text variant="caption" color="muted" truncate title={label ?? step.stepId}>
            {label ?? humanizeIdentifier(step.stepId)}
          </Text>
        </Container>
        <Text variant="caption" color="muted">
          {step.durationMs} ms
        </Text>
        {hasOutput && (
          <Button
            variant="ghost"
            size="sm"
            aria-label={showOutput ? 'Hide result' : 'View result'}
            onClick={() => setShowOutput((current) => !current)}
          >
            <Icon icon={showOutput ? ChevronDownIcon : ChevronRightIcon} size="xs" />
          </Button>
        )}
      </Container>
      {barFraction > 0 && (
        <Container
          aria-hidden="true"
          data-workflow-step-duration-bar="true"
          style={{
            height: '3px',
            borderRadius: '2px',
            backgroundColor: 'var(--glass-bg-secondary)',
            overflow: 'hidden',
          }}
        >
          <Container
            style={{
              width: `${Math.round(barFraction * 100)}%`,
              height: '100%',
              borderRadius: '2px',
              backgroundColor: step.status === 'failed'
                ? 'var(--status-error, #e5484d)'
                : 'var(--accent-primary)',
              opacity: 0.55,
            }}
          />
        </Container>
      )}
      {step.error && (
        <Text variant="caption" color="error" title={step.error}>
          {step.error}
        </Text>
      )}
      {showOutput && hasOutput && (
        <Card variant="nested" padding="sm" data-workflow-step-output="true">
          <StructuredValueEditor value={step.output} readOnly maxDepth={6} />
        </Card>
      )}
    </Container>
  );
}

/**
 * Resolve a run step's display label from the draft's step summaries:
 * `step_3` → index 3 → that step's plain sentence. Unmatched ids fall back
 * to the humanized id (loop/nested ids the canvas didn't author).
 */
function runStepLabel(
  stepId: string,
  summaries: readonly { sentence: string }[],
): string | undefined {
  const match = /^step_(\d+)$/.exec(stepId);
  if (!match) return undefined;
  return summaries[Number(match[1])]?.sentence;
}

/**
 * Lindy's "what this trigger sends" anatomy: the trigger's real dispatch
 * payload behind one disclosure — labeled field rows via the same
 * translation hook the rest of the inspector uses, never a JSON dump.
 */
/**
 * Transport plumbing fields in a dispatch template. These tell the engine HOW
 * to deliver (operation verb, reply-shaping booleans) — they are not part of
 * what the trigger MEANS, so the human payload view drops them (L118). The
 * step `definition_id` stays: it translates to "Runs <Name>".
 */
const DISPATCH_PLUMBING_FIELDS = new Set(['operation', 'include_steps', 'include_output', 'user_id']);

export function humanTriggerPayload(template: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(template).filter(([key]) => !DISPATCH_PLUMBING_FIELDS.has(key)),
  );
}

function TriggerPayloadDisclosure({ template }: {
  template: Record<string, unknown>;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const humanPayload = useMemo(() => humanTriggerPayload(template), [template]);
  return (
    <Container layout="vertical" gap="xs" data-workflow-trigger-payload="true">
      <Button variant="ghost" size="sm" onClick={() => setOpen((current) => !current)}>
        <Container layout="horizontal" gap="sm" alignItems="center" width="full">
          <Icon icon={open ? ChevronDownIcon : ChevronRightIcon} size="xs" color="muted" />
          <Container flex={1} style={{ minWidth: 0, textAlign: 'left' }}>
            <Text variant="body-xs">What it sends</Text>
          </Container>
        </Container>
      </Button>
      {open && (
        <Card variant="nested" padding="sm">
          <StructuredValueEditor
            value={humanPayload}
            readOnly
            renderValue={renderWorkflowValue}
            maxDepth={6}
          />
        </Card>
      )}
    </Container>
  );
}

/**
 * Lindy's "Last Run" vocabulary: relative plain words ("about 4 hours ago"),
 * falling back to the date for anything older than a week. The exact stamp
 * stays reachable as the row title.
 */
function relativeRunTime(startedAtMs: number): string {
  const elapsed = Date.now() - startedAtMs;
  if (elapsed < 60_000) return 'just now';
  const minutes = Math.round(elapsed / 60_000);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours === 1 ? 'about an hour ago' : `about ${hours} hours ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return days === 1 ? 'yesterday' : `${days} days ago`;
  return new Date(startedAtMs).toLocaleDateString();
}

/**
 * n8n's Executions anatomy, scoped to one definition: a "Past runs"
 * disclosure that loads the owner's durable receipts on open — status dot,
 * when it ran, how long it took, what it wrote. Honest empty state.
 */
function PastRunsSection({ definitionId, onListRuns }: {
  definitionId: string;
  onListRuns: (definitionId: string) => Promise<WorkflowRunReceiptRow[]>;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<WorkflowRunReceiptRow[] | null>(null);
  const [loading, setLoading] = useState(false);

  const toggle = useCallback(async () => {
    const next = !open;
    setOpen(next);
    if (next && rows === null && !loading) {
      setLoading(true);
      try {
        setRows(await onListRuns(definitionId));
      } catch {
        setRows([]);
      } finally {
        setLoading(false);
      }
    }
  }, [open, rows, loading, definitionId, onListRuns]);

  return (
    <Container layout="vertical" gap="xs" data-workflow-past-runs="true">
      <Button variant="ghost" size="sm" onClick={toggle}>
        <Container layout="horizontal" gap="sm" alignItems="center" width="full">
          <Icon icon={open ? ChevronDownIcon : ChevronRightIcon} size="xs" color="muted" />
          <Container flex={1} style={{ minWidth: 0, textAlign: 'left' }}>
            <Text variant="body-xs">Past runs</Text>
          </Container>
        </Container>
      </Button>
      {open && (
        <Card variant="nested" padding="sm">
          <Container layout="vertical" gap="xs">
            {loading && <Text variant="caption" color="muted">Loading…</Text>}
            {!loading && rows !== null && rows.length === 0 && (
              <Text variant="caption" color="muted">No runs recorded yet — Run now writes one.</Text>
            )}
            {!loading && rows?.map((row, index) => (
              <Container key={`${row.startedAtMs ?? 'run'}-${index}`} layout="horizontal" gap="sm" alignItems="center">
                <StatusDot status={runStatusDot(row.status)} size="sm" />
                <Container flex={1} style={{ minWidth: 0 }}>
                  <Text
                    variant="caption"
                    color="muted"
                    truncate
                    title={row.startedAtMs ? new Date(row.startedAtMs).toLocaleString() : undefined}
                  >
                    {row.startedAtMs ? relativeRunTime(row.startedAtMs) : 'Earlier'}
                  </Text>
                </Container>
                {row.writeCount > 0 && (
                  <Text variant="caption" color="muted">{row.writeCount} written</Text>
                )}
                <Text variant="caption" color="muted">{row.durationMs} ms</Text>
              </Container>
            ))}
          </Container>
        </Card>
      )}
    </Container>
  );
}

function RunReport({ result, summaries = [] }: {
  result: WorkflowRunResult;
  summaries?: readonly { sentence: string }[];
}): React.ReactElement {
  const [showFinalOutput, setShowFinalOutput] = useState(false);
  const hasFinalOutput = result.output !== null && result.output !== undefined;
  return (
    <Card variant="nested" padding="sm" data-workflow-run-report="true">
      <Container layout="vertical" gap="xs">
        <Container layout="horizontal" gap="sm" alignItems="center">
          <StatusDot status={runStatusDot(result.status)} size="md" />
          <Container flex={1} style={{ minWidth: 0 }}>
            <Text variant="body-xs" weight="semibold">
              {result.status === 'completed'
                ? `Ran in ${result.durationMs} ms`
                : result.status === 'failed'
                  ? 'Run failed'
                  : `Run ${result.status}`}
            </Text>
          </Container>
          {hasFinalOutput && (
            <Button variant="ghost" size="sm" onClick={() => setShowFinalOutput((current) => !current)}>
              {showFinalOutput ? 'Hide result' : 'View result'}
            </Button>
          )}
        </Container>
        {result.error && (
          <Text variant="caption" color="error">
            {result.error}
          </Text>
        )}
        {showFinalOutput && hasFinalOutput && (
          <Card variant="nested" padding="sm" data-workflow-run-output="true">
            <StructuredValueEditor value={result.output} readOnly maxDepth={6} />
          </Card>
        )}
        {result.steps.map((step) => (
          <RunReportStep
            key={step.stepId}
            step={step}
            label={runStepLabel(step.stepId, summaries)}
            maxDurationMs={Math.max(...result.steps.map((candidate) => candidate.durationMs), 0)}
          />
        ))}
      </Container>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// INSPECTOR
// ---------------------------------------------------------------------------

export const NodeInspector: React.FC<NodeInspectorProps> = ({
  node,
  availableActions = [],
  workTargets = [],
  workCapabilities,
  onClose,
  onSave,
  onRun,
  onNavigate,
  onFork,
  onDelete,
  onListRuns,
  renameRequestId = 0,
  inputFields = [],
}) => {
  const [draft, setDraft] = useState<SelectedActionDraft>(() => draftFromNode(node));
  const [renamingTitle, setRenamingTitle] = useState(false);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [runResult, setRunResult] = useState<WorkflowRunResult | null>(null);
  const [expandedSteps, setExpandedSteps] = useState<ReadonlySet<number>>(new Set());
  const [addingStep, setAddingStep] = useState(false);

  useEffect(() => {
    setDraft(draftFromNode(node));
    setSaveError('');
  }, [node]);
  // What the person did with this card (a run's report, open steps, an editor) stays while the same card is read
  // again (a run just started reads the map again); choosing another card starts it over.
  const nodeId = node?.id ?? null;
  useEffect(() => {
    setRunResult(null);
    setExpandedSteps(new Set());
    setAddingStep(false);
    setRenamingTitle(false);
  }, [nodeId]);

  // Context-menu Rename: each bump opens the title editor for the (already
  // selected) node. Runs after the node-reset effect above, so it wins.
  useEffect(() => {
    if (renameRequestId > 0 && node?.data.editable) setRenamingTitle(true);
  }, [renameRequestId, node]);

  const toggleStepExpanded = useCallback((index: number) => {
    setExpandedSteps((previous) => {
      const next = new Set(previous);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }, []);

  const actionOptions = useMemo(
    () => availableActions
      .filter((candidate) => candidate.id !== node?.id && candidate.data.runnable)
      .map((candidate) => ({ value: candidate.id, label: candidate.label }))
      .sort((left, right) => left.label.localeCompare(right.label)),
    [availableActions, node],
  );

  const workTargetOptions = useMemo(
    () => workTargets.map((target) => ({
      value: target,
      label: target.replace(/^slot::/, '').split(/[-_.]/).map(
        (part) => part.charAt(0).toUpperCase() + part.slice(1),
      ).join(' '),
    })),
    [workTargets],
  );

  const labelFor = useCallback((id: string) => {
    const found = availableActions.find((candidate) => candidate.id === id);
    return found?.label ?? humanizeIdentifier(id);
  }, [availableActions]);

  const summaries = useMemo(
    () => summarizeSteps(draft.steps, labelFor),
    [draft.steps, labelFor],
  );

  const referencedIds = useMemo(() => {
    const ids = new Set<string>();
    for (const summary of summaries) {
      for (const id of summary.referencedDefinitionIds) ids.add(id);
    }
    if (node) ids.delete(node.id);
    return [...ids].sort((a, b) => labelFor(a).localeCompare(labelFor(b)));
  }, [summaries, node, labelFor]);

  const replaceStep = useCallback((index: number, nextStep: unknown) => {
    setDraft((current) => ({
      ...current,
      steps: current.steps.map((step, stepIndex) => (stepIndex === index ? nextStep : step)),
    }));
  }, []);

  const removeStep = useCallback((index: number) => {
    setDraft((current) => ({
      ...current,
      steps: current.steps.filter((_, stepIndex) => stepIndex !== index),
    }));
  }, []);

  const moveStep = useCallback((index: number, delta: number) => {
    setDraft((current) => {
      const steps = [...current.steps];
      const target = index + delta;
      if (target < 0 || target >= steps.length) return current;
      const [moved] = steps.splice(index, 1);
      steps.splice(target, 0, moved!);
      return { ...current, steps };
    });
  }, []);

  const addStep = useCallback((kind: string) => {
    setDraft((current) => ({
      ...current,
      steps: [...current.steps, emptyStepOfKind(kind, actionOptions[0]?.value ?? '')],
    }));
  }, [actionOptions]);

  /**
   * Append a fully-formed step picked from the capability catalog (the same
   * catalog the canvas + popover uses — one source of "what can run next").
   * The new step opens expanded so its fields are immediately editable.
   */
  const appendPickedStep = useCallback((step: unknown) => {
    setDraft((current) => {
      const nextIndex = current.steps.length;
      setExpandedSteps((previous) => new Set([...previous, nextIndex]));
      return { ...current, steps: [...current.steps, step] };
    });
    setAddingStep(false);
  }, []);

  /** Catalog rows: every OTHER runnable action, in the catalog's shape. */
  const catalogActionOptions = useMemo(
    () => actionOptions.map((option) => ({ id: option.value, label: option.label })),
    [actionOptions],
  );

  const handleSave = useCallback(async () => {
    if (!onSave) return;
    setSaving(true);
    setSaveError('');
    try {
      await onSave(draft);
    } catch (error) {
      console.error("[workflow-canvas] save failed:", error); setSaveError("Save failed");
    } finally {
      setSaving(false);
    }
  }, [draft, onSave]);

  const handleRun = useCallback(async () => {
    if (!onRun || !node) return;
    setRunning(true);
    setRunResult(null);
    try {
      setRunResult(await onRun(node.id));
    } catch (error) {
      setRunResult({
        definitionId: node.id,
        status: 'failed',
        durationMs: 0,
        output: null,
        steps: [],
        error: "Node update failed",
      });
    } finally {
      setRunning(false);
    }
  }, [node, onRun]);

  if (!node) return null;
  const display = node.data;
  // Capability flag, never the kind word (L090): read-data tells us this node
  // starts work on its own; the inspector lays out the start-event sections.
  const isTrigger = display.isStartEvent;
  const editable = display.editable && !isTrigger;
  const triggerRuns = isTrigger ? display.runsDefinitionIds ?? [] : [];

  // Per-node overflow actions for the header "…" menu. The header is blind — it
  // renders whatever self-describing rows we hand it (L090). Only the user's own
  // actions get Rename/Delete; shipped nodes keep their explicit "Make my copy"
  // call-to-action in the body rather than a near-empty menu.
  const menuActions: readonly NodeMenuAction[] = editable
    ? [
        { id: 'rename', label: 'Rename', icon: PenLineIcon, onSelect: () => setRenamingTitle(true) },
        ...(onDelete
          ? [
              {
                id: 'delete',
                label: 'Delete',
                icon: TrashIcon,
                danger: true,
                confirm: 'Delete',
                shortcut: DELETE_SELECTED_NODE_SHORTCUT,
                onSelect: () => { void onDelete(node); },
              } as NodeMenuAction,
            ]
          : []),
      ]
    : [];

  return (
    <Container
      data-workflow-node-inspector="true"
      position="absolute"
      zIndex="20"
      // Lindy anatomy: a FULL-HEIGHT configuration panel docked to the right
      // edge of the canvas — not a floating cardlet. The panel owns its own
      // scroll; the canvas stays interactive beside it.
      style={{ top: 0, right: 0, bottom: 0, width: '380px', maxWidth: 'calc(100% - 1rem)' }}
      // The inspector floats INSIDE the canvas element. Without these stops,
      // clicks inside it bubble to the canvas background handlers, which
      // deselect the node — closing the inspector mid-interaction.
      onPointerDown={(event: React.PointerEvent) => event.stopPropagation()}
      onClick={(event: React.MouseEvent) => event.stopPropagation()}
    >
      <Card
        variant="popover"
        padding="md"
        height="full"
        style={{ height: '100%', overflowY: 'auto', borderRadius: 0 }}
      >
        <Container layout="vertical" gap="md">

          {/* Header — Lindy panel anatomy: leading kind icon + title over a
              quiet type subtitle + close. Editable actions rename in place
              (click the title; the id stays stable). */}
          <InspectorHeader
            iconName={display.iconName}
            accentTone={display.accentTone}
            title={draft.name || node.label}
            typeLabel={isTrigger ? 'Starts work' : 'Action'}
            editable={editable}
            renaming={renamingTitle}
            onTitleChange={(name) => setDraft((current) => ({ ...current, name }))}
            onStartRename={() => setRenamingTitle(true)}
            onStopRename={() => setRenamingTitle(false)}
            onClose={onClose}
            enabled={draft.enabled}
            onToggleEnabled={
              editable ? (value) => setDraft((current) => ({ ...current, enabled: value })) : undefined
            }
            menuActions={menuActions}
          />

          {/* Trigger: Lindy's trigger-config anatomy — "Triggers when…"
              subtitle under the header, labeled field rows for the real
              facts (what event, on/off), the actual payload it sends behind
              a disclosure, then navigation chips to what it runs. */}
          {isTrigger && (
            <Container layout="vertical" gap="md">
              {display.description && (
                <Text variant="caption" color="muted">
                  {display.description}.
                </Text>
              )}
              {display.topic && (
                <Container layout="vertical" gap="xs" data-workflow-trigger-fields="true">
                  <Text variant="caption" color="muted">Listens for</Text>
                  <Card variant="nested" padding="sm">
                    <Text variant="body-xs">{humanizeIdentifier(display.topic)}</Text>
                  </Card>
                </Container>
              )}
              <Container layout="horizontal" gap="sm" alignItems="center">
                <StatusDot status={display.enabled ? 'success' : 'neutral'} size="sm" />
                <Text variant="caption" color="muted">
                  {display.enabled ? 'On — fires whenever this happens' : 'Off — not firing'}
                </Text>
              </Container>
              <Container layout="vertical" gap="xs">
                <Text variant="caption" color="muted">Then it runs</Text>
                {triggerRuns.length > 0 ? (
                  <Container layout="vertical" gap="xs">
                    {triggerRuns.map((id) => (
                      <Button key={id} variant="secondary" size="sm" onClick={() => onNavigate?.(id)}>
                        <Container layout="horizontal" gap="sm" alignItems="center" width="full">
                          <Container flex={1} style={{ minWidth: 0, textAlign: 'left' }}>
                            <Text variant="body-xs" truncate>{labelFor(id)}</Text>
                          </Container>
                          <Icon icon={ChevronRightIcon} size="xs" color="muted" />
                        </Container>
                      </Button>
                    ))}
                  </Container>
                ) : (
                  <Text variant="caption" color="muted">
                    Nothing on this canvas — it starts work elsewhere.
                  </Text>
                )}
              </Container>
              {display.outputTemplate && Object.keys(display.outputTemplate).length > 0 && (
                <TriggerPayloadDisclosure template={display.outputTemplate} />
              )}
              <Card variant="nested" padding="sm">
                <Text variant="caption" color="muted">
                  This is a start event. It fires on its own — open the action
                  it runs to change what happens next.
                </Text>
              </Card>
            </Container>
          )}

          {/* Shipped action: honest, with fork */}
          {!isTrigger && !display.editable && (
            <Card variant="nested" padding="sm">
              <Container layout="vertical" gap="sm">
                <Text variant="body-xs" color="muted">
                  Shipped with {display.shippedBy}. Make your own copy to change it.
                </Text>
                <Container layout="horizontal" gap="sm">
                  <Button variant="secondary" size="sm" onClick={() => onFork?.(node)}>
                    <Icon icon={CopyIcon} size="sm" />
                    Make my copy
                  </Button>
                </Container>
              </Container>
            </Card>
          )}

          {/* Action behavior */}
          {!isTrigger && (
            <Container layout="vertical" gap="md">
              <Container layout="vertical" gap="xs">
                <Container layout="horizontal" gap="sm" alignItems="center">
                  {/* On/off lives in the header pill now (Lindy keeps it top-
                      level, beside the title). Shipped actions can't be toggled,
                      so they say why instead of showing a dead control (L114). */}
                  {!editable && (
                    <Text variant="caption" color="muted">
                      {display.enabled ? 'On' : 'Paused'} — copy it to change this
                    </Text>
                  )}
                  <Container flex={1} />
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={handleRun}
                    disabled={running}
                    style={{ whiteSpace: 'nowrap', flexShrink: 0 }}
                  >
                    <Icon icon={PlayIcon} size="sm" />
                    {running ? 'Running…' : 'Run now'}
                  </Button>
                </Container>
                <Text variant="caption" color="muted">
                  Run now does the steps below once and shows you what happened.
                </Text>
              </Container>

              {/* Read-only nodes with no description skip the field — an
                  empty disabled box is dead chrome (L118). */}
              {(editable || draft.description.trim().length > 0) && (
                <Textarea
                  label="What this does"
                  rows={2}
                  value={draft.description}
                  disabled={!editable}
                  onChange={(event) => setDraft((current) => ({
                    ...current,
                    description: event.target.value,
                  }))}
                />
              )}

              {/* Steps */}
              <Container layout="vertical" gap="sm">
                <Text variant="caption" color="muted">
                  {draft.steps.length === 0
                    ? 'No work yet'
                    : draft.steps.length === 1
                      ? '1 step'
                      : `${draft.steps.length} steps, in order`}
                </Text>
                {draft.steps.map((step, index) => {
                  const isExpanded = expandedSteps.has(index);
                  return (
                    <Card key={index} variant="nested" padding="sm">
                      <Container layout="vertical" gap="sm">
                        <Container layout="horizontal" gap="xs" alignItems="center">
                          <Button
                            variant="ghost"
                            size="sm"
                            aria-label={isExpanded ? 'Hide details' : 'Show details'}
                            onClick={() => toggleStepExpanded(index)}
                          >
                            <Icon icon={isExpanded ? ChevronDownIcon : ChevronRightIcon} size="xs" />
                          </Button>
                          <Container
                            flex={1}
                            style={{ minWidth: 0, cursor: 'pointer' }}
                            onClick={() => toggleStepExpanded(index)}
                          >
                            <Text variant="body-xs" weight="semibold" truncate>
                              {summaries[index]?.sentence ?? `Step ${index + 1}`}
                            </Text>
                          </Container>
                          {editable && (
                            <ExpandableTabs
                              mode="action"
                              size="sm"
                              ariaLabel={`Step ${index + 1}`}
                              items={[
                                { id: 'up', label: 'Move up', icon: 'ArrowUp', disabled: index === 0 },
                                { id: 'down', label: 'Move down', icon: 'ArrowDown', disabled: index === draft.steps.length - 1 },
                                { id: 'remove', label: 'Remove step', icon: 'Trash2' },
                              ]}
                              onSelect={(id) => (id === 'remove' ? removeStep(index) : moveStep(index, id === 'up' ? -1 : 1))}
                            />
                          )}
                        </Container>
                        {isExpanded && (editable ? (
                          <StepEditor
                            step={step}
                            actionOptions={actionOptions}
                            workTargetOptions={workTargetOptions}
                            workCapabilities={workCapabilities}
                            priorSteps={draft.steps.slice(0, index).map((prior, priorIndex) => ({
                              stepId: stepIdOf(prior, priorIndex),
                              sentence: summaries[priorIndex]?.sentence ?? `Step ${priorIndex + 1}`,
                            }))}
                            inputFields={inputFields}
                            onChange={(nextStep) => replaceStep(index, nextStep)}
                          />
                        ) : (
                          <StepDetail
                            step={step}
                            actionOptions={actionOptions}
                            workTargetOptions={workTargetOptions}
                            workCapabilities={workCapabilities}
                          />
                        ))}
                      </Container>
                    </Card>
                  );
                })}
                {editable && !addingStep && (
                  <Button
                    variant="ghost"
                    size="sm"
                    data-workflow-add-step="true"
                    onClick={() => setAddingStep(true)}
                  >
                    <Container layout="horizontal" gap="sm" alignItems="center">
                      <Icon icon={PlusIcon} size="xs" color="secondary" />
                      <Text variant="body-xs">Add a step</Text>
                    </Container>
                  </Button>
                )}
                {editable && addingStep && (
                  <Card variant="nested" padding="sm" data-workflow-add-step-catalog="true">
                    <Container layout="vertical" gap="sm">
                      <Container layout="horizontal" gap="sm" alignItems="center" justifyContent="between">
                        <Text variant="caption" color="muted">Select next step</Text>
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label="Close step catalog"
                          onClick={() => setAddingStep(false)}
                        >
                          <Icon icon={CloseIcon} size="xs" />
                        </Button>
                      </Container>
                      <NextStepCatalog
                        actionOptions={catalogActionOptions}
                        workTargets={workTargets}
                        workCapabilities={workCapabilities}
                        onPick={appendPickedStep}
                      />
                      <Container layout="horizontal" gap="xs" wrap="wrap">
                        {stepKindCatalog().filter((shape) =>
                          !['custom', 'loop', 'wait', 'ask', 'action'].includes(shape.value)).map((shape) => (
                          <Button
                            key={shape.value}
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                              addStep(shape.value);
                              setAddingStep(false);
                            }}
                          >
                            {shape.label}
                          </Button>
                        ))}
                      </Container>
                    </Container>
                  </Card>
                )}
              </Container>

              {/* Paths: the engine's real branching — edges with conditions */}
              <PathsSection
                steps={draft.steps}
                edges={draft.edges}
                summaries={summaries}
                editable={editable}
                onChange={(edges) => setDraft((current) => ({
                  ...current,
                  // Edges point at step ids — make sure every step has one.
                  steps: withStepIds(current.steps),
                  edges,
                }))}
              />

              {/* References */}
              {referencedIds.length > 0 && (
                <Container layout="vertical" gap="xs">
                  <Text variant="caption" color="muted">Works with</Text>
                  <Container layout="horizontal" gap="xs" wrap="wrap">
                    {referencedIds.map((id) => (
                      <Button key={id} variant="ghost" size="sm" onClick={() => onNavigate?.(id)}>
                        {labelFor(id)}
                      </Button>
                    ))}
                  </Container>
                </Container>
              )}

              {/* Save / discard. Delete moved to the header "…" menu (Lindy
                  anatomy) — the editing footer is now just the form commit. */}
              {editable && (
                <Container layout="horizontal" gap="sm" alignItems="center">
                  <Container flex={1} />
                  <Button variant="ghost" size="sm" onClick={() => setDraft(draftFromNode(node))}>
                    Discard
                  </Button>
                  <Button variant="primary" size="sm" onClick={handleSave} disabled={saving}>
                    {saving ? 'Saving…' : 'Save'}
                  </Button>
                </Container>
              )}
              {saveError && (
                <Text variant="caption" color="error">
                  {saveError}
                </Text>
              )}
            </Container>
          )}

          {/* Run report */}
          {runResult && <RunReport result={runResult} summaries={summaries} />}

          {/* Past runs: the owner's durable receipt trail for this action. */}
          {!isTrigger && onListRuns && (
            <PastRunsSection definitionId={node.id} onListRuns={onListRuns} />
          )}
        </Container>
      </Card>
    </Container>
  );
};
