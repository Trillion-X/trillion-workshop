#!/usr/bin/env node
/**
 * autonomous-worker.mjs — the ONE blind, descriptor-driven autonomous worker (L069 primitive).
 *
 * This engine hardcodes NOTHING about any domain. It runs a generic
 *   sense -> guard -> decide -> act -> verify
 * loop whose every domain value (subjects, what to sense, the decide capability, the
 * output kind + address) is read from a `autonomous-worker-descriptor` DATA record.
 * Coach / business-operator / accountant / an agent that spawns agents / a NON-AI
 * script worker are all just DIFFERENT descriptor rows — ZERO code change per worker.
 * Deletion test: delete the tennis descriptor and this engine still runs an accountant
 * descriptor unchanged. (Supersedes the bespoke, tennis-coded coach-loop.mjs — L030.)
 *
 * Composition (no god package): SENSE = slot::find-current-items; DECIDE = the
 * descriptor-named capability binary, with NO default of any kind: the provider, its
 * command grammar and its model are DATA, and an undeclared one refuses instead of
 * guessing (a non-AI worker names python3 or any binary); ACT = write-batch.
 *
 * STRUCTURAL ANTI-SPAM (Codex L063): the output ADDRESS is deterministic —
 *   address = <prefix>::hash(subject + output_kind + evidence_cursor + persona_version + program_version)
 * so re-runs / retries / restarts / LLM wording-variance all COLLAPSE to the SAME
 * address; skip-non-empty is then natural idempotency. A new write is earned ONLY when
 * the evidence watermark (or persona/program) actually advances. The address IS the
 * guard — there is no "decide whether to write" branch.
 *
 * Descriptor source (DATA): BITFIELD_WORKER_DESCRIPTOR_FILE (a local JSON, for bootstrap)
 * OR BITFIELD_WORKER_DESCRIPTOR_ID (fetched live from the log as an
 * `autonomous-worker-descriptor` published-record). Env overrides on the descriptor:
 * BITFIELD_TARGET_CARRIER_URL (or BITFIELD_TARGET_CARRIER_URL_FILE, the path the
 * runtime publishes its own address into — required for a worker that outlives a
 * runtime restart), BITFIELD_WORKER_PARTITION, BITFIELD_WORKER_SUBJECTS,
 * BITFIELD_WORKER_INTERVAL_SECONDS, BITFIELD_WORKER_DECIDE_BIN.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function nonEmptyEnv(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text || null;
}

/** Resolve the runtime address at the moment of use, never at import.
 *
 *  A worker outlives many runtime restarts, and a runtime that picks its port
 *  at startup has an address that changes on every one of them. A module-level
 *  const captures the address of the runtime that happened to be up when this
 *  process started; after the next restart it points at a dead port or, worse,
 *  at whatever else has since claimed it. So the long-lived thing holds the one
 *  value that does not change — the PATH the runtime publishes its address into
 *  — and reads through it per use. The path is DATA, exactly like the URL is;
 *  nothing is scanned, guessed, or discovered.
 *
 *  Second configuration of the resident-emitter address primitive, now owned by
 *  notice-when-something-shows-up (2026-09-02). */
export function currentAddressFromFile(env, options = {}) {
  const addressFile = nonEmptyEnv(env.BITFIELD_TARGET_CARRIER_URL_FILE);
  if (!addressFile) return null;
  const readFile = options.readFileSync ?? readFileSync;
  try {
    return nonEmptyEnv(readFile(addressFile, 'utf8'));
  } catch {
    // The runtime is not up, or has not published yet. Not an error.
    return null;
  }
}

/** Precedence: an explicit address wins, then the published address file, then
 *  the runtime-owned fallback. There is no hardcoded port: a guessed port is
 *  the same defect as a frozen one, and talking to a stranger on 8081 is worse
 *  than not talking at all. */
export function resolveCarrier(env = process.env, options = {}) {
  return nonEmptyEnv(env.BITFIELD_TARGET_CARRIER_URL)
    || currentAddressFromFile(env, options)
    || nonEmptyEnv(env.BITFIELD_SHELL_PUBLISHED_HTTP_ADDRESS);
}

