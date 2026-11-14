// packages/workflow-canvas/show/WorkflowNodeCard.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The visual card for one node on the Workflow Canvas — one real record from
// the definition store. Two kinds, one card: triggers (what starts work) and
// actions (what runs).
//
// Reference anatomy (locked by the workflow-canvas screen contract):
// - Lindy Flow Editor: rounded node card, leading icon frame tinted by kind,
//   title + one quiet caption, selected node carries an accent outline, port
//   dots at the connection sides.
// - n8n: execution status attached directly to the node (running/success/
//   failed), paused nodes visually receded.
// - Zapier Canvas: plain human caption under the title, never schema words.
//
// Studio-glass restraint: title + one quiet caption, kind carried by the icon
// and its tint — no badges, no stripes, no labels the user doesn't need for
// the next action (L118).
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. All chrome through ui components + screen-look tokens. Inline style is
//    limited to geometry and data-driven color values.
// 2. Plain visible copy only: no ids, no engine vocabulary, no provenance
//    addresses. Paused/run states are shown by the status dot and opacity,
//    not by extra labels.
// 3. The card renders display data — it never derives truth from feeds.
// 4. Port dots are aria-hidden geometry: edges connect at (right-center) and
//    (left-center), and the dots make those points visible, Lindy-style.
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React, { useState } from 'react';
import { Plus as PlusIcon } from 'lucide-react';
import { Card, Container, Icon, StatusDot, Text } from '../../ui';
import { NodeIconFrame } from './node-icon';
import type { WorkflowCanvasNodeDisplay } from '../read-data/read-workflow-canvas-layout';
import type { CanvasRunState } from './workflow-canvas-types';

export { NODE_WIDTH, NODE_HEIGHT } from '../read-data/read-workflow-canvas-layout';

export interface WorkflowNodeCardProps {
  display: WorkflowCanvasNodeDisplay;
  isSelected?: boolean;
  runState?: CanvasRunState | null;
  /**
   * When provided, an inline + affordance renders under the node's out port
   * (Lindy's "add next step"). The canvas supplies the click intent; the card
   * stays a pure projection.
   */
  onAddNextStep?: () => void;
  /**
   * When provided, the out port becomes a drag handle: pointer-down starts a
   * connection drag (n8n/Zapier "pull a line"). The canvas owns the drag —
   * the card only reports the start.
   */
  onStartConnect?: (event: React.PointerEvent) => void;
  /** True while a connection drag hovers this node as a valid drop target. */
  isConnectTarget?: boolean;
  /**
   * When provided, right-click opens the canvas-owned node menu (n8n/Lindy
   * context menu). The card only reports the event — the canvas owns the menu.
   */
  onContextMenu?: (event: React.MouseEvent) => void;
}

function dotStatus(
  display: WorkflowCanvasNodeDisplay,
  isSelected: boolean,
  runState: CanvasRunState | null,
): 'success' | 'error' | 'info' | 'accent' | 'idle' | null {
  if (runState === 'running') return 'accent';
  if (runState === 'failed') return 'error';
  if (runState === 'completed') return 'success';
  if (!display.enabled) return 'idle';
  if (isSelected) return 'accent';
  return null;
}

// The icon-name → glyph map and the tinted icon frame live in ./node-icon
// (shared with the inspector header — SSOT). The card stays blind: it passes
// display.iconName to NodeIconFrame and never names a kind.

/** Run-state ring color — n8n-style execution status carried by the card edge. */
function runRing(runState: CanvasRunState | null, isSelected: boolean): string | null {
  if (runState === 'running') return 'var(--accent-primary)';
  if (runState === 'failed') return 'var(--status-error, #e5484d)';
  if (runState === 'completed') return 'var(--status-success, #46a758)';
  if (isSelected) return 'var(--accent-primary)';
  return null;
}

/**
 * One Lindy-style port dot at a connection point. Pure geometry; aria-hidden.
 * Vertical flow: 'in' sits at top-center, 'out' at bottom-center.
 */
function PortDot({ side }: { side: 'in' | 'out' }): React.ReactElement {
  return (
    <Container
      as="span"
      aria-hidden="true"
      data-workflow-node-port={side}
      style={{
        position: 'absolute',
        left: '50%',
        [side === 'in' ? 'top' : 'bottom']: '-3px',
        transform: 'translateX(-50%)',
        // Quiet geometry: small and dim so it reads as a connection point,
        // never as a button to press (a dead-looking control is an L114 trap).
        width: '6px',
        height: '6px',
        borderRadius: '50%',
        backgroundColor: 'var(--text-tertiary)',
        opacity: 0.5,
        pointerEvents: 'none',
      } as React.CSSProperties}
    />
  );
}

