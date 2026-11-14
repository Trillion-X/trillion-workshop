// src/workspace/leave-blockers.ts
//
// PURPOSE
//   One registry of unsaved work in this page, asked before anything tears the page down (leaving it, signing out,
//   switching account). A screen that holds work the person has not saved says so here; the page asks once and the
//   answer names what would be lost, instead of every feature wiring its own quit hook.
//
// NON-NEGOTIABLE INVARIANTS
//   1. A blocker has a kind (an id in leave-blockers.json `kinds`; a kind the DATA does not know is still counted, as
//      "unsaved item") and is held until its owner releases it. Release is idempotent.
//   2. A store that already knows its own count registers a counter instead; the counter is read each time the page
//      asks, never cached here.
//   3. The refusal is plain words naming each kind and how many, from the DATA's words: `3 unsaved: 2 edits, 1 draft.`
//      It is null when nothing is unsaved.
//   4. The page-leave guard only asks the browser to confirm leaving while something is unsaved; it never blocks a
//      page with nothing unsaved and holds no state of its own.
import words from './leave-blockers.json';

type Counter = () => number;
type Held = { kind: string; count: Counter };
const held = new Set<Held>();

/** Marks unsaved work of one kind until the returned release is called. */
export function holdLeaveBlocker(kind: string, count = 1): () => void {
  const entry: Held = { kind, count: () => count };
  held.add(entry);
  return () => { held.delete(entry); };
}

/** Registers a store's own count of unsaved work of one kind; the returned function stops asking it. */
export function registerLeaveCounter(kind: string, count: Counter): () => void {
  const entry: Held = { kind, count };
  held.add(entry);
  return () => { held.delete(entry); };
}

/** What is unsaved now, by kind, in the order kinds first appeared. */
export function leaveBlockers(): { kind: string; count: number }[] {
  const totals = new Map<string, number>();
  for (const entry of held) {
    const count = Math.max(0, Math.floor(Number(entry.count()) || 0));
    if (count > 0) totals.set(entry.kind, (totals.get(entry.kind) ?? 0) + count);
  }
  return [...totals].map(([kind, count]) => ({ kind, count }));
}

/** The plain words for what would be lost by leaving, or null when nothing is unsaved. */
export function leaveRefusal(): string | null {
  const blockers = leaveBlockers();
  if (!blockers.length) return null;
  const kinds = words.kinds as Record<string, { noun: string; plural: string }>;
  const list = blockers.map(({ kind, count }) => {
    const spec = kinds[kind] ?? words.unknown_kind;
    return `${count} ${count === 1 ? spec.noun : spec.plural}`;
  }).join(words.separator);
  return words.refusal.replace('{count}', String(blockers.reduce((sum, row) => sum + row.count, 0))).replace('{list}', list);
}

/** Asks the browser to confirm leaving the page while anything is unsaved. Installed once by the signed-in page. */
export function installLeaveGuard(target: Pick<Window, 'addEventListener'> = window): void {
  target.addEventListener('beforeunload', event => {
    if (!leaveRefusal()) return;
    event.preventDefault();
    (event as BeforeUnloadEvent).returnValue = '';
  });
}
