// parts/funnel-offer-graph/show/FunnelCanvas.tsx
//
// PURPOSE
//   One funnel drawn as a tornado on the shared canvas (graph-canvas CanvasView): each stage a bar as wide as the
//   number who entered it, filled to the share that converted, with its offer and price, how many entered, its
//   conversion and the share that came on from the stage before; the edges between stages carry the outcome that
//   leads there. Choosing a stage opens it beside the funnel: its numbers and the records counted in it, in the
//   shared record views. Ported from bitfield-packages packages/funnel-offer-graph/show/mount-funnel-canvas.tsx (its
//   StageBar and StageDrawer), reading a funnel row (stage-projection.ts funnelStages) instead of engine feeds.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Only what the funnel row and its facts say is drawn; an unmeasured stage says it has no visits yet.
//   2. Every element is a shared ui component or an SVG shape on the canvas; inline style is geometry only.
//   3. The drill-in's columns come from the records themselves; nothing here names a field.
//   4. Reference anatomy: Klaviyo and Calendly funnels (count, then share of the previous step, bars narrowing).

import React, { useMemo, useRef } from 'react';
import { Badge, Button, Card, Container, Text } from '../../ui';
import { RecordViews, type FieldDescriptor } from '../../ui/show/record-views/record-views';
import { CanvasView } from '../../graph-canvas/show/CanvasView';
import { useGraphCanvas } from '../../graph-canvas/show/use-graph-canvas';
import type { CanvasNodeFrame, EdgeRoute } from '../../graph-canvas/show/types';
import { CanvasArrowMarker, WorkflowEdge } from '../../workflow-canvas/show/WorkflowEdge';
import { layoutTornado, type Funnel, type FunnelStage } from '../read-data/stage-projection';

const money = (cents: number, recurring?: string, currency = 'USD') => `${cents === 0 ? 'Free' : (cents / 100).toLocaleString(undefined, { style: 'currency', currency, minimumFractionDigits: cents % 100 ? 2 : 0 })}${recurring && cents ? ` / ${recurring}` : ''}`;

function StageBar({ stage, selected, currency }: { stage: FunnelStage; selected: boolean; currency: string }) {
  const m = stage.measures;
  const converted = m.visits > 0 ? Math.min(1, m.conversions / m.visits) : 0;
  return (
    <Card data-funnel-stage={stage.id} variant="surface" padding="sm" height="full" selected={selected} style={{ width: '100%', height: '100%', position: 'relative', overflow: 'hidden' }}>
      <Container position="absolute" style={{ left: 0, top: 0, bottom: 0, width: `${Math.round(converted * 100)}%`, background: 'var(--accent-soft, rgba(80,140,255,0.16))', pointerEvents: 'none' }} />
      <Container layout="vertical" gap="xs" style={{ position: 'relative' }}>
        <Container layout="horizontal" gap="sm" alignItems="baseline" justifyContent="between">
          <Text variant="body-xs" weight="semibold" truncate title={stage.title}>{stage.title}</Text>
          <Text variant="caption">{money(stage.amount_cents, stage.recurring, currency)}</Text>
        </Container>
        <Container layout="horizontal" gap="md" alignItems="baseline">
          <Text variant="heading-xs">{m.visits ? `${m.conversion_rate}%` : 'No visits yet'}</Text>
          {m.visits ? <Text variant="caption">{m.visits.toLocaleString()} entered · {m.conversions.toLocaleString()} converted</Text> : null}
        </Container>
        <Container layout="horizontal" gap="xs" alignItems="center">
          {stage.from_previous !== null ? <Text variant="caption">{stage.from_previous}% of the step before</Text> : null}
          {stage.tested_price ? <Badge variant="accent" size="sm">Tested price</Badge> : null}
        </Container>
      </Container>
    </Card>
  );
}

