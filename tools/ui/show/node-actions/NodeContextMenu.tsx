// packages/ui/show/node-actions/NodeContextMenu.tsx
//
// The generic right-click menu over a NodeRef. It is a blind renderer: on
// contextmenu it finds the nearest stamped node, asks the owner-provided pack
// which actions accept it, and renders them through the shared ActionMenu
// (required icons, groups, submenus, quiet destructive tone) anchored at the
// pointer. It names no node kind and no action.
//
// Usage (a surface mounts it once):
//   const { onContextMenu, contextMenu } = useNodeContextMenu(pack)
//   return <div onContextMenu={onContextMenu}>…nodes…{contextMenu}</div>

import * as React from 'react';
import { ActionMenu, type ActionMenuItem } from '../action-menu';
import { AnchoredOverlay } from '../anchored-overlay';
import { closestNodeRef, type NodeRef } from 'trillion-workshop/tools/turn-frames-into-slides/read-data/node-ref.ts';
import {
  acceptedNodeActions,
  indexNodeActions,
  type NodeActionCapability,
  type NodeActionPack,
} from './node-action-types';

function toActionItem(action: NodeActionCapability, nodeRef: NodeRef): ActionMenuItem {
  const children = action.submenu ? action.submenu(nodeRef).map((child) => toActionItem(child, nodeRef)) : undefined;
  return {
    id: action.id,
    label: action.label,
    icon: action.icon ?? '',
    tone: action.tone,
    disabled: action.disabled,
    ...(children && children.length > 0 ? { items: children } : {}),
  };
}

interface MenuState {
  readonly nodeRef: NodeRef;
  readonly anchor: { readonly x: number; readonly y: number };
}

export interface NodeContextMenuHandle {
  /** Spread on a container; opens the menu for the nearest stamped node. */
  readonly onContextMenu: (event: React.MouseEvent) => void;
  /** Render this once inside the same container. */
  readonly contextMenu: React.ReactNode;
  /** Imperatively open for an explicit node (e.g. a ⋮ button). */
  readonly openFor: (nodeRef: NodeRef, anchor: { x: number; y: number }) => void;
  readonly isOpen: boolean;
}

export function useNodeContextMenu(pack: NodeActionPack): NodeContextMenuHandle {
  const [state, setState] = React.useState<MenuState | null>(null);
  /** Id of the action whose rich editor panel is currently open (if any). */
  const [editorId, setEditorId] = React.useState<string | null>(null);
  // The menu closes itself on every selection before it reports the choice.
  // The close is deferred one task so a choice that OPENS an editor panel can
  // cancel it; otherwise the menu would unmount before the panel renders.
  const pendingClose = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const close = React.useCallback(() => {
    setState(null);
    setEditorId(null);
  }, []);

  const onContextMenu = React.useCallback((event: React.MouseEvent) => {
    const found = closestNodeRef(event.target);
    if (!found) return; // not over a node → let the platform menu happen
    event.preventDefault();
    event.stopPropagation();
    setEditorId(null);
    setState({ nodeRef: found.ref, anchor: { x: event.clientX, y: event.clientY } });
  }, []);

  const openFor = React.useCallback((nodeRef: NodeRef, anchor: { x: number; y: number }) => {
    setEditorId(null);
    setState({ nodeRef, anchor });
  }, []);

  const actions = state ? acceptedNodeActions(pack, state.nodeRef) : [];
  const index = state ? indexNodeActions(actions, state.nodeRef) : null;

  const onValueChange = React.useCallback(
    (id: string) => {
      const action = index?.get(id);
      // An action with an editor opens its panel (stays open); run/submenu-leaf
      // actions execute and close. The menu never inspects WHICH editor.
      if (action?.editor) {
        if (pendingClose.current) clearTimeout(pendingClose.current);
        pendingClose.current = null;
        setEditorId(id);
        return;
      }
      close();
      if (action?.run) void action.run(state!.nodeRef);
    },
    [index, state, close],
  );

  const editorAction = editorId ? index?.get(editorId) : undefined;
  const editorPanel =
    state && editorAction?.editor ? editorAction.editor(state.nodeRef, close) : null;

  // Mount-on-open: the menu exists ONLY while a node is targeted and is
  // anchored at the pointer, so it draws no trigger into the host's layout.
  //
  // Two render modes, one state machine:
  //  • ACTION LIST → the shared ActionMenu anchored at the cursor (icons/submenus).
  //  • EDITOR PANEL → a DRAGGABLE, height-clamped AnchoredOverlay. An editor (the
  //    layer-stack style editor) can be taller than the viewport AND the user
  //    wants to park it out of the way — the overlay scrolls its body and the
  //    drag header lets it be moved anywhere (a user's bug: "can't drag it / can't
  //    see the bottom"). The panel itself brings its own surface chrome.
  const contextMenu =
    state !== null ? (
      editorPanel ? (
        <AnchoredOverlay
          open
          anchorPoint={state.anchor}
          placement="below"
          draggable
          title="Drag to move"
          onDismiss={close}
        >
          {/* Body surface — a SOLID opaque fill (--black-rich), never the 8%
              glass token: this panel floats over unpredictable board content
              (bright images/video) where a translucent fill reads see-through.
              The draggable header above carries the matching opaque surface. */}
          <div
            style={{ backgroundColor: 'var(--black-rich)', borderBottomLeftRadius: 'var(--radius-lg)', borderBottomRightRadius: 'var(--radius-lg)' }}
            className="w-80 max-w-[90vw] border border-t-0 border-[var(--border-primary)] p-3 shadow-xl"
          >
            {editorPanel}
          </div>
        </AnchoredOverlay>
      ) : (
        <ActionMenu
          label="Actions"
          items={actions.map((a) => toActionItem(a, state.nodeRef))}
          onAction={onValueChange}
          open
          anchorPoint={state.anchor}
          align="start"
          onOpenChange={(next) => {
            if (next) return;
            pendingClose.current = setTimeout(() => { pendingClose.current = null; close(); }, 0);
          }}
        />
      )
    ) : null;

  return { onContextMenu, contextMenu, openFor, isOpen: state !== null };
}
