// Outcome tests for the hosted-site functions, ported from the old test file of the same name (its last commit before the Worker host was retired, 4ffa1dc4a2^).
// The service is a generic example (example.com), not a named product: the old Ghost rows are not used here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { claimAndSetUp, gatedStart, hostedSiteExecutor, hostedSiteFor, isBlockedPath, packScript, reassignClaim, serviceEnv } from '../src/hosted-sites.mjs';

const rows = [
  {
    kind: 'hosted-site', id: 'site:letters', service: 'service:blog', label: 'Letters site',
    host: 'letters.example.com', url: 'https://letters.example.com',
  },
  {
    kind: 'hosted-service', id: 'service:blog', label: 'A blog service',
    env: { NODE_ENV: 'production', url: { fill: { from: 'site', field: 'url' } }, database__filename: '/var/lib/blog/data/blog.db' },
    state: {
      paths: ['/var/lib/blog/content'],
      exclude: ['var/lib/blog/content/data/blog.db*', 'var/lib/blog/content/logs'],
    },
    blocked_paths: ['/admin/setup'],
    port: 2368,
    start_argv: ['docker-entrypoint.sh', 'node', 'current/index.js'],
    setup: {
      argv: ['node', '-e', 'setup', { fill: { from: 'input', field: 'owner_name' } }, { fill: { from: 'input', field: 'owner_email' } }, { fill: { from: 'input', field: 'title' } }],
      hand_over_argv: ['node', '-e', 'hand-over'],
      connects: 'blog',
    },
  },
];

test('a request host picks its site and service from DATA, and the service env fills from the site', () => {
  const { site, service } = hostedSiteFor(rows, 'letters.example.com');
  assert.equal(site.id, 'site:letters');
  assert.equal(serviceEnv(service, site).url, 'https://letters.example.com');
  assert.equal(hostedSiteFor(rows, 'elsewhere.example'), null);
  assert.throws(() => serviceEnv(service, { ...site, url: '' }), /has no url/);
  assert.equal(isBlockedPath(service, '/admin/setup/'), true, 'first-run setup is never open to the public');
  assert.equal(isBlockedPath(service, '/'), false);
});

test('the start waits for the restore mark, and the pack leaves out the live database', () => {
  const [, , script, , ...start] = gatedStart(['docker-entrypoint.sh', 'node', 'current/index.js']);
  assert.match(script, /while \[ ! -e \/tmp\/\.hosted-service-restored \]/);
  assert.deepEqual(start, ['docker-entrypoint.sh', 'node', 'current/index.js']);
  const { service } = hostedSiteFor(rows, 'letters.example.com');
  const pack = packScript(service.state);
  assert.match(pack, /--exclude='var\/lib\/blog\/content\/data\/blog\.db\*'/);
  assert.ok(pack.endsWith("'var/lib/blog/content'"));
  // The shell the pack runs is valid: `sh -n` parses it without running it.
  execFileSync('sh', ['-n', '-c', pack]);
});

test('setting up a site runs its setup inside the site and connects this account, never returning the key', async () => {
  const calls = [];
  const execute = hostedSiteExecutor({
    rows: async () => rows,
    claimant: 'maker:one',
    siteFor: id => ({
      setUp: async (found, argv, claimant) => {
        calls.push([id, found.site.url, argv.slice(3), claimant]);
        return { code: 0, stdout: JSON.stringify({ site_url: 'https://letters.example.com', admin_api_key: 'abc:0011' }), stderr: '' };
      },
    }),
    connect: async args => {
      calls.push(['connect', args.invocation.provider, Object.keys(args.input.values)]);
      return { connected: true, connection_id: 'service_connection:blog', checked_with_the_service: true };
    },
  });
  const done = await execute({ invocation: { operation: 'set-up' }, input: { site_id: 'site:letters', owner_name: 'Owner', owner_email: 'owner@example.com', title: 'Letters' } });
  assert.deepEqual(done, { site_id: 'site:letters', site_url: 'https://letters.example.com', connected: true, connection_id: 'service_connection:blog', checked_with_the_service: true });
  assert.equal(JSON.stringify(done).includes('0011'), false, 'the key is never returned');
  assert.deepEqual(calls, [
    ['site:letters', 'https://letters.example.com', ['Owner', 'owner@example.com', 'Letters'], 'maker:one'],
    ['connect', 'blog', ['site_url', 'admin_api_key']],
  ]);
  await assert.rejects(execute({ invocation: { operation: 'set-up' }, input: { site_id: 'site:none' } }), /no hosted site/);
});

test('a site is claimed before its setup runs: the claimant is handed its connection again, anyone else is refused', async () => {
  const kept = new Map();
  const storage = { get: async key => kept.get(key), put: async (key, value) => { kept.set(key, value); } };
  const ran = [];
  let ownerMade = false;
  const run = async argv => {
    ran.push(argv[0]);
    if (argv[0] === 'setup') {
      if (ownerMade) return { code: 1, stdout: '', stderr: 'This site already has an owner.' };
      ownerMade = true;
      return { code: 0, stdout: '{"made":1}', stderr: '' };
    }
    return ownerMade ? { code: 0, stdout: '{"made":1}', stderr: '' } : { code: 1, stdout: '', stderr: 'not set up yet' };
  };
  const first = await claimAndSetUp({ storage, claimant: 'maker:one', run, argv: ['setup'], handOverArgv: ['hand-over'] });
  assert.deepEqual([first.code, first.handed_over], [0, false]);
  // The first run was cut short after the owner was made; the same account asking again gets the connection.
  const again = await claimAndSetUp({ storage, claimant: 'maker:one', run, argv: ['setup'], handOverArgv: ['hand-over'] });
  assert.deepEqual([again.code, again.handed_over, again.stdout], [0, true, '{"made":1}']);
  await assert.rejects(claimAndSetUp({ storage, claimant: 'maker:two', run, argv: ['setup'], handOverArgv: ['hand-over'] }), /already has an owner/);
  await assert.rejects(claimAndSetUp({ storage, claimant: '', run, argv: ['setup'] }), /needs the account/);
  assert.deepEqual(ran, ['setup', 'hand-over']);
  // A claim whose setup never finished runs the setup again for that account.
  kept.clear();
  kept.set('claimed_by', 'maker:three');
  ownerMade = false;
  ran.length = 0;
  const resumed = await claimAndSetUp({ storage, claimant: 'maker:three', run, argv: ['setup'], handOverArgv: ['hand-over'] });
  assert.deepEqual([resumed.code, resumed.handed_over, ran], [0, false, ['hand-over', 'setup']]);
});

test('a claim moves to another account only from the account that holds it now', async () => {
  const kept = new Map([['claimed_by', 'maker:one']]);
  const storage = { get: async key => kept.get(key), put: async (key, value) => { kept.set(key, value); } };
  assert.equal(await reassignClaim({ storage, from: 'maker:two', to: 'maker:three' }), false, 'a stranger cannot take the claim');
  assert.equal(kept.get('claimed_by'), 'maker:one');
  assert.equal(await reassignClaim({ storage, from: 'maker:one', to: 'maker:three' }), true);
  assert.equal(kept.get('claimed_by'), 'maker:three');
});