function StageDrawer({ stage, currency, onClose }: { stage: FunnelStage; currency: string; onClose: () => void }) {
  const m = stage.measures;
  const fields: FieldDescriptor[] = useMemo(() => {
    const keys = [...new Set(stage.facts.flatMap(fact => Object.keys(fact)))].slice(0, 6);
    return keys.map(key => ({ id: key, label: key.replace(/[_-]+/g, ' ').replace(/^\w/, c => c.toUpperCase()), ruleKind: 'text', sortable: true, read: (row: Record<string, unknown>) => (typeof row[key] === 'object' ? JSON.stringify(row[key]) : String(row[key] ?? '')) }));
  }, [stage]);
  const stat = (label: string, value: string) => (
    <Container layout="vertical" gap="none"><Text variant="caption">{label}</Text><Text variant="body-xs" weight="semibold">{value}</Text></Container>
  );
  return (
    <Container position="absolute" zIndex="20" style={{ top: '12px', right: '12px', bottom: '12px', width: '420px', maxWidth: '92%' }} onPointerDown={(event: React.PointerEvent) => event.stopPropagation()}>
      <Card data-funnel-stage-detail={stage.id} variant="popover" padding="md" height="full" style={{ overflowY: 'auto' }}>
        <Container layout="vertical" gap="md">
          <Container layout="horizontal" justifyContent="between" alignItems="center">
            <Text variant="heading-xs" truncate>{stage.title}</Text>
            <Button size="sm" variant="ghost" onClick={onClose}>Close</Button>
          </Container>
          <Text variant="caption">{stage.offer} · {money(stage.amount_cents, stage.recurring, currency)}</Text>
          <Container layout="horizontal" gap="lg">
            {stat('Entered', m.visits.toLocaleString())}
            {stat('Converted', m.conversions.toLocaleString())}
            {stat('Conversion', `${m.conversion_rate}%`)}
            {m.revenue_cents ? stat('Revenue', money(m.revenue_cents, undefined, currency)) : null}
          </Container>
          {stage.next.length ? <Text variant="caption">{stage.next.map(t => `${t.on} leads to ${t.to}`).join(' · ')}</Text> : null}
          {stage.facts.length
            ? <RecordViews label={`${stage.title} records`} fields={fields} records={stage.facts} identify={(row: Record<string, unknown>) => String(row.id ?? stage.facts.indexOf(row))} views={[{ id: 'table', label: 'Table' }]} view="table" />
            : <Text variant="body-xs" color="muted">No records counted at this stage yet.</Text>}
        </Container>
      </Card>
    </Container>
  );
}

export function FunnelCanvas({ funnel }: { funnel: Funnel }): React.ReactElement {
  const canvasRef = useRef<HTMLDivElement>(null);
  const { frames, edges } = useMemo(() => layoutTornado(funnel.stages), [funnel]);
  const byId = useMemo(() => new Map(funnel.stages.map(stage => [stage.id, stage])), [funnel]);
  const graph = useGraphCanvas({ nodes: frames, canvasRef, enableNodeDrag: false });
  const at = useMemo(() => new Map(frames.map(frame => [frame.id, frame])), [frames]);
  const routes: EdgeRoute[] = useMemo(() => edges.flatMap(edge => {
    const from = at.get(edge.from);
    const to = at.get(edge.to);
    return from && to ? [{ edge_id: `${edge.from}->${edge.to}:${edge.on}`, points: [{ x: from.x + from.width / 2, y: from.y + from.height }, { x: to.x + to.width / 2, y: to.y }] }] : [];
  }), [edges, at]);
  const labels = useMemo(() => new Map(edges.map(edge => [`${edge.from}->${edge.to}:${edge.on}`, edge.on])), [edges]);
  const selected = graph.selectedNodeId ? byId.get(graph.selectedNodeId) ?? null : null;
  return (
    <CanvasView
      canvasRef={canvasRef}
      nodes={frames}
      edgeRoutes={routes}
      renderNode={(frame: CanvasNodeFrame) => { const stage = byId.get(frame.id); return stage ? <StageBar stage={stage} currency={funnel.currency} selected={graph.selectedNodeId === frame.id} /> : null; }}
      renderEdge={(route: EdgeRoute) => (
        <>
          <CanvasArrowMarker />
          <WorkflowEdge edgeId={route.edge_id} sourceX={route.points[0].x} sourceY={route.points[0].y} targetX={route.points[1].x} targetY={route.points[1].y} label={labels.get(route.edge_id) || undefined} />
        </>
      )}
      camera={graph.camera}
      selectedNodeId={graph.selectedNodeId}
      selectNode={graph.selectNode}
      onNodeSelect={id => graph.selectNode(id)}
      zoomToFit={graph.zoomToFit}
      onCanvasPointerDown={event => { if (!(event.target as HTMLElement).closest('[data-graph-node]')) graph.startCanvasPan(event.clientX, event.clientY); }}
      layout="tornado"
    >
      {selected ? <StageDrawer stage={selected} currency={funnel.currency} onClose={() => graph.selectNode(null)} /> : null}
    </CanvasView>
  );
}
