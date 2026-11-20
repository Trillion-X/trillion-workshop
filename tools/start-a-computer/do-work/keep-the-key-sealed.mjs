// tools/start-a-computer/do-work/keep-the-key-sealed.mjs
//
// A unit that names `key_sealed_file` runs an engine whose computer key is kept sealed by systemd (`systemd-creds encrypt`, loaded
// by the unit's LoadCredentialEncrypted= and opened for the engine on descriptor 4): no readable file holds the key. This module
// is everything the tool does about it: the sealed file is made when the computer lacks it (from the plain `key_file` the unit
// held until now, byte for byte, so the person's vaults still open; else from 32 new random bytes in one base64 line, like set-up
// made the plain one), and the plain file is removed only once the unit runs from the sealed key and the two are the same key.
import { isAbsolute } from 'node:path';

/** The name systemd gives the key inside the unit's credentials folder; the unit template names the same. */
export const KEY_CREDENTIAL = 'computer-key';

const q = text => `'${String(text).replace(/'/g, `'\\''`)}'`;
const PATH = /^\/[A-Za-z0-9._/-]+$/;

/** The units of a computer's row that keep their key sealed. A sealed unit's settings must not name the plain key file (the
 * engine would read it, and removing it would stop the engine), and its plain file is only the key it held before: set-up no
 * longer makes one. */
export function sealedKeyUnits(units) {
  return units.filter(unit => unit.key_sealed_file !== undefined).map(unit => {
    const where = `${unit.unit} key_sealed_file`;
    if (typeof unit.key_sealed_file !== 'string' || !PATH.test(unit.key_sealed_file) || !isAbsolute(unit.key_sealed_file)) throw new Error(`${where} is an absolute path.`);
    if (unit.key_file !== undefined && (typeof unit.key_file !== 'string' || !PATH.test(unit.key_file) || unit.key_file === unit.key_sealed_file)) throw new Error(`${unit.unit} key_file, when given beside key_sealed_file, is the other absolute path that held the key.`);
    const settings = JSON.stringify(unit.settings ?? {}) + (unit.settings_lines ?? []).join('\n');
    if (unit.key_file !== undefined && settings.includes(unit.key_file)) throw new Error(`${unit.unit} settings still name the plain key_file ${unit.key_file}: its sealed engine reads its key from descriptor 4 (secrets.unlock.key_descriptor).`);
    return unit;
  });
}

/** What the computer holds for each sealed-key unit: { unit, sealed, plain }. */
export async function keyState(machine, units, run) {
  const has = (path) => run(machine, `test -s ${q(path)} || exit 3`).then(() => true, error => { if (error.code === 3) return false; throw error; });
  const states = [];
  for (const unit of sealedKeyUnits(units)) states.push({ unit, sealed: await has(unit.key_sealed_file), plain: unit.key_file !== undefined && await has(unit.key_file) });
  return states;
}

/** The differences a computer's keys show: a sealed file it lacks, and a plain copy it still holds. */
export const keyDifferences = states => states.flatMap(({ unit, sealed, plain }) => [
  ...(sealed ? [] : [{ path: unit.key_sealed_file, reason: 'the computer key is not sealed there; its row keeps it sealed' }]),
  ...(plain ? [{ path: unit.key_file, reason: 'a plain copy of the computer key is held; its row keeps the key sealed' }] : []),
]);

/** Make each missing sealed file: from the plain file when the computer holds one, else from a new key. */
export async function sealTheKeys(machine, states, run) {
  const made = [];
  for (const { unit, sealed, plain } of states.filter(({ sealed }) => !sealed)) {
    const into = q(unit.key_sealed_file), name = `--name=${KEY_CREDENTIAL}`;
    const from = plain ? `systemd-creds encrypt ${name} ${q(unit.key_file)} ${into}` : `head -c 32 /dev/urandom | base64 -w0 | systemd-creds encrypt ${name} - ${into}`;
    await run(machine, `install -d -m 0700 ${q(unit.key_sealed_file.replace(/\/[^/]*$/, '') || '/')} && umask 077 && ${from}`);
    made.push(unit.unit);
  }
  return made;
}

/** Remove each plain key whose unit has just answered its boot check, and only when the sealed file opens to those same bytes. */
export async function removeThePlainKeys(machine, states, booted, run) {
  const removed = [];
  for (const { unit, plain } of states.filter(({ plain }) => plain)) {
    if (!booted.includes(unit.unit)) continue;
    const same = `[ "$(systemd-creds decrypt ${`--name=${KEY_CREDENTIAL}`} ${q(unit.key_sealed_file)} -)" = "$(cat ${q(unit.key_file)})" ]`;
    await run(machine, `${same} && rm -f -- ${q(unit.key_file)}`).catch(error => { throw Object.assign(new Error(`${unit.unit}'s sealed key is not the plain key ${unit.key_file} held: the plain file is kept.`), { cause: error }); });
    removed.push(unit.key_file);
  }
  return removed;
}
