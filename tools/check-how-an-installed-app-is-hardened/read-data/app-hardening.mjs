// tools/check-how-an-installed-app-is-hardened/read-data/app-hardening.mjs
//
// PURPOSE
//   Reads how an installed app is hardened, from the files on disk and the system's own codesign, without launching it,
//   and says what falls short of read-data/app-hardening.json. It checks Trillion's own carrier before release and any other
//   app on the Mac the same way. An Electron app signed with the hardened runtime can still be run as Node or have its
//   code archive edited when its fuses are left at their defaults; the signature alone does not show that.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Blind: no app, fuse or entitlement is named here; the sentinel, the tables and the expectations are DATA.
//   2. The app is never launched, and only the framework binary, Info.plist and codesign output are read.
//   3. A thing that cannot be read (no sentinel, an unknown wire version, an unsigned bundle) is a finding in words, never
//      assumed fine.
//
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const HERE = dirname(fileURLToPath(import.meta.url));
const exec = promisify(execFile);
export const hardeningSettings = () => JSON.parse(readFileSync(join(HERE, 'app-hardening.json'), 'utf8'));
const fill = (text, values) => text.replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));

/** The fuses in a framework binary's bytes: { version, fuses: { name: 'on' | 'off' | 'removed' } }, or null with no sentinel. */
export function readFuses(bytes, settings = hardeningSettings()) {
  const at = bytes.indexOf(Buffer.from(settings.sentinel));
  if (at < 0) return null;
  const start = at + settings.sentinel.length;
  const version = bytes[start], length = bytes[start + 1];
  const table = settings.fuse_tables[String(version)];
  const states = [...bytes.subarray(start + 2, start + 2 + length)].map(byte => settings.states[String(byte)] ?? `unknown(${byte})`);
  return { version, fuses: table ? Object.fromEntries(table.map((name, index) => [name, states[index] ?? 'absent'])) : null, raw: states };
}

/** Real system facts about a bundle: code-signing flags and entitlements, from codesign. */
export async function signingFacts(app, run = (file, args) => exec(file, args, { maxBuffer: 8 * 1024 * 1024 }).then(({ stdout, stderr }) => ({ stdout, stderr })).catch(error => ({ stdout: error.stdout ?? '', stderr: error.stderr ?? String(error.message), failed: true }))) {
  const detail = await run('/usr/bin/codesign', ['-dv', '--verbose=2', app]);
  const entitlements = await run('/usr/bin/codesign', ['-d', '--entitlements', '-', '--xml', app]);
  const flags = /flags=0x[0-9a-f]+\(([^)]*)\)/.exec(detail.stderr)?.[1] ?? '';
  const names = [...entitlements.stdout.matchAll(/<key>([^<]+)<\/key>\s*<true\/>/g)].map(match => match[1]);
  return { signed: !/not signed at all/.test(detail.stderr) && !detail.failed, hardened: flags.split(',').includes('runtime'), entitlements: names };
}

/** The findings for one app bundle: an array of { kind, name?, said }. Empty means every expectation is met. */
export async function auditApp(app, { settings = hardeningSettings(), facts = signingFacts } = {}) {
  const name = basename(app);
  if (!existsSync(join(app, 'Contents')) || !statSync(app).isDirectory()) return [{ kind: 'no_app', said: fill(settings.words.no_app, { path: app }) }];
  const findings = [];
  const signing = await facts(app);
  if (!signing.signed) findings.push({ kind: 'unsigned', said: fill(settings.words.unsigned, { app: name }) });
  else {
    if (settings.expect.require_hardened_runtime && !signing.hardened) findings.push({ kind: 'not_hardened', said: fill(settings.words.not_hardened, { app: name }) });
    for (const row of settings.expect.forbidden_entitlements) if (signing.entitlements.includes(row.name)) findings.push({ kind: 'entitlement', name: row.name, said: fill(settings.words.entitlement, { app: name, name: row.name, why: row.why }) });
  }
  const framework = join(app, settings.framework_path);
  let fuses = null;
  if (existsSync(framework)) {
    fuses = readFuses(readFileSync(framework), settings);
    if (!fuses) findings.push({ kind: 'no_sentinel', said: fill(settings.words.no_sentinel, { app: name }) });
    else if (!fuses.fuses) findings.push({ kind: 'unknown_version', said: fill(settings.words.unknown_version, { app: name, version: fuses.version }) });
    else for (const row of settings.expect.fuses) {
      const state = fuses.fuses[row.name];
      if (state !== undefined && !row.want.includes(state)) findings.push({ kind: 'fuse', name: row.name, state, said: fill(settings.words.fuse, { name: row.name, state, app: name, why: row.why }) });
    }
    const plist = join(app, settings.info_plist);
    if (fuses?.fuses && existsSync(plist) && readFileSync(plist, 'utf8').includes(settings.integrity_key) && fuses.fuses.EnableEmbeddedAsarIntegrityValidation === 'off')
      findings.push({ kind: 'integrity_not_enforced', said: fill(settings.words.integrity_not_enforced, { app: name }) });
  }
  return findings;
}

export const hardeningTools = { audit: ({ app } = {}) => auditApp(String(app ?? '')).then(findings => ({ app, findings, ok: findings.length === 0 })) };

/** tool:check-an-app, run by tools/records-door run-an-export.mjs as audit(input). */
export const { audit } = hardeningTools;