/** Which partition this worker reads and writes, resolved the same way everywhere.
 *
 *  This file used to answer that question in three places with three different chains: the
 *  singleton lock key, the write target, and the descriptor. They disagreed, and the disagreement
 *  is WHY the shipped DATA had to freeze a literal. The write target refused to consult the
 *  ambient runtime field the lock key was already reading, so the only way to satisfy it was to
 *  name a partition in the record. One chain, and the literal becomes deletable DATA.
 *
 *  Returns null rather than a default, because the two callers need OPPOSITE failure behaviour and
 *  that is the only real difference between them: a lock key may fall back to a shared bucket and
 *  still be correct, while a write target that guesses writes a customer's rows into a partition
 *  nobody chose. Deciding that at the edge keeps the chain itself honest.
 *
 *  `d.partition` is deliberately absent. A descriptor that names a partition is a tenant install
 *  wearing an example's clothes; the installer supplies it. */
export function resolvePartition(env = process.env) {
  return nonEmptyEnv(env.BITFIELD_WORKER_PARTITION)
    || nonEmptyEnv(env.BITFIELD_PARTITION)
    || nonEmptyEnv(env.BITFIELD_DISPATCH_PARTITION);
}

/** Which binary answers the DECIDE turn: host override, then the descriptor. There is no third
 *  link, and removing it is the point of this function.
 *
 *  Whatever is resolved is a NAME and never a PATH. Where a binary lives is a property of the host,
 *  and this engine is a guest. `/usr/local/bin/codex` was correct on exactly one machine and wrong
 *  in the container this worker actually runs in, which is a frozen host identity wearing different
 *  clothes from a frozen carrier address. A bare name resolves through PATH, which is the host
 *  answering the question about itself.
 *
 *  THE VENDOR DEFAULT IS GONE, and the path fix above is why it survived as long as it did. Once
 *  the hardcoded PATH became a bare name, the line looked generic: no absolute path, no host
 *  identity, just a word. But `|| 'codex'` still froze ONE vendor into an engine whose entire job
 *  is to be blind to which one. The consequence is not theoretical and not a style point. When that
 *  vendor's usage runs out, every worker that never declared a decider silently runs a binary that
 *  cannot answer, and a generic engine is taken down by a fact about one supplier's billing.
 *
 *  So this fails closed, exactly like the partition does, and the earlier asymmetry argument does
 *  not survive contact with an exhausted account. That argument said a wrong binary cannot be
 *  reached silently because PATH throws ENOENT with the name in the message. True, and irrelevant
 *  here: the failure being described is a binary that EXISTS and runs and returns a refusal, which
 *  is the quietest failure in the set. Undeclared is a declaration defect, and the honest answer is
 *  to say which DATA is missing rather than to guess a supplier on the operator's behalf. */
export function resolveDecideBin(d, env = process.env) {
  const declared = nonEmptyEnv(env.BITFIELD_WORKER_DECIDE_BIN) || nonEmptyEnv(d?.decide?.bin);
  if (!declared) {
    throw new Error(
      'WORKER_DECIDE_BIN_UNDECLARED: no decider is declared for this worker. Set `decide.bin` in the '
      + 'worker descriptor, or BITFIELD_WORKER_DECIDE_BIN in the environment. This engine does not '
      + 'name a vendor, because one whose usage has run out is indistinguishable from one that works '
      + 'until it answers.',
    );
  }
  return declared;
}

/** Resolved once per sweep, never at import and never per call.
 *
 *  Reading the address file on every fetch puts a syscall in front of every HTTP
 *  call, and `target()` makes two of them (its own plus `basis()`), so a sweep of
 *  N subjects paid 2N reads for a value that can only change when the runtime
 *  restarts. A sweep is short, so refreshing at its start is the smallest
 *  interval that still cannot go stale across a restart. If the runtime moves
 *  mid-sweep the remaining calls fail and the next sweep picks up the new
 *  address, which is the same convergence the clock ticker uses. */
let sweepCarrier = null;

