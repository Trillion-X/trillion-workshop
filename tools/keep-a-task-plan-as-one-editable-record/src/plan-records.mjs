// Trillion-owned task plans: one editable plan record with an append-only progress trail.
// A plan names existing pursuits, decisions and workflow runs instead of copying their records. Any connected AI can
// read and update the same account record; an owner may share its explicitly shareable fields into a Space through
// the existing record-sharing path.
import { identityOf } from '../../shared-code/src/record-identity.mjs';

const PLAN = 'plan';
const PROGRESS = 'plan-progress';
const idOf = source => `${PLAN}:${identityOf(source)}`;
const progressIdOf = (planId, source) => `${PROGRESS}:${identityOf(`${planId}\n${source}`)}`;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const requiredText = (value, label, max = 20000) => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is needed.`);
  return value.trim().slice(0, max);
};
const optionalText = (value, label, max = 20000) => value === undefined ? undefined : value === null ? null : requiredText(value, label, max);
const stringIds = (value, label) => {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some(id => typeof id !== 'string' || !id.trim())) throw new Error(`${label} is a list of record ids.`);
  return [...new Set(value.map(id => id.trim()))];
};
const states = new Set(['active', 'blocked', 'completed', 'paused']);
const planSummary = plan => ({
  id: plan.id,
  title: plan.title,
  goal: plan.goal,
  status: plan.status,
  next_action: plan.next_action ?? null,
  updated_at: plan.updated_at,
  pursuit_ids: plan.pursuit_ids ?? [],
  decision_case_id: plan.decision_case_id ?? null,
  workflow_run_id: plan.workflow_run_id ?? null,
  latest_progress: plan.latest_progress ?? null,
});

export const isPlanPath = path => path === '/plans' || path.startsWith('/plans/');

export function planRecords(eeaf, { app = null, now = () => new Date().toISOString() } = {}) {
  function readPlan(id) {
    if (typeof id !== 'string') return null;
    const plan = eeaf.read(id);
    return eeaf.typeOf(id) === PLAN && plan ? { id, ...plan } : null;
  }

  function list({ limit = 20, offset = 0, status, pursuit_id: pursuitId } = {}) {
    const start = Math.max(0, Math.floor(Number(offset) || 0));
    const size = Math.min(100, Math.max(1, Math.floor(Number(limit) || 20)));
    const plans = eeaf.ids(PLAN).map(id => readPlan(id)).filter(Boolean)
      .filter(plan => !status || plan.status === status)
      .filter(plan => !pursuitId || (plan.pursuit_ids ?? []).includes(pursuitId))
      .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)) || a.id.localeCompare(b.id));
    const page = plans.slice(start, start + size);
    return { plans: page.map(planSummary), total: plans.length, offset: start, next_offset: start + page.length < plans.length ? start + page.length : null };
  }

  function save(input = {}) {
    if (!object(input)) throw new Error('Send the plan fields as an object.');
    const existing = input.plan_id ? readPlan(input.plan_id) : null;
    if (input.plan_id && !existing) throw new Error(`${input.plan_id} is not one of your plans.`);
    if (!existing && typeof input.source_id !== 'string') throw new Error('source_id is needed to create a plan and make retries safe.');
    const id = existing?.id ?? idOf(requiredText(input.source_id, 'source_id', 1000));
    const duplicate = eeaf.typeOf(id);
    if (duplicate && duplicate !== PLAN) throw new Error('That source_id is already used by another Trillion record.');
    // Creation retries return the current plan. Changes use plan_id, so an old create request cannot reset
    // completed work or detach progress written after the original response was lost.
    if (!existing && duplicate === PLAN) return readPlan(id);
    const previous = existing ?? {};
    const at = now();
    const textField = (key, label, max) => optionalText(input[key], label, max) ?? previous[key] ?? null;
    const status = input.status === undefined ? previous.status ?? 'active' : requiredText(input.status, 'status', 30);
    if (!states.has(status)) throw new Error(`status is one of: ${[...states].join(', ')}.`);
    const plan = {
      title: input.title === undefined ? previous.title : requiredText(input.title, 'title', 300),
      goal: input.goal === undefined ? previous.goal : requiredText(input.goal, 'goal'),
      body: input.body === undefined ? previous.body : requiredText(input.body, 'body'),
      status,
      next_action: textField('next_action', 'next_action', 4000),
      success_measure: textField('success_measure', 'success_measure', 4000),
      pursuit_ids: input.pursuit_ids === undefined ? previous.pursuit_ids ?? [] : stringIds(input.pursuit_ids, 'pursuit_ids'),
      decision_case_id: textField('decision_case_id', 'decision_case_id', 300),
      workflow_run_id: textField('workflow_run_id', 'workflow_run_id', 300),
      progress_ids: previous.progress_ids ?? [],
      latest_progress: previous.latest_progress ?? null,
      created_at: previous.created_at ?? at,
      updated_at: at,
      created_by: previous.created_by ?? app,
      updated_by: app,
    };
    if (!plan.title) throw new Error('title is needed.');
    if (!plan.goal) throw new Error('goal is needed.');
    if (!plan.body) throw new Error('body is needed.');
    eeaf.write([{ id, type: PLAN, value: plan }], { actor: { by: app ?? 'ai' } });
    return { ...plan, id };
  }

  function read(id, { limit = 50, offset = 0 } = {}) {
    const plan = readPlan(id);
    if (!plan) return null;
    const start = Math.max(0, Math.floor(Number(offset) || 0));
    const size = Math.min(100, Math.max(1, Math.floor(Number(limit) || 50)));
    const events = (plan.progress_ids ?? []).map(progressId => {
      const value = eeaf.read(progressId);
      return value ? { id: progressId, ...value } : null;
    }).filter(Boolean).sort((a, b) => String(a.at).localeCompare(String(b.at)) || a.id.localeCompare(b.id));
    const page = events.slice(start, start + size);
    return { ...plan, progress: page, progress_total: events.length, progress_offset: start,
      progress_next_offset: start + page.length < events.length ? start + page.length : null };
  }

  function progress(input = {}) {
    if (!object(input)) throw new Error('Send the progress fields as an object.');
    const plan = readPlan(input.plan_id);
    if (!plan) throw new Error(`${String(input.plan_id ?? 'That plan')} is not one of your plans.`);
    const sourceId = requiredText(input.source_id, 'source_id', 1000);
    const id = progressIdOf(plan.id, sourceId);
    const existing = eeaf.read(id);
    if (existing) return { plan: planSummary(plan), progress: { id, ...existing }, already_recorded: true };
    const status = input.status === undefined ? plan.status : requiredText(input.status, 'status', 30);
    if (!states.has(status)) throw new Error(`status is one of: ${[...states].join(', ')}.`);
    const event = {
      plan_id: plan.id,
      summary: requiredText(input.summary, 'summary', 4000),
      status,
      step: optionalText(input.step, 'step', 300) ?? null,
      at: now(),
      app,
    };
    const { id: planId, ...previous } = plan;
    const updated = { ...previous, status, progress_ids: [...(plan.progress_ids ?? []), id], latest_progress: event.summary, updated_at: event.at, updated_by: app };
    eeaf.write([{ id, type: PROGRESS, value: event }, { id: planId, type: PLAN, value: updated }], { actor: { by: app ?? 'ai' } });
    return { plan: planSummary({ ...updated, id: planId }), progress: { id, ...event }, already_recorded: false };
  }

  function collectionPage({limit=100}={}) {
    if(!Number.isInteger(limit)||limit<1||limit>100)throw Object.assign(new RangeError('Read at most100 plan summaries.'),{status:400});
    const rows=eeaf.scan(PLAN,'updated_at',{reverse:true,limit:limit+1});
    return {plans:rows.slice(0,limit).map(row=>readPlan(row.id)).filter(Boolean).map(planSummary),more:rows.length>limit};
  }
  return { list, collectionPage, summary: id => { const plan=readPlan(id);return plan?planSummary(plan):null; }, read, save, progress };
}

// A plan's save or progress is one synchronous write, committed with its answer through `commit` (kept under the
// command's receipt with its status, src/standalone-resource-behavior.mjs routeReceipts).
export const PLAN_RECEIPTED_WRITES = Object.freeze(['plans:save', 'plans:progress']);
export async function handlePlanRequest(eeaf, request, context = {}, { commit = change => change() } = {}) {
  try {
    const url = new URL(request.url);
    const path = url.pathname;
    const plans = planRecords(eeaf, { app: request.headers.get('x-trillion-app'), ...context });
    if (path === '/plans' && request.method === 'GET') {
      return Response.json(plans.list(Object.fromEntries(url.searchParams)));
    }
    if (path === '/plans' && request.method === 'POST') {
      const input = await request.json();
      return Response.json(commit(() => plans.save(input), { operation: 'plans:save', status: 201 }), { status: 201 });
    }
    const progress = path.match(/^\/plans\/([^/]+)\/progress$/);
    if (progress && request.method === 'POST') {
      const input = await request.json();
      return Response.json(commit(() => plans.progress({ ...input, plan_id: decodeURIComponent(progress[1]) }), { operation: 'plans:progress' }));
    }
    const one = path.match(/^\/plans\/([^/]+)$/);
    if (one && request.method === 'GET') {
      const result = plans.read(decodeURIComponent(one[1]), Object.fromEntries(url.searchParams));
      return result ? Response.json(result) : Response.json({ error: 'Plan not found.' }, { status: 404 });
    }
    if (one && request.method === 'PATCH') {
      const input = await request.json();
      return Response.json(commit(() => plans.save({ ...input, plan_id: decodeURIComponent(one[1]) }), { operation: 'plans:save' }));
    }
    return Response.json({ error: 'Not found' }, { status: 404 });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 400 });
  }
}

// Required current native-owner API; existing owner behavior is retained.
