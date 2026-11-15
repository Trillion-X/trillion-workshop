// A decision on the free plan keeps nothing. Its state travels inside the case id the AI sends back with each call,
// sealed so only this person's store can open it, and holds only what the next step needs: the goal, the evidence
// refs and options, the method's id, which deeper checks the scope answer switched on, and which steps are answered.
// No answer text, note, pursuit or result is in it, and nothing of it is written anywhere.
//
// The seal is AES-GCM under a key derived with BLAKE3 from the service's root key and this person's store id, so a
// run started by one person cannot be opened by another, and a changed byte is refused.
import { makeDerivedKeyBytes } from '../../content-identity/read-data/identity.mjs';
import { caseIdFor, rowsOf } from './decisions.mjs';
import { methodCatalogue } from './method.mjs';
import settings from './decide-with-a-method.json' with { type: 'json' };
import { decisionSession, handleCaseRequest } from './free-decision-session.mjs';

export const RUN_PREFIX = 'run_';
const encoder = new TextEncoder();
const CONTEXT = encoder.encode('trillion free decision run');

async function runKey(root, person) {
  if (!root) throw new Error('Free decisions need the service root key, and it is not set.');
  const raw = makeDerivedKeyBytes(new Uint8Array([...root, ...encoder.encode(person)]), CONTEXT);
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

/** What a run keeps between calls: only what routing the next step needs. */
function compact(record) {
  const guidance = record.guidance ?? [];
  const scopeId = record.method.steps.find(step => step.kind === 'scope')?.id;
  const scope = guidance.find(item => item.step_id === scopeId);
  return {
    source_id: record.source_id,
    goal: record.input.goal,
    evidence_refs: record.input.evidence.filter(item => !item.retracted_at).map(item => item.ref),
    options: record.input.options,
    method: record.method.id,
    ...(scope?.answer?.decision_context !== undefined ? { switches: scope.answer.decision_context } : {}),
    completed_steps: guidance.map(item => item.step_id),
    created_at: record.created_at,
  };
}

/** The case record the engine works on for this call, rebuilt from the run. Answers already given are not held. */
function expand(run, methods) {
  const method = methodCatalogue(methods, [], { link: [settings.records.method_link, ...(settings.records.old_method_links ?? [])] }).snapshotMethod(run.method);
  const scopeId = method.steps.find(step => step.kind === 'scope')?.id;
  // Earlier tokens stored the scope separately and only the later answered IDs.
  const completed = run.completed_steps ?? (run.switches
    ? [method.steps[0].id, ...(run.answered ?? [])] : run.answered ?? []);
  return {
    id: caseIdFor(run.source_id), source_id: run.source_id,
    input: { source_id: run.source_id, goal: run.goal, evidence: run.evidence_refs.map(ref => ({ ref, claim: ref })), options: run.options },
    method, scratchpad: [], status: 'needs_decision', decision: null, actions: [], checks: [], pursuits_known: false, created_at: run.created_at,
    guidance: completed.map(step_id => ({ step_id,
      answer: step_id === scopeId && run.switches !== undefined ? { decision_context: run.switches } : {} })),
  };
}

// `roots`: every bound root key, newest first (src/root-keys.mjs readRootKeys). The newest seals; a run sealed before
// a root rotation still opens with the root it was sealed under while that root is bound.
export async function sealRun(record, { roots, person }) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await runKey(roots[0], person), encoder.encode(JSON.stringify(compact(record)))));
  return RUN_PREFIX + Buffer.from(new Uint8Array([...iv, ...sealed])).toString('base64url');
}

export async function openRun(token, { roots, person, methods }) {
  if (!token.startsWith(RUN_PREFIX)) throw new Error('This is not a free decision.');
  if (!roots?.length) await runKey(null, person);
  const bytes = Buffer.from(token.slice(RUN_PREFIX.length), 'base64url');
  let plain = null;
  for (const root of roots) {
    try { plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.subarray(0, 12) }, await runKey(root, person), bytes.subarray(12)); break; }
    catch { /* the next bound root may be the one it was sealed under */ }
  }
  if (!plain) throw new Error('This decision id was changed or belongs to someone else. Use the case_id from the latest reply.');
  return expand(JSON.parse(new TextDecoder().decode(plain)), methods);
}

/** An engine store that holds one run for the length of one call and writes nowhere. */
export function runStore(record) {
  let state = { cases: record ? { [record.id]: record } : {}, pursuits: {} };
  return { read: async () => structuredClone(state), write: async next => { state = structuredClone(next); }, current: () => state };
}

// A free decision's reply: the run's id in place of the case id, no pursuits (a free plan keeps none), and the lines
// the AI passes on to the person.
async function freeReply(response, id, token, notes, instructions = []) {
  const reply = JSON.parse((await response.text()).replaceAll(id, token));
  delete reply.pursuits;
  delete reply.pursuits_note;
  return Response.json({ ...reply, ...(notes.length ? { tell_the_person: notes } : {}), ...(instructions.length ? { ai_instructions: [...(reply.ai_instructions ?? []), ...instructions] } : {}) }, { status: response.status });
}

