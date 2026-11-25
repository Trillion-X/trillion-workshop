// tools/move-the-public-door/do-work/door-tools.mjs
//
// The rows' functions, run by tools/workflows/do-work/run-a-function.mjs as fn(input): see where the public
// door runs and the rows it can move between, rent or release one host lease, and cut one hostname over to a new
// address (prepare, activate, roll back, or read where a cutover stands) or keep it answering with the front-door computers that pass their health check. The rent, release and cutover functions
// keep nothing: the person's Service connections rows (`connections`) and any receipt of an earlier run (`lease`,
// `receipt`) come in as input, and the lease or cutover receipt they make is answered, never saved. A held value
// comes from the row's credential mounts only: the row mounts the secret the run's input names (the provider row's
// `vault_key`, read from the `hosting` or `dns` row the run is handed) under one fixed variable, which heldFrom reads;
// it is never printed or answered.
import { hostingProviders, currentDoor } from '../read-data/public-door-rows.mjs';
import { keptReceipts, receiptStore } from '../read-data/door-receipts.mjs';
import { at, providerClient, rentMachine, releaseMachine } from '../../start-a-computer/do-work/rent-a-machine.mjs';
import { dnsClient, prepareCutover, changeCutover, readCutover, keepHealthyRecords, probeHealthy } from './portable-dns-cutover.mjs';

/** The variables the rows mount the provider's key under: one for a host's hosting row, one for a name's DNS row. */
export const HOSTING_KEY = 'HOSTING_API_TOKEN', DNS_KEY = 'DNS_API_TOKEN';
/** The held value mounted under `variable`, or a refusal naming the mount the row lacks. */
export function heldFrom(variable, env = process.env) {
  const value = env[variable];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`This run was handed no held value under ${variable}; its row needs a credential mount { secret_name_from_input: <the path of the vault name in the input>, env: "${variable}" }.`);
  return value.trim();
}
/** The hosting row handed in as `hosting`, in the shape the lease owner reads. */
function hostingOf(hosting) {
  const [row] = hostingProviders([hosting]);
  if (!row) throw new Error('The row handed in as `hosting` has no rents_a_host block, so it is no hosting row.');
  return row;
}

// Shows where the door runs from the Service connections rows (record:service-connection) the caller read from the
// person's own store and handed in as `connections`: this function reads no store.
export async function seeWhereTheDoorRuns(input) {
  if (!Array.isArray(input?.connections)) throw new Error('Hand in `connections`: the record:service-connection rows as the person\'s own store holds them.');
  const connections = input.connections.filter(value => value && typeof value === 'object'), hosting = hostingProviders(connections);
  return {
    current: currentDoor(connections),
    hosting_providers: hosting.map(r => ({ id: r.id, name: r.name, move_ready: r.move_ready === true, not_ready_because: r.not_ready_because ?? null, vault_key: r.vault_key ?? null })),
  };
}

const LEASE = 'lease', CUTOVER = 'cutover';

export async function rentAHost(input, { env = process.env, fetchImpl = fetch } = {}) {
  const provider = hostingOf(input.hosting);
  const request = provider.base ? providerClient(provider, heldFrom(HOSTING_KEY, env), { fetchImpl }) : null;
  const placement = Object.fromEntries(Object.entries({ size: input.server_type, location: input.location, image: input.image, address: input.address }).filter(([, value]) => value));
  return rentMachine({ request, store: receiptStore(keptReceipts(input.lease ? { [LEASE]: input.lease } : {}), LEASE), name: input.name, publicKey: input.public_key, placement, expiresAt: input.expires_at ?? undefined, provider });
}

export async function releaseAHost(input, { env = process.env, fetchImpl = fetch } = {}) {
  const store = receiptStore(keptReceipts({ [LEASE]: input.lease }), LEASE), provider = hostingOf(input.hosting);
  if (input.lease.provider !== provider.id) throw new Error(`The lease was rented from ${input.lease.provider}, not from the hosting row handed in (${provider.id}).`);
  const request = provider.base ? providerClient(provider, heldFrom(HOSTING_KEY, env), { fetchImpl }) : null;
  return releaseMachine({ request, store, provider });
}

