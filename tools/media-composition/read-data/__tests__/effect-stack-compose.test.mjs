/**
 * EMERGENT UNLOCK of the effect-registry primitive: the ordered `segment.effects` list dispatches (via
 * resolveEffectFragment) to ALL 33 compute effects, plus `template` (opaque -vf) and `effect_id` (keyframe)
 * nodes, in the SAME list. So an authored stack applies ANY effect in ANY order/count as pure DATA (the L069
 * combinatorial explosion), zero code per combination. Nothing emits this list from the compose/materialize
 * layer yet, so this proves the compositor end (buildClip, then the effects loop) directly by attaching an
 * authored `effects` array to a materialized EDL's spine segment.
 *
 * Proof (L155 temporal): a real OFFLINE render where (1) the stack visibly changes the output vs no effects,
 * (2) applying the SAME effect TWICE differs from once (count matters), (3) reordering differs (order matters),
 * (4) a mixed compute + template + keyframe list renders, and (5) the whole path is byte-identical across two
 * runs (determinism carries through the emergent path).
 */
import { tempFolder } from '../../../../test-helpers/temp-folder.mjs';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { blake3 } from '@noble/hashes/blake3.js';
import { writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { authorEffectStackDecision, authorEffectStackRecord } from '../../do-work/author-effect-stack.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, '..', '..', 'do-work', 'video-compose.mjs');
const FPS = 24;
let composeTimeline, materializeExportEdl, work, clip;

function ffmpeg(args) {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' });
}
const hashFile = (file) => '1f:' + Buffer.from(blake3(new Uint8Array(readFileSync(file)))).toString('hex');

before(async () => {
  const dir = tempFolder(join(tmpdir(), 'fxstack-'));
  const alias = '--alias:@=' + join(here, '..', '..', '..', '..');
  const ct = join(dir, 'ct.mjs'); const me = join(dir, 'me.mjs');
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'compose-timeline.ts'), `--outfile=${ct}`], { encoding: 'utf8' });
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'materialize-edl.ts'), `--outfile=${me}`], { encoding: 'utf8' });
  ({ composeTimeline } = await import(ct));
  ({ materializeExportEdl } = await import(me));

  work = tempFolder(join(tmpdir(), 'fxstack-render-'));
  clip = join(work, 'clip.mp4'); // colorful content so effects visibly change the frame
  ffmpeg(['-f', 'lavfi', '-i', `testsrc2=s=320x240:r=${FPS}:d=2`, '-pix_fmt', 'yuv420p', clip]);
});

const view = () => ({
  lanes: [{ lane_id: 'video', role: 'video', label: 'Video', items: [
    { item_id: 's1', label: 'Clip', start: 0, end: 2, source_ref: { artifact_ref: 'r.mp4', source_id: 's1' } },
  ] }],
  editDecisions: [],
  markers: [],
});

// Materialize a plain EDL (no flat effects), attach an authored ordered `effects` stack to the spine clip,
// render deterministically. `effects` is the emergent ordered-list DATA the primitive now dispatches.
const renderWithEffects = (name, effects) => {
  const comp = composeTimeline(view());
  const { edl } = materializeExportEdl(comp, () => clip, { width: 320, height: 240, fps: FPS, deterministic: true });
  assert.ok(Array.isArray(edl.spine?.segments) && edl.spine.segments.length >= 1, 'materialized EDL has a spine clip');
  edl.spine.segments[0].effects = effects;
  const edlFile = join(work, `${name}.json`); const out = join(work, `${name}.mp4`);
  writeFileSync(edlFile, JSON.stringify(edl));
  execFileSync('node', [SCRIPT, '--edl', edlFile, '--out', out], { encoding: 'utf8' });
  return out;
};

