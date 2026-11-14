// packages/ui/show/floating-grab/FloatingGrab.tsx
//
// PURPOSE
// The strip a floating window is moved by when it shows no tab bar: the whole
// strip is the grab area, with the window's own actions and its close (or
// put-back) control at the right. Every picture-in-picture window uses this
// one strip, whether it is a caller-filled panel (mountFloatingPanel) or an
// arrangement container whose header DATA hides its tab bar, so they look and
// move alike.
//
// NON-NEGOTIABLE INVARIANTS
// 1. A press on a button inside the strip never starts a move.
// 2. The strip owns no position; `onGrab` hands the press to the window owner
//    (OverlayArranger), which moves the window without re-rendering.
// 3. Callers pass actions as data (label, Lucide icon name, handler); the strip
//    draws them with the shared ExpandableTabs, so no caller authors markup.
// 4. No grip mark sits in the middle: the strip itself shows the grab cursor.
// 5. `closeAs` names what closing does when it is not plain closing (a list
//    unpinned from the sidebar closes by pinning back), so the control says so.
// 6. Appearance lives in screen-look (coss-workspace.css, `.coss-floating-panel-grab`).

import React from 'react';
import {ExpandableTabs} from '../expandable-tabs/ExpandableTabs';

export interface FloatingGrabAction {
  id: string;
  /** Its name, shown when pointed at and read by assistive tech, for example "Show Notifications as a tab". */
  label: string;
  /** Lucide icon name. */
  icon: string;
  onAction: () => void;
}

/** What the close control says and shows when closing puts the content back somewhere. */
export interface FloatingCloseAs {
  label: string;
  /** Lucide icon name. */
  icon: string;
}

export interface FloatingGrabProps {
  /** What the window shows, used in "Drag to move …" and "Close …". */
  label: string;
  onGrab: (event: React.PointerEvent) => void;
  onClose: () => void;
  /** Window actions shown before the close control. */
  actions?: readonly FloatingGrabAction[];
  /** The close control's own words and icon, when closing puts the content back. */
  closeAs?: FloatingCloseAs;
  grabRef?: (node: HTMLDivElement | null) => void;
  /** Adds the shared control scope when the strip is not already inside one. */
  scoped?: boolean;
}

export function FloatingGrab({label, onGrab, onClose, actions = [], closeAs, grabRef, scoped = false}: FloatingGrabProps) {
  return (
    <div ref={grabRef} className={scoped ? 'coss-ui coss-floating-panel-grab' : 'coss-floating-panel-grab'} data-floating-grab="" title={`Drag to move ${label}`}
      onPointerDown={(event) => { if ((event.target as HTMLElement).closest('button')) return; onGrab(event); }}>
      <ExpandableTabs
        mode="action"
        size="sm"
        ariaLabel={`${label} window`}
        className="coss-floating-panel-grab-actions"
        items={[
          ...actions.map((action) => ({id: `action:${action.id}`, label: action.label, icon: action.icon})),
          {id: 'close', label: closeAs?.label ?? `Close ${label}`, icon: closeAs?.icon ?? 'X'},
        ]}
        onSelect={(id) => (id === 'close' ? onClose() : actions.find((action) => `action:${action.id}` === id)?.onAction())}
      />
    </div>
  );
}