function refreshCarrierForThisSweep() {
  sweepCarrier = resolveCarrier();
}

function carrierOrThrow() {
  const url = sweepCarrier ?? resolveCarrier();
  if (!url) {
    throw new Error(
      'RUNTIME_ADDRESS_UNAVAILABLE: set BITFIELD_TARGET_CARRIER_URL, or '
      + 'BITFIELD_TARGET_CARRIER_URL_FILE to the path the runtime publishes its address into',
    );
  }
  return url;
}

// Singleton lock (L127 guard; second configuration of the resident-emitter liveness-lock
// primitive — plan 2026-08-01-worker-singleton-lock-engine-descriptor-scope).
// Production incident 2026-08-01: the runner spawned TWO workers per descriptor;
// each pair burned duplicate decide-turns. Invariant scope = ONE worker per
// (engine, descriptor); different descriptors legitimately run concurrently.
// cwd is useless for coordination (process-engine mounts every spawn in a fresh
// /tmp cwd), so: machine-wide os.tmpdir() keyed by engine identity + descriptor id.
// /tmp wipe on restart is safe — processes die with the machine.
// A lock key MAY fall back: two workers sharing a bucket still exclude each other correctly, which
// is the whole job. The write target below may not, and that is the only difference between them.
const ENGINE_IDENTITY = String(
  resolvePartition() || nonEmptyEnv(process.env.PORT) || 'default',
);
// The lock's uniqueness has to come from WHAT IT LOCKS, not from a prefix. The old name
// leaned on a product-name prefix to stay clear of other software in a shared temporary
// directory, because the rest of it could be as generic as `default-some-id` and collide
// with anything. Hashing the pair the lock actually protects gives it a real identity, at
// which point a name in front of it adds nothing.
export function workerLockKey(engineIdentity, descriptorId) {
  return createHash('sha256')
    .update(String(engineIdentity ?? 'default'))
    .update('\0')
    .update(String(descriptorId ?? 'default'))
    .digest('hex')
    .slice(0, 24);
}
function workerLockFile(descriptorId) {
  return path.join(os.tmpdir(), `worker-lock-${workerLockKey(ENGINE_IDENTITY, descriptorId)}.lock`);
}

/** PURE (exported for self-test): yield ONLY to a holder that is BOTH a running PID
 *  (not us) AND heartbeat-fresh. A dead PID or stale heartbeat means take over. */
export function heldLockIsLive(held, { nowMs, selfPid, staleMs, isPidAlive }) {
  if (!held || typeof held !== 'object') return false;
  const fresh = typeof held.heartbeat_ms === 'number' && nowMs - held.heartbeat_ms < staleMs;
  const alive = typeof held.pid === 'number' && held.pid !== selfPid && isPidAlive(held.pid);
  return Boolean(alive && fresh);
}

function isPidAlive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }

function stampWorkerLock(lockFile) {
  try { writeFileSync(lockFile, JSON.stringify({ pid: process.pid, heartbeat_ms: Date.now() })); } catch {}
}

/** Two-phase acquire (closes the exists→read→write TOCTOU): exclusive wx create;
 *  on EEXIST judge the holder and yield or take over by overwrite. Fail-OPEN on
 *  other lock errors — the worker is required substrate; never wedge it shut. */
function acquireWorkerLock(lockFile, staleMs) {
  try {
    writeFileSync(lockFile, JSON.stringify({ pid: process.pid, heartbeat_ms: Date.now() }), { flag: 'wx' });
    return true;
  } catch (e) {
    if (e?.code !== 'EEXIST') { console.error('autonomous-worker: lock create failed (continuing unguarded):', e?.message ?? e); return true; }
  }
  try {
    const held = JSON.parse(readFileSync(lockFile, 'utf8'));
    if (heldLockIsLive(held, { nowMs: Date.now(), selfPid: process.pid, staleMs, isPidAlive })) {
      console.log(`autonomous-worker: a running worker (pid=${held.pid}) already owns this descriptor on this engine — exiting (singleton).`);
      return false;
    }
    console.log(`autonomous-worker: taking over stale/dead lock (prior pid=${held.pid}).`);
  } catch { console.log('autonomous-worker: unreadable lock file — taking over.'); }
  stampWorkerLock(lockFile);
  return true;
}

