// src/workspace/request-classes.ts
//
// PURPOSE
//   The page's requests share one browser connection pool. A person pressing Send, Stop or Approve must never wait behind
//   the long catalogue and list reads that fill a screen, so every request has a class (src/workspace/request-classes.json)
//   and a class can yield to another and be limited in how many run at once.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Classes, matches, limits and yields are DATA; nothing here names a path or a class.
//   2. A request is never refused or dropped by this file: it waits its turn and then runs; a request that fails frees its
//      place like one that succeeds.
//   3. A class that yields waits only while a class it yields to has a request in flight, so it cannot starve once those end.
//   4. A request that matches no class is in the default class.
import rules from './request-classes.json' with { type: 'json' };

type Rule = { id: string; match: { methods?: string[]; path_prefixes?: string[] }; concurrency: number | null; yield_to: string[] };
type Rules = { default: string; classes: Rule[] };

/** The class of a request under the rules. */
export function classOf(path: string, method: string | undefined, data: Rules = rules as Rules): Rule {
  const verb = (method ?? 'GET').toUpperCase();
  const found = data.classes.find(row => {
    const { methods, path_prefixes: prefixes } = row.match;
    if (methods && !methods.includes(verb)) return false;
    if (prefixes && !prefixes.some(prefix => path.startsWith(prefix))) return false;
    return Boolean(methods || prefixes);
  });
  return found ?? data.classes.find(row => row.id === data.default)!;
}

/** A scheduler over the rules: `run(path, method, task)` runs the task when its class may. */
export function requestScheduler(data: Rules = rules as Rules) {
  const flying = new Map<string, number>();
  const waiting: Array<{ rule: Rule; go: () => void }> = [];
  const count = (id: string) => flying.get(id) ?? 0;
  const mayRun = (rule: Rule) => (rule.concurrency === null || count(rule.id) < rule.concurrency) && !rule.yield_to.some(id => count(id) > 0);
  const drain = () => {
    for (let at = 0; at < waiting.length;) {
      if (mayRun(waiting[at].rule)) { const [next] = waiting.splice(at, 1); flying.set(next.rule.id, count(next.rule.id) + 1); next.go(); } else at += 1;
    }
  };
  return {
    async run<T>(path: string, method: string | undefined, task: () => Promise<T>): Promise<T> {
      const rule = classOf(path, method, data);
      if (mayRun(rule)) flying.set(rule.id, count(rule.id) + 1);
      else await new Promise<void>(go => waiting.push({ rule, go }));
      try { return await task(); } finally { flying.set(rule.id, count(rule.id) - 1); drain(); }
    },
    inFlight: (id: string) => count(id),
    waiting: () => waiting.length,
  };
}

/** The page's one scheduler. */
export const pageRequests = requestScheduler();