// EMERGENT-3 (authoring wire-up): the FULL path an editor uses. A set-transform editDecision carrying
// `transform.effects` / `transform.look_stack` folds through composeTimeline, and materialize EMITS them
// onto the spine segment via the generic transform pass-through, so the compositor renders them. This proves
// editDecisions -> composeTimeline -> materializeExportEdl -> render end-to-end (not effects hand-attached to the EDL).
const viewWith = (decisions) => ({
  lanes: [{ lane_id: 'video', role: 'video', label: 'Video', items: [
    { item_id: 's1', label: 'Clip', start: 0, end: 2, source_ref: { artifact_ref: 'r.mp4', source_id: 's1' } },
  ] }],
  editDecisions: decisions,
  markers: [],
});
const materializeFromDecisions = (decisions) => {
  const comp = composeTimeline(viewWith(decisions));
  const { edl } = materializeExportEdl(comp, () => clip, { width: 320, height: 240, fps: FPS, deterministic: true });
  return edl;
};
const renderEdl = (name, edl) => {
  const edlFile = join(work, `${name}.json`); const out = join(work, `${name}.mp4`);
  writeFileSync(edlFile, JSON.stringify(edl));
  execFileSync('node', [SCRIPT, '--edl', edlFile, '--out', out], { encoding: 'utf8' });
  return out;
};
const setTransform = (transform) => [{
  action: 'set-transform', created_at: '2026-01-01T00:00:00Z',
  source_ref: { source_id: 's1' }, parameters: { transform },
}];

test('OFFLINE RENDER: a set-transform editDecision EMITS segment.effects/look_stack through the fold, and renders', () => {
  // (a) an effects stack authored as a decision lands on the materialized EDL segment AND renders
  const edlFx = materializeFromDecisions(setTransform({ effects: [
    { compute: 'scanlines', params: { depth: 0.8 } }, { compute: 'glow', params: { strength: 0.8 } },
  ] }));
  assert.deepEqual(edlFx.spine.segments[0].effects, [
    { compute: 'scanlines', params: { depth: 0.8 } }, { compute: 'glow', params: { strength: 0.8 } },
  ], 'the authored effects[] reached the EDL segment via fold -> materialize pass-through');
  const fx = renderEdl('dec-fx', edlFx);
  const plain = renderEdl('dec-plain', materializeFromDecisions([]));
  assert.notEqual(hashFile(fx), hashFile(plain), 'the decision-authored effects changed the rendered output');
  assert.equal(hashFile(fx), hashFile(renderEdl('dec-fx2', materializeFromDecisions(setTransform({ effects: [
    { compute: 'scanlines', params: { depth: 0.8 } }, { compute: 'glow', params: { strength: 0.8 } },
  ] })))), 'authoring the same decision twice is byte-identical (determinism through the fold)');

  // (b) a look_stack preset authored as a decision lands as segment.look_stack AND renders its whole stack
  const edlLook = materializeFromDecisions(setTransform({ look_stack: 'vhs' }));
  assert.equal(edlLook.spine.segments[0].look_stack, 'vhs', 'the authored look preset reached the EDL segment');
  assert.notEqual(hashFile(renderEdl('dec-look', edlLook)), hashFile(plain), 'the decision-authored vhs preset changed the output');

  // (c) a decision setting ONLY a non-effect field carries NO effects/look_stack, and renders byte-identical
  // to the no-decision baseline: adding the two DATA fields did not regress flat renders.
  const edlFlat = materializeFromDecisions(setTransform({ volume: 1 }));
  assert.equal(edlFlat.spine.segments[0].effects, undefined, 'no effects field when none authored');
  assert.equal(edlFlat.spine.segments[0].look_stack, undefined, 'no look_stack field when none authored');
  assert.equal(hashFile(renderEdl('dec-flat', edlFlat)), hashFile(plain), 'a non-effect decision renders byte-identically to the baseline');
});

