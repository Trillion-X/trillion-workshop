// packages/media-composition/do-work/effect-registry.mjs
//
// =============================================================================
// THE EFFECT-CAPABILITY PRIMITIVE (recursive plugin architecture, plan 2026-08-06)
// =============================================================================
//
// An EFFECT is a capability the BLIND compositor dispatches to by `effect_id`. The
// compositor never names an effect (no `if (segment.ken_burns)`); it looks up the
// id and calls resolveEffect. Three kinds match the platform's OsProcess/InProcess
// duality (the same duality behind the `process` transition renderer):
//
//   - 'template' : a DATA ffmpeg-fragment string with ${param}/${ctx} placeholders.
//                  ZERO code. This is the Johnny path: a user adds an effect by
//                  dropping ONE record, no compositor edit (the opaque-string seam
//                  already used by grade/denoise/viz/chroma, generalized).
//   - 'compute'  : a pure leaf fn (params, ctx) => fragment, for effects that need
//                  real math (piecewiseExpr envelopes, cumulative ramps, zoompan
//                  assembly). Still returns a STRING that joins the ONE filtergraph,
//                  so performance is identical to the in-file maps (no extra pass).
//   - 'process'  : a DATA command that shells a binary (heavy: AI roto / RIFE /
//                  DeepFilterNet). Owned by the existing process seam in the render.
//
// Stage 1 of the migration (plan 2026-08-06) moves the KEYFRAME_BINDINGS domain
// (opacity/volume/zoom/rotate) here as `compute` capabilities, byte-identical, and
// adds the `template` path so a new fragment effect is a DATA record. Later stages
// move transitions, looks, viz, matte, and the flat `if (segment.X)` blocks, then
// the EDL carries an ordered effects list the compositor walks blindly.
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import { chooseByThreshold } from './choose-by-threshold.mjs';

/**
 * Build the keyframe-envelope `compute` capabilities. The compositor injects its
 * own `fpsNum` and `zoompanFilter` leaf (dependency injection, so this module owns
 * NO compositor state). Each returns a filter fragment from a compiled envelope
 * `expr` carrying the `__T__` placeholder; the capability substitutes its stream's
 * time symbol (video filters use T, the volume filter uses t, zoom uses on/fps).
 * A property becomes animatable by registering ONE row here, and the compositor
 * dispatches generically and never branches on property names (enum dissolution).
 */
export function createKeyframeEffects({ fpsNum, zoompanFilter }) {
  return {
    opacity: {
      stream: 'video',
      // Per-frame luma/chroma scale toward black. geq evaluates the envelope at
      // every frame time T. Correct for spine segments (no under-layer to blend).
      filter: (expr) => {
        const e = expr.replaceAll('__T__', 'T');
        return `geq=lum='lum(X,Y)*(${e})':cb='(cb(X,Y)-128)*(${e})+128':cr='(cr(X,Y)-128)*(${e})+128'`;
      },
    },
    volume: {
      stream: 'audio',
      filter: (expr) => `volume=volume='${expr.replaceAll('__T__', 't')}':eval=frame`,
    },
    // Auto-zoom / punch-in: a keyframed CENTER zoom. The envelope value is the zoom
    // factor (1 = no zoom); zoompan reads it per output frame (on/fps = clip seconds)
    // and crops a centered iw/zoom window scaled back to the canvas. Same zoompan
    // primitive as Ken Burns; a bare zoom envelope pans nowhere (centered 0.5/0.5).
    zoom: {
      stream: 'video',
      filter: (expr) => {
        const e = expr.replaceAll('__T__', `(on/${fpsNum})`);
        return zoompanFilter(`max(1,${e})`, '0.5', '0.5', fpsNum);
      },
    },
    // Animated rotation: the envelope value is DEGREES; the ffmpeg rotate filter takes
    // radians and evaluates `t` (seconds) per frame, so a spin-in, wobble, or animated
    // dutch angle is just a keyframes.rotate envelope. c=black fills the corners a
    // rotation exposes and ow/oh keep the canvas size. The piecewise commas ride inside
    // the rotate='...' quotes, so the raw (unescaped) envelope is safe in the -vf chain.
    rotate: {
      stream: 'video',
      filter: (expr) => {
        const e = expr.replaceAll('__T__', 't');
        return `rotate='(${e})*PI/180':c=black:ow=iw:oh=ih`;
      },
    },
  };
}

/**
 * The Johnny path: resolve a `template` effect (a DATA fragment string) by substituting
 * ${key} placeholders from `vars` (params + ctx like rw/rh/color/fps/W/H). An unknown
 * placeholder is left intact rather than throwing, so a template can reference a var the
 * caller does not supply without corrupting the graph. Returns the ffmpeg fragment string.
 * This is the same mechanism as the process seam's command templating, applied in-graph.
 */
export function resolveTemplateEffect(template, vars = {}) {
  if (typeof template !== 'string') throw new Error('[effect-registry] template effect needs a string `template`');
  return template.replace(/\$\{(\w+)\}/g, (whole, key) => (key in vars ? String(vars[key]) : whole));
}

// Local round3. The compute entries get round3 injected via createComputeEffects; resolveEffectFragment
// is a standalone export, so it carries its own identical rounding for the sampled keyframe times/values.
const r3 = (x) => Math.round(Number(x) * 1000) / 1000;

/**
 * Numerically sample a piecewise envelope `[{t, value, interp}]` (the SAME point shape KEYFRAME_BINDINGS
 * compiles to an ffmpeg expression) at clip-local time `t`. Mirrors piecewiseExpr's linear/hold semantics
 * but returns a NUMBER, so a compute effect's scalar param can be evaluated in JS at stepped windows.
 * Fails closed on a non-finite point or an unsupported interp (only linear/hold are numerically exact here;
 * per-frame eased curves belong to the effect_id envelope seam, which evaluates in ffmpeg).
 */
export function sampleEnvelope(points, t) {
  const pts = (Array.isArray(points) ? points : [])
    .map((p) => ({ t: Number(p.t), value: Number(p.value), interp: p.interp ?? 'linear' }))
    .sort((a, b) => a.t - b.t);
  if (pts.length === 0) throw new Error('[effect-registry] param envelope needs at least one point');
  for (const p of pts) {
    if (!Number.isFinite(p.t) || !Number.isFinite(p.value)) throw new Error('[effect-registry] param envelope point needs finite t and value');
    if (p.interp !== 'linear' && p.interp !== 'hold') throw new Error(`[effect-registry] param envelope interp ${JSON.stringify(p.interp)} must be 'linear' or 'hold'`);
  }
  if (t <= pts[0].t) return pts[0].value;
  if (t >= pts[pts.length - 1].t) return pts[pts.length - 1].value;
  for (let i = 0; i < pts.length - 1; i += 1) {
    const a = pts[i];
    const b = pts[i + 1];
    if (t >= a.t && t <= b.t) {
      const span = b.t - a.t;
      if (b.interp === 'hold' || span <= 0) return a.value;
      return a.value + (b.value - a.value) * ((t - a.t) / span);
    }
  }
  return pts[pts.length - 1].value;
}

// True if `s` contains a comma OUTSIDE a single-quoted span, i.e. a top-level ffmpeg filter-chain separator.
// A single ffmpeg filter has none (options are `:`-separated; any commas live inside quoted expr values).
// Used to fail closed when param-keyframing a fragment that is actually a chain (`a,b`), because a single
// timeline `enable` can only gate one filter, so a chain must use the effect_id envelope seam or a command pass.
function hasTopLevelComma(s) {
  let inQuote = false;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (ch === "'") inQuote = !inQuote;
    else if (ch === ',' && !inQuote) return true;
  }
  return false;
}

/**
 * Resolve ONE ordered effect node to `{ stream, fragment }` for the blind compositor. Dispatch is by
 * SELF-DESCRIBING DATA (L090), never a `kind` enum or an if-game: the node's SHAPE names its capability.
 *   - `node.template` (a string) => a DATA ffmpeg fragment, ${var} substituted from `vars` (the Johnny
 *     path, zero code). `node.stream` picks the stream (video default).
 *   - `node.effect_id` => a registered `compute` capability (keyframeEffects[id]); its envelope is
 *     `node.points` compiled by the injected `compileEnvelope`; the capability declares its own stream.
 *   - `node.compute` => one of the named compute effects; static `node.params`, OR (EMERGENT-4) a
 *     `node.param_envelopes` map `{param:[{t,value,interp}]}` that animates a scalar param over the clip:
 *     sampled in JS at `node.steps` stepped windows, each re-invoking the SAME effect and gated by ffmpeg
 *     `enable` (generic keyframing of ANY single-filter compute effect, zero per-effect code).
 * A node with neither field fails closed. (An out-of-process `node.command` effect is a separate render
 * PASS, not a per-clip fragment, so it is not resolved here.)
 */
export function resolveEffectFragment(node, { keyframeEffects, computeEffects = {}, compileEnvelope, timing = {}, vars = {} }) {
  // ONE blind dispatcher over an ordered `effects` list. Three self-describing node shapes (Physics-distinct
  // dispatch mechanisms, NOT a Society enum): `template` = an opaque ${var}-substituted -vf string (the Johnny
  // path); `effect_id` = a keyframe-envelope capability (opacity/volume/zoom/rotate); `compute` = one of the
  // named compute effects (glow/spotlight/scanlines/...). Returns { stream, fragments[] } uniformly, so a node
  // may yield 0 (null/neutral), 1, or N fragments (e.g. letterbox/strobe). Compute effects are invoked with the
  // uniform (params, timing) convention, so ANY of the 33 stacks in ANY order/count as pure DATA (L069).
  if (node && typeof node.template === 'string') {
    return { stream: node.stream === 'audio' ? 'audio' : 'video', fragments: [resolveTemplateEffect(node.template, vars)] };
  }
  if (node && typeof node.effect_id === 'string') {
    const cap = keyframeEffects[node.effect_id];
    if (!cap) throw new Error(`[effect-registry] unknown keyframe effect ${JSON.stringify(node.effect_id)}`);
    return { stream: cap.stream, fragments: [cap.filter(compileEnvelope(node.points ?? []))] };
  }
  if (node && typeof node.compute === 'string') {
    const entry = computeEffects[node.compute];
    if (typeof entry !== 'function') throw new Error(`[effect-registry] unknown compute effect ${JSON.stringify(node.compute)}`);
    const envelopes = node.param_envelopes && typeof node.param_envelopes === 'object' ? node.param_envelopes : null;
    const envNames = envelopes ? Object.keys(envelopes) : [];
    if (envNames.length === 0) {
      // Static params: unchanged, byte-identical to the flat path.
      const out = entry(node.params ?? {}, node.timing ?? timing);
      const fragments = Array.isArray(out) ? out.filter((f) => typeof f === 'string') : (typeof out === 'string' ? [out] : []);
      return { stream: 'video', fragments };
    }
    // EMERGENT-4 Per-effect scalar-param keyframing over ANY compute effect (L069). Each named param is a
    // piecewise envelope `[{t,value,interp}]` sampled in JS at K stepped time windows; each step re-invokes
    // the SAME compute entry with the sampled scalar and gates its fragment to that window via ffmpeg's
    // UNIVERSAL timeline `enable` option (zero per-effect code). Fail closed on a missing duration and on a
    // multi-filter chain (one `enable` cannot correctly gate a comma-chain; use effect_id or a command pass).
    const eff = node.timing ?? timing;
    const dur = Number.isFinite(eff.duration) && eff.duration > 0
      ? eff.duration
      : (Number.isFinite(eff.out) && Number.isFinite(eff.in) && eff.out > eff.in ? eff.out - eff.in : null);
    if (dur === null) throw new Error('[effect-registry] param-keyframed compute effect needs a positive timing.duration (or out>in)');
    const steps = Number.isInteger(node.steps) ? Math.max(2, Math.min(60, node.steps)) : 12;
    const fragments = [];
    for (let k = 0; k < steps; k += 1) {
      const t0 = r3((k * dur) / steps);
      const t1 = r3(((k + 1) * dur) / steps);
      const mid = (t0 + t1) / 2;
      const stepParams = { ...(node.params ?? {}) };
      for (const name of envNames) stepParams[name] = r3(sampleEnvelope(envelopes[name], mid));
      const out = entry(stepParams, eff);
      const raw = Array.isArray(out) ? out.filter((f) => typeof f === 'string') : (typeof out === 'string' ? [out] : []);
      for (const frag of raw) {
        if (hasTopLevelComma(frag)) throw new Error(`[effect-registry] compute effect ${JSON.stringify(node.compute)} produced a multi-filter chain (${JSON.stringify(frag)}); param keyframing needs a single filter (use effect_id envelope or a command pass instead)`);
        const sep = frag.includes('=') ? ':' : '=';
        fragments.push(`${frag}${sep}enable='between(t,${t0},${t1})'`);
      }
    }
    return { stream: 'video', fragments };
  }
  throw new Error(`[effect-registry] effect node has no capability field (template | effect_id | compute): ${JSON.stringify(node)}`);
}

