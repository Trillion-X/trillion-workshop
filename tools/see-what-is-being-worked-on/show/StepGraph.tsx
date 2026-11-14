// parts/workflow-canvas/show/StepGraph.tsx
//
// PURPOSE
//   A job done in steps, drawn on the one shared canvas (parts/ui/show/node-graph NodeGraph): every step a section
//   card (Sim's workflow block anatomy: its who-does-it icon on a tile in its state's tone, its title, how long it took
//   or has been going, the checks run on it as rows), the lines between steps right-angled with rounded bends and
//   colouring as the run passes along them, a line into a step being done now flowing with a dot travelling along it,
//   and a step being done breathing a ring in its tone. A step that holds steps of its own opens into them as a canvas
//   of its own, to any depth. The chosen step opens beside the graph with what it does, who does it, anything that
//   went wrong and what it handed back. Levels run across on a wide canvas and down on a phone.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Blind: a step's `state` is a raw key looked up in `looks`; an unknown key reads as its own words, quietly. The
//      lines' colours and motion come from the same looks (`flow`), never from a state named here.
//   2. Every element is a shared ui component; inline style is geometry only.
//   3. What a step handed back is shown exactly as given, never summarised or invented.
//   4. Time on a card is read from the run's own kept times; a step still going counts up live, a step not reached
//      says nothing.
//   5. Reference anatomy: Sim Studio's workflow renderer (Apache-2.0: packages/workflow-renderer workflow-block,
//      sub-block-row, edge views and the block ring pulse), AirOps and Klaviyo run views (one step's output opened in a
//      side panel).

import React, { useEffect, useMemo, useState } from 'react';
import { Button, Card, Container, NodeGraph, SchemaValueView, StatusDot, Text, type JsonSchema } from '../../ui';
import type { GraphEdgeInput, GraphNodeInput } from '../../ui/show/node-graph/NodeGraph';
import type { StatusOverrides } from '../../ui/show/graph-status/graph-status-view';
import { errorWords } from '../../ui/show/safe-error-card/sanitize-error-text';

/** How lines out of a step are drawn once it has run: completed, active (flowing into work happening now), failed. */
export type EdgeFlow = 'completed' | 'active' | 'failed';
export type Tone = 'success' | 'warning' | 'error' | 'info' | 'accent' | 'idle' | 'neutral';
/** How one state reads: its words, its tone, whether it moves, and how lines out of it are drawn. */
export type StateLook = { label: string; tone: Tone; pulse?: boolean; flow?: EdgeFlow };
export type StepDetail = { label: string; text: string };
/** A row inside a step's card: a check run on the step, a tool it may call. Its state reads through the same looks. */
export type StepRow = { id: string; label: string; icon?: string; state?: string; detail?: string };
/** Something that can be done to a step from its card; `onStepAction` runs it. */
export type StepAction = { id: string; label: string; icon?: string };
export type GraphStep = {
  id: string;
  title: string;
  /** A lucide icon name for who does the step. */
  icon?: string;
  /** One quiet line under the title. */
  caption?: string;
  state: string;
  details?: StepDetail[];
  /** What the step handed back, as it was kept; shown readably, shaped by output_schema. */
  output?: unknown;
  /** The JSON Schema of what the step hands back. */
  output_schema?: JsonSchema;
  /** A note about what the step handed back when its output is not here, shown as written. */
  evidence?: string | null;
  /** The evidence is only the opening of a longer output; readWhole fetches the rest. */
  evidence_partial?: boolean;
  /** When the step began and was admitted, as kept by the run (ISO times). */
  started_at?: string | null;
  finished_at?: string | null;
  rows?: StepRow[];
  /** The step's own steps: it opens into them. */
  inner?: { steps: GraphStep[]; edges: GraphEdge[] };
  actions?: StepAction[];
};
export type GraphEdge = { from: string; to: string; label?: string };
export type StepGraphProps = {
  steps: GraphStep[];
  edges: GraphEdge[];
  looks: Record<string, StateLook>;
  /** The heading of the evidence part of the side panel. */
  evidenceLabel?: string;
  /** Said in the side panel when a step has handed nothing back. */
  noEvidence?: string;
  /** Reads a step's whole output, for a step whose evidence is only its opening. */
  readWhole?: (stepId: string) => Promise<unknown>;
  /** Runs one of a step's actions; the promise drives the press's own pending, done and failed faces. */
  onStepAction?: (stepId: string, actionId: string) => Promise<unknown>;
  /** The outermost graph's name in the trail shown inside a step. */
  title?: string;
  /** Drawn small and read-only (a hover card): the whole graph fits, nothing is chosen, nothing pans. */
  still?: boolean;
};