export const WorkflowNodeCard: React.FC<WorkflowNodeCardProps> = ({
  display,
  isSelected = false,
  runState = null,
  onAddNextStep,
  onStartConnect,
  isConnectTarget = false,
  onContextMenu,
}) => {
  const captionText = display.caption;
  const shownRunState = runState ?? display.runState ?? null;
  const dot = dotStatus(display, isSelected, shownRunState);
  const ring = isConnectTarget ? 'var(--accent-primary)' : runRing(shownRunState, isSelected);
  const [isHovered, setIsHovered] = useState(false);
  const runStateLabel = shownRunState === 'running'
    ? 'Running'
    : shownRunState === 'completed'
      ? 'Done'
      : shownRunState === 'failed'
        ? 'Failed'
        : null;

  return (
    <Container
      data-workflow-node-shell="true"
      position="relative"
      height="full"
      style={{ width: '100%' }}
      onContextMenu={onContextMenu}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
    <Card
      data-workflow-node-card="true"
      data-node-kind={display.kind}
      data-workflow-node-run-state={shownRunState ?? undefined}
      variant="surface"
      padding="sm"
      selected={isSelected}
      height="full"
      style={{
        width: '100%',
        overflow: 'hidden',
        position: 'relative',
        opacity: display.enabled ? 1 : 0.55,
        transition: 'box-shadow 0.18s ease, opacity 0.18s ease, transform 0.18s ease',
        // Ring only — flat highlight, never a drop shadow. Hover gets a
        // quiet 1px border tint (Lindy node hover), states stack: run/select
        // ring wins over hover.
        ...(ring
          ? { boxShadow: `0 0 0 1.5px ${ring}` }
          : isHovered
            ? { boxShadow: '0 0 0 1px var(--border-secondary, var(--border-primary))' }
            : null),
      }}
    >
      <Container layout="horizontal" gap="sm" alignItems="center" height="full">
        <NodeIconFrame
          iconName={display.iconName}
          accentTone={display.accentTone}
          selected={isSelected}
        />

        <Container
          layout="vertical"
          gap="xs"
          flex={1}
          style={{ minWidth: 0, overflow: 'hidden' }}
        >
          <Text
            variant="body-xs"
            weight="semibold"
            truncate
            title={display.label}
          >
            {display.label}
          </Text>
          {captionText && (
            <Text variant="caption" color="muted" truncate title={captionText}>
              {captionText}
            </Text>
          )}
        </Container>
      </Container>

      {dot && (
        <Container
          as="span"
          role="img"
          aria-label={runStateLabel ?? undefined}
          title={runStateLabel ?? undefined}
          data-workflow-node-status-dot="true"
          style={{ position: 'absolute', right: '10px', top: '10px' }}
        >
          <StatusDot size="sm" pulse={runState === 'running'} status={dot} />
        </Container>
      )}

    </Card>

      {/* Connection ports: a node renders an in-port only when it can receive
          an incoming connection (read-data decides; the card stays blind).
          Ports live on the shell so they are not clipped by the card. */}
      {display.hasInPort && <PortDot side="in" />}
      <PortDot side="out" />

      {/* Drag-to-connect handle over the out port (n8n/Zapier pull-a-line).
          A generous invisible hit area; visible affordance stays the quiet
          port dot + cursor change. */}
      {onStartConnect && (
        <Container
          as="span"
          aria-hidden="true"
          data-workflow-node-connect-handle="true"
          data-graph-node-interactive="true"
          onPointerDown={(event: React.PointerEvent) => {
            event.stopPropagation();
            onStartConnect(event);
          }}
          style={{
            position: 'absolute',
            left: '50%',
            bottom: '-12px',
            transform: 'translateX(-50%)',
            width: '28px',
            height: '20px',
            cursor: 'crosshair',
          } as React.CSSProperties}
        />
      )}

      {/* Lindy-style inline add: a + circle hanging under the out port.
          Renders ONLY where pressing it works (editable actions) — a dead
          affordance is worse than none (L114). */}
      {onAddNextStep && (
        <Container
          as="button"
          type="button"
          aria-label="Add next step"
          data-workflow-node-add-next="true"
          data-graph-node-interactive="true"
          layout="vertical"
          alignItems="center"
          justifyContent="center"
          onClick={(event: React.MouseEvent) => {
            event.stopPropagation();
            onAddNextStep();
          }}
          style={{
            position: 'absolute',
            left: '50%',
            bottom: '-30px',
            transform: 'translateX(-50%)',
            width: '22px',
            height: '22px',
            borderRadius: '50%',
            backgroundColor: 'var(--glass-bg-popover)',
            border: '1px solid var(--border-primary)',
            cursor: 'pointer',
            // Lindy keeps the + persistently visible along the flow; quiet
            // at rest, full strength when the node is selected.
            opacity: isSelected ? 1 : 0.55,
            transition: 'opacity 0.15s ease, border-color 0.15s ease',
          } as React.CSSProperties}
        >
          <Icon icon={PlusIcon} size="xs" color="secondary" />
        </Container>
      )}
    </Container>
  );
};
