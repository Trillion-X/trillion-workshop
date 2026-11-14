// packages/workflow-canvas/show/WorkflowCanvas.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The Workflow Canvas surface: the living map of everything this product can
// do — every real trigger and action in the definition store, connected by
// the work they actually run — plus the full loop on top of it: move, search,
// focus a flow, inspect, edit, create, copy, and run with a live pulse.
//
// Reference anatomy (locked by the workflow-canvas screen contract):
// - Lindy Flow Editor: clean world canvas, node cards with port dots,
//   selected-node config panel on the right.
// - n8n: dot-grid world, bottom-left zoom/fit toolbar cluster, execution
//   status directly on nodes and edges.
// - FigJam: camera confidence — pan, pinch zoom, zoom-to-fit, minimap
//   wayfinding for large maps.
// - Zapier: plain human language everywhere.
//
// Composition:
//   feeds (useBitfieldData) → read-data decode/projection → graph-canvas
//   substrate (camera/drag/zoom) → WorkflowNodeCard / WorkflowEdge visuals →
//   NodeInspector + CanvasCommandOverlay + flow rail + toolbar + minimap as
//   overlays, CanvasDotGrid as the world background.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Durable truth lives in addressed feeds; this component holds only
//    ephemeral UI state (selection, drag, search, and run-pulse overrides).
//    The latest engine run state is projected from the workflow map onto nodes.
// 2. All writes go through do-work request builders to the owner.
// 3. ui primitives + tokens only; inline style limited to geometry.
// 4. The same surface works at 5 nodes or 5,000: deterministic auto-layout,
//    search, flow focus, and the minimap are structural, not bolted on.
// 5. Honest states: loading shows loading copy, empty shows empty copy — no
//    fake nodes ever (L117).
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Search as SearchIcon,
  X as CloseIcon,
} from 'lucide-react';
import { useGraphCanvas } from '../../graph-canvas/show/use-graph-canvas';
import {
  Button,
  Card,
  Container,
  Icon,
  Input,
  Spinner,
  Text,
} from '../../ui';
import { CanvasMinimap } from '../../ui/show/canvas-minimap';
import { useBitfieldData } from '#workspace-records';
import {
  createActionId,
  saveWorkflowCanvasActions,
  slugFromActionId,
  type WorkflowCanvasActionEdit,
} from '../do-work/save-workflow-canvas-actions';
import { saveWorkflowCanvasLayout } from '../do-work/save-workflow-canvas-layout';
import { deleteWorkflowCanvasDefinition } from '../do-work/delete-workflow-canvas-definition';
import { listWorkflowCanvasRuns } from '../do-work/list-workflow-canvas-runs';
import {
  runWorkflowCanvasDefinition,
  type WorkflowRunResult,
} from '../do-work/run-workflow-canvas-definition';
import { WorkflowNodeCard } from './WorkflowNodeCard';
import { WorkflowEdge, CanvasArrowMarker } from './WorkflowEdge';
import { NodeInspector, humanTriggerPayload, type SelectedActionDraft } from './NodeInspector';
import { NextStepPopover } from './NextStepPopover';
import { CanvasCommandOverlay } from './CanvasCommandOverlay';
import { CanvasView } from '../../graph-canvas/show/CanvasView';
import { CanvasEmptyState } from './CanvasEmptyState';
import { CanvasToolbar } from './CanvasToolbar';
import { isDeleteSelectedNodeIntent } from './canvas-shortcuts';
import { useCanvasHistory } from './use-canvas-history';
import type { CanvasNode, CanvasRunState } from './workflow-canvas-types';
import type { CanvasNodeFrame, EdgeRoute } from '../../graph-canvas/show/types';
import {
  decodeWorkflowCanvasFeed,
  humanizeIdentifier,
  knownWorkTargetCapabilities,
  knownWorkTargets,
  projectWorkflowCanvasFeed,
  NODE_HEIGHT,
  NODE_WIDTH,
  type WorkflowCanvasNodeKind,
  type WorkflowDefinitionRow,
} from '../read-data/read-workflow-canvas-layout';

// Vertical flow: edges leave the source's bottom-center and enter the
// target's top-center (Lindy/Zapier/n8n anatomy).
const EDGE_SOURCE_OFFSET_X = NODE_WIDTH / 2;
const EDGE_SOURCE_OFFSET_Y = NODE_HEIGHT;
const EDGE_TARGET_OFFSET_X = NODE_WIDTH / 2;
const EDGE_TARGET_OFFSET_Y = 0;
const RUN_PULSE_CLEAR_MS = 4000;
const ZOOM_STEP_FACTOR = 1.25;

export interface WorkflowCanvasProps {
  workflowId?: string;
  onNodeClick?: (nodeId: string) => void;
}

