// parts/ui/show/file-tree/FileTree.tsx
//
// PURPOSE
//   An explorable tree of folders and files that loads each folder only when it is opened: a highlight that glides to
//   the row under the pointer, folders that spring open and closed with their icon swapping, several rows chosen with
//   Cmd/Ctrl or Shift, rows dragged out, and folders that take a drop while showing, before release, what the drop
//   will do there. Adapted from "Animated File Tree Primitives" (21st.dev component 20042, by unlumen), see
//   provenance.json.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Domain-blind: a node is an id, a name, whether it is a folder, and optional icon and detail words; what a
//      folder holds comes from the caller's `load`, and what a drag carries and what a drop does are the caller's.
//   2. A folder is read once when first opened; reading again is the caller's (`reloadKey`). A folder with more than
//      one page shows one "Show more" row that asks for the next page.
//   3. Selection is controlled: the caller keeps the chosen ids; the tree only reports changes.
//   4. A drop target says what will happen before release (`dropLabel`), and only while something is over it.
//   5. Motion respects reduced-motion preferences: the springs become instant.
//   6. This is the shared owner of the tree's markup; screens hand it data and never write rows themselves.

import * as React from 'react';
import {AnimatePresence, useReducedMotion} from 'framer-motion';
import { motion } from 'trillion-workshop/tools/ui/motion/lazy-motion.tsx';
import { NamedIcon } from '../icon/NamedIcon';
import { Button } from '../coss/ui/button';
import { cn } from '../cn';

export type FileTreeNode = {
  id: string;
  name: string;
  folder: boolean;
  /** False leaves folders browsable without selecting them as files. */
  selectable?: boolean;
  /** A named icon for the row (a file's type); a folder draws the open/closed folder. */
  icon?: string;
  /** Quiet words at the end of the row, such as a size. */
  detail?: string;
};

export type FileTreePage = { nodes: FileTreeNode[]; more: boolean };

export type FileTreeProps = {
  /** The first level of the tree. */
  roots: FileTreeNode[];
  /** What a folder holds, page by page (`page` starts at 0). */
  load: (folder: FileTreeNode, page: number) => Promise<FileTreePage>;
  label: string;
  selected?: string[];
  /** Single replaces the pick; multiple toggles on click/touch. Omitted preserves modifier-based selection. */
  selectionMode?: 'single' | 'multiple';
  onSelectionChange?: (ids: string[], nodes: FileTreeNode[]) => void;
  /** A row opened by double click or Enter. */
  onOpen?: (node: FileTreeNode) => void;
  /** Dragging one or several chosen rows: the caller puts what they carry on the event. */
  onDragOut?: (nodes: FileTreeNode[], event: React.DragEvent) => void;
  /** What dropping the dragged thing on this folder would do, in words, or null when it cannot be dropped here. */
  dropLabel?: (folder: FileTreeNode, event: React.DragEvent) => string | null;
  onDrop?: (folder: FileTreeNode, event: React.DragEvent) => void;
  /** Wraps a row, for a hover card around it; must render `row`. */
  wrapRow?: (node: FileTreeNode, row: React.ReactElement<Record<string, unknown>>) => React.ReactElement;
  /** Folders open (and read) when the tree first appears. */
  initiallyOpen?: string[];
  /** Changing this reads every opened folder again. */
  reloadKey?: unknown;
  emptyLabel?: string;
  loadingLabel?: string;
  failedLabel?: string;
  moreLabel?: string;
};

type Branch = { state: 'loading' | 'ready' | 'failed'; nodes: FileTreeNode[]; more: boolean; pages: number };
type Visible = { node: FileTreeNode; depth: number };

const SPRING = { type: 'spring' as const, stiffness: 750, damping: 40 };
const ICON_SPRING = { type: 'spring' as const, stiffness: 500, damping: 30, mass: 0.8 };
const INSTANT = { duration: 0 };

