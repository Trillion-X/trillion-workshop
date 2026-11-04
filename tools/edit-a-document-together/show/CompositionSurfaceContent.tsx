'use client';

import * as React from 'react';
import { Container, ErrorBoundary, Spinner, Text } from '../../ui';
import {
  SceneNodeView,
  type SceneNodeViewProps,
  DOCUMENTS_SURFACE_CSS,
  type CompositionSnapshot,
  type AutoformatMatch,
  type CursorCommand,
  type InlineMark,
} from './DocumentsSurface';
import { type InputShortcut } from '../read-data/documents';

/**
 * CompositionSurfaceContent
 *
 * Reusable rich composition canvas renderer. Renders scene blocks via SceneNodeView
 * with optional workspace chrome suppression and edit affordance gating.
 *
 * When canEdit=false, all mutation handlers are replaced with no-ops, rendering
 * the composition in a read-only state without drag handles, selection chrome, or
 * interaction affordances.
 *
 * When hideWorkspaceChrome=true, the sidebar, toolbar, and empty-state messages
 * are suppressed, showing only the canvas content.
 */

type CompositionSurfaceContentProps = Omit<SceneNodeViewProps, 'node' | 'snapshot' | 'rootId'> & {
  /** The composition snapshot (tree, frames, camera state, etc.) */
  snapshot: CompositionSnapshot;
  /** The framed page/root node ID to render */
  framedNodeId: string | null;
  /** When true, suppress sidebar/toolbar/empty-state; show only canvas */
  hideWorkspaceChrome?: boolean;
  /** Optional overlay rendered INSIDE the scrolling stage (drop indicators,
   *  drag ghosts). Scrolls with the content; the caller owns its meaning. */
  stageOverlay?: React.ReactNode;
  /** When false, replace all handlers with no-ops (read-only rendering) */
  canEdit?: boolean;
  /** Authored edge metadata paired with kernel-routed visible edge geometry. */
  authoredEdges?: readonly { edge_id: string; label?: string }[];
};

/**
 * No-op handlers for read-only rendering
 */
const NOOP_SELECT = () => undefined;
const NOOP_TEXT_CHANGE = () => undefined;
const NOOP_AUTOFORMAT = () => null;
const NOOP_MATCH_SHORTCUT = () => null;
const NOOP_DISPATCH_SHORTCUT = () => false;
const NOOP_OPEN_COMPOSER = () => false;
const NOOP_TEXT_FOCUS = () => undefined;
const NOOP_ESCAPE = () => undefined;
const NOOP_INSERT_BESIDE = () => undefined;
const NOOP_MERGE_BACKWARD = () => false;
const NOOP_CREATE_COMPONENT = () => undefined;
const NOOP_ADD_BLOCK_BELOW = () => undefined;
const NOOP_MEASURE_TEXT = () => undefined;
const NOOP_REMOVE_BLOCK = () => undefined;
const NOOP_BEGIN_DRAG = () => undefined;
const NOOP_START_CONNECT = () => undefined;
const NOOP_NOTE_ACTION = () => undefined;
const NOOP_RESIZE_FRAME = () => undefined;
const NOOP_SPLIT_DRAG_START = () => undefined;
const NOOP_SPLIT_DRAG = () => undefined;
const NOOP_EDIT_VIS = () => undefined;
const NOOP_EDIT_SPACING = () => undefined;
const NOOP_FLOAT_NODE = () => undefined;
const NOOP_COLLAPSE_PANEL = () => undefined;
const NOOP_EXPAND_PANEL = () => undefined;
const NOOP_INSERT_TABLE_ROW = () => undefined;
const NOOP_REMOVE_TABLE_ROW = () => undefined;
const NOOP_INSERT_TABLE_COL = () => undefined;
const NOOP_REMOVE_TABLE_COL = () => undefined;
const NOOP_GET_CURSOR_COMMANDS = () => [] as readonly CursorCommand[];
const NOOP_GET_INLINE_MARKS = () => [] as readonly InlineMark[];
const NOOP_GET_INPUT_SHORTCUT_RULES = () => [] as readonly InputShortcut[];

