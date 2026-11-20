// The installed Mac host's narrow adapter for the shared harness installer. Inputs select an existing computer,
// manifest-supported harness and operation, never executable code, paths, credentials or process settings.
// Both the existing local identity and its record in the authenticated owning account must agree before any
// inspection or change. The signed app owns its payload; configuration and actual hook execution stay distinct.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import host from './mac-tools.json' with { type: 'json' };
import { setup, settings } from '../harness/setup.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const validId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(value);
const payload = fileURLToPath(new URL('../harness', import.meta.url));
export function existingComputerId() {
  try { const id = JSON.parse(readFileSync(join(homedir(), host.computer_scope.file), 'utf8'))?.[host.computer_scope.field]; return validId(id) ? id : null; }
  catch { return null; }
}

/** Dependency parameters are for tests; the Workshop input cannot supply or override any of them. */
export function makeHarnessSetupTools({ readComputerId = existingComputerId, fetchImpl = (...args) => fetch(...args),
  runSetup = setup, now = () => new Date().toISOString() } = {}) {
  return { async manage(input, { origin, key } = {}) {
    const allowed = ['computer_id', 'harness', 'action', 'trust_hooks', 'reviewed_definition_hashes'];
    if (!object(input) || Object.keys(input).some(name => !allowed.includes(name)) || !validId(input.computer_id) ||
      !settings.hosts.some(row => row.id === input.harness) || !['inspect', 'apply', 'remove'].includes(input.action) ||
      (input.trust_hooks !== undefined && typeof input.trust_hooks !== 'boolean')) throw new Error('Name only an existing computer, a supported harness and inspect, apply or remove.');
    const reviewed = input.reviewed_definition_hashes;
    if (input.trust_hooks === true) {
      if (input.action !== 'apply' || !settings.hosts.find(row => row.id === input.harness)?.trust || !Array.isArray(reviewed) ||
        reviewed.length !== settings.hooks.length || new Set(reviewed).size !== reviewed.length || !reviewed.every(value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value))) {
        throw new Error('Trust requires an explicit apply for the selected host and every exact definition hash reviewed from its current inspect report.');
      }
    } else if (reviewed !== undefined) throw new Error('Reviewed hashes are only accepted with explicit trust_hooks on apply.');
    const computerId = readComputerId();
    if (!computerId || computerId !== input.computer_id) throw new Error('This tool can operate only on its existing local computer ID. No identity was created or changed.');
    if (typeof key !== 'string' || !key || typeof origin !== 'string') throw new Error('The authenticated owning account context is required.');
    const url = new URL('/mcp/api/computer-sources', origin);
    if (url.protocol !== 'https:' || url.username || url.password || new URL(origin).username || new URL(origin).password) throw new Error('The authenticated account must use its HTTPS origin.');
    let response, owner;
    try {
      response = await fetchImpl(url, { method: 'GET', headers: { authorization: `Bearer ${key}` }, redirect: 'error', signal: AbortSignal.timeout(15000) });
      if (response.ok) owner = await response.json();
    } catch { throw new Error('The owning account could not confirm this computer. No harness operation ran.'); }
    const matches = Array.isArray(owner?.computers) ? owner.computers.filter(row => row?.computer_id === computerId) : [];
    if (!response?.ok || matches.length !== 1 || !Number.isFinite(Date.parse(matches[0].reported_at))) throw new Error('The signed-in account does not currently record this exact computer. No harness operation ran.');
    if (readComputerId() !== computerId) throw new Error('The local computer identity changed during ownership verification. No harness operation ran.');
    const options = { action: input.action, harness: input.harness, payload };
    if (input.trust_hooks === true) {
      options.trustHooks = true;
      options.reviewedDefinitionHashes = reviewed;
    }
    const report = await runSetup(options);
    return { schema: 'trillion.native-harness-setup/v1', computer_id: computerId, scope_id: `${host.computer_scope.skill_prefix}${computerId}`,
      observed_at: now(), owner_reported_at: matches[0].reported_at, verification_basis: 'authenticated-mac-tool-local-inspector', report };
  } };
}

export const harnessSetupTools = makeHarnessSetupTools();
