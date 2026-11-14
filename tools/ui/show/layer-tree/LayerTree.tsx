// parts/ui/show/layer-tree/LayerTree.tsx
//
// NO PRIOR: searched ~/dev/bitfield-packages/packages/*/show for "layer tree", "LayersPanel", "tree view" and
// "outline tree" (found group/show/BoardLayersPanel, a board's sibling-only reorder list with eye and lock toggles,
// and ui/show/node-editors/LayerStackPanel, a flat list), and the 21st.dev MCP for "layers panel tree view with drag
// and drop reorder" (origin UI "Tree", 4322, whose anatomy this follows). None moves a row across levels with lines
// showing nesting, which a page's layers need.
//
// PURPOSE
//   A layers tree, the way Figma, Framer and Webflow show what a page is made of: each row is one thing on the page
//   with an arrow that opens what it holds, a mark for what kind of thing it is and its own name; lines down the left
//   show which row holds which; the chosen row is filled; and a row dragged up, down or into another row shows, before
//   release, the line or the outline of where it will land. Anatomy from origin UI's "Tree" (21st.dev component 4322:
//   indent variable, rotating arrow, drag line with a dot at its start, filled chosen row; retrieval has no license
//   metadata, so this is inspiration only and no component source is copied) and the layers panels
//   of Framer, Webflow and Wix on Mobbin; the gliding highlight is the one FileTree uses.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Domain-blind: a node is an id, a name, a named icon, its children and whether it may hold more; what a move
//      does is the caller's (onMove), as is what choosing (onSelect) and pointing at a row (onHover) mean.
//   2. A drop says where it lands before release: a line above or below a row, or an outline around a row that takes
//      it inside. A row is never dropped into itself or into anything it holds.
//   3. The chosen row is always visible: the rows holding it open when it is chosen from elsewhere (the page itself).
//   4. Keyboard: Up and Down move focus, Right opens or goes in, Left closes or goes out, Enter chooses. With
//      onMove, Space picks up the focused row, Up and Down choose a sibling slot, Enter or Space drops, Escape cancels.
//      A polite live region announces pickup, movement, drop and cancel.
//   5. Motion respects reduced-motion preferences.
//   6. This is the shared owner of the tree's markup; screens hand it data and never write rows themselves.

import * as React from 'react';
import {AnimatePresence, useReducedMotion} from 'framer-motion';
import { motion } from 'trillion-workshop/tools/ui/motion/lazy-motion.tsx';
import { NamedIcon } from '../icon/NamedIcon';
import { cn } from '../cn';

export type LayerTreeNode = {
  id: string;
  name: string;
  /** A named Lucide icon for what kind of thing the row is. */
  icon: string;
  children: LayerTreeNode[];
  /** Other rows may be dropped inside this one. */
  holds?: boolean;
};

/** Where a dragged row lands: inside `parentId` (null: at the top level) at `index` among its children, counted
 *  without the dragged row itself. */
export type LayerTreeMove = { id: string; parentId: string | null; index: number };

export type LayerTreeProps = {
  nodes: LayerTreeNode[];
  label: string;
  selectedId?: string | null;
  onSelect?: (id: string) => void;
  onHover?: (id: string | null) => void;
  onMove?: (move: LayerTreeMove) => void;
  /** Rows open when the tree first appears; the top level is open when left out. */
  initiallyOpen?: string[];
  emptyLabel?: string;
};

type Row = { node: LayerTreeNode; depth: number; parent: LayerTreeNode | null };
type Over = { id: string; where: 'before' | 'after' | 'inside' };
type KeyboardMove = { id: string; parentId: string | null; index: number; count: number };

const INDENT = 16;
const SPRING = { type: 'spring' as const, stiffness: 750, damping: 40 };
const INSTANT = { duration: 0 };

