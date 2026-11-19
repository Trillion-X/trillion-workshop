// Ported from old-trillion-before-worker-retire. The caller supplies trusted interaction settings read from rows.
// reportClientHealthIssue takes the issue's own record and the settings as input (the caller reads them from the operator's
// store and hands them in) and answers the issue and its job to keep. Input never selects the account.
// The caller keeps them in one conditional write, which refuses when the issue changed meanwhile.
// prepareProducedTask is the existing plan-tasks-and-todo-lists public owner, provided by the runtime through this package port.
// src/client-health.mjs
//
// Purpose: a grouped client health issue (src/interaction-log.mjs) as one task for Trillion HQ's own AIs. Each issue key
// has its own owner, one record book per issue (src/book-handlers.mjs 'client-health'), which keeps the issue and hands
// its fix work once to the AIs of the account that runs Trillion (the account `OPERATOR_ACCOUNT_ID` names, whose AIs
// take Trillion's own work). No book every issue shares and no store answers every report: every interaction log used
// to call the operator's store with each issue, and then one service book took them all.
//
// Non-Negotiable Invariants:
//   1. One issue key is one owner and one job id, and the job's words never carry the count: sending an issue again (its
//      first send landed but its answer was lost) reaches the same owner, which hands the job once (once_per).
//   2. Only a kind with fix_work and values its job allows (records/interactions.json) make a job: no person identifier,
//      exception text, stack or URL query reaches it.
//   3. An owner keeps an issue as handed only after the account took the job, so a busy account is handed it on the
//      next send, never twice.
//
//   clientHealthWork({ key, kind, facts }) → { id, said, job, outcome, priority, once_per }
//   clientHealthBookName(work) → the issue's book name
//   reportClientHealthIssue({ stored, settings, prepareProducedTask, now?, requestKey? }, issue) → { handoff_id, key, keep }
//     stored.records must be the list handed in (the issue's record, if one is kept); keep is [] once the issue is handed.
//   makeClientHealthIssue({ list, put, hand }) → { run('report', issue) }
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';

const fill = (template, values) => template.replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));
const invalid = () => new Error('Invalid client health issue.');

export function clientHealthWork({ key, kind, facts }, settings) {
  const row = settings.client_health.fix_work_row;
  const declared = settings.kinds.find(candidate => candidate.id === kind && candidate.fix_work);
  if (!declared || typeof key !== 'string' || !key || key.length > 500 || !facts || typeof facts !== 'object') throw invalid();
  if (!settings.surfaces.some(surface => surface.id === facts.surface) || !/^\/[a-z0-9/:._-]{0,120}$/i.test(facts.path ?? '')) throw invalid();
  for (const [field, allowed] of Object.entries(declared.allowed_values ?? {})) {
    if (declared.fix_work.group_by.includes(field) && !allowed.includes(facts[field])) throw invalid();
  }
  const words = { said: declared.fix_work.said ?? declared.label, shell: facts.shell, path: facts.path, category: facts.category };
  const id = `${row.id_prefix}${makeHashCodeHexFromBytes(new TextEncoder().encode(key)).slice(3, 35)}`;
  return { id, said: fill(row.said, words), job: fill(row.job, words), outcome: fill(row.outcome, words), priority: row.priority, once_per: `client-health:${id}` };
}

export const clientHealthBookName = work => `client-health:${work.id}`;

/** The issue's own owner answers the issue and its task to keep, once: keep is written by the caller in one conditional write. */
export async function reportClientHealthIssue(context, issue) {
  const { stored, settings, prepareProducedTask, now = () => new Date() } = context;
  if (!Array.isArray(stored?.records) || !settings || typeof prepareProducedTask !== 'function') throw new Error('The issue records handed in, trusted interaction settings and produced-task owner are required.');
  const work = clientHealthWork(issue, settings);
  const id = clientHealthBookName(work);
  const held = stored.records.find(record => record.id === id && record.type === 'client-health') ?? null;
  if (held?.value?.handoff_id) return { handoff_id: held.value.handoff_id, key: null, keep: [] };
  const at = now();
  const job = prepareProducedTask({ key: work.once_per, description: work.job, title: work.said,
    outcome: work.outcome, priority: work.priority, source: { kind: 'client-health', ref: id } }, at);
  const value = { id: work.id, handoff_id: job.id, handed_at: at.toISOString() };
  return {
    handoff_id: job.id,
    key: context.requestKey ?? `client-health-report:${work.id}`,
    keep: [job, { id, type: 'client-health', value, expected: held ? { type: 'client-health', value: held.value } : null }],
  };
}

// hand(work) → { handoff_id }: the account whose AIs take Trillion's own work is handed the job (owner wiring).
export function makeClientHealthIssue({ list, put, hand, settings }) {
  return {
    async run(operation, input = {}) {
      if (operation !== 'report') throw new Error('A client health issue can only be reported.');
      const work = clientHealthWork(input, settings);
      const kept = (await list('issue'))[0] ?? null;
      if (kept && kept.id !== work.id) throw new Error('This book keeps another client health issue.');
      if (kept?.handoff_id) return { handoff_id: kept.handoff_id };
      const { handoff_id } = await hand(work);
      await put('issue', { id: work.id, handoff_id, handed_at: new Date().toISOString() });
      return { handoff_id };
    },
  };
}
