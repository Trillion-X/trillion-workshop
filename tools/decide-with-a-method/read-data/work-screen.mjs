// tools/decide-with-a-method/read-data/work-screen.mjs
//
// PURPOSE
//   The Decisions/Home screen read, as one Workshop row (tool:see-my-decisions): the person's newest decisions as
//   summaries (with the pursuits each cites and how far each has got), their current pursuits as the tree they nest
//   into, their newest plans, what helped them (or, for one bounded page, the facts it is counted from), and the access
//   and allowance their place reports. Moved from the old app (trillion d273ef3): src/native-work-screen.mjs whole,
//   with the parts it called: src/check-uses.mjs (checkUses, helpedItem, whatHelpedOf), src/decision-store.mjs
//   (carriedOut, decidedSummary, summaryOf, summariesOf), src/work-progress.mjs (progressFromSteps), src/record-scope.mjs
//   (linksOf, choiceLinks, scopePursuitTree), src/allowance.mjs (decisionLimit, pursuitsWords), src/engine.mjs
//   (currentPursuit), src/payment.mjs (keepsDecisions) and src/plan-records.mjs (planSummary). The Rust engine's copy
//   (trillion-rust src/local_account/decision_screen_source.rs) is deleted in the same move.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Every record read is the person's own, through the records door, and only the kinds the row's rights name.
//      This reads and changes nothing else.
//   2. A bounded page says so: collection_coverage names the limit and whether more decisions, pursuits or plans exist.
//      Full-history statistics are never approximated from a page.
//   3. A decision's status and result are decision-outcome.mjs's, the same projection the decision tools write by.
//   4. Access and allowance are what the caller's place reports (input.access, input.allowance). Nothing here invents
//      a limit, a meter or a refusal: no access reported is no limit.
//   5. The words and numbers are DATA: work-screen.json, decision-progress.json and what-helped-words.json.
//
import screen from './work-screen.json' with { type: 'json' };
import decisionSteps from './decision-progress.json' with { type: 'json' };
import words from './what-helped-words.json' with { type: 'json' };
import settings from './decide-with-a-method.json' with { type: 'json' };
import { decisionResult as outcomeResult, decisionStatus as outcomeStatus } from './decision-outcome.mjs';
import { joinDecision, settled } from './decision-records.mjs';

// Who wins when the person and a check disagree is the decision tools' own setting.
const decisionResult = record => outcomeResult(record, settings.precedence);
const decisionStatus = record => outcomeStatus(record, settings.precedence);
const fill = (template, parts) => template.replace(/\{(\w+)\}/g, (_, name) => String(parts[name] ?? ''));
const DECISION_ACCESS = screen.decision_access;
const sales = { kept_access: screen.kept_access };
const CHOSEN = 'chosen';
const NOT = 'not';
const CHOICE_TYPE = screen.scope.choice_type;
const LINKS = screen.scope.links;
const DIMENSIONS = screen.scope.dimensions;
const pick = (value, path) => path.reduce((at, key) => (at && typeof at === 'object' ? at[key] : undefined), value);
const text = value => (typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : '');
const idsIn = value => (typeof value === 'string' ? [value] : Array.isArray(value) ? value.filter(item => typeof item === 'string') : value && typeof value === 'object' ? Object.keys(value) : []);
const membersOf = value => (Array.isArray(value) ? value : value && typeof value === 'object' ? Object.values(value) : []);
const refOf = (kind, id) => {
  const prefix = screen.scope.refs[kind]?.prefix;
  return prefix ? `${prefix}${id}` : id;
};
const stanceId = ref => `${screen.records.stance}:${ref}`;

// --- src/check-uses.mjs ---

const numbers = usage => Object.fromEntries(Object.entries(usage ?? {}).filter(([, value]) => typeof value === 'number' && Number.isFinite(value)));
// The check ids a refusal names: every id the step could ask that appears in the refusal's words.
const named = (reason, ids) => ids.filter(id => String(reason ?? '').includes(id));