/** Step cards 264 wide, 72 clear between one step and the next, 28 between steps side by side. */
const STEP_LAYOUT = { levelSpace: 72, siblingGap: 28, defaultWidth: 264 } as const;
const lookOf = (looks: Record<string, StateLook>, state: string): StateLook => looks[state] ?? { label: state, tone: 'idle' };
const toneColor = (tone: string) => `var(--record-kind-${tone}, var(--record-kind-grey))`;
const FLOW_KEY = (flow: EdgeFlow) => `line:${flow}`;
const FLOW_LOOKS: Record<EdgeFlow, { tone: Tone; pulse?: boolean }> = { completed: { tone: 'success' }, active: { tone: 'info', pulse: true }, failed: { tone: 'error' } };

/** How long, in the words a card has room for: 4s, 1m 12s, 2h 3m, 3d 4h. */
export function tookWords(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** The state a line into `to` from `from` reads as: flowing into work happening now, else the flow of the step it
 *  leaves once the step it reaches has been reached. */
function lineState(from: StateLook, to: StateLook): string | undefined {
  if (to.pulse && to.flow === 'active') return FLOW_KEY('active');
  if (to.tone === 'idle') return undefined;
  return from.flow && from.flow !== 'active' ? FLOW_KEY(from.flow) : undefined;
}

function toGraph(steps: GraphStep[], edges: GraphEdge[], looks: Record<string, StateLook>, now: number): { nodes: GraphNodeInput[]; edges: GraphEdgeInput[] } {
  const byId = new Map(steps.map(step => [step.id, step]));
  return {
    nodes: steps.map(step => {
      const look = lookOf(looks, step.state);
      const started = step.started_at ? Date.parse(step.started_at) : NaN;
      const finished = step.finished_at ? Date.parse(step.finished_at) : NaN;
      const meta = Number.isFinite(started) && Number.isFinite(finished) ? tookWords(finished - started)
        : Number.isFinite(started) && look.pulse ? tookWords(now - started) : undefined;
      return {
        id: step.id,
        label: step.title,
        subtitle: step.caption,
        status: step.state,
        icon: step.icon,
        meta,
        rows: step.rows?.map(row => ({ id: row.id, label: row.label, icon: row.icon, status: row.state, detail: row.detail })),
        inner: step.inner ? toGraph(step.inner.steps, step.inner.edges, looks, now) : undefined,
        actions: step.actions,
      };
    }),
    edges: edges.map(edge => {
      const from = byId.get(edge.from), to = byId.get(edge.to);
      return { id: `${edge.from}->${edge.to}`, from: edge.from, to: edge.to, label: edge.label, activity: from && to ? lineState(lookOf(looks, from.state), lookOf(looks, to.state)) : undefined };
    }),
  };
}

/** Every step at any depth, by id, so a step chosen inside another opens its panel too. */
function everyStep(steps: GraphStep[], into = new Map<string, GraphStep>()): Map<string, GraphStep> {
  for (const step of steps) {
    into.set(step.id, step);
    if (step.inner) everyStep(step.inner.steps, into);
  }
  return into;
}

const moving = (steps: GraphStep[], looks: Record<string, StateLook>): boolean =>
  steps.some(step => (lookOf(looks, step.state).pulse && Boolean(step.started_at)) || (step.inner ? moving(step.inner.steps, looks) : false));

function StepPanel({ step, look, evidenceLabel, noEvidence, readWhole, onClose }: { step: GraphStep; look: StateLook; evidenceLabel: string; noEvidence: string; readWhole?: (stepId: string) => Promise<unknown>; onClose: () => void }) {
  const [whole, setWhole] = useState<{ step: string; output?: unknown; problem?: string } | null>(null);
  const shown = whole?.step === step.id ? whole : null;
  const output = shown && 'output' in shown ? shown.output : step.output;
  const readRest = () => {
    if (!readWhole) return Promise.resolve();
    return readWhole(step.id).then(value => setWhole({ step: step.id, output: value }), (error: unknown) => setWhole({ step: step.id, problem: errorWords(error) }));
  };
  return (
    <Container position="absolute" zIndex="20" data-step-panel-frame style={{ top: '52px', right: '12px', bottom: '12px', width: '380px', maxWidth: 'calc(100% - 24px)' }} onPointerDown={(event: React.PointerEvent) => event.stopPropagation()} onWheel={(event: React.WheelEvent) => event.stopPropagation()}>
      <Card data-step-panel={step.id} variant="popover" padding="md" height="full" style={{ overflowY: 'auto' }}>
        <Container layout="vertical" gap="md">
          <Container layout="horizontal" gap="sm" alignItems="center" justifyContent="between">
            <Text variant="heading-xs" truncate>{step.title}</Text>
            <Button size="sm" variant="ghost" onClick={onClose}>Close</Button>
          </Container>
          <Container layout="horizontal" gap="xs" alignItems="center">
            <StatusDot size="md" status={look.tone === 'neutral' ? 'idle' : look.tone} pulse={look.pulse === true} />
            <Text variant="body-xs">{look.label}</Text>
          </Container>
          {(step.details ?? []).map(detail => (
            <Container key={detail.label} layout="vertical" gap="xs">
              <Text variant="caption">{detail.label}</Text>
              <Text variant="body-xs" wrap="preserve">{detail.text}</Text>
            </Container>
          ))}
          <Container layout="vertical" gap="xs">
            <Text variant="caption">{evidenceLabel}</Text>
            {output !== undefined
              ? <Container layout="vertical" data-step-evidence={step.id}><SchemaValueView value={output} schema={step.output_schema} /></Container>
              : step.evidence
                ? <Card variant="nested" padding="sm"><Text variant="caption" wrap="preserve" data-step-evidence={step.id}>{step.evidence}</Text></Card>
                : <Text variant="body-xs" color="muted">{noEvidence}</Text>}
            {step.evidence_partial && readWhole && output === undefined
              ? <Container layout="horizontal" gap="sm" alignItems="center"><Text variant="caption" color="muted">This is the start of a longer answer.</Text><Button size="sm" variant="secondary" onClick={readRest}>Show all of it</Button></Container>
              : null}
            {shown?.problem ? <Text variant="caption" color="error">{shown.problem}</Text> : null}
          </Container>
        </Container>
      </Card>
    </Container>
  );
}

export function StepGraph({ steps, edges, looks, evidenceLabel = 'What it handed back', noEvidence = 'Nothing yet.', readWhole, onStepAction, title = 'Workflow', still = false }: StepGraphProps): React.ReactElement {
  // A step still going counts up on its card; the clock ticks only while one is.
  const [now, setNow] = useState(() => Date.now());
  const live = !still && moving(steps, looks);
  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [live]);
  const graph = useMemo(() => toGraph(steps, edges, looks, now), [steps, edges, looks, now]);
  const overrides: StatusOverrides = useMemo(() => ({
    ...Object.fromEntries(Object.entries(looks).map(([key, look]) => [key, { label: look.label, tone: look.tone, pulse: look.pulse === true }])),
    ...Object.fromEntries((Object.keys(FLOW_LOOKS) as EdgeFlow[]).map(flow => [FLOW_KEY(flow), FLOW_LOOKS[flow]])),
  }), [looks]);
  const all = useMemo(() => everyStep(steps), [steps]);
  const [chosen, setChosen] = useState<string | null>(null);
  const selected = !still && chosen ? all.get(chosen) ?? null : null;

  return (
    <NodeGraph
      nodes={graph.nodes}
      edges={graph.edges}
      layout="dag"
      direction="auto"
      layoutOptions={STEP_LAYOUT}
      statusOverrides={overrides}
      toneToColor={toneColor}
      selectedNodeId={selected?.id}
      onSelectNode={setChosen}
      onNodeAction={onStepAction}
      onPathChange={() => setChosen(null)}
      rootLabel={title}
      readableMinZoom={0.7}
      showControls={!still}
      showMinimap={!selected}
      still={still}
      ariaLabel={title}
      emptyState="This workflow has no steps."
    >
      {selected ? <StepPanel step={selected} look={lookOf(looks, selected.state)} evidenceLabel={evidenceLabel} noEvidence={noEvidence} readWhole={readWhole} onClose={() => setChosen(null)} /> : null}
    </NodeGraph>
  );
}