export const WorkflowCanvas: React.FC<WorkflowCanvasProps> = ({
  workflowId,
  onNodeClick,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const [nodeFrames, setNodeFrames] = useState<CanvasNodeFrame[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [focusFlowRootId, setFocusFlowRootId] = useState<string | null>(null);
  const [kindFilter, setKindFilter] = useState<string | null>(null);
  const [runStates, setRunStates] = useState<ReadonlyMap<string, CanvasRunState>>(new Map());
  const [showMinimap, setShowMinimap] = useState(true);
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  // Compact = the canvas element itself is narrow (container-driven, not
  // window-driven — the surface may share a screen with other panes).
  const isCompact = viewportSize.width > 0 && viewportSize.width < 640;
  const [railOpen, setRailOpen] = useState(false);
  /** Node id whose "add next step" popover is open (null = closed). */
  const [nextStepSourceId, setNextStepSourceId] = useState<string | null>(null);
  /** Right-click node menu (n8n/Lindy context menu): node + canvas-local point. */
  const [nodeMenu, setNodeMenu] = useState<{ nodeId: string; x: number; y: number } | null>(null);
  /** Monotonic signal: bump to ask the inspector to open its rename editor. */
  const [renameRequestId, setRenameRequestId] = useState(0);
  /** Monotonic signal: bump to ask the create overlay to open (empty-state CTA). */
  const [createRequestId, setCreateRequestId] = useState(0);
  /** Live connection drag (pull-a-line): source node + cursor world point. */
  const [connectDrag, setConnectDrag] = useState<{
    sourceId: string;
    worldX: number;
    worldY: number;
    targetId: string | null;
  } | null>(null);
  const connectDragRef = useRef(connectDrag);
  useEffect(() => {
    connectDragRef.current = connectDrag;
  }, [connectDrag]);
  const runClearTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // The node menu dismisses on any outside press or Escape — the menu card
  // itself stops pointerdown propagation, so this only sees outside presses.
  useEffect(() => {
    if (!nodeMenu) return;
    // Primary presses dismiss. Secondary presses don't — the SAME right-click
    // that re-targets the menu fires pointerdown(button 2) BEFORE contextmenu;
    // dismissing on it would close-then-reopen (or kill the menu entirely).
    const dismiss = (event: PointerEvent) => { if (event.button === 0) setNodeMenu(null); };
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setNodeMenu(null); };
    window.addEventListener('pointerdown', dismiss);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', dismiss);
      window.removeEventListener('keydown', onKey);
    };
  }, [nodeMenu]);

  // ---- feeds → graph (all engine-maintained projections, purely reactive) ----
  const triggerFactsEntry = useBitfieldData('workflow-canvas-triggers');
  const layoutFactsEntry = useBitfieldData('workflow-canvas-layout');
  const definitionRecordsEntry = useBitfieldData('workflow-canvas-definitions');

  // Honest loading: until any feed delivers, the map is loading — not empty.
  const feedsLoading = triggerFactsEntry == null
    && layoutFactsEntry == null
    && definitionRecordsEntry == null;

  const decodedFeed = useMemo(
    () => decodeWorkflowCanvasFeed(
      triggerFactsEntry,
      layoutFactsEntry,
      definitionRecordsEntry,
    ),
    [triggerFactsEntry, layoutFactsEntry, definitionRecordsEntry],
  );

  // Saves are real the moment the owner accepts them — the canvas reflects
  // them immediately with a local overlay while the feed catches up. The feed
  // remains the durable truth; overlay rows are superseded by feed rows on
  // the next feed delivery that contains them.
  const [localDefinitions, setLocalDefinitions] =
    useState<ReadonlyMap<string, WorkflowDefinitionRow>>(new Map());
  // Removals mirror the overlay: a deleted id disappears immediately and
  // stays hidden until the feed itself no longer carries the row.
  const [removedDefinitionIds, setRemovedDefinitionIds] =
    useState<ReadonlySet<string>>(new Set());

  const upsertLocalDefinition = useCallback((edit: WorkflowCanvasActionEdit) => {
    setLocalDefinitions((previous) => {
      const next = new Map(previous);
      next.set(edit.id, {
        id: edit.id,
        // Mirror the owner's slug derivation so the rename shows instantly.
        slug: edit.name?.trim()
          ? slugFromActionId(createActionId(edit.name))
          : slugFromActionId(edit.id),
        description: edit.description,
        isActive: edit.enabled,
        steps: edit.steps,
        edges: edit.edges ?? [],
        layout: { x: Math.round(edit.x), y: Math.round(edit.y) },
      });
      return next;
    });
  }, []);

  const feed = useMemo(() => {
    if (localDefinitions.size === 0 && removedDefinitionIds.size === 0) return decodedFeed;
    const merged = new Map(decodedFeed.definitions.map((row) => [row.id, row]));
    for (const [id, row] of localDefinitions) merged.set(id, row);
    for (const id of removedDefinitionIds) merged.delete(id);
    return { ...decodedFeed, definitions: [...merged.values()] };
  }, [decodedFeed, localDefinitions, removedDefinitionIds]);

  // Latest-feed mirror so undo/redo snapshots can read durable definition state
  // without re-creating every handler on each feed delivery.
  const feedRef = useRef(feed);
  useEffect(() => { feedRef.current = feed; }, [feed]);
  // Latest node frames (positions) for capturing a drag's prior placement.
  const nodeFramesRef = useRef(nodeFrames);
  useEffect(() => { nodeFramesRef.current = nodeFrames; }, [nodeFrames]);
  // Undo/redo — generic command history; every mutation records (before, after).
  const history = useCanvasHistory();

  const workTargets = useMemo(() => knownWorkTargets(feed), [feed]);
  const workCapabilities = useMemo(() => knownWorkTargetCapabilities(feed), [feed]);

  const { feedFrames, nodeDisplayById, edgeDisplayById, flows, nodeKindFacets } = useMemo(
    () => projectWorkflowCanvasFeed(feed, {
      focusId: focusFlowRootId ?? undefined,
      query: searchQuery,
      kind: kindFilter ?? undefined,
    }),
    [feed, focusFlowRootId, searchQuery, kindFilter],
  );

  const {
    camera,
    selectedNodeId,
    selectNode,
    draggedNodeId,
    draggedNodePosition,
    startCanvasPan,
    startNodeDrag,
    updateNodeDragPosition,
    endNodeDrag,
    zoomToFit,
    zoomBy,
    centerOnWorldPoint,
  } = useGraphCanvas({
    nodes: nodeFrames,
    canvasRef,
    enableNodeDrag: true,
  });

  useEffect(() => {
    setNodeFrames(feedFrames);
  }, [feedFrames]);

  // Land on a readable flow, not the full universe: on first delivery with
  // no user filter active, focus the largest flow (Lindy opens ON a flow).
  // 'Everything' stays one click away in the rail.
  const didDefaultFocus = useRef(false);
  useEffect(() => {
    if (didDefaultFocus.current || feedsLoading) return;
    if (focusFlowRootId || searchQuery.trim() || kindFilter) {
      didDefaultFocus.current = true;
      return;
    }
    if (flows.length === 0) return;
    didDefaultFocus.current = true;
    const largest = flows.reduce(
      (best, flow) => (flow.memberIds.length > best.memberIds.length ? flow : best),
      flows[0]!,
    );
    setFocusFlowRootId(largest.rootId);
  }, [feedsLoading, flows, focusFlowRootId, searchQuery, kindFilter]);

  // Track viewport size for the minimap's window rectangle.
  useEffect(() => {
    const element = canvasRef.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      setViewportSize({ width: element.clientWidth, height: element.clientHeight });
    });
    observer.observe(element);
    setViewportSize({ width: element.clientWidth, height: element.clientHeight });
    return () => observer.disconnect();
  }, [feedsLoading]);

  // Re-fit the camera when the visible set changes shape (filter/focus).
  const fitKey = `${focusFlowRootId ?? 'all'}::${searchQuery.trim().toLowerCase()}::${kindFilter ?? 'any'}`;
  const lastFitKey = useRef(fitKey);
  useEffect(() => {
    if (lastFitKey.current === fitKey) return;
    lastFitKey.current = fitKey;
    if (feedFrames.length > 0) zoomToFit(feedFrames);
  }, [fitKey, feedFrames, zoomToFit]);

  useEffect(() => () => {
    for (const timer of runClearTimers.current.values()) clearTimeout(timer);
  }, []);

  // Keyboard: Cmd/Ctrl+Z undo, Cmd/Ctrl+Shift+Z (or Ctrl+Y) redo. Ignored while
  // typing in a field so text editors keep their own native undo stack.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!event.metaKey && !event.ctrlKey) return;
      const key = event.key.toLowerCase();
      if (key !== 'z' && key !== 'y') return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        return;
      }
      const isRedo = key === 'y' || (key === 'z' && event.shiftKey);
      if (isRedo) {
        if (!history.canRedo) return;
        event.preventDefault();
        history.redo();
      } else {
        if (!history.canUndo) return;
        event.preventDefault();
        history.undo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // undo/redo are stable; re-subscribe only when the can-do flags flip.
  }, [history.undo, history.redo, history.canUndo, history.canRedo]);

  // ---- canvas nodes (frame + display) ----
  const canvasNodes: CanvasNode[] = useMemo(
    () => nodeFrames.flatMap((frame) => {
      const display = nodeDisplayById.get(frame.id);
      if (!display) return [];
      return [{
        id: frame.id,
        x: frame.x,
        y: frame.y,
        width: frame.width,
        height: frame.height,
        label: display.label,
        data: display,
      }];
    }),
    [nodeFrames, nodeDisplayById],
  );

  const selectedNode: CanvasNode | null = useMemo(() => {
    if (!selectedNodeId) return null;
    return canvasNodes.find((node) => node.id === selectedNodeId) ?? null;
  }, [canvasNodes, selectedNodeId]);

  // Lindy's per-field inject list: what the dispatching trigger actually
  // sends this action, one row per field. The dispatch template's `input`
  // object IS the action's input — its keys are the fields. Top-level
  // template keys are routing/plumbing (definition_id, operation, …), so
  // they only count when no `input` object exists.
  const selectedInputFields = useMemo(() => {
    if (!selectedNodeId) return [];
    const keys = new Set<string>();
    // Source 1: start events that dispatch this action declare what they send.
    for (const display of nodeDisplayById.values()) {
      if (!display.isStartEvent || !display.outputTemplate) continue;
      if (!display.runsDefinitionIds.includes(selectedNodeId)) continue;
      const template = display.outputTemplate;
      const input = template.input;
      const fieldSource = (input && typeof input === 'object' && !Array.isArray(input))
        ? input as Record<string, unknown>
        : humanTriggerPayload(template);
      for (const key of Object.keys(fieldSource)) {
        if (key !== 'definition_id' && key !== 'input') keys.add(key);
      }
    }
    // Source 2: fields the action's own steps already read from input —
    // a forked copy keeps these even though no trigger dispatches it yet.
    const selected = nodeDisplayById.get(selectedNodeId);
    const collectInputPaths = (value: unknown): void => {
      if (Array.isArray(value)) { value.forEach(collectInputPaths); return; }
      if (!value || typeof value !== 'object') return;
      const record = value as Record<string, unknown>;
      const select = record.select;
      if (record.$kind === 'binding' && select && typeof select === 'object') {
        const { from, path } = select as Record<string, unknown>;
        if (from === 'input' && typeof path === 'string' && path) {
          keys.add(path.split('.')[0]!);
        }
      }
      Object.values(record).forEach(collectInputPaths);
    };
    if (selected && !selected.isStartEvent) collectInputPaths(selected.steps);
    return [...keys].sort().map((key) => ({ key, label: humanizeIdentifier(key) }));
  }, [selectedNodeId, nodeDisplayById]);

  const edgeRoutes: EdgeRoute[] = useMemo(() => {
    const frameMap = new Map(nodeFrames.map((frame) => [frame.id, frame]));
    const routes: EdgeRoute[] = [];
    for (const edge of edgeDisplayById.values()) {
      const source = frameMap.get(edge.sourceId);
      const target = frameMap.get(edge.targetId);
      if (!source || !target) continue;
      routes.push({
        edge_id: edge.id,
        points: [
          { x: source.x + EDGE_SOURCE_OFFSET_X, y: source.y + EDGE_SOURCE_OFFSET_Y },
          { x: target.x + EDGE_TARGET_OFFSET_X, y: target.y + EDGE_TARGET_OFFSET_Y },
        ],
      });
    }
    return routes;
  }, [nodeFrames, edgeDisplayById]);

  // Live pull-a-line ghost: a synthetic route from the source's out port to
  // the cursor (or the hovered target's in port when one is valid).
  const liveRoutes: EdgeRoute[] = useMemo(() => {
    if (!connectDrag) return edgeRoutes;
    const source = nodeFrames.find((frame) => frame.id === connectDrag.sourceId);
    if (!source) return edgeRoutes;
    const target = connectDrag.targetId
      ? nodeFrames.find((frame) => frame.id === connectDrag.targetId)
      : null;
    return [...edgeRoutes, {
      edge_id: 'edge:connect-drag',
      points: [
        { x: source.x + EDGE_SOURCE_OFFSET_X, y: source.y + EDGE_SOURCE_OFFSET_Y },
        target
          ? { x: target.x + EDGE_TARGET_OFFSET_X, y: target.y + EDGE_TARGET_OFFSET_Y }
          : { x: connectDrag.worldX, y: connectDrag.worldY },
      ],
    }];
  }, [edgeRoutes, connectDrag, nodeFrames]);

  // ---- undo/redo command builders (one generic shape per mutation class) ----

  // A definition's reversible state is either PRESENT (a full edit we can
  // re-save) or ABSENT (a tombstone we can re-delete). Every create / edit /
  // delete / append-step reduces to a transition between two such snapshots —
  // no per-mutation revert closures (L069: one primitive, every mutation a
  // configuration of it).
  type DefinitionSnapshot =
    | { present: true; edit: WorkflowCanvasActionEdit }
    | { present: false; id: string };

  /** Faithful PRESENT snapshot of a saved definition's current durable state. */
  const definitionSnapshotById = useCallback((id: string): DefinitionSnapshot | null => {
    const row = feedRef.current.definitions.find((candidate) => candidate.id === id);
    if (!row) return null;
    const layout = (row.layout ?? {}) as Record<string, unknown>;
    return {
      present: true,
      edit: {
        id: row.id,
        // Pass the current slug as the name so a re-save re-derives the SAME
        // slug/label — undo restores the exact prior identity, not a fresh one.
        name: row.slug,
        description: row.description,
        steps: row.steps,
        edges: row.edges,
        enabled: row.isActive,
        x: Math.round(Number(layout.x ?? 0)),
        y: Math.round(Number(layout.y ?? 0)),
      },
    };
  }, []);

  /** Make a definition match a snapshot: re-save it, or retract it. */
  const applyDefinitionSnapshot = useCallback(async (snapshot: DefinitionSnapshot) => {
    if (snapshot.present) {
      await saveWorkflowCanvasActions({
        workflowId: workflowId ?? 'workflow:default',
        actions: [snapshot.edit],
      });
      // Clear any tombstone so a re-created node reappears immediately.
      setRemovedDefinitionIds((previous) => {
        if (!previous.has(snapshot.edit.id)) return previous;
        const next = new Set(previous);
        next.delete(snapshot.edit.id);
        return next;
      });
      upsertLocalDefinition(snapshot.edit);
      return;
    }
    await deleteWorkflowCanvasDefinition({
      actionId: snapshot.id,
      workflowId: workflowId ?? 'workflow:default',
    });
    setLocalDefinitions((previous) => {
      if (!previous.has(snapshot.id)) return previous;
      const next = new Map(previous);
      next.delete(snapshot.id);
      return next;
    });
    setRemovedDefinitionIds((previous) => new Set([...previous, snapshot.id]));
  }, [upsertLocalDefinition, workflowId]);

  /** Record an already-applied definition transition for undo/redo. */
  const recordDefinitionChange = useCallback(
    (before: DefinitionSnapshot, after: DefinitionSnapshot) => {
      history.record({
        apply: () => applyDefinitionSnapshot(after),
        revert: () => applyDefinitionSnapshot(before),
      });
    },
    // history.record is stable (the hook memoizes it); only canUndo/canRedo
    // change identity, so depend on the member, not the wrapper — keeps the
    // five mutation handlers stable across renders.
    [history.record, applyDefinitionSnapshot],
  );

  /** Move a node to a position (shared by drag, undo, and redo). */
  const applyNodePosition = useCallback(async (
    nodeId: string,
    kind: WorkflowCanvasNodeKind,
    x: number,
    y: number,
  ) => {
    // Save FIRST and do NOT swallow — a failed durable write throws, so the
    // history layer (which awaits this) catches it and leaves the stack
    // unchanged, and the frame never moves on failure. Undo/redo of a move thus
    // stays atomic with the persisted position (round-13 atomicity, for layout).
    await saveWorkflowCanvasLayout({ subjectId: nodeId, kind, x, y });
    setNodeFrames((previous) =>
      previous.map((frame) => (frame.id === nodeId ? { ...frame, x, y } : frame)));
  }, []);

  /** Record an already-applied node move for undo/redo. */
  const recordLayoutChange = useCallback(
    (
      nodeId: string,
      kind: WorkflowCanvasNodeKind,
      before: { x: number; y: number },
      after: { x: number; y: number },
    ) => {
      history.record({
        apply: () => applyNodePosition(nodeId, kind, after.x, after.y),
        revert: () => applyNodePosition(nodeId, kind, before.x, before.y),
      });
    },
    [history.record, applyNodePosition],
  );

  // ---- intents ----

  const handleNodeSelect = useCallback((nodeId: string) => {
    selectNode(nodeId);
    onNodeClick?.(nodeId);
  }, [onNodeClick, selectNode]);

  const handleNodeDragEnd = useCallback(async (
    nodeId: string,
    position: { x: number; y: number },
  ) => {
    const display = nodeDisplayById.get(nodeId);
    const previousFrame = nodeFramesRef.current.find((frame) => frame.id === nodeId);
    const before = previousFrame ? { x: previousFrame.x, y: previousFrame.y } : null;
    const x = Math.round(position.x);
    const y = Math.round(position.y);
    // Optimistic: the node followed the cursor during the drag; settle it on the
    // rounded grid position immediately so the drop feels instant.
    setNodeFrames((previous) =>
      previous.map((frame) => (frame.id === nodeId ? { ...frame, x, y } : frame)));
    if (!display) return;
    // No-op drag (dropped where it started) — nothing to persist or record.
    if (before && before.x === x && before.y === y) return;
    try {
      await saveWorkflowCanvasLayout({ subjectId: nodeId, kind: display.kind, x, y });
    } catch (error) {
      // The durable write failed — undo the optimistic move so the canvas never
      // shows a position the store doesn't hold, and record nothing. History
      // stays atomic with persisted state (round-17 layout atomicity).
      console.error('[WorkflowCanvas] Could not save the new position:', error);
      if (before) {
        setNodeFrames((previous) =>
          previous.map((frame) => (frame.id === nodeId
            ? { ...frame, x: before.x, y: before.y }
            : frame)));
      }
      return;
    }
    // Record only a real, PERSISTED move so undo/redo matches the durable state.
    if (before) {
      recordLayoutChange(nodeId, display.kind, before, { x, y });
    }
  }, [nodeDisplayById, recordLayoutChange]);

  const handleSelectedActionSave = useCallback(async (draft: SelectedActionDraft) => {
    const before = definitionSnapshotById(draft.id);
    const frame = nodeFrames.find((candidate) => candidate.id === draft.id);
    const description = draft.description.trim().length > 0
      ? draft.description.trim()
      : null;
    const edit: WorkflowCanvasActionEdit = {
      id: draft.id,
      name: draft.name.trim() || undefined,
      description,
      steps: draft.steps,
      edges: draft.edges,
      enabled: draft.enabled,
      x: Math.round(frame?.x ?? 0),
      y: Math.round(frame?.y ?? 0),
    };
    await saveWorkflowCanvasActions({
      workflowId: workflowId ?? 'workflow:default',
      actions: [edit],
    });
    upsertLocalDefinition(edit);
    if (before) recordDefinitionChange(before, { present: true, edit });
  }, [nodeFrames, upsertLocalDefinition, workflowId, definitionSnapshotById, recordDefinitionChange]);

  const setRunState = useCallback((nodeId: string, state: CanvasRunState | null) => {
    setRunStates((previous) => {
      const next = new Map(previous);
      if (state === null) next.delete(nodeId);
      else next.set(nodeId, state);
      return next;
    });
  }, []);

  const handleRun = useCallback(async (definitionId: string): Promise<WorkflowRunResult> => {
    const existingTimer = runClearTimers.current.get(definitionId);
    if (existingTimer) clearTimeout(existingTimer);
    setRunState(definitionId, 'running');
    try {
      const result = await runWorkflowCanvasDefinition({ definitionId });
      setRunState(definitionId, result.status === 'completed' ? 'completed' : result.status === 'failed' ? 'failed' : 'running');
      return result;
    } catch (error) {
      setRunState(definitionId, 'failed');
      throw error;
    } finally {
      runClearTimers.current.set(definitionId, setTimeout(() => {
        setRunState(definitionId, null);
        runClearTimers.current.delete(definitionId);
      }, RUN_PULSE_CLEAR_MS));
    }
  }, [setRunState]);

  const handleFork = useCallback(async (node: CanvasNode) => {
    const existing = new Set(canvasNodes.map((candidate) => candidate.id));
    const base = createActionId(`${node.label} copy`);
    let copyId = base;
    let suffix = 2;
    while (existing.has(copyId)) {
      copyId = `${base}-${suffix}`;
      suffix += 1;
    }
    const edit: WorkflowCanvasActionEdit = {
      id: copyId,
      description: node.data.description,
      steps: node.data.steps,
      edges: node.data.edges,
      enabled: node.data.enabled,
      x: Math.round(node.x + 48),
      y: Math.round(node.y + NODE_HEIGHT + 40),
    };
    await saveWorkflowCanvasActions({
      workflowId: workflowId ?? 'workflow:default',
      actions: [edit],
    });
    upsertLocalDefinition(edit);
    // Undo of a fork is a delete of the copy (before = it didn't exist).
    recordDefinitionChange({ present: false, id: copyId }, { present: true, edit });
    // The copy is not a member of any focused flow yet — reveal it.
    setFocusFlowRootId(null);
    selectNode(copyId);
  }, [canvasNodes, selectNode, upsertLocalDefinition, workflowId, recordDefinitionChange]);

  /** Remove a canvas-owned action: owner retracts every record, node leaves. */
  const handleDelete = useCallback(async (node: CanvasNode) => {
    // Capture the full record BEFORE retraction so undo can re-create it.
    const before = definitionSnapshotById(node.id);
    await deleteWorkflowCanvasDefinition({
      actionId: node.id,
      workflowId: workflowId ?? 'workflow:default',
    });
    setLocalDefinitions((previous) => {
      if (!previous.has(node.id)) return previous;
      const next = new Map(previous);
      next.delete(node.id);
      return next;
    });
    setRemovedDefinitionIds((previous) => new Set([...previous, node.id]));
    selectNode(null);
    if (before) recordDefinitionChange(before, { present: false, id: node.id });
  }, [selectNode, workflowId, definitionSnapshotById, recordDefinitionChange]);

  // Delete / Backspace removes the selected node — every canvas editor's
  // expectation. The pure decision (canvas-shortcuts) guards against deleting
  // while typing and only removes an editable node (capability flag, not kind).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (!isDeleteSelectedNodeIntent({
        key: event.key,
        targetTag: target?.tagName ?? null,
        isContentEditable: Boolean(target?.isContentEditable),
        hasSelection: selectedNode !== null,
        selectedEditable: selectedNode?.data.editable ?? false,
      })) return;
      event.preventDefault();
      if (selectedNode) void handleDelete(selectedNode);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedNode, handleDelete]);

  // ---- drag-to-connect (n8n/Zapier pull-a-line) ----

  /** Append a 'run that action' step on the source — same path as the popover. */
  const appendRunStep = useCallback(async (sourceId: string, targetId: string) => {
    const source = nodeDisplayById.get(sourceId);
    const frame = nodeFrames.find((candidate) => candidate.id === sourceId);
    if (!source || !source.canChain) return;
    const before = definitionSnapshotById(sourceId);
    const edit: WorkflowCanvasActionEdit = {
      id: sourceId,
      description: source.description,
      steps: [...source.steps, {
        kind: 'action',
        config: { definition_id: targetId, inputs: {} },
      }],
      edges: source.edges,
      enabled: source.enabled,
      x: Math.round(frame?.x ?? 0),
      y: Math.round(frame?.y ?? 0),
    };
    await saveWorkflowCanvasActions({
      workflowId: workflowId ?? 'workflow:default',
      actions: [edit],
    });
    upsertLocalDefinition(edit);
    if (before) recordDefinitionChange(before, { present: true, edit });
  }, [nodeDisplayById, nodeFrames, upsertLocalDefinition, workflowId, definitionSnapshotById, recordDefinitionChange]);

  const screenToWorld = useCallback((clientX: number, clientY: number) => {
    const element = canvasRef.current;
    if (!element) return { x: 0, y: 0 };
    const rect = element.getBoundingClientRect();
    return {
      x: (clientX - rect.left - camera.pan_x) / camera.zoom,
      y: (clientY - rect.top - camera.pan_y) / camera.zoom,
    };
  }, [camera]);

  const hitTestNode = useCallback((worldX: number, worldY: number): string | null => {
    for (const frame of nodeFrames) {
      if (worldX >= frame.x && worldX <= frame.x + frame.width
        && worldY >= frame.y && worldY <= frame.y + frame.height) {
        return frame.id;
      }
    }
    return null;
  }, [nodeFrames]);

  const handleStartConnect = useCallback((sourceId: string, event: React.PointerEvent) => {
    const start = screenToWorld(event.clientX, event.clientY);
    setConnectDrag({ sourceId, worldX: start.x, worldY: start.y, targetId: null });

    const handleMove = (moveEvent: PointerEvent) => {
      const point = screenToWorld(moveEvent.clientX, moveEvent.clientY);
      const over = hitTestNode(point.x, point.y);
      const target = over && over !== sourceId
        && nodeDisplayById.get(over)?.hasInPort ? over : null;
      setConnectDrag({ sourceId, worldX: point.x, worldY: point.y, targetId: target });
    };
    const handleUp = () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
      const final = connectDragRef.current;
      setConnectDrag(null);
      if (final?.targetId) {
        void appendRunStep(final.sourceId, final.targetId);
      }
    };
    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
  }, [screenToWorld, hitTestNode, nodeDisplayById, appendRunStep]);

  // ---- inline "add next step" (Lindy popover) ----

  /** Append one real step to the source action through the owner save path.
      The new edge appears automatically — edges are derived from steps. */
  const handlePickNextStep = useCallback(async (step: unknown) => {
    const sourceId = nextStepSourceId;
    setNextStepSourceId(null);
    if (!sourceId) return;
    const source = nodeDisplayById.get(sourceId);
    const frame = nodeFrames.find((candidate) => candidate.id === sourceId);
    if (!source || !source.canChain) return;
    const before = definitionSnapshotById(sourceId);
    const edit: WorkflowCanvasActionEdit = {
      id: sourceId,
      description: source.description,
      steps: [...source.steps, step],
      edges: source.edges,
      enabled: source.enabled,
      x: Math.round(frame?.x ?? 0),
      y: Math.round(frame?.y ?? 0),
    };
    await saveWorkflowCanvasActions({
      workflowId: workflowId ?? 'workflow:default',
      actions: [edit],
    });
    upsertLocalDefinition(edit);
    if (before) recordDefinitionChange(before, { present: true, edit });
  }, [nextStepSourceId, nodeDisplayById, nodeFrames, upsertLocalDefinition, workflowId, definitionSnapshotById, recordDefinitionChange]);

  /** Screen-space anchor for the popover: under the source node's + circle. */
  const nextStepAnchor = useMemo(() => {
    if (!nextStepSourceId) return null;
    const frame = nodeFrames.find((candidate) => candidate.id === nextStepSourceId);
    if (!frame) return null;
    return {
      x: (frame.x + frame.width / 2) * camera.zoom + camera.pan_x,
      y: (frame.y + frame.height + 36) * camera.zoom + camera.pan_y,
    };
  }, [nextStepSourceId, nodeFrames, camera]);

  const nextStepActionOptions = useMemo(
    () => canvasNodes
      .filter((node) => node.data.runnable && node.id !== nextStepSourceId)
      .map((node) => ({ id: node.id, label: node.label }))
      .sort((left, right) => left.label.localeCompare(right.label)),
    [canvasNodes, nextStepSourceId],
  );

  // Drop spot for newly created actions: just right of the rightmost node.
  const nextCreatePosition = useMemo(() => {
    if (nodeFrames.length === 0) return { x: 80, y: 80 };
    const rightmost = nodeFrames.reduce(
      (best, frame) => (frame.x > best.x ? frame : best),
      nodeFrames[0]!,
    );
    return { x: Math.round(rightmost.x + NODE_WIDTH + 100), y: Math.round(rightmost.y) };
  }, [nodeFrames]);

  // ---- renderers ----

  const renderNode = useCallback((frame: CanvasNodeFrame) => {
    const display = nodeDisplayById.get(frame.id);
    if (!display) return null;
    const canChain = display.canChain;
    return (
      <WorkflowNodeCard
        display={display}
        isSelected={selectedNodeId === frame.id}
        runState={runStates.get(frame.id) ?? null}
        isConnectTarget={connectDrag?.targetId === frame.id}
        onAddNextStep={canChain
          ? () => setNextStepSourceId((current) => (current === frame.id ? null : frame.id))
          : undefined}
        onStartConnect={canChain
          ? (event) => handleStartConnect(frame.id, event)
          : undefined}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          const rect = canvasRef.current?.getBoundingClientRect();
          setNodeMenu({
            nodeId: frame.id,
            x: event.clientX - (rect?.left ?? 0),
            y: event.clientY - (rect?.top ?? 0),
          });
        }}
      />
    );
  }, [selectedNodeId, nodeDisplayById, runStates, connectDrag, handleStartConnect]);

  const renderEdge = useCallback((route: EdgeRoute, isSelected?: boolean) => {
    const edge = edgeDisplayById.get(route.edge_id);
    const [source, target] = route.points;
    if (!source || !target) return null;
    // The live pull-a-line ghost renders in the accent 'active' state.
    if (route.edge_id === 'edge:connect-drag') {
      return (
        <>
          <CanvasArrowMarker />
          <WorkflowEdge
            edgeId={route.edge_id}
            sourceX={source.x}
            sourceY={source.y}
            targetX={target.x}
            targetY={target.y}
            runStatus="active"
          />
        </>
      );
    }
    // The executed path lights up: a running source animates its outgoing
    // edges; completed/failed sources freeze them in the status color.
    const sourceRun = edge
      ? runStates.get(edge.sourceId) ?? nodeDisplayById.get(edge.sourceId)?.runState ?? null
      : null;
    const runStatus = sourceRun === 'running'
      ? 'active' as const
      : sourceRun === 'completed'
        ? 'completed' as const
        : sourceRun === 'failed'
          ? 'failed' as const
          : null;
    // A condition can only be added where the source action is editable (a
    // capability flag, never a node-kind check). WorkflowEdge reveals the pill
    // on hover and only when the edge has no label — so a conditioned/otherwise
    // edge or a non-editable source never offers it.
    const sourceEditable = edge ? nodeDisplayById.get(edge.sourceId)?.editable ?? false : false;
    return (
      <>
        <CanvasArrowMarker />
        <WorkflowEdge
          edgeId={route.edge_id}
          sourceX={source.x}
          sourceY={source.y}
          targetX={target.x}
          targetY={target.y}
          label={edge?.label}
          isSelected={isSelected}
          runStatus={runStatus}
          onSelect={(id) => selectNode(id)}
          affordanceLabel={sourceEditable && edge && !edge.label ? 'Define a condition' : undefined}
          onAffordance={edge ? () => selectNode(edge.sourceId) : undefined}
        />
      </>
    );
  }, [selectNode, edgeDisplayById, runStates, nodeDisplayById]);

  const totalCount = nodeDisplayById.size;
  const zoomPercent = Math.round(camera.zoom * 100);

  // ---- honest loading state (before any feed has delivered) ----
  if (feedsLoading) {
    return (
      <Container
        ref={containerRef}
        data-workflow-canvas-loading="true"
        height="full"
        width="full"
        flex={1}
        minHeight="0"
        layout="vertical"
        alignItems="center"
        justifyContent="center"
        overflow="hidden"
      >
        <Container layout="vertical" gap="md" alignItems="center">
          <Spinner size="md" aria-label="Loading workflows" />
          <Text variant="body-xs" color="muted">Loading workflows…</Text>
        </Container>
      </Container>
    );
  }

  return (
    <CanvasView
      containerRef={containerRef}
      canvasRef={canvasRef}
      nodes={nodeFrames}
      edgeRoutes={liveRoutes}
      onNodeDragEnd={handleNodeDragEnd}
      onNodeSelect={handleNodeSelect}
      renderNode={renderNode}
      renderEdge={renderEdge}
      engineState="ready"
      engineError={null}
      camera={camera}
      selectedNodeId={selectedNodeId}
      draggedNodeId={draggedNodeId}
      draggedNodePosition={draggedNodePosition}
      selectNode={selectNode}
      startNodeDrag={startNodeDrag}
      updateNodeDragPosition={updateNodeDragPosition}
      endNodeDrag={endNodeDrag}
      zoomToFit={zoomToFit}
      onCanvasPointerDown={(event) => {
        const target = event.target as HTMLElement;
        if (!target.closest('[data-graph-node]')) {
          setNextStepSourceId(null);
          startCanvasPan(event.clientX, event.clientY);
        }
      }}
      emptyState={
        <CanvasEmptyState
          filtered={Boolean(searchQuery.trim() || focusFlowRootId || kindFilter)}
          onStart={() => setCreateRequestId((current) => current + 1)}
          onClearFilters={() => {
            setSearchQuery('');
            setFocusFlowRootId(null);
            setKindFilter(null);
          }}
        />
      }
    >

        {/* Flow rail: search + focus. On compact viewports the rail starts
            collapsed to one button so the graph owns the screen (Lindy's
            mobile anatomy: canvas first, chrome on demand). */}
        {isCompact && !railOpen && (
          <Container
            position="absolute"
            zIndex="10"
            style={{ top: '1rem', left: '1rem' }}
            onPointerDown={(event: React.PointerEvent) => event.stopPropagation()}
            onClick={(event: React.MouseEvent) => event.stopPropagation()}
          >
            <Card variant="popover" padding="sm">
              <Button
                variant="ghost"
                size="sm"
                data-workflow-rail-open="true"
                onClick={() => setRailOpen(true)}
              >
                <Container layout="horizontal" gap="sm" alignItems="center">
                  <Icon icon={SearchIcon} size="xs" color="secondary" />
                  <Text variant="body-xs">Find a workflow</Text>
                </Container>
              </Button>
            </Card>
          </Container>
        )}
        <Container
          data-workflow-flow-rail="true"
          position="absolute"
          zIndex="10"
          style={isCompact
            ? (railOpen
              ? { top: '1rem', left: '1rem', right: '1rem' }
              : { display: 'none' })
            : { top: '1rem', left: '1rem', width: '248px' }}
          onPointerDown={(event: React.PointerEvent) => event.stopPropagation()}
          onClick={(event: React.MouseEvent) => event.stopPropagation()}
        >
          <Card variant="popover" padding="sm">
            <Container layout="vertical" gap="sm">
              <Container layout="horizontal" gap="xs" alignItems="center">
                <Container flex={1} style={{ minWidth: 0 }}>
                  <Input
                    aria-label="Search"
                    placeholder="Search workflows"
                    value={searchQuery}
                    onChange={(event) => setSearchQuery(event.target.value)}
                  />
                </Container>
                {isCompact && (
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label="Close search"
                    onClick={() => setRailOpen(false)}
                  >
                    <Icon icon={CloseIcon} size="xs" />
                  </Button>
                )}
              </Container>
              {/* Kind chips: All / Starts (triggers) / Does work (actions). */}
              <Container layout="horizontal" gap="xs" data-workflow-kind-chips="true">
                <Button
                  variant="ghost"
                  size="sm"
                  active={kindFilter === null}
                  onClick={() => setKindFilter(null)}
                >
                  All
                </Button>
                {/* Facets come from read-data (the distinct kinds present) — the
                    toolbar never names 'trigger'/'action', so a new node kind
                    gets its own chip with zero edits here (L090/L063). */}
                {nodeKindFacets.map((facet) => (
                  <Button
                    key={facet.value}
                    variant="ghost"
                    size="sm"
                    active={kindFilter === facet.value}
                    onClick={() => setKindFilter(kindFilter === facet.value ? null : facet.value)}
                  >
                    {facet.label}
                  </Button>
                ))}
              </Container>
              <Container
                layout="vertical"
                gap="xs"
                overflow="auto"
                style={{ maxHeight: '40vh' }}
              >
                <Button
                  variant="ghost"
                  size="sm"
                  active={focusFlowRootId === null}
                  onClick={() => setFocusFlowRootId(null)}
                >
                  <Container layout="horizontal" gap="sm" alignItems="center" width="full">
                    <Container flex={1} style={{ minWidth: 0, textAlign: 'left' }}>
                      <Text variant="body-xs" truncate>Everything</Text>
                    </Container>
                    <Text variant="caption" color="muted">{totalCount}</Text>
                  </Container>
                </Button>
                {flows.map((flow) => (
                  <Button
                    key={flow.id}
                    variant="ghost"
                    size="sm"
                    active={focusFlowRootId === flow.rootId}
                    onClick={() => setFocusFlowRootId(
                      focusFlowRootId === flow.rootId ? null : flow.rootId,
                    )}
                  >
                    <Container layout="horizontal" gap="sm" alignItems="center" width="full">
                      <Container flex={1} style={{ minWidth: 0, textAlign: 'left' }}>
                        <Text variant="body-xs" truncate title={flow.label}>
                          {flow.label}
                        </Text>
                      </Container>
                      <Text variant="caption" color="muted">{flow.memberIds.length}</Text>
                    </Container>
                  </Button>
                ))}
              </Container>
            </Container>
          </Card>
        </Container>

        {/* Canvas toolbar: history (undo/redo) + camera (zoom / fit / minimap)
            as grouped pills — the n8n-style bottom-left cluster. Redo disables
            when there is nothing to redo (Lindy Flow editor anatomy). */}
        <Container
          data-workflow-canvas-toolbar="true"
          position="absolute"
          zIndex="10"
          style={{ bottom: '1rem', left: '1rem' }}
          onPointerDown={(event: React.PointerEvent) => event.stopPropagation()}
          onClick={(event: React.MouseEvent) => event.stopPropagation()}
        >
          <CanvasToolbar
            canUndo={history.canUndo}
            canRedo={history.canRedo}
            onUndo={history.undo}
            onRedo={history.redo}
            zoomPercent={zoomPercent}
            onZoomIn={() => zoomBy(ZOOM_STEP_FACTOR)}
            onZoomOut={() => zoomBy(1 / ZOOM_STEP_FACTOR)}
            onFit={() => nodeFrames.length > 0 && zoomToFit(nodeFrames)}
            showMinimap={showMinimap}
            onToggleMinimap={() => setShowMinimap((current) => !current)}
          />
        </Container>

        {/* Minimap: FigJam-style wayfinding for large maps. */}
        {showMinimap && nodeFrames.length > 0 && viewportSize.width > 0 && (
          <Container
            data-workflow-canvas-minimap="true"
            position="absolute"
            zIndex="10"
            style={{ bottom: '1rem', right: '1rem' }}
            onPointerDown={(event: React.PointerEvent) => event.stopPropagation()}
            onClick={(event: React.MouseEvent) => event.stopPropagation()}
          >
            <Card variant="popover" padding="xs">
              <CanvasMinimap
                frames={nodeFrames}
                panX={camera.pan_x}
                panY={camera.pan_y}
                zoom={camera.zoom}
                viewportWidth={viewportSize.width}
                viewportHeight={viewportSize.height}
                selectedId={selectedNodeId}
                onJump={centerOnWorldPoint}
              />
            </Card>
          </Container>
        )}

        {/* Lindy "Select next step": anchored under the source node's +. */}
        {nextStepSourceId && nextStepAnchor && (
          <NextStepPopover
            anchorX={nextStepAnchor.x}
            anchorY={nextStepAnchor.y}
            actionOptions={nextStepActionOptions}
            workTargets={workTargets}
            workCapabilities={workCapabilities}
            onPick={handlePickNextStep}
            onClose={() => setNextStepSourceId(null)}
          />
        )}

        {/* Right-click node menu — n8n/Lindy context menu. Canvas-local
            coordinates; every row is a real intent (no dead items, L114). */}
        {nodeMenu && (() => {
          const menuDisplay = nodeDisplayById.get(nodeMenu.nodeId);
          if (!menuDisplay) return null;
          const closeMenu = () => setNodeMenu(null);
          const menuNode = canvasNodes.find((candidate) => candidate.id === nodeMenu.nodeId) ?? null;
          return (
            <Card
              variant="popover"
              padding="sm"
              data-workflow-node-menu="true"
              style={{
                position: 'absolute',
                left: `${Math.min(nodeMenu.x, Math.max(0, viewportSize.width - 200))}px`,
                top: `${Math.min(nodeMenu.y, Math.max(0, viewportSize.height - 180))}px`,
                zIndex: 40,
                minWidth: '180px',
              }}
              onPointerDown={(event) => event.stopPropagation()}
            >
              <Container layout="vertical" gap="none">
                {menuDisplay.runnable && (
                  <Button
                    variant="ghost"
                    size="nav"
                    onClick={() => { closeMenu(); selectNode(nodeMenu.nodeId); void handleRun(nodeMenu.nodeId); }}
                  >
                    Run now
                  </Button>
                )}
                {menuDisplay.runnable && (
                  <Button
                    variant="ghost"
                    size="nav"
                    onClick={() => { closeMenu(); if (menuNode) void handleFork(menuNode); }}
                  >
                    Make a copy
                  </Button>
                )}
                {menuDisplay.editable && (
                  <Button
                    variant="ghost"
                    size="nav"
                    onClick={() => {
                      closeMenu();
                      selectNode(nodeMenu.nodeId);
                      setRenameRequestId((current) => current + 1);
                    }}
                  >
                    Rename
                  </Button>
                )}
                {menuDisplay.editable && (
                  <Button
                    variant="ghost"
                    size="nav"
                    color="danger"
                    onClick={() => { closeMenu(); if (menuNode) void handleDelete(menuNode); }}
                  >
                    Remove
                  </Button>
                )}
              </Container>
            </Card>
          );
        })()}

        <NodeInspector
          node={selectedNode}
          availableActions={canvasNodes}
          workTargets={workTargets}
          workCapabilities={workCapabilities}
          renameRequestId={renameRequestId}
          inputFields={selectedInputFields}
          onClose={() => selectNode(null)}
          onSave={handleSelectedActionSave}
          onRun={handleRun}
          onNavigate={(nodeId) => selectNode(nodeId)}
          onFork={handleFork}
          onDelete={handleDelete}
          onListRuns={(definitionId) => listWorkflowCanvasRuns({ definitionId })}
        />
        <CanvasCommandOverlay
          workflowId={workflowId}
          nodes={canvasNodes}
          selectedNodeId={selectedNodeId}
          workTargets={workTargets}
          workCapabilities={workCapabilities}
          nextPosition={nextCreatePosition}
          openSignal={createRequestId}
          onCreated={(edit) => {
            upsertLocalDefinition(edit);
            // Undo of a create is a delete of the new node (before = absent) —
            // the same shape as fork, so create joins the one undo history.
            recordDefinitionChange({ present: false, id: edit.id }, { present: true, edit });
            // A focused flow would HIDE the new node (it is not a member
            // yet) — show everything so the user sees what they just made.
            setFocusFlowRootId(null);
            setSearchQuery('');
            setKindFilter(null);
            selectNode(edit.id);
          }}
        />
    </CanvasView>
  );
};