// ---- transport (proven verbatim from the in-Fly loop) ----------------------
async function basis() { const j = await (await fetch(carrierOrThrow() + '/boot', { headers: { 'Cache-Control': 'no-cache' } })).json(); return j[0].running_command_list_basis; }
async function target(t, body) {
  const r = await fetch(carrierOrThrow() + '/target/' + encodeURIComponent(t), { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Bitfield-Running-Command-List-Basis': await basis() }, body: JSON.stringify(body) });
  const txt = await r.text(); let j = null; try { j = JSON.parse(txt); } catch {} return { status: r.status, txt, j };
}
async function find(kind) { const { j } = await target('slot::find-current-items', { operation: 'find-current-items', in: 'published-record', where: { all: [{ field: 'kind', in: [kind] }] }, include: ['address', 'payload'] }); const a = Array.isArray(j) ? j : (j?.items || j?.results || []); return a; }
async function readCur(partition, addr) { const { j } = await target('engine.operation.label-addressed', { operation_label: 'engine.operation.read-current', partition_label: partition, address_label: addr, address_mode: 'identity_text' }); return j; }

// ---- pure, testable helpers (no I/O — exported for the self-test) -----------
export const shortHash = (s) => createHash('sha256').update(String(s)).digest('hex').slice(0, 16);
export function renderTemplate(tpl, vars) { return String(tpl).replace(/\{\{(\w+)\}\}/g, (_, k) => (k in vars ? String(vars[k]) : `{{${k}}}`)); }
/**
 * Codex's structural anti-spam address — same inputs => same address => skip-non-empty.
 * CRITICAL: the address depends ONLY on inputs the worker does NOT itself produce —
 * the SUBJECT's evidence watermark + the persona/policy version. It must NEVER depend on
 * the worker's own output corpus (the program), or every write would change the address
 * and re-trigger forever (the self-trigger loop Codex flagged). A new write is earned
 * ONLY when the student produces new evidence, or the coaching policy changes.
 */
export function deterministicAddress(prefix, subject, outputKind, evidenceCursor, personaVersion) {
  return `${prefix}::${shortHash([subject, outputKind, evidenceCursor, personaVersion].join('|'))}`;
}
/** Version stamp of a sensed corpus — advances only when the sensed content changes. */
export function corpusVersion(rows) { return shortHash(JSON.stringify(rows)); }
/**
 * Layer-2 structural gate: ACT only when the decision clears the descriptor's confidence +
 * provenance threshold; otherwise return a FAIL-CLOSED record (never a guessed action).
 * This makes "act above threshold, gather when unsure" a STRUCTURAL property of the engine,
 * not something the prompt is merely asked to honor. No `gate` block => pass (opt-in).
 */
export function gateDecision(decision, gate) {
  if (!gate) return { pass: true };
  const conf = typeof decision.confidence === 'number' ? decision.confidence : null;
  const prov = Array.isArray(decision.provenance) ? decision.provenance.filter(Boolean) : [];
  const minConf = typeof gate.minimum_confidence === 'number' ? gate.minimum_confidence : 0;
  const needProv = gate.provenance_required !== false;
  const belowConf = conf === null || conf < minConf;
  const missingProv = needProv && prov.length === 0;
  if (!belowConf && !missingProv) return { pass: true };
  const reason = [belowConf ? `confidence ${conf} < ${minConf}` : null, missingProv ? 'no provenance' : null].filter(Boolean).join('; ');
  return {
    pass: false,
    reason,
    failClosedRecord: {
      kind: decision.kind,
      id: `${decision.id || 'decision'}-fail-closed`,
      created_by: decision.created_by,
      created_at: decision.created_at,
      produced_by: decision.produced_by,
      worker_evidence_cursor: decision.worker_evidence_cursor,
      fail_closed: true,
      gate_reason: reason,
      recommended_capture: gate.fail_closed_action || 'capture-more-evidence',
      original_confidence: conf,
      original_provenance: prov,
    },
  };
}
/** Extract the first JSON object whose kind === outputKind from raw model stdout. */
export function parseDecision(out, outputKind) {
  for (const m of [...String(out).matchAll(/\{[\s\S]*?\}(?=\s*$|\s*\{)/g)]) { try { const o = JSON.parse(m[0]); if (o.kind === outputKind) return o; } catch {} }
  for (const m of [...String(out).matchAll(/\{[\s\S]*\}/g)]) { try { const o = JSON.parse(m[0]); if (o.kind === outputKind) return o; } catch {} }
  const anchor = `"kind":"${outputKind}"`; const i = String(out).lastIndexOf(anchor);
  if (i >= 0) { const s = String(out).slice(String(out).lastIndexOf('{', i)); try { return JSON.parse(s.slice(0, s.lastIndexOf('}') + 1)); } catch {} }
  return null;
}
/**
 * Best-effort extraction of a DECIDE outcome SIGNAL when the model refused to emit the
 * output_kind (e.g. it emitted its own `{...,"decision":"fail_closed_...","confidence":0.0}`
 * refusal object). This lets a refusal become an observable FAIL-CLOSED AUDIT record rather
 * than a silent drop. Live-Fly-discovered (cont.88): the hiring-director refused an ungrounded
 * hire by emitting a `sub-coach-hiring-decision` kind, so parseDecision(output_kind) returned
 * null and the loop wrote NOTHING — losing the audit trail AND defeating deterministic-address
 * skip (every unchanged tick would re-run the expensive decide forever). Returns
 * {confidence, provenance, reason} (all null/empty when no structured signal is present).
 */
export function extractRefusalSignal(out) {
  let best = null;
  const consider = (o) => { if (o && (typeof o.confidence === 'number' || o.fail_closed === true || /fail[_-]?closed/i.test(String(o.decision || '')))) best = o; };
  for (const m of [...String(out).matchAll(/\{[\s\S]*?\}(?=\s*$|\s*\{|\s*\n)/g)]) { try { consider(JSON.parse(m[0])); } catch {} }
  if (!best) { for (const m of [...String(out).matchAll(/\{[\s\S]*\}/g)]) { try { consider(JSON.parse(m[0])); } catch {} } }
  if (!best) return { confidence: null, provenance: [], reason: null };
  return {
    confidence: typeof best.confidence === 'number' ? best.confidence : null,
    provenance: Array.isArray(best.provenance) ? best.provenance.filter(Boolean) : [],
    reason: best.reason || best.decision || null,
  };
}
/**
 * Build the FAIL-CLOSED AUDIT record for a decide turn that produced no actionable output_kind.
 * Pure + exported for the self-test. Mirrors gateDecision's fail-closed shape so downstream
 * readers see ONE fail-closed schema regardless of whether the block came from a sub-threshold
 * output_kind (gateDecision) or a model refusal of a different kind (this).
 */
export function noOutputFailClosed(d, subject, evidenceCursor, signal) {
  const s = signal || { confidence: null, provenance: [], reason: null };
  return {
    kind: d.act.output_kind,
    id: `${subject}-${d.act.output_kind}-fail-closed`,
    created_by: d.act.created_by,
    created_at: new Date().toISOString(),
    produced_by: `autonomous-worker:${d.id}`,
    worker_evidence_cursor: evidenceCursor,
    fail_closed: true,
    gate_reason: `decide produced no actionable ${d.act.output_kind}` + (s.reason ? `: ${s.reason}` : ''),
    recommended_capture: (d.gate && d.gate.fail_closed_action) || 'capture-more-evidence',
    original_confidence: s.confidence,
    original_provenance: s.provenance,
  };
}

// ---- descriptor load (DATA: file for bootstrap, or live from the log) --------
async function loadDescriptor() {
  const file = process.env.BITFIELD_WORKER_DESCRIPTOR_FILE;
  if (file) return JSON.parse(readFileSync(file, 'utf8'));
  const id = process.env.BITFIELD_WORKER_DESCRIPTOR_ID;
  if (!id) throw new Error('no descriptor: set BITFIELD_WORKER_DESCRIPTOR_FILE or BITFIELD_WORKER_DESCRIPTOR_ID');
  const rows = await find('autonomous-worker-descriptor');
  const row = rows.map(r => r.payload || {}).find(p => p.id === id);
  if (!row) throw new Error(`descriptor ${id} not found on log`);
  return row;
}

// ---- the ONE blind loop ------------------------------------------------------
async function tickSubject(d, subject) {
  // Fail closed. This value selects which customer's rows get written, and an unresolved partition
  // silently finds nothing on read and lands the write somewhere nobody chose, with no error to see.
  const partition = resolvePartition();
  if (!partition) {
    throw new Error(
      'PARTITION_UNAVAILABLE: set BITFIELD_WORKER_PARTITION, or let the runtime supply '
      + 'BITFIELD_PARTITION. A worker that guesses its partition writes into the wrong app.',
    );
  }
  // SENSE — persona + program, entirely per the descriptor.
  const personaRows = (await find(d.sense.persona.kind))
    .filter(x => !d.sense.persona.id_includes || String(x.payload?.id || '').includes(d.sense.persona.id_includes))
    .map(x => ({ id: x.payload.id, body: x.payload.body ?? x.payload.text ?? '' }));
  const programRows = (await find(d.sense.program.kind)).map(x => x.payload)
    .filter(p => { const f = d.sense.program.subject_field; return !f || !p[f] || p[f] === subject; });
  if (d.sense.persona.required !== false && !personaRows.length) { console.log(`[${subject}] no persona on log; skip`); return; }

  // GUARD — evidence watermark (state-change cadence, gated BEFORE the expensive decide).
  // The watermark is the SUBJECT's own evidence only — never the worker's output program.
  const evidenceCursor = await latestEvidenceCursor(d, subject);
  // DETERMINISTIC ADDRESS (structural anti-spam): subject + output_kind + evidence watermark
  // + persona/policy version. Deliberately EXCLUDES the program (coach's own output) so
  // re-runs collapse and a write is earned only when the student's evidence advances.
  const personaVersion = corpusVersion(personaRows);
  const addr = deterministicAddress(d.act.address_prefix, subject, d.act.output_kind, evidenceCursor, personaVersion);
  const exist = await readCur(partition, addr);
  if (exist && exist.found) { console.log(`[${subject}] address ${addr.slice(-16)} already written (evidence/persona/program unchanged) — skip, no decide`); return; }

  // DECIDE, the descriptor-named capability. Any binary is valid.
  const bin = resolveDecideBin(d);
  const prompt = renderTemplate(d.decide.prompt_template, {
    persona: personaRows.map(p => `[${p.id}]\n${p.body}`).join('\n\n'),
    subject,
    program: JSON.stringify(programRows.map(p => ({ id: p.id, ...pick(p, d.sense.program.summary_fields) }))),
    output_kind: d.act.output_kind,
  });
  // No argv default and no model default. Both used to exist and both were ONE vendor's grammar
  // (`exec --skip-git-repo-check -m ... --`) and ONE vendor's model name, which is a worse freeze
  // than the binary name was: a descriptor could name a different decider and still be handed
  // arguments only the original supplier understands, so the engine kept speaking one vendor while
  // looking configurable. A descriptor that names a capability must also say how to call it.
  if (!Array.isArray(d.decide.argv_template) || d.decide.argv_template.length === 0) {
    throw new Error(
      `WORKER_DECIDE_ARGV_UNDECLARED: worker ${d.id} names a decider but not how to invoke it. `
      + 'Declare `decide.argv_template`. This engine holds no vendor\'s command grammar.',
    );
  }
  if (d.decide.argv_template.some(a => String(a).includes('{{model}}')) && !nonEmptyEnv(d.decide.model)) {
    throw new Error(
      `WORKER_DECIDE_MODEL_UNDECLARED: worker ${d.id} interpolates {{model}} but declares none. `
      + 'Declare `decide.model`. A guessed model name is a guess about someone else\'s catalogue.',
    );
  }
  const argv = d.decide.argv_template.map(a => renderTemplate(a, { model: d.decide.model, prompt }));

  // A non-zero exit is NOT automatically a failure, and it is not automatically an answer either.
  // This used to swallow every error and take whatever sat on stdout, justified by one vendor
  // exiting non-zero on an unrelated MCP warning with a valid answer still on stdout. That is real,
  // but the blanket catch turned the loudest failure mode into the quietest one: when a decider is
  // out of quota or unauthenticated it also exits non-zero, and its stdout is empty or an error
  // blob, so the worker treated "the supplier refused to serve me" as a decision it could parse.
  // The vendor-blind form of the same allowance: output present means answer, output absent means
  // the failure is real and must surface with the decider's own words attached.
  let out = '';
  try {
    out = execFileSync(bin, argv, { encoding: 'utf8', timeout: (d.decide.timeout_seconds || 280) * 1000, maxBuffer: 20 * 1024 * 1024, input: d.decide.prompt_via === 'stdin' ? prompt : undefined, env: process.env });
  } catch (e) {
    out = String(e.stdout || '');
    if (!out.trim()) {
      throw new Error(
        `WORKER_DECIDE_PRODUCED_NOTHING: \`${bin}\` exited without usable output, so this is the `
        + 'decider failing rather than warning. Its own message follows, because a worker that '
        + `guesses here is how an exhausted account looks identical to a considered refusal.\n${String(e.stderr || e.message || '').trim()}`,
      );
    }
  }

  const decision = parseDecision(out, d.act.output_kind);
  let payload, gatePass;
  if (decision) {
    if (!decision.created_at) decision.created_at = new Date().toISOString();
    decision.created_by = d.act.created_by; decision.produced_by = `autonomous-worker:${d.id}`; decision.worker_evidence_cursor = evidenceCursor;
    // GATE (layer 2) — structural confidence/provenance threshold; act above it, fail-closed below.
    const gated = gateDecision(decision, d.gate);
    payload = gated.pass ? decision : gated.failClosedRecord;
    gatePass = gated.pass;
    if (!gated.pass) console.log(`[${subject}] GATE fail-closed (${gated.reason}) — writing a capture-request, not a guessed action`);
  } else {
    // NEVER drop silently after spending a decide turn (cont.88, live-Fly-discovered). The model
    // refused to emit an actionable ${output_kind} (e.g. it returned its own refusal object). Turn
    // that into an observable FAIL-CLOSED AUDIT record — so the outcome is on-log AND the
    // deterministic address is populated (unchanged next tick skips the expensive re-decide).
    // Opt-out only when there is NO gate (a gate-less worker keeps the old strict-or-nothing shape).
    if (!d.gate) { console.log(`[${subject}] DECIDE produced no ${d.act.output_kind} (no gate; nothing written)`); return; }
    payload = noOutputFailClosed(d, subject, evidenceCursor, extractRefusalSignal(out));
    gatePass = false;
    console.log(`[${subject}] DECIDE produced no ${d.act.output_kind} — writing FAIL-CLOSED audit (${payload.gate_reason})`);
  }

  // ACT — write the gated payload to the DETERMINISTIC address (additive, skip-non-empty checked, readback).
  const w = await target('engine.operation.label-addressed', { operation_label: 'engine.operation.write-batch', writes: [{ partition_label: partition, address_label: addr, address_mode: 'identity_text', path_labels: ['current-item', 'published-record'], payload }] });
  const back = await readCur(partition, addr);
  console.log(`[${subject}] ACT ${w.status} -> ${addr.slice(-16)} gate=${gatePass ? 'pass' : 'fail-closed'} verified=${!!(back && back.found)}`);
}

function pick(o, fields) { if (!fields || !fields.length) return o; const r = {}; for (const f of fields) if (f in o) r[f] = o[f]; return r; }

/** Latest evidence watermark for a subject: max timestamp across the descriptor's evidence
 *  kinds (SUBJECT-produced records only). 'issue-first' when the subject has produced no
 *  evidence yet — a constant, so repeated no-evidence runs collapse to the SAME address
 *  (issue once, then wait for the student to do the work). The worker's own output program
 *  is deliberately NOT consulted here — that would let the coach's writes advance its own
 *  watermark and re-trigger forever. */
async function latestEvidenceCursor(d, subject) {
  let cursor = '';
  for (const k of (d.guard?.evidence_kinds || [])) {
    let recs = []; try { recs = await find(k); } catch { continue; }
    for (const r of recs) { const p = r.payload || {}; const sf = d.guard?.subject_field || 'student'; if (p[sf] && p[sf] !== subject) continue; const t = p.created_at || p.captured_at || p.started_at || p.timestamp || ''; if (t && String(t) > cursor) cursor = String(t); }
  }
  return cursor || 'issue-first';
}

async function main() {
  const d = await loadDescriptor();
  const subjects = (process.env.BITFIELD_WORKER_SUBJECTS || (d.subjects || []).join(',')).split(',').map(s => s.trim()).filter(Boolean);
  // The DECLARED cadence, which this process no longer acts on. Its one remaining job is to size
  // the stale-lock floor: a crash must not lock the descriptor out for longer than the cadence the
  // installer chose. The installer's clock trigger is what actually decides when this runs.
  const cadenceSeconds = parseInt(process.env.BITFIELD_WORKER_INTERVAL_SECONDS || String(d.interval_seconds || 3600), 10);
  // Singleton gate: key by the RESOLVED descriptor id (not the env filename — two
  // filenames aliasing one id must still collapse to one worker). Duplicates exit 0.
  // Stale floor MUST exceed one decide turn (Codex convergence finding: a 280s
  // synchronous decide outlives a 180s lease → a live worker mid-decide would be
  // stolen from). Heartbeat is stamped per-SUBJECT so the gap between stamps is
  // bounded by ONE decide turn, and the floor covers that turn plus margin.
  const lockFile = workerLockFile(d.id);
  const decideTimeoutS = (d.decide?.timeout_seconds || 280);
  const staleMs = Math.max(cadenceSeconds * 3, decideTimeoutS + 180, 180) * 1000;
  if (!acquireWorkerLock(lockFile, staleMs)) return;
  console.log(`autonomous-worker sweep: descriptor=${d.id} carrier=${resolveCarrier() ?? '(waiting for runtime)'} subjects=${subjects.join(',')} declared-cadence=${cadenceSeconds}s (owned by the installer clock trigger, not by this process)`);
  // ONE sweep, then exit. WHEN this runs again is not this process's question.
  //
  // This used to end by re-arming itself on a timer every `interval` seconds, which made the engine
  // a second owner of scheduling: the descriptor's `interval_seconds` competed with the installer's
  // own clock trigger, and a cadence change meant restarting a year-long process instead of editing
  // DATA. A hand-rolled poll loop is also the exact shape L136 refuses, for the reason visible here:
  // the loop could not be observed, retried, rate-limited or stopped by anything that owns those
  // concerns, because it was not addressable from outside this process.
  //
  // The replacement already existed and did not need inventing. The clock waiter in
  // `notice-when-something-shows-up` emits `clock::tick`,
  // a trigger-rule matches it, and the installing DATA dispatches this same start action once per
  // tick. `interval_seconds` stays DATA and keeps its ONE remaining job below: sizing the stale-lock
  // floor, so a crashed sweep cannot block the next tick for longer than the cadence warrants.
  //
  // The singleton lock is what makes per-tick invocation safe, and it already asserted this: a tick
  // arriving while a sweep runs sees a live pid and exits 0, while a tick after a crash sees a dead
  // pid and takes over immediately. That is `heldLockIsLive`, unchanged, tested in section 0.
  refreshCarrierForThisSweep();
  for (const s of subjects) {
    stampWorkerLock(lockFile);
    try { await tickSubject(d, s); } catch (e) { console.log(`[${s}] error: ${e.message}`); }
  }
}

// Run only when invoked directly (not when imported by the self-test).
if (import.meta.url === `file://${process.argv[1]}`) { main().catch(e => { console.error(e); process.exit(1); }); }
