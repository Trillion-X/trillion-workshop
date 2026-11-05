// src/close-many.mjs
//
// Purpose
//   Closes up to max_items waiting jobs in one call (POST /handoffs/close-many), for a helper that already sorted them
//   (harness/triage-open-work.mjs): each is closed as handled, with its one-line reason, or gathered into one digest job
//   with the others gathered in the same call. It does in the account's own store what would otherwise take a helper
//   six calls a job: the finish, the decision a job made from the person's own words needs before it may finish
//   (src/message-decision.mjs, decided "keep" from the sorting's words), and the fold into the digest.
//
// Non-negotiable invariants
//   1. Running it twice changes nothing: a finished job is reported as already closed, a decided message is not decided
//      again, and the digest's request_key is made from the jobs it gathers.
//   2. A job someone holds now, or one handed to one agent by name, is never closed here.
//   3. The decision is recorded in the engine like any other, without telling the person's other AIs about each one:
//      closing old work in bulk is not news. Two or more of the person's messages that have no decision yet share one
//      (admitTogether): every message is a fact of it in its own words, its reason names each one's reason, and each
//      message is linked to it as a follow-up is. A decision of each sentence cost a whole decision's rows per line.
//   4. Every word and answer is DATA (src/close-many.json); an outcome is a row there, never a branch here.
//
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import settings from './close-many.json' with { type: 'json' };

const fill = (template, values) => String(template ?? '').replace(/\{(\w+)\}/g, (whole, name) => (Object.hasOwn(values, name) ? String(values[name]) : whole));
const filled = (value, values) => JSON.parse(JSON.stringify(value), (key, text) => (typeof text === 'string' ? fill(text, values) : text));
const line = (value, max = 500) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null);

export class CloseManyError extends Error {}
const identity = value => bytesToHex(blake3(new TextEncoder().encode(JSON.stringify(value))));
const checked = async (check, work) => { check(); const result = await work(); check(); return result; };

/**
 * Decides one message's decision from the sorting's words, quietly. → case_id
 *   engine: the account's decision engine;  admit(message_id) → case_id (src/message-decision.mjs admitMessageDecision)
 */
export async function decideMessageQuietly({ engine, admit, message_id, values, option, check = () => {}, remember = () => {}, resume = null }) {
  if (resume) return decideQuietly({ engine, ...resume, check });
  const case_id = await checked(check, () => admit(message_id));
  const record = await checked(check, () => engine.get(case_id));
  // A follow-up that joined another message's decision closes without deciding it: that decision is its first
  // message's to make, and sorting a "thanks" must never decide the request it followed.
  if (record?.decision || (record && record.source_id !== message_id)) return case_id;
  const decision = { case_id, evidence_refs: [message_id], values, option, decision_generation: (record?.decision_generation ?? 0) + 1 };
  remember(decision);
  return decideQuietly({ engine, ...decision, check });
}

// Answers a decision's questions from the sorting's words, decides it and records it carried out. → case_id
async function decideQuietly({ engine, case_id, evidence_refs, values, option, decision_generation = null, check = () => {} }) {
  let record = await checked(check, () => engine.get(case_id));
  const intended = { option_id: option, evidence_refs, ...filled(settings.decide, values) };
  const matches = actual => Object.keys(actual ?? {}).length === Object.keys(intended).length
    && Object.entries(intended).every(([key, value]) => JSON.stringify(actual?.[key]) === JSON.stringify(value));
  const generationMatches = kept => decision_generation === null || (kept?.decision_generation ?? 1) === decision_generation;
  if (record?.decision && (!matches(record.decision) || !generationMatches(record))) throw new CloseManyError('The reserved source decision changed. Read it before resuming this closure.');
  for (let step = 0; !record?.decision && step < 20; step += 1) {
    // Closing in bulk never shows similar earlier decisions, so it never asks for them.
    const question = (await checked(check, () => engine.guide(case_id, undefined, { allowHistory: false }))).question;
    if (!question) break;
    const answer = settings.answers[question.step_id];
    if (!answer) throw new CloseManyError(`Its decision asks "${question.step_id}", which closing in bulk does not answer.`);
    await checked(check, () => engine.guide(case_id, { step_id: question.step_id, answer: { evidence_refs, ...filled(answer, values) } }));
  }
  if (!record?.decision) await checked(check, () => engine.decideGuided(case_id, intended, { ...(decision_generation === null ? {} : { expected_generation: decision_generation }) }));
  record = await checked(check, () => engine.get(case_id));
  if (!matches(record?.decision) || !generationMatches(record)) throw new CloseManyError('The reserved source decision did not persist with its intended result.');
  // Its next action is nothing, so it is carried out now: otherwise every message closed this way came back hours later
  // as a decision whose next step nobody said was done, a job for an AI to read and close again.
  const receipt = { ...filled(settings.carried_out, values), by: values.by ?? 'trillion' };
  const already = record.carried_out?.some(entry => (entry.decision_generation ?? 1) === (record.decision_generation ?? 1)
    && Object.entries(receipt).every(([key, value]) => entry[key] === value));
  if (!already) await checked(check, () => engine.recordCarriedOut(case_id, { ...receipt, expected_generation: decision_generation ?? record.decision_generation ?? 1 }));
  return case_id;
}

