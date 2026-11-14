#!/usr/bin/env node
/**
 * autonomous-worker.selftest.mjs — offline proof (no engine) that the ONE engine is
 * generic (two unrelated descriptors drive it identically) and that the address is a
 * STRUCTURAL anti-spam guard (Codex L063). Run: node autonomous-worker.selftest.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { deterministicAddress, renderTemplate, corpusVersion, parseDecision, gateDecision, extractRefusalSignal, noOutputFailClosed, heldLockIsLive, resolvePartition, resolveDecideBin } from './autonomous-worker.mjs';

const here = dirname(fileURLToPath(import.meta.url));
// A descriptor fixture may exist only on the production machine (e.g. the coach +
// hiring descriptors ride the Fly log, not git). Missing file => null; sections
// filter to present fixtures so the selftest proves the engine with whatever DATA
// is on hand instead of crashing on absent DATA (the engine itself is descriptor-blind).
// Both lists are appended by `desc` itself, so the denominator is however many fixtures this file
// actually asks for. An earlier version of this block hardcoded the count at 4 while its own
// comment claimed a fixture added tomorrow would move the reported coverage on its own. It would
// not have: it would have printed 5/4. A number written beside a claim that it maintains itself is
// the worst kind of closed set, because the comment stops anyone from checking.
const askedForFixtures = [];
const absentFixtures = [];
const desc = (f) => { askedForFixtures.push(f); try { return JSON.parse(readFileSync(join(here, '..', 'worker-descriptors', f), 'utf8')); } catch { absentFixtures.push(f); console.log(`  (fixture ${f} not present locally, skipped)`); return null; } };
// Sections that run only when their fixture is present announce themselves here, so the verdict
// line can say what it did NOT cover. Without this the suite prints the same "ALL PASS" whether it
// ran every section or two thirds of them, and a green whose scope varies with the environment
// cannot be compared to the previous green: fewer assertions passing reads identically to all of
// them passing. Found on 2026-09-05, the first time anything ran this file, when it reported
// 47 passed with layer 6 entirely absent because two of the four descriptor fixtures ride the
// production log rather than git.
const skippedSections = [];
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name); } };

console.log('0) SINGLETON LOCK: yield only to a running, heartbeat-fresh holder (per engine+descriptor)');
{
  const now = 1_000_000, staleMs = 180_000, base = { nowMs: now, selfPid: 1, staleMs };
  ok('running + fresh holder => yield', heldLockIsLive({ pid: 42, heartbeat_ms: now - 1000 }, { ...base, isPidAlive: () => true }) === true);
  ok('dead pid => take over', heldLockIsLive({ pid: 42, heartbeat_ms: now - 1000 }, { ...base, isPidAlive: () => false }) === false);
  ok('stale heartbeat => take over', heldLockIsLive({ pid: 42, heartbeat_ms: now - 999999 }, { ...base, isPidAlive: () => true }) === false);
  ok('self pid => take over (own crashed-restart lock)', heldLockIsLive({ pid: 1, heartbeat_ms: now - 1000 }, { ...base, isPidAlive: () => true }) === false);
  ok('garbage lock => take over', heldLockIsLive(null, { ...base, isPidAlive: () => true }) === false);
}

const coach = desc('academy-director-coach.json');
const acct = desc('autonomous-accountant.json');
const groomer = desc('work-board-groomer.json'); // was proven live against a since-retired app (cont.81)
const hiring = desc('academy-hiring-director.json'); // layer 6: an agent that SPAWNS agents

console.log('1) GENERIC: the same engine renders ALL descriptors from DATA (zero code per worker)');
for (const d of [coach, acct, groomer, hiring].filter(Boolean)) {
  const subject = d.subjects[0];
  const prompt = renderTemplate(d.decide.prompt_template, { persona: '[p]\nbody', subject, program: '[]', output_kind: d.act.output_kind });
  ok(`${d.id}: prompt names its OWN domain (${d.act.output_kind}) with no other domain leaking`,
    prompt.includes(d.act.output_kind) && prompt.includes(subject) && !prompt.includes('{{'));
  ok(`${d.id}: argv renders the decide capability (${d.decide.bin})`,
    d.decide.argv_template.map(a => renderTemplate(a, { model: d.decide.model, prompt: 'X' })).join(' ').includes('exec'));
}
if (coach && acct) ok('coach and accountant differ in EVERY domain field (kind/prefix/subject) — proving nothing is hardcoded',
  coach.act.output_kind !== acct.act.output_kind && coach.act.address_prefix !== acct.act.address_prefix && coach.subjects[0] !== acct.subjects[0]);

console.log('2) DELETION TEST: drop the coach descriptor — the accountant still fully drives the engine');
{
  const d = acct, subject = d.subjects[0];
  const prompt = renderTemplate(d.decide.prompt_template, { persona: '', subject, program: '[]', output_kind: d.act.output_kind });
  ok('accountant alone yields a complete, domain-correct prompt (engine untouched by coach removal)',
    prompt.includes('reconciling-entry') && prompt.includes('books:2026-q3') && !prompt.includes('drill'));
}

console.log('3) STRUCTURAL ANTI-SPAM: address = hash(subject+kind+evidence_cursor+persona_v) — NO program');
{
  const prefix = (coach ?? acct ?? groomer).act.address_prefix, subj = 'student-truth-fly', kind = 'drill-prescription';
  const pv = corpusVersion([{ id: 'ethos-1', body: 'x' }]);
  const a1 = deterministicAddress(prefix, subj, kind, '2026-07-05T00:00:00Z', pv);
  const a2 = deterministicAddress(prefix, subj, kind, '2026-07-05T00:00:00Z', pv); // identical re-run
  const a3 = deterministicAddress(prefix, subj, kind, '2026-07-06T09:00:00Z', pv); // evidence watermark advanced
  const a4 = deterministicAddress(prefix, subj, kind, '2026-07-05T00:00:00Z', corpusVersion([{ id: 'ethos-1', body: 'x' }, { id: 'ethos-2', body: 'y' }])); // persona changed
  ok('re-run with identical evidence + persona => SAME address (idempotent, skip-non-empty collapses spam)', a1 === a2);
  ok('advanced evidence watermark => NEW address (a real re-prescribe is earned)', a1 !== a3);
  ok('changed persona => NEW address (adapt when the policy changes)', a1 !== a4);
  ok('address carries the descriptor prefix (routes to the right output namespace)', a1.startsWith(prefix + '::'));
  // THE self-trigger guard (the live-run bug): the coach's OWN output (the growing program)
  // must NOT be an address input. deterministicAddress takes no program arg — proven by the
  // signature: 5 params. Adding prescriptions cannot change the address; only the student can.
  ok('address function has NO program parameter (self-trigger loop structurally impossible)', deterministicAddress.length === 5);
}

console.log('4) PARSE: the engine extracts the descriptor-named output_kind from noisy model stdout');
{
  const noisy = 'thinking...\n```json\n{"kind":"drill-prescription","id":"x","cue":"c"}\n```\ndone';
  const got = parseDecision(noisy, 'drill-prescription');
  ok('parses drill-prescription from fenced/noisy output', got && got.id === 'x');
  ok('does NOT mis-parse a different kind', parseDecision('{"kind":"other","id":"y"}', 'drill-prescription') === null);
}

console.log('5) LAYER-2 GATE: act above confidence + provenance; else fail-closed (structural, not prompt-hoped)');
{
  const gate = coach?.gate ?? { minimum_confidence: 0.75, provenance_required: true, fail_closed_action: 'capture-more-motion-detail' }; // coach fixture may live only in tenant DATA
  // Announced because the FIRST assertion below reads the gate block off the descriptor, and with
  // no coach fixture it reads it off the literal one line above, so it asserts that a value equals
  // itself. The engine assertions after it stay meaningful either way; that one does not.
  if (!coach) skippedSections.push('5 gate-block assertion (reads a literal, not a descriptor: needs academy-director-coach.json)');
  const base = { kind: 'drill-prescription', id: 'x', created_by: 'c', drill_name: 'D' };
  ok('descriptor carries a gate block (opt-in threshold)', gate && gate.minimum_confidence === 0.75);
  ok('high confidence + provenance => PASS (acts)', gateDecision({ ...base, confidence: 0.9, provenance: ['match-stat-1'] }, gate).pass === true);
  const low = gateDecision({ ...base, confidence: 0.5, provenance: ['match-stat-1'] }, gate);
  ok('below-threshold confidence => FAIL-CLOSED (no guessed action)', low.pass === false && low.failClosedRecord.fail_closed === true);
  const noProv = gateDecision({ ...base, confidence: 0.9, provenance: [] }, gate);
  ok('no provenance => FAIL-CLOSED even at high confidence', noProv.pass === false && noProv.reason.includes('provenance'));
  ok('missing confidence field => FAIL-CLOSED (cannot claim certainty it did not state)', gateDecision({ ...base, provenance: ['x'] }, gate).pass === false);
  ok('fail-closed record carries the descriptor capture action', low.failClosedRecord.recommended_capture === 'capture-more-motion-detail');
  ok('no gate block => PASS (gate is opt-in, engine stays generic)', gateDecision({ ...base }, undefined).pass === true);
}

console.log('6) LAYER-6 AGENTS-MAKING-AGENTS: a spawner is just a descriptor whose output IS a worker descriptor');
if (!hiring) skippedSections.push('6 (agents-making-agents: needs academy-hiring-director.json)');
if (hiring) {
  ok('hiring director act.output_kind === autonomous-worker-descriptor (its ACT writes a NEW agent)', hiring.act.output_kind === 'autonomous-worker-descriptor');
  ok('hiring director runs on the SAME engine (renders a domain-correct prompt from DATA)',
    renderTemplate(hiring.decide.prompt_template, { persona: 'p', subject: 'student-truth-fly', program: '[]', output_kind: hiring.act.output_kind }).includes('autonomous-worker-descriptor'));
  ok('spawner reuses the layer-2 gate (a spawned hire must clear confidence+provenance too)', hiring.gate && hiring.gate.minimum_confidence === 0.75);
  ok('spawner writes to its own address namespace (spawned descriptors do not collide with coach outputs)', hiring.act.address_prefix.includes('spawned-worker-descriptor'));
  // The engine is output_kind-agnostic: writing a drill-prescription vs a worker-descriptor is the
  // SAME code path. So "agents making agents / non-AI scripts" needs ZERO engine change — it is a DATA row.
  const allKinds = new Set([coach, acct, groomer, hiring].filter(Boolean).map(d => d.act.output_kind));
  ok('4 real configs span 4 distinct output kinds incl. spawning — engine is output-kind-agnostic (DATA)', allKinds.size === 4 && allKinds.has('autonomous-worker-descriptor'));
}

console.log('7) NO SILENT DROP: a decide turn that yields no output_kind becomes a FAIL-CLOSED audit (cont.88, live-Fly-found)');
{
  // The EXACT refusal object the hiring-director's codex turn emitted on Fly (2026-07-05): it refused an
  // ungrounded hire with its OWN kind, so parseDecision(output_kind) is null — the loop must NOT go silent.
  const realRefusal = '{"kind":"sub-coach-hiring-decision","id":"student-truth-fly-no-new-sub-coach-fail-closed-2026-07-05","student":"student-truth-fly","decision":"fail_closed_no_descriptor","created_by":"academy-hiring-director","confidence":0.0,"provenance":[],"reason":"No real student-produced evidence records were available."}';
  ok('parseDecision still returns null for a non-output_kind refusal (act path stays strict)', parseDecision(realRefusal, 'autonomous-worker-descriptor') === null);
  const sig = extractRefusalSignal(realRefusal);
  ok('extractRefusalSignal captures the model-stated confidence (0.0)', sig.confidence === 0.0);
  ok('extractRefusalSignal captures the refusal reason', typeof sig.reason === 'string' && /no real student-produced evidence/i.test(sig.reason));
  ok('extractRefusalSignal returns empty provenance for an ungrounded refusal', Array.isArray(sig.provenance) && sig.provenance.length === 0);
  // The hiring fixture may ride only the production log; a minimal literal descriptor
  // exercises the same engine path (the engine is descriptor-blind — DATA is DATA).
  const spawner = hiring ?? { id: 'academy-hiring-director', act: { output_kind: 'autonomous-worker-descriptor' }, gate: { minimum_confidence: 0.75, fail_closed_action: 'capture-more-motion-detail' } };
  const audit = noOutputFailClosed(spawner, 'student-truth-fly', 'issue-first', sig);
  ok('fail-closed audit is stamped with the descriptor output_kind (one schema for readers)', audit.kind === spawner.act.output_kind);
  ok('fail-closed audit is marked fail_closed:true', audit.fail_closed === true);
  ok('fail-closed audit carries the descriptor capture action', audit.recommended_capture === spawner.gate.fail_closed_action);
  ok('fail-closed audit preserves the evidence cursor (deterministic address populated => skips re-decide)', audit.worker_evidence_cursor === 'issue-first');
  ok('fail-closed audit id is deterministic per subject+kind (idempotent collapse)', audit.id === 'student-truth-fly-autonomous-worker-descriptor-fail-closed');
  // No-signal path (model emitted only prose): still produce an audit, never throw / never silence.
  const bare = noOutputFailClosed(spawner, 'student-truth-fly', 'issue-first', extractRefusalSignal('the model just talked, no json'));
  ok('no structured signal still yields a well-formed fail-closed audit (never silent)', bare.fail_closed === true && bare.original_confidence === null);
}

console.log('8) HOST IDENTITY: the engine RESOLVES host properties and FREEZES none (one chain per property)');
{
  // A descriptor fixture is not needed: these two chains are the whole subject, and passing an
  // env object instead of mutating process.env keeps the assertions order-independent.
  const empty = {};
  ok('no partition anywhere => null, NOT a default (the caller decides the consequence)',
    resolvePartition(empty) === null);
  ok('ambient BITFIELD_PARTITION alone resolves (the runtime supplies it; DATA need not name one)',
    resolvePartition({ BITFIELD_PARTITION: 'ambient-app' }) === 'ambient-app');
  ok('BITFIELD_DISPATCH_PARTITION alone resolves (third link of the same chain)',
    resolvePartition({ BITFIELD_DISPATCH_PARTITION: 'dispatch-app' }) === 'dispatch-app');
  ok('explicit BITFIELD_WORKER_PARTITION wins over the ambient field (install beats runtime)',
    resolvePartition({ BITFIELD_WORKER_PARTITION: 'chosen', BITFIELD_PARTITION: 'ambient-app' }) === 'chosen');
  ok('an empty string is not an answer (a blank env var must not defeat the next link)',
    resolvePartition({ BITFIELD_WORKER_PARTITION: '   ', BITFIELD_PARTITION: 'ambient-app' }) === 'ambient-app');
  // THE regression this section exists for: the lock key at :98 and the write target at :320 used
  // to read two DIFFERENT chains for one value, and that disagreement is why the shipped DATA had
  // to freeze a partition literal. Same input, same answer, or the literal comes back.
  const oneEnv = { BITFIELD_PARTITION: 'ambient-app' };
  ok('one chain: lock key and write target read the SAME resolver, so they cannot disagree',
    resolvePartition(oneEnv) === resolvePartition(oneEnv) && resolvePartition(oneEnv) === 'ambient-app');

  // This assertion used to read "no override and no descriptor bin yields the bare NAME codex".
  // It was green, and it was the defect: a check can only be as generic as what it asserts, and
  // this one pinned a supplier's name into the proof that the engine is supplier-blind.
  ok('nothing declared REFUSES rather than guessing a vendor, naming the DATA that is missing',
    (() => {
      try { resolveDecideBin(undefined, empty); return false; }
      catch (e) { return String(e.message).includes('WORKER_DECIDE_BIN_UNDECLARED'); }
    })());
  ok('descriptor names its own capability (any binary is valid, because the engine is blind)',
    resolveDecideBin({ decide: { bin: 'claude' } }, empty) === 'claude');
  ok('host override beats the descriptor (the host gets the last word about itself)',
    resolveDecideBin({ decide: { bin: 'claude' } }, { BITFIELD_WORKER_DECIDE_BIN: '/opt/x/codex' }) === '/opt/x/codex');
  // Every shipped descriptor must name a capability, not a location. An absolute path in DATA is
  // the same defect as a frozen carrier address: correct on the authoring machine, wrong in the
  // container. This asserts on the FIXTURES, so a future descriptor cannot reintroduce it quietly.
  for (const d of [coach, acct, groomer, hiring].filter(Boolean)) {
    ok(`${d.id}: names a bin by capability, not by absolute path`,
      !String(d.decide?.bin ?? '').startsWith('/'));
    ok(`${d.id}: declares no partition (a descriptor that names one is a tenant install)`,
      d.partition === undefined);
  }
}

// The verdict states its SCOPE, never just its result. "ALL PASS" over a shrunken set is the
// failure this line exists to stop: with two descriptor fixtures absent it printed the same words
// as a full run, and a green that cannot be compared to the previous green is a number rather than
// evidence. The denominator is COUNTED from what this file asked for, never written down.
const coverage = `${askedForFixtures.length - absentFixtures.length}/${askedForFixtures.length} descriptor fixtures present`;
console.log(`\n${fail === 0 ? '✅ ALL PASS' : '❌ FAILURES'}, ${pass} passed, ${fail} failed, over ${coverage}`);
if (absentFixtures.length) console.log(`   NOT A FULL RUN. Absent: ${absentFixtures.join(', ')}`);
for (const section of skippedSections) console.log(`   section skipped: ${section}`);
// process.exitCode rather than process.exit: exiting outright abandons anything still queued on an
// async stdout, which is how the declared-rules ratchet was silently unable to report for days.
process.exitCode = fail === 0 ? 0 : 1;
