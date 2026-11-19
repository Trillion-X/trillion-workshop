// The task rows read once for both views (Now and History): the moments of change, every task as it stood at a
// moment, the task tree in one fixed order, and how a goal and its work items count. What a status means (done,
// closed, its mark and colour) is a row of task_statuses, never a name in code.
import type { StepMarkState } from 'trillion-workshop/tools/ui/show/step-mark/StepMark';

export type Task = { id: string; title: string; parent: string | null; status: string; plain_title?: string | null; plain_detail?: string | null; waiting_on?: string | null; evidence?: string | null };
export type Change = { task: string; at: string; kind: string; status: string | null; title?: string | null };
export type Status = { name: string; mark: StepMarkState; tone: string | null; counts_as_done: boolean; closed: boolean; place: number };
/** A show: a thing a task produced, drawn inline when the task is opened. `made_at` says when it was made; History draws it only from then on. */
export type Show = { task: string; ref: string; label: string; made_at: string };
/** A fact: one part of a task's state (what happened, a count, what it is stuck on, the next step), of a kind that is a row. */
export type Fact = { task: string; kind: string; said: string; number: number | null; of_number: number | null; at: string };
export type FactKind = { name: string; label: string; place: number; tone: string | null };
export type Data = { tasks: Task[]; changes: Change[]; statuses: Status[]; shows: Show[]; facts?: Fact[]; fact_kinds?: FactKind[] };
export type Moment = { at: string; changes: Change[]; label: string; title: string };
/** kids: each task's rows in the fixed order (null: the roots); items: the work items under each task, at any depth. */
export type Tree = { kids: Map<string | null, Task[]>; items: Map<string, string[]>; allItems: string[]; byId: Map<string, Task> };
export type Standing = { made: Set<string>; status: Map<string, string>; since: Map<string, string> };