export function CompositionSurfaceContent({
  snapshot,
  framedNodeId,
  hideWorkspaceChrome = false,
  stageOverlay,
  canEdit = true,
  authoredEdges = [],
  // Pass through all SceneNodeViewProps handlers
  selectedNodeIds = new Set(),
  focusedNodeId = null,
  selectedNodeId = null,
  onSelect,
  onTextChange,
  onAutoformat,
  matchShortcut,
  dispatchShortcut,
  openComposer,
  getCursorCommands,
  getInlineMarks,
  getInputShortcutRules,
  onTextFocus,
  onEscape,
  onInsertBeside,
  onMergeBackward,
  onCreateComponent,
  onAddBlockBelow,
  editorPlaceholder = '',
  onMeasureTextHeight,
  revealTextNodeIds = new Set(),
  streamingTextNodeId = null,
  streamingText = '',
  onRemoveBlock,
  onBeginDrag,
  dragNodeId = null,
  onStartConnect,
  onNoteAction,
  noteActions = [],
  onResizeFrame,
  onSplitDragStart,
  onSplitDrag,
  onEditVisibility,
  onEditSpacing,
  onFloatNode,
  onCollapsePanel,
  onExpandPanel,
  onInsertTableRow,
  onRemoveTableRow,
  onInsertTableColumn,
  onRemoveTableColumn,
}: CompositionSurfaceContentProps) {
  // Find the framed page/root node
  const findNode = (node: SceneNode | null, targetId: string): SceneNode | null => {
    if (!node) return null;
    if (node.id === targetId) return node;
    for (const child of node.children ?? []) {
      const found = findNode(child, targetId);
      if (found) return found;
    }
    return null;
  };

  const framedPage = framedNodeId && snapshot.tree
    ? findNode(snapshot.tree, framedNodeId)
    : snapshot.tree;

  const framedPageIsCanvas = framedPage?.kind === 'Canvas';

  if (!snapshot.tree) {
    return (
      <Container layout="vertical" alignItems="center" justifyContent="center" padding="lg" gap="md">
        <Spinner />
        <Text variant="body-xs" color="faint">Loading content...</Text>
      </Container>
    );
  }

  if (!framedPage) {
    return (
      <Container layout="vertical" alignItems="center" justifyContent="center" padding="lg" gap="md">
        <Text variant="body-xs" color="faint">No content to display</Text>
      </Container>
    );
  }

  // Gate mutation handlers based on canEdit
  const gatedOnSelect = canEdit ? onSelect : NOOP_SELECT;
  const gatedOnTextChange = canEdit ? onTextChange : NOOP_TEXT_CHANGE;
  const gatedOnAutoformat = canEdit ? onAutoformat : NOOP_AUTOFORMAT;
  const gatedMatchShortcut = canEdit ? matchShortcut : NOOP_MATCH_SHORTCUT;
  const gatedDispatchShortcut = canEdit ? dispatchShortcut : NOOP_DISPATCH_SHORTCUT;
  const gatedOpenComposer = canEdit ? openComposer : NOOP_OPEN_COMPOSER;
  const gatedOnTextFocus = canEdit ? onTextFocus : NOOP_TEXT_FOCUS;
  const gatedOnEscape = canEdit ? onEscape : NOOP_ESCAPE;
  const gatedOnInsertBeside = canEdit ? onInsertBeside : NOOP_INSERT_BESIDE;
  const gatedOnMergeBackward = canEdit ? onMergeBackward : NOOP_MERGE_BACKWARD;
  const gatedOnCreateComponent = canEdit ? onCreateComponent : NOOP_CREATE_COMPONENT;
  const gatedOnAddBlockBelow = canEdit ? onAddBlockBelow : NOOP_ADD_BLOCK_BELOW;
  const gatedOnMeasureTextHeight = canEdit ? onMeasureTextHeight : NOOP_MEASURE_TEXT;
  const gatedOnRemoveBlock = canEdit ? onRemoveBlock : NOOP_REMOVE_BLOCK;
  const gatedOnBeginDrag = canEdit ? onBeginDrag : NOOP_BEGIN_DRAG;
  const gatedOnStartConnect = canEdit ? onStartConnect : NOOP_START_CONNECT;
  const gatedOnNoteAction = canEdit ? onNoteAction : NOOP_NOTE_ACTION;
  const gatedOnResizeFrame = canEdit ? onResizeFrame : NOOP_RESIZE_FRAME;
  const gatedOnSplitDragStart = canEdit ? onSplitDragStart : NOOP_SPLIT_DRAG_START;
  const gatedOnSplitDrag = canEdit ? onSplitDrag : NOOP_SPLIT_DRAG;
  const gatedOnEditVisibility = canEdit ? onEditVisibility : NOOP_EDIT_VIS;
  const gatedOnEditSpacing = canEdit ? onEditSpacing : NOOP_EDIT_SPACING;
  const gatedOnFloatNode = canEdit ? onFloatNode : NOOP_FLOAT_NODE;
  const gatedOnCollapsePanel = canEdit ? onCollapsePanel : NOOP_COLLAPSE_PANEL;
  const gatedOnExpandPanel = canEdit ? onExpandPanel : NOOP_EXPAND_PANEL;
  const gatedOnInsertTableRow = canEdit ? onInsertTableRow : NOOP_INSERT_TABLE_ROW;
  const gatedOnRemoveTableRow = canEdit ? onRemoveTableRow : NOOP_REMOVE_TABLE_ROW;
  const gatedOnInsertTableColumn = canEdit ? onInsertTableColumn : NOOP_INSERT_TABLE_COL;
  const gatedOnRemoveTableColumn = canEdit ? onRemoveTableColumn : NOOP_REMOVE_TABLE_COL;
  const gatedGetCursorCommands = canEdit ? getCursorCommands : NOOP_GET_CURSOR_COMMANDS;
  const gatedGetInlineMarks = canEdit ? getInlineMarks : NOOP_GET_INLINE_MARKS;
  const gatedGetInputShortcutRules = canEdit ? getInputShortcutRules : NOOP_GET_INPUT_SHORTCUT_RULES;

  return (
    <div
      className="ca-root"
      data-dragging={canEdit && dragNodeId ? 'true' : undefined}
      data-read-only={!canEdit ? 'true' : undefined}
      // The notetaker sizes .ca-root/.ca-stage from its own full-page layout; a bare
      // single-composition mount has no such parent, so without explicit fill the
      // stage collapses to height 0 and the scene renders clipped/invisible.
      style={{ height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column' }}
    >
      <style>{DOCUMENTS_SURFACE_CSS}</style>
      <div
        className={framedPageIsCanvas ? 'ca-stage ca-stage-canvas' : 'ca-stage'}
        aria-label="Content"
        data-reach-role="canvas"
        tabIndex={-1}
        style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}
      >
        <ErrorBoundary zoneName="composition surface content">
          <SceneNodeView
            node={framedPage}
            snapshot={snapshot}
            focusedNodeId={focusedNodeId}
            selectedNodeId={selectedNodeId}
            selectedNodeIds={selectedNodeIds}
            onSelect={gatedOnSelect}
            onTextChange={gatedOnTextChange}
            onAutoformat={gatedOnAutoformat}
            matchShortcut={gatedMatchShortcut}
            dispatchShortcut={gatedDispatchShortcut}
            openComposer={gatedOpenComposer}
            getCursorCommands={gatedGetCursorCommands}
            getInlineMarks={gatedGetInlineMarks}
            getInputShortcutRules={gatedGetInputShortcutRules}
            onTextFocus={gatedOnTextFocus}
            onEscape={gatedOnEscape}
            rootId={framedPage.id}
            onInsertBeside={gatedOnInsertBeside}
            onMergeBackward={gatedOnMergeBackward}
            onCreateComponent={gatedOnCreateComponent}
            onAddBlockBelow={gatedOnAddBlockBelow}
            editorPlaceholder={editorPlaceholder}
            onMeasureTextHeight={gatedOnMeasureTextHeight}
            revealTextNodeIds={revealTextNodeIds}
            streamingTextNodeId={streamingTextNodeId}
            streamingText={streamingText}
            onRemoveBlock={gatedOnRemoveBlock}
            onBeginDrag={gatedOnBeginDrag}
            dragNodeId={dragNodeId}
            onStartConnect={gatedOnStartConnect}
            onNoteAction={gatedOnNoteAction}
            noteActions={noteActions}
            onResizeFrame={gatedOnResizeFrame}
            onSplitDragStart={gatedOnSplitDragStart}
            onSplitDrag={gatedOnSplitDrag}
            onEditVisibility={gatedOnEditVisibility}
            onEditSpacing={gatedOnEditSpacing}
            onFloatNode={gatedOnFloatNode}
            onCollapsePanel={gatedOnCollapsePanel}
            onExpandPanel={gatedOnExpandPanel}
            onInsertTableRow={gatedOnInsertTableRow}
            onRemoveTableRow={gatedOnRemoveTableRow}
            onInsertTableColumn={gatedOnInsertTableColumn}
            onRemoveTableColumn={gatedOnRemoveTableColumn}
          />
        </ErrorBoundary>
        {snapshot.visible_edge_routes.length > 0 ? (
          <svg className="ca-edge-layer" aria-label="Connections">
            {snapshot.visible_edge_routes.map((route) => {
              const label = authoredEdges.find((edge) => edge.edge_id === route.edge_id)?.label;
              const path = route.points.map((point, index) => `${index ? 'L' : 'M'} ${point.x} ${point.y}`).join(' ');
              const midpoint = route.points[Math.floor(route.points.length / 2)];
              return (
                <g key={route.edge_id} data-edge-id={route.edge_id}>
                  <path className="ca-edge-path" d={path} />
                  {label && midpoint ? <text className="ca-edge-label-text" x={midpoint.x} y={midpoint.y}>{label}</text> : null}
                </g>
              );
            })}
          </svg>
        ) : null}
        {stageOverlay}
      </div>
    </div>
  );
}
