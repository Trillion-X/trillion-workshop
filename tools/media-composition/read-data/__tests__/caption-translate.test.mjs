/**
 * #90 Multi-language caption translation. Burned text (captions / titles / cards) is resolved
 * through a DATA-selected translation producer before it is drawn. `translate-captions` sets the
 * composition-wide `captionTranslate` {to, producer, glossary?}; a text overlay can override it with
 * its own translate_to/translate_producer/translate_glossary. LANGUAGES are DATA (any BCP-47 code),
 * ENGINES are DATA producer keys (glossary/argos/ai) so a new one is a data row, never a code branch.
 * The knobs flow through the fold + materialize onto the EDL; the render draws the translated text.
 */
import { tempFolder } from '../../../../test-helpers/temp-folder.mjs';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
let composeTimeline, materializeExportEdl;

before(async () => {
  const dir = tempFolder(join(tmpdir(), 'xlate-'));
  const alias = '--alias:@=' + join(here, '..', '..', '..', '..');
  const ct = join(dir, 'ct.mjs'); const me = join(dir, 'me.mjs');
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'compose-timeline.ts'), `--outfile=${ct}`], { encoding: 'utf8' });
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'materialize-edl.ts'), `--outfile=${me}`], { encoding: 'utf8' });
  ({ composeTimeline } = await import(ct));
  ({ materializeExportEdl } = await import(me));
});

const view = (decisions) => ({
  lanes: [{ lane_id: 'video', role: 'video', label: 'Video', items: [{ item_id: 's1', label: 'Main', start: 0, end: 4, source_ref: { artifact_ref: 'clip.mp4', source_id: 's1' } }] }],
  editDecisions: decisions,
  markers: [],
});
const dec = (action, parameters) => ({ action, label: action, span: {}, source_ref: { item_id: 's1' }, created_at: '2026-08-05T00:00:00.000Z', parameters });

test('translate-captions sets a composition-wide captionTranslate default', () => {
  const comp = composeTimeline(view([dec('translate-captions', { to: 'es', producer: 'glossary', glossary: { hello: 'hola' } })]));
  assert.deepEqual(comp.captionTranslate, { to: 'es', producer: 'glossary', glossary: { hello: 'hola' } });
});

test('producer defaults to glossary; an empty target clears any prior translation', () => {
  const setThenClear = composeTimeline(view([
    dec('translate-captions', { to: 'fr' }),
    dec('translate-captions', { to: '' }),
  ]));
  assert.equal(setThenClear.captionTranslate, undefined);
  const defaulted = composeTimeline(view([dec('translate-captions', { to: 'de' })]));
  assert.equal(defaulted.captionTranslate.producer, 'glossary');
});

test('captionTranslate materializes onto the EDL as caption_translate', () => {
  const comp = composeTimeline(view([dec('translate-captions', { to: 'es', producer: 'argos' })]));
  const { edl } = materializeExportEdl(comp, () => 'clip.mp4', { width: 640, height: 360 });
  assert.equal(edl.caption_translate.to, 'es');
  assert.equal(edl.caption_translate.producer, 'argos');
});

test('a per-overlay translate override rides onto the text_overlay row', () => {
  const comp = composeTimeline(view([
    dec('add-overlay', { overlay_kind: 'text', text: 'hello world', start: 0, end: 2, translate_to: 'es', translate_producer: 'glossary', translate_glossary: { hello: 'hola', world: 'mundo' } }),
  ]));
  const { edl } = materializeExportEdl(comp, () => 'clip.mp4', { width: 640, height: 360 });
  const o = edl.text_overlays.find((t) => t.translate_to);
  assert.ok(o, 'a text overlay carries the translate override');
  assert.equal(o.translate_to, 'es');
  assert.deepEqual(o.translate_glossary, { hello: 'hola', world: 'mundo' });
});