/**
 * EMERGENT-5 (registry half): the machine-readable SELF-DESCRIPTION of the effect vocabulary, derived from
 * the LIVE maps so it can never drift from what resolveEffectFragment actually dispatches. This is what an
 * AI/agent (or its MCP tool bridge) advertises as "what effects can I compose", so "make this clip look like
 * X" resolves to a validated DATA stack. The registry OWNS the vocabulary + node shapes; the agent/MCP wiring
 * that exposes it (Society) is a separate lane. `looks` lists the named LOOK presets (look_stack values).
 */
export function buildEffectCatalog({ computeEffects = {}, keyframeEffects = {}, audioFx = {} } = {}) {
  return {
    node_shapes: [
      { field: 'template', desc: 'opaque ffmpeg -vf string with ${var} substitution (the Johnny path)', stream: 'video|audio' },
      { field: 'effect_id', desc: 'keyframe-envelope capability; carries points:[{t,value,interp}]', ids: Object.keys(keyframeEffects).sort() },
      { field: 'compute', desc: 'named compute effect; static params:{} OR param_envelopes:{param:[{t,value,interp}]} + steps? for keyframing', ids: Object.keys(computeEffects).sort() },
    ],
    compute_effects: Object.keys(computeEffects).sort(),
    keyframe_effects: Object.keys(keyframeEffects).sort(),
    // `audio_fx` (a set-transform PARAM, not an effects[] node): the audio placement/tone vocabulary the agent
    // can select (studio-sound / pitch / noise-gate / pan-left ...). Injected from the AUDIO_FX_CATALOG DATA so
    // this stays decoupled; empty when the caller does not supply it. A new audio preset auto-advertises here.
    audio_fx: Object.keys(audioFx).sort(),
    looks: Object.keys(LOOK_STACKS).sort(),
  };
}

/**
 * EMERGENT-5 (registry half): dry-run VALIDATE an untrusted (e.g. AI-authored) ordered effects list against the
 * live registry WITHOUT rendering, so the agent/MCP bridge rejects a malformed stack before it reaches ffmpeg.
 * Returns `{ ok, errors:[{index, message}] }`. Checks each node names exactly one capability field and that a
 * `compute`/`effect_id` id exists; a `template` node is accepted (opaque by design). Never throws on bad input.
 */
export function validateEffectStack(nodes, { computeEffects = {}, keyframeEffects = {} } = {}) {
  const errors = [];
  if (!Array.isArray(nodes)) return { ok: false, errors: [{ index: -1, message: 'effect stack must be an array' }] };
  nodes.forEach((node, index) => {
    if (!node || typeof node !== 'object') { errors.push({ index, message: 'effect node must be an object' }); return; }
    const has = ['template', 'effect_id', 'compute'].filter((f) => typeof node[f] === 'string');
    if (has.length === 0) { errors.push({ index, message: 'node has no capability field (template | effect_id | compute)' }); return; }
    if (has.length > 1) { errors.push({ index, message: `node has multiple capability fields (${has.join(', ')}); exactly one` }); return; }
    if (typeof node.effect_id === 'string' && !keyframeEffects[node.effect_id]) errors.push({ index, message: `unknown effect_id ${JSON.stringify(node.effect_id)}` });
    if (typeof node.compute === 'string' && typeof computeEffects[node.compute] !== 'function') errors.push({ index, message: `unknown compute effect ${JSON.stringify(node.compute)}` });
    if (node.param_envelopes && (typeof node.param_envelopes !== 'object' || Array.isArray(node.param_envelopes))) errors.push({ index, message: 'param_envelopes must be an object {param:[points]}' });
  });
  return { ok: errors.length === 0, errors };
}

/**
 * LOOK_STACKS: named multi-effect presets as pure DATA. A "look" that needs MORE than a single linear grade
 * string (the LOOK_CATALOG kind) is a named ordered `effects[]` array over the registry, resolved through
 * resolveEffectFragment like any authored stack. So a VHS look (scanlines + RGB fringe + posterize + damage)
 * or a bloom look (glow's split/blend, which no grade string can express) is ONE DATA row that expands to N
 * effect nodes, ZERO per-look engine code (L069/L090/enum-dissolution). Adding a look = adding a row here.
 * Emergent from the ordered-stacking primitive: these compose, repeat, and reorder for free.
 */
export const LOOK_STACKS = {
  vhs: [
    { compute: 'scanlines', params: { depth: 0.45 } },
    { template: 'rgbashift=rh=4:bh=-4' },        // chromatic fringe (opaque -vf, the Johnny path)
    { compute: 'posterize', params: { levels: 6 } },
    { compute: 'film_damage', params: { scratches: 2, dust: 3, strength: 0.6 } },
  ],
  'dreamy-bloom': [
    { compute: 'glow', params: { strength: 0.7 } },   // split/blend bloom, not expressible as a grade string
    { template: 'gblur=sigma=1.5' },
    { template: 'eq=brightness=0.03:saturation=1.08' },
  ],
  crt: [
    { compute: 'scanlines', params: { depth: 0.6, period: 3 } },
    { compute: 'lens_fringe', params: { strength: 0.08 } },
    { compute: 'spotlight', params: { strength: 0.5 } }, // positioned vignette darkening
  ],
  'cinematic-bloom': [
    { compute: 'glow', params: { strength: 0.5 } },
    { compute: 'letterbox', params: { aspect: 2.39 } },
    { template: 'colorbalance=rh=.10:bh=-.08:rs=-.06:bs=.10,eq=saturation=1.1:contrast=1.05' }, // teal-orange
  ],
  // golden-hour: the warm sunset look. A composition no single grade string can express: a warm white-balance
  // grade + highlight BLOOM (glow's split/blend) + a gentle vignette to focus the frame. Ordered DATA nodes.
  'golden-hour': [
    { template: 'colorbalance=rs=.16:rm=.13:rh=.09:bs=-.15:bm=-.12:bh=-.07,eq=saturation=1.14:brightness=0.02' }, // warm grade
    { compute: 'glow', params: { strength: 0.4 } }, // soft highlight bloom
    { template: 'vignette=PI/5' },                   // gentle corner falloff (opaque -vf escape)
  ],
};

/**
 * Resolve a named look preset to its ordered effect-node array (or [] for an unknown/absent name). The
 * compositor spreads this into the clip's effect list, so a preset applies its whole multi-effect stack.
 */
export function resolveLookStack(name) {
  const stack = typeof name === 'string' ? LOOK_STACKS[name] : null;
  return Array.isArray(stack) ? stack : [];
}

/**
 * Build the TRANSITION renderer capabilities (the in-between of a cut, rendered as a `dur`-second
 * segment). A transition is self-describing DATA `{renderer, spec|expr|command, script_ref?, duration}`;
 * the compositor dispatches by the `renderer` capability id and never enumerates transition TYPES.
 * These are OUT-OF-PROCESS effects (each runs its own ffmpeg pass and returns a path), so the compositor
 * injects its I/O leaf (trPath, ff, V, A, W, H, FPS, materializeRef, execFileSync); the registry owns no
 * compositor state. `process` shells ANY binary via a DATA command template, so gl-transitions, a
 * RIFE/FILM AI-morph, or a renderer invented tomorrow is a DATA row with zero engine change.
 */
export function createTransitionRenderers({ trPath, ff, V, A, W, H, FPS, materializeRef, execFileSync }) {
  return {
    // (aSeg, bSeg, dur, spec) writes a `dur`-second transition segment (canonical params), returns path.
    // aSeg/bSeg are already-normalized `dur`-second subclips (tail of A, head of B).
    // AUDIO rides the visual crossfade: `acrossfade=d=dur` equal-powers the tail of A into the head of B
    // over the same `dur` window (output len = dur+dur-dur = dur, matching the xfade), so the mix does not
    // go silent during a transition. Every normalized subclip carries a stereo track (real or anullsrc, per
    // video-compose's silent path), so [0:a]/[1:a] always exist and acrossfade never errors.
    xfade(a, b, dur, spec) {
      const out = trPath();
      const type = spec.spec || spec.type || 'fade';
      ff(['-i', a, '-i', b,
        '-filter_complex', `[0:v][1:v]xfade=transition=${type}:duration=${dur}:offset=0[v];[0:a][1:a]acrossfade=d=${dur}[a]`,
        '-map', '[v]', '-map', '[a]', '-t', String(dur), ...V, ...A, out], `xfade ${type}`);
      return out;
    },
    expr(a, b, dur, spec) {
      const out = trPath();
      ff(['-i', a, '-i', b,
        '-filter_complex', `[0:v][1:v]xfade=transition=custom:expr='${spec.expr}':duration=${dur}:offset=0[v];[0:a][1:a]acrossfade=d=${dur}[a]`,
        '-map', '[v]', '-map', '[a]', '-t', String(dur), ...V, ...A, out], 'xfade custom');
      return out;
    },
    process(a, b, dur, spec) {
      const out = trPath();
      const vars = { A: a, B: b, OUT: out, DUR: dur, W, H, FPS };
      // `${SCRIPT}` + a `script_ref` stored-bytes address materializes the shipped transition
      // script (whip-pan / luma-fade / ai-matte) at render time, so command DATA carries no machine path.
      if (spec.script_ref) vars.SCRIPT = materializeRef(spec.script_ref);
      const sub = (s) => String(s).replace(/\$\{(\w+)\}/g, (_, k) => (k in vars ? String(vars[k]) : `\${${k}}`));
      const cmd = (spec.command || []).map(sub);
      if (!cmd.length) throw new Error('[effect-registry] process transition requires a `command` array (DATA)');
      try { execFileSync(cmd[0], cmd.slice(1), { encoding: 'utf8' }); }
      catch (e) { throw new Error(`[effect-registry] process transition '${cmd[0]}' failed: ${e.stderr?.toString().slice(-300) ?? e.message}`); }
      return out;
    },
  };
}

/**
 * #plugin-arch Stage 4: the audio-reactive VISUALIZER producers (a `compute`-style taxonomy). Each maps
 * {rw,rh,color,fps} to an ffmpeg SOURCE-filter string that turns one audio input into a video signal;
 * the compositor keys it on black and overlays it, blind to what it draws. A new visualizer is ONE row
 * here (zero compositor edit); the opaque `viz_filter` escape-hatch (same ${var} seam as a template
 * effect) covers anything not yet a named preset. Pure DATA, so this map has no injected deps.
 */
export const VIZ_PRODUCERS = {
  waveform: ({ rw, rh, color, fps }) => `showwaves=s=${rw}x${rh}:mode=cline:colors=${color}:rate=${fps}`,
  spectrum: ({ rw, rh, fps }) => `showspectrum=s=${rw}x${rh}:mode=combined:color=intensity:scale=cbrt:fps=${fps}`,
  cqt: ({ rw, rh, fps }) => `showcqt=s=${rw}x${rh}:fps=${fps}`,
  bars: ({ rw, rh, color, fps }) => `showfreqs=s=${rw}x${rh}:mode=bar:colors=${color}:rate=${fps}`,
};

/**
 * #plugin-arch Stage 4: the OUT-OF-PROCESS producer taxonomy (denoise / matte / translation). Each is a
 * DATA-selected map of producers the compositor's wrapper fns (denoisePreprocess/matteProduce/translateText)
 * invoke fail-soft; the compositor stays blind to WHICH engine runs. The registry owns the taxonomy, the
 * compositor injects its process leaf (execFileSync) and path leaf (PKG_ROOT, join). Adding a denoiser,
 * a segmentation model, or a translator is ONE row here (or a `command`/`bin` DATA field), zero engine edit.
 */