export const when = (at: string) => new Date(at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
export const plain = (task: Task) => task.plain_title || task.title;
export const faint = 'color-mix(in srgb, var(--color-foreground) 38%, transparent)';
export const muted = 'var(--color-muted-foreground)';

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto', style: 'short' });
const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [['day', 864e5], ['hour', 36e5], ['minute', 6e4]];
/** "3 hr. ago", "yesterday", "now". */
export function ago(at: string, now = Date.now()) {
  const elapsed = Date.parse(at) - now;
  for (const [unit, size] of UNITS) if (Math.abs(elapsed) >= size) return relative.format(Math.round(elapsed / size), unit);
  return relative.format(0, 'minute');
}

export function momentsOf(data: Data): Moment[] {
  const groups = new Map<string, Change[]>();
  for (const change of data.changes) {
    const key = change.at.slice(0, 16);
    groups.set(key, [...(groups.get(key) ?? []), change]);
  }
  const names = new Map(data.tasks.map(task => [task.id, plain(task)]));
  return [...groups.values()].map(changes => {
    const made = changes.filter(c => c.kind === 'made').length, moved = changes.length - made;
    const label = [made && `${made} new task${made > 1 ? 's' : ''}`, moved && `${moved} update${moved > 1 ? 's' : ''}`].filter(Boolean).join(', ');
    const titles = [...new Set(changes.map(c => names.get(c.task) ?? c.title ?? c.task))];
    return { at: changes[0].at, changes, label, title: titles.length > 1 ? `${titles[0]}, and ${titles.length - 1} more` : titles[0] };
  });
}

/** Every task as it stood at the end of moment `index`: which were made, each one's status then and since when. */
export function standing(moments: Moment[], index: number): Standing {
  const made = new Set<string>(), status = new Map<string, string>(), since = new Map<string, string>();
  for (const moment of moments.slice(0, index + 1)) {
    for (const change of moment.changes) {
      if (!made.has(change.task)) since.set(change.task, change.at);
      made.add(change.task);
      if (change.status && change.status !== status.get(change.task)) { status.set(change.task, change.status); since.set(change.task, change.at); }
    }
  }
  return { made, status, since };
}

// The tree in one fixed order for the whole timeline. A work item sorts by when it first became done, else by when it
// was made; a goal by the first time any work item under it became done, else the first time it or anything under it
// was made. Done comes before never done, so ticks fill each group from the top down.
export function treeOf(data: Data, looks: Map<string, Status>): Tree {
  const firstDone = new Map<string, string>(), firstMade = new Map<string, string>();
  for (const change of data.changes) {
    if (!firstMade.has(change.task) || change.at < firstMade.get(change.task)!) firstMade.set(change.task, change.at);
    const done = change.status && looks.get(change.status)?.counts_as_done;
    if (done && (!firstDone.has(change.task) || change.at < firstDone.get(change.task)!)) firstDone.set(change.task, change.at);
  }
  const byId = new Map(data.tasks.map(task => [task.id, task]));
  const kids = new Map<string | null, Task[]>();
  for (const task of data.tasks) {
    const parent = task.parent && byId.has(task.parent) ? task.parent : null;
    kids.set(parent, [...(kids.get(parent) ?? []), task]);
  }
  const items = new Map<string, string[]>(), key = new Map<string, string>();
  const walk = (task: Task): string[] => {
    const under = kids.get(task.id) ?? [];
    const leaves = under.length ? under.flatMap(walk) : [task.id];
    items.set(task.id, leaves);
    const done = leaves.map(id => firstDone.get(id)).filter((at): at is string => !!at).sort()[0];
    const made = [task.id, ...under.map(k => k.id)].map(id => firstMade.get(id) ?? '9').sort()[0];
    key.set(task.id, done ? `0${done}` : `1${made}`);
    return leaves;
  };
  const allItems = (kids.get(null) ?? []).flatMap(walk);
  for (const list of kids.values()) list.sort((a, b) => key.get(a.id)!.localeCompare(key.get(b.id)!));
  return { kids, items, allItems, byId };
}

/** Each task's shows, in the order they were made. */
/** Each task's facts grouped by kind, kinds in their place order, facts in the order they were said. */
export function factsOf(data: Data): Map<string, { kind: FactKind; facts: Fact[] }[]> {
  const kinds = [...(data.fact_kinds ?? [])].sort((a, b) => a.place - b.place);
  const byTask = new Map<string, Fact[]>();
  for (const fact of data.facts ?? []) byTask.set(fact.task, [...(byTask.get(fact.task) ?? []), fact]);
  const out = new Map<string, { kind: FactKind; facts: Fact[] }[]>();
  for (const [task, facts] of byTask) {
    out.set(task, kinds.map(kind => ({ kind, facts: facts.filter(f => f.kind === kind.name) })).filter(group => group.facts.length > 0));
  }
  return out;
}

export function showsOf(data: Data): Map<string, Show[]> {
  const out = new Map<string, Show[]>();
  for (const show of data.shows) out.set(show.task, [...(out.get(show.task) ?? []), show]);
  return out;
}

/** The shows a task had made by the moment `at` (an ISO time). */
export const shownBy = (shows: Show[] | undefined, at: string) => (shows ?? []).filter(show => Date.parse(show.made_at) <= Date.parse(at));

/** How work items count: done ones, and the total that still matters (a closed item that is not done, such as one
 *  ruled out, leaves the total). */
export function tally(ids: string[], lookOf: (id: string) => Status | undefined) {
  let done = 0, total = 0;
  for (const id of ids) {
    const look = lookOf(id);
    if (look?.counts_as_done) done += 1;
    if (look?.counts_as_done || !look?.closed) total += 1;
  }
  return { done, total };
}

/** A goal is complete only when every work item under it is done AND its own row, if it has a status, is done too:
 *  a goal whose own work was never written as steps must not read as finished. */
export const goalComplete = (own: Status | undefined, count: { done: number; total: number }) =>
  count.total > 0 && count.done === count.total && (!own || own.counts_as_done);

/** The status word worth showing beside a row: a status that is not done and has a colour of its own; with `plainToo`,
 *  any status that is not done (a goal's own "To do" must show, since its ring cannot say it). */
export const statusWord = (look: Status | undefined, plainToo = false) =>
  (look && !look.counts_as_done && (plainToo || look.tone) ? look : undefined);