test('EMERGENT-5: authorEffectStackDecision validates a proposed stack and emits a set-transform decision (pure)', () => {
  // valid stack -> a set-transform decision targeting the clip, carrying the effects
  const good = authorEffectStackDecision({ clipId: 's1', stack: [{ compute: 'glow', params: { strength: 0.6 } }, { template: 'eq=saturation=1.2' }] });
  assert.equal(good.ok, true);
  assert.equal(good.decision.action, 'set-transform');
  assert.equal(good.decision.parameters.clip_id, 's1');
  assert.deepEqual(good.decision.parameters.transform.effects, [{ compute: 'glow', params: { strength: 0.6 } }, { template: 'eq=saturation=1.2' }]);
  // valid look preset
  assert.equal(authorEffectStackDecision({ clipId: 's1', look: 'vhs' }).decision.parameters.transform.look_stack, 'vhs');
  // global target
  assert.equal(authorEffectStackDecision({ global: true, stack: [{ compute: 'glow' }] }).decision.parameters.global, true);
  // rejections (never throw): unknown compute, unknown look, no clip, nothing to author
  assert.match(authorEffectStackDecision({ clipId: 's1', stack: [{ compute: 'nope' }] }).errors[0].message, /unknown compute effect/);
  assert.match(authorEffectStackDecision({ clipId: 's1', look: 'nope' }).errors[0].message, /unknown look preset/);
  assert.match(authorEffectStackDecision({ stack: [{ compute: 'glow' }] }).errors[0].message, /clipId or sourceId is required/);
  assert.match(authorEffectStackDecision({ clipId: 's1' }).errors[0].message, /nothing to author/);
});

test('OFFLINE RENDER: the agent bridge decision flows bridge -> editDecision -> fold -> render', () => {
  // The FULL emergent-5 loop: an agent proposes a stack, the bridge validates + emits a set-transform decision,
  // and that decision (unmodified) folds through composeTimeline + materialize and renders the effects.
  const res = authorEffectStackDecision({ sourceId: 's1', stack: [
    { compute: 'scanlines', params: { depth: 0.7 } }, { compute: 'glow', params: { strength: 0.7 } },
  ] });
  assert.equal(res.ok, true, 'bridge produced a decision');
  const edl = materializeFromDecisions([{ ...res.decision, created_at: '2026-01-01T00:00:00Z' }]);
  assert.deepEqual(edl.spine.segments[0].effects, res.decision.parameters.transform.effects, 'the bridge-authored effects reached the EDL segment');
  const out = renderEdl('bridge-fx', edl);
  const plain = renderEdl('bridge-plain', materializeFromDecisions([]));
  assert.notEqual(hashFile(out), hashFile(plain), 'the bridge-authored stack rendered and changed the output');
});

test('EMERGENT-5 workflow-native: authorEffectStackRecord emits the media-composition.edit-decision RECORD the write action consumes, and its payload folds + renders', () => {
  // The record is exactly what action:write-media-composition-record writes (input.record = {address, payload}).
  const rec = authorEffectStackRecord({ sourceId: 's1', stack: [{ compute: 'scanlines', params: { depth: 0.7 } }], id: 'demo' });
  assert.equal(rec.ok, true);
  assert.equal(rec.record.address, 'package::media-composition::edit-decision::demo');
  assert.equal(rec.record.payload.kind, 'media-composition.edit-decision');
  assert.equal(rec.record.payload.action, 'set-transform');
  // stable content-hash id when none given (idempotent re-authoring)
  const a = authorEffectStackRecord({ sourceId: 's1', look: 'vhs' });
  const b = authorEffectStackRecord({ sourceId: 's1', look: 'vhs' });
  assert.equal(a.record.address, b.record.address, 'same stack -> same edit-decision address (idempotent)');
  // the record payload IS the edit-decision the fold reads: feed it as an editDecision and it renders
  const edl = materializeFromDecisions([{ ...rec.record.payload, created_at: '2026-01-01T00:00:00Z' }]);
  assert.deepEqual(edl.spine.segments[0].effects, [{ compute: 'scanlines', params: { depth: 0.7 } }], 'the write-action record payload folds to segment.effects');
  assert.notEqual(hashFile(renderEdl('wf-record', edl)), hashFile(renderEdl('wf-plain', materializeFromDecisions([]))), 'the workflow-record path renders the effects');
});

