// packages/funnel-offer-graph/show/mount-funnel-canvas.tsx
//
// =============================================================================
// PURPOSE — the Funnels surface: a tornado view of the Observable Choice-Stage
// Workflow primitive, rendered through the SAME canvas as the workflow engine.
// =============================================================================
//
// The funnel is NOT a bespoke widget. It reads a `funnel-definition` DATA record
// (the stage_address primitive), resolves each stage's seven `$ref`s against the
// generic owner packages (workflow nodes, choose-per-observer surfaces, checkout
// offers, progression-evaluator measures, visual-database detail views), lays the
// stages out as a narrowing tornado (`layoutTornado`), and renders them through
// `CanvasView` — the shared graph-view primitive extracted from the workflow
// canvas (graph-canvas underneath). Clicking a stage opens a generic
// stage-detail drawer composed from `visual-database` (data) + direct row actions.
// A stage's A/B variants come from `choose-per-observer`; editing a variant is a
// scoped additive write to that selection surface.
//
// NON-NEGOTIABLE INVARIANTS:
// 1. No bespoke second canvas. Renders through `CanvasView` (-> graph-canvas).
// 2. No re-owned logic: A/B = choose-per-observer, drill-in = visual-database,
//    measures = progression-evaluator, offers = checkout. The funnel only
//    resolves refs + projects + dispatches.
// 3. Product copy is human ("Step", "Conversion", "Test", "Run") — no internal
//    vocabulary (stage_address, $ref, execute_definition) in the UI (L114/L118).
// 4. Fail-soft: no funnel -> honest empty state, never a throw. No fake data.

import React from 'react';
import { useBitfieldData } from '@bitfield/runtime-kit/react';
import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';
import {
  Badge,
  Button,
  Card,
  Container,
  Divider,
  ErrorBoundary,
  Input,
  OpenSurfaceAction,
  Text,
  mountReactSurface,
} from '../../../ui';
import { useGraphCanvas } from '@/packages/graph-canvas/show/use-graph-canvas';
import type { CanvasNodeFrame } from '@/packages/graph-canvas/show/types';
import { CanvasView } from '@/packages/graph-canvas/show/CanvasView';
import { VisualDatabaseSurface } from '@/packages/visual-database/show/VisualDatabaseSurface';
import {
  buildStageActionRequest,
  buildVariantUpsertWrite,
  liveVariantMapFromDecisions,
  stageRowActionSpecs,
  type ObserverDecisionRow,
  type ProjectionActionSpec,
} from '../read-data/funnel-composition';
import {
  buildFunnelStageDetailVisualDatabaseProjection,
  type FunnelStageDetailVisualDatabaseProjection,
} from '../read-data/stage-detail-visual-database';
import {
  readFunnelDefinition,
  resolveFunnelDefinition,
  type FunnelDefinition,
  type FunnelOwnerRecords,
  type ResolvedStage,
} from '../read-data/funnel-definition';
import { layoutTornado } from '../read-data/stage-projection';
import {
  appendStage,
  buildFunnelDefinitionWrite,
  buildNewFunnelDefinition,
} from '../do-work/create-funnel';
import { FloatingPanel } from '@/packages/screen-arrangement/show/FloatingPanel';

const ENGINE_LABEL_TARGET = 'engine.operation.label-addressed';

// The package's own always-declared input, used ONLY as a safe fallback NAME so
// an unbound optional owner input never reaches `useBitfieldData('')` — which
// throws "Bitfield read scope has no input named ''" and crashes the entire
// canvas (violating the fail-soft invariant above). The read value is discarded
// when the input was not actually bound, so this reads no wrong data.
const SAFE_FALLBACK_INPUT = 'funnel-definition-list';

/**
 * Read an OPTIONAL bound input. Returns undefined (never throws) when the input
 * name is empty/unbound. Always calls the read hook exactly once in a fixed
 * order, so the React rules of hooks hold. This is what makes workflow_nodes /
 * decisions (which the descriptor may legitimately omit) fail-soft instead of
 * crashing the funnel canvas.
 */