export function checkUses(record, knownIds = []) {
  const calls = (record.calls ?? []).filter(call => call.route === 'guide');
  const uses = [];
  (record.guidance ?? []).forEach((item, index, all) => {
    // A step laid apart keeps its checklist as { checks: [...] } (decision-records.mjs); one kept whole, as the list.
    const rows = Array.isArray(item.checklist) ? item.checklist : item.checklist?.checks ?? [];
    if (!rows.length) return;
    const attempts = calls.filter(call => call.step_id === item.step_id);
    const accepted = attempts.find(call => call.accepted);
    const refusals = attempts.filter(call => !call.accepted);
    const started = index ? all[index - 1].answered_at : record.created_at;
    const seconds = Math.max(0, Math.round((Date.parse(item.answered_at) - Date.parse(started)) / 1000));
    for (const row of rows) {
      const given = item.answer?.checklist?.[row.id] ?? {};
      const refused = refusals.filter(call => named(call.reason, [row.id]).length).length;
      const reported = given.changed_answer === true;
      const verdict = given.handled === false ? 'skipped' : refused || reported ? 'revised' : 'passed';
      uses.push({
        decision_id: record.id, step_id: item.step_id, check_id: row.id, verdict, changed: verdict === 'revised',
        changed_by: verdict !== 'revised' ? null : refused ? 'refused' : 'answer', refusals: refused, seconds,
        cost: numbers(item.usage), app: accepted?.app ?? null, model: typeof item.usage?.model === 'string' ? item.usage.model : null,
        at: item.answered_at,
      });
    }
  });
  // A step still being answered: each check its refusals named is refused until an answer is accepted.
  const answered = new Set((record.guidance ?? []).map(item => item.step_id));
  const pending = new Map();
  for (const call of calls) {
    if (call.accepted || answered.has(call.step_id)) continue;
    for (const id of named(call.reason, knownIds)) {
      const key = `${call.step_id}\u0000${id}`;
      const held = pending.get(key) ?? { decision_id: record.id, step_id: call.step_id ?? null, check_id: id, verdict: 'refused', changed: false, changed_by: null, refusals: 0, seconds: null, cost: {}, app: call.app ?? null, model: null, at: call.at };
      held.refusals += 1;
      pending.set(key, held);
    }
  }
  return [...uses, ...pending.values()];
}

// One decision as a choice among candidates, the shape a contrastive choice model trains on (InfoNCE): the situation
// is the anchor, every option that was available is a candidate, the chosen one is the positive and the rest are the

const median = values => {
  const sorted = values.filter(value => typeof value === 'number' && Number.isFinite(value)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const secondsBetween = (from, to) => (from && to ? Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 1000)) : null);
const met = list => list.filter(item => item.result?.result === 'met').length;
const known = list => list.filter(item => item.result).length;

// One decided decision as the few facts whatHelped counts: when it was opened and decided, how it turned out, what
// each step's usage added up to, and what each check did. A store reads its decisions one at a time and keeps only
// this (DecisionEngine.mapDecided): holding every decision whole, with every step's checks and every logged try, to
// draw the Progress screen reset the person's store again and again as their decisions grew (2026-10-01).
export function helpedItem(record, knownIds = []) {
  const cost = {};
  for (const report of [...(record.guidance ?? []).map(step => step.usage), record.decision_usage]) for (const [name, value] of Object.entries(numbers(report))) cost[name] = (cost[name] ?? 0) + value;
  return {
    created_at: record.created_at, decided_at: record.decided_at, result: decisionResult(record), cost,
    uses: checkUses(record, knownIds).filter(use => use.verdict !== 'refused').map(({ check_id, verdict }) => ({ check_id, verdict })),
  };
}

// Everything the person's own records say about which checks helped them, as counts with their sample sizes.
// records: the person's decisions; checkText: { [check id]: the check's question }; agentWork: recorded agent plans.
export function whatHelped(records, { checkText = {}, knownIds = Object.keys(checkText), ...options } = {}) {
  return whatHelpedOf(records.filter(record => record?.decision).map(record => helpedItem(record, knownIds)), { checkText, ...options });
}

