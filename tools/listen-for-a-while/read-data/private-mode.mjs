// src/private-mode.mjs
//
// Purpose
//   An opt-in private mode for meetings (end-to-end encrypted ones, or any space that asks): a table of which features are
//   available in it, applied in the shared owner rather than as words on a screen, said plainly per feature when asked, and a
//   short security code both sides can compare out of band. With the mode off, every feature is available.
//
// Non-negotiable invariants
//   1. Which features exist and which a private mode takes away are DATA (src/private-mode.json `features`); this file names none.
//   2. Mode off means everything on. Mode on means a feature is available only if its row says `private: true`; a feature with no
//      row is NOT available in private mode (unknown means off), so a new feature cannot leak by being forgotten.
//   3. The security code is BLAKE3 of the sorted key list, shown as groups of digits; the same keys give the same code on every
//      device and one changed key changes it.
//
import { blake3 } from '@noble/hashes/blake3.js';
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
  const digest = blake3(new TextEncoder().encode(JSON.stringify([...keys].sort())), { dkLen: 30 });
  const groups = [];
  for (let at = 0; at < 30; at += 5) groups.push(String(Number(BigInt(`0x${Buffer.from(digest.slice(at, at + 5)).toString('hex')}`) % 100000n)).padStart(5, '0'));
  return groups.join(' ');
}