test('OFFLINE RENDER: an authored effects stack applies, and is byte-identical across two runs', () => {
  const stack = [
    { compute: 'scanlines', params: { depth: 0.8 } },
    { compute: 'glow', params: { strength: 0.8 } },
  ];
  const a = renderWithEffects('stack-a', stack);
  const b = renderWithEffects('stack-b', stack);
  const none = renderWithEffects('none', []);
  // the stack actually changed the output (effects were applied, not silently dropped)
  assert.notEqual(hashFile(a), hashFile(none), 'the effects stack changed the rendered output');
  // determinism carries through the emergent ordered-effects path
  assert.equal(hashFile(a), hashFile(b), 'two runs of the same authored stack are byte-identical');
});

test('OFFLINE RENDER: stacking is combinatorial, so same effect twice differs from once, and order matters', () => {
  const once = renderWithEffects('once', [{ compute: 'scanlines', params: { depth: 0.6 } }]);
  const twice = renderWithEffects('twice', [
    { compute: 'scanlines', params: { depth: 0.6 } },
    { compute: 'scanlines', params: { depth: 0.6 } },
  ]);
  assert.notEqual(hashFile(once), hashFile(twice), 'applying the SAME effect twice differs from once (count matters)');

  const ab = renderWithEffects('order-ab', [
    { compute: 'posterize', params: { levels: 4 } },
    { compute: 'glow', params: { strength: 0.9 } },
  ]);
  const ba = renderWithEffects('order-ba', [
    { compute: 'glow', params: { strength: 0.9 } },
    { compute: 'posterize', params: { levels: 4 } },
  ]);
  assert.notEqual(hashFile(ab), hashFile(ba), 'reordering the same two effects changes the output (order matters)');
});

test('OFFLINE RENDER: a named LOOK preset (look_stack) applies its whole multi-effect stack', () => {
  // author a preset by NAME on the clip; the compositor expands resolveLookStack('vhs') into the effect list
  const renderPreset = (name, look) => {
    const comp = composeTimeline(view());
    const { edl } = materializeExportEdl(comp, () => clip, { width: 320, height: 240, fps: FPS, deterministic: true });
    edl.spine.segments[0].look_stack = look;
    const edlFile = join(work, `${name}.json`); const out = join(work, `${name}.mp4`);
    writeFileSync(edlFile, JSON.stringify(edl));
    execFileSync('node', [SCRIPT, '--edl', edlFile, '--out', out], { encoding: 'utf8' });
    return out;
  };
  const vhs = renderPreset('look-vhs', 'vhs');
  const vhs2 = renderPreset('look-vhs2', 'vhs');
  const plain = renderPreset('look-none', 'nope'); // unknown -> [] -> no effects
  assert.notEqual(hashFile(vhs), hashFile(plain), 'the vhs preset applied its whole multi-effect stack (differs from plain)');
  assert.equal(hashFile(vhs), hashFile(vhs2), 'the same named preset renders byte-identically across runs');
  // the preset stacks WITH explicit per-clip effects (preset first, then segment.effects on top)
  const layered = (() => {
    const comp = composeTimeline(view());
    const { edl } = materializeExportEdl(comp, () => clip, { width: 320, height: 240, fps: FPS, deterministic: true });
    edl.spine.segments[0].look_stack = 'vhs';
    edl.spine.segments[0].effects = [{ compute: 'glow', params: { strength: 0.8 } }];
    const edlFile = join(work, 'look-layered.json'); const out = join(work, 'look-layered.mp4');
    writeFileSync(edlFile, JSON.stringify(edl));
    execFileSync('node', [SCRIPT, '--edl', edlFile, '--out', out], { encoding: 'utf8' });
    return out;
  })();
  assert.notEqual(hashFile(layered), hashFile(vhs), 'a per-clip effect layered on top of the preset changes the output');
});