// The same view from helpedItem rows, one per decided decision.
export function whatHelpedOf(items, { checkText = {}, agentWork = [], settings = words } = {}) {
  const decided = [...items].sort((a, b) => String(a.decided_at).localeCompare(String(b.decided_at)));
  const enough = count => count >= settings.minimum;

  // Per check: how often it was asked, how often it changed the answer, and how those decisions turned out.
  const byCheck = new Map();
  for (const item of decided) for (const use of item.uses) {
    if (use.verdict === 'refused') continue;
    const held = byCheck.get(use.check_id) ?? { check_id: use.check_id, question: checkText[use.check_id] ?? null, asked: 0, changed: [], unchanged: [], skipped: 0 };
    held.asked += 1;
    if (use.verdict === 'skipped') held.skipped += 1;
    else (use.verdict === 'revised' ? held.changed : held.unchanged).push(item);
    byCheck.set(use.check_id, held);
  }
  const questions = [...byCheck.values()].map(held => ({
    check_id: held.check_id, question: held.question, asked: held.asked, changed_answer: held.changed.length, skipped: held.skipped,
    when_changed: { hit_goal: met(held.changed), with_result: known(held.changed) },
    when_unchanged: { hit_goal: met(held.unchanged), with_result: known(held.unchanged) },
    comparable: enough(known(held.changed)) && enough(known(held.unchanged)),
  })).sort((a, b) => b.changed_answer - a.changed_answer || b.asked - a.asked);

  // Faster, cheaper, better: the latest decisions against the ones before them, from real timestamps and reports.
  const recent = decided.slice(-settings.recent);
  const earlier = decided.slice(0, -settings.recent);
  const deciding = list => median(list.map(item => secondsBetween(item.created_at, item.decided_at)));
  const costs = list => list.map(item => item.cost);
  const names = [...new Set(costs(decided).flatMap(Object.keys))];
  const done = decided.filter(item => item.result?.result === 'met' && item.result.by === 'checked').map(item => secondsBetween(item.decided_at, item.result.at));
  const compared = enough(recent.length) && enough(earlier.length);

  return {
    decisions: decided.length,
    goal: { hit_goal: met(decided), with_result: known(decided), waiting: decided.length - known(decided), share_shown: enough(known(decided)) },
    time: {
      deciding: { recent: deciding(recent), earlier: compared ? deciding(earlier) : null, recent_count: recent.length, earlier_count: earlier.length, compared },
      decision_to_done: { typical: enough(done.length) ? median(done) : null, count: done.length },
      cost: names.map(name => ({ name, recent: median(costs(recent).map(row => row[name])), earlier: compared ? median(costs(earlier).map(row => row[name])) : null })).filter(row => row.recent !== null),
      goal: compared ? { recent: { hit_goal: met(recent), with_result: known(recent) }, earlier: { hit_goal: met(earlier), with_result: known(earlier) } } : null,
    },
    // Every decision in the order it was made: how long deciding took and how it turned out, for the lines over time.
    series: decided.map(item => ({ at: item.decided_at ?? null, seconds: secondsBetween(item.created_at, item.decided_at), result: item.result?.result ?? null })).filter(point => point.at),
    questions,
    agents: agentView(agentWork, checkText),
    minimum: settings.minimum,
  };
}

// Plans recorded from the person's AI agents (Claude Code, Codex): which checks each cited and whether it landed.
function agentView(items, checkText) {
  const cited = new Map();
  for (const item of items) for (const use of item.checks ?? []) if (use.verdict === 'cited') cited.set(use.check_id, (cited.get(use.check_id) ?? 0) + 1);
  return {
    plans: items.length,
    landed: items.filter(item => item.landed).length,
    most_cited: [...cited].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([id, count]) => ({ check_id: id, question: checkText[id] ?? null, cited: count })),
  };
}

// --- src/work-progress.mjs ---
// A bounded measure is a share of named units, never an estimate from a status word.
// Keep the source units beside the percentage so a reader can see its denominator.
function countWords(measure) {
  const done = measure?.done;
  const total = measure?.total;
  if (!Number.isSafeInteger(done) || !Number.isSafeInteger(total) || total < 1 || done < 0 || done > total) return null;
  const many = typeof measure.unit === 'string' && measure.unit.trim() ? measure.unit.trim() : 'steps';
  const unit = total === 1 && typeof measure.unit_one === 'string' && measure.unit_one.trim() ? measure.unit_one.trim() : many;
  return `${done} of ${total} ${unit} finished`;
}

export function progressWords(measure) {
  const count = countWords(measure);
  return count ? `${count} (${Math.round(100 * measure.done / measure.total)}%)` : 'Not measured';
}

