// tools/move-the-public-door/do-work/door-tools.mjs
//
// The rows' functions, run by tools/records-door/do-work/run-an-export.mjs as fn(input, { door }): see where the public
// door runs and the rows it can move between, rent or release one host lease, and cut one hostname over to a new
// address (prepare, activate, roll back, or read where a cutover stands). Every row and receipt comes through the
// person's records door. A held value comes from the row's credential mounts only: the one a list row names by
// `vault_key` is read from the environment variable named after it (heldFrom), and is never printed or answered.
import { hostingProviders, dnsProviders, hostingProvider, dnsProvider, currentDoor } from '../read-data/public-door-rows.mjs';
import { doorReceipts } from '../read-data/door-receipts.mjs';
import { leaseClient, provisionHostLease, removeHostLease, readHostLease } from './portable-host-lease.mjs';
import { dnsClient, prepareCutover, changeCutover, readCutover } from './portable-dns-cutover.mjs';

/** The environment variable a row's credential mount names for a vault key: hetzner-api-token -> HETZNER_API_TOKEN. */
export const heldVariable = vaultKey => String(vaultKey).toUpperCase().replace(/[^A-Z0-9]+/g, '_');
/** The held value the row mounted for `vaultKey`, or a refusal naming the mount the row lacks. */
export function heldFrom(vaultKey, env = process.env) {
  const value = env[heldVariable(vaultKey)];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`This run was handed no held value named ${vaultKey}; its row needs a credential mount { secret_name: "${vaultKey}", env: "${heldVariable(vaultKey)}" }.`);
  return value.trim();
}

export async function seeWhereTheDoorRuns(_input, { door }) {
  const hosting = await hostingProviders(door), naming = await dnsProviders(door), current = await currentDoor(door);
  return {
    current,
    hosting_providers: hosting.map(r => ({ id: r.id, name: r.name, move_ready: r.move_ready === true, not_ready_because: r.not_ready_because ?? null, vault_key: r.vault_key ?? null })),
    dns_providers: naming.map(r => ({ id: r.id, name: r.name, vault_key: r.vault_key })),
  };
}

export async function rentAHost(input, { door, env = process.env, fetchImpl = fetch }) {
  const provider = await hostingProvider(input.provider, door);
  const request = provider.base ? leaseClient(provider, heldFrom(provider.vault_key, env), { fetchImpl }) : null;
  return provisionHostLease({ request, receipts: doorReceipts(door), file: input.lease, name: input.name, publicKey: input.public_key,
    serverType: input.server_type, location: input.location, image: input.image, address: input.address,
    lifetime: input.lifetime, expiresAt: input.expires_at ?? undefined, provider });
}

export async function releaseAHost(input, { door, env = process.env, fetchImpl = fetch }) {
  const receipts = doorReceipts(door), kept = await readHostLease(receipts, input.lease), provider = await hostingProvider(kept.provider, door);
  const request = provider.base ? leaseClient(provider, heldFrom(provider.vault_key, env), { fetchImpl }) : null;
  return removeHostLease({ request, receipts, file: input.lease, provider });
}

export async function cutAHostnameOver(input, { door, env = process.env, fetchImpl = fetch }) {
  const receipts = doorReceipts(door), c = { hostname: input.hostname, address: input.address };
  const answer = receipt => ({ state: receipt.state, hostname: receipt.hostname, address: receipt.address, mode: receipt.mode,
    original: receipt.before.records.find(x => x.id === receipt.targetId) ?? null, current: receipt.afterTarget ?? null, worker_routes_preserved: receipt.before.routes.length });
  if (input.action === 'status') return answer(await readCutover(receipts, input.cutover));
  const provider = await dnsProvider(input.dns_provider ?? (await currentDoor(door)).dns_provider, door);
  const request = dnsClient(heldFrom(provider.vault_key, env), { fetchImpl, provider });
  const receipt = input.action === 'prepare'
    ? await prepareCutover(c, { request, receipts, file: input.cutover })
    : await changeCutover(c, { request, receipts, file: input.cutover, rollback: input.action === 'rollback' });
  return answer(receipt);
}
