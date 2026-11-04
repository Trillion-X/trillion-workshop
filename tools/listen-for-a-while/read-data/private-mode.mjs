// tools/listen-for-a-while/read-data/private-mode.mjs
//
// Purpose
//   An opt-in private mode for meetings (end-to-end encrypted ones, or any space that asks): a table of which features are
//   available in it, applied in the shared owner rather than as words on a screen, said plainly per feature when asked, and a
//   short security code both sides can compare out of band. With the mode off, every feature is available.
//
// Non-negotiable invariants
//   1. Which features exist and which a private mode takes away are DATA (private-mode.json `features`); this file names none.
//   2. Mode off means everything on. Mode on means a feature is available only if its row says `private: true`; a feature with no
//      row is NOT available in private mode (unknown means off), so a new feature cannot leak by being forgotten.
//   3. The security code is BLAKE3 of the sorted key list, shown as groups of digits; the same keys give the same code on every
//      device and one changed key changes it.
//
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import copy from './private-mode.json' with { type: 'json' };

const fill = (template, values) => String(template ?? '').replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? ''));

/** Whether `feature` is available given the mode ({ on: boolean }). */
export function available(mode, feature, table = copy.features) {
  if (!mode?.on) return true;
  return table.find(row => row.id === feature)?.private === true;
}

/** One plain sentence per feature for the mode: [{ feature, available, says }]. */
export function explain(mode, table = copy.features) {
  return table.map(row => ({ feature: row.id, available: available(mode, row.id, table), says: fill(available(mode, row.id, table) ? copy.words.available : copy.words.unavailable, { feature: row.label }) }));
}

/** Digits both sides can read aloud and compare: 6 groups of 5 from the BLAKE3 of the sorted keys. */
export function securityCode(keys) {
  // The first 30 bytes of the BLAKE3 output (a shorter BLAKE3 output is a prefix of a longer one), as 60 hex digits.
  const digest = makeHashCodeHexFromBytes(new TextEncoder().encode(JSON.stringify([...keys].sort()))).slice(3, 63);
  const groups = [];
  for (let at = 0; at < 60; at += 10) groups.push(String(Number(BigInt(`0x${digest.slice(at, at + 10)}`) % 100000n)).padStart(5, '0'));
  return groups.join(' ');
}