// Named steps kept as facts on one record (a decision's src/decision-progress.json): each step counts only when its own
// fact is true, and the words name the furthest step reached, so "2 of 3" also says which two.
export function progressFromSteps(record, rows) {
  const steps = Array.isArray(rows?.steps) ? rows.steps : [];
  if (!record || typeof record !== 'object' || !steps.length) return 'Not measured';
  const met = steps.filter(step => record[step.field] === true);
  const words = progressWords({ done: met.length, total: steps.length, unit: rows.unit, unit_one: rows.unit_one });
  return met.length ? `${words} · ${met.at(-1).says}` : words;
}

// --- src/decision-store.mjs ---
// Whether the AI that took a decision's next action has said it was done (or named the wall it reached), for the
// decision as it stands now: a revised decision is owed again. src/engine.mjs recordCarriedOut keeps what was said.
export const carriedOut = record => Boolean(record?.decision) && (record.carried_out ?? []).some(entry => entry.decision_generation === (record.decision_generation ?? 1));
// What a list of decisions says about a decided one: when it was decided and whether its next action was said done.
export const decidedSummary = record => (record.decision ? { decided: true, decided_at: record.decided_at ?? null, carried_out: carriedOut(record) } : { decided: false });

// --- src/record-scope.mjs ---
/** Every link one record carries, from the DATA links: [{ target, target_kind, via }]. The links the store keeps as
 *  participation (kept_by model) only when `kept` is true, so the scope_links index never holds them. */
export function linksOf(type, value, { kept = false } = {}) {
  const rows = [];
  for (const link of LINKS) {
    if (link.from !== type || (link.kept_by === 'model') !== kept) continue;
    const found = pick(value, link.field);
    const via = link.field.join('.');
    if (link.each) {
      for (const member of membersOf(found)) {
        const kind = text(pick(member, link.each.kind));
        const id = text(pick(member, link.each.id));
        if (kind && id) rows.push({ target: refOf(kind, id), target_kind: kind, via });
      }
    } else for (const id of idsIn(found)) if (id.trim()) rows.push({ target: refOf(link.to, id.trim()), target_kind: link.to, via });
  }
  return rows;
}

/** The links a person's own choice for one record adds and removes. A choice kept before rooms were their pursuits'
 *  names rooms under the room's param; each still links the record to that room, which stands for its pursuit. */
export function choiceLinks(choice) {
  if (!choice) return [];
  const named = (param, kind) => [
    ...idsIn(choice[param]).map(target => ({ target, target_kind: kind, via: CHOSEN })),
    ...idsIn(choice[`not_${param}`]).map(target => ({ target, target_kind: kind, via: NOT })),
  ];
  return DIMENSIONS.flatMap(dimension => [...named(dimension.param, dimension.id), ...(dimension.room ? named(dimension.room.param, dimension.room.target_kind) : [])]);
}

export const recordScopeMethods = {
  // The pursuits a pursuit is set under (its parents) and the ones set under it (its children), read from the same
  // links every scope read follows, so list_pursuits returns the person's pursuits as the tree they nest into. A
  // pursuit can sit under several others; a link the person removed (`not`) and a pursuit no longer current are left out.
  scopePursuitTree(pursuits) {
    const pursuit = DIMENSIONS.find(dimension => dimension.values_from === 'pursuits');
    const current = new Set(pursuits.map(item => item.id));
    const parents = new Map(pursuits.map(item => [item.id, []]));
    const children = new Map(pursuits.map(item => [item.id, []]));
    for (const item of pursuits) {
      const choice = this.store.eeaf.read(`${CHOICE_TYPE}:${item.id}`);
      const links = [...linksOf(pursuit.id, item), ...choiceLinks(choice)].filter(link => link.target_kind === pursuit.id);
      const removed = new Set(links.filter(link => link.via === NOT).map(link => link.target));
      for (const link of links) {
        if (link.via === NOT || !current.has(link.target) || removed.has(link.target) || link.target === item.id || parents.get(item.id).includes(link.target)) continue;
        parents.get(item.id).push(link.target);
        children.get(link.target).push(item.id);
      }
    }
    return pursuits.map(item => ({ ...item, parents: parents.get(item.id), children: children.get(item.id) }));
  },
};

// --- src/allowance.mjs, src/engine.mjs, src/payment.mjs, src/plan-records.mjs ---
// The limit on deciding for this person now, or null when nothing limits it.
// With more than one offer limiting it, the most generous count applies.
export const decisionLimit = access => {
  const rows = access.limits?.[DECISION_ACCESS];
  return rows?.length ? rows.reduce((best, row) => (row.count > best.count ? row : best)) : null;
};