export function createEffectProducers({ execFileSync, PKG_ROOT, join }) {
  const MATTE_PY = process.env.SEGMENT_MATTE_PY || '/opt/homebrew/anaconda3/bin/python3';
  const MATTE_SCRIPT = join(PKG_ROOT, 'do-work', 'segment-person-matte.py');
  return {
    denoise: {
      deepfilternet: {
        bin: process.env.DEEPFILTER_BIN || 'deepFilter',
        // DeepFilterNet writes `<stem>_<ModelName>.wav`; the installed model is DeepFilterNet3
        // (DATA, overridable via DEEPFILTER_MODEL) so the output name is deterministic, no scan.
        run: (bin, inWav, outDir) => execFileSync(bin, [inWav, '-o', outDir], { encoding: 'utf8' }),
        cleanedName: (stem) => `${stem}_${process.env.DEEPFILTER_MODEL || 'DeepFilterNet3'}.wav`,
      },
    },
    // producer key -> rembg model name (3rd script arg). Adding a producer is a new row here, not a change
    // to the composite, which just alphamerges whatever matte it is handed (L069).
    matte: {
      person: { bin: MATTE_PY, script: MATTE_SCRIPT, args: ['u2net_human_seg'] },
      salient: { bin: MATTE_PY, script: MATTE_SCRIPT, args: ['u2netp'] },
    },
    translation: {
      // Offline, deterministic, network-free: a phrase/word glossary carried inline as DATA. Whole-string
      // hit first, else word-by-word (unknown words pass through). Proves the DATA->drawtext flow.
      glossary: (text, _to, cfg) => {
        const g = cfg?.glossary ?? {};
        if (Object.prototype.hasOwnProperty.call(g, text)) return String(g[text]);
        const hit = { any: false };
        const out = text.split(/(\s+)/).map((tok) => {
          const k = tok.toLowerCase();
          if (Object.prototype.hasOwnProperty.call(g, k)) { hit.any = true; return String(g[k]); }
          return tok;
        }).join('');
        return hit.any ? out : null;
      },
      // Real offline engine: the argos-translate CLI (a producer command). The binary is DATA (`cfg.bin`)
      // or the `MEDIA_ARGOS_BIN` env (mirrors the matte producer's SEGMENT_MATTE_PY), defaulting to the
      // one on PATH; a machine path never enters source. Absent/failing -> fail-soft to original.
      argos: (text, to, cfg) => execFileSync(cfg?.bin ?? process.env.MEDIA_ARGOS_BIN ?? 'argos-translate', ['--from-lang', cfg?.from ?? 'en', '--to-lang', to, text], { encoding: 'utf8' }).trim(),
    },
  };
}

/**
 * #plugin-arch Stage 5: the STABILIZE (#85) PROCESS effect. vidstab is 2-pass: pass 1 (vidstabdetect)
 * analyzes the SEEKED source in forward order and writes a .trf transforms file; pass 2 (vidstabtransform,
 * added as the FIRST video filter) consumes it. Because pass 1 shells an ffmpeg detect pass, this is a
 * `process` capability (not a template node) that the compositor resolves IN PLACE where the flat block was
 * (L179). The compositor injects its I/O leaf (ff, T, join, execFileSync) so the registry owns no compositor
 * state. Fail-soft: on any detect error return null so the clip renders un-stabilized (never a hard crash).
 * `resolve(segment, seek)` returns the vidstabtransform fragment or null.
 */
export function createStabilizeEffect({ ff, T, join, execFileSync }) {
  return {
    resolve(segment, seek) {
      let trf;
      try {
        trf = join(T, `stab-${segment.id}.trf`);
        const shk = Number.isFinite(segment.stabilize_shakiness) ? Math.max(1, Math.min(10, Math.round(segment.stabilize_shakiness))) : 8;
        ff([...seek, '-i', segment.source, '-vf', `vidstabdetect=shakiness=${shk}:result=${trf}`, '-f', 'null', '-'], `stabilize-detect ${segment.id}`);
        execFileSync('test', ['-f', trf]);
      } catch (e) {
        console.error(`[video.compose] stabilize detect failed for clip ${segment.id}, keeping original frames:`, e?.message ?? e);
        return null;
      }
      const smoothing = Number.isFinite(segment.stabilize_smoothing) ? Math.max(1, Math.round(segment.stabilize_smoothing)) : 10;
      return `vidstabtransform=input=${trf}:smoothing=${smoothing}:crop=black`;
    },
  };
}

/**
 * #plugin-arch Stage 5: a `compute` effect capability. `color_adjust` (the CapCut "Adjust" / Lumetri-basic
 * daily driver) composes an `eq=` fragment from {brightness,contrast,saturation,gamma}, emitting only
 * non-identity terms. The COMPUTATION now lives in the registry (the compositor no longer builds the eq
 * inline); it stays a pure leaf (the caller injects its `round3`), returns the fragment or null (nothing to
 * do). A new manual-adjust term is one line here, and the compositor resolves + pushes it in place (order
 * is the vf-chain push order, so no ordering concern).
 */
export function colorAdjustFragment(params, { round3 }) {
  const eq = [];
  if (Number.isFinite(params.brightness) && params.brightness !== 0) eq.push(`brightness=${round3(params.brightness)}`);
  if (Number.isFinite(params.contrast) && params.contrast !== 1) eq.push(`contrast=${round3(params.contrast)}`);
  if (Number.isFinite(params.saturation) && params.saturation !== 1) eq.push(`saturation=${round3(params.saturation)}`);
  if (Number.isFinite(params.gamma) && params.gamma > 0 && params.gamma !== 1) eq.push(`gamma=${round3(params.gamma)}`);
  return eq.length ? `eq=${eq.join(':')}` : null;
}

/**
 * #plugin-arch Stage 5: the COMPUTE-EFFECT taxonomy (a map keyed by effect id, the L069 twin of
 * createKeyframeEffects / VIZ_PRODUCERS / createTransitionRenderers). Each entry takes the effect's DATA
 * params and returns an ffmpeg fragment string, an array of fragments, or null (nothing to emit). The
 * compositor resolves `computeEffects[id](params)` and pushes the result IN PLACE (L179: vParts is the
 * ordered -vf list, so order is the push order, no ordering concern). The compositor no longer owns the
 * eq/drawbox/geq math; a new manual-adjust / letterbox / scrim knob is one entry here. Deps (round3, W, H,
 * safeColor, colorToRgb255) are injected so this module owns no compositor state.
 */
