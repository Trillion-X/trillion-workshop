// packages/ui/show/selection/useSelection.ts
//
// =============================================================================
// PURPOSE — P1: Selection is an addressed NodeRef SET (the one SSOT artifact)
// =============================================================================
//
// Every selection GESTURE on any canvas — a click, a shift/⌘-click, a marquee
// rubber-band, select-all, or select-by-descriptor (kind / tag / color / preset)
// — produces the SAME artifact: a Set of serialized NodeRefs. This hook owns
// that set. It is the single source of truth for "what is selected" on a surface.
//
// It is GENERIC: it speaks only NodeRef (the universal addressed handle from
// node-actions/node-ref.ts). It has ZERO knowledge of boards, items, workflows,
// or any domain. A board, a workflow canvas, a screen-arrangement, and any future
// canvas all use this one hook; new selection gestures are just new callers of
// `replace`/`toggle` — never new selection code.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. The artifact is `ReadonlySet<string>` keyed by `serializeNodeRef(ref)`.
//    Identity is the serialization, so two NodeRefs addressing the same node
//    collapse to one entry (Set semantics, free dedup).
// 2. Pure browser-local state: no reads, writes, feeds, or package behavior.
// 3. Order-independent: a selection is a SET, not a list. The "primary" (anchor)
//    is tracked separately for ops that need a reference member (e.g. align-to-
//    primary, copy-from-primary), and is the most-recently added ref.
// 4. Every mutator returns nothing; read `selectedRefs`/`selectedKeys`/`primary`.
// =============================================================================

import { useCallback, useMemo, useRef, useState } from 'react';
import type { NodeRef } from 'trillion-workshop/tools/turn-frames-into-slides/read-data/node-ref.ts';
import { serializeNodeRef, parseNodeRef } from 'trillion-workshop/tools/turn-frames-into-slides/read-data/node-ref.ts';

export interface SelectionApi {
  /** Serialized-key set — the SSOT artifact. */
  readonly selectedKeys: ReadonlySet<string>;
  /** Parsed refs (derived from the key set). */
  readonly selectedRefs: readonly NodeRef[];
  /** Count of selected nodes. */
  readonly size: number;
  /** The anchor/reference member (most-recently added), or null when empty. */
  readonly primary: NodeRef | null;
  /** Is this ref selected? */
  has(ref: NodeRef): boolean;
  /** Replace the whole selection with exactly these refs (click, marquee, select-all, by-descriptor). */
  replace(refs: readonly NodeRef[]): void;
  /** Add/remove one ref (shift/⌘-click). `additive=false` → behaves like replace([ref]). */
  select(ref: NodeRef, opts?: { additive?: boolean }): void;
  /** Toggle one ref's membership, keeping the rest. */
  toggle(ref: NodeRef): void;
  /** Add these refs to the current selection (marquee with shift held). */
  add(refs: readonly NodeRef[]): void;
  /** Clear everything. */
  clear(): void;
}

/** The one selection hook. Holds a Set<serializedNodeRef> + a primary anchor. */
export function useSelection(): SelectionApi {
  const [selectedKeys, setSelectedKeys] = useState<ReadonlySet<string>>(() => new Set());
  // Primary = anchor member for primary-relative ops (align-to-primary, copy-from).
  const primaryKeyRef = useRef<string | null>(null);
  const [primaryKey, setPrimaryKey] = useState<string | null>(null);

  const setBoth = useCallback((next: Set<string>, primary: string | null) => {
    primaryKeyRef.current = primary;
    setPrimaryKey(primary);
    setSelectedKeys(next);
  }, []);

  const replace = useCallback(
    (refs: readonly NodeRef[]) => {
      const keys = refs.map(serializeNodeRef);
      const next = new Set(keys);
      const primary = keys.length ? keys[keys.length - 1] : null;
      setBoth(next, primary);
    },
    [setBoth],
  );

  const add = useCallback(
    (refs: readonly NodeRef[]) => {
      setSelectedKeys((prev) => {
        const next = new Set(prev);
        let lastAdded: string | null = primaryKeyRef.current;
        for (const ref of refs) {
          const key = serializeNodeRef(ref);
          next.add(key);
          lastAdded = key;
        }
        primaryKeyRef.current = lastAdded;
        setPrimaryKey(lastAdded);
        return next;
      });
    },
    [],
  );

  const toggle = useCallback((ref: NodeRef) => {
    const key = serializeNodeRef(ref);
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
        if (primaryKeyRef.current === key) {
          // primary removed → fall back to any remaining member (deterministic: last in iteration)
          let fallback: string | null = null;
          for (const k of next) fallback = k;
          primaryKeyRef.current = fallback;
          setPrimaryKey(fallback);
        }
      } else {
        next.add(key);
        primaryKeyRef.current = key;
        setPrimaryKey(key);
      }
      return next;
    });
  }, []);

  const select = useCallback(
    (ref: NodeRef, opts?: { additive?: boolean }) => {
      if (opts?.additive) toggle(ref);
      else replace([ref]);
    },
    [toggle, replace],
  );

  const clear = useCallback(() => setBoth(new Set(), null), [setBoth]);

  const has = useCallback((ref: NodeRef) => selectedKeys.has(serializeNodeRef(ref)), [selectedKeys]);

  const selectedRefs = useMemo(() => {
    const refs: NodeRef[] = [];
    for (const key of selectedKeys) {
      const ref = parseNodeRef(key);
      if (ref) refs.push(ref);
    }
    return refs;
  }, [selectedKeys]);

  const primary = useMemo(() => (primaryKey ? parseNodeRef(primaryKey) : null), [primaryKey]);

  return {
    selectedKeys,
    selectedRefs,
    size: selectedKeys.size,
    primary,
    has,
    replace,
    select,
    toggle,
    add,
    clear,
  };
}