// What to say about pursuits: a measured comparison when the pool can give one for both groups, plain words otherwise.
// A number appears only when it came from the pool's measurement.
export function pursuitsWords(measured) {
  const both = measured?.with?.enough && measured?.without?.enough;
  if (!both) return { text: screen.pursuits.none, measured: false };
  const asShare = share => `${Math.round(share * 100)}%`;
  return {
    text: fill(screen.pursuits.measured, { with: asShare(measured.with.worked_share), without: asShare(measured.without.worked_share), people: Math.min(measured.with.people_at_least, measured.without.people_at_least) }),
    measured: true,
  };
}

export const currentPursuit = item => item?.status !== 'ended' && item?.status !== 'archived';
/** Whether this person's decisions are kept (sales.json `kept_access`); without it a decision is kept nowhere. */
export const keepsDecisions = access => access.capabilities.includes(sales.kept_access);

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

// --- src/native-work-screen.mjs ---
export function nativeWorkScreen({owner,records,store,engine,setting,readAllowance,currentPolicy,spacePursuits=async()=>[],checkQuestions}){
  return async(input={})=>{
    const {access}=await currentPolicy();
    const limit=decisionLimit(access);let allowance=null;
    if(limit){
      if(typeof readAllowance!=='function')throw new TypeError('The native screen requires its actual account allowance owner.');
      const saved=await readAllowance(access);
      allowance={count:saved.count,per:saved.per,used:saved.used};
    }
    let spaces=[],timer;try{spaces=await Promise.race([spacePursuits(),new Promise(resolve=>{timer=setTimeout(()=>resolve([]),1500);})]);}catch{spaces=[];}finally{clearTimeout(timer);}
    if(allowance&&!keepsDecisions(access))return {free:true,summaries:[],pursuits:[],space_pursuits:spaces,access,allowance};
    if(input.metadata_only)return {free:false,access,allowance,space_pursuits:spaces,pursuits_words:pursuitsWords(null)};
    if(input.native_collection_page){
      // A bounded source projection, with explicit coverage. Full-history
      // statistics are never approximated by adding per-resource medians.
      const limit=100;
      const summaries=await engine.summaries(limit+1);
      const ids=records.ids('pursuit',{limit:limit+1});
      const pursuits=ids.slice(0,limit).map(id=>records.read(id)).filter(row=>row&&currentPursuit(row));
      const planPage=planRecords(records).collectionPage({limit});
      const roots=Object.values(store.read({cases:summaries.slice(0,limit).map(row=>row.case_id)}).cases);
      const known=Object.keys(checkQuestions());
      return {free:false,summaries:summaries.slice(0,limit).map(row=>{const kept=records.read(stanceId(row.case_id));return kept?{...row,stance:kept.stance}:row;}),
        pursuits:recordScopeMethods.scopePursuitTree.call({store:{eeaf:records}},pursuits),space_pursuits:spaces,
        plans:planPage.plans,access,allowance,pursuits_words:pursuits.length||spaces.length?null:pursuitsWords(null),
        helped_items:roots.filter(row=>row.decision).map(row=>({id:row.id,...helpedItem(row,known)})),
        collection_coverage:{scope:'newest_decisions',limit,more_decisions:summaries.length>limit,more_pursuits:ids.length>limit,more_plans:planPage.more}};
    }
    const [summaries,pursuits]=await Promise.all([engine.summaries(100),engine.pursuits()]);
    const known=Object.keys(checkQuestions());
    const helped=whatHelpedOf(await engine.mapDecided(root=>helpedItem(root,known)),{checkText:checkQuestions(),agentWork:store.settings('agent-work:').map(row=>row.value).filter(Boolean)});
    return {free:false,summaries:summaries.map(row=>{const kept=records.read(stanceId(row.case_id));return kept?{...row,stance:kept.stance}:row;}),
      pursuits:recordScopeMethods.scopePursuitTree.call({store:{eeaf:records}},pursuits),space_pursuits:spaces,
      plans:planRecords(records).list({limit:100}).plans,access,allowance,pursuits_words:pursuits.length||spaces.length?null:pursuitsWords(null),helped};
  };
}

