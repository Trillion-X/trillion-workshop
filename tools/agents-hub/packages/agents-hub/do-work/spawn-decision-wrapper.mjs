// package-set://bitfield-studio/packages/agents-hub/do-work/spawn-decision-wrapper.mjs
//
// Purpose:
//   The node `-e` wrapper that compute.process_session spawns to run ONE autonomous
//   AI trading-decision cycle on the SSOT model (claude-opus-4-8). It is the body of
//   the `argv:[node,-e,<this minified>]` in action:spawn-decision-session.
//
// WHY a wrapper that reads the protocol at RUNTIME (SSOT, not baked):
//   The objective the AI runs IS the live protocol record `ai-instruction-block:trading-agent-protocol`
//   plus a tiny this-cycle addendum. Baking the 8KB protocol into the workflow-def
//   would fork SSOT: a protocol edit (the front door for changing how the AI trades)
//   would silently NOT take effect until the def is rebuilt. So the wrapper reads the
//   live protocol from the carrier each spawn. A protocol update needs ZERO def rebuild.
//
// WHY claude -p (not codex): the ai-agent-profile:trading-momentum model_ref is
//   claude-opus-4-8. The MODEL is SSOT. claude -p runs Opus 4.8 headless and does NOT
//   block on stdin (unlike codex). The child inherits the session PTY (stdio inherit).
//
// DECISION != EXECUTION: the AI authors the policy + cycle fact + bridge + decision.
//   It NEVER places a broker order directly — the generic executor (apply-trading-policy)
//   applies the policy. The protocol enforces this; the cycle addendum reiterates it.
//
// This file is the readable SOURCE. The deliver script minifies it into the def's argv.
// Env (set by the spawn step descriptor):
//   BITFIELD_TARGET_CARRIER_URL — carrier base URL (e.g. http://127.0.0.1:3012)
//   BF_MODEL                    — the SSOT model id (claude-opus-4-8)
//   BF_CLAUDE_BIN               — absolute path to the claude CLI

'use strict';
const cp = require('child_process');

const SHELL = process.env.BITFIELD_TARGET_CARRIER_URL;
const MODEL = process.env.BF_MODEL;
const CLAUDE_BIN = process.env.BF_CLAUDE_BIN;
const HUB = 'bitfield-studio';
const RUNTIME = 'runtime-partition';

async function bootBasis() {
  const r = await fetch(SHELL + '/boot', { headers: { 'Cache-Control': 'no-cache' } });
  const b = await r.json();
  return b[0].running_command_list_basis;
}

async function readCurrent(basis, partition, address, mode) {
  const body = { operation_label: 'engine.operation.read-current', partition_label: partition, address_label: address };
  if (mode) body.address_mode = mode;
  const r = await fetch(SHELL + '/target/engine.operation.label-addressed', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Bitfield-Running-Command-List-Basis': basis },
    body: JSON.stringify(body),
  });
  const t = await r.text();
  try { return JSON.parse(t); } catch { return { found: false, raw: t.slice(0, 200) }; }
}

async function main() {
  if (!SHELL || !MODEL || !CLAUDE_BIN) {
    console.error('spawn-decision-wrapper: missing env (CARRIER_URL/MODEL/CLAUDE_BIN)');
    process.exit(2);
  }
  const basis = await bootBasis();
  const instr = await readCurrent(basis, HUB, 'ai-instruction-block:trading-agent-protocol', 'identity_text');
  const protocol = instr && instr.found && instr.payload ? instr.payload.body : null;
  if (!protocol) {
    console.error('spawn-decision-wrapper: live protocol ai-instruction-block:trading-agent-protocol not found');
    process.exit(3);
  }
  const pol = await readCurrent(basis, RUNTIME, 'trading-policy:current', 'identity_text');
  const vBefore = pol && pol.found && pol.payload && Number.isFinite(Number(pol.payload.policy_version))
    ? Number(pol.payload.policy_version) : 0;
  const vNext = vBefore + 1;

  // The cycle addendum DEFERS to the protocol's "HOW TO CALL THE CARRIER"/"CARRIER CALLS"
  // sections (the SSOT for targets/bodies). It must NOT re-specify a target (a wrong
  // target like /target/engine.operation.write-batch 404s and nothing is written —
  // the appended-step-contradicts-protocol bug). Keep it THIN: just say "run one cycle,
  // bump to vNext, write all four artifacts, then stop", and let the protocol carry the how.
  const objective = [
    protocol,
    '',
    '=== THIS CYCLE — run ONE decision cycle using the CARRIER CALLS section above, then STOP. Do NOT place a broker order directly (the executor does). ===',
    'Use the Bash tool with curl and the EXACT targets/bodies from the protocol above (writes/reads -> target "engine.operation.label-addressed" with operation_label in the body; market/account -> target "slot::workflow" execute_definition). Real numbers only; never invent prices.',
    'BUMP policy_version to ' + vNext + ' or higher when you AUTHOR trading-policy:current. Every order target MUST carry order_type:"limit" + a real limit_price (else the executor SKIPS it).',
    'Write ALL FOUR artifacts this cycle (even on HOLD): trading-policy:current (runtime-partition), the cycle fact TWICE (attribute_fact|agent:trading-momentum|last_cycle|type:json AND agent:trading-momentum.last-cycle, both in ' + HUB + '), and trading-decision:latest (runtime-partition). If you HOLD, decisions:[] with hold_reason, but still write all four.',
    'After writing the four artifacts, STOP.',
  ].join('\n');

  // Spawn claude -p (Opus 4.8) headless. stdin IGNORED (claude does not block on it).
  // stdout/stderr inherit the session PTY so the AI's work streams into the session feed.
  const r = cp.spawnSync(
    CLAUDE_BIN,
    ['-p', '--model', MODEL, '--dangerously-skip-permissions', '--output-format', 'text', objective],
    { stdio: ['ignore', 'inherit', 'inherit'], timeout: 590000 },
  );
  process.exit(r.status || 0);
}

main().catch((e) => { console.error('spawn-decision-wrapper fatal: ' + (e && e.message ? e.message : e)); process.exit(1); });