export function LayerTree({ nodes, label, selectedId = null, onSelect, onHover, onMove, initiallyOpen, emptyLabel = 'Nothing on this page yet' }: LayerTreeProps) {
  const reduced = useReducedMotion();
  const [open, setOpen] = React.useState<Set<string>>(() => new Set(initiallyOpen ?? nodes.map(node => node.id)));
  const openedLoadedRoots = React.useRef(nodes.length > 0);
  React.useEffect(() => {
    if (openedLoadedRoots.current || !nodes.length) return;
    openedLoadedRoots.current = true;
    setOpen(current => new Set([...current, ...(initiallyOpen ?? nodes.map(node => node.id))]));
  }, [nodes, initiallyOpen]);
  const [focus, setFocus] = React.useState<string | null>(null);
  const [highlight, setHighlight] = React.useState<{ top: number; height: number } | null>(null);
  const [dragging, setDragging] = React.useState<string | null>(null);
  const [over, setOver] = React.useState<Over | null>(null);
  const [keyboardMove, setKeyboardMove] = React.useState<KeyboardMove | null>(null);
  const [announcement, setAnnouncement] = React.useState('');
  const box = React.useRef<HTMLDivElement>(null);
  const keyboardHelpId = React.useId();

  const index = React.useMemo(() => {
    const parents = new Map<string, LayerTreeNode | null>();
    const byId = new Map<string, LayerTreeNode>();
    const walk = (list: LayerTreeNode[], parent: LayerTreeNode | null) => {
      for (const node of list) { byId.set(node.id, node); parents.set(node.id, parent); walk(node.children, node); }
    };
    walk(nodes, null);
    return { parents, byId };
  }, [nodes]);

  // A row chosen on the page opens every row that holds it, then scrolls into view, once per choice: the rows are read
  // again whenever the page changes (a row hovered, a drag begun), and scrolling back to the chosen row each time moved
  // the list under the pointer, so a row dragged toward another landed somewhere else.
  const scrolledTo = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!selectedId || !index.byId.has(selectedId)) return;
    const holders: string[] = [];
    for (let at = index.parents.get(selectedId); at; at = index.parents.get(at.id) ?? null) holders.push(at.id);
    if (holders.some(id => !open.has(id))) setOpen(now => new Set([...now, ...holders]));
    if (scrolledTo.current === selectedId) return;
    scrolledTo.current = selectedId;
    requestAnimationFrame(() => box.current?.querySelector<HTMLElement>(`[data-layer-id="${CSS.escape(selectedId)}"]`)?.scrollIntoView({ block: 'nearest' }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, index]);

  const visible: Row[] = [];
  const walk = (list: LayerTreeNode[], depth: number, parent: LayerTreeNode | null) => {
    for (const node of list) {
      visible.push({ node, depth, parent });
      if (node.children.length && open.has(node.id)) walk(node.children, depth + 1, node);
    }
  };
  walk(nodes, 0, null);

  const toggle = (id: string, to?: boolean) => setOpen(now => {
    const next = new Set(now);
    if (to ?? !next.has(id)) next.add(id); else next.delete(id);
    return next;
  });
  const holdsDragged = (target: LayerTreeNode) => {
    for (let at: LayerTreeNode | null = target; at; at = index.parents.get(at.id) ?? null) if (at.id === dragging) return true;
    return false;
  };
  const glide = (element: HTMLElement) => {
    const outer = box.current?.getBoundingClientRect();
    const inner = element.getBoundingClientRect();
    if (outer) setHighlight({ top: inner.top - outer.top + (box.current?.scrollTop ?? 0), height: inner.height });
  };
  const moveFocus = (to: number) => {
    const next = visible[Math.max(0, Math.min(visible.length - 1, to))];
    if (!next) return;
    setFocus(next.node.id);
    box.current?.querySelector<HTMLElement>(`[data-layer-id="${CSS.escape(next.node.id)}"]`)?.focus();
  };
  const siblingsFor = (row: Row) => row.parent ? row.parent.children : nodes;
  const finishKeyboardMove = (commit: boolean) => {
    if (!keyboardMove) return;
    const { id, parentId, index: targetIndex, count } = keyboardMove;
    const node = index.byId.get(id);
    if (commit && node) {
      onMove?.({ id, parentId, index: targetIndex });
      setAnnouncement(`Dropped ${node.name}, position ${targetIndex + 1} of ${count}.`);
    } else setAnnouncement(`Cancelled moving ${node?.name ?? 'layer'}.`);
    setKeyboardMove(null);
    setFocus(id);
    requestAnimationFrame(() => box.current?.querySelector<HTMLElement>(`[data-layer-id="${CSS.escape(id)}"]`)?.focus());
  };
  const onKey = (event: React.KeyboardEvent, row: Row, at: number) => {
    const { node } = row;
    if (keyboardMove?.id === node.id) {
      if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        event.preventDefault();
        const delta = event.key === 'ArrowUp' ? -1 : 1;
        const index = Math.max(0, Math.min(keyboardMove.count - 1, keyboardMove.index + delta));
        if (index !== keyboardMove.index) {
          setKeyboardMove({ ...keyboardMove, index });
          setAnnouncement(`Moving ${node.name}, position ${index + 1} of ${keyboardMove.count}. Press Enter to drop or Escape to cancel.`);
        }
      } else if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault(); finishKeyboardMove(true);
      } else if (event.key === 'Escape') {
        event.preventDefault(); finishKeyboardMove(false);
      } else if (event.key.startsWith('Arrow')) event.preventDefault();
      return;
    }
    if (event.key === 'ArrowDown') { event.preventDefault(); moveFocus(at + 1); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); moveFocus(at - 1); }
    else if (event.key === 'ArrowRight') { event.preventDefault(); if (node.children.length && !open.has(node.id)) toggle(node.id, true); else if (node.children.length) moveFocus(at + 1); }
    else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      if (node.children.length && open.has(node.id)) toggle(node.id, false);
      else if (row.parent) moveFocus(visible.findIndex(item => item.node.id === row.parent?.id));
    }
    else if (event.key === ' ' && onMove) {
      event.preventDefault();
      const siblings = siblingsFor(row);
      const index = siblings.findIndex(item => item.id === node.id);
      const move = { id: node.id, parentId: row.parent?.id ?? null, index, count: siblings.length };
      setKeyboardMove(move);
      setAnnouncement(`Picked up ${node.name}, position ${index + 1} of ${siblings.length}. Use Up and Down to move, Enter to drop, or Escape to cancel.`);
    }
    else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect?.(node.id); }
  };
  const whereOver = (event: React.DragEvent, node: LayerTreeNode): Over['where'] => {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const y = (event.clientY - rect.top) / rect.height;
    if (node.holds && y > 0.28 && y < 0.72) return 'inside';
    return y < 0.5 ? 'before' : 'after';
  };
  const drop = (target: Row, where: Over['where']) => {
    if (!dragging || !onMove) return;
    const parent = where === 'inside' ? target.node : target.parent;
    const siblings = (parent ? parent.children : nodes).filter(node => node.id !== dragging);
    const at = siblings.findIndex(node => node.id === target.node.id);
    const index = where === 'inside' ? siblings.length : where === 'before' ? at : at + 1;
    onMove({ id: dragging, parentId: parent?.id ?? null, index });
  };

  const rows = visible.map((row, at) => {
    const { node, depth } = row;
    const isOpen = open.has(node.id);
    const chosen = node.id === selectedId;
    const landing = over?.id === node.id ? over.where : null;
    return (
      <div
        key={node.id}
        role="treeitem"
        aria-level={depth + 1}
        aria-selected={chosen}
        aria-expanded={node.children.length ? isOpen : undefined}
        aria-keyshortcuts={onMove ? 'Space ArrowUp ArrowDown Enter Escape' : undefined}
        tabIndex={(focus ?? selectedId ?? visible[0]?.node.id) === node.id ? 0 : -1}
        data-layer-id={node.id}
        data-chosen={chosen ? '' : undefined}
        data-landing={landing ?? undefined}
        draggable={Boolean(onMove)}
        className={cn('layer-tree-row relative z-[1] flex h-7 cursor-default select-none items-center gap-1.5 rounded-md pr-2 text-[13px] outline-none',
          chosen && 'layer-tree-row-chosen', dragging === node.id && 'layer-tree-row-dragged')}
        style={{ paddingLeft: 4 + depth * INDENT }}
        onMouseEnter={event => { glide(event.currentTarget); onHover?.(node.id); }}
        onFocus={event => { setFocus(node.id); glide(event.currentTarget); }}
        onClick={() => onSelect?.(node.id)}
        onKeyDown={event => onKey(event, row, at)}
        onDragStart={event => { setDragging(node.id); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', node.name); }}
        onDragEnd={() => { setDragging(null); setOver(null); }}
        onDragOver={dragging ? event => {
          if (holdsDragged(node)) return;
          event.preventDefault();
          const where = whereOver(event, node);
          if (over?.id !== node.id || over.where !== where) setOver({ id: node.id, where });
        } : undefined}
        onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setOver(now => (now?.id === node.id ? null : now)); }}
        onDrop={event => { event.preventDefault(); const where = over?.id === node.id ? over.where : whereOver(event, node); setOver(null); drop(row, where); setDragging(null); }}
      >
        {Array.from({ length: depth }, (_, level) => (
          <span key={level} aria-hidden="true" className="layer-tree-guide pointer-events-none absolute inset-y-0 w-px" style={{ left: 4 + level * INDENT + 7 }}/>
        ))}
        {node.children.length ? (
          <motion.span
            aria-hidden="true"
            className="layer-tree-arrow inline-flex size-3.5 shrink-0"
            animate={{ rotate: isOpen ? 90 : 0 }}
            transition={reduced ? INSTANT : SPRING}
            onClick={event => { event.stopPropagation(); toggle(node.id); }}
          >
            <NamedIcon name="ChevronRight" size="sm"/>
          </motion.span>
        ) : <span className="inline-flex size-3.5 shrink-0"/>}
        <span className="layer-tree-icon inline-flex size-4 shrink-0"><NamedIcon name={node.icon} size="sm" aria-hidden="true"/></span>
        <span className="min-w-0 flex-1 truncate">{node.name}</span>
        {landing && landing !== 'inside' ? (
          <span aria-hidden="true" className="layer-tree-drop-line pointer-events-none absolute right-1 h-0.5" style={{ left: 4 + depth * INDENT, [landing === 'before' ? 'top' : 'bottom']: -1 }}/>
        ) : null}
      </div>
    );
  });

  return (
    <>
    <div ref={box} role="tree" aria-label={label} aria-describedby={onMove ? keyboardHelpId : undefined} className="layer-tree relative isolate overflow-auto" onMouseLeave={() => { setHighlight(null); onHover?.(null); }}>
      {onMove ? <span id={keyboardHelpId} className="sr-only">Press Space to pick up a layer, Up or Down to change its position, Enter to drop it, or Escape to cancel.</span> : null}
      <AnimatePresence>
        {highlight && (
          <motion.div
            aria-hidden="true"
            className="layer-tree-highlight pointer-events-none absolute inset-x-0 z-0 rounded-md"
            initial={{ opacity: 0, top: highlight.top, height: highlight.height }}
            animate={{ opacity: 1, top: highlight.top, height: highlight.height }}
            exit={{ opacity: 0 }}
            transition={reduced ? INSTANT : SPRING}
          />
        )}
      </AnimatePresence>
      {visible.length ? rows : <div className="flex h-7 items-center px-2 text-xs text-muted-foreground">{emptyLabel}</div>}
    </div>
    <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">{announcement}</div>
    </>
  );
}
