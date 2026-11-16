// spawn-check.mjs — the GENERIC AGENT-LIFECYCLE enact step (L069/L090: one primitive, N configs via env DATA).
// An operator's model turn DECIDES (emits ONE directive line); this blind node step GUARDS + ENACTS via
// write-batch (L093 owners: ai-agent-profile + ai-instruction-blocks). Parses the output for ONE of:
//   SPAWN_<VERB>:  {agent_id,name,directive}   -> mint a sub-agent (guarded by an ai-action-guard cap)
//   ADAPT_<VERB>:  {agent_id,directive}         -> rewrite an existing autospawned sub-agent's directive
//   RETIRE_<VERB>: {agent_id}                   -> retract an autospawned sub-agent (profile + block)
// Config via env (coach defaults keep the live coach UNCHANGED): BITFIELD_LIFECYCLE_VERB (COACH),
// BITFIELD_SPAWN_CAP_KEY (coach-spawn), BITFIELD_LIFECYCLE_PARENT (ai-agent-profile:academy-director).
// Config A (coach): VERB=COACH, cap=coach-spawn, parent=academy-director. Config B (operator): VERB=SPECIALIST,
// cap=operator-spawn, parent=autonomous-business-operator. Fail-OPEN on parse errors (never blocks the tick);
// fail-CLOSED on the spawn cap; adapt/retire only touch AUTOSPAWNED sub-agents (never the parent/non-autospawned).
// One name for the runtime address, the same one every sibling here uses. This file used to
// read BITFIELD_CARRIER, which is the same concept under a second name, and a second name is
// how a defect hides: the corpus check that finds a frozen address keys on the variable name,
// so this file's own `|| 'http://127.0.0.1:8080'` sat in plain sight and matched nothing.
//
// The address itself is not durable, because the runtime picks its port at startup, so a value
// captured once is right until the next restart and silently wrong after it. What IS durable is
// the PATH the runtime publishes that address into, so the path arrives as DATA and the address
// is read through it at launch. This process is a one-shot, so reading at start is reading at
// the point of use. The chain lives in ./lib/carrier.mjs, mounted beside this file.
//
// Adopting the shared chain adds the PORT fallback this file lacked, which is the drift the one
// owner exists to remove.
//
// THE PARTITION HAS NO DEFAULT HERE, and the comment this replaces claimed the opposite. It said the
// tennis literal was "a real DATA default this action relies on". It was not: the action's own manifest
// env froze `BITFIELD_PARTITION` to a second literal, so `resolvePartition()` never returned null and
// the tenant fallback could not run. Both literals named an app nothing owns, and PART decides where
// agent profiles and instruction blocks are WRITTEN, so a wrong value mints agents into a store nobody
// opens and NOTHING ERRORS. That silence is the whole defect: a guessed partition looks exactly like a
// correct one. The eight sibling processes here take `resolvePartition()` verbatim, because the shared
// owner returns null rather than a default precisely so each caller states its own consequence. This
// one WRITES, so its consequence is to fail closed, the same answer `autonomous-worker`'s README gives
// for its own write target. The partition now arrives as `input.partition`, stamped by the dispatcher.
import { resolveCarrier, resolvePartition, CARRIER_AND_PARTITION_REQUIRED } from './lib/carrier.mjs';

