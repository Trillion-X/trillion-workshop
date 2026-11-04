// Which of the method's checks each decision was asked, what each one did to the answer, and how the decision turned out.
//
// Nothing here is reported by the caller as a verdict. A check use is derived from what the service itself stored:
// the step's checklist and answer (src/engine.mjs), and every attempt it logged (src/routes.mjs). A check is
// "revised" when the service refused an answer naming it and a later answer was accepted, or when the answer itself
// says the check changed it (`changed_answer: true`); "skipped" when the answer said it does not bear on this
// decision; "refused" while a refusal naming it has no accepted answer yet; otherwise "passed".
// A decision's current outcome is the latest observation or person report about its current generation. A later
// failure or uncertainty is never hidden behind an earlier check; historical evidence stays in its original owner.
import words from '../../decide-with-a-method/read-data/what-helped-words.json' with { type: 'json' };
import handling from '../records/outcome-handling.json' with { type: 'json' };
import precedence from './outcome-precedence.json' with { type: 'json' };

const numbers = usage => Object.fromEntries(Object.entries(usage ?? {}).filter(([, value]) => typeof value === 'number' && Number.isFinite(value)));
// The check ids a refusal names: every id the step could ask that appears in the refusal's words.
const named = (reason, ids) => ids.filter(id => String(reason ?? '').includes(id));

