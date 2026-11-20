// tools/decide-with-a-method/read-data/decision-facts.mjs
//
// The facts of one decision as its screen reads them (ported from the old app's src/screen.mjs decisionFacts and the
// helpers it computes from): what was decided, its results and notes, what it rested on, how it was worked through,
// what came after it, and where the person stands on it. Pure: it reads no store, keeps nothing and knows no clock.
// Every date is said as a day and every status as the { label, tone } a row shows.
//
// The caller hands in what this file does not read:
//   words     the screen's words: heading, ask, why_label, earlier (the stance block) and followed_heading
//   worked    the decision's worked steps, as read-data/answer-words.mjs workedSteps(held, decision, method) returns
//             them (that read needs the store and the method, so it runs in the caller)
//   trace     what came after the decision, as tools/shared-code/src/activity.mjs traceActivity returns it
//
// Reused, not copied: statusWords and resultWords (read-data/report.mjs, which reads read-data/decision-outcome.mjs),
// and stanceFacts with the stance rows and their kind (tools/where-a-person-stands read-data/stance-facts.mjs and
// stances.json). statusOf here shapes { label, tone } for a day; it is not check-against-a-persons-rules-and-verdicts'
// statusOf, which means something else.

import { resultWords, statusWords } from './report.mjs';
import { stanceFacts } from '../../where-a-person-stands/read-data/stance-facts.mjs';
import stanceData from '../../where-a-person-stands/read-data/stances.json' with { type: 'json' };

const STANCE_KIND = stanceData.kind;

export const day = iso => (typeof iso === 'string' && iso.length >= 10 ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : null);

// The address an item names as its source, and whether it is a page that was looked at (a page reference loses the time it
// was read), or null where it names no web address.
export const sourceOf = ref => {
  const page = typeof ref === 'string' && ref.startsWith('page:') ? ref.slice(5).replace(/@\d{4}-\d{2}-\d{2}T.*$/, '') : null;
  const href = page ?? ref;
  return /^https?:\/\/[^\s]+$/i.test(href ?? '') ? { href, page: page !== null } : null;
};

// A decision's "<title>: now <now>; should be <after>" pursuit change, as its parts, or null.
export const pursuitChange = value => {
  const match = typeof value === 'string' && value.match(/^(.+): now (.+); should be (.+)$/s);
  return match ? { title: match[1], now: match[2], after: match[3] } : null;
};

export const toneOf = result => (result === 'met' ? 'good' : result === 'failed' ? 'attention' : 'quiet');
export const statusOf = (iso, tone = 'quiet') => ({ label: day(iso) ?? '', tone });
export const lines = items => items.filter(Boolean).join('\n') || null;

// Where the person stands on the decision: the stance rows' words, the stand taken and why, and one choice for each row.
// `words` is the screen's stance block (heading, ask, why_label, earlier); the status day is shaped here.
export function stanceOf(record, stance, words) {
  const facts = stanceFacts({ record, stance, stances: stanceData.stances });
  return {
    words: { heading: words.heading, ask: words.ask, why_label: words.why_label, earlier: words.earlier },
    said: facts.said,
    earlier_said: facts.earlier_said,
    why: facts.why,
    detailed: facts.detailed,
    status: facts.status ? statusOf(facts.status.at, facts.status.tone) : null,
    choices: facts.choices,
  };
}

// What came after the decision, newest first: the person's records that name it (not their stand records) and every AI
// call that used it or was done for it, each once. A failed call has no status day.
export function followedFacts(trace) {
  const records = (trace?.records ?? []).filter(item => item.kind !== STANCE_KIND)
    .map(item => ({ at: item.at, id: `record-${item.ref}`, title: item.title ?? item.kind, detail: item.kind, failed: false }));
  const calls = (trace?.steps ?? []).filter(step => step.link !== 'made')
    .map(step => ({ at: step.at, id: `call-${step.seq}`, title: step.title ?? step.label, detail: [step.label, step.agent_name ?? step.app].filter(Boolean).join(' · '), failed: step.ok === false }));
  return [...records, ...calls].sort((a, b) => String(b.at ?? '').localeCompare(String(a.at ?? ''))).slice(0, 30)
    .map(({ at, failed, ...row }) => ({ ...row, failed, status: failed ? null : statusOf(at) }));
}

// An action and its independently observed outcome share action_key. They are kept together so a result is visibly about
// the step that produced it; an AI's account of work done is shown as reported, never as an outcome.
export function actionFacts(record) {
  return (record.actions ?? []).map(action => {
    const observed = action.key ? (record.observations ?? []).filter(item => item.action_key === action.key)
      .sort((a, b) => String(a.observed_at ?? '').localeCompare(String(b.observed_at ?? ''))).at(-1) : null;
    const result = action.owner_result;
    const refs = [action.key, action.result_ref, result?.ref].filter(Boolean);
    const reported = (record.reports ?? []).filter(item => refs.includes(item.action_ref))
      .sort((a, b) => String(a.reported_at ?? '').localeCompare(String(b.reported_at ?? ''))).at(-1);
    const completion = result?.status === 'completed' ? 'completed' : result?.status === 'failed' ? 'failed' : action.state === 'running' ? 'running' : null;
    const error = result?.error || null;
    const outcome = observed ? { result: resultWords(observed.result), summary: observed.summary || null } : null;
    const said = reported ? { result: resultWords(reported.result), summary: reported.summary ?? null } : null;
    return {
      title: action.description ?? action.request?.description ?? action.request?.operation ?? record.decision?.next_action ?? null,
      completion, error, outcome, reported: said,
      detailed: Boolean(completion || error || outcome || said),
      status: statusOf(observed?.observed_at ?? reported?.reported_at ?? action.recorded_at, observed?.result === 'met' ? 'good' : observed?.result === 'failed' || result?.status === 'failed' ? 'attention' : 'quiet'),
      source: observed ? sourceOf(observed.source_ref) : null,
    };
  });
}

