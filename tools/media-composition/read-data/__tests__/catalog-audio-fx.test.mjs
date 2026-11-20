/**
 * buildEffectCatalog now surfaces the AUDIO placement/tone vocabulary (AUDIO_FX_CATALOG) to the agent /
 * MCP bridge, closing a primitive-without-product gap: the audio presets (studio-sound / pitch / noise-gate /
 * pan-left ...) were reachable via the `audio_fx` set-transform param but were NEVER advertised in the
 * self-describing catalog, so an autonomous agent could not DISCOVER them. `audioFx` is injected (decoupled)
 * and a new audio preset auto-advertises. This test is the exact call the studio's TS agent-catalog surface
 * makes (buildEffectCatalog with the real AUDIO_FX_CATALOG), proving the surfacing end-to-end.
 */
import { tempFolder } from '../../../../test-helpers/temp-folder.mjs';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildEffectCatalog, createComputeEffects } from '../../do-work/effect-registry.mjs';

const here = dirname(fileURLToPath(import.meta.url));
let AUDIO_FX_CATALOG;
const round3 = (n) => Math.round(n * 1000) / 1000;
const CE = createComputeEffects({ round3, W: 1920, H: 1080, safeColor: (c, d) => c || d, colorToRgb255: () => [0, 0, 0], fpsNum: 30, FPS: '30' });
const REG = {}; // keyframe effects not needed for this catalog-surfacing assertion

before(async () => {
  const out = join(tempFolder(join(tmpdir(), 'audcat-')), 'ct.mjs');
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', '--alias:@=' + join(here, '..', '..', '..', '..'),
    join(here, '..', 'compose-timeline.ts'), `--outfile=${out}`], { encoding: 'utf8' });
  ({ AUDIO_FX_CATALOG } = await import(out));
});

test('buildEffectCatalog surfaces the real AUDIO_FX_CATALOG (incl. this session pitch/noise-gate/pan), empty when not passed', () => {
  const withAudio = buildEffectCatalog({ computeEffects: CE, keyframeEffects: REG, audioFx: AUDIO_FX_CATALOG });
  const withoutAudio = buildEffectCatalog({ computeEffects: CE, keyframeEffects: REG });

  // the catalog now advertises the audio vocabulary...
  for (const key of ['studio-sound', 'pitch-up', 'noise-gate', 'pan-left', 'pan-right']) {
    assert.ok(withAudio.audio_fx.includes(key), `agent catalog advertises audio_fx '${key}'`);
  }
  assert.deepEqual(withAudio.audio_fx, Object.keys(AUDIO_FX_CATALOG).sort(), 'audio_fx = the whole catalog, sorted');
  // ...and stays empty (a no-op) when the caller does not supply it (decoupled, no import).
  assert.deepEqual(withoutAudio.audio_fx, []);
  // regression: node_shapes unchanged (audio_fx is a top-level list, not a 4th node shape).
  assert.equal(withAudio.node_shapes.length, 3);
  // regression: this session's compute effects are also surfaced.
  for (const key of ['deband', 'deinterlace', 'deflicker']) assert.ok(withAudio.compute_effects.includes(key), `compute catalog advertises '${key}'`);
});