export function checkUses(record, knownIds = []) {
  const calls = (record.calls ?? []).filter(call => call.route === 'guide');
  const uses = [];
  (record.guidance ?? []).forEach((item, index, all) => {
    const rows = item.checklist ?? [];
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
// negatives, and the outcome says whether the choice worked. Null until the decision is made.
export function decisionChoice(record) {
  if (!record?.decision) return null;
  const candidates = record.input.options.map(option => ({ id: option.id, text: option.label }));
  return {
    source: 'decision', choice_id: record.id, method: record.method?.id ?? null,
    situation: [record.input.goal, ...record.input.evidence.map(item => item.claim)].join('\n'),
    candidates, chosen_index: candidates.findIndex(item => item.id === record.decision.option_id), chosen_id: record.decision.option_id,
    reason: record.decision.reason, outcome: decisionResult(record)?.result ?? null, at: record.decided_at,
  };
}

export const decisionGeneration = record => record?.decision_generation ?? 1;
const outcomeTime = (entry, kind) => entry.observed_at ?? (kind === 'report' ? entry.reported_at : entry.checked_at);
const milliseconds = value => Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;

// Older records did not name their generation. Their own timestamp, and an action's recorded generation when
// available, are enough to keep them historical after a new decision. Undated legacy evidence cannot verify a
// later generation. This is a projection: no earlier observation or testimony is rewritten to manufacture a link.
export function outcomeIsCurrent(record, entry, kind = 'check') {
  const generation = entry.decision_generation ?? (entry.action_key
    ? record.actions?.find(action => action.key === entry.action_key)?.decision_generation : undefined);
  if (generation !== undefined) return generation === decisionGeneration(record);
  const observed = milliseconds(outcomeTime(entry, kind));
  const decided = milliseconds(record.decided_at);
  if (observed !== null && decided !== null) return observed >= decided;
  return decisionGeneration(record) === 1;
}

// The one current assessment used by execution controls, screens and learning. "checked" and "reported" remain
// distinct. The server's revision orders simultaneous new evidence; a legacy tie favours failure over a success.
export function currentDecisionOutcome(record) {
  // A decision that does not exist (a lookup that came back null) has no outcome; a default parameter would not
  // catch null, and reading its lists crashed every decision call.
  record ??= {};
  const candidates = [];
  for (const [field, kind, by] of [['outcome_checks', 'check', 'checked'], ['observations', 'observation', 'checked'], ['reports', 'report', 'reported']]) {
    for (const [index, entry] of (record[field] ?? []).entries()) {
      if (!['met', 'failed', 'unknown'].includes(entry.result) || !outcomeIsCurrent(record, entry, kind)) continue;
      if (['technical_delivery_only', 'reported_execution', 'observation_unavailable'].includes(entry.scope)) continue;
      if (kind === 'report' && entry.answered_by !== undefined && entry.answered_by !== 'person') continue;
      candidates.push({ result: entry.result, at: outcomeTime(entry, kind) ?? null, by,
        source_ref: entry.source_ref ?? null, summary: entry.summary ?? entry.reason ?? null,
        decision_generation: decisionGeneration(record), revision: entry.outcome_revision ?? 0, index, evidence: entry });
    }
  }
  const severity = { met: 0, unknown: 1, failed: 2 };
  const superseded = new Set(candidates.map(item => item.evidence.supersedes).filter(Boolean));
  const current = candidates.filter(item => !superseded.has(item.source_ref));
  current.sort((a, b) => (milliseconds(a.at) ?? -Infinity) - (milliseconds(b.at) ?? -Infinity)
    || a.revision - b.revision || severity[a.result] - severity[b.result] || a.index - b.index);
  const latest = current.at(-1) ?? null;
  if (!latest) return null;
  // The person's confirmed value (a report they made themselves) and the AI's inference (a check or observation) are
  // kept side by side. With src/outcome-precedence.json person_confirmed_wins the confirmed value stays current until the person
  // changes or retracts it; the inference never replaces it, and is returned beside it.
  const confirmed = current.filter(item => item.by === 'reported' && personReportVerified(item.evidence)).at(-1) ?? null;
  const inferred = current.filter(item => item.by === 'checked').at(-1) ?? null;
  const chosen = precedence.person_confirmed_wins === true && confirmed ? confirmed : latest;
  const inference = inferred && inferred !== chosen ? { result: inferred.result, at: inferred.at, source_ref: inferred.source_ref, summary: inferred.summary } : null;
  return inference ? { ...chosen, inference } : chosen;
}

// This basis is supplied by the signed-in host, never copied from report_result's body. An author label alone is
// a claim. Old entries and AI-transcribed words remain attributed claims until a trusted original source exists.
export const personReportVerified = report => Boolean(report?.answered_by === 'person' && ['signed_in_person_screen', 'kept_person_message'].includes(report.person_source?.basis)
  && typeof report.person_source?.source_ref === 'string' && report.person_source.source_ref.trim().length > 0);

// A person report can contradict a verified result; it cannot promote itself into independent verification.
// Preserve other reasons a case is open for correction (a rejected action or an explicit disagreement).
export function decisionStatus(record) {
  record ??= {};
  if (!record.decision || ['invalid_source', 'ended', 'needs_decision'].includes(record.status)) return record.status;
  const outcome = currentDecisionOutcome(record);
  if (outcome?.result === 'failed') return 'correction_needed';
  if (outcome?.result === 'unknown' || outcome?.by === 'reported' || !outcome) {
    return record.status === 'correction_needed' ? 'correction_needed' : 'needs_outcome';
  }
  return record.status;
}

// The current settled outcome, or null while unknown. Every consumer gets the same chronology and generation.
export function decisionResult(record) {
  const outcome = currentDecisionOutcome(record);
  if (outcome?.result === 'met' && outcome.by === 'reported' && !personReportVerified(outcome.evidence)) return null;
  return outcome && outcome.result !== 'unknown' ? { result: outcome.result, at: outcome.at, by: outcome.by } : null;
}

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

// One agent plan as the hook sends it, kept only in the shape the view reads.
export function agentWorkItem(body, knownIds) {
  const text = value => (typeof value === 'string' && value.trim() ? value.trim().slice(0, 300) : null);
  if (!body || typeof body !== 'object' || !text(body.session_id) || !text(body.harness)) throw new Error('Agent work needs session_id and harness');
  const known = new Set(knownIds);
  const checks = (Array.isArray(body.checks) ? body.checks : [])
    .filter(use => use && known.has(use.check_id) && ['cited', 'loaded'].includes(use.verdict))
    .map(use => ({ check_id: use.check_id, verdict: use.verdict }));
  return {
    id: `${text(body.session_id)}:${text(body.turn_id) ?? text(body.decision_ref) ?? 'session'}`,
    harness: text(body.harness), session_id: text(body.session_id), decision_ref: text(body.decision_ref),
    method_files: (Array.isArray(body.method_files) ? body.method_files : []).map(text).filter(Boolean).slice(0, 50),
    checks, seconds: Number.isFinite(body.seconds) && body.seconds >= 0 ? Math.round(body.seconds) : null,
    cost: numbers(body.usage), model: text(body.model),
    landed: text(body.landed_commit) ? { commit: text(body.landed_commit) } : null,
    at: new Date().toISOString(),
  };
}

// The view as the person reads it: plain sentences, a count beside every share, "not enough" below the minimum.
// A count of one reads as one thing: "over 1 decision" and "1 plan recorded", never "1 decisions".
const fill = (sentence, values) => sentence.replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? '')).replace(/(^|over )1 (decision|plan)s\b/g, '$11 $2');
export function duration(seconds) {
  if (seconds === null || seconds === undefined) return null;
  if (seconds < 90) return `${Math.round(seconds)} seconds`;
  if (seconds < 5400) return `${Math.round(seconds / 60)} minutes`;
  if (seconds < 172800) return `${Math.round(seconds / 3600)} hours`;
  return `${Math.round(seconds / 86400)} days`;
}
const share = (part, whole) => Math.round((100 * part) / whole);

export function whatHelpedSections(view, text = words) {
  if (!view.decisions) return [{ emphasis: 'work', heading: text.heading, body: text.empty }];
  const sections = [];
  if (view.decisions) {
    const goal = view.goal;
    sections.push({
      emphasis: 'work', heading: text.goal.heading,
      body: goal.with_result
        ? (goal.share_shown ? fill(text.goal.share, { share: share(goal.hit_goal, goal.with_result), met: goal.hit_goal, known: goal.with_result }) : `${fill(text.goal.counted, { met: goal.hit_goal, known: goal.with_result })} (${text.not_enough}).`)
        : text.not_enough[0].toUpperCase() + text.not_enough.slice(1) + '.',
      ...(goal.waiting ? { items: [{ body: fill(text.goal.waiting, { waiting: goal.waiting }) }] } : {}),
    });
    const time = view.time;
    const rows = [
      time.decision_to_done.typical !== null ? fill(text.time.done, { time: duration(time.decision_to_done.typical), count: time.decision_to_done.count }) : null,
      time.deciding.compared ? fill(text.time.deciding, { now: duration(time.deciding.recent), before: duration(time.deciding.earlier), recent: time.deciding.recent_count, earlier: time.deciding.earlier_count })
        : time.deciding.recent !== null ? fill(text.time.deciding_once, { now: duration(time.deciding.recent), count: time.deciding.recent_count }) : null,
      time.goal ? fill(text.time.goal_change, { now: `${time.goal.recent.hit_goal} of ${time.goal.recent.with_result}`, before: `${time.goal.earlier.hit_goal} of ${time.goal.earlier.with_result}`, recent: time.deciding.recent_count, earlier: time.deciding.earlier_count }) : null,
    ].filter(Boolean);
    sections.push({ emphasis: 'work', heading: text.time.heading, ...(time.deciding.compared ? {} : { body: `Before and after comparisons: ${text.not_enough}.` }), items: rows.map(body => ({ body })) });
    const useful = view.questions.filter(item => item.changed_answer > 0 && item.question).slice(0, text.questions.limit);
    sections.push({
      emphasis: 'work', heading: text.questions.heading,
      ...(useful.length ? {} : { body: `No question has changed an answer yet.` }),
      items: useful.map(item => ({
        heading: item.question,
        details: [fill(text.questions.changed, { changed: item.changed_answer, asked: item.asked }),
          item.comparable ? fill(text.questions.compare, { changed_met: item.when_changed.hit_goal, changed_known: item.when_changed.with_result, unchanged_met: item.when_unchanged.hit_goal, unchanged_known: item.when_unchanged.with_result }) : `Whether it led to better results: ${text.not_enough}`],
      })),
    });
  }
  return sections;
}
