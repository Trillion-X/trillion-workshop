// parts/screen-look/read-data/type-register.ts and tint-look.ts: a register and a picked colour are worn on a look through save_look
// (src/looks.mjs), the way a person or AI changes a look of their own; the look owner validates every value written.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeLooks } from '../src/looks.mjs';
import { unofferedFaces, wearRegister } from '../../screen-looks/read-data/type-register.ts';
import { DEFAULT_EDITABLE_SCREEN_LOOK_THEME } from '../../screen-looks/read-data/read-editable-screen-look-themes.ts';
import { contrastOf, oklchOfRgb, parseHex } from '../../screen-looks/read-data/tint-look.ts';
import appLooks from '../src/workspace/looks.json' with { type: 'json' };

const records: Record<string, unknown> = {};
const looks = makeLooks({
  records: { read: () => structuredClone(records), write: (writes: { address_label: string; payload: unknown }[]) => { for (const write of writes) records[write.address_label] = structuredClone(write.payload); } },
  shelf: { published: async () => [], publish: async () => {}, withdraw: async () => false }, maker: 'maker:a',
});
const BLACK = appLooks.themes.find(theme => theme.payload.id === 'trillion-black')?.payload.id as string;
const valueOf = (look: { tokens: { key: string; value: unknown }[] }, key: string) => look.tokens.find(token => token.key === key)?.value;
const lch = (colour: string) => { const [l, c, h] = (colour.match(/[\d.]+/g) ?? []).map(Number); return { l, c, h }; };

test('save_look wears a register: every type role changes together and a token named too still wins', async () => {
  const { look } = await looks.save({ from: BLACK, name: 'Reader', register: 'editorial', tokens: { displayFontFamily: 'Inter' }, wear: false });
  assert.deepEqual([valueOf(look, 'defaultPrimaryFontFamily'), valueOf(look, 'displayFontFamily')], ['Georgia', 'Inter']);
  const back = await looks.save({ look_id: look.id, register: 'compact', wear: false });
  assert.deepEqual([valueOf(back.look, 'defaultPrimaryFontFamily'), valueOf(back.look, 'displayFontFamily')], ['Instrument Sans', 'Instrument Sans']);
  await assert.rejects(looks.save({ from: BLACK, register: 'gothic' }), /There is no type register gothic\. The ones that exist: compact, editorial\./);
  assert.deepEqual(unofferedFaces(), []);
});

test('a register skips a token the look lacks', () => {
  const sparse = { ...DEFAULT_EDITABLE_SCREEN_LOOK_THEME, tokens: DEFAULT_EDITABLE_SCREEN_LOOK_THEME.tokens.filter(token => token.key !== 'displayFontFamily') };
  const worn = wearRegister(sparse, 'editorial');
  assert.equal(valueOf(worn, 'defaultPrimaryFontFamily'), 'Georgia');
  assert.equal(valueOf(worn, 'displayFontFamily'), undefined);
});

test('save_look wears one picked colour on the app looks: the accent roles take its hue and the button text stays readable', async () => {
  const dark = (await looks.save({ from: BLACK, name: 'Blue night', tint: '#2255ee', wear: false })).look;
  const accent = lch(valueOf(dark, 'accent-primary') as string);
  const fill = lch(valueOf(dark, 'button-primary-bg') as string);
  assert.deepEqual([accent.l, accent.h], [0.76, fill.h]);
  assert.ok(accent.h > 250 && accent.h < 285, 'the blue hue survived');
  assert.ok(contrastOf(fill, lch(valueOf(dark, 'button-primary-text') as string)) >= 4.5, 'text on the button reads');
  const light = (await looks.save({ from: 'trillion', name: 'Blue day', tint: { colour: '#2255ee' }, wear: false })).look;
  assert.equal(lch(valueOf(light, 'button-primary-bg') as string).l, 0.52, 'the scheme came from the look itself');
  assert.ok(contrastOf(lch(valueOf(light, 'button-primary-bg') as string), lch(valueOf(light, 'button-primary-text') as string)) >= 4.5);
  await assert.rejects(looks.save({ from: BLACK, tint: 'blue' }), /Give the colour as #rgb or #rrggbb/);
  assert.ok(oklchOfRgb(...(parseHex('#2255ee') as [number, number, number])).h > 250);
});