// --- The records door: the person's own rows, read once, served to the moved screen above ---

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
// A join over a decision reads every answered step whole: helpedItem counts each step's checklist and answer.
const EVERY_STEP = { includes: () => true };

/** The first `most` rows a query names, in the door's order, and whether there are more. */
async function firstRows(door, query, most) {
  const rows = [];
  for await (const row of door.list({ ...query, limit: Math.min(most + 1, screen.page_rows) })) {
    rows.push(row);
    if (rows.length > most) break;
  }
  return { rows: rows.slice(0, most), more: rows.length > most };
}

/** Every row a query names, refused past `most` so a reader is told to ask for one bounded page instead. */
async function everyRow(door, query, most, what) {
  const { rows, more } = await firstRows(door, query, most);
  if (more) throw new Error(fill(screen.words.too_many, { most, what }));
  return rows;
}

/** One decision with its lists and every step put back, as the decision tools lay it out. */
const wholeDecision = (door, row) => settled(door, get => joinDecision(row.id, row.value, get, EVERY_STEP));

// --- src/decision-store.mjs (summaryOf, summariesOf over rows read here) ---
const summaryOf = record => ({
    case_id: record.id,
    source_id: record.source_id ?? null,
    goal: record.input.goal,
    method: record.method?.id ?? record.method_id ?? null,
    status: decisionStatus(record),
    decision: record.decision ? record.input.options.find(option => option.id === record.decision.option_id)?.label ?? null : null,
    created_at: record.created_at,
    outcome_question: record.outcome_question?.question ?? null,
    recheck_on: record.recheck_on ?? null,
    cited_pursuit_ids: Object.keys(record.cited_pursuits ?? {}),
    ...(record.decision ? { move: record.decision.move ?? null, next_action: record.decision.next_action ?? null, success_measure: record.decision.success_measure ?? null } : {}),
    ...decidedSummary(record),
    // How far it has got, from its own facts (src/decision-progress.json): decided, carried out, result checked.
    ...(() => { const facts = { ...decidedSummary(record), result_checked: Boolean(record.decision && decisionResult(record)) }; return { result_checked: facts.result_checked, progress: progressFromSteps(facts, decisionSteps) }; })(),
  });
  // These decisions as summaries, each with the titles of the pursuits it cites: only those pursuits are read, so a
  // page of summaries costs the page and what it cites, never every pursuit the person has.
async function summariesOf(door, found) {
    const ids = [...new Set(found.flatMap(summary => summary.cited_pursuit_ids))];
    const pursuits = Object.fromEntries(await Promise.all(ids.map(async id => [id, await door.read(screen.records.pursuit, id)])));
    return found.map(({ cited_pursuit_ids, ...summary }) => ({ ...summary, pursuits: cited_pursuit_ids.filter(id => pursuits[id]?.title).map(id => ({ id, title: pursuits[id].title })) }));
}

/**
 * tool:see-my-decisions. input: { metadata_only?, native_collection_page?, before?, access?, allowance?, space_pursuits? }.
 * Answers the old screen's shape: { free, summaries, pursuits, space_pursuits, plans, access, allowance, pursuits_words,
 * helped } and, for one bounded page (native_collection_page), helped_items, helped_check_text, agent_work,
 * collection_coverage and next_before (the created_at to send as `before` for the next page, when there is one).
 */