const CARRIER = resolveCarrier();
const PART = resolvePartition();
// Guard only when invoked as the process entry, so a test importing the pure exports skips the exit.
// Matches produce-grounded.mjs, which keys the same check on the carrier being set.
if (CARRIER && !PART) { console.error(CARRIER_AND_PARTITION_REQUIRED); process.exit(1); }
const VERB = (process.env.BITFIELD_LIFECYCLE_VERB || 'COACH').toUpperCase();
const CAP_KEY = process.env.BITFIELD_SPAWN_CAP_KEY || 'coach-spawn';
const PARENT = process.env.BITFIELD_LIFECYCLE_PARENT || 'ai-agent-profile:academy-director';
const CAP_ADDR = `package::ai-action-guard::ai-guard-limit::${CAP_KEY}`;
const DEFAULT_CAP = 8;
const text = process.argv[2] || '';
const PROF = (id) => `package::ai-agent-profile::ai-agent-profile::${id}`;
const BLOCK = (id) => `package::ai-instruction-blocks::ai-instruction-block::${id}-directive`;
// PURE guards (unit-tested in spawn-check.test.mjs) — the security-critical decisions, no I/O:
export function sanitizeAgentId(s) { return String(s || '').replace(/[^a-zA-Z0-9-]/g, '-').slice(0, 60); }
export function parseDirective(txt, tag) { const m = String(txt || '').match(new RegExp(tag + ':\\s*(\\{[\\s\\S]*?\\})')); if (!m) return null; try { return JSON.parse(m[1]); } catch { return null; } }
// ADAPT/RETIRE may ONLY touch an autospawned sub-agent that EXISTS — never the parent/non-autospawned (a
// bug here could retire the root operator/coach and kill the whole loop). Fail-closed on both conditions.
export function mutateDecision(profs, id) {
  const p = (profs || []).find((x) => x && x.id === id) || null;
  if (!p) return { ok: false, reason: 'not-found' };
  if (!p.autospawned) return { ok: false, reason: 'not-autospawned-protected' };
  return { ok: true };
}
// SPAWN admission: fail-CLOSED on the ai-action-guard cap (autospawned count >= max), idempotent on existing id.
export function spawnDecision(profs, id, maxCount) {
  const autoCount = (profs || []).filter((p) => p && p.autospawned).length;
  if (autoCount >= maxCount) return { ok: false, reason: 'guard-cap', autoCount, maxCount };
  if ((profs || []).some((p) => p && p.id === id)) return { ok: false, reason: 'idempotent-exists', autoCount, maxCount };
  return { ok: true, autoCount, maxCount };
}
const clean = (s) => sanitizeAgentId(s);
function parse(tag) { return parseDirective(text, tag); }
async function boot() { const b = await fetch(CARRIER + '/boot', { headers: { 'Cache-Control': 'no-cache' } }).then((r) => r.json()); return (Array.isArray(b) ? b[0] : b).running_command_list_basis; }
async function post(target, body, basis) { const r = await fetch(CARRIER + '/target/' + encodeURIComponent(target), { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Bitfield-Running-Command-List-Basis': basis, 'X-Bitfield-Partition': PART }, body: JSON.stringify(body) }); const x = await r.text(); try { return { http: r.status, body: JSON.parse(x) }; } catch { return { http: r.status }; } }
async function profiles(basis) { const f = await post('slot::find-current-items', { operation: 'find-current-items', in: 'published-record', where: { all: [{ field: 'kind', in: ['ai-agent-profile'] }] }, include: ['payload'] }, basis); return (Array.isArray(f.body) ? f.body : (f.body && (f.body.items || f.body.results) || [])).map((o) => o.payload || o); }
async function main() {
  const spawn = parse('SPAWN_' + VERB), adapt = parse('ADAPT_' + VERB), retire = parse('RETIRE_' + VERB);
  if (!spawn && !adapt && !retire) { console.log(JSON.stringify({ acted: false, reason: 'no-directive' })); process.exit(0); }
  const basis = await boot();
  const profs = await profiles(basis);
  // RETIRE: only an autospawned sub-coach.
  if (retire && retire.agent_id) {
    const id = clean(retire.agent_id); const d = mutateDecision(profs, id);
    if (!d.ok) { console.log(JSON.stringify({ acted: false, op: 'retire', reason: d.reason, id })); process.exit(0); }
    const w = await post('engine.operation.label-addressed', { operation_label: 'engine.operation.write-batch', writes: [{ partition_label: PART, address_label: PROF(id), address_mode: 'label_hash', path_labels: ['current-item', 'published-record'] }, { partition_label: PART, address_label: BLOCK(id), address_mode: 'label_hash', path_labels: ['current-item', 'published-record'] }] }, basis);
    console.log(JSON.stringify({ acted: true, op: 'retire', id, http: w.http })); process.exit(0);
  }
  // ADAPT: rewrite an existing autospawned sub-coach's directive block.
  if (adapt && adapt.agent_id && adapt.directive) {
    const id = clean(adapt.agent_id); const d = mutateDecision(profs, id);
    if (!d.ok) { console.log(JSON.stringify({ acted: false, op: 'adapt', reason: d.reason, id })); process.exit(0); }
    const w = await post('engine.operation.label-addressed', { operation_label: 'engine.operation.write-batch', writes: [{ partition_label: PART, address_label: BLOCK(id), address_mode: 'label_hash', path_labels: ['current-item', 'published-record'], payload: { kind: 'ai-instruction-block', id: `${id}-directive`, body: String(adapt.directive), created_by: PARENT, adapted: true } }] }, basis);
    console.log(JSON.stringify({ acted: true, op: 'adapt', id, http: w.http })); process.exit(0);
  }
  // SPAWN: guarded by the ai-action-guard cap + idempotency.
  if (spawn && spawn.agent_id && spawn.directive) {
    const id = clean(spawn.agent_id);
    const cap = await post('engine.operation.label-addressed', { operation_label: 'engine.operation.read-current', partition_label: PART, address_label: CAP_ADDR, address_mode: 'label_hash' }, basis);
    const cp = cap.body && (cap.body.payload || cap.body.value || null);
    const maxCount = cp && Number.isFinite(cp.max_count) ? cp.max_count : DEFAULT_CAP;
    const d = spawnDecision(profs, id, maxCount);
    if (!d.ok) { console.log(JSON.stringify({ acted: false, op: 'spawn', reason: d.reason, id, autoCount: d.autoCount, maxCount: d.maxCount })); process.exit(0); }
    const autoCount = d.autoCount;
    // WAKE-ENABLE the spawned specialist (close the spawn->wake seam): a spawned profile is INERT unless it
    // carries produce_instruction (the wake-producer opt-in read by produce-grounded.selectWakeAgent) AND
    // produce_output_kind (so its model output parses). Both are INHERITED from the parent so the child
    // produces the SAME output contract, specialized to its own mandate — config-agnostic (operator's
    // specialists -> action-intent, coach's sub-coaches -> drill-prescription), ZERO hardcoded schema/enum.
    // Without this, agents-making-agents mints agents that can never autonomously produce (the 2nd-gen loop
    // dead-ends at spawn). See produce-grounded.selectWakeAgent + reference-wake-fanout memory.
    const parentProfile = profs.find((p) => p && p.id === PARENT) || null;
    const parentInstruction = (parentProfile && typeof parentProfile.produce_instruction === 'string' && parentProfile.produce_instruction.trim()) ? parentProfile.produce_instruction.trim() : '';
    const parentOutputKind = (parentProfile && typeof parentProfile.produce_output_kind === 'string' && parentProfile.produce_output_kind.trim()) ? parentProfile.produce_output_kind.trim() : 'action-intent';
    const childProduceInstruction = `You are "${spawn.name || id}", a focused SPECIALIST sub-agent spawned by ${PARENT}. YOUR MANDATE (act ONLY on this, AS YOURSELF — you are NOT the parent): ${String(spawn.directive)}\n\nProduce your output in EXACTLY your parent's contract/output format below, specialized to your mandate:\n\n${parentInstruction}`;
    const w = await post('engine.operation.label-addressed', { operation_label: 'engine.operation.write-batch', writes: [{ partition_label: PART, address_label: BLOCK(id), address_mode: 'label_hash', path_labels: ['current-item', 'published-record'], payload: { kind: 'ai-instruction-block', id: `${id}-directive`, body: String(spawn.directive), created_by: PARENT } }, { partition_label: PART, address_label: PROF(id), address_mode: 'label_hash', path_labels: ['current-item', 'published-record'], payload: { kind: 'ai-agent-profile', id, name: spawn.name || id, instruction_block_refs: [`${id}-directive`], produce_instruction: childProduceInstruction, produce_output_kind: parentOutputKind, spawned_by: PARENT, parent_ref: PARENT, autospawned: true } }] }, basis);
    console.log(JSON.stringify({ acted: true, op: 'spawn', id, autoCount, maxCount, http: w.http })); process.exit(0);
  }
  console.log(JSON.stringify({ acted: false, reason: 'incomplete-directive' }));
}
// Run only when invoked as the process entry (the def execs `node spawn-check.mjs "<arg>"`); a test
// importing this module for the pure guards skips main().
if ((process.argv[1] || '').endsWith('spawn-check.mjs')) { main().catch((e) => { console.log(JSON.stringify({ acted: false, err: e.message })); process.exit(0); }); }
