// tools/follow-my-ai-command-line-runs/do-work/computer-settings.mjs
//
// This computer's settings file, read and kept in one write. Moved from Trillion-X/trillion harness/chosen-ai.mjs
// (computerSettings, keepComputerSettings and the two helpers they use); its rows are read-data/ai-command-lines.json
// (`folder`/`settings_file`) instead of the helper's wake-sessions.json.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const helperSettings = JSON.parse(readFileSync(new URL('../read-data/ai-command-lines.json', import.meta.url), 'utf8'));
const settingsPath = (rules = helperSettings) => join(rules.folder.replace(/^~(?=\/|$)/, homedir()), rules.settings_file);
const readJson = path => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } };

/** Everything kept in this computer's settings file (an object, empty when none). */
export const computerSettings = (rules = helperSettings) => {
  const kept = readJson(settingsPath(rules));
  return kept && typeof kept === 'object' && !Array.isArray(kept) ? kept : {};
};

/** Keeps the named values in this computer's settings file in one write (every other value is kept as it was). */
export function keepComputerSettings(values, rules = helperSettings) {
  const path = settingsPath(rules);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const part = `${path}.${process.pid}.part`;
  writeFileSync(part, JSON.stringify({ ...(readJson(path) ?? {}), ...values }, null, 2), { mode: 0o600 });
  renameSync(part, path);
}

export { helperSettings };
