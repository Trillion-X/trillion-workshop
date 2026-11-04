#!/usr/bin/env node
// author-effect-stack.mjs is the deterministic AGENT/MCP bridge for EMERGENT-5 (agent composition of effect
// stacks as DATA). An AI worker turns "make this clip look like X" into a proposed effect stack (an LLM step,
// owned by model-selection owners, NOT here); THIS script is the deterministic half: it advertises the effect vocabulary
// (buildEffectCatalog), VALIDATES an untrusted proposed stack against the live registry (validateEffectStack,
// zero rendering), and EMITS the set-transform editDecision that the fold (compose-timeline set-transform) plus
// materialize now turn into segment.effects/look_stack for the compositor to render. So an agent composes a
// stack the exact same way the editor does: one validated set-transform decision. No engine, no god package.
//
// Usage:
//   node author-effect-stack.mjs --catalog
//   node author-effect-stack.mjs --clip-id <id> --stack '[{"compute":"glow","params":{"strength":0.6}}]' [--out file]
//   node author-effect-stack.mjs --clip-id <id> --look vhs [--out file]
//   node author-effect-stack.mjs --global --stack '[...]'
import { writeFileSync } from 'node:fs';
import { blake3 } from '@noble/hashes/blake3.js';
import {
  buildEffectCatalog, validateEffectStack, resolveLookStack,
  createComputeEffects, createKeyframeEffects,
} from './effect-registry.mjs';

// Validation only reads Object.keys of the maps plus node shapes, so the deps are irrelevant to correctness
// here (the exact W/H/fps only matter at render). Instantiate with neutral deps to enumerate the real vocabulary.
const round3 = (x) => Math.round(Number(x) * 1000) / 1000;
const COMPUTE = createComputeEffects({ round3, W: 1920, H: 1080, safeColor: (c, d) => c || d, colorToRgb255: () => [0, 0, 0], fpsNum: 30, FPS: '30' });
const KEYFRAME = createKeyframeEffects({ fpsNum: 30, zoompanFilter: (z) => z });

/**
 * Pure agent-to-DATA bridge: given a proposed stack (or a named look) and a target, VALIDATE against the live
 * registry and return either the set-transform editDecision (DATA the fold renders) or structured errors.
 * `look` is validated as a real LOOK_STACKS key. Never renders, never throws on bad input.
 */
export function authorEffectStackDecision({ clipId, sourceId, stack, look, global = false } = {}, { computeEffects = COMPUTE, keyframeEffects = KEYFRAME } = {}) {
  const hasClip = typeof clipId === 'string' && clipId !== '';
  const hasSource = typeof sourceId === 'string' && sourceId !== '';
  // Target exactly ONE way: by derived clip_id (the editor inspector's path) OR by stable source_ref.source_id
  // (what an agent referencing a media item naturally has) OR global. Emitting both makes the fold's clip_id
  // precedence shadow the source match and miss the clip, so pick one.
  if (!global && !hasClip && !hasSource) return { ok: false, errors: [{ index: -1, message: 'clipId or sourceId is required (or pass global:true)' }] };
  const transform = {};
  if (look !== undefined && look !== null) {
    if (typeof look !== 'string' || resolveLookStack(look).length === 0) {
      return { ok: false, errors: [{ index: -1, message: `unknown look preset ${JSON.stringify(look)}; call --catalog for the valid looks` }] };
    }
    transform.look_stack = look;
  }
  if (stack !== undefined && stack !== null) {
    const v = validateEffectStack(stack, { computeEffects, keyframeEffects });
    if (!v.ok) return v;
    if (stack.length > 0) transform.effects = stack;
  }
  if (transform.look_stack === undefined && transform.effects === undefined) {
    return { ok: false, errors: [{ index: -1, message: 'nothing to author: pass a non-empty stack and/or a look preset' }] };
  }
  let parameters;
  let source_ref;
  if (global) parameters = { global: true, transform };
  else if (hasClip) parameters = { clip_id: clipId, transform };            // target the derived clip id (inspector path)
  else { parameters = { transform }; source_ref = { source_id: sourceId }; } // target by stable source id
  return { ok: true, decision: { action: 'set-transform', ...(source_ref ? { source_ref } : {}), parameters } };
}

/**
 * Wrap the validated decision as the exact media-composition.edit-decision RECORD the workflow engine's generic
 * `action:write-media-composition-record` action consumes (`input.record = {address, payload}`; it writes the
 * payload at the address into the content-media-evidence projection the fold reads). So an agent composes an
 * effect stack workflow-natively: author-effect-stack.mjs validates + shapes the record, then the WORKFLOW
 * action writes it (no bespoke command, no parallel dispatch). `id` defaults to a stable content hash of the
 * decision (no randomness), so re-authoring the same stack yields the same address (idempotent).
 */
export function authorEffectStackRecord(args = {}, deps = {}) {
  const res = authorEffectStackDecision(args, deps);
  if (!res.ok) return res;
  const decision = { ...res.decision };
  if (typeof args.createdAt === 'string' && args.createdAt) decision.created_at = args.createdAt;
  const id = typeof args.id === 'string' && args.id ? args.id : Buffer.from(blake3(new TextEncoder().encode(JSON.stringify(decision)))).toString('hex').slice(0, 16);
  const address = `package::media-composition::edit-decision::${id}`;
  return { ok: true, record: { address, payload: { kind: 'media-composition.edit-decision', ...decision } } };
}

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i += 1) {
    const k = argv[i];
    if (k === '--catalog') a.catalog = true;
    else if (k === '--global') a.global = true;
    else if (k === '--clip-id') a.clipId = argv[++i];
    else if (k === '--source-id') a.sourceId = argv[++i];
    else if (k === '--stack') a.stack = argv[++i];
    else if (k === '--look') a.look = argv[++i];
    else if (k === '--as-record') a.asRecord = true;
    else if (k === '--id') a.id = argv[++i];
    else if (k === '--created-at') a.createdAt = argv[++i];
    else if (k === '--out') a.out = argv[++i];
  }
  return a;
}

function main() {
  const a = parseArgs(process.argv.slice(2));
  if (a.catalog) {
    process.stdout.write(JSON.stringify(buildEffectCatalog({ computeEffects: COMPUTE, keyframeEffects: KEYFRAME }), null, 2) + '\n');
    return;
  }
  let stack;
  if (a.stack !== undefined) {
    try { stack = JSON.parse(a.stack); } catch (e) { process.stderr.write(JSON.stringify({ ok: false, errors: [{ index: -1, message: `--stack is not valid JSON: ${e.message}` }] }) + '\n'); process.exit(1); }
  }
  const call = { clipId: a.clipId, sourceId: a.sourceId, stack, look: a.look, global: a.global, id: a.id, createdAt: a.createdAt };
  // --as-record emits the media-composition.edit-decision RECORD the workflow action `action:write-media-composition-record`
  // writes; the default emits the bare editDecision (for the fold / a test). Both feed the workflow engine, never bypass it.
  const res = a.asRecord ? authorEffectStackRecord(call) : authorEffectStackDecision(call);
  if (!res.ok) { process.stderr.write(JSON.stringify(res) + '\n'); process.exit(1); }
  const text = JSON.stringify(a.asRecord ? res.record : res.decision, null, 2) + '\n';
  if (a.out) { writeFileSync(a.out, text); process.stdout.write(`wrote ${a.out}\n`); }
  else process.stdout.write(text);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