// What a decided run holds that the upgrade pitch may cite: the option chosen, the ones it ruled out, the reason given.
function decidedFacts(record) {
  const label = option => option.label ?? option.id;
  const chosen = record.input.options.find(option => option.id === record.decision.option_id);
  return { chosen: chosen ? label(chosen) : record.decision.option_id, ruledOut: record.input.options.filter(option => option !== chosen).map(label), reason: record.decision.reason ?? '' };
}

/**
 * One call to a free person's decision routes. Nothing is written except through `countDecision`, which the store
 * keeps as this period's count; the run lives only in the sealed case id.
 * context: { sealing: { roots, person }, allowance: { count, per, used } (always a count: the free plan is never unlimited), words: { left(allowance), keeps, usedUp, pitch(facts)? },
 *            countDecision(), door (the person's records door, used only for method/check reads) }
 * The current tools accept caller verdicts beside each answer. Retired hosted judge callbacks are refused.
 */
export async function freeDecisionRequest(request, { sealing, allowance, words, countDecision, judgeChecks, onePassJudgeChecks, workflowRun, door }) {
  const methods = await rowsOf(door, settings.records.method_row, settings.records.method_where);
  sealing = { ...sealing, methods };
  const session = store => decisionSession(store, { door });
  if (judgeChecks || onePassJudgeChecks) throw new Error('Free decisions use caller verdicts beside each answer; hosted judge callbacks are no longer supported.');
  const url = new URL(request.url);
  // The questions of a whole decision read nothing and keep nothing, so they cost no free decision.
  if (request.method === 'POST' && url.pathname === '/cases/one-pass/questions') return handleCaseRequest(session(runStore(null)), request, { allowHistory: false });
  // A whole decision sent at once uses one free decision, the same as starting one, and is kept nowhere.
  if (request.method === 'POST' && url.pathname === '/cases/one-pass') {
    if (!Number.isSafeInteger(allowance.count) || allowance.used >= allowance.count) {
      return Response.json({ error: words.usedUp, plan_needed: true }, { status: 402 });
    }
    const store = runStore(null);
    const response = await handleCaseRequest(session(store), request, { allowHistory: false, judgeChecks, onePassJudgeChecks, workflowRun });
    if (!response.ok) return response;
    await countDecision();
    const record = Object.values(store.current().cases)[0];
    return freeReply(response, record.id, await sealRun(record, sealing), [words.left({ ...allowance, used: allowance.used + 1 }), words.keeps], words.pitch ? [words.pitch(decidedFacts(record))] : []);
  }
  if (request.method === 'POST' && url.pathname === '/cases') {
    // No count means no free decisions, never unlimited ones.
    if (!Number.isSafeInteger(allowance.count) || allowance.used >= allowance.count) {
      return Response.json({ error: words.usedUp, plan_needed: true }, { status: 402 });
    }
    const store = runStore(null);
    const response = await handleCaseRequest(session(store), request, { allowHistory: false });
    if (!response.ok) return response;
    await countDecision();
    const record = Object.values(store.current().cases)[0];
    return freeReply(response, record.id, await sealRun(record, sealing), [words.left({ ...allowance, used: allowance.used + 1 }), words.keeps]);
  }
  const step = url.pathname.match(/^\/cases\/(run_[^/]+)\/(guide|agent-decision|evidence)$/);
  if (step && (request.method === 'POST' || step[2] === 'guide')) {
    const token = decodeURIComponent(step[1]);
    let record;
    try { record = await openRun(token, sealing); } catch (error) { return Response.json({ error: error.message }, { status: 400 }); }
    const store = runStore(record);
    const response = await handleCaseRequest(session(store), new Request(`https://person/cases/${encodeURIComponent(record.id)}/${step[2]}`, request), { allowHistory: false, judgeChecks, workflowRun });
    const next = store.current().cases[record.id];
    if (!response.ok || request.method === 'GET') return freeReply(response, record.id, token, []);
    // The decided result carries, once, the instruction to tell the person what this decision surfaced and why paid is worth it.
    return next.decision ? freeReply(response, record.id, token, [words.keeps], words.pitch ? [words.pitch(decidedFacts(next))] : []) : freeReply(response, record.id, await sealRun(next, sealing), []);
  }
  if (request.method === 'GET' && url.pathname === '/decisions') return Response.json({ decisions: [], tell_the_person: [words.keeps] });
  if (request.method === 'GET' && url.pathname === '/pursuits') return Response.json({ pursuits: [], tell_the_person: [words.keeps] });
  return Response.json({ error: words.keeps, plan_needed: true }, { status: 402 });
}
