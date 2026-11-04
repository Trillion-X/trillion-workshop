// packages/group/show/ConnectorFormatControls.tsx
//
// The connector format toolbar (FigJam/Miro/Mural canon): when exactly one
// connector is selected, these controls appear in the board's selection bar and
// let the user style the relationship — line color, solid/dashed, arrow direction.
// Every control writes ONE field of the connector member's style DATA via `onPatch`;
// the panel persists it with the generic patchItem. Built only from shipped `ui`
// molecules (ColorDot + ColorPickerPopover + Button + Tooltip) — zero new primitive,
// zero raw HTML / className (L065).

import React, { useRef, useState } from 'react';
import { Button, ColorDot, ColorPickerPopover, ExpandableTabs, Tooltip, Container } from '../../ui';
import { CONNECTOR_COLOR_PRESETS, CONNECTOR_WIDTH_OPTIONS } from './item-appearance';

export type ConnectorArrow = 'end' | 'both' | 'none';
// `ConnectorRouting` is owned by the pure geometry leaf that also owns the routing
// algorithm map (ROUTING_ALGORITHMS) — the SSOT for what routing names exist. Import +
// re-export it here so this UI (and its consumers, e.g. GroupBoardPanel) share the ONE
// definition instead of a drift-prone copy (auditor advisory, #199).
export type { ConnectorRouting } from '../do-work/connector-geometry';
import type { ConnectorRouting } from '../do-work/connector-geometry';

export interface ConnectorStyle {
  color?: string;
  dashed?: boolean;
  arrow?: ConnectorArrow;
  routing?: ConnectorRouting;
  /** Line weight in px (#197) — a FREE number, not a closed thin/medium/bold enum. */
  thickness?: number;
}

/** The arrow modes form a closed cycle (Physics: a line has 0/1/2 directed ends). */
const ARROW_NEXT: Record<ConnectorArrow, ConnectorArrow> = { end: 'both', both: 'none', none: 'end' };
const ARROW_ICON: Record<ConnectorArrow, string> = { end: 'ArrowRight', both: 'MoveHorizontal', none: 'Minus' };
const ARROW_LABEL: Record<ConnectorArrow, string> = { end: 'Arrow at end', both: 'Arrows at both ends', none: 'No arrow' };

/** Routing modes: the geometric trio cycles straight → curved → elbow → straight.
 *  'waypoints' (custom bends) is NOT in the cycle — it is entered via the "Add bend"
 *  button and exits to straight — so cycling never lands on an invisible bend-less
 *  waypoints line. */
const ROUTING_NEXT: Record<ConnectorRouting, ConnectorRouting> = { straight: 'curved', curved: 'smooth', smooth: 'elbow', elbow: 'diagonal', diagonal: 'avoid', avoid: 'straight', waypoints: 'straight' };
const ROUTING_ICON: Record<ConnectorRouting, string> = { straight: 'Minus', curved: 'Spline', smooth: 'Waves', elbow: 'CornerDownRight', diagonal: 'Slash', avoid: 'Route', waypoints: 'Waypoints' };
const ROUTING_LABEL: Record<ConnectorRouting, string> = { straight: 'Straight line', curved: 'Curved line', smooth: 'Smooth curve (through bends)', elbow: 'Elbow (right-angle)', diagonal: 'Diagonal (45°)', avoid: 'Avoid obstacles', waypoints: 'Custom bends' };
/** Preset line weights (px) the weight button cycles through — derived from the SSOT
 *  CONNECTOR_WIDTH_OPTIONS DATA so the per-line cycle and the board-default Dropdown never
 *  drift. An off-preset current weight snaps to the nearest before advancing. */
const THICKNESS_PRESETS = CONNECTOR_WIDTH_OPTIONS.map((o) => Number(o.value));
const DEFAULT_THICKNESS = 2;
function nextThickness(cur?: number): number {
  const c = typeof cur === 'number' && cur > 0 ? cur : DEFAULT_THICKNESS;
  let idx = 0;
  let best = Infinity;
  THICKNESS_PRESETS.forEach((p, i) => {
    const d = Math.abs(p - c);
    if (d < best) {
      best = d;
      idx = i;
    }
  });
  return THICKNESS_PRESETS[(idx + 1) % THICKNESS_PRESETS.length];
}
const DEFAULT_COLOR = '#6366f1';