/**
 * input: { items: [{ handoff_id, outcome (a key of settings.outcomes), reason, meaning? }], by }
 *   agents: src/agents.mjs;  engine, admit: for jobs made from the person's words
 *   admitTogether(message_ids, { source_id, goal }) → { placed, together, joined } (src/message-decision.mjs
 *   admitMessagesTogether): when given, messages with no decision yet share one
 * → { closed: [{ handoff_id, outcome, case_id? }], repeated: [handoff_id], digest: { into, count } | null, problems: [{ handoff_id, problem }] }
 */
export async function closeMany({ agents, engine, admit, admitTogether = null }, input = {}) {
  const items = input.items;
  if (!Array.isArray(items) || !items.length || items.length > settings.max_items)
    throw new CloseManyError(`items is a list of 1 to ${settings.max_items} jobs, each { handoff_id, outcome, reason }.`);
  const by = line(input.by, 200) ?? 'trillion';
  for (const [index, item] of items.entries()) {
    if (!line(item?.handoff_id, 200) || !Object.hasOwn(settings.outcomes, item?.outcome) || !line(item?.reason))
      throw new CloseManyError(`items[${index}] needs handoff_id, outcome (${Object.keys(settings.outcomes).join(' or ')}) and a reason.`);
  }
  if (new Set(items.map(item => item.handoff_id)).size !== items.length) throw new CloseManyError('Each handoff may appear only once in a close-many request.');
  const done = { closed: [], repeated: [], digest: null, problems: [] };
  const reserved = [], current = new Map(), failed = new Set();
  const fail = (item, error) => {
    if (failed.has(item.handoff_id)) return;
    failed.add(item.handoff_id);
    const problem = String(error.message ?? error).slice(0, 400);
    agents.closeWaitingFailed({ handoff_id: item.handoff_id, reservation_token: item.reservation_token, error: problem });
    done.problems.push({ handoff_id: item.handoff_id, problem, retry: true });
  };
  for (const item of items) {
    try {
      const claim = agents.reserveCloseWaiting({ handoff_id: item.handoff_id, by,
        intent: { outcome: item.outcome, reason: line(item.reason), meaning: line(item.meaning) } });
      if (claim.repeated) { done.repeated.push(item.handoff_id); continue; }
      current.set(item.handoff_id, claim.handoff);
      reserved.push({ ...item, reservation_token: claim.reservation_token, digest_handoff_id: claim.digest_handoff_id, source_decision: claim.source_decision, group_admission: claim.group_admission });
    } catch (error) { done.problems.push({ handoff_id: item.handoff_id, problem: String(error.message ?? error).slice(0, 400) }); }
  }
  const check = item => agents.checkCloseReservation({ handoff_id: item.handoff_id, reservation_token: item.reservation_token });
  const checkAll = group => () => { for (const item of group) check(item); };
  try {
    // Reserve eligibility first, so a held/named/refused item cannot enter a digest or a shared source decision.
    const gathered = reserved.filter(item => settings.outcomes[item.outcome].result_state === 'folded');
    const newDigest = gathered.filter(item => !item.digest_handoff_id).sort((a, b) => a.handoff_id.localeCompare(b.handoff_id));
    if (newDigest.length) {
      checkAll(newDigest)();
      const into = agents.handOff({
        job: fill(settings.digest_job, { count: newDigest.length }), from_agent: by,
        request_key: `close-many-digest:${newDigest.map(item => item.handoff_id).sort().join(',')}`.slice(0, 500),
        input: { arrived: { count: newDigest.length, items: newDigest.map(item => ({ handoff_id: item.handoff_id, handed_at: current.get(item.handoff_id).handed_at, job: String(current.get(item.handoff_id).job ?? '').slice(0, 600), why_here: line(item.reason) })) } },
      }).handoff.handoff_id;
      for (const item of newDigest) {
        agents.keepCloseDigest({ handoff_id: item.handoff_id, reservation_token: item.reservation_token, digest_handoff_id: into });
        item.digest_handoff_id = into;
      }
    }
    const digests = [...new Set(gathered.map(item => item.digest_handoff_id))];
    if (digests.length === 1) done.digest = { into: digests[0], count: gathered.length };
    else if (digests.length > 1) done.digests = digests.map(into => ({ into, count: gathered.filter(item => item.digest_handoff_id === into).length }));
    const messageOf = item => { const arrived = current.get(item.handoff_id).input?.arrived; return arrived?.from_person === true && arrived.message_id ? arrived.message_id : null; };
    const shared = new Map();
    const keepSource = (item, field, value) => {
      agents.keepCloseSource({ handoff_id: item.handoff_id, reservation_token: item.reservation_token, [field]: value });
      item[field] = value;
    };
    const spoken = reserved.filter(messageOf).sort((a, b) => messageOf(a).localeCompare(messageOf(b)));
    const needsGroup = spoken.some(item => !item.source_decision);
    if (needsGroup && spoken.some(item => item.group_admission && JSON.stringify(item.group_admission.ids) !== JSON.stringify([...new Set(spoken.map(messageOf))].sort()))) {
      for (const item of spoken.filter(item => item.group_admission)) fail(item, new CloseManyError('Retry the original grouped close request together so its kept admission can finish.'));
    }
    if (!admitTogether) for (const item of spoken.filter(item => item.group_admission && !item.source_decision))
      fail(item, new CloseManyError('Retry the original grouped close request with its source admission owner.'));
    if (admitTogether && needsGroup && spoken.length > 1 && !spoken.some(item => failed.has(item.handoff_id))) {
      try {
        const guard = checkAll(spoken);
        const ids = [...new Set(spoken.map(messageOf))].sort();
        const plan = { ids, source_id: `close-many:${identity(ids)}`, goal: fill(settings.together.goal, { count: ids.length }),
          items: spoken.map(item => ({ handoff_id: item.handoff_id, outcome: item.outcome, reason: line(item.reason), meaning: line(item.meaning) })) };
        for (const item of spoken) keepSource(item, 'group_admission', plan);
        const { placed, together, joined } = await checked(guard, () => admitTogether(ids, { source_id: plan.source_id, goal: plan.goal }));
        // Admission may have persisted its links before a transport refusal. On restart the owner returns those
        // placements instead of "together"; only this exact batch's source may resume our unfinished decision.
        const caseIds = [...new Set([together, ...placed.values()].filter(Boolean))];
        for (const case_id of caseIds) {
          const record = await checked(guard, () => engine.get(case_id));
          if (case_id !== together && record?.source_id !== plan.source_id) continue;
          const members = spoken.filter(item => placed.get(messageOf(item)) === case_id);
          const evidence_refs = together === case_id ? joined : members.map(messageOf).sort();
          if (!members.length) continue;
          const reasons = members.map(item => line(item.reason)).join('; ');
          const outcomes = [...new Set(members.map(item => item.outcome))];
          const decision = { case_id, evidence_refs, option: settings.outcomes[members[0].outcome].decision_option,
            decision_generation: members.find(item => item.source_decision)?.source_decision.decision_generation ?? (record?.decision_generation ?? 0) + 1,
            values: { reason: line(fill(settings.together.reason, { reasons }), 2000), meaning: line(fill(settings.together.meaning, { count: evidence_refs.length }), 500), outcome: outcomes.join(' or '), by } };
          // An earlier completed decision is left alone. Only a decision this closure prepared can be resumed.
          if (!record?.decision || members.some(item => item.source_decision)) {
            for (const item of members) keepSource(item, 'source_decision', decision);
            await decideQuietly({ engine, ...decision, check: guard });
          }
          for (const item of members) shared.set(messageOf(item), case_id);
        }
      } catch (error) { for (const item of spoken) fail(item, error); }
    }
    for (const item of reserved.filter(item => !failed.has(item.handoff_id))) {
      const shape = settings.outcomes[item.outcome], reason = line(item.reason);
      try {
        check(item);
        const message_id = messageOf(item);
        const case_id = message_id ? shared.get(message_id) ?? await decideMessageQuietly({ engine, admit, message_id, option: shape.decision_option,
          values: { reason, meaning: line(item.meaning) ?? reason, outcome: item.outcome, by }, check: () => check(item),
          resume: item.source_decision, remember: decision => keepSource(item, 'source_decision', decision) }) : null;
        check(item);
        const into = item.digest_handoff_id;
        const result = shape.result_state === 'folded' ? { state: 'folded', into, because: reason } : { state: shape.result_state, because: reason };
        const summary = fill(shape.result_state === 'folded' ? settings.summary_folded : settings.summary_handled, { reason, into });
        agents.closeWaiting({ handoff_id: item.handoff_id, by, result, summary, reservation_token: item.reservation_token });
        done.closed.push({ handoff_id: item.handoff_id, outcome: item.outcome, ...(case_id ? { case_id } : {}) });
      } catch (error) { fail(item, error); }
    }
  } catch (error) { for (const item of reserved) fail(item, error); }
  return done;
}
