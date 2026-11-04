// tools/screen-looks/read-data/type-register.ts: a register is worn on a look through changeScreenLookTokens, so the look owner
// validates every value written. (The save_look cases stay with their caller, old trillion's src/looks.mjs.)
import test from 'node:test';
import assert from 'node:assert/strict';
import { unofferedFaces, wearRegister } from '../read-data/type-register.ts';
import { DEFAULT_EDITABLE_SCREEN_LOOK_THEME } from '../read-data/read-editable-screen-look-themes.ts';

const valueOf = (look: { tokens: { key: string; value: unknown }[] }, key: string) => look.tokens.find(token => token.key === key)?.value;

test('a register skips a token the look lacks', () => {
  const sparse = { ...DEFAULT_EDITABLE_SCREEN_LOOK_THEME, tokens: DEFAULT_EDITABLE_SCREEN_LOOK_THEME.tokens.filter(token => token.key !== 'displayFontFamily') };
  const worn = wearRegister(sparse, 'editorial');
  assert.equal(valueOf(worn, 'defaultPrimaryFontFamily'), 'Georgia');
  assert.equal(valueOf(worn, 'displayFontFamily'), undefined);
});

test('a register that does not exist is refused with the ones that do, and every register face is one the editor offers', () => {
  assert.throws(() => wearRegister(DEFAULT_EDITABLE_SCREEN_LOOK_THEME, 'gothic'), /There is no type register gothic\. The ones that exist: compact, editorial\./);
  assert.deepEqual(unofferedFaces(), []);
});
