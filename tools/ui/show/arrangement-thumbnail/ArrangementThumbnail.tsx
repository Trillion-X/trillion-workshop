// parts/ui/show/arrangement-thumbnail/ArrangementThumbnail.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// One small picture of an arrangement of panes with its name under it, pressed
// to choose it: the anatomy of a theme or template chooser (a framed preview,
// the name beneath, the chosen one ringed in the accent), drawn from boxes the
// caller hands in rather than from a screenshot. A secondary "…" appears on
// hover or focus; a right-click reports its point so the caller can open the
// same actions there.
//
// Anatomy sources: Etsy's Pattern theme chooser (framed preview, name below,
// accent border and mark on the chosen one) and Manus's template picker (grid
// of framed previews, chosen one ringed, its name in the accent), both on Mobbin
// (https://mobbin.com/screens/53cf9f12-a7a1-4d89-8ac2-4ccc69f417bd,
// https://mobbin.com/screens/c96eb46a-a492-4a8f-a4c0-ed2aede9b2bf). No 21st.dev
// component matched ("layout switcher thumbnails", "layout picker grid of
// wireframe presets selectable card"), so the code is original.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Blind: boxes are {x, y, w, h} in a 0..1 frame plus an optional icon name
//    and short label; nothing here knows what a pane, layout or screen is.
// 2. The press target is the shared Button; the chosen state is `aria-current`
//    and its look is the screen-look accent (layout-picker.css), never a colour
//    written here.
// 3. Secondary actions never sit in the picture's way: they are a slot the
//    caller fills (the shared ActionMenu), shown on hover or focus only.
//
// =============================================================================

'use client';

import * as React from 'react';
import { Button } from '../button/Button';
import { NamedIcon } from '../icon';

export interface ArrangementThumbnailBox {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  /** Icon name drawn in the box. */
  readonly icon?: string | null;
  /** Short words drawn in the box when it has no icon. */
  readonly label?: string | null;
}

export interface ArrangementThumbnailProps {
  readonly name: string;
  readonly boxes: readonly ArrangementThumbnailBox[];
  /** This is the arrangement on screen now. */
  readonly selected?: boolean;
  readonly disabled?: boolean;
  /** What pressing it does, for people who cannot see the picture ("Open Files and Decisions"). */
  readonly pressLabel: string;
  readonly onPress: () => void;
  /** A right-click on the picture, at this viewport point. */
  readonly onMenuAt?: (point: { x: number; y: number }) => void;
  /** Shown on hover or focus: the caller's "…" menu. */
  readonly actions?: React.ReactNode;
  /** Replaces the name line (a rename field). */
  readonly nameEditor?: React.ReactNode;
  /** Focus left the rename field. */
  readonly onNameEditorLeave?: () => void;
}

const percent = (value: number) => `${Math.max(0, Math.min(100, value * 100))}%`;

export function ArrangementThumbnail({
  name, boxes, selected = false, disabled = false, pressLabel, onPress, onMenuAt, actions, nameEditor, onNameEditorLeave,
}: ArrangementThumbnailProps): React.ReactElement {
  return (
    <div className="arrangement-thumbnail" data-selected={selected ? '' : undefined}>
      <Button
        type="button"
        variant="plain"
        size="xs"
        className="arrangement-thumbnail-press"
        aria-label={pressLabel}
        aria-current={selected ? 'true' : undefined}
        disabled={disabled}
        onClick={onPress}
        onContextMenu={onMenuAt ? (event: React.MouseEvent) => {
          event.preventDefault();
          onMenuAt({ x: event.clientX, y: event.clientY });
        } : undefined}
      >
        <span className="arrangement-thumbnail-picture" aria-hidden="true">
          {boxes.map((box) => (
            <span
              key={box.id}
              className="arrangement-thumbnail-box"
              style={{ left: percent(box.x), top: percent(box.y), width: percent(box.w), height: percent(box.h) }}
            >
              {box.icon ? <NamedIcon name={box.icon} size="xs" /> : box.label ? <span className="arrangement-thumbnail-box-label">{box.label}</span> : null}
            </span>
          ))}
        </span>
        {nameEditor ? null : <span className="arrangement-thumbnail-name">{name}</span>}
      </Button>
      {nameEditor ? <div className="arrangement-thumbnail-name-editor" onBlur={onNameEditorLeave}>{nameEditor}</div> : null}
      {actions ? <div className="arrangement-thumbnail-actions">{actions}</div> : null}
    </div>
  );
}