export function createComputeEffects({ round3, W, H, safeColor, colorToRgb255, fpsNum, FPS }) {
  return {
    // #95 smooth slow-mo: motion-compensated optical-flow interpolation (DaVinci Optical Flow / Twixtor).
    // A fixed graph at the raw FPS string; the compositor owns the `speed<1 && speed_smooth` gate.
    smooth_motion: () => `minterpolate=fps=${FPS}:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1`,
    // #171 hue rotation: spin the color wheel `degrees` (static) + optional `cycleRate` (deg/sec animated
    // rainbow, h='<deg>+/-<rate>*t'); `saturation` scales chroma (1 unchanged). All clamped+round3'd so
    // the h/s expressions carry NO free text (injection-safe). Returns the hue= fragment, or null (neutral).
    hue_shift: (hs) => {
      const deg = round3(Math.max(-360, Math.min(360, Number(hs.degrees) || 0)));
      const rate = round3(Math.max(-720, Math.min(720, Number(hs.cycleRate) || 0)));
      const sat = hs.saturation === undefined ? 1 : round3(Math.max(0, Math.min(3, Number(hs.saturation) || 0)));
      const hExpr = rate !== 0 ? `${deg}${rate >= 0 ? '+' : '-'}${Math.abs(rate)}*t` : String(deg);
      return (deg !== 0 || rate !== 0 || sat !== 1) ? `hue=h='${hExpr}':s=${sat}` : null;
    },
    // #202 echo / reverb (AUDIO): add spatial depth by mixing delayed copies of the clip audio (a two-tap
    // ffmpeg aecho). `amount` 0..1 scales the wet decay (louder, longer tail); `delayMs` 20..1000 (default
    // 250) sets the tap spacing (short = slap-back, long = cavern). This is the missing ADD half of the
    // audio catalog: the `de-reverb` preset REMOVES room, nothing added it. Numeric-only (clamp+round3), so
    // the aecho args carry NO free text (injection-safe). Returns the aecho fragment, or null at zero amount.
    echo: (e) => {
      const amount = round3(Math.min(1, Math.max(0, Number(e.amount) || 0)));
      if (amount <= 0) return null;
      const d = Math.round(Math.min(1000, Math.max(20, Number(e.delayMs) || 250)));
      const decay = round3(0.2 + amount * 0.65); // 0.2..0.85 wet feedback
      const decay2 = round3(decay * 0.6);        // the second (quieter) tap
      return `aecho=0.8:0.88:${d}|${2 * d}:${decay}|${decay2}`;
    },
    // #124 border/frame: a solid colored border inside the clip edges (drawbox thickness). `width` px at
    // canvas scale; color sanitized to ffmpeg color chars (name/0xRRGGBB/#RRGGBB/name@alpha), blind (L090).
    // The compositor owns the `border.width > 0` gate; this entry owns the fragment.
    border: (b) => {
      const bw = Math.round(b.width);
      const color = (typeof b.color === 'string' ? b.color : '').match(/^[A-Za-z0-9#@.]+$/) ? b.color : 'white';
      return `drawbox=x=0:y=0:w=iw:h=ih:t=${bw}:color=${color}`;
    },
    // #78 clip-level chroma key: apply the opaque key filter then flatten to black (a standalone spine clip
    // has no layer behind it, so the keyed color reads as black). `k` is the opaque key filter string (L090).
    chroma_key: (k) => `${k.trim()},format=yuv420p`,
    // edge fades: the VIDEO -vf half only (the compositor keeps the paired afade on the audio chain).
    // #<edge-fade> in-fade from black over `s` seconds from clip start.
    fade_in: (s) => `fade=t=in:st=0:d=${round3(s)}`,
    // out-fade to black starting at `st` (pre-computed against the REMAPPED end for #102 velocity ramps).
    fade_out: (st, s) => `fade=t=out:st=${st}:d=${round3(s)}`,
    // #76 freeze-frame / hold: clone the first (`start`) or last (`stop`) frame for `dur` seconds. VIDEO
    // half only (the compositor keeps the paired adelay/apad audio hold). `mode` is 'start' | 'stop'.
    freeze: (mode, dur) => `tpad=${mode}_mode=clone:${mode}_duration=${dur}`,
    // burned-in timer HUD: `elapsed` (%{pts:hms}) or `countdown` (ceil(D-t) via %{eif}). Corner via the
    // pad->pixel mapping; color safeColor'd (injection-safe, L090). `timing` = {duration,out,in} resolves
    // the countdown duration. The %{...} token needs BOTH quotes AND escaped colons/commas for the -vf join.
    timer: (tm, timing) => {
      const tsize = Math.max(16, Math.min(H, Math.round(Number.isFinite(tm.size) && tm.size > 0 ? tm.size : H * 0.08)));
      const tcolor = safeColor(tm.color, 'white');
      const tpad = Math.round(H * 0.03);
      const TCORNER = { tl: [0, 0], tr: [1, 0], bl: [0, 1], br: [1, 1] };
      const [tfx, tfy] = TCORNER[tm.corner] || [1, 0];
      const tx = `${tpad}+(w-text_w-${2 * tpad})*${tfx}`;
      const ty = `${tpad}+(h-text_h-${2 * tpad})*${tfy}`;
      const tDur = Number.isFinite(timing.duration) && timing.duration > 0
        ? timing.duration
        : (Number.isFinite(timing.out) && Number.isFinite(timing.in) && timing.out > timing.in ? timing.out - timing.in : null);
      const text = tm.mode === 'countdown' && tDur !== null
        ? `%{eif\\:max(0\\,ceil(${round3(tDur)}-t))\\:d}`
        : `%{pts\\:hms}`;
      return `drawtext=text='${text}':expansion=normal:x=${tx}:y=${ty}:fontsize=${tsize}:fontcolor=${tcolor}:box=1:boxcolor=black@0.5:boxborderw=${Math.round(tsize * 0.3)}`;
    },
    // #126 framed clip (Screen Studio / CleanShot look): shrink the finished clip to `scale` and center it
    // on a background. background 'blur' fills the bars with a blurred zoomed copy; any other value is a
    // solid pad color (sanitized). Even dims for yuv420p. The compositor owns the 0<scale<1 gate.
    frame: (f) => {
      const sw = Math.max(2, Math.round((W * f.scale) / 2) * 2); // even dims for yuv420p
      const sh = Math.max(2, Math.round((H * f.scale) / 2) * 2);
      const bg = typeof f.background === 'string' ? f.background.trim() : '';
      if (bg === 'blur') {
        return `split=2[frbg][frfg];[frbg]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},gblur=sigma=20[frbgb];[frfg]scale=${sw}:${sh}[frfgb];[frbgb][frfgb]overlay=(W-w)/2:(H-h)/2`;
      }
      const color = bg.match(/^[A-Za-z0-9#@.]+$/) ? bg : 'black';
      return `scale=${sw}:${sh},pad=${W}:${H}:(${W}-iw)/2:(${H}-ih)/2:color=${color}`;
    },
    // #143 animated progress bar: a colored edge band that fills left-to-right over the clip (per-frame geq
    // single-color-replace, T-in-geq). #145 optional chapter markers drawn ON TOP. `timing`={duration,out,in}
    // resolves the display length D. Returns the geq fragment, or null when D can't be resolved. Blind (L090).
    progress_bar: (pb, timing) => {
      const pbH = Math.max(1, Math.round(H * Math.min(1, Math.max(0, Number(pb.height)))));
      const [pr, pg, pbl] = colorToRgb255(pb.color);
      const pbDur = Number.isFinite(timing.duration) && timing.duration > 0
        ? timing.duration
        : (Number.isFinite(timing.out) && Number.isFinite(timing.in) && timing.out > timing.in ? timing.out - timing.in : null);
      if (pbDur === null) return null;
      const band = pb.edge === 'top' ? `lt(Y\\,${pbH})` : `gt(Y\\,H-${pbH})`;
      const isBar = `${band}*lt(X\\,W*T/${round3(pbDur)})`;
      const markers = Array.isArray(pb.markers) ? pb.markers.filter((m) => Number.isFinite(m)) : [];
      let redF, greenF, blueF;
      if (markers.length > 0) {
        const tw = Math.max(2, Math.round(W * 0.006));
        const [mr, mg, mb] = colorToRgb255(pb.markerColor);
        const near = markers.map((m) => `lt(abs(X-${Math.round(W * Math.min(1, Math.max(0, m)))})\\,${tw})`).join('+');
        const isTick = `${band}*gt(${near}\\,0)`;
        redF = `if(${isTick}\\,${mr}\\,if(${isBar}\\,${pr}\\,r(X\\,Y)))`;
        greenF = `if(${isTick}\\,${mg}\\,if(${isBar}\\,${pg}\\,g(X\\,Y)))`;
        blueF = `if(${isTick}\\,${mb}\\,if(${isBar}\\,${pbl}\\,b(X\\,Y)))`;
      } else {
        redF = `if(${isBar}\\,${pr}\\,r(X\\,Y))`;
        greenF = `if(${isBar}\\,${pg}\\,g(X\\,Y))`;
        blueF = `if(${isBar}\\,${pbl}\\,b(X\\,Y))`;
      }
      return `format=rgb24,geq=r='${redF}':g='${greenF}':b='${blueF}',format=yuv420p`;
    },
    // #147 countdown ring: a circular arc HUD sweeping clockwise from 12 o'clock (the story/intro countdown a
    // LINEAR bar can't express). POLAR geq: a pixel is on the ring iff its distance from center is in [R-w,R+w]
    // AND its clockwise angle-from-top <= the swept fraction. `fill` grows (elapsed), else `deplete` shrinks
    // (default). radius/thickness are fractions of the short side. Returns the geq, or null when D unresolved.
    countdown_ring: (cr, timing) => {
      const crDur = Number.isFinite(timing.duration) && timing.duration > 0
        ? timing.duration
        : (Number.isFinite(timing.out) && Number.isFinite(timing.in) && timing.out > timing.in ? timing.out - timing.in : null);
      if (crDur === null) return null;
      const minWH = Math.min(W, H);
      const R = round3(minWH * Math.min(0.5, Math.max(0.02, Number.isFinite(cr.radius) && cr.radius > 0 ? cr.radius : 0.3)));
      const rw = round3(minWH * Math.min(0.2, Math.max(0.004, Number.isFinite(cr.thickness) && cr.thickness > 0 ? cr.thickness : 0.03)));
      const rcx = round3(W * Math.min(1, Math.max(0, Number.isFinite(cr.x) ? cr.x : 0.5)));
      const rcy = round3(H * Math.min(1, Math.max(0, Number.isFinite(cr.y) ? cr.y : 0.5)));
      const [rr, rg, rb] = colorToRgb255(cr.color);
      const ang = `mod(atan2(X-${rcx}\\,${rcy}-Y)+2*PI\\,2*PI)`;
      const prog = cr.mode === 'fill' ? `(T/${round3(crDur)})*2*PI` : `(1-T/${round3(crDur)})*2*PI`;
      const on = `between(hypot(X-${rcx}\\,Y-${rcy})\\,${round3(R - rw)}\\,${round3(R + rw)})*lt(${ang}\\,${prog})`;
      return `format=rgb24,geq=r='if(${on}\\,${rr}\\,r(X\\,Y))':g='if(${on}\\,${rg}\\,g(X\\,Y))':b='if(${on}\\,${rb}\\,b(X\\,Y))',format=yuv420p`;
    },
    // #130 region filter / censor EMIT: assemble the split->crop->opaque-filter->overlay filtergraph for ONE
    // region. `mode` 'outside' = spotlight (filter the whole frame, overlay the untouched crop back on top),
    // else 'inside' = censor (filter only the crop). `op` (opacity fade expr) triggers a per-frame blend of
    // the original vs filtered; `moving` (path/motion) forces the expression position form. `rf${i}` labels
    // keep each region's pads distinct. Pure string assembly; the compositor owns the region geometry math.
    region_filter: ({ i, mode, moving, op, eff, cw, ch, cx, cy, xE, yE }) => {
      if (mode === 'outside') {
        const bg = op
          ? `split=2[rf${i}b1][rf${i}b2];[rf${i}b2]${eff}[rf${i}d];[rf${i}b1][rf${i}d]blend=all_expr='A*(1-${op})+B*${op}'`
          : eff;
        return `split=2[rf${i}b][rf${i}k];[rf${i}b]${bg}[rf${i}bg];[rf${i}k]crop=${cw}:${ch}:x='${xE}':y='${yE}'[rf${i}orig];[rf${i}bg][rf${i}orig]overlay=x='${xE}':y='${yE}'`;
      }
      const obscure = op
        ? `split=2[rf${i}c1][rf${i}c2];[rf${i}c2]${eff}[rf${i}filt];[rf${i}c1][rf${i}filt]blend=all_expr='A*(1-${op})+B*${op}'`
        : eff;
      if (!moving && !op) {
        return `split=2[rf${i}k][rf${i}r];[rf${i}r]crop=${cw}:${ch}:${cx}:${cy},${eff}[rf${i}o];[rf${i}k][rf${i}o]overlay=${cx}:${cy}`;
      }
      return `split=2[rf${i}k][rf${i}r];[rf${i}r]crop=${cw}:${ch}:x='${xE}':y='${yE}',${obscure}[rf${i}o];[rf${i}k][rf${i}o]overlay=x='${xE}':y='${yE}'`;
    },
    // #125 spotlight / positioned radial focus: a POSITIONED vignette (x0/y0 accept w/h exprs) that darkens
    // the frame away from a chosen center. #154 an optional keyframed `track` (>=2 pts) moves the focus over
    // the clip, piecewise-linearly interpolated in clip-local seconds (needs `timing` to resolve the length);
    // without a valid track the center is the static cx/cy (one render path, L069). Commas escaped for the -vf.
    spotlight: (spot, timing) => {
      const cx = round3(Math.min(1, Math.max(0, Number(spot.cx) || 0.5)));
      const cy = round3(Math.min(1, Math.max(0, Number(spot.cy) || 0.5)));
      const strength = Math.min(1, spot.strength);
      const aBase = round3(0.4 + strength * 1.1); // 0.4..1.5 rad; larger = darker edges
      // #201 breathing focus: a positive `pulse` (cycles/sec) sinusoidally modulates the falloff ANGLE
      // over time (amplitude scales with strength), so the spotlight throbs, the tension/heartbeat move
      // #154 could not do (it animates POSITION, this animates the DEPTH of the darkening). Every value
      // is numeric+round3'd (injection-safe); the a= expression needs eval=frame. pulse 0 = the existing
      // static angle. Composes with the static center AND the #154 moving-focus (track) path.
      const pulse = round3(Math.min(10, Math.max(0, Number(spot.pulse) || 0)));
      const amp = round3(0.30 * strength);
      const w = round3(2 * Math.PI * pulse);
      const aExpr = pulse > 0 ? `'${aBase}+${amp}*sin(${w}*t)'` : String(aBase);
      const spotDur = Number.isFinite(timing.duration) && timing.duration > 0
        ? timing.duration
        : (Number.isFinite(timing.out) && Number.isFinite(timing.in) && timing.out > timing.in ? timing.out - timing.in : null);
      const track = Array.isArray(spot.track)
        ? spot.track.filter((p) => p && Number.isFinite(p.at) && Number.isFinite(p.cx) && Number.isFinite(p.cy))
        : [];
      if (track.length >= 2 && spotDur !== null && spotDur > 0) {
        const piecewise = (axis) => {
          const pts = track
            .map((p) => ({ s: round3(Math.min(1, Math.max(0, p.at)) * spotDur), v: round3(Math.min(1, Math.max(0, p[axis]))) }))
            .sort((a, b) => a.s - b.s);
          const lerps = pts.slice(1).map((next, i) => {
            const dt = round3(next.s - pts[i].s) || 0.001;
            return `${pts[i].v}+(t-${pts[i].s})/${dt}*(${round3(next.v - pts[i].v)})`;
          });
          return chooseByThreshold('t', pts.map((p) => p.s), [pts[0].v, ...lerps, pts[pts.length - 1].v], '\\,');
        };
        return `vignette=x0='w*(${piecewise('cx')})':y0='h*(${piecewise('cy')})':a=${aExpr}:eval=frame`;
      }
      const evalArg = pulse > 0 ? ':eval=frame' : '';
      return `vignette=x0=w*${cx}:y0=h*${cy}:a=${aExpr}${evalArg}`;
    },
    // #129 drop shadow (Screen Studio "floating card"): shrink the clip to `scale`, cast a blurred offset dark
    // copy behind it on `background`, overlay the sharp card on top (a self-contained split subgraph, no extra
    // input). #134 optional rounded card corners. color/background sanitized to ffmpeg color chars. Blind (L090).
    drop_shadow: (shadow) => {
      const sw = Math.max(2, Math.round((W * shadow.scale) / 2) * 2); // even dims for yuv420p
      const sh = Math.max(2, Math.round((H * shadow.scale) / 2) * 2);
      const ox = Math.round((W - sw) / 2);
      const oy = Math.round((H - sh) / 2);
      const sx = ox + Math.round(Number(shadow.dx) || 0); // shadow rect top-left = card offset + (dx,dy)
      const sy = oy + Math.round(Number(shadow.dy) || 0);
      const blur = round3(Math.max(0.1, Number(shadow.blur) || 16));
      const shColor = (typeof shadow.color === 'string' ? shadow.color : '').match(/^[A-Za-z0-9#@.]+$/) ? shadow.color : 'black';
      const bgColor = (typeof shadow.background === 'string' ? shadow.background : '').match(/^[A-Za-z0-9#@.]+$/) ? shadow.background : 'white';
      const cr = Number.isFinite(shadow.cornerRadius) ? Math.min(0.5, Math.max(0, shadow.cornerRadius)) : 0;
      let cardChain = `[dscard]scale=${sw}:${sh}`;
      if (cr > 0) {
        const cR = Math.max(1, Math.round(cr * Math.min(sw, sh)));
        const [cbr, cbg, cbb] = colorToRgb255(bgColor);
        const cdx = `max(${cR}-min(X\\,W-1-X)\\,0)`;
        const cdy = `max(${cR}-min(Y\\,H-1-Y)\\,0)`;
        const cOut = `gt(${cdx}\\,0)*gt(${cdy}\\,0)*gt(pow(${cdx}\\,2)+pow(${cdy}\\,2)\\,${cR}*${cR})`;
        cardChain += `,format=rgb24,geq=r='if(${cOut}\\,${cbr}\\,r(X\\,Y))':g='if(${cOut}\\,${cbg}\\,g(X\\,Y))':b='if(${cOut}\\,${cbb}\\,b(X\\,Y))',format=yuv420p`;
      }
      return `split=2[dscard][dssh];[dssh]scale=${sw}:${sh},drawbox=x=0:y=0:w=iw:h=ih:color=${shColor}:t=fill,` +
        `pad=${W}:${H}:${sx}:${sy}:color=${bgColor},gblur=sigma=${blur}[dsshl];` +
        `${cardChain}[dscd];[dsshl][dscd]overlay=${ox}:${oy}`;
    },
    // #128 rounded corners (Arc "beautiful card" finisher): round the final frame, filling the four cut corners
    // with `background` via a per-pixel geq single-color replace (no alpha/extra input). #133 optional feather
    // softens the corner arc. R (px) = radius(0..0.5)*min(W,H). bg parsed to RGB ints (injection-safe, L090).
    rounded_corners: (rounded) => {
      const R = Math.max(1, Math.round(Math.min(0.5, rounded.radius) * Math.min(W, H)));
      const [br, bgc, bb] = colorToRgb255(rounded.background);
      const dx = `max(${R}-min(X\\,W-1-X)\\,0)`;
      const dy = `max(${R}-min(Y\\,H-1-Y)\\,0)`;
      const feather = Number.isFinite(rounded.feather) ? Math.min(1, Math.max(0, rounded.feather)) : 0;
      if (feather > 0) {
        const inner = round3(R * (1 - feather));
        const denom = round3(Math.max(0.0001, R - inner));
        const cd = `sqrt(pow(${dx}\\,2)+pow(${dy}\\,2))`;
        const f = `gt(${dx}\\,0)*gt(${dy}\\,0)*min(1\\,max((${cd}-${inner})/${denom}\\,0))`;
        return `format=rgb24,geq=r='r(X\\,Y)*(1-${f})+${br}*${f}':g='g(X\\,Y)*(1-${f})+${bgc}*${f}':b='b(X\\,Y)*(1-${f})+${bb}*${f}',format=yuv420p`;
      }
      const outside = `gt(${dx}\\,0)*gt(${dy}\\,0)*gt(pow(${dx}\\,2)+pow(${dy}\\,2)\\,${R}*${R})`;
      return `format=rgb24,geq=r='if(${outside}\\,${br}\\,r(X\\,Y))':g='if(${outside}\\,${bgc}\\,g(X\\,Y))':b='if(${outside}\\,${bb}\\,b(X\\,Y))',format=yuv420p`;
    },
    // #131 ellipse / circle mask: show the clip through an ellipse and fill OUTSIDE with `background` (same geq
    // single-color-replace family as #128). #135 optional animated iris reveal scales the radii by a time factor
    // over [start,start+duration]. #132 optional feather softens the edge. bg parsed to RGB ints (L090).
    ellipse_mask: (ellipse) => {
      const c01 = (v, d) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : d);
      const CX = round3(c01(ellipse.cx, 0.5) * W);
      const CY = round3(c01(ellipse.cy, 0.5) * H);
      const RX = Math.max(1, round3(c01(ellipse.rx, 0.5) * W));
      const RY = Math.max(1, round3(c01(ellipse.ry, 0.5) * H));
      const [er, eg, eb] = colorToRgb255(ellipse.background);
      const feather = c01(ellipse.feather, 0);
      const rev = ellipse.reveal && typeof ellipse.reveal === 'object' ? ellipse.reveal : null;
      let RXs = String(RX);
      let RYs = String(RY);
      if (rev && Number.isFinite(rev.duration) && rev.duration > 0) {
        const from = round3(Math.max(0, Number(rev.from) || 0));
        const to = round3(Math.max(0, Number(rev.to) || 0));
        const start = round3(Math.max(0, Number(rev.start) || 0));
        const dur = round3(rev.duration);
        const fact = `max((min(1\\,max((T-${start})/${dur}\\,0))*(${to}-${from})+${from})\\,0.02)`;
        RXs = `(${RX}*${fact})`;
        RYs = `(${RY}*${fact})`;
      }
      const d2 = `pow((X-${CX})/${RXs}\\,2)+pow((Y-${CY})/${RYs}\\,2)`;
      if (feather > 0) {
        const t0 = round3((1 - feather) * (1 - feather));
        const denom = round3(Math.max(0.0001, 1 - t0));
        const f = `min(1\\,max((${d2}-${t0})/${denom}\\,0))`;
        return `format=rgb24,geq=r='r(X\\,Y)*(1-${f})+${er}*${f}':g='g(X\\,Y)*(1-${f})+${eg}*${f}':b='b(X\\,Y)*(1-${f})+${eb}*${f}',format=yuv420p`;
      }
      const out = `gt(${d2}\\,1)`;
      return `format=rgb24,geq=r='if(${out}\\,${er}\\,r(X\\,Y))':g='if(${out}\\,${eg}\\,g(X\\,Y))':b='if(${out}\\,${eb}\\,b(X\\,Y))',format=yuv420p`;
    },
    // #121 manual color adjustment -> eq= of non-identity terms (or null).
    color_adjust: (p) => colorAdjustFragment(p, { round3 }),
    // #149 letterbox / cinematic bars: solid bars to a target aspect (top/bottom if wider, left/right if
    // taller). Returns 0, or 2 drawbox fragments. Bar thickness is computed from the frame ratio vs target.
    letterbox: (p) => {
      const targetAR = Number.isFinite(p.aspect) && p.aspect > 0 ? p.aspect : 2.39;
      const frameAR = W / H;
      const color = safeColor(p.color, 'black');
      if (targetAR >= frameAR) {
        const bar = Math.round((H - W / targetAR) / 2);
        return bar > 0 ? [`drawbox=x=0:y=0:w=iw:h=${bar}:color=${color}:t=fill`, `drawbox=x=0:y=ih-${bar}:w=iw:h=${bar}:color=${color}:t=fill`] : [];
      }
      const bar = Math.round((W - H * targetAR) / 2);
      return bar > 0 ? [`drawbox=x=0:y=0:w=${bar}:h=ih:color=${color}:t=fill`, `drawbox=x=iw-${bar}:y=0:w=${bar}:h=ih:color=${color}:t=fill`] : [];
    },
    // #152 gradient scrim: a per-pixel blend toward the scrim color with opacity A = strength*ramp, ramp a
    // linear edge gradient. geq time-independent; commas escaped \\, for the filtergraph. Returns one geq.
    scrim: (p) => {
      const s = round3(Math.min(1, Math.max(0, Number.isFinite(p.strength) ? p.strength : 0.6)));
      const RAMP = { top: '(1-Y/H)', bottom: 'Y/H', left: '(1-X/W)', right: 'X/W' };
      const ramp = RAMP[p.edge] || RAMP.bottom;
      const [r, g, b] = colorToRgb255(p.color);
      const A = `${s}*${ramp}`;
      return `format=rgb24,geq=r='r(X\\,Y)*(1-${A})+${r}*(${A})':g='g(X\\,Y)*(1-${A})+${g}*(${A})':b='b(X\\,Y)*(1-${A})+${b}*(${A})',format=yuv420p`;
    },
    // #136 split-tone color grade (cinematic 3-way color wheels): shift RGB balance of shadows/mids/
    // highlights independently via colorbalance. Each param clamped -1..1; only nonzero channels emitted;
    // null when the whole grade is neutral. `p` is the split_tone object {shadows,mids,highlights}.
    split_tone: (p) => {
      const cb = [];
      const push = (band, prefix) => {
        const bnd = band && typeof band === 'object' ? band : null;
        if (!bnd) return;
        for (const [ch, key] of [['r', 'r'], ['g', 'g'], ['b', 'b']]) {
          const v = Number(bnd[ch]);
          if (Number.isFinite(v) && v !== 0) cb.push(`${key}${prefix}=${round3(Math.min(1, Math.max(-1, v)))}`);
        }
      };
      push(p.shadows, 's');
      push(p.mids, 'm');
      push(p.highlights, 'h');
      return cb.length ? `colorbalance=${cb.join(':')}` : null;
    },
    // #122 self-glow / bloom: split the stream, heavily blur one copy, SCREEN-blend it back so only
    // highlights bloom. `p.strength` (0..1, the glow_strength) scales blur spread (4..20) and bloom
    // intensity (0.25..0.8). Returns the self-contained split/blend graph fragment. The compositor owns
    // the `segment.glow === true` gate; this entry owns the fragment math.
    glow: (p) => {
      const gs = Number.isFinite(p.strength) ? Math.min(1, Math.max(0, p.strength)) : 0.5;
      const sigma = round3(4 + gs * 16); // 4..20 blur spread
      const opacity = round3(0.25 + gs * 0.55); // 0.25..0.8 bloom intensity
      return `split=2[glowbase][glowsrc];[glowsrc]gblur=sigma=${sigma}[glowblur];[glowbase][glowblur]blend=all_mode=screen:all_opacity=${opacity}`;
    },
    // #123 sharpen: unsharp mask on luma; `amount` (segment.sharpen 0..1) scales the luma amount 0..2.
    sharpen: (p) => { const amount = typeof p === 'number' ? p : Number(p && p.amount); return `unsharp=5:5:${round3(Math.min(1, amount) * 2)}`; },
    // #146 camera-shake: an animated crop inset window (organic, non-circular via an irrational x/y ratio).
    camera_shake: (p) => {
      const m = round3(Math.min(0.2, Math.max(0, p.amplitude)));
      const fx = round3(Number.isFinite(p.frequency) && p.frequency > 0 ? p.frequency : 8);
      const fy = round3(fx * 1.37); // an irrational-ish ratio so x/y never re-sync (organic, non-circular)
      const decay = Number.isFinite(p.decay) && p.decay > 0 ? round3(p.decay) : 0;
      const env = decay > 0 ? `max(0\\,1-${decay}*t)` : '1';
      const xE = `iw*(${m}+${m}*(${env})*sin(2*PI*${fx}*t))`;
      const yE = `ih*(${m}+${m}*(${env})*cos(2*PI*${fy}*t))`;
      return `crop=w=iw*${round3(1 - 2 * m)}:h=ih*${round3(1 - 2 * m)}:x='${xE}':y='${yE}'`;
    },
    // motion_blur: frame-blend (tmix) the last N frames; `frames` (motion_blur_frames) default 3, min 2.
    motion_blur: (p) => { const frames = typeof p === 'number' ? p : (p && p.frames); return `tmix=frames=${Number.isFinite(frames) && frames >= 2 ? Math.round(frames) : 3}`; },
    // #156 trails: exponential temporal persistence (lagfun); `decay` clamped 0.5..0.98.
    trails: (p) => { const decay = typeof p === 'number' ? p : (p && p.decay); return `format=rgb24,lagfun=decay=${round3(Math.min(0.98, Math.max(0.5, decay)))},format=yuv420p`; },
    // #157 wobble: per-frame sinusoidal horizontal displacement (underwater / dream / heat-haze); needs H.
    wobble: (p) => {
      const amp = round3(Math.min(H / 4, p.amplitude));
      const freq = Number.isFinite(p.frequency) && p.frequency > 0 ? p.frequency : 3;
      const wl = round3(H / freq);
      const speed = Number.isFinite(p.speed) && p.speed >= 0 ? round3(p.speed) : 0.5;
      const disp = `${amp}*sin(2*PI*(Y/${wl}+${speed}*T))`;
      const sx = `min(W-1\\,max(0\\,X+${disp}))`;
      return `format=rgb24,geq=r='r(${sx}\\,Y)':g='g(${sx}\\,Y)':b='b(${sx}\\,Y)',format=yuv420p`;
    },
    // #153 highlight-sweep: a translucent colored box over {x,y,w,h} that WIPES left-to-right over
    // [start,start+duration]. Takes ONE highlight object; the compositor composites the effective list.
    highlight_sweep: (hl) => {
      const bx = Math.round(W * Math.min(1, Math.max(0, hl.x)));
      const by = Math.round(H * Math.min(1, Math.max(0, hl.y)));
      const bw = Math.round(W * Math.min(1, hl.w));
      const bh = Math.round(H * Math.min(1, hl.h));
      const op = round3(Math.min(1, Math.max(0, Number.isFinite(hl.opacity) ? hl.opacity : 0.5)));
      const start = round3(Number.isFinite(hl.start) && hl.start >= 0 ? hl.start : 0);
      const dur = round3(Number.isFinite(hl.duration) && hl.duration > 0 ? hl.duration : 0.4);
      const [hr, hg, hb] = colorToRgb255(hl.color ?? 'yellow');
      const wipeX = `${bx}+${bw}*min(1\\,max(0\\,(T-${start})/${dur}))`;
      const on = `between(X\\,${bx}\\,${bx + bw})*between(Y\\,${by}\\,${by + bh})*lt(X\\,${wipeX})`;
      return `format=rgb24,geq=r='if(${on}\\,r(X\\,Y)*(1-${op})+${hr}*${op}\\,r(X\\,Y))':g='if(${on}\\,g(X\\,Y)*(1-${op})+${hg}*${op}\\,g(X\\,Y))':b='if(${on}\\,b(X\\,Y)*(1-${op})+${hb}*${op}\\,b(X\\,Y))',format=yuv420p`;
    },
    // #158 warmth-ramp: animated white-balance shift; K ramps `from`->`to` over [start,start+dur], red*=(1+K),
    // blue*=(1-K). Takes the warmth_ramp object + the compositor-resolved `dur` (clip-length fallback lives there).
    warmth_ramp: (p, timing = {}) => {
      // dur = the effect's OWN duration field, else the clip display length (timing.duration | out-in).
      // Uniform (params, timing) shape so the ordered-effects list can invoke it like spotlight/timer.
      const dur = Number.isFinite(p.duration) && p.duration > 0
        ? p.duration
        : (Number.isFinite(timing.duration) && timing.duration > 0 ? timing.duration
          : (Number.isFinite(timing.out) && Number.isFinite(timing.in) && timing.out > timing.in ? timing.out - timing.in : null));
      if (dur === null || dur <= 0) return null;
      const from = round3(Math.min(1, Math.max(-1, p.from)));
      const to = round3(Math.min(1, Math.max(-1, p.to)));
      const start = Number.isFinite(p.start) && p.start > 0 ? round3(p.start) : 0;
      const prog = `min(1\\,max(0\\,(T-${start})/${round3(dur)}))`;
      const K = `(${from}+(${round3(to - from)})*${prog})`;
      return `format=rgb24,geq=r='min(255\\,r(X\\,Y)*(1+${K}))':g='g(X\\,Y)':b='min(255\\,b(X\\,Y)*(1-${K}))',format=yuv420p`;
    },
    // #159 strobe: decimate to `rate` fps then restore output fps (held frames). Returns [fps=rate, fps=out].
    strobe: (p) => [`fps=${round3(p.rate)}`, `fps=${fpsNum}`],
    // #160 scanlines (CRT): periodic horizontal darkening; depth/period/roll (roll scrolls over T).
    scanlines: (p) => {
      const depth = round3(Math.min(1, Math.max(0, p.depth)));
      const period = round3(Number.isFinite(p.period) && p.period > 0 ? p.period : 4);
      const roll = round3(Number.isFinite(p.roll) && p.roll >= 0 ? p.roll : 0);
      const att = `(1-${depth}*(0.5+0.5*cos(2*PI*(Y/${period}+${roll}*T))))`;
      return `format=rgb24,geq=r='r(X\\,Y)*${att}':g='g(X\\,Y)*${att}':b='b(X\\,Y)*${att}',format=yuv420p`;
    },
    // #162 posterize: quantize each channel to `levels` discrete steps (step = 255/(levels-1)).
    posterize: (p) => {
      const step = round3(255 / (Math.round(p.levels) - 1));
      const q = (c) => `min(255\\,round(${c}(X\\,Y)/${step})*${step})`;
      return `format=rgb24,geq=r='${q('r')}':g='${q('g')}':b='${q('b')}',format=yuv420p`;
    },
    // #173 solarize: partial per-channel tone inversion ABOVE a threshold (the darkroom / psychedelic look).
    // thr = round(threshold*255); each channel c -> if(c > thr, 255-c, c). Distinct from posterize (quantize)
    // and gradient_map (color remap): this reflects the highlights. One geq, numeric-only (injection-safe).
    solarize: (p) => {
      const thr = round3(Math.min(255, Math.max(0, (Number.isFinite(p.threshold) ? p.threshold : 0.5) * 255)));
      const s = (c) => `if(gt(${c}(X\\,Y)\\,${thr})\\,255-${c}(X\\,Y)\\,${c}(X\\,Y))`;
      return `format=rgb24,geq=r='${s('r')}':g='${s('g')}':b='${s('b')}',format=yuv420p`;
    },
    // #174 pixelate: quantize the whole frame into blockSize-px square blocks (retro 8-bit / mosaic look).
    // Uses ffmpeg's dimension-preserving `pixelize` filter (each block collapses to one averaged color), so
    // no scale-down/up dimension drift on the fixed canvas. blockSize is an integer >= 2 (numeric, injection-safe).
    pixelate: (p) => {
      const n = Math.round(Math.min(256, Math.max(2, Number.isFinite(p.blockSize) ? p.blockSize : 12)));
      return `pixelize=w=${n}:h=${n}`;
    },
    // #175 grain: composable tunable analog film / sensor grain via ffmpeg's `noise` filter (fine per-pixel
    // temporal noise). amount 1..100 -> `alls` strength; a FIXED seed keeps it byte-reproducible (#170) while
    // `allf=t+u` gives even, per-frame grain. Numeric-only (injection-safe). Composes on top of any grade.
    grain: (p) => {
      const n = Math.round(Math.min(100, Math.max(1, Number.isFinite(p.amount) ? p.amount : 20)));
      return `noise=alls=${n}:allf=t+u:all_seed=8675309`;
    },
    // #176 emboss: monochrome relief / engraving via a 3x3 convolution (sum-0 kernel + 128 bias => flat tone
    // maps to mid-gray, edges surface as light/dark relief). `depth` scales the kernel magnitude. Luma-only
    // (format=gray), chroma passed through identity, numeric-only (injection-safe).
    emboss: (p) => {
      const k = Math.min(4, Math.max(0.2, Number.isFinite(p.depth) ? p.depth : 1));
      const a = round3(k), b = round3(2 * k);
      const m = `-${b} -${a} 0 -${a} 0 ${a} 0 ${a} ${b}`;
      const id = '0 0 0 0 1 0 0 0 0';
      return `format=gray,convolution='${m}:${id}:${id}:${id}:1:1:1:1:128:0:0:0',format=yuv420p`;
    },
    // #177 defocus: uniform full-frame gaussian blur (focus pull / out-of-focus). `amount` is the blur radius
    // (sigma), clamped 0.3..40. Numeric-only (injection-safe). The plain isotropic blur none of the other
    // blur effects provide; composes on top of any of them.
    defocus: (p) => {
      const s = round3(Math.min(40, Math.max(0.3, Number.isFinite(p.amount) ? p.amount : 8)));
      return `gblur=sigma=${s}`;
    },
    // #178 fisheye: barrel / pincushion lens distortion via `lenscorrection` (k1 coefficient). strength -1..1:
    // negative bulges outward (barrel/fisheye), positive pinches inward (pincushion). Optical warp - moves
    // pixels, does not recolor. Numeric-only (injection-safe).
    fisheye: (p) => {
      const s = round3(Math.min(1, Math.max(-1, Number.isFinite(p.strength) ? p.strength : -0.4)));
      return `lenscorrection=k1=${s}:k2=0:i=bilinear`;
    },
    // #179 warmth: static white-balance / color-temperature tint via `colortemperature`. amount -1..1 maps to
    // Kelvin (positive => low K => warm/orange, negative => high K => cool/blue; 0 => ~6500K neutral).
    // Numeric-only (injection-safe).
    warmth: (p) => {
      const a = Math.min(1, Math.max(-1, Number.isFinite(p.amount) ? p.amount : 0.5));
      const k = Math.round(6500 - a * 3500); // amount +1 => 3000K (warm), -1 => 10000K (cool)
      return `colortemperature=temperature=${k}`;
    },
    // #180 color splash (selective color): keep one hue, grey the rest, via `colorhold`. The DATA color is
    // sanitized through colorToRgb255 -> a numeric 0xRRGGBB hex (no raw string reaches ffmpeg); similarity
    // 0.01..1 sets the kept hue band. Injection-safe.
    colorSplash: (p) => {
      const [r, g, b] = colorToRgb255(p.color ?? 'red');
      const hex = '0x' + [r, g, b].map((c) => Math.max(0, Math.min(255, Math.round(c))).toString(16).padStart(2, '0')).join('');
      const sim = round3(Math.min(1, Math.max(0.01, Number.isFinite(p.similarity) ? p.similarity : 0.3)));
      return `colorhold=color=${hex}:similarity=${sim}:blend=0`;
    },
    // #181 perspective: keystone trapezoid warp via `perspective` (4 source corners). tilt -1..1: positive
    // pulls the TOP corners inward (top narrower), negative pulls the BOTTOM corners inward. off = |tilt| * 25%
    // of width. Numeric-only (injection-safe). Uses the injected canvas W/H.
    perspective: (p) => {
      const t = round3(Math.min(1, Math.max(-1, Number.isFinite(p.tilt) ? p.tilt : 0.4)));
      const off = Math.round(Math.abs(t) * W * 0.25);
      return t >= 0
        ? `perspective=${off}:0:${W - off}:0:0:${H}:${W}:${H}:interpolation=linear`
        : `perspective=0:0:${W}:0:${off}:${H}:${W - off}:${H}:interpolation=linear`;
    },
    // #182 smooth: edge-PRESERVING light smooth via `smartblur` (a "beauty" / noise-soften). `amount` (0..1)
    // scales luma_strength; the positive luma_threshold protects edges (flats smooth, edges stay). Numeric-only
    // (injection-safe). Distinct from #177 defocus (a full blur) and the heavy out-of-process `denoise` binary.
    smooth: (p) => {
      const s = round3(Math.min(1, Math.max(0.05, Number.isFinite(p.amount) ? p.amount : 0.6)));
      return `smartblur=luma_radius=3:luma_strength=${s}:luma_threshold=18`;
    },
    // #183 directional blur: a single-axis motion streak via `avgblur` (separable box average). `amount` (0..1)
    // scales the blur radius on the chosen axis; `axis` 'h' streaks horizontally (sizeX), 'v' vertically
    // (sizeY), the other axis pinned to 1. Numeric-only radius + a fixed axis keyword (injection-safe).
    // Distinct from #177 defocus (symmetric gblur): this blurs ONE axis, keeping the other sharp.
    directionalBlur: (p) => {
      const r = Math.max(1, Math.round(Math.min(1, Math.max(0, Number.isFinite(p.amount) ? p.amount : 0.6)) * 24));
      return p.axis === 'v' ? `avgblur=sizeX=1:sizeY=${r}` : `avgblur=sizeX=${r}:sizeY=1`;
    },
    // #184 binarize: pure 1-bit black/white at a luma cutoff (the notan / silkscreen stamp look) via a luma LUT,
    // chroma neutralized so the output is grayscale. `cutoff` (0..1) maps to the 0..255 split. Numeric-only
    // (injection-safe). Distinct from #175 posterize (N levels) and #173 solarize (invert above cutoff).
    binarize: (p) => {
      const c = Math.round(Math.min(1, Math.max(0, Number.isFinite(p.cutoff) ? p.cutoff : 0.5)) * 255);
      return `lutyuv=y='if(gt(val,${c}),255,0)':u=128:v=128`;
    },
    // #185 swirl: a rotational twist that is strongest at the center and fades to zero at the edge, via a geq
    // coordinate remap (the same sampling mechanism the beat-glitch/gradient-map effects use). `strength`
    // (-1..1) scales the max twist angle (+-PI); sign is the direction. Numeric-only, internal commas escaped
    // (injection-safe). Distinct from #178 fisheye (radial bulge) and #181 perspective (keystone).
    swirl: (p) => {
      const s = round3(Math.min(1, Math.max(-1, Number.isFinite(p.strength) ? p.strength : 0.6)) * Math.PI);
      const cx = round3(W / 2), cy = round3(H / 2), R = round3(Math.min(W, H) / 2);
      const A = `${s}*max(0\\,1-hypot(X-${cx}\\,Y-${cy})/${R})`;
      const rx = `${cx}+(X-${cx})*cos(${A})-(Y-${cy})*sin(${A})`;
      const ry = `${cy}+(X-${cx})*sin(${A})+(Y-${cy})*cos(${A})`;
      return `format=rgb24,geq=r='r(${rx}\\,${ry})':g='g(${rx}\\,${ry})':b='b(${rx}\\,${ry})',format=yuv420p`;
    },
    // #186 mirror: a kaleidoscope-style self-fold that reflects one half of the frame onto the other, via a geq
    // coordinate remap (no trig, fast). `axis` 'v' folds top onto bottom, else 'h' folds left onto right.
    // Internal commas escaped (injection-safe). Distinct from `flip` (a full flip, not a symmetric fold).
    mirror: (p) => {
      if (p.axis === 'v') {
        const sy = `if(lt(Y\\,${round3(H / 2)})\\,Y\\,${H - 1}-Y)`;
        return `format=rgb24,geq=r='r(X\\,${sy})':g='g(X\\,${sy})':b='b(X\\,${sy})',format=yuv420p`;
      }
      const sx = `if(lt(X\\,${round3(W / 2)})\\,X\\,${W - 1}-X)`;
      return `format=rgb24,geq=r='r(${sx}\\,Y)':g='g(${sx}\\,Y)':b='b(${sx}\\,Y)',format=yuv420p`;
    },
    // #187 tile: repeats the frame in an NxN grid (the kaleidoscope-tile / grid look) via a geq modulo remap
    // (no trig). `count` (2..6) is the grid dimension; each axis samples at count times the frequency. Internal
    // commas escaped (injection-safe). Distinct from #186 mirror (a single reflected fold).
    tile: (p) => {
      const n = Math.max(2, Math.min(6, Math.round(Number.isFinite(p.count) ? p.count : 2)));
      const sx = `mod(X*${n}\\,${W})`, sy = `mod(Y*${n}\\,${H})`;
      return `format=rgb24,geq=r='r(${sx}\\,${sy})':g='g(${sx}\\,${sy})':b='b(${sx}\\,${sy})',format=yuv420p`;
    },
    // #188 invert: photographic negative (flip every tone) via the `negate` filter. A constant string with ZERO
    // DATA interpolation (the safest effect). Distinct from #173 solarize (inverts only above a cutoff).
    invert: () => `negate`,
    // #189 vibrance: nonlinear smart-saturation (boosts muted colors, protects vivid ones) via the native
    // `vibrance` filter. `intensity` clamped -1..1 and round3'd (numeric-only, injection-safe). The nonlinear
    // counterpart to the plain linear saturation control.
    vibrance: (p) => {
      const i = Math.max(-1, Math.min(1, round3(Number.isFinite(p.intensity) ? p.intensity : 0.6)));
      return `vibrance=intensity=${i}`;
    },
    // #190 channel swap: swap two RGB channels via a FIXED colorchannelmixer matrix (the "wrong colors" / alien
    // look). `pair` selects one of 3 constant matrices; no DATA reaches the filter string (injection-safe).
    channelSwap: (p) => {
      const M = {
        rb: 'rr=0:rg=0:rb=1:gr=0:gg=1:gb=0:br=1:bg=0:bb=0',
        rg: 'rr=0:rg=1:rb=0:gr=1:gg=0:gb=0:br=0:bg=0:bb=1',
        gb: 'rr=1:rg=0:rb=0:gr=0:gg=0:gb=1:br=0:bg=1:bb=0',
      };
      const m = M[p.pair === 'rg' ? 'rg' : (p.pair === 'gb' ? 'gb' : 'rb')];
      return `colorchannelmixer=${m}`;
    },
    // #191 exposure: brighten/darken in linear light by N stops via the native `exposure` filter (the
    // exponential Lightroom slider), distinct from the additive linear eq brightness. `stops` clamped -2..2
    // and round3'd (numeric-only, injection-safe).
    exposure: (p) => {
      const s = Math.max(-2, Math.min(2, round3(Number.isFinite(p.stops) ? p.stops : 0.6)));
      return `exposure=exposure=${s}`;
    },
    // #192 shear: parallelogram slant via a geq coordinate remap (no trig). `amount` is parenthesized so a
    // negative value stays a valid expression; internal commas escaped; all 3 channels remapped; rgb24 wrap.
    // axis 'v' slants rows by column, else 'h' slants columns by row. Numeric-only (injection-safe).
    shear: (p) => {
      const a = Math.max(-1, Math.min(1, round3(Number.isFinite(p.amount) ? p.amount : 0.3)));
      if (p.axis === 'v') {
        const cx = round3(W / 2);
        const sy = `Y-(${a})*(X-${cx})`;
        return `format=rgb24,geq=r='r(X\\,${sy})':g='g(X\\,${sy})':b='b(X\\,${sy})',format=yuv420p`;
      }
      const cy = round3(H / 2);
      const sx = `X-(${a})*(Y-${cy})`;
      return `format=rgb24,geq=r='r(${sx}\\,Y)':g='g(${sx}\\,Y)':b='b(${sx}\\,Y)',format=yuv420p`;
    },
    // #193 auto-contrast: histogram equalization via the native `histeq` filter (the auto-levels / enhance
    // look), nonlinear, distinct from a linear contrast scale. `strength` clamped 0..1 and round3'd.
    histeq: (p) => {
      const s = Math.max(0, Math.min(1, round3(Number.isFinite(p.strength) ? p.strength : 0.5)));
      return `histeq=strength=${s}`;
    },
    // #194 morphology: grow ('dilate') or shrink ('erode') bright regions via the native dilation/erosion
    // max/min filters, repeated `amount` times (1..4). coordinates=255 uses all 8 neighbours. Numeric-only.
    morphology: (p) => {
      const n = Math.max(1, Math.min(4, Math.round(Number.isFinite(p.amount) ? p.amount : 2)));
      const f = p.mode === 'erode' ? 'erosion=coordinates=255' : 'dilation=coordinates=255';
      return Array(n).fill(f).join(',');
    },
    // #195 colorize: wash the whole frame toward one hue (keeping luma) via the native `colorize` filter (the
    // blueprint / cyanotype / sepia tint). `hue` 0..360 and `saturation` 0..1 are numeric-only (injection-safe).
    colorize: (p) => {
      const h = (((Math.round(Number.isFinite(p.hue) ? p.hue : 220)) % 360) + 360) % 360;
      const s = Math.max(0, Math.min(1, round3(Number.isFinite(p.strength) ? p.strength : 0.5)));
      return `colorize=hue=${h}:saturation=${s}`;
    },
    // #196 normalize: auto white-balance via the native `normalize` filter at independence 1 (each RGB channel
    // stretched to full range independently, which fixes a color cast + maximizes contrast). `strength` blends
    // toward the corrected frame, clamped 0..1 and round3'd (numeric-only, injection-safe).
    normalize: (p) => {
      const s = Math.max(0, Math.min(1, round3(Number.isFinite(p.strength) ? p.strength : 1)));
      return `normalize=independence=1.0:strength=${s}`;
    },
    // #197 chroma bleed: blur ONLY the chroma planes (luma_radius=0) via boxblur, so the color smears past
    // edges while the luma detail stays sharp (the VHS / anime color-bleed look). `radius` numeric (injection-safe).
    chromaBleed: (p) => {
      const r = Math.max(1, Math.min(40, Math.round(Number.isFinite(p.radius) ? p.radius : 15)));
      return `boxblur=luma_radius=0:luma_power=0:chroma_radius=${r}:chroma_power=1`;
    },
    // #198 RGB split (chromatic glitch): translate the red plane left and the blue plane right by `amount` px
    // via the native rgbashift filter, so the image ghosts into a red/blue double edge (datamosh / anaglyph
    // look). UNIFORM everywhere (distinct from lens_fringe radial fringing and #197 chromaBleed chroma blur).
    // amount is numeric-only (clamped 1..30, rounded); zero free text reaches ffmpeg (injection-safe).
    rgbSplit: (p) => {
      const a = Math.max(1, Math.min(30, Math.round(Number.isFinite(p.amount) ? p.amount : 6)));
      return `rgbashift=rh=-${a}:bh=${a}`;
    },
    // #199 Mono mix (B&W color-filter): weighted monochrome via colorchannelmixer, where every output channel
    // is the SAME weighted sum r*R + g*G + b*B, so the frame becomes gray with a photographer's color filter
    // (red filter brightens reds, darkens sky). Weights are numeric-only (clamped 0..2, round3); zero free
    // text reaches ffmpeg (injection-safe).
    monoMix: (p) => {
      const w = (v) => round3(Math.max(0, Math.min(2, Number.isFinite(v) ? v : 0)));
      const r = w(p.r), g = w(p.g), b = w(p.b);
      return `colorchannelmixer=rr=${r}:rg=${g}:rb=${b}:gr=${r}:gg=${g}:gb=${b}:br=${r}:bg=${g}:bb=${b}`;
    },
    // #200 Faded film (lifted blacks / matte): raise the output black floor on all 3 channels via colorlevels,
    // so pure black becomes gray and the shadows wash out (matte / faded-film look), white unchanged. lift is
    // numeric-only (clamped 0..0.5, round3); zero free text reaches ffmpeg (injection-safe).
    fadedFilm: (p) => {
      const l = round3(Math.max(0, Math.min(0.5, Number.isFinite(p.lift) ? p.lift : 0.15)));
      return `colorlevels=romin=${l}:gomin=${l}:bomin=${l}`;
    },
    // #203 Deband: remove color banding in smooth gradients (skies, shadows, fades) via the native `deband`
    // filter, which finds near-flat pixels whose neighbors differ by less than the threshold and replaces them
    // with a dithered weighted average, so hard visible steps become a continuous ramp. `threshold` (0.00003..0.5,
    // the largest per-channel step still counted as banding) and `range` (1..64px, how far it samples) are
    // numeric-only (clamped, no free text reaches ffmpeg, injection-safe). ONE filter (no comma chain), so it
    // still keyframes through the effect_id envelope seam.
    deband: (p) => {
      const thr = Math.max(0.00003, Math.min(0.5, Number.isFinite(p.threshold) ? p.threshold : 0.02));
      const range = Math.max(1, Math.min(64, Math.round(Number.isFinite(p.range) ? p.range : 16)));
      const t = thr.toFixed(5);
      return `deband=1thr=${t}:2thr=${t}:3thr=${t}:4thr=${t}:range=${range}:blur=1`;
    },
    // #204 Deinterlace: convert interlaced footage (old cameras / broadcast, where each frame interleaves two
    // time-offset fields so horizontal motion shows as comb teeth) to clean progressive frames via ffmpeg's
    // native `yadif`, which rebuilds each missing field by spatial+temporal interpolation. `mode` selects the
    // yadif mode (0 frame, 1 field, 2 frame-nospatial, 3 field-nospatial), clamped 0..3 int. `deint=0` forces
    // every frame (so it also cleans sources not flagged interlaced). Numeric-only (injection-safe).
    deinterlace: (p) => {
      const mode = Math.max(0, Math.min(3, Math.round(Number.isFinite(p.mode) ? p.mode : 0)));
      return `yadif=mode=${mode}:parity=-1:deint=0`;
    },
    // #213 Deflicker: remove temporal brightness FLICKER (timelapse / LED / old-film pulsing) by evening each
    // frame's luminance against a rolling window of `size` neighbouring frames (native ffmpeg `deflicker`).
    // `size` = frames averaged (2..129 int; larger = smoother, more latency). Numeric-only (injection-safe).
    // The temporal twin of the spatial band/contrast fixers: this fixes variation ACROSS frames, not within one.
    deflicker: (p) => {
      const size = Math.max(2, Math.min(129, Math.round(Number.isFinite(p.size) ? p.size : 5)));
      return `deflicker=size=${size}:mode=am`;
    },
    // #222 halation: the warm bloom that spreads from bright HIGHLIGHTS (the film-look staple, distinct from
    // glow/bloom which is a neutral highlight bloom). Extract highlights (curves crush below the cutoff), tint
    // them warm (red kept, green/blue cut), blur to spread the halo, and SCREEN-blend back over the original so
    // only bright areas glow warm. Forced to planar RGB (gbrp) so the warm channel mix means RGB not YUV (a YUV
    // mix injects a purple cast), then back to yuv420p for the rest of the chain. `strength` (0..1) scales the
    // spread, intensity, and how much of the highlight range glows. Numbers only (clamp+round), injection-safe.
    halation: (p) => {
      const gs = Number.isFinite(p.strength) ? Math.min(1, Math.max(0, p.strength)) : 0.5;
      const sigma = round3(8 + gs * 20);          // 8..28 halo spread
      const opacity = round3(0.3 + gs * 0.5);     // 0.3..0.8 halo intensity
      const thr = round3(0.8 - gs * 0.35);        // 0.8..0.45 highlight cutoff (more area glows as strength rises)
      return `format=gbrp,split=2[halb][hals];[hals]curves=all='0/0 ${thr}/0 1/1',colorchannelmixer=rr=1:gg=0.4:bb=0.12,gblur=sigma=${sigma}[halo];[halb][halo]blend=all_mode=screen:all_opacity=${opacity},format=yuv420p`;
    },
    // #172 gradient map: map normalized luma to a MULTI-STOP color ramp (the CapCut / Lumetri / DaVinci
    // "gradient map" tonal grade). `stops` is the DATA list [{at, color}] (>= 2, sorted by the reducer);
    // each output channel is the piecewise-linear blend of the two surrounding stop colors at the pixel's
    // luma, held flat below the first stop and above the last. REPLACES color (the N-stop generalization of
    // #127 duotone). Colors -> RGB ints via colorToRgb255 (injection-safe); at/luma numeric. One geq.
    gradient_map: (gm) => {
      const stops = gm.stops;
      const rgb = stops.map((s) => colorToRgb255(s.color));
      const Lm = '(0.299*r(X\\,Y)+0.587*g(X\\,Y)+0.114*b(X\\,Y))/255';
      const chan = (ci) => {
        const lerps = stops.slice(1).map((next, i) => {
          const a0 = round3(stops[i].at);
          const denom = round3(Math.max(0.0001, round3(next.at) - a0));
          return `${rgb[i][ci]}+(${Lm}-${a0})/${denom}*(${round3(rgb[i + 1][ci] - rgb[i][ci])})`;
        });
        // luma below the first stop holds its colour, at or above the last stop holds the last colour
        return chooseByThreshold(Lm, stops.map((s) => round3(s.at)), [rgb[0][ci], ...lerps, rgb[stops.length - 1][ci]], '\\,');
      };
      return `format=rgb24,geq=r='${chan(0)}':g='${chan(1)}':b='${chan(2)}',format=yuv420p`;
    },
    // #167 zoom-blur: radial zoom streaks by averaging TAPS=8 taps sampled toward a center; spread=0.26*strength.
    zoom_blur: (p) => {
      const s = Math.min(1, Math.max(0, p.strength));
      const spread = round3(0.26 * s);
      const zcx = round3((Number.isFinite(p.cx) ? Math.min(1, Math.max(0, p.cx)) : 0.5) * W);
      const zcy = round3((Number.isFinite(p.cy) ? Math.min(1, Math.max(0, p.cy)) : 0.5) * H);
      const TAPS = 8;
      const chan = (ch) => {
        const terms = [];
        for (let k = 0; k < TAPS; k++) {
          const f = round3(1 - spread * (k / (TAPS - 1)));
          terms.push(`${ch}(min(W-1\\,max(0\\,${zcx}+(X-${zcx})*${f}))\\,min(H-1\\,max(0\\,${zcy}+(Y-${zcy})*${f})))`);
        }
        return `(${terms.join('+')})/${TAPS}`;
      };
      return `format=rgb24,geq=r='${chan('r')}':g='${chan('g')}':b='${chan('b')}',format=yuv420p`;
    },
    // #168 light-leak: a colored radial bloom screen-blended in from a point (film light-leak look).
    light_leak: (p) => {
      const s = round3(Math.min(1, Math.max(0, p.strength)));
      const lx = round3((Number.isFinite(p.x) ? Math.min(1, Math.max(0, p.x)) : 1) * W);
      const ly = round3((Number.isFinite(p.y) ? Math.min(1, Math.max(0, p.y)) : 0) * H);
      const diag = Math.hypot(W, H);
      const radPx = round3((Number.isFinite(p.radius) && p.radius > 0 ? Math.min(1, p.radius) : 0.75) * diag);
      const [lr, lg, lb] = colorToRgb255(p.color || '#ff9628');
      const A = `${s}*max(0\\,1-hypot(X-${lx}\\,Y-${ly})/${radPx})`;
      const scr = (ch, c) => `255-(255-${ch}(X\\,Y))*(255-${c}*(${A}))/255`;
      return `format=rgb24,geq=r='${scr('r', lr)}':g='${scr('g', lg)}':b='${scr('b', lb)}',format=yuv420p`;
    },
    // #161 lens-fringe (radial chromatic aberration): red pushed OUTWARD, blue INWARD, growing to the corners.
    lens_fringe: (p) => {
      const s = round3(Math.min(0.2, p.strength));
      const cx = round3(W / 2); const cy = round3(H / 2);
      const maxr = round3(Math.hypot(W / 2, H / 2));
      const n = `hypot(X-${cx}\\,Y-${cy})/${maxr}`;
      const rx = `min(W-1\\,max(0\\,${cx}+(X-${cx})*(1+${s}*${n})))`;
      const ry = `min(H-1\\,max(0\\,${cy}+(Y-${cy})*(1+${s}*${n})))`;
      const bx = `min(W-1\\,max(0\\,${cx}+(X-${cx})*(1-${s}*${n})))`;
      const by = `min(H-1\\,max(0\\,${cy}+(Y-${cy})*(1-${s}*${n})))`;
      return `format=rgb24,geq=r='r(${rx}\\,${ry})':g='g(X\\,Y)':b='b(${bx}\\,${by})',format=yuv420p`;
    },
    // #163 halftone (comic dot-screen): each `size`-px cell becomes a dot whose area grows as brightness drops.
    halftone: (p) => {
      const cell = Math.round(p.size);
      const lum = `(0.299*r(X\\,Y)+0.587*g(X\\,Y)+0.114*b(X\\,Y))/255`;
      const dist = `hypot(mod(X\\,${cell})-${cell}/2\\,mod(Y\\,${cell})-${cell}/2)/(${cell}/2)`;
      const expr = `if(lt(${dist}\\,1.42*sqrt(max(0\\,1-${lum})))\\,0\\,255)`;
      return `format=rgb24,geq=r='${expr}':g='${expr}':b='${expr}',format=yuv420p`;
    },
    // #164 tilt-shift: keep a horizontal band SHARP and blur above/below via a feathered per-pixel mask.
    tilt_shift: (p) => {
      const center = Math.min(1, Math.max(0, Number.isFinite(p.center) ? p.center : 0.5));
      const half = Math.min(1, Math.max(0, p.height)) / 2;
      const y0 = round3((center - half) * H);
      const y1 = round3((center + half) * H);
      const feaPx = Math.max(1, round3((Number.isFinite(p.feather) ? Math.min(1, p.feather) : 0.1) * H));
      const sigma = round3(Number.isFinite(p.blur) && p.blur > 0 ? p.blur : 8);
      const m = `max(0\\,1-max(0\\,max(${y0}-Y\\,Y-${y1}))/${feaPx})`;
      return `format=rgb24,split[tsSharp][tsSrc];[tsSrc]gblur=sigma=${sigma}[tsBlur];[tsBlur][tsSharp]blend=all_expr='A*(1-(${m}))+B*(${m})',format=yuv420p`;
    },
    // #165 sketch / edge-detect: line-art / cartoon shading via edgedetect; `mode` ALLOWLISTED (Physics of the filter).
    sketch: (p) => {
      const MODES = new Set(['colormix', 'canny', 'wires']);
      const skMode = MODES.has(String(p.mode)) ? String(p.mode) : 'colormix';
      const skStrength = Math.min(1, Math.max(0, Number.isFinite(p.strength) ? p.strength : 0.5));
      const low = round3(0.02 + 0.1 * (1 - skStrength));
      const high = round3(low + 0.1 + 0.3 * (1 - skStrength));
      return `format=rgb24,edgedetect=mode=${skMode}:low=${low}:high=${high},format=yuv420p`;
    },
    // #169 film-damage (old-film): flickering vertical scratch lines (ADD light) + dust specks (SUBTRACT) that
    // jump per frame. fk = floor(T*fps) is the per-frame index; distinct prime seeds jump each independently.
    film_damage: (p) => {
      const nS = Math.round(Math.min(8, Math.max(0, Number.isFinite(p.scratches) ? p.scratches : 0)));
      const nD = Math.round(Math.min(40, Math.max(0, Number.isFinite(p.dust) ? p.dust : 0)));
      const st = Math.min(1, Math.max(0, Number.isFinite(p.strength) ? p.strength : 0.7));
      const fk = `floor(T*${fpsNum})`;
      const ampS = round3(120 + 100 * st);   // bright scratch add
      const ampD = round3(110 + 90 * st);    // dark dust subtract
      const scratchTerms = [];
      for (let i = 0; i < nS; i++) {
        const prime = 97 + i * 58, off = i * 37, onp = 13 + i * 6, thr = 6;
        scratchTerms.push(`lt(mod(${fk}*${onp}\\,10)\\,${thr})*lt(abs(X-mod(${fk}*${prime}+${off}\\,${W}))\\,1)`);
      }
      const dustTerms = [];
      for (let j = 0; j < nD; j++) {
        const px = 131 + j * 41, py = 71 + j * 29, onp = 17 + j * 3;
        const dx = `mod(${fk}*${px}+${j * 53}\\,${W})`;
        const dy = `mod(${fk}*${py}+${j * 23}\\,${H})`;
        dustTerms.push(`lt(mod(${fk}*${onp}\\,10)\\,3)*lt(hypot(X-${dx}\\,Y-${dy})\\,2)`);
      }
      const sSum = scratchTerms.length ? scratchTerms.join('+') : '0';
      const dSum = dustTerms.length ? dustTerms.join('+') : '0';
      const delta = `${ampS}*(${sSum})-${ampD}*(${dSum})`;
      const ch = (c) => `min(255\\,max(0\\,${c}(X\\,Y)+${delta}))`;
      return `format=rgb24,geq=r='${ch('r')}':g='${ch('g')}':b='${ch('b')}',format=yuv420p`;
    },
  };
}

/**
 * #plugin-arch Stage 5: the BEAT-REACTIVE pulse-effect cluster. `segment.pulses` is a list of {at, kind,
 * strength, duration, color}; each kind maps to a transient filter whose amplitude is a triangular BUMP
 * envelope (bumpExpr) peaking AT each beat and 0 between. `resolve(pulses)` returns the ORDERED flat list
 * of fragments (flash, punch, shake, glitch, tint), which the compositor pushes IN PLACE (L179). The kind
 * filters are preserved EXACTLY (flash = anything that is not punch/shake/glitch, so a tint beat also
 * flashes brightness, existing behavior). Deps (round3, fpsNum, W, H, colorToRgb255) are injected.
 */
export function createPulseEffects({ round3, fpsNum, W, H, colorToRgb255 }) {
  const bumpExpr = (p, tvar) => {
    const at = round3(p.at);
    const strength = round3(Math.min(1, Math.max(0, Number.isFinite(p.strength) ? p.strength : 0.5)));
    const half = round3((Number.isFinite(p.duration) && p.duration > 0 ? p.duration : 0.16) / 2);
    return `${strength}*max(0\\,1-abs(${tvar}-${at})/${half})`;
  };
  const maxReduce = (list, tvar) => list.map((p) => bumpExpr(p, tvar)).reduce((acc, b) => (acc === null ? b : `max(${acc}\\,${b})`), null);
  return {
    resolve(pulses) {
      const out = [];
      const flashPulses = pulses.filter((p) => p.kind !== 'punch' && p.kind !== 'shake' && p.kind !== 'glitch');
      const punchPulses = pulses.filter((p) => p.kind === 'punch');
      const shakePulses = pulses.filter((p) => p.kind === 'shake');
      const glitchPulses = pulses.filter((p) => p.kind === 'glitch');
      const tintPulses = pulses.filter((p) => p.kind === 'tint');
      if (flashPulses.length > 0) {
        // t is clip-relative secs; eq brightness is additive, a flash is a positive spike.
        out.push(`eq=brightness='${maxReduce(flashPulses, 't')}':eval=frame`);
      }
      if (punchPulses.length > 0) {
        // transient centered zoom via zoompan (clock `on` -> on/fps secs).
        const secs = `(on/${fpsNum})`;
        out.push(`zoompan=z='1+${maxReduce(punchPulses, secs)}':x='(iw-iw/zoom)/2':y='(ih-ih/zoom)/2':d=1:s=${W}x${H}:fps=${fpsNum}`);
      }
      if (shakePulses.length > 0) {
        // aspect-preserving inset crop whose x/y oscillate, amplitude driven by the beat envelope (t secs).
        const env = maxReduce(shakePulses, 't');
        const m = 0.06; const fx = 25; const fy = round3(fx * 1.37);
        const xE = `iw*(${m}+${m}*(${env})*sin(2*PI*${fx}*t))`;
        const yE = `ih*(${m}+${m}*(${env})*cos(2*PI*${fy}*t))`;
        out.push(`crop=w=iw*${round3(1 - 2 * m)}:h=ih*${round3(1 - 2 * m)}:x='${xE}':y='${yE}'`, `scale=${W}:${H}`);
      }
      if (glitchPulses.length > 0) {
        // transient horizontal RGB split (chromatic jitter) gated by the beat envelope; geq time var is T.
        const MAXPX = 12;
        const env = maxReduce(glitchPulses, 'T');
        const off = `${MAXPX}*(${env})`;
        const xr = `min(W-1\\,max(0\\,X+${off}))`;
        const xb = `min(W-1\\,max(0\\,X-${off}))`;
        out.push(`format=rgb24,geq=r='r(${xr}\\,Y)':g='g(X\\,Y)':b='b(${xb}\\,Y)',format=yuv420p`);
      }
      if (tintPulses.length > 0) {
        // per-beat blend toward a color, grouped BY color so N beats of one color = ONE geq pass; geq var T.
        const byColor = new Map();
        for (const p of tintPulses) {
          const [r, g, b] = colorToRgb255(p.color || '#ff2d55');
          const key = `${r},${g},${b}`;
          if (!byColor.has(key)) byColor.set(key, { rgb: [r, g, b], list: [] });
          byColor.get(key).list.push(p);
        }
        for (const { rgb: [cr, cg, cb], list } of byColor.values()) {
          const A = `min(1\\,${maxReduce(list, 'T')})`;
          out.push(`format=rgb24,geq=r='r(X\\,Y)*(1-(${A}))+${cr}*(${A})':g='g(X\\,Y)*(1-(${A}))+${cg}*(${A})':b='b(X\\,Y)*(1-(${A}))+${cb}*(${A})',format=yuv420p`);
        }
      }
      return out;
    },
  };
}