function useOptionalInput(name: string | undefined): unknown {
  const raw = useBitfieldData(name || SAFE_FALLBACK_INPUT);
  return name ? raw : undefined;
}

type SurfaceInput = {
  funnel_input?: string;
  funnel_id?: string;
  owners?: {
    workflow_nodes_input?: string;
    variant_surfaces_input?: string;
    offers_input?: string;
    measures_input?: string;
    detail_views_input?: string;
  };
  decisions_input?: string;
  detail_records_input?: string;
  edit?: { path_labels?: string[] };
};

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function isRecord(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}
function centsToMoney(cents: number): string {
  return `$${(cents / 100).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

/**
 * Decode a find-current-items `address` value (hex with a leading CAS-fp
 * byte-pair) into its identity_text address label. Pure. Reused for discovering
 * a selection-surface's live address before an additive variant write.
 */
export function decodeItemAddress(hex: unknown): string | null {
  if (typeof hex !== 'string' || hex.length <= 4 || !/^[0-9a-f]+$/i.test(hex)) return null;
  const bytes = hex.slice(4).match(/../g) ?? [];
  try {
    return decodeURIComponent(bytes.map((b) => `%${b}`).join(''));
  } catch {
    return null;
  }
}

/** Discover a record's live address from the fold (self-describing kind+id). */
export async function discoverRecordAddress(kind: string, id: string): Promise<string | null> {
  if (!kind || !id) return null;
  const reply = await sendRequestToBitfieldTarget({
    target: 'slot::find-current-items',
    payload: {
      operation: 'find-current-items',
      in: 'published-record',
      where: { all: [{ field: 'kind', in: [kind] }, { field: 'id', in: [id] }] },
      include: ['payload', 'address'],
    },
  } as never) as { payload: Uint8Array };
  const parsed = JSON.parse(new TextDecoder().decode(reply.payload));
  const items: Array<{ address?: unknown }> = parsed?.items ?? parsed?.output?.items ?? [];
  for (const item of items) {
    const address = decodeItemAddress(item.address);
    if (address) return address;
  }
  return null;
}

// ---------------------------------------------------------------------------
// STAGE BAR — the tornado node (bar width = the frame; converted-fill inside)
// ---------------------------------------------------------------------------

function StageBar({
  stage,
  isSelected,
}: {
  stage: ResolvedStage;
  isSelected: boolean;
}) {
  const convertedFraction = stage.entered > 0
    ? Math.max(0, Math.min(1, stage.converted / stage.entered))
    : 0;
  return (
    <Card
      variant="surface"
      padding="sm"
      height="full"
      selected={isSelected}
      data-reach-action="view-funnel"
      style={{ width: '100%', height: '100%', position: 'relative', overflow: 'hidden' }}
    >
      {/* Converted portion of the bar (solid); the rest reads as drop-off. */}
      <Container
        position="absolute"
        style={{
          left: 0,
          top: 0,
          bottom: 0,
          width: `${Math.round(convertedFraction * 100)}%`,
          background: 'var(--accent-soft, rgba(80,140,255,0.16))',
          pointerEvents: 'none',
        }}
      />
      <Container layout="vertical" gap="none" style={{ position: 'relative' }}>
        <Container layout="horizontal" gap="sm" alignItems="baseline" justifyContent="between">
          <Text variant="body-sm" weight="semibold" truncate>{stage.title}</Text>
          {stage.offer_amount_cents != null ? (
            <Text variant="body-xs" color="muted">{centsToMoney(stage.offer_amount_cents)}</Text>
          ) : null}
        </Container>
        <Container layout="horizontal" gap="md" alignItems="baseline" data-reach-role="conversion-rates">
          <Text variant="heading-sm">{stage.conversion_rate}%</Text>
          <Text variant="body-xs" color="muted">{stage.entered.toLocaleString()} entered</Text>
        </Container>
        {stage.variants.length > 0 ? (
          <Container layout="horizontal" gap="xs" alignItems="center">
            <Badge variant="accent" size="sm">Test</Badge>
            <Text variant="body-xs" color="muted">{stage.variants.length} variants</Text>
          </Container>
        ) : null}
      </Container>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// STAGE DETAIL DRAWER — the "click a step -> see data + take actions" panel.
// Composed from visual-database (data) + choose-per-observer (A/B).
// ---------------------------------------------------------------------------

function StageDrawer({
  stage,
  detailView,
  onClose,
  onRunAction,
  onEditVariant,
}: {
  stage: ResolvedStage;
  detailView: FunnelStageDetailVisualDatabaseProjection | null;
  onClose: () => void;
  onRunAction: (spec: ProjectionActionSpec) => void;
  onEditVariant: (candidateId: string, amountCents: number) => void;
}) {
  const actionSpecs = React.useMemo(() => stageRowActionSpecs(stage), [stage]);

  return (
    <Container
      position="absolute"
      zIndex="20"
      style={{ top: 0, right: 0, bottom: 0, width: '360px', maxWidth: '90%' }}
      onPointerDown={(event: React.PointerEvent) => event.stopPropagation()}
      onClick={(event: React.MouseEvent) => event.stopPropagation()}
    >
      <Card variant="popover" padding="md" height="full" style={{ overflowY: 'auto' }}>
        <Container layout="vertical" gap="md">
          <Container layout="horizontal" justifyContent="between" alignItems="center">
            <Text variant="heading-sm" truncate>{stage.title}</Text>
            <Button size="sm" variant="ghost" onClick={onClose} aria-label="Close">Close</Button>
          </Container>

          {/* Conversion stats. */}
          <Container layout="horizontal" gap="lg">
            <Container layout="vertical">
              <Text variant="body-xs" color="muted">Entered</Text>
              <Text variant="body-sm" weight="semibold">{stage.entered.toLocaleString()}</Text>
            </Container>
            <Container layout="vertical">
              <Text variant="body-xs" color="muted">Converted</Text>
              <Text variant="body-sm" weight="semibold">{stage.converted.toLocaleString()}</Text>
            </Container>
            <Container layout="vertical">
              <Text variant="body-xs" color="muted">Conversion</Text>
              <Text variant="body-sm" weight="semibold">{stage.conversion_rate}%</Text>
            </Container>
          </Container>

          {/* A/B variant strip (choose-per-observer) + in-UI edit. */}
          {stage.variants.length > 0 ? (
            <>
              <Divider />
              <Container layout="vertical" gap="sm">
                <Text variant="body-sm" weight="semibold">Test</Text>
                {stage.variants.map((variant) => (
                  <VariantRow
                    key={variant.candidate_id}
                    label={variant.label ?? variant.candidate_id}
                    amountCents={variant.amount_cents}
                    live={variant.live === true}
                    onSave={(cents) => onEditVariant(variant.candidate_id, cents)}
                  />
                ))}
              </Container>
            </>
          ) : null}

          {/* Row actions (generic target envelope dispatch). */}
          {actionSpecs.length > 0 ? (
            <>
              <Divider />
              <Container layout="vertical" gap="xs">
                {actionSpecs.map((spec) => (
                  spec.surface ? (
                    <OpenSurfaceAction key={spec.id} payload={spec.surface} label={spec.label} />
                  ) : (
                    <Button key={spec.id} size="sm" variant="secondary" onClick={() => onRunAction(spec)}>
                      {spec.label}
                    </Button>
                  )
                ))}
              </Container>
            </>
          ) : null}

          {/* The stage's own data — a visual-database descriptor scoped to this
              stage (records + fields + columns all DATA). */}
          {detailView ? (
            <>
              <Divider />
              <VisualDatabaseSurface
                model={detailView.model}
                initialViewId={detailView.initialViewId}
              />
            </>
          ) : null}
        </Container>
      </Card>
    </Container>
  );
}

function VariantRow({
  label,
  amountCents,
  live,
  onSave,
}: {
  label: string;
  amountCents?: number;
  live: boolean;
  onSave: (cents: number) => void;
}) {
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState('');
  return (
    <Container layout="horizontal" gap="sm" alignItems="center" justifyContent="between">
      <Container layout="horizontal" gap="xs" alignItems="center">
        <Text variant="body-sm">{label}</Text>
        {live ? <Badge variant="success" size="sm">Live</Badge> : null}
      </Container>
      {editing ? (
        <Container layout="horizontal" gap="xs" alignItems="center">
          <Input
            size="sm"
            value={draft}
            placeholder={amountCents != null ? String(amountCents / 100) : 'price'}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setDraft(e.target.value)}
            aria-label="New price in dollars"
          />
          <Button
            size="sm"
            variant="primary"
            onClick={() => {
              const dollars = Number(draft);
              if (Number.isFinite(dollars) && dollars >= 0) onSave(Math.round(dollars * 100));
              setEditing(false);
              setDraft('');
            }}
          >
            Save
          </Button>
        </Container>
      ) : (
        <Container layout="horizontal" gap="xs" alignItems="center">
          {amountCents != null ? <Text variant="body-xs" color="muted">{centsToMoney(amountCents)}</Text> : null}
          <Button size="sm" variant="ghost" onClick={() => setEditing(true)} aria-label="Edit test price">Edit</Button>
        </Container>
      )}
    </Container>
  );
}

// ---------------------------------------------------------------------------
// AUTHORING MODAL — a single-field name prompt reused for "create funnel" and
// "add step". One text input + a primary confirm; blank input is inert. Human
// copy only (no internal vocabulary) — the same shape as the Seline/Mixpanel
// funnel-create prompt (name → confirm).
// ---------------------------------------------------------------------------

function NamePromptModal({
  open,
  title,
  description,
  placeholder,
  confirmLabel,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  description?: string;
  placeholder: string;
  confirmLabel: string;
  onConfirm: (value: string) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = React.useState('');
  // Reset the draft whenever the modal (re)opens so a prior entry never leaks.
  React.useEffect(() => { if (open) setDraft(''); }, [open]);
  const trimmed = draft.trim();
  const submit = () => {
    if (!trimmed) return;
    onConfirm(trimmed);
    onClose();
  };
  return (
    <FloatingPanel open={open} onClose={onClose} title={title} description={description}>
      <Container layout="vertical" gap="md" data-reach-role="funnel-author">
        <Input
          value={draft}
          placeholder={placeholder}
          autoFocus
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setDraft(e.target.value)}
          onKeyDown={(e: React.KeyboardEvent) => { if (e.key === 'Enter') submit(); }}
          aria-label={title}
        />
        <Container layout="horizontal" gap="sm" justifyContent="end">
          <Button size="sm" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            size="sm"
            variant="primary"
            disabled={!trimmed}
            onClick={submit}
            data-reach-action="confirm-funnel-author"
          >
            {confirmLabel}
          </Button>
        </Container>
      </Container>
    </FloatingPanel>
  );
}

// ---------------------------------------------------------------------------
// ROOT
// ---------------------------------------------------------------------------

export function FunnelCanvasRoot({ surfaceInput }: { surfaceInput: SurfaceInput }) {
  // Primary feed: the funnel definitions. funnel_input binds to this input; if
  // it is somehow unbound we still read the (always-declared) definitions list
  // rather than throwing on '' — the empty state then renders honestly.
  const funnelRaw = useBitfieldData(surfaceInput.funnel_input || SAFE_FALLBACK_INPUT);
  const owners = surfaceInput.owners ?? {};
  // Owner feeds are OPTIONAL — read fail-soft so a descriptor that omits any of
  // them (e.g. workflow_nodes / decisions) renders empty instead of crashing.
  const workflowNodesRaw = useOptionalInput(owners.workflow_nodes_input);
  const variantSurfacesRaw = useOptionalInput(owners.variant_surfaces_input);
  const offersRaw = useOptionalInput(owners.offers_input);
  const measuresRaw = useOptionalInput(owners.measures_input);
  const detailViewsRaw = useOptionalInput(owners.detail_views_input);
  const decisionsRaw = useOptionalInput(surfaceInput.decisions_input);
  const detailRecordsRaw = useOptionalInput(surfaceInput.detail_records_input);

  const funnel = React.useMemo(() => {
    const ownerRecords: FunnelOwnerRecords = {
      workflowNodes: asArray(workflowNodesRaw),
      variantSurfaces: asArray(variantSurfacesRaw),
      offers: asArray(offersRaw),
      measures: asArray(measuresRaw),
      detailViews: asArray(detailViewsRaw),
      liveVariantBySurface: liveVariantMapFromDecisions(
        asArray(decisionsRaw).filter(isRecord) as unknown as ObserverDecisionRow[],
      ),
    };
    return resolveFunnelDefinition(asArray(funnelRaw), ownerRecords, surfaceInput.funnel_id);
  }, [
    funnelRaw, workflowNodesRaw, variantSurfacesRaw, offersRaw, measuresRaw,
    detailViewsRaw, decisionsRaw, surfaceInput.funnel_id,
  ]);

  // The RAW selected funnel-definition (unresolved) — the authoring base an
  // "add step" append writes back. Selection mirrors resolveFunnelDefinition:
  // the requested funnel_id, else the first defined funnel. Null when none.
  const selectedDef = React.useMemo<FunnelDefinition | null>(() => {
    const defs = asArray(funnelRaw)
      .map(readFunnelDefinition)
      .filter((d): d is FunnelDefinition => d !== null);
    if (surfaceInput.funnel_id) {
      return defs.find((d) => d.id === surfaceInput.funnel_id || d.id.includes(surfaceInput.funnel_id!)) ?? null;
    }
    return defs[0] ?? null;
  }, [funnelRaw, surfaceInput.funnel_id]);

  const layout = React.useMemo(
    () => (funnel ? layoutTornado(funnel.stages) : { frames: [], edges: [], maxEntered: 0 }),
    [funnel],
  );
  const stageByAddress = React.useMemo(() => {
    const out: Record<string, ResolvedStage> = {};
    for (const s of funnel?.stages ?? []) out[s.stage_address] = s;
    return out;
  }, [funnel]);

  const canvasRef = React.useRef<HTMLDivElement>(null);
  const containerRef = React.useRef<HTMLDivElement>(null);
  const graph = useGraphCanvas({ nodes: layout.frames, canvasRef });

  // Fit the tornado to the viewport once it is measurable (late-hydrating pane).
  const fittedForRef = React.useRef<string | null>(null);
  const zoomToFitRef = React.useRef(graph.zoomToFit);
  zoomToFitRef.current = graph.zoomToFit;
  const frameSetKey = React.useMemo(
    () => layout.frames.map((f) => f.id).sort().join('|'),
    [layout.frames],
  );
  React.useEffect(() => {
    if (layout.frames.length === 0 || fittedForRef.current === frameSetKey) return undefined;
    let cancelled = false;
    let attempts = 0;
    const tryFit = () => {
      if (cancelled) return;
      if (zoomToFitRef.current(layout.frames)) {
        fittedForRef.current = frameSetKey;
        return;
      }
      attempts += 1;
      if (attempts < 40) setTimeout(tryFit, 250);
    };
    tryFit();
    return () => { cancelled = true; };
  }, [frameSetKey, layout.frames]);

  const selectedStage = graph.selectedNodeId ? stageByAddress[graph.selectedNodeId] : undefined;

  // The detail visual-database descriptor for the selected stage.
  const detailView = React.useMemo(() => {
    if (!selectedStage?.detail_projection_id) return null;
    const descriptor = asArray(detailViewsRaw).find(
      (v) => isRecord(v) && (v.id === selectedStage.detail_projection_id
        || (typeof v.id === 'string' && v.id.includes(selectedStage.detail_projection_id!))),
    );
    return descriptor
      ? buildFunnelStageDetailVisualDatabaseProjection(descriptor, asArray(detailRecordsRaw))
      : null;
  }, [selectedStage, detailViewsRaw, detailRecordsRaw]);

  const runAction = React.useCallback((spec: ProjectionActionSpec) => {
    const request = buildStageActionRequest({ action: spec, projectionRevision: 'funnel' });
    if (!request) return;
    void Promise.resolve(sendRequestToBitfieldTarget(request as never)).catch(
      (e) => console.error('[funnel] stage action failed', e),
    );
  }, []);

  const editVariant = React.useCallback((stage: ResolvedStage, candidateId: string, amountCents: number) => {
    const surface = asArray(variantSurfacesRaw).find(
      (s) => isRecord(s) && (s.id === stage.variant_surface_id || s.address === stage.variant_surface_id),
    );
    if (!isRecord(surface)) return;
    void (async () => {
      const kind = typeof surface.kind === 'string' ? surface.kind : 'selection-surface';
      const id = typeof surface.id === 'string'
        ? surface.id
        : (typeof surface.address === 'string' ? surface.address : '');
      const address = await discoverRecordAddress(kind, id);
      const write = address
        ? buildVariantUpsertWrite(address, surface, { candidate_id: candidateId, amount_cents: amountCents }, surfaceInput.edit?.path_labels)
        : null;
      if (write) await Promise.resolve(sendRequestToBitfieldTarget({ target: ENGINE_LABEL_TARGET, payload: write.payload } as never));
      else console.error('[funnel] variant edit skipped: surface address not found');
    })().catch((e) => console.error('[funnel] variant edit failed', e));
  }, [variantSurfacesRaw, surfaceInput.edit?.path_labels]);

  const renderNode = React.useCallback((frame: CanvasNodeFrame) => {
    const stage = stageByAddress[frame.id];
    if (!stage) return null;
    return <StageBar stage={stage} isSelected={graph.selectedNodeId === frame.id} />;
  }, [stageByAddress, graph.selectedNodeId]);

  // ----- Authoring: create a new funnel + add steps to it (the usable path) ---
  const [createOpen, setCreateOpen] = React.useState(false);
  const [addStepOpen, setAddStepOpen] = React.useState(false);

  /** A short unique id fragment. Injected into the pure builder (kept out of it
   *  so the builder stays deterministic); base36 of now + a random tail. */
  const freshEntropy = React.useCallback(
    () => `${Date.now().toString(36)}${Math.floor(Math.random() * 46656).toString(36)}`,
    [],
  );

  const createFunnel = React.useCallback((title: string) => {
    const def = buildNewFunnelDefinition(title, freshEntropy());
    const request = buildFunnelDefinitionWrite(def);
    void Promise.resolve(sendRequestToBitfieldTarget(request as never)).catch(
      (e) => console.error('[funnel] create failed', e),
    );
  }, [freshEntropy]);

  const addStep = React.useCallback((title: string) => {
    if (!selectedDef) return;
    const next = appendStage(selectedDef, title);
    const request = buildFunnelDefinitionWrite(next);
    void Promise.resolve(sendRequestToBitfieldTarget(request as never)).catch(
      (e) => console.error('[funnel] add step failed', e),
    );
  }, [selectedDef]);

  // A funnel exists but has zero stages → prompt to add the first step (Seline
  // "Start by adding a step"); no funnel at all → prompt to create one.
  const hasFunnel = Boolean(selectedDef);
  const hasStages = layout.frames.length > 0;

  return (
    <CanvasView
      containerRef={containerRef}
      canvasRef={canvasRef}
      reachRole="funnel-canvas"
      layout="tornado"
      nodes={layout.frames}
      edgeRoutes={layout.edges}
      renderNode={renderNode}
      camera={graph.camera}
      selectedNodeId={graph.selectedNodeId}
      draggedNodeId={graph.draggedNodeId}
      draggedNodePosition={graph.draggedNodePosition}
      selectNode={graph.selectNode}
      startNodeDrag={graph.startNodeDrag}
      updateNodeDragPosition={graph.updateNodeDragPosition}
      endNodeDrag={graph.endNodeDrag}
      zoomToFit={graph.zoomToFit}
      onCanvasPointerDown={(event) => {
        const target = event.target as HTMLElement;
        if (!target.closest('[data-graph-node]')) {
          graph.selectNode(null);
          graph.startCanvasPan(event.clientX, event.clientY);
        }
      }}
      emptyState={(
        <Container layout="vertical" gap="md" alignItems="center" data-reach-role="empty-state">
          {hasFunnel ? (
            <>
              <Text variant="heading-sm" color="muted">Start by adding a step</Text>
              <Text variant="body-xs" color="muted">
                Add the first step of "{selectedDef?.title ?? 'your funnel'}" to see it take shape.
              </Text>
              <Button size="sm" variant="primary" onClick={() => setAddStepOpen(true)} data-reach-action="add-step">
                Add step
              </Button>
            </>
          ) : (
            <>
              <Text variant="heading-sm" color="muted">No funnel yet</Text>
              <Text variant="body-xs" color="muted">
                Create a funnel to map your steps and watch conversion at each one.
              </Text>
              <Button size="sm" variant="primary" onClick={() => setCreateOpen(true)} data-reach-action="create-funnel">
                Create funnel
              </Button>
            </>
          )}
        </Container>
      )}
    >
      {/* Toolbar overlay — always lets you start a new funnel; when a funnel is
          open it also offers "Add step" so the funnel is never stuck empty. */}
      <Container
        position="absolute"
        zIndex="10"
        layout="horizontal"
        gap="sm"
        style={{ top: '12px', left: '12px' }}
        data-reach-role="funnel-toolbar"
      >
        <Button size="sm" variant="secondary" onClick={() => setCreateOpen(true)} data-reach-action="create-funnel">
          New funnel
        </Button>
        {hasFunnel && hasStages ? (
          <Button size="sm" variant="ghost" onClick={() => setAddStepOpen(true)} data-reach-action="add-step">
            Add step
          </Button>
        ) : null}
      </Container>

      {selectedStage ? (
        <StageDrawer
          stage={selectedStage}
          detailView={detailView}
          onClose={() => graph.selectNode(null)}
          onRunAction={runAction}
          onEditVariant={(candidateId, cents) => editVariant(selectedStage, candidateId, cents)}
        />
      ) : null}

      <NamePromptModal
        open={createOpen}
        title="Create funnel"
        description="Give your funnel a name — you'll add its steps next."
        placeholder="e.g. Offer ladder"
        confirmLabel="Create"
        onConfirm={createFunnel}
        onClose={() => setCreateOpen(false)}
      />
      <NamePromptModal
        open={addStepOpen}
        title="Add step"
        description="Name the step people move through at this point in the funnel."
        placeholder="e.g. Visited landing page"
        confirmLabel="Add step"
        onConfirm={addStep}
        onClose={() => setAddStepOpen(false)}
      />
    </CanvasView>
  );
}

type MountArgs = { el: HTMLElement; props?: Record<string, unknown> };

export default function mount({ el, props = {} }: MountArgs) {
  // The placeable-surface descriptor delivers its config under `surface_input`
  // (snake_case); some hosts camelize it to `surfaceInput`. Read BOTH so the
  // bound input names always reach the reads below — otherwise funnel_input is
  // undefined, `useBitfieldData('')` throws, and the whole canvas crashes with
  // "read scope has no input named ''" instead of rendering. (Matches the
  // robust convention in choose-per-observer / connector-room / mount-progress.)
  const surfaceInput = (props.surfaceInput ?? props.surface_input ?? {}) as SurfaceInput;
  return mountReactSurface(
    el,
    <ErrorBoundary zoneName="funnel canvas">
      <FunnelCanvasRoot surfaceInput={surfaceInput} />
    </ErrorBoundary>,
  );
}