export async function seeMyDecisions(input = {}, { door }) {
  if (!object(input)) throw new Error(screen.words.input);
  for (const name of ['metadata_only', 'native_collection_page']) if (input[name] !== undefined && typeof input[name] !== 'boolean') throw new Error(fill(screen.words.flag, { name }));
  if (input.before !== undefined && (typeof input.before !== 'string' || !input.before || input.before.length > screen.most_before)) throw new Error(fill(screen.words.before, { most: screen.most_before }));
  if (input.access !== undefined && !(object(input.access) && Array.isArray(input.access.capabilities) && (input.access.limits === undefined || object(input.access.limits)))) throw new Error(screen.words.access);
  if (input.allowance !== undefined && !(object(input.allowance) && Number.isInteger(input.allowance.count) && typeof input.allowance.per === 'string' && Number.isInteger(input.allowance.used))) throw new Error(screen.words.allowance);
  if (input.space_pursuits !== undefined && !Array.isArray(input.space_pursuits)) throw new Error(screen.words.space_pursuits);
  // Access the caller's place reports; none reported is no limit (nothing here invents one).
  const access = input.access ?? { capabilities: [], limits: {} };
  const limit = screen.limit;
  const held = new Map();
  const R = screen.records;
  const decisionQuery = { type: R.decision, order: R.decision_order, reverse: true, ...(input.before ? { below: input.before } : {}) };

  // The rows the screen reads, read here once (sync reads below are served from them).
  const page = { decisions: [] };
  const records = { plans: [], more_plans: false, ids: () => pursuitIds, read: id => held.get(id) ?? null };
  const decided = [];
  let pursuitIds = [];
  if (!input.metadata_only) {
    const first = await firstRows(door, decisionQuery, limit + 1);
    for (const row of first.rows) page.decisions.push({ ...(await wholeDecision(door, row)), id: row.id });
    // limit + 1 ids, so the screen's own coverage sees whether there are more.
    const pursuits = await firstRows(door, { type: R.pursuit }, limit + 1);
    pursuitIds = pursuits.rows.map(row => row.id);
    for (const row of pursuits.rows) {
      held.set(row.id, object(row.value) ? { ...row.value, id: row.id } : null);
      held.set(`${CHOICE_TYPE}:${row.id}`, await door.read(CHOICE_TYPE, `${CHOICE_TYPE}:${row.id}`));
    }
    for (const decision of page.decisions) held.set(stanceId(decision.id), await door.read(R.stance, stanceId(decision.id)));
    const plans = await firstRows(door, { type: R.plan, order: R.plan_order, reverse: true }, limit);
    records.plans = plans.rows.map(row => planSummary({ id: row.id, ...row.value }));
    records.more_plans = plans.more;
    if (!input.native_collection_page) {
      for (const row of await everyRow(door, decisionQuery, screen.most_decisions, R.decision)) {
        if (row.value?.decision) decided.push({ ...(await wholeDecision(door, row)), id: row.id });
      }
    }
  }
  // Only the step rows of the one Checks list carry question text; word checks, pieces and branches are left to the door.
  const checkRows = input.metadata_only ? [] : await everyRow(door, { type: R.method_checks, ...R.step_rows }, screen.most_checks, R.method_checks);
  const checkText = Object.fromEntries(checkRows.map(row => [row.value?.id ?? row.id, row.value?.check ?? null]).filter(([, question]) => typeof question === 'string'));
  const agentWork = input.metadata_only ? [] : (await everyRow(door, { type: R.agent_work.type, prefix: R.agent_work.prefix }, screen.most_agent_work, R.agent_work.prefix))
    .filter(row => object(row.value?.value)).map(row => ({ ...row.value.value, id: row.id }));

  const store = {
    read: ({ cases }) => ({ cases: Object.fromEntries(page.decisions.filter(row => cases.includes(row.id)).map(row => [row.id, row])) }),
    settings: () => agentWork.map(value => ({ value })),
  };
  const engine = {
    summaries: async count => summariesOf(door, page.decisions.slice(0, count).map(summaryOf)),
    pursuits: async () => pursuitIds.slice(0, limit).map(id => held.get(id)).filter(row => row && currentPursuit(row)),
    mapDecided: async fn => decided.map(fn),
  };
  const screenOf = nativeWorkScreen({
    records, store, engine,
    currentPolicy: async () => ({ access }),
    readAllowance: async () => input.allowance ?? (() => { throw new Error(screen.words.allowance_needed); })(),
    spacePursuits: async () => input.space_pursuits ?? [],
    checkQuestions: () => checkText,
  });
  const answer = await screenOf(input);
  if (!input.native_collection_page || answer.free) return answer;
  // The bounded page also carries what the person's AI counts what helped from, and where the next page starts.
  const last = page.decisions.slice(0, limit).at(-1);
  const more = page.decisions.length > limit;
  return { ...answer, helped_check_text: checkText, agent_work: agentWork, next_before: more && last ? last.created_at ?? null : null };
}

// The moved screen's own plan reader, over the plan rows read above (src/plan-records.mjs collectionPage and list).
const planRecords = records => ({ collectionPage: () => ({ plans: records.plans, more: records.more_plans }), list: () => ({ plans: records.plans }) });
