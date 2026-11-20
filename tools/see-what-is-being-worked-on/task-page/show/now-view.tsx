// Now: where the work stands, as a summary and not a list. A few sentences first: how much is done, how the open work
// divides, what changed since the reader last looked. Then one tree of the goals,
// closed at first: each goal one line (its ring, its name, k of n, and a dot only when something under it is held up);
// opened in place it shows its sub-goals and its open work, with its done work behind a quiet "Show done". What a
// status means (open or closed, done, held up, its colour) comes from the task_statuses rows and the rows'
// `waiting_on`; no status name is in code. One row height, one type scale: goal 15px, item 14px, meta 12px.
// Every item is drawn once, in its place under its goal: held-up work is marked by its goal's dot and its own status
// word, never listed a second time above the goals (a page over many pursuits would open on a wall of such lines).
//
// Anatomy (inspiration, original code): Workshop ui/show/status-overview (sections and counts, from 21st.dev 28770
// and Linear/Asana grouped lists on Mobbin), 21st.dev 29442 "Onboarding Checklist" (ring with k of n, rows that open in
// place), and the visual-hierarchy pairs: summary not a list, one hue, every state drawn.
// A row named in the address (#task=<row id>, the link anyone gives when they ask the reader to look at one row) is opened
// in place: every goal above it, the "Show done" it may sit behind, and the row itself; then it is scrolled to and marked.
// It is opened once per name, so the page's own refresh never takes the reader back to it.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ago, factsOf, goalComplete, muted, plain, showsOf, tally, when, type Data, type Standing, type Status, type Task, type Tree } from '../read-data/task-rows';
import { Chevron, Detail, Mark, Ring } from './task-marks';
import { OpenedShows } from './task-shows';

const INDENT = 22;
const ROW = 'tl-row min-h-9 py-1.5';
const NAMED = /^#task=(.+)$/;
const namedInAddress = () => { const m = NAMED.exec(location.hash); return m ? decodeURIComponent(m[1]) : null; };
const namedTone = 'color-mix(in srgb, var(--color-foreground) 6%, transparent)';

