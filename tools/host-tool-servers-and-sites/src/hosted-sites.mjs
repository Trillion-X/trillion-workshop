// Hosted sites as DATA (the hosted-site and hosted-service rows a site is made from): which site a request's host names,
// the environment its service is started with, how its state is packed, which paths the public may never reach, and the
// first-run set-up that claims a site for one account. Each function takes its rows or storage as input and reads nothing
// else, so a site on a person's own computer uses the same functions as any other host.
//
// Retired with the Cloudflare host (the Worker and its Durable Object classes, ruled out Nov 17 2026, commit 2026c5f21 in
// in the Workshop's history): the binding and class names (hostedBindingOf, hostedClassOf), the container stubs (hostedStubFor,
// setUpSiteStubs), the stored-rows identity read (loadHostedRows) and the request routing (handleHostedSite). The container
// lifecycle that used them (wake, save and restore state, sleep when idle) is not in this folder; see the tool's README.

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

// A path the public may never reach (for example a first-run owner setup that anyone could claim): true when the
// request's pathname starts with one of the service's `blocked_paths`.
export function isBlockedPath(service, pathname) {
  return (service?.blocked_paths ?? []).some(path => pathname.startsWith(path));
}

export function hostedSiteFor(rows, host) {
  const site = rows.find(row => row.kind === 'hosted-site' && row.host === host);
  if (!site) return null;
  const service = rows.find(row => row.kind === 'hosted-service' && row.id === site.service);
  return service ? { site, service } : null;
}

// The Workshop executor for hosted sites. `set-up` runs the service's own first-run setup inside the site (a path the
// public can never reach), then hands what it made (for example the site's address and an admin key) straight to this
// account's connect, so the key goes into the locked box and is never returned.
// rows(): the hosted rows; siteFor(id, service): the site's runner, with setUp(found, argv, claimant) → { code, stdout, stderr };
// connect(args): the connect executor; claimant: this account's opaque identity.
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

// Hands a site's claim from one account to another. Only the account that holds the claim now may hand it on; any other
// asker gets false and the claim stays where it was.
export async function reassignClaim({ storage, from, to }) {
  if ((await storage.get('claimed_by')) !== from) return false;
  await storage.put('claimed_by', to);
  return true;
}