export async function cutAHostnameOver(input, { env = process.env, fetchImpl = fetch, call } = {}) {
  const receipts = keptReceipts(input.receipt ? { [CUTOVER]: input.receipt } : {}), c = { hostname: input.hostname, address: input.address };
  const answer = receipt => ({ state: receipt.state, hostname: receipt.hostname, address: receipt.address, mode: receipt.mode,
    original: receipt.original ?? receipt.before.records.find(x => at(x, input.dns.record.id_at ?? 'id') === receipt.targetId) ?? null, current: receipt.afterTarget ?? null, guarded_lists_preserved: receipt.before.guards.length, receipt });
  if (input.action === 'status') return answer(await readCutover(receipts, CUTOVER));
  // A description reached through the engine (transport "engine") holds no key: its requests go through `call`, which only a
  // runner outside the container hands in (cut-over-through-this-computers-engine.mjs); in a container dnsClient refuses it.
  const provider = input.dns, request = dnsClient(provider?.transport === 'engine' ? null : heldFrom(DNS_KEY, env), { fetchImpl, provider, call });
  if (input.action === 'keep-healthy') {
    const probe = candidate => probeHealthy({ hostname: input.hostname, address: candidate.address, path: candidate.health_path ?? input.health_path ?? '/' });
    return keepHealthyRecords({ hostname: input.hostname, candidates: input.candidates, check: input.check ?? probe, request, provider, adopt: input.adopt === true });
  }
  const receipt = input.action === 'prepare'
    ? await prepareCutover(c, { request, provider, receipts, file: CUTOVER })
    : await changeCutover(c, { request, provider, receipts, file: CUTOVER, rollback: input.action === 'rollback' });
  return answer(receipt);
}

// A description reached through the engine (transport "engine") runs as a workflow, whose ask steps send its declared tools
// (tool:step-a-hostname-cut-over-through-the-engine): a step replays the cut-over named in `cutover` (prepare, activate, rollback or status) against the answers the workflow
// kept so far (`transcript`: [{ request: { name, arguments }, answer }], in the order they were asked), and answers either the
// next request it needs ({ done: false, next: { name, arguments } }) or the cut-over's own answer ({ done: true, answer }). The
// same code runs as for one call, so a step changes nothing and reaches nothing: every request goes out through the workflow.
// A kept answer whose request is not the one the replay asks at that place refuses the step: those answers belong to another
// cut-over (a changed input or zone), and the run must start again.
const NEEDS_ANSWER = request => Object.assign(new Error(`The workflow is to ask ${request.name}.`), { from_a_step: true, needs_answer: true, request });
export async function stepACutover(input) {
  if (input.dns?.transport !== 'engine') throw new Error('Only a DNS description reached through the engine (transport "engine") is stepped; a keyed one runs as one call.');
  if (!['prepare', 'activate', 'rollback', 'status'].includes(input.cutover)) throw new Error('A step names the cut-over it replays: cutover is prepare, activate, rollback or status.');
  const transcript = Array.isArray(input.transcript) ? input.transcript : [];
  let used = 0;
  const call = async run => {
    const request = { name: run.tool.slice(run.tool.indexOf('/') + 1), arguments: run.input };
    if (used === transcript.length) throw NEEDS_ANSWER(request);
    const kept = transcript[used];
    if (JSON.stringify(kept?.request) !== JSON.stringify(request)) throw Object.assign(new Error(`Kept answer ${used + 1} was for another request; these answers belong to another cut-over, so start the run again.`), { from_a_step: true });
    used += 1;
    return kept.answer;
  };
  const { transcript: _kept, cutover, ...rest } = input;
  try {
    return { done: true, answer: await cutAHostnameOver({ ...rest, action: cutover }, { call }), asked: used };
  } catch (error) {
    if (error?.needs_answer) return { done: false, next: error.request, asked: used };
    throw error;
  }
}
