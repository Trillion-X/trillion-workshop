// computer/switch-guard.mjs
//
// Purpose
//   A program the Trillion app starts refuses to run with switches that open it to a debugger or weaken its TLS (an
//   inspector port, a preloaded module, certificate checks turned off, a proxy forced on it), because the app's permissions
//   (Full Disk Access, Accessibility) belong to those programs. A support person can allow one run with a token whose BLAKE3
//   is in the shipped list; every refusal and every override is logged by name.
//
// Non-negotiable invariants
//   1. Which switches and variables are dangerous, the variable that carries a support token, the shipped hashes and the
//      variable that says "started by the app" are DATA (computer/switch-guard.json); this file names none.
//   2. It applies only to programs the app started (the variable is set by the app, macos/computer-reader.json), so a
//      developer's own shell run is untouched.
//   3. The token is compared as BLAKE3 and never logged; an override is logged without it.
//
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeHashCodeHexFromBytes } from '../content-identity/read-data/identity.mjs';

export const guardSettings = () => JSON.parse(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'switch-guard.json'), 'utf8'));

/** The dangerous things in this run: [{ where: 'argv' | 'env', what }]. */
export function dangerousIn({ execArgv, env, settings = guardSettings() }) {
  const found = [];
  const switches = [...execArgv, ...String(env.NODE_OPTIONS ?? '').split(/\s+/).filter(Boolean)];
  for (const word of switches) if (settings.switches.some(pattern => new RegExp(pattern).test(word))) found.push({ where: 'argv', what: word.split('=')[0] });
  for (const rule of settings.variables) if (env[rule.name] !== undefined && (rule.value === undefined || env[rule.name] === rule.value)) found.push({ where: 'env', what: rule.name });
  return found;
}

/** { ok: true } when nothing dangerous, or the support token matches; else { ok: false, found, said }. */
export function checkSwitches({ execArgv = process.execArgv, env = process.env, settings = guardSettings(), log = () => {} } = {}) {
  if (!env[settings.app_child_variable]) return { ok: true, applies: false };
  const found = dangerousIn({ execArgv, env, settings });
  if (!found.length) return { ok: true, applies: true };
  const token = env[settings.token_variable];
  if (token && settings.support_token_blake3.includes(makeHashCodeHexFromBytes(new TextEncoder().encode(token)).slice(3))) {
    log(settings.words.overridden.replace('{list}', found.map(row => row.what).join(', ')));
    return { ok: true, applies: true, overridden: true, found };
  }
  const said = settings.words.refused.replace('{list}', found.map(row => row.what).join(', '));
  log(said);
  return { ok: false, applies: true, found, said };
}
