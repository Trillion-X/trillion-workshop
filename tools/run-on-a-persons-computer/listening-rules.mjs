// computer/listening-rules.mjs
//
// Purpose
//   The person's own say over recording on this Mac, kept in four small files beside the listening switch: recording rules they
//   added (src/recording-rules.mjs rows), the facts those rules ask about (such as that the notice has been given), who has been
//   given the right to record, and private mode on or off. computer/listen.mjs reads them each time it decides, so a change takes
//   effect on the next piece.
//
// Non-negotiable invariants
//   1. Nothing is required by default: with no file, no rules apply and private mode is whatever the shipped DATA says (off).
//   2. A file that cannot be read is treated as empty, never fatal to listening.
//
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rulesSettings = () => JSON.parse(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'listening-rules.json'), 'utf8'));
const expand = place => String(place).replace(/^~(?=\/|$)/, os.homedir());
const read = (file, fallback) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; } };

export const filesOf = (listen, rules = rulesSettings()) => Object.fromEntries(Object.entries(rules.files).map(([key, name]) => [key, path.join(expand(listen.state), name)]));

/** The shipped rules plus the person's own. */
export const rulesIn = listen => [...(listen.recording_rules ?? []), ...read(filesOf(listen).rules, { rows: [] }).rows];
/** Facts the listener asks rules about: the person's own facts plus whether this device has been granted the right to record. */
export function factsIn(listen, device) {
  const files = filesOf(listen);
  const grants = read(files.grants, { granted: [] }).granted;
  return { kind: 'listening', device, granted: grants.some(row => row.person === (listen.grant_person ?? 'me')) ? true : undefined, ...read(files.facts, {}) };
}
/** Private mode as it stands: the person's setting if they made one, else the shipped DATA. */
export const privateModeIn = listen => read(filesOf(listen).private, null) ?? listen.private_mode ?? { on: false };