// EMERGENT-4 proof: a compute effect's scalar param is a keyframe envelope (`param_envelopes`), so the same
// effect animates over the clip (each step gated by ffmpeg `enable`). On a CONSTANT gray clip the only source
// of change is the brightness ramp, so an early frame must be darker than a late frame, and the animated render
// must differ from BOTH static-endpoint renders (proving it is genuinely time-varying, not a constant).
test('OFFLINE RENDER: per-effect param keyframing animates a scalar over time (early frame darker than late)', () => {
  const gray = join(work, 'gray.mp4');
  ffmpeg(['-f', 'lavfi', '-i', `color=c=gray:s=320x240:r=${FPS}:d=2`, '-pix_fmt', 'yuv420p', gray]);
  const renderOnGray = (name, seg) => {
    const comp = composeTimeline(view());
    const { edl } = materializeExportEdl(comp, () => gray, { width: 320, height: 240, fps: FPS, deterministic: true });
    Object.assign(edl.spine.segments[0], seg);
    const edlFile = join(work, `${name}.json`); const out = join(work, `${name}.mp4`);
    writeFileSync(edlFile, JSON.stringify(edl));
    execFileSync('node', [SCRIPT, '--edl', edlFile, '--out', out], { encoding: 'utf8' });
    return out;
  };
  const avgLuma = (file, t) => {
    const out = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', String(t), '-i', file,
      '-frames:v', '1', '-vf', 'signalstats,metadata=print:file=-', '-f', 'null', '-'], { encoding: 'utf8' });
    const m = out.match(/lavfi\.signalstats\.YAVG=([0-9.]+)/);
    assert.ok(m, `signalstats YAVG present for ${file} @${t}`);
    return Number(m[1]);
  };
  const ramp = [{ t: 0, value: 0.05 }, { t: 2, value: 0.6 }];
  const kf = renderOnGray('kf-ramp', { effects: [{ compute: 'color_adjust', param_envelopes: { brightness: ramp }, steps: 8 }] });
  const kf2 = renderOnGray('kf-ramp2', { effects: [{ compute: 'color_adjust', param_envelopes: { brightness: ramp }, steps: 8 }] });
  const lo = renderOnGray('static-lo', { effects: [{ compute: 'color_adjust', params: { brightness: 0.05 } }] });
  const hi = renderOnGray('static-hi', { effects: [{ compute: 'color_adjust', params: { brightness: 0.6 } }] });

  assert.equal(hashFile(kf), hashFile(kf2), 'the param-keyframed render is byte-identical across two runs (determinism)');
  assert.notEqual(hashFile(kf), hashFile(lo), 'the animated render differs from the static low-brightness render');
  assert.notEqual(hashFile(kf), hashFile(hi), 'the animated render differs from the static high-brightness render');

  const early = avgLuma(kf, 0.15);
  const late = avgLuma(kf, 1.85);
  assert.ok(late - early > 15, `brightness ramp raises luma over time (early ${early.toFixed(1)} -> late ${late.toFixed(1)})`);
});

test('OFFLINE RENDER: a MIXED compute + template + keyframe list renders in one stack', () => {
  const mixed = renderWithEffects('mixed', [
    { compute: 'sharpen', params: { amount: 0.6 } },            // scalar compute effect (params.amount)
    { template: 'eq=saturation=1.4' },                          // opaque -vf (the Johnny path)
    { effect_id: 'opacity', points: [{ t: 0, value: 1 }, { t: 2, value: 0.4 }] }, // keyframe-envelope node
    { compute: 'scanlines', params: { depth: 0.5 } },           // another compute node
    { compute: 'hue_shift', params: { degrees: 0, cycleRate: 0, saturation: 1 } }, // NEUTRAL, yields 0 fragments
  ]);
  const plain = renderWithEffects('mixed-none', []);
  assert.notEqual(hashFile(mixed), hashFile(plain), 'the mixed compute+template+keyframe stack rendered and changed the output');
});
