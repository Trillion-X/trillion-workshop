// src/work-item-rows.mjs
//
// Purpose: an account's own work, as rows of any of its lists that names these sources in its row_sources
// (src/lists.mjs withRowSources): `work-items` are its handoffs, read through the work owner's own page (agents
// board, src/agents.mjs), and `workflow-runs` its workflow runs, read through the workflow owner's own page
// (workflows runs, src/workflows.mjs). A list's `of` (row_sources: [{ source: 'work-items', of: <handoff id> }]) shows
// only the work handed on from that one job, one page of its own index at a time. A row is never written here: the work
// fills it as it goes, its stage from where the work is, its summary and outcome from what finish_work or each step
// sent. A shared copy of the list reads the same rows and releases them by the list's own rules (src/list-copy.mjs).
//
// Non-Negotiable Invariants:
//   1. Rows come only from the owners' own pages and cursors, bounded by the list's page; nothing is copied.
//   2. A row carries the work's own facts (title, stage, summary, times) and, for each field the list itself declares,
//      the value the work's outcome gave that field (a file field shows the picture or recording it names). Which
//      fields those are is the list's DATA; nothing here names one.
//   3. A source this account cannot read answers no rows; it never reads another account's work.
//
//   workItemRowSources({ board, runs, ais }) → { sources, declared } for withRowSources
//     board({ before, limit, parent?, native_ids, agent_scope }) → { work, next_before }   (the work owner's page)
//     ais() → the native AI owner’s bounded list ({ id, label, ... }), read through without copying
//     runs({ before, limit, run_ids, outcome_fields }) → { runs, next }          (the workflow owner's page)

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const shown = value => value !== undefined && value !== null && value !== '';
const SUMMARY_MAX = 2000;
const cut = value => typeof value === 'string' && value.length > SUMMARY_MAX ? `${value.slice(0, SUMMARY_MAX - 1)}…` : value;

// The work's own facts; a list field of the same id shows them, and an outcome never overwrites them.
const facts = values => Object.fromEntries(Object.entries(values).filter(([, value]) => shown(value)));
const fieldIdsOf = list => (list.fields ?? []).map(field => field.id).filter(id => typeof id === 'string');
const outcomeValues = (list, outcome, own) => object(outcome)
  ? Object.fromEntries(fieldIdsOf(list).filter(id => !Object.hasOwn(own, id) && shown(outcome[id])).map(id => [id, outcome[id]]))
  : {};

function workRow(list, item) {
  const result = item.result;
  const own = facts({
    title: item.said, stage: item.status ?? item.state, in_the_way: item.in_the_way,
    summary: cut(item.summary ?? (typeof result === 'string' ? result : object(result) ? result.outcome : null)),
    wanted: item.outcome, started_at: item.handed_at, finished_at: item.finished_at, by: item.taken_by, work: item.handoff_id,
  });
  return { id: item.handoff_id, values: { ...own, ...outcomeValues(list, result, own) } };
}

function runRow(list, run) {
  const own = facts({
    title: run.title ?? run.workflow_id, stage: run.step_title ?? run.step_now ?? run.state,
    summary: cut(object(run.outcome) && typeof run.outcome.summary === 'string' ? run.outcome.summary : run.error),
    started_at: run.started_at, finished_at: run.finished_at, workflow: run.workflow_id, run: run.run_id,
  });
  return { id: run.run_id, values: { ...own, ...outcomeValues(list, run.outcome, own) } };
}

export function workItemRowSources({ board = null, runs = null, ais = null } = {}) {
  const sources = {};
  // A read-through view of the same native AI records used by setup and routing (src/ais.mjs). The list only offers
  // their names; choosing one gives no sign-in, delivery, liveness or assignment authority and writes no AI record.
  if (ais) sources['account-ais'] = async ({ limit, cursor, row_ids }) => {
    const named = (await ais()).filter(ai => typeof ai.id === 'string' && typeof ai.label === 'string')
      .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    const wanted = row_ids ? new Set(row_ids) : null;
    const matching = named.filter(ai => wanted ? wanted.has(ai.id) : cursor == null || ai.id > cursor);
    const rows = matching.slice(0, limit).map(ai => ({ id: ai.id, values: { name: ai.label }, title: ai.label }));
    return { rows, next_cursor: !wanted && matching.length > rows.length && rows.length ? rows.at(-1).id : null };
  };
  if (board) sources['work-items'] = async ({ list, source, limit, cursor, row_ids }) => {
    const page = await board({ ...(row_ids ? { native_ids: row_ids } : { before: cursor ?? undefined, limit, ...(source?.of ? { parent: source.of } : {}) }), agent_scope: 'work' });
    // A named row outside the job the list is of is not one of its rows.
    if (row_ids && source?.of) page.work = (page?.work ?? []).filter(item => item.parent_handoff_id === source.of);
    return { rows: (page?.work ?? []).map(item => workRow(list, item)), next_cursor: row_ids ? null : page?.next_before ?? null };
  };
  if (runs) sources['workflow-runs'] = async ({ list, limit, cursor, row_ids }) => {
    const page = await runs({ ...(row_ids ? { run_ids: row_ids } : { before: cursor ?? null, limit }), outcome_fields: [...fieldIdsOf(list), 'summary'] });
    return { rows: (page?.runs ?? []).map(run => runRow(list, run)), next_cursor: row_ids ? null : page?.next ?? null };
  };
  return { sources, declared: () => null };
}
