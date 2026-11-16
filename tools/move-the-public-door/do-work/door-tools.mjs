// tools/move-the-public-door/do-work/door-tools.mjs
//
// The rows' functions, run by tools/records-door/do-work/run-an-export.mjs as fn(input, context): see where the public
// door runs and the rows it can move between, rent or release one host lease, and cut one hostname over to a new
// address (prepare, activate, roll back, or read where a cutover stands). The rent, release and cutover functions
// keep nothing: the person's Service connections rows (`connections`) and any receipt of an earlier run (`lease`,
// `receipt`) come in as input, and the lease or cutover receipt they make is answered, never saved. A held value
// comes from the row's credential mounts only: the one a list row names by `vault_key` is read from the environment
// variable named after it (heldFrom), and is never printed or answered.
import { hostingProviders, dnsProviders, hostingProvider, dnsProvider, currentDoor } from '../read-data/public-door-rows.mjs';
import { keptReceipts } from '../read-data/door-receipts.mjs';
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

// The one function here that reads a list: it shows the person's Service connections rows (record:service-connection)
// as the providers and placement the other functions take as `connections`.
async function connectionsOf(door) {
  const values = [];
  for await (const record of door.list({ type: 'record:service-connection' })) if (record.value) values.push(record.value);
  return values;
}

export async function seeWhereTheDoorRuns(_input, { door }) {
  const connections = await connectionsOf(door), hosting = hostingProviders(connections), naming = dnsProviders(connections);
  return {
    current: currentDoor(connections),
    hosting_providers: hosting.map(r => ({ id: r.id, name: r.name, move_ready: r.move_ready === true, not_ready_because: r.not_ready_because ?? null, vault_key: r.vault_key ?? null })),
    dns_providers: naming.map(r => ({ id: r.id, name: r.name, vault_key: r.vault_key })),
  };
}

const LEASE = 'lease', CUTOVER = 'cutover';

export async function rentAHost(input, { env = process.env, fetchImpl = fetch } = {}) {
  const provider = hostingProvider(input.provider, input.connections);
  const request = provider.base ? leaseClient(provider, heldFrom(provider.vault_key, env), { fetchImpl }) : null;
  return provisionHostLease({ request, receipts: keptReceipts(input.lease ? { [LEASE]: input.lease } : {}), file: LEASE, name: input.name, publicKey: input.public_key,
    serverType: input.server_type, location: input.location, image: input.image, address: input.address,
    lifetime: input.lifetime, expiresAt: input.expires_at ?? undefined, provider });
}

export async function releaseAHost(input, { env = process.env, fetchImpl = fetch } = {}) {
  const receipts = keptReceipts({ [LEASE]: input.lease }), kept = await readHostLease(receipts, LEASE), provider = hostingProvider(kept.provider, input.connections);
  const request = provider.base ? leaseClient(provider, heldFrom(provider.vault_key, env), { fetchImpl }) : null;
  return removeHostLease({ request, receipts, file: LEASE, provider });
}

export async function cutAHostnameOver(input, { env = process.env, fetchImpl = fetch } = {}) {
  const receipts = keptReceipts(input.receipt ? { [CUTOVER]: input.receipt } : {}), c = { hostname: input.hostname, address: input.address };
  const answer = receipt => ({ state: receipt.state, hostname: receipt.hostname, address: receipt.address, mode: receipt.mode,
    original: receipt.before.records.find(x => x.id === receipt.targetId) ?? null, current: receipt.afterTarget ?? null, worker_routes_preserved: receipt.before.routes.length, receipt });
  if (input.action === 'status') return answer(await readCutover(receipts, CUTOVER));
  const provider = dnsProvider(input.dns_provider ?? currentDoor(input.connections).dns_provider, input.connections);
  const request = dnsClient(heldFrom(provider.vault_key, env), { fetchImpl, provider });
  const receipt = input.action === 'prepare'
    ? await prepareCutover(c, { request, receipts, file: CUTOVER })
    : await changeCutover(c, { request, receipts, file: CUTOVER, rollback: input.action === 'rollback' });
  return answer(receipt);
}
