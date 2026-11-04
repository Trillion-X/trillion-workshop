// Sealed read-only Composition projection entry. It receives only the selected
// snapshot through props; it never opens a package read scope or mutation rail.
import React from 'react';
import { mountReactSurface } from '../../ui';
import { CompositionSurfaceContent } from './CompositionSurfaceContent';

type Node = { id: string; kind?: string; type?: string; props?: Record<string, unknown>; visible?: unknown; children?: Node[] };
type Args = { el: HTMLElement; props?: Record<string, unknown> };

function contexts(props: Record<string, unknown>): Node[] {
  const selection = props.selection;
  if (!selection || typeof selection !== 'object' || Array.isArray(selection)) return [];
  const raw = (selection as Record<string, unknown>).contexts;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((context) => context && typeof context === 'object' && Array.isArray((context as Record<string, unknown>).nodes)
    ? (context as { nodes: Node[] }).nodes : []);
}

function SelectedComposition({ props }: { props: Record<string, unknown> }) {
  const children = contexts(props);
  const root: Node = { id: 'selected-composition-root', kind: 'Container', visible: true, props: {}, children };
  // SceneNodeView is the existing rendering semantics. Read-only gates every
  // mutation handler inside CompositionSurfaceContent; no selected projection can
  // subscribe, mutate, or accidentally recover unselected source state.
  const snapshot = { tree: root, frames: {}, camera: { pan_x: 0, pan_y: 0, zoom: 1 }, visible_edge_routes: [] };
  return <CompositionSurfaceContent {...({ snapshot, framedNodeId: null, canEdit: false, hideWorkspaceChrome: true } as never)} />;
}

export default function mount({ el, props = {} }: Args) {
  return mountReactSurface(el, <SelectedComposition props={props} />);
}
