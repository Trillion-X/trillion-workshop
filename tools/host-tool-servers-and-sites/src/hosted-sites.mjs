// Hosted sites as DATA (see src/hosted-service.mjs for the container that runs one): which site a request's host
// names, the environment its service is started with, how its state is packed, and the rows the deploy stored.
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';

export const RESTORED_MARK = '/tmp/.hosted-service-restored';

// A service row's env with each `{ fill: { from: 'site', field } }` replaced by that site field.
export function serviceEnv(service, site) {
  return Object.fromEntries(Object.entries(service.env ?? {}).map(([name, value]) => {
    if (value && typeof value === 'object' && value.fill?.from === 'site') {
      const filled = site[value.fill.field];
      if (filled === undefined || filled === null || filled === '') throw new Error(`The site has no ${value.fill.field}, which ${service.id} needs for ${name}.`);
      return [name, String(filled)];
    }
    return [name, String(value)];
  }));
}

// The shell that packs a service's state paths (relative to /), leaving out what `exclude` names.
export function packScript(state) {
  const quote = value => `'${String(value).replace(/'/g, `'\\''`)}'`;
  const excludes = (state.exclude ?? []).map(pattern => `--exclude=${quote(pattern)}`).join(' ');
  return `cd / && tar czf - ${excludes} ${state.paths.map(path => quote(path.replace(/^\//, ''))).join(' ')}`;
}

// The start command waits until the state is restored, then runs the service's own start.
export const gatedStart = startArgv => ['sh', '-c', `while [ ! -e ${RESTORED_MARK} ]; do sleep 0.2; done; exec "$@"`, 'sh', ...startArgv];

// Each service row names the Durable Object binding and class its sites run in (`binding`, `class_name`; Ghost's
// row names neither and keeps HOSTED_SERVICE / HostedService), so a second image is a second class, never a second
// image in one. The container's image is the row's `image`, or built from `build.dockerfile_lines` by the deploy.
export const hostedBindingOf = service => service?.binding ?? 'HOSTED_SERVICE';
export const hostedClassOf = service => service?.class_name ?? 'HostedService';
export const hostedBound = env => Boolean(env.HOSTED_SERVICE || env.HOSTED_IDENTITY);

// One site's container object, in the namespace its service's row names.
export function hostedStubFor(env, siteId, service) {
  const namespace = env[hostedBindingOf(service)];
  if (!namespace) throw new Error(`${service?.id ?? 'The service'} is not bound in this deploy (${hostedBindingOf(service)}).`);
  return namespace.get(namespace.idFromName(siteId));
}

// The container objects of the sites an account sets up (their service has a first-run setup), with their ids.
export function setUpSiteStubs(env, rows) {
  return rows.filter(row => row.kind === 'hosted-site').flatMap(site => {
    const service = rows.find(row => row.kind === 'hosted-service' && row.id === site.service);
    return service?.setup && env[hostedBindingOf(service)] ? [{ id: site.id, stub: hostedStubFor(env, site.id, service) }] : [];
  });
}

export function hostedSiteFor(rows, host) {
  const site = rows.find(row => row.kind === 'hosted-site' && row.host === host);
  if (!site) return null;
  const service = rows.find(row => row.kind === 'hosted-service' && row.id === site.service);
  return service ? { site, service } : null;
}

// The hosted rows the deploy stored under their BLAKE3 identity (HOSTED_IDENTITY), read once per isolate.
let hostedRows = null;
export function loadHostedRows(env, readParts) {
  if (!env.HOSTED_IDENTITY) return Promise.resolve([]);
  hostedRows ??= (async () => {
    const bytes = await readParts(env, `hosted:rows:${env.HOSTED_IDENTITY}`);
    if (!bytes || bytesToHex(blake3(new Uint8Array(bytes))) !== env.HOSTED_IDENTITY) throw new Error('The site list is not available yet. Please try again in a minute.');
    return JSON.parse(new TextDecoder().decode(bytes));
  })().catch(error => { hostedRows = null; throw error; });
  return hostedRows;
}

// A request whose host is a hosted site goes to that site's container; any other request is not this file's.
export async function handleHostedSite(request, env, readParts) {
  if (!hostedBound(env)) return null;
  const found = hostedSiteFor(await loadHostedRows(env, readParts), new URL(request.url).hostname);
  if (!found || !env[hostedBindingOf(found.service)]) return null;
  return hostedStubFor(env, found.site.id, found.service).serve(request, found);
}

// The Workshop executor for hosted sites. `set-up` runs the service's own first-run setup inside the site's
// container (a path the public can never reach), then hands what it made (for example the site's address and an
// admin key) straight to this account's connect, so the key goes into the locked box and is never returned.
// rows(): the hosted rows; siteFor(id, service): the site's container object; connect(args): the connect executor;
// claimant: this account's opaque identity, so only the account that set a site up can be handed its key again.
export function hostedSiteExecutor({ rows, siteFor, connect, claimant }) {
  return async ({ invocation, input }) => {
    if (invocation.operation !== 'set-up') throw new Error(`A hosted site has no operation "${invocation.operation}".`);
    const all = await rows();
    const site = all.find(row => row.kind === 'hosted-site' && row.id === input.site_id);
    if (!site) throw new Error(`There is no hosted site ${input.site_id}.`);
    const service = all.find(row => row.kind === 'hosted-service' && row.id === site.service);
    if (!service?.setup) throw new Error(`${site.service} has no first-run setup.`);
    const argv = service.setup.argv.map(part => (part && typeof part === 'object' ? String(input[part.fill.field] ?? '') : String(part)));
    const ran = await siteFor(site.id, service).setUp({ site, service }, argv, claimant);
    if (ran.code !== 0) throw new Error(`The site's setup did not finish: ${ran.stderr.slice(-400)}`);
    const made = JSON.parse(ran.stdout);
    const connected = await connect({ invocation: { kind: 'held-values', operation: 'connect', provider: service.setup.connects }, input: { values: made } });
    return { site_id: site.id, site_url: site.url, connected: connected.connected === true, connection_id: connected.connection_id, checked_with_the_service: connected.checked_with_the_service };
  };
}

// A site is claimed by the first account that sets it up, BEFORE its setup runs, so a setup cut short (a restart
// between making the owner and connecting) never leaves a site no account can reach. The claiming account asking
// again is handed the connection its setup made (the service's `setup.hand_over_argv`, which reads it from the
// site itself); any other account is refused. storage: { get, put }; run(argv) → { code, stdout, stderr }.
export async function claimAndSetUp({ storage, claimant, run, argv, handOverArgv }) {
  if (typeof claimant !== 'string' || !claimant) throw new Error('Setting up a site needs the account that asks.');
  const claimed = await storage.get('claimed_by');
  if (claimed && claimed !== claimant) throw new Error('This site already has an owner.');
  if (!claimed) await storage.put('claimed_by', claimant);
  if (claimed && handOverArgv) {
    const again = await run(handOverArgv);
    if (again.code === 0) return { ...again, handed_over: true };
  }
  return { ...(await run(argv)), handed_over: false };
}