export function NowView({ data, tree, now, seenBefore }: { data: Data; tree: Tree; now: Standing; seenBefore: string | null }) {
  const looks = useMemo(() => new Map(data.statuses.map(s => [s.name, s])), [data]);
  const shows = useMemo(() => showsOf(data), [data]);
  const factGroups = useMemo(() => factsOf(data), [data]);
  const lookOf = (id: string) => looks.get(now.status.get(id) ?? '');
  const [open, setOpen] = useState<Set<string>>(new Set());
  const flip = (id: string) => setOpen(set => { const next = new Set(set); if (!next.delete(id)) next.add(id); return next; });
  const kidsOf = (id: string | null) => tree.kids.get(id) ?? [];
  const isGoal = (task: Task) => kidsOf(task.id).length > 0;
  const isOpenWork = (task: Task) => !lookOf(task.id)?.closed;
  // Held up: open, and either waiting on something named in its row or in a status drawn as unknown (blocked, broken).
  const heldUp = (task: Task) => isOpenWork(task) && (!!task.waiting_on || lookOf(task.id)?.mark === 'unknown');

  const all = useMemo(() => {
    const out: Task[] = [];
    const walk = (parent: string | null) => { for (const task of tree.kids.get(parent) ?? []) { out.push(task); walk(task.id); } };
    walk(null);
    return out;
  }, [tree]);
  const [named, setNamed] = useState(namedInAddress);
  const openedFor = useRef<string | null>(null);
  useEffect(() => { const on = () => setNamed(namedInAddress()); addEventListener('hashchange', on); return () => removeEventListener('hashchange', on); }, []);
  useEffect(() => {
    if (!named || openedFor.current === named) return;
    const byId = new Map(all.map(task => [task.id, task]));
    const parentOf = new Map<string, string | null>();
    for (const [parent, kids] of tree.kids) for (const kid of kids) parentOf.set(kid.id, parent);
    if (!byId.has(named)) return;
    openedFor.current = named;
    const keys: string[] = [named];
    for (let id = named; ;) {
      const parent = parentOf.get(id) ?? null;
      if (isDoneRow(byId.get(id)!)) keys.push(`done-${parent ?? 'top'}`);
      if (parent === null) break;
      keys.push(parent);
      id = parent;
    }
    setOpen(set => new Set([...set, ...keys]));
    requestAnimationFrame(() => document.getElementById(`row-${named}`)?.scrollIntoView({ block: 'center' }));
  }, [named, all, tree]);
  const count = tally(tree.allItems, lookOf);
  const held = all.filter(heldUp);
  const openByStatus = [...data.statuses].sort((a, b) => a.place - b.place).filter(s => !s.closed)
    .map(status => ({ status, n: tree.allItems.filter(id => now.status.get(id) === status.name).length })).filter(part => part.n);
  const ruledOut = [...data.statuses].filter(s => s.closed && !s.counts_as_done)
    .map(status => ({ status, n: tree.allItems.filter(id => now.status.get(id) === status.name).length })).filter(part => part.n);
  const changed = new Map<string, Status>();
  if (seenBefore) for (const c of data.changes) if (c.at > seenBefore && c.status && looks.get(c.status)) changed.set(c.task, looks.get(c.status)!);
  const changedParts = [...new Set(changed.values())].map(status => ({ status, n: [...changed.values()].filter(s => s === status).length }));

  // The held-up row at or under a goal that marks the goal's line: one drawn as unknown (blocked, broken) first, else
  // the first in the fixed order.
  const below = (id: string): string[] => kidsOf(id).flatMap(kid => [kid.id, ...below(kid.id)]);
  const heldUnder = (goal: Task) => { const under = new Set([goal.id, ...below(goal.id)]); const mine = held.filter(task => under.has(task.id)); return mine.find(task => lookOf(task.id)?.mark === 'unknown') ?? mine[0]; };
  const dot = (tone: string | null | undefined) => <i aria-hidden="true" className="inline-block h-2 w-2 flex-none rounded-full" style={{ background: tone ?? muted }} />;

  const item = (task: Task, depth: number) => {
    const look = lookOf(task.id), isOpen = open.has(task.id);
    const word = look && !look.counts_as_done && look.tone ? look : undefined;
    return (
      <li key={task.id} id={`row-${task.id}`} className="rounded-lg" style={{ paddingLeft: depth * INDENT, background: named === task.id ? namedTone : undefined }}>
        <button type="button" className={ROW} aria-expanded={isOpen} aria-controls={`now-${task.id}`} onClick={() => flip(task.id)}>
          <span className="flex w-[14px] flex-none" />
          <Mark look={look} />
          <span className="min-w-0 flex-1 truncate text-[14px] leading-6">{plain(task)}</span>
          {word && <span className="flex-none text-[12px]" style={{ color: word.tone! }}>{word.name}</span>}
        </button>
        {isOpen && (
          <div style={{ paddingLeft: 46 }}>
            {/* A row with facts says what it waits on among them; the waiting_on line is for a row without facts. */}
            {task.waiting_on && !factGroups.get(task.id)?.length && <p className="m-0 pb-1 text-[13px] leading-5"><span style={{ color: look?.tone ?? muted }}>Waiting on</span> {task.waiting_on}</p>}
            <Detail id={`now-${task.id}`} detail={task.plain_detail} evidence={task.evidence} look={look} title={task.title} shows={shows.get(task.id) ?? []} facts={factGroups.get(task.id) ?? []} assignees={task.assignees} takenBy={task.taken_by} />
          </div>
        )}
      </li>
    );
  };

  // A goal's rows: its open sub-goals and open work first, then its done ones behind a quiet "Show done".
  const isDoneRow = (task: Task) => {
    if (!isGoal(task)) return !isOpenWork(task);
    const steps = tally(tree.items.get(task.id) ?? [], lookOf);
    return steps.done === steps.total && !(lookOf(task.id) && isOpenWork(task));
  };
  const children = (parent: string | null, depth: number) => {
    const kids = kidsOf(parent), openKids = kids.filter(kid => !isDoneRow(kid)), doneKids = kids.filter(isDoneRow);
    const key = `done-${parent ?? 'top'}`, showDone = open.has(key);
    const draw = (kid: Task) => (isGoal(kid) ? goal(kid, depth) : item(kid, depth));
    return [
      ...openKids.map(draw),
      doneKids.length > 0 && (
        <li key={key} style={{ paddingLeft: depth * INDENT }}>
          <button type="button" className="tl-row min-h-8 py-1" style={{ color: muted }} aria-expanded={showDone} onClick={() => flip(key)}>
            <span className="flex w-[14px] flex-none" /><span className="text-[12px]">{showDone ? 'Hide done' : `Show ${doneKids.length} done`}</span>
          </button>
        </li>
      ),
      ...(showDone ? doneKids.map(draw) : []),
    ];
  };

  const goal = (task: Task, depth: number): React.ReactNode => {
    const leaves = tree.items.get(task.id) ?? [], steps = tally(leaves, lookOf), own = lookOf(task.id), isOpen = open.has(task.id);
    const attention = heldUnder(task);
    return (
      <li key={task.id} id={`row-${task.id}`} className="rounded-lg" style={{ paddingLeft: depth * INDENT, background: named === task.id ? namedTone : undefined }}>
        <button type="button" className={ROW} aria-expanded={isOpen} aria-controls={`now-${task.id}`} onClick={() => flip(task.id)}>
          <span className="flex w-[14px] flex-none justify-center"><Chevron open={isOpen} /></span>
          <Ring done={steps.done} total={steps.total} complete={goalComplete(own, steps)} />
          <span className="min-w-0 flex-1 truncate text-[15px] font-semibold leading-6">{plain(task)}</span>
          {attention && dot(lookOf(attention.id)?.tone)}
          {/* A goal whose steps are all done but whose own row is still open says so: its ring cannot. */}
          {own && !own.closed && steps.total > 0 && steps.done === steps.total && <span className="flex-none text-[12px]" style={{ color: own.tone ?? muted }}>{own.name}</span>}
          <span className="w-14 flex-none text-right text-[12px] tabular-nums" style={{ color: muted }}>{steps.done} of {steps.total}</span>
        </button>
        {isOpen && <OpenedShows shows={shows.get(task.id) ?? []} />}
        {isOpen && <ul id={`now-${task.id}`} className="m-0 list-none p-0">{children(task.id, 1)}</ul>}
      </li>
    );
  };

  const sentence = 'm-0 text-[15px] leading-7';
  return (
    <div className="mx-auto box-border flex w-full max-w-[720px] flex-col gap-6 px-6 pb-16 pt-7">
      <section aria-label="Summary" className="flex flex-col gap-1">
        <p className={sentence}>
          <strong className="font-semibold tabular-nums">{count.done} of {count.total}</strong> work items done
          {ruledOut.length > 0 && <span style={{ color: muted }}>, {ruledOut.map(p => `${p.n} ${p.status.name.toLowerCase()}`).join(', ')}</span>}.
          {openByStatus.length > 0 && <span style={{ color: muted }}> Open: {openByStatus.map(p => `${p.n} ${p.status.name.toLowerCase()}`).join(', ')}.</span>}
        </p>
        <div className="my-2 h-1 w-full overflow-hidden rounded-full" style={{ background: 'color-mix(in srgb, var(--color-foreground) 8%, transparent)' }}>
          <div className="h-full rounded-full" style={{ width: `${(count.done / Math.max(1, count.total)) * 100}%`, background: 'var(--color-success)' }} />
        </div>
        {changedParts.length > 0 && (
          <p className="m-0 text-[13px] leading-6" style={{ color: muted }}>
            Since you last looked ({when(seenBefore!)}, {ago(seenBefore!)}): {changedParts.map(p => `${p.n} ${p.status.name.toLowerCase()}`).join(', ')}.
          </p>
        )}
      </section>

      <section aria-label="Goals" className="rounded-2xl border px-4 py-2" style={{ borderColor: 'var(--color-border)', background: 'var(--color-card)' }}>
        <ul className="m-0 list-none p-0">{children(null, 0)}</ul>
      </section>
    </div>
  );
}