export interface ConnectorFormatControlsProps extends ConnectorStyle {
  /** Apply one style field. `undoable:false` = live preview (e.g. color-wheel drag).
   *  `from` = the values when a live gesture began, so its finishing patch records ONE
   *  undo step back to them (the previews already changed the saved line). */
  onPatch: (patch: ConnectorStyle, opts?: { undoable?: boolean; from?: ConnectorStyle }) => void;
  /** Insert a bend point at the line's midpoint and switch routing to custom bends
   *  (#195). The panel owns the geometry (it has the endpoint rects). Absent → the
   *  bend controls are hidden. */
  onAddBend?: () => void;
  /** Remove every bend and restore a straight line (#195). */
  onClearBends?: () => void;
  /** Whether the connector currently has any bends — gates the "Clear bends" button. */
  hasBends?: boolean;
}

export function ConnectorFormatControls({ color, dashed, arrow = 'end', routing = 'straight', thickness, onPatch, onAddBend, onClearBends, hasBends }: ConnectorFormatControlsProps) {
  const colorAnchor = useRef<HTMLButtonElement>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const current = color || DEFAULT_COLOR;
  // The colour gesture: the line's colour when the picker opened, and whether a preview
  // has changed it since. Done or dismiss finishes it as one undoable step from there.
  const gesture = useRef<{ from: string | undefined; previewed: string | null } | null>(null);
  const finishColor = (hex: string | null) => {
    const started = gesture.current;
    gesture.current = null;
    setPickerOpen(false);
    if (hex === null) return;
    if (!started) { onPatch({ color: hex }); return; }
    if (hex === started.from) {
      // Back to where it began: no step, but a preview that changed the saved line is put back.
      if (started.previewed !== null && started.previewed !== hex) onPatch({ color: hex }, { undoable: false });
      return;
    }
    onPatch({ color: hex }, { from: { color: started.from } });
  };
  return (
    <Container layout="horizontal" gap="xs" alignItems="center">
      <Tooltip label="Line color">
        <Button
          ref={colorAnchor}
          variant="ghost"
          size="icon"
          aria-label="Line color"
          onClick={() => {
            if (pickerOpen) { finishColor(gesture.current?.previewed ?? null); return; }
            gesture.current = { from: color, previewed: null };
            setPickerOpen(true);
          }}
        >
          <ColorDot color={current} size="md" />
        </Button>
      </Tooltip>
      <ColorPickerPopover
        anchorRef={colorAnchor}
        open={pickerOpen}
        value={current}
        presets={CONNECTOR_COLOR_PRESETS}
        title="Line color"
        // Live recolor while dragging the wheel (no undo flood). Done, or closing the
        // picker with a previewed colour, lands it as ONE undoable step back to the
        // colour the line had when the picker opened.
        onChange={(hex) => {
          if (gesture.current) gesture.current.previewed = hex;
          onPatch({ color: hex }, { undoable: false });
        }}
        onSave={(hex) => finishColor(hex)}
        saveLabel="Done"
        onDismiss={() => finishColor(gesture.current?.previewed ?? null)}
      />
      <ExpandableTabs
        mode="action"
        size="sm"
        ariaLabel="Line style"
        items={[
          { id: 'dashed', label: 'Dashed line', icon: dashed ? 'MoreHorizontal' : 'Minus', pinned: !!dashed },
          { id: 'arrow', label: 'Arrow direction', icon: ARROW_ICON[arrow], detail: ARROW_LABEL[arrow] },
          { id: 'routing', label: 'Line routing', icon: ROUTING_ICON[routing], detail: ROUTING_LABEL[routing] },
        ]}
        onSelect={(id) => {
          if (id === 'dashed') onPatch({ dashed: !dashed });
          else if (id === 'arrow') onPatch({ arrow: ARROW_NEXT[arrow] });
          else if (id === 'routing') onPatch({ routing: ROUTING_NEXT[routing] });
        }}
      />
      {/* Line weight (#197): a self-describing button showing the ACTUAL px value —
          the label IS the value (no explanatory subcopy, L115), and it renders any
          number, not a closed thin/medium/bold enum. Clicking cycles the presets. */}
      <Tooltip label="Line weight">
        <Button
          variant="ghost"
          size="sm"
          aria-label="Line weight"
          onClick={() => onPatch({ thickness: nextThickness(thickness) })}
        >
          {`${thickness ?? DEFAULT_THICKNESS}px`}
        </Button>
      </Tooltip>
      {onAddBend || (onClearBends && hasBends) ? (
        <ExpandableTabs
          mode="action"
          size="sm"
          ariaLabel="Bend points"
          items={[
            ...(onAddBend ? [{ id: 'add-bend', label: 'Add bend point', icon: 'Waypoints' }] : []),
            ...(onClearBends && hasBends ? [{ id: 'clear-bends', label: 'Clear bends', icon: 'Eraser' }] : []),
          ]}
          onSelect={(id) => (id === 'add-bend' ? onAddBend?.() : onClearBends?.())}
        />
      ) : null}
    </Container>
  );
}
