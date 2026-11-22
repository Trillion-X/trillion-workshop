// harness/chosen-ai.mjs
//
// Purpose
//   The one place the person's chosen AI on this computer is kept and read: its id in the helper's settings file
//   (wake-sessions.json `folder`/`settings_file`, so ~/.trillion/wake-sessions/settings.json `chosen_ai`). Its headless
//   command is its row in take-open-work.json `ais`. Both harness/wake-sessions.mjs and harness/take-open-work.mjs read
//   it here; this module imports neither of them, so the helper can load its handlers while it starts.
//   A computer made from its row (a server) has no hand-kept settings file: its row renders take-open-work.computer.json
//   in the taker's state folder, and its values (chosen_ai, then_ai, tasks_store …) are read here under the hand-kept
//   ones. Without it the server's taker found no chosen AI and never started (10 h, Nov 21 2026), its card unwritten.
//
// Non-negotiable invariants
//   1. Nothing is chosen for the person: with no choice kept, chosenAi() is null and the callers say how to choose.
//
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const helperSettings = JSON.parse(readFileSync(new URL('./wake-sessions.json', import.meta.url), 'utf8'));
const settingsPath = (rules = helperSettings) => join(rules.folder.replace(/^~(?=\/|$)/, homedir()), rules.settings_file);
const readJson = path => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } };
const takerSettings = JSON.parse(readFileSync(new URL('./take-open-work.json', import.meta.url), 'utf8'));
const rowPath = (rules = helperSettings) => join((rules.taker_state_folder ?? takerSettings.state_folder).replace(/^~(?=\/|$)/, homedir()), 'take-open-work.computer.json');
const plain = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
/** This computer's settings: what its row rendered, then what was kept by hand on it (a hand-kept value wins). */
const keptHere = (rules = helperSettings) => ({ ...plain(readJson(rowPath(rules))), ...plain(readJson(settingsPath(rules))) });

/** The id of the AI the person chose on this computer, or null when none is chosen yet. */
export const chosenAi = (rules = helperSettings) => keptHere(rules).chosen_ai ?? null;

/** The AIs the person chose, in the order they are tried: the chosen one, then its `then_ai` (empty when none chosen). */
export const aiOrder = (rules = helperSettings) => {
  const kept = keptHere(rules);
  return kept.chosen_ai ? [kept.chosen_ai, ...(Array.isArray(kept.then_ai) ? kept.then_ai : [])] : [];
};

/** Everything kept in this computer's settings file (an object, empty when none): per-computer values such as a
 * `claude_settings_file` that take-open-work.json `computer_args` turns into command arguments. */
export const computerSettings = (rules = helperSettings) => keptHere(rules);

/** Keeps the named values in this computer's settings file in one write (every other value is kept as it was). */
export function keepComputerSettings(values, rules = helperSettings) {
  const path = settingsPath(rules);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const part = `${path}.${process.pid}.part`;
  writeFileSync(part, JSON.stringify({ ...(readJson(path) ?? {}), ...values }, null, 2), { mode: 0o600 });
  renameSync(part, path);
}

/**
 * Keeps the person's choice: the id of one take-open-work.json `ais` row, or several separated by commas, tried in that
 * order (a row that has reached its usage limit gives way to the next until it resets).
 */
export function chooseAi(id, rules = helperSettings) {
  const ids = typeof id === 'string' ? id.split(',').map(part => part.trim()).filter(Boolean) : [];
  if (!ids.length || !ids.every(part => /^[A-Za-z0-9_-]{1,100}$/.test(part))) throw new Error('--choose-ai takes the id of one AI row, or several in order separated by commas, for example codex,claude.');
  keepComputerSettings({ chosen_ai: ids[0], then_ai: ids.slice(1) }, rules);
  return ids.join(', ');
}
