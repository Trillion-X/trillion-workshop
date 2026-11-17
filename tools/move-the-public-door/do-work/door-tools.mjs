// tools/move-the-public-door/do-work/door-tools.mjs
//
// The rows' functions, run by tools/records-door/do-work/run-an-export.mjs as fn(input, context): see where the public
// door runs and the rows it can move between, rent or release one host lease, and cut one hostname over to a new
// address (prepare, activate, roll back, or read where a cutover stands) or keep it answering with the front-door computers that pass their health check. The rent, release and cutover functions
// keep nothing: the person's Service connections rows (`connections`) and any receipt of an earlier run (`lease`,
// `receipt`) come in as input, and the lease or cutover receipt they make is answered, never saved. A held value
// comes from the row's credential mounts only: the one a list row names by `vault_key` is read from the environment
// variable named after it (heldFrom), and is never printed or answered.
import { hostingProviders, hostingProvider, currentDoor } from '../read-data/public-door-rows.mjs';
import { keptReceipts, receiptStore } from '../read-data/door-receipts.mjs';
import { at, providerClient, rentMachine, releaseMachine } from '../../start-a-computer/do-work/rent-a-machine.mjs';
import { dnsClient, prepareCutover, changeCutover, readCutover, keepHealthyRecords, probeHealthy } from './portable-dns-cutover.mjs';

/** The environment variable a row's credential mount names for a vault key: example-cloud-token -> EXAMPLE_CLOUD_TOKEN. */
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
  const connections = await connectionsOf(door), hosting = hostingProviders(connections);
  return {
    current: currentDoor(connections),
    hosting_providers: hosting.map(r => ({ id: r.id, name: r.name, move_ready: r.move_ready === true, not_ready_because: r.not_ready_because ?? null, vault_key: r.vault_key ?? null })),
  };
}

const LEASE = 'lease', CUTOVER = 'cutover';

export async function rentAHost(input, { env = process.env, fetchImpl = fetch } = {}) {
  const provider = hostingProvider(input.provider, input.connections);
  const request = provider.base ? providerClient(provider, heldFrom(provider.vault_key, env), { fetchImpl }) : null;
  const placement = Object.fromEntries(Object.entries({ size: input.server_type, location: input.location, image: input.image, address: input.address }).filter(([, value]) => value));
  return rentMachine({ request, store: receiptStore(keptReceipts(input.lease ? { [LEASE]: input.lease } : {}), LEASE), name: input.name, publicKey: input.public_key, placement, expiresAt: input.expires_at ?? undefined, provider });
}

export async function releaseAHost(input, { env = process.env, fetchImpl = fetch } = {}) {
  const store = receiptStore(keptReceipts({ [LEASE]: input.lease }), LEASE), provider = hostingProvider(input.lease.provider, input.connections);
  const request = provider.base ? providerClient(provider, heldFrom(provider.vault_key, env), { fetchImpl }) : null;
  return releaseMachine({ request, store, provider });
}

export async function cutAHostnameOver(input, { env = process.env, fetchImpl = fetch } = {}) {
  const receipts = keptReceipts(input.receipt ? { [CUTOVER]: input.receipt } : {}), c = { hostname: input.hostname, address: input.address };
  const answer = receipt => ({ state: receipt.state, hostname: receipt.hostname, address: receipt.address, mode: receipt.mode,
    original: receipt.before.records.find(x => at(x, input.dns.record.id_at ?? 'id') === receipt.targetId) ?? null, current: receipt.afterTarget ?? null, guarded_lists_preserved: receipt.before.guards.length, receipt });
  if (input.action === 'status') return answer(await readCutover(receipts, CUTOVER));
  const provider = input.dns, request = dnsClient(heldFrom(provider.vault_key, env), { fetchImpl, provider });
  if (input.action === 'keep-healthy') {
    const probe = candidate => probeHealthy({ hostname: input.hostname, address: candidate.address, path: candidate.health_path ?? input.health_path ?? '/' });
    return keepHealthyRecords({ hostname: input.hostname, candidates: input.candidates, check: input.check ?? probe, request, provider, adopt: input.adopt === true });
  }
  const receipt = input.action === 'prepare'
    ? await prepareCutover(c, { request, provider, receipts, file: CUTOVER })
    : await changeCutover(c, { request, provider, receipts, file: CUTOVER, rollback: input.action === 'rollback' });
  return answer(receipt);
}