export function FileTree({
  roots, load, label, selected = [], selectionMode, onSelectionChange, onOpen, onDragOut, dropLabel, onDrop, wrapRow, initiallyOpen, reloadKey,
  emptyLabel = 'Nothing here', loadingLabel = 'Loading…', failedLabel = 'This folder could not be read', moreLabel = 'Show more',
}: FileTreeProps) {
  const reduced = useReducedMotion();
  const [open, setOpen] = React.useState<Set<string>>(() => new Set(initiallyOpen));
  const [branches, setBranches] = React.useState<Map<string, Branch>>(() => new Map());
  const [highlight, setHighlight] = React.useState<{ top: number; height: number } | null>(null);
  const [over, setOver] = React.useState<{ id: string; words: string } | null>(null);
  const [anchor, setAnchor] = React.useState<string | null>(null);
  const [focus, setFocus] = React.useState<string | null>(null);
  const box = React.useRef<HTMLDivElement>(null);
  const nodes = React.useRef(new Map<string, FileTreeNode>());
  const reading = React.useRef(new Map<string, symbol>());
  const revision = React.useRef(0);
  React.useEffect(() => () => { revision.current++; reading.current.clear(); }, []);
  for (const node of roots) nodes.current.set(node.id, node);
  for (const branch of branches.values()) for (const node of branch.nodes) nodes.current.set(node.id, node);

  const read = React.useCallback(async (folder: FileTreeNode, page: number) => {
    if (reading.current.has(folder.id)) return;
    const token = Symbol(folder.id);
    const current = revision.current;
    reading.current.set(folder.id, token);
    const active = () => revision.current === current && reading.current.get(folder.id) === token;
    setBranches(now => new Map(now).set(folder.id, { ...(page === 0 ? { nodes: [], more: false, pages: 0 } : now.get(folder.id) ?? { nodes: [], more: false, pages: 0 }), state: 'loading' }));
    try {
      const got = await load(folder, page);
      if (!active()) return;
      setBranches(now => {
        const before = page === 0 ? [] : now.get(folder.id)?.nodes ?? [];
        return new Map(now).set(folder.id, { state: 'ready', nodes: [...new Map([...before, ...got.nodes].map(node => [node.id, node])).values()], more: got.more, pages: page + 1 });
      });
    } catch {
      if (!active()) return;
      setBranches(now => new Map(now).set(folder.id, { ...(now.get(folder.id) ?? { nodes: [], more: false, pages: 0 }), state: 'failed' }));
    } finally { if (reading.current.get(folder.id) === token) reading.current.delete(folder.id); }
  }, [load]);

  // The folders open at the start are read once.
  React.useEffect(() => {
    for (const id of initiallyOpen ?? []) { const node = nodes.current.get(id); if (node?.folder) void read(node, 0); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reading again: every open folder from its first page.
  const first = React.useRef(true);
  React.useEffect(() => {
    if (first.current) { first.current = false; return; }
    revision.current++;
    reading.current.clear();
    for (const id of open) { const node = nodes.current.get(id); if (node) void read(node, 0); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadKey]);

  const toggle = (node: FileTreeNode) => {
    const opening = !open.has(node.id);
    setOpen(now => {
      const next = new Set(now);
      if (opening) next.add(node.id); else next.delete(node.id);
      return next;
    });
    if (opening && !branches.has(node.id)) void read(node, 0);
  };

  const visible: Visible[] = [];
  const walk = (list: FileTreeNode[], depth: number) => {
    for (const node of list) {
      visible.push({ node, depth });
      if (node.folder && open.has(node.id)) walk(branches.get(node.id)?.nodes ?? [], depth + 1);
    }
  };
  walk(roots, 0);

  const choose = (node: FileTreeNode, event: React.MouseEvent | React.KeyboardEvent) => {
    if (node.selectable === false) return;
    let ids: string[];
    if (selectionMode === 'single') { ids = [node.id]; setAnchor(node.id); }
    else if (event.shiftKey && anchor) {
      const order = visible.map(row => row.node.id);
      const [from, to] = [order.indexOf(anchor), order.indexOf(node.id)].sort((a, b) => a - b);
      ids = from < 0 ? [node.id] : order.slice(from, to + 1).filter(id => nodes.current.get(id)?.selectable !== false);
    } else if (selectionMode === 'multiple' || event.metaKey || event.ctrlKey) {
      ids = selected.includes(node.id) ? selected.filter(id => id !== node.id) : [...selected, node.id];
      setAnchor(node.id);
    } else {
      ids = [node.id];
      setAnchor(node.id);
    }
    onSelectionChange?.(ids, ids.map(id => nodes.current.get(id)).filter(Boolean) as FileTreeNode[]);
  };

  const glide = (element: HTMLElement) => {
    const outer = box.current?.getBoundingClientRect();
    const inner = element.getBoundingClientRect();
    if (outer) setHighlight({ top: inner.top - outer.top + (box.current?.scrollTop ?? 0), height: inner.height });
  };

  const onKey = (event: React.KeyboardEvent, node: FileTreeNode) => {
    const order = visible.map(row => row.node);
    const at = order.findIndex(item => item.id === node.id);
    const move = (to: number) => { const next = order[Math.max(0, Math.min(order.length - 1, to))]; if (next) { setFocus(next.id); box.current?.querySelector<HTMLElement>(`[data-tree-id="${CSS.escape(next.id)}"]`)?.focus(); } };
    if (event.key === 'ArrowDown') { event.preventDefault(); move(at + 1); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); move(at - 1); }
    else if (event.key === 'ArrowRight' && node.folder && !open.has(node.id)) { event.preventDefault(); toggle(node); }
    else if (event.key === 'ArrowLeft' && node.folder && open.has(node.id)) { event.preventDefault(); toggle(node); }
    else if (event.key === ' ') { event.preventDefault(); choose(node, event); }
    else if (event.key === 'Enter') { event.preventDefault(); if (node.folder) toggle(node); else onOpen?.(node); }
  };

  const row = (node: FileTreeNode, depth: number) => {
    const isOpen = open.has(node.id);
    const chosen = selected.includes(node.id);
    const dropping = over?.id === node.id;
    const element = (
      <div
        role="treeitem"
        aria-level={depth + 1}
        aria-selected={chosen}
        aria-expanded={node.folder ? isOpen : undefined}
        tabIndex={(focus ?? visible[0]?.node.id) === node.id ? 0 : -1}
        data-tree-id={node.id}
        data-chosen={chosen ? '' : undefined}
        data-dropping={dropping ? '' : undefined}
        draggable={Boolean(onDragOut)}
        className={cn('file-tree-row relative z-[1] flex h-8 cursor-default select-none items-center gap-2 rounded-lg pr-2 text-sm outline-none',
          chosen && 'file-tree-row-chosen', dropping && 'file-tree-row-dropping')}
        style={{ paddingLeft: 8 + depth * 18 }}
        onMouseEnter={event => glide(event.currentTarget)}
        onFocus={event => { setFocus(node.id); glide(event.currentTarget); }}
        onClick={event => { choose(node, event); if (node.folder && !event.metaKey && !event.ctrlKey && !event.shiftKey) toggle(node); }}
        onDoubleClick={() => { if (!node.folder) onOpen?.(node); }}
        onKeyDown={event => onKey(event, node)}
        onDragStart={event => {
          const ids = chosen ? selected : [node.id];
          if (!chosen) onSelectionChange?.(ids, [node]);
          onDragOut?.(ids.map(id => nodes.current.get(id)).filter(Boolean) as FileTreeNode[], event);
        }}
        onDragOver={node.folder && dropLabel ? event => {
          const words = dropLabel(node, event);
          if (!words) return;
          event.preventDefault();
          if (over?.id !== node.id || over.words !== words) setOver({ id: node.id, words });
        } : undefined}
        onDragLeave={node.folder ? event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setOver(now => (now?.id === node.id ? null : now)); } : undefined}
        onDrop={node.folder && onDrop ? event => { event.preventDefault(); setOver(null); onDrop(node, event); } : undefined}
      >
        {node.folder ? (
          <motion.span className="inline-flex size-4 shrink-0 text-muted-foreground" animate={{ rotate: isOpen ? 90 : 0 }} transition={reduced ? INSTANT : ICON_SPRING}>
            <NamedIcon name="ChevronRight" size="md" aria-hidden="true"/>
          </motion.span>
        ) : <span className="inline-flex size-4 shrink-0"/>}
        <span className="relative inline-flex size-[1.125rem] shrink-0 text-muted-foreground">
          <AnimatePresence initial={false} mode="popLayout">
            <motion.span
              key={node.folder ? (isOpen ? 'open' : 'closed') : 'file'}
              className="inline-flex"
              initial={reduced ? false : { scale: 0.5, opacity: 0, rotate: -15 }}
              animate={{ scale: 1, opacity: 1, rotate: 0 }}
              exit={reduced ? undefined : { scale: 0.5, opacity: 0, rotate: 15 }}
              transition={reduced ? INSTANT : ICON_SPRING}
            >
              <NamedIcon name={node.folder ? (isOpen ? 'FolderOpen' : 'Folder') : node.icon ?? 'File'} size="md" aria-hidden="true"/>
            </motion.span>
          </AnimatePresence>
        </span>
        <span className="min-w-0 flex-1 truncate">{node.name}</span>
        {dropping ? <span className="file-tree-drop-words shrink-0 text-xs font-medium">{over.words}</span>
          : node.detail ? <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{node.detail}</span> : null}
      </div>
    );
    return wrapRow ? wrapRow(node, element) : element;
  };

  const note = (key: string, depth: number, words: string, action?: () => void) => (
    <div key={key} className="relative z-[1] flex h-8 items-center text-xs text-muted-foreground" style={{ paddingLeft: 34 + depth * 18 }}>
      {action ? <Button variant="ghost" size="xs" onClick={action}>{words}</Button> : words}
    </div>
  );

  const level = (list: FileTreeNode[], depth: number): React.ReactNode => list.map(node => (
    <React.Fragment key={node.id}>
      {row(node, depth)}
      {node.folder ? (
        <AnimatePresence initial={false}>
          {open.has(node.id) && (
            <motion.div role="group" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={reduced ? INSTANT : SPRING} style={{ overflow: 'hidden' }}>
              {(() => {
                const branch = branches.get(node.id);
                if (!branch || (branch.state === 'loading' && !branch.nodes.length)) return note(`${node.id}:loading`, depth + 1, loadingLabel);
                if (branch.state === 'failed' && !branch.nodes.length) return note(`${node.id}:failed`, depth + 1, failedLabel, () => void read(node, branch.pages));
                return <>
                  {branch.nodes.length ? level(branch.nodes, depth + 1) : note(`${node.id}:empty`, depth + 1, emptyLabel)}
                  {branch.state === 'failed' ? note(`${node.id}:retry`, depth + 1, failedLabel, () => void read(node, branch.pages))
                    : branch.more ? note(`${node.id}:more`, depth + 1, branch.state === 'loading' ? loadingLabel : moreLabel, branch.state === 'loading' ? undefined : () => void read(node, branch.pages)) : null}
                </>;
              })()}
            </motion.div>
          )}
        </AnimatePresence>
      ) : null}
    </React.Fragment>
  ));

  return (
    <div ref={box} role="tree" aria-label={label} aria-multiselectable={selectionMode !== 'single'} className="file-tree relative isolate overflow-auto" onMouseLeave={() => setHighlight(null)}>
      <AnimatePresence>
        {highlight && (
          <motion.div
            aria-hidden="true"
            className="file-tree-highlight pointer-events-none absolute inset-x-0 z-0 rounded-lg"
            initial={{ opacity: 0, top: highlight.top, height: highlight.height }}
            animate={{ opacity: 1, top: highlight.top, height: highlight.height }}
            exit={{ opacity: 0 }}
            transition={reduced ? INSTANT : SPRING}
          />
        )}
      </AnimatePresence>
      {roots.length ? level(roots, 0) : note('empty', 0, emptyLabel)}
    </div>
  );
}
