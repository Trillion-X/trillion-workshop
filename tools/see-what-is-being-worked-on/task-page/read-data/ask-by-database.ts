// The task page's two addresses (pursuits, data) answered from one kept session per database. The engine never starts one
// run that holds the keys of two places, so a page over several databases cannot ask one session for all of them: each
// database has a session of its own (start input dbs = [that database]), the list of pursuits is asked of the pages
// database's session, and each chosen pursuit's data is asked of its own database's session, given the pursuit's row as the pages database listed it (a database need keep no task_pages of its own). The answers are joined into
// the shape one session gave (tasks, statuses, shows, changes, facts, fact_kinds). A database whose call fails is named
// in `unread` with its own words, and the others are still drawn; only when every one fails is the ask refused.
import type { Data } from './task-rows';

export type Pursuit = { id: string; label: string; database: string; tables?: Record<string, string> };
/** One call of the session started with `input`: its name, its arguments, its answer. */
export type CallSession = (name: string, args: Record<string, unknown>, input: Record<string, unknown>) => Promise<any>;
export type Joined = Data & { unread?: { ids: string[]; label: string; error: string }[] };

type Named = { name: string; place: number };
/** The rows of several lists, one per name (the first kept), in their place. */
function firstByName(lists: (Named[] | undefined)[]): any[] {
  const kept = new Map<string, Named>();
  for (const list of lists) for (const one of list ?? []) if (!kept.has(one.name)) kept.set(one.name, one);
  return [...kept.values()].sort((a, b) => a.place - b.place);
}

/** Several databases' answers as one: each key's rows joined, a status or fact kind once by name, changes in time order. */
export function joinAnswers(parts: Partial<Data>[]): Data {
  const joined = (key: 'tasks' | 'shows' | 'changes' | 'facts'): any[] => parts.flatMap(part => (part[key] ?? []) as any[]);
  return { tasks: joined('tasks'), statuses: firstByName(parts.map(part => part.statuses)), shows: joined('shows'),
    changes: joined('changes').sort((a, b) => a.at.localeCompare(b.at)), facts: joined('facts'), fact_kinds: firstByName(parts.map(part => part.fact_kinds)) };
}

const wordsOf = (error: unknown) => String((error as Error)?.message ?? error);

/** The page's ask: `call` asks the session started for the given input. `dbs` are the database names; `pagesDatabase` is the
 *  one whose task_pages names the pursuits. */
export function askByDatabase({ call, dbs, pagesDatabase }: { call: CallSession; dbs: string[]; pagesDatabase: string }) {
  const only = (database: string) => ({ named: [{ database }], input: { dbs: [{ database }] } });
  const pursuits = async (): Promise<Pursuit[]> => {
    const { named, input } = only(pagesDatabase);
    const answer = await call('pursuits', { dbs: named, pages_database: pagesDatabase }, input);
    if (!Array.isArray(answer?.items)) throw new Error('the session answered no pursuits');
    return (answer.items as Pursuit[]).filter(one => dbs.includes(one.database));
  };
  return async (url: string): Promise<string> => {
    const asked = new URL(url, 'http://page/');
    if (asked.pathname.endsWith('/pursuits')) return JSON.stringify(await pursuits());
    const ids = (asked.searchParams.get('p') ?? '').split(',').filter(Boolean);
    const chosen = (await pursuits()).filter(one => ids.includes(one.id));
    const databases = [...new Set(chosen.map(one => one.database))];
    const settled = await Promise.allSettled(databases.map(async database => {
      const { named, input } = only(database);
      const answered = await call('data', { dbs: named, pursuits: chosen.filter(one => one.database === database).map(one => ({ id: one.id, database: one.database, tables: one.tables ?? {} })) }, input);
      if (!answered || typeof answered !== 'object') throw new Error('the session answered nothing');
      return answered;
    }));
    const unread = settled.flatMap((result, at) => (result.status === 'rejected'
      ? [{ ids: chosen.filter(one => one.database === databases[at]).map(one => one.id), label: chosen.filter(one => one.database === databases[at]).map(one => one.label).join(', '), error: wordsOf(result.reason) }] : []));
    const parts = settled.flatMap(result => (result.status === 'fulfilled' ? [result.value] : []));
    if (databases.length && !parts.length) throw new Error(unread.map(one => `${one.label}: ${one.error}`).join('; '));
    const answer: Joined = { ...joinAnswers(parts), ...(unread.length ? { unread } : {}) };
    return JSON.stringify(answer);
  };
}
