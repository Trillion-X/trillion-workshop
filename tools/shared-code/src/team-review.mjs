// src/team-review.mjs
//
// Purpose: a team review. One of the person's AIs does a piece of work, another reviews it, and they pass it back and
// forth until the reviewer approves or the round limit is reached. Every step is an ordinary handoff on the account
// (src/agents.mjs), handed on from the step before (parent_handoff_id), so any AI connected to the account takes part:
// a coding agent, a chat app, or a local model on the person's own computer that published itself there. The review is
// the chain of those handoffs and nothing else; there is no second store.
//
// Non-Negotiable Invariants:
//   1. Roles, their order, their words, which step decides and the round limit are DATA (src/team-review.json); this
//      file names no role and no AI.
//   2. The review id is the first step's handoff id. Its state is read from the chain every time, never kept apart.
//   3. The same request_key starts the same review once (hand_off's own request_key rule); each later step's key is
//      derived from it, round and step, so advancing twice never hands a step out twice.
//   4. A step is handed on only when the step before is finished; a deciding step whose result says yes in its
//      `decides.field` ends the review, and so does the last round.
//   5. Explicit execution needs travel with every handoff through every round. A review that requires connected
//      subscription AIs never broadens into local/API work when the next stage is handed on.
//

import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';

const identity = value => `1f:${bytesToHex(blake3(new TextEncoder().encode(JSON.stringify(value))))}`;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fill = (words, values) => words.replace(/\{(\w+)\}/g, (whole, name) => (Object.hasOwn(values, name) ? String(values[name]) : whole));

// A result says yes in a field when it is an object (or JSON text of one) whose field is true.
function saysYes(result, field) {
  let value = result;
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch { return false; } }
  return object(value) && value[field] === true;
}

// The exact finished candidate, rather than its mutable card or the reviewer's claim, owns approval.
export const reviewCandidate = item => ({ handoff_id: item.handoff_id, generation: item.generation ?? 0, agent_id: item.taken_by,
  result_identity: identity(item.result) });
const sameCandidate = (a, b) => object(a) && object(b) && a.handoff_id === b.handoff_id && a.generation === b.generation && a.agent_id === b.agent_id && a.result_identity === b.result_identity;
const resultObject = result => { if (typeof result === 'string') { try { return JSON.parse(result); } catch { return null; } } return result; };

// Pure selection uses the saved actor; actual take/finish also checks the source owner's current actor.
export function teamReviewActorProblem(item, agent) {
  const at = item?.input?.team_review;
  return at?.integrity?.independent_actor && at.decides_field && (!agent || !agent.agent_id || agent.agent_id === at.candidate?.agent_id)
    ? 'The agent that did this work cannot decide its review. Another published agent must take it.' : null;
}

// Shared by take/finish and readback. A refusal leaves the ordinary handoff open/taken and recoverable.
// This proves distinct published agents, not distinct people, vendors or underlying model executions.
export function teamReviewProblem(item, { agent, candidate, result, deciding = false, cardFor = () => null } = {}) {
  const at = item?.input?.team_review;
  if (!at?.integrity || !at.decides_field) return null; // Existing saved runs retain their original contract.
  if (!candidate || item.parent_handoff_id !== at.candidate?.handoff_id || candidate.handoff_id !== at.candidate?.handoff_id)
    return 'This review has no matching candidate handoff. Read the original work before reviewing it.';
  const actorProblem = teamReviewActorProblem(item, agent);
  if (actorProblem) return actorProblem;
  const worker = cardFor(candidate.taken_by);
  if (at.integrity.independent_actor && (!agent || agent.agent_id === candidate.taken_by
      || (agent.source_id && worker?.source_id === agent.source_id)))
    return 'The agent that did this work cannot decide its review. Another published agent must take it.';
  if (!deciding || !saysYes(result, at.decides_field)) return null;
  if (candidate.state !== 'finished' || candidate.withdrawal || !sameCandidate(reviewCandidate(candidate), at.candidate))
    return 'The candidate changed or was withdrawn. Reject this review with notes so a new round can prepare current work.';
  if (!sameCandidate(item.input.previous?.candidate, at.candidate) || identity(item.input.previous?.result) !== at.candidate.result_identity)
    return 'The review input does not contain the exact candidate result. Reject it with notes before another round.';
  const answer = resultObject(result);
  if (!sameCandidate(answer?.[at.integrity.candidate_field], at.candidate))
    return `Approval must include ${at.integrity.candidate_field} equal to input.team_review.candidate from this exact review.`;
  return null;
}