// What the AI that carried out the next action said it did, one row for each. A wall is attention; a done is quiet.
export const carriedOutFacts = record => (record.carried_out ?? []).map(entry => ({ done: entry.state === 'done', what_happened: entry.what_happened ?? null,
  status: statusOf(entry.at, entry.state === 'wall' ? 'attention' : 'quiet') }));

// Every check, report and observation of how the decision went, oldest first.
export function resultFacts(record) {
  return [
    ...(record.outcome_checks ?? []).map((check, index) => ({
      id: `check-${index}`, at: check.checked_at, kind: 'check', result: resultWords(check.result),
      reason: check.reason || null, by_person: check.observer === 'person', observed: check.observed ?? null,
      looked_at: check.source_ref ? check.source_ref.replace(/@.*$/, '').replace(/^page:/, '') : null,
      status: statusOf(check.checked_at, toneOf(check.result)), source: null,
    })),
    ...(record.reports ?? []).filter(report => !report.action_ref).map((report, index) => ({
      id: `report-${index}`, at: report.reported_at, kind: 'report', result: resultWords(report.result), summary: report.summary ?? null,
      status: statusOf(report.reported_at), source: null,
    })),
    ...(record.observations ?? []).map((observation, index) => ({
      id: `observation-${index}`, at: observation.observed_at, kind: 'observation', result: resultWords(observation.result), summary: observation.summary ?? null,
      status: statusOf(observation.observed_at, toneOf(observation.result)), source: sourceOf(observation.source_ref),
    })),
  ].sort((a, b) => String(a.at ?? '').localeCompare(String(b.at ?? ''))).map(({ at, ...row }) => row);
}

// One decision's facts. `worked` is the output of workedSteps for the decision; `words` the screen's words (see the header).
// A record that cannot be read (no input) is { found: false }, never a TypeError.
export function decisionFacts({ record, stance = null, trace = null, worked = [], words }) {
  if (!record?.input) return { kind: 'decision', asked: true, found: false };
  const decision = record.decision ?? null;
  const chosen = record.input.options.find(option => option.id === decision?.option_id);
  const latest = [...(record.outcome_checks ?? []).map(item => ({ at: item.checked_at, result: item.result, summary: item.reason })),
    ...(record.observations ?? []).map(item => ({ at: item.observed_at, result: item.result, summary: item.summary })),
    ...(record.reports ?? []).map(item => ({ at: item.reported_at, result: item.result, summary: item.summary }))]
    .sort((a, b) => String(a.at ?? '').localeCompare(String(b.at ?? ''))).at(-1);
  const actions = actionFacts(record);
  const carriedOut = carriedOutFacts(record);
  return {
    kind: 'decision', asked: true, found: true,
    id: record.id,
    followed_heading: words.followed_heading,
    goal: record.input.goal,
    status_words: statusWords(record),
    copy_href: `/work/decisions/${encodeURIComponent(record.id)}/copy`,
    decision: decision ? {
      name: decision.move ?? chosen?.label ?? decision.option_id,
      from_option: decision.move && chosen ? chosen.label : null,
      reason: decision.reason, next_action: decision.next_action, success_measure: decision.success_measure,
      recheck_day: record.recheck_on ? day(record.recheck_on) : null,
    } : null,
    latest_result: latest ? { result: resultWords(latest.result), summary: latest.summary || null } : null,
    waiting: record.outcome_question ? { question: record.outcome_question.question } : null,
    options: record.input.options.map(option => ({ label: option.label, chosen: option.id === decision?.option_id })),
    stance: decision ? stanceOf(record, stance, words) : null,
    actions, carried_out: carriedOut, acted: Boolean(actions.length || carriedOut.length),
    followed: followedFacts(trace),
    pursuits: Object.values(record.cited_pursuits ?? {}).map(pursuitChange).filter(Boolean),
    results: resultFacts(record),
    notes: (record.scratchpad ?? []).map(note => ({ title: note.text, status: statusOf(note.written_at) })),
    evidence: record.input.evidence.map(item => ({ claim: item.claim, withdrawn: Boolean(item.retracted_at), source: sourceOf(item.ref) })),
    worked: worked.map(step => ({ question: step.question, detail: lines(step.rows.map(row => `${row.label}: ${row.text}`)) })),
    started: day(record.created_at),
  };
}
