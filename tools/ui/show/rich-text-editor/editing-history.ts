import {
  createCommandHistory,
  type CommandHistory,
  type HistoryOutcome,
} from 'trillion-workshop/tools/ui/show/canvas-history/command-history.ts';

export type EditorHistory<T> = {
  record: (before: T, after: T, group?: string) => void;
  undo: () => Promise<HistoryOutcome>;
  redo: () => Promise<HistoryOutcome>;
  clear: () => void;
  state: CommandHistory['state'];
};

/**
 * Record editor snapshots through the shared history owner. Consecutive input
 * events from the same block coalesce into one undo step; every ungrouped model
 * operation forms its own step and closes the active typing group.
 */
export function createEditorHistory<T>(options: {
  apply: (snapshot: T) => void | Promise<void>;
  limit?: number;
  groupWindowMs?: number;
  now?: () => number;
  onChange?: () => void;
}): EditorHistory<T> {
  const now = options.now ?? Date.now;
  const groupWindowMs = options.groupWindowMs ?? 900;
  let active: { key: string; after: T; lastAt: number } | null = null;
  const owner = createCommandHistory({
    limit: options.limit,
    onChange: () => options.onChange?.(),
  });

  const closeGroup = () => { active = null; };
  return {
    record(before, after, group) {
      const at = now();
      if (group && active?.key === group && at - active.lastAt <= groupWindowMs) {
        active.after = after;
        active.lastAt = at;
        return;
      }
      closeGroup();
      if (!group) {
        owner.record({ revert: () => options.apply(before), apply: () => options.apply(after) });
        return;
      }
      const entry = { key: group, before, after, lastAt: at };
      active = entry;
      owner.record({
        revert: () => options.apply(entry.before),
        apply: () => options.apply(entry.after),
      });
    },
    undo() { closeGroup(); return owner.undo(); },
    redo() { closeGroup(); return owner.redo(); },
    clear() { closeGroup(); owner.clear(); },
    state: owner.state,
  };
}