/**
 * agents:   the account's agents (src/agents.mjs makeAgents): handOff, read, find, idFor, cardOf
 * settings: src/team-review.json
 */
export function makeTeamReview({ agents, settings }) {
  const { steps } = settings;
  if (!Array.isArray(steps) || !steps.length) throw new Error('A team review needs at least one step.');

  function handStep({ key, work, root, round, rounds, step, assign, needs, from_agent, parent_handoff_id, previous, integrity }) {
    const row = steps[step];
    const candidate = integrity && row.decides && previous ? previous.candidate : undefined;
    return agents.handOff({
      request_key: `${key}\n${round}\n${step}`,
      job: fill(row.job, { round, rounds, work }),
      to_agent: assign[row.role] ?? undefined,
      from_agent: from_agent ?? undefined,
      parent_handoff_id: parent_handoff_id ?? undefined,
      hold_minutes: settings.hold_minutes,
      input: { ...(needs ? { needs: [...needs] } : {}), team_review: { key, root, round, rounds, step, role: row.role, assign, ...(integrity ? { integrity: { ...integrity }, decides_field: row.decides?.field ?? null, ...(candidate ? { candidate } : {}) } : {}) }, work, previous },
    }).handoff;
  }

  function start(input = {}) {
    const work = typeof input.work === 'string' ? input.work.trim() : '';
    if (!work) throw new Error('work is needed: what the AIs should do, in plain words.');
    const key = typeof input.request_key === 'string' ? input.request_key.trim() : '';
    if (!key) throw new Error('request_key is needed: any unique text, so starting again returns the same review.');
    const most = settings.rounds.most;
    const rounds = input.rounds === undefined ? settings.rounds.default : input.rounds;
    if (!Number.isInteger(rounds) || rounds < 1 || rounds > most) throw new Error(`rounds is a whole number from 1 to ${most}.`);
    if (input.needs !== undefined && !(Array.isArray(input.needs) && input.needs.length > 0 && input.needs.length <= 64 && input.needs.every(need => typeof need === 'string' && need.trim() && need.length <= 120)))
      throw new Error('needs is a nonempty list of at most 64 capability names, each up to 120 characters.');
    const needs = input.needs?.map(need => need.trim());
    const roles = new Set(steps.map(row => row.role));
    const assign = input.assign === undefined ? {} : input.assign;
    if (!object(assign)) throw new Error(`assign is { role: agent_id } for the roles ${[...roles].join(', ')}.`);
    // Resume the original saved contract when defaults or integrity requirements have since changed.
    // The handoff owner supplies the request-key identity; review code never reimplements its address rule.
    let existing;
    try { existing = agents.read({ handoff_id: agents.idFor(`${key}\n1\n0`) }).handoff; } catch {}
    if (existing) {
      const prior = existing.input?.team_review;
      if (!prior || existing.input.work !== work || (input.rounds !== undefined && prior.rounds !== rounds)
          || (existing.from_agent ?? null) !== (typeof input.from_agent === 'string' && input.from_agent.trim() ? input.from_agent.trim().slice(0, 200) : null)
          || identity(prior.assign ?? {}) !== identity(assign) || identity(existing.input.needs ?? null) !== identity(needs ?? null))
        throw new Error('This request_key already started different review work. Use a new request_key for changed work.');
      return read({ review_id: existing.handoff_id });
    }
    const published = new Set(agents.find({ all: true }).agents.map(agent => agent.agent_id));
    for (const [role, agent_id] of Object.entries(assign)) {
      if (!roles.has(role)) throw new Error(`There is no role ${role}. The roles are ${[...roles].join(', ')}.`);
      if (typeof agent_id !== 'string' || !published.has(agent_id)) throw new Error(`No AI ${agent_id} has published on this account. find_agents lists them.`);
    }
    for (let step = 1; step < steps.length; step += 1) {
      if (settings.integrity?.independent_actor && steps[step].decides && assign[steps[step].role]
          && assign[steps[step].role] === assign[steps[step - 1].role])
        throw new Error('The agent assigned to review must differ from the agent doing the preceding work.');
    }
    const first = handStep({ key, work, root: null, round: 1, rounds, step: 0, assign, needs, from_agent: input.from_agent, parent_handoff_id: null, previous: null, integrity: settings.integrity });
    return read({ review_id: first.handoff_id });
  }

  // Called with every handoff that finishes: a step of a review hands on the next step, or ends the review.
  function advance(finished) {
    if (finished?.withdrawal || finished?.status === 'withdrawn' || finished?.result?.state === 'withdrawn') return null;
    const at = finished?.input?.team_review;
    if (!object(at)) return null;
    const row = steps[at.step];
    if (!row) return null;
    if (row.decides && saysYes(finished.result, row.decides.field)) return null;
    const wraps = row.decides || at.step + 1 >= steps.length;
    if (wraps && at.round >= at.rounds) return null;
    const next = wraps ? { round: at.round + 1, step: 0 } : { round: at.round, step: at.step + 1 };
    // Re-finishing a reopened candidate does not rewrite the review already handed out for its prior attempt.
    // The reviewer can reject that stale candidate, then the ordinary next round carries current work.
    let existing;
    try { existing = agents.read({ handoff_id: agents.idFor(`${at.key}\n${next.round}\n${next.step}`) }).handoff; } catch {}
    if (existing && existing.parent_handoff_id === finished.handoff_id
        && existing.input?.team_review?.key === at.key
        && identity(existing.input?.team_review?.integrity ?? null) === identity(at.integrity ?? null)) return existing;
    return handStep({
      key: at.key, work: finished.input.work, root: at.root ?? finished.handoff_id, rounds: at.rounds, assign: at.assign ?? {}, needs: finished.input.needs,
      ...next, from_agent: finished.taken_by, parent_handoff_id: finished.handoff_id,
      integrity: at.integrity,
      previous: { role: at.role, round: at.round, result: finished.result, summary: finished.summary ?? null, ...(at.integrity ? { candidate: reviewCandidate(finished) } : {}) },
    });
  }

  // The review as its chain of steps, first to last, with where it stands and the last work done.
  function read(input = {}) {
    const review_id = typeof input.review_id === 'string' ? input.review_id.trim() : '';
    if (!review_id) throw new Error('review_id is needed: the id start_team_review returned.');
    let found;
    try { found = agents.read({ handoff_id: review_id }); } catch { return { review_id, state: null, said: `There is no team review ${review_id} on this account.` }; }
    if (!object(found.handoff.input?.team_review)) return { review_id, state: null, said: `${review_id} is a handoff, not a team review.` };
    const contract = found.handoff.input.team_review;
    const invalid = problem => ({ review_id, state: 'invalidated', said: settings.states.invalidated,
      assurance: { contract: typeof contract.integrity?.version === 'string' ? contract.integrity.version : 'invalid', candidate_bound: false, independent_agent: false, problem },
      steps: [], result: null });
    if (typeof contract.key !== 'string' || !contract.key.trim() || contract.root !== null || contract.round !== 1 || contract.step !== 0
        || contract.role !== steps[0].role || !Number.isInteger(contract.rounds) || contract.rounds < 1
        || agents.idFor(`${contract.key}\n1\n0`) !== review_id)
      return invalid('This handoff is not the canonical first step of a team review.');
    if (contract.integrity && (!object(contract.integrity) || typeof contract.integrity.version !== 'string' || !contract.integrity.version.trim()
        || typeof contract.integrity.independent_actor !== 'boolean' || typeof contract.integrity.candidate_field !== 'string' || !contract.integrity.candidate_field.trim()))
      return invalid('This review has an invalid integrity contract.');
    const chain = [];
    let lastItem;
    let chainProblem = null;
    const rootContract = found.handoff.input.team_review;
    const visited = new Set();
    for (let current = found; current; ) {
      const item = current.handoff;
      if (visited.has(item.handoff_id)) { chainProblem = 'The review chain contains a cycle.'; break; }
      visited.add(item.handoff_id);
      lastItem = item;
      const at = item.input.team_review;
      if (!Number.isInteger(at.step) || !steps[at.step] || at.role !== steps[at.step].role || !Number.isInteger(at.round)
          || at.round < 1 || at.round > contract.rounds || at.rounds !== contract.rounds
          || (contract.integrity && at.decides_field !== (steps[at.step].decides?.field ?? null)))
        return invalid('A review step or deciding field does not match the actual review definition.');
      chain.push({ handoff_id: item.handoff_id, round: at.round, step: at.step, role: at.role, label: steps[at.step]?.label ?? at.role, state: item.withdrawal ? 'withdrawn' : item.state, to_agent: item.to_agent, taken_by: item.taken_by, finished_at: item.finished_at, summary: item.summary, result: item.result });
      if (steps[at.step]?.decides && saysYes(item.result, steps[at.step].decides.field)) break;
      const wraps = steps[at.step]?.decides || at.step + 1 >= steps.length;
      const next = wraps ? { round: at.round + 1, step: 0 } : { round: at.round, step: at.step + 1 };
      const child = current.handed_on.find(child => child.handoff_id === agents.idFor(`${rootContract.key}\n${next.round}\n${next.step}`));
      if (child && (child.parent_handoff_id !== item.handoff_id || child.input?.team_review?.root !== review_id
          || child.input?.team_review?.key !== rootContract.key || child.input?.team_review?.round !== next.round
          || child.input?.team_review?.step !== next.step
          || identity(child.input?.team_review?.integrity ?? null) !== identity(rootContract.integrity ?? null))) {
        chainProblem = 'The next review handoff does not match this saved review contract.';
        break;
      }
      current = child ? agents.read({ handoff_id: child.handoff_id }) : null;
    }
    const last = chain.at(-1);
    const lastRow = steps[last.step];
    const candidate = lastItem.input.team_review.candidate;
    const approvalProblem = chainProblem || (last.state === 'finished' && lastRow?.decides && saysYes(last.result, lastRow.decides.field)
      && lastItem.input.team_review.integrity ? teamReviewProblem(lastItem, {
        agent: agents.cardOf(last.taken_by),
        candidate: candidate ? agents.read({ handoff_id: candidate.handoff_id }).handoff : null,
        cardFor: agents.cardOf, result: last.result, deciding: true,
      }) : null);
    const state = chain.some(step => step.state === 'withdrawn') ? 'withdrawn' : approvalProblem ? 'invalidated' : last.state !== 'finished' ? 'working'
      : lastRow?.decides && saysYes(last.result, lastRow.decides.field) ? 'approved' : 'round_limit';
    const work = [...chain].reverse().find(step => step.state === 'finished' && !steps[step.step]?.decides);
    return {
      review_id, state, said: settings.states[state], assurance: found.handoff.input.team_review.integrity ? { contract: found.handoff.input.team_review.integrity.version, candidate_bound: state === 'approved', independent_agent: state === 'approved' && Boolean(found.handoff.input.team_review.integrity.independent_actor), ...(approvalProblem ? { problem: approvalProblem } : {}) } : { contract: 'legacy', candidate_bound: false, independent_agent: false }, work: found.handoff.input.work, ...(found.handoff.input.needs ? { needs: found.handoff.input.needs } : {}), rounds: found.handoff.input.team_review.rounds,
      round: last.round, steps: chain, result: work?.result ?? null,
    };
  }

  return { start, advance, read };
}
