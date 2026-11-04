// parts/screen-look/read-data/type-register.ts
//
// PURPOSE
//   One choice swaps every type role of a look between registers (compact sans for working screens, editorial serif for pages
//   meant to be read). The registers are DATA (parts/screen-look/type-registers.json); the values are written through
//   changeScreenLookTokens so the look owner still validates every one. save_look (src/looks.mjs) takes `register` by id.
//
// NON-NEGOTIABLE INVARIANTS
//   1. No component picks a font: a look wears the register's values, and a screen wears the look its rules pick.
//   2. A register names look tokens only; a token the look lacks is skipped, never invented.
//   3. A register that does not exist is refused with the ones that do.

import registers from '../type-registers.json' with { type: 'json' };
import tuning from '../look-tuning.json' with { type: 'json' };
import { changeScreenLookTokens } from './screen-look-record.ts';
import type { EditableScreenLookTheme } from './read-editable-screen-look-themes.ts';

export type TypeRegisters = typeof registers;

/** `theme` wearing register `id`: its tokens set where the look has them. */
export function wearRegister(theme: EditableScreenLookTheme, id: string, rows: TypeRegisters = registers): EditableScreenLookTheme {
  const row = rows.registers.find(entry => entry.id === id);
  if (!row) throw new Error(rows.words.unknown_register.replace('{id}', String(id)).replace('{ids}', rows.registers.map(entry => entry.id).join(', ')));
  const have = new Set(theme.tokens.map(token => token.key));
  return changeScreenLookTokens(theme, Object.fromEntries(Object.entries(row.tokens).filter(([key]) => have.has(key))));
}

/** The faces the registers use that the editor does not offer (should be none). */
export const unofferedFaces = (rows: TypeRegisters = registers): string[] =>
  rows.registers.flatMap(row => Object.values(row.tokens)).filter(face => !tuning.font_faces.includes(face));
