// tools/open-a-prompt-in-a-local-ai-app/read-data/open-in-ai.mjs
//
// PURPOSE
//   Hands one prompt to a local AI app the person already has (Claude Code, Codex, any app with a row), opened through
//   a launcher the DATA allowlists. Run by tools/records-door's run-an-export.mjs as tool:open-in-ai; the apps are
//   read-data/open-in-ai.json.
//
// NON-NEGOTIABLE INVARIANTS
//   1. This file names no app, scheme or executable: they are the DATA rows, and the rows are the allowlist. An app
//      not in them is refused. A new app is one more row.
//   2. Nothing goes through a shell. A URL launch fills percent-encoded values into the row's URL and opens it with the
//      row's opener as one argument; an argv launch runs the row's list as it is, the prompt standing for one argument.
//   3. A folder is used only when the person names one that exists (a real directory, resolved); the app's own config
//      is never read or written.
//   4. The outcome is typed: launched, app_missing or refused. The prompt is never echoed or kept; only its length.
//   5. `dry_run` builds the launch and returns it without running it.
import { spawn } from 'node:child_process';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RULES = JSON.parse(readFileSync(fileURLToPath(new URL('./open-in-ai.json', import.meta.url)), 'utf8'));
const fill = (text, values) => text.replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));
const refused = (said, extra = {}) => ({ outcome: 'refused', said, ...extra });
const placeAt = (place, home) => (place.startsWith('~/') ? join(home, place.slice(2)) : place);
const exists = path => { try { statSync(path); return true; } catch { return false; } };

/** The folder a person named, resolved, or null when it is not a directory that exists. */
function folderOf(named) {
  if (typeof named !== 'string' || !named.trim()) return null;
  try { const real = realpathSync(named.replace(/^~(?=\/|$)/, homedir())); return statSync(real).isDirectory() ? real : null; } catch { return null; }
}

/** The command a launch runs: { command, args, cwd? }. */
export function launchOf(row, { prompt, folder }, rules = RULES) {
  const { launch } = row;
  if (launch.kind === 'url') return { command: rules.opener, args: [fill(launch.url, { prompt: encodeURIComponent(prompt), folder: encodeURIComponent(folder ?? '') })] };
  const args = launch.argv.slice(1).map(part => (part === '{prompt}' ? prompt : part === '{folder}' ? (folder ?? '') : part));
  return { command: launch.argv[0], args, ...(folder ? { cwd: folder } : {}) };
}

/** Opens the prompt in the named app. deps: { spawnImpl, home, rules } for tests. */
export async function openInAi(input = {}, { spawnImpl = spawn, home = homedir(), rules = RULES } = {}) {
  const row = rules.apps.find(app => app.id === input.app);
  if (!row) return refused(fill(rules.words.unknown_app, { app: String(input.app ?? ''), known: rules.apps.map(app => app.id).join(', ') }));
  const prompt = input.prompt;
  if (typeof prompt !== 'string' || !prompt.trim()) return refused(rules.words.needs_prompt, { app: row.id });
  if (prompt.length > rules.max_prompt_chars) return refused(fill(rules.words.prompt_long, { length: prompt.length, most: rules.max_prompt_chars }), { app: row.id });
  let folder = null;
  if (input.folder !== undefined || row.needs_folder) {
    folder = folderOf(input.folder);
    if (!folder) return refused(fill(input.folder === undefined ? rules.words.needs_folder : rules.words.bad_folder, { label: row.label, folder: String(input.folder ?? '') }), { app: row.id });
  }
  if (!row.installed.some(place => exists(placeAt(place, home)))) return { outcome: 'app_missing', app: row.id, said: fill(rules.words.app_missing, { label: row.label }) };
  const launch = launchOf(row, { prompt, folder }, rules);
  const shown = { app: row.id, via: row.launch.kind, command: launch.command, prompt_chars: prompt.length, ...(folder ? { folder } : {}) };
  if (input.dry_run === true) return { outcome: 'launched', dry_run: true, ...shown, argv: [launch.command, ...launch.args.map(arg => arg.replace(prompt, '<prompt>').replace(encodeURIComponent(prompt), '<prompt>'))], said: fill(rules.words.launched, { label: row.label }) };
  try {
    await new Promise((resolve, reject) => {
      const child = spawnImpl(launch.command, launch.args, { ...(launch.cwd ? { cwd: launch.cwd } : {}), stdio: 'ignore', detached: true });
      child.once('error', reject);
      child.once('spawn', () => { child.unref?.(); resolve(); });
    });
  } catch (error) { return refused(fill(rules.words.launch_failed, { label: row.label, error: String(error?.code ?? error?.message ?? error).slice(0, 80) }), { app: row.id }); }
  return { outcome: 'launched', ...shown, said: fill(rules.words.launched, { label: row.label }) };
}

export const openInAiTools = { open: input => openInAi(input) };
