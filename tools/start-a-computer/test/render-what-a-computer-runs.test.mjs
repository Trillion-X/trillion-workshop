// tools/start-a-computer/test/render-what-a-computer-runs.test.mjs
//
// The renderer of what a computer runs, on a synthetic computer: its files, its refusals and the comparison with what a computer runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { differences, renderWhatItRuns, withPrepared } from '../do-work/render-what-a-computer-runs.mjs';

const runs = {
  units: [{
    unit: 'example-place.service', template: 'tools/keep-an-engine-on-a-computer/serve-computer.service', description: 'Example place', user: 'example-place',
    state: '/var/lib/example-place', builds: '/var/lib/example-place/builds', program: 'example-engine',
    settings_file: '/etc/example-place/computer.json', settings: { listen: '127.0.0.1:7199', persons: '/var/lib/example-place/persons' },
    writable: '/var/lib/example-place', drop_ins: ['tools/start-a-computer/read-data/unit-templates/nofile.conf'],
  }],
};

test('renders the unit and its drop-ins from the template fields', () => {
  const files = renderWhatItRuns(runs);
  const unit = files.find(file => file.path === '/etc/systemd/system/example-place.service').text;
  assert.match(unit, /^ExecStart=\/var\/lib\/example-place\/builds\/current\/example-engine serve \/etc\/example-place\/computer\.json$/m);
  assert.match(unit, /^WorkingDirectory=\/var\/lib\/example-place$/m);
  assert.match(unit, /^ReadWritePaths=\/var\/lib\/example-place$/m);
  assert.doesNotMatch(unit, /\{[a-z_]+\}/);
  const dropIns = files.filter(file => file.path.startsWith('/etc/systemd/system/example-place.service.d/')).map(file => file.path);
  assert.deepEqual(dropIns, ['/etc/systemd/system/example-place.service.d/nofile.conf']);
  const config = files.find(file => file.path === '/etc/example-place/computer.json').text;
  assert.deepEqual(JSON.parse(config), runs.units[0].settings, 'the computer config is the row\'s settings, as they are');
});

test('refuses a template field the row does not give', () => {
  const { program, ...withoutProgram } = runs.units[0];
  assert.throws(() => renderWhatItRuns({ ...runs, units: [withoutProgram] }), /needs program/);
});

test('a unit names its files by path: one that does not exist, one outside the Workshop, or none is refused', () => {
  const unit = runs.units[0];
  assert.throws(() => renderWhatItRuns({ ...runs, units: [{ ...unit, template: 'tools/nope/nope.service' }] }), /template names a file that does not exist: tools\/nope\/nope\.service/);
  assert.throws(() => renderWhatItRuns({ ...runs, units: [{ ...unit, template: '../../etc/passwd' }] }), /names a file outside the Workshop/);
  assert.throws(() => renderWhatItRuns({ ...runs, units: [{ ...unit, template: '' }] }), /template names no file/);
  assert.throws(() => renderWhatItRuns({ ...runs, units: [{ ...unit, drop_ins: ['tools/nope/nope.conf'] }] }), /drop-in names a file that does not exist/);
});

test('differences name a missing file and a changed file, and match when equal', () => {
  const rendered = renderWhatItRuns(runs);
  const live = Object.fromEntries(rendered.map(({ path, text }) => [path, text]));
  assert.deepEqual(differences(rendered, live), []);
  live['/etc/example-place/computer.json'] = 'changed';
  delete live['/etc/systemd/system/example-place.service'];
  assert.deepEqual(differences(rendered, live), [
    { path: '/etc/systemd/system/example-place.service', reason: 'missing on the computer' },
    { path: '/etc/example-place/computer.json', reason: 'differs from the computer row' },
  ]);
});

test('a unit with no template is one whose unit file the computer already has: only its drop-ins and files are written', () => {
  const files = renderWhatItRuns({ units: [{ unit: 'example-web.service', user: 'example-web', drop_ins: ['tools/start-a-computer/read-data/unit-templates/nofile.conf'], files: [{ path: '/etc/example-web/site', text: 'site\n' }] }] });
  assert.deepEqual(files.map(file => file.path), ['/etc/example-web/site', '/etc/systemd/system/example-web.service.d/nofile.conf']);
});

// A computer whose runs row names the better-auth unit serves sign-in: the unit runs official Better Auth from the Workshop
// tool folder with its settings from the row, and the secret by vault key only.
const withSignIn = {
  units: [...runs.units, {
    unit: 'example-sign-in.service', template: 'tools/better-auth-official/on-a-computer/serve-better-auth.service', description: 'Example sign-in', user: 'example-sign-in',
    workshop: '/var/lib/example-sign-in/trillion-workshop', repository: 'https://github.com/Trillion-X/trillion-workshop.git',
    tool_folder: 'tools/better-auth-official', workshop_commit: '7777777777777777777777777777777777777777', node_bin: '/opt/node/bin', settings_file: '/var/lib/example-sign-in/settings.json',
    settings: { port: 7201, base_url: 'https://place.example.test', issuer: 'https://place.example.test', store: { credential: 'sign-in-store', env: 'BETTER_AUTH_STORE_CONNECTION' } },
    secret_vault_key: 'example-better-auth-secret', secret_name: 'better-auth-secret', secret_file: '/etc/example-sign-in/better-auth-secret',
    credentials: [
      { vault_key: 'example-store', name: 'sign-in-store', file: '/etc/credstore.encrypted/sign-in-store', env: 'BETTER_AUTH_STORE_CONNECTION' },
      { vault_key: 'example-sender-key', name: 'example-sender-key', file: '/etc/credstore.encrypted/example-sender-key' },
    ],
    writable: '/var/lib/example-sign-in',
  }],
};

test('a row that names the better-auth unit renders it and its settings file', () => {
  const files = renderWhatItRuns(withSignIn);
  const unit = files.find(file => file.path === '/etc/systemd/system/example-sign-in.service').text;
  assert.doesNotMatch(unit, /\{[a-z_]+\}/);
  assert.match(unit, /^LoadCredentialEncrypted=better-auth-secret:\/etc\/example-sign-in\/better-auth-secret$/m);
  assert.match(unit, /^# BETTER_AUTH_SECRET is the value held under the vault name example-better-auth-secret:/m);
  assert.match(unit, /^Environment=BETTER_AUTH_SETTINGS=\/var\/lib\/example-sign-in\/settings\.json$/m);
  const W = '/var/lib/example-sign-in/trillion-workshop', PIN = '7'.repeat(40);
  assert.ok(unit.includes(`ExecStartPre=/bin/sh -c 'git -C ${W} fetch -q --depth 1 https://github.com/Trillion-X/trillion-workshop.git ${PIN} && git -C ${W} checkout -q --detach ${PIN}'`), 'the pinned commit is fetched into the copy that stays');
  assert.ok(unit.includes(`lock=$$(git -C ${W} rev-parse ${PIN}:tools/better-auth-official/package-lock.json)`), 'npm runs only when the pinned lock file is not the one installed');
  assert.ok(unit.includes(`echo "$$lock" > ${W}/.git/npm-lock-id`));
  assert.doesNotMatch(unit, /git clone/);
  assert.match(unit, /exec node server\.mjs'$/m);
  assert.match(unit, /^LoadCredentialEncrypted=sign-in-store:\/etc\/credstore\.encrypted\/sign-in-store$/m);
  assert.match(unit, /^LoadCredentialEncrypted=example-sender-key:\/etc\/credstore\.encrypted\/example-sender-key$/m);
  assert.match(unit, / BETTER_AUTH_STORE_CONNECTION="\$\(cat "\$CREDENTIALS_DIRECTORY\/sign-in-store"\)" && export BETTER_AUTH_STORE_CONNECTION && exec node/, 'a credential that names an env is handed in it');
  assert.doesNotMatch(unit, /example-sender-key"\)/, 'a credential with no env is read by the server from its credentials folder');
  const settings = files.find(file => file.path === '/var/lib/example-sign-in/settings.json');
  assert.deepEqual(JSON.parse(settings.text), withSignIn.units[1].settings);
});

test('a sign-in unit without its secret file or settings file is refused', () => {
  const { secret_file, ...noSecret } = withSignIn.units[1];
  assert.throws(() => renderWhatItRuns({ ...withSignIn, units: [runs.units[0], noSecret] }), /needs secret_file/);
  const { settings_file, ...noSettingsFile } = withSignIn.units[1];
  assert.throws(() => renderWhatItRuns({ ...withSignIn, units: [runs.units[0], noSettingsFile] }), /needs settings_file/);
});

// A unit that names `prepare` is handed to its program's own module first, which knows its program: start-a-computer writes
// the files it answers beside the unit and joins the ports it opens, and knows nothing else about it.
test('a unit that names prepare is made by its program\'s own module: its files and ports', async () => {
  const unit = { ...runs.units[0], prepare: 'tools/start-a-computer/test/fixtures/prepare-example.mjs', greeting: 'hello' };
  const prepared = await withPrepared({ ...runs, units: [unit], machine: { firewall_allow: ['22/tcp'] } }, { pages: [{ name: 'icon.png', bytes: Buffer.from([0x89, 0x50]) }] });
  assert.equal(prepared.units[0].prepare, undefined);
  assert.equal(prepared.units[0].greeting, undefined, 'the module takes the fields it reads');
  assert.deepEqual(prepared.machine.firewall_allow, ['22/tcp', '9000/tcp']);
  const files = renderWhatItRuns(prepared);
  assert.equal(files.find(file => file.path === '/etc/example-greeter/example-place.service.txt').text, 'hello\n');
  assert.deepEqual(files.find(file => file.path === '/var/lib/example-greeter/icon.png'), { path: '/var/lib/example-greeter/icon.png', text: 'iVA=', binary: true, then: [] }, 'what the request hands every module reaches it');
  await assert.rejects(withPrepared({ ...runs, units: [{ ...unit, prepare: 'tools/nope/prepare.mjs' }] }), /prepare names a file that does not exist/);
  await assert.rejects(withPrepared({ ...runs, units: [{ ...unit, prepare: 'tools/start-a-computer/do-work/fill-fields.mjs' }] }), /exports no prepare/);
  await assert.rejects(withPrepared({ ...runs, units: [unit], machine: { firewall_allow: null } }), /firewall is kept by another program/);
});

// A program the row builds from its own source commit, run by an interpreter, with its held values as sealed credentials and
// its own folder under /run that a web server's group may read (a site's program on a socket there).
test('serve-a-built-program renders the built program, its interpreter, its credentials and its /run folder', () => {
  const unit = {
    unit: 'example-site.service', template: 'tools/start-a-computer/read-data/unit-templates/serve-a-built-program.service',
    description: 'Example site program', user: 'example-site', group: 'example-web', state: '/var/lib/example-site',
    builds: '/var/lib/example-site/builds', program: 'serve.mjs', interpreter: '/opt/node/bin/node', runtime_directory: 'sites/place.example.test',
    environment: ['SOCKET=/run/sites/place.example.test/http.sock'], writable: '/var/lib/example-site',
    credentials: [{ name: 'store', file: '/etc/credstore.encrypted/example-site-store' }],
  };
  const [file] = renderWhatItRuns({ units: [unit] });
  assert.equal(file.path, '/etc/systemd/system/example-site.service');
  assert.doesNotMatch(file.text, /\{[a-z_]+\}/);
  assert.match(file.text, /^ExecStart=\/opt\/node\/bin\/node \/var\/lib\/example-site\/builds\/current\/serve\.mjs$/m);
  assert.match(file.text, /^LoadCredentialEncrypted=store:\/etc\/credstore\.encrypted\/example-site-store$/m);
  assert.match(file.text, /^RuntimeDirectory=sites\/place\.example\.test$/m);
  assert.match(file.text, /^Group=example-web$/m);
  // A restart keeps the socket's folder and lets the program finish the calls it holds.
  assert.match(file.text, /^RuntimeDirectoryPreserve=restart$/m);
  assert.match(file.text, /^KillMode=mixed$/m);
  assert.match(file.text, /^TimeoutStopSec=30$/m);
});

// Two slots of one site program share its /run folder, each on its own socket: each says runtime_preserve yes, so the slot that
// stops never removes the folder the other serves from (Nov 21 2026: a site restarted in place made its names wait).
test('serve-a-built-program keeps its /run folder always when its row says runtime_preserve yes', () => {
  const unit = {
    unit: 'example-site.service', template: 'tools/start-a-computer/read-data/unit-templates/serve-a-built-program.service',
    description: 'Example site program', user: 'example-site', group: 'example-web', state: '/var/lib/example-site',
    builds: '/var/lib/example-site/builds', program: 'serve.mjs', interpreter: '/opt/node/bin/node', runtime_directory: 'sites/place.example.test',
    environment: ['SOCKET=/run/sites/place.example.test/http.sock'], writable: '/var/lib/example-site', credentials: [],
    runtime_preserve: 'yes',
    slots: { a: { environment: ['SOCKET=/run/sites/place.example.test/http-a.sock'] }, b: { environment: ['SOCKET=/run/sites/place.example.test/http-b.sock'] } },
  };
  const files = renderWhatItRuns({ units: [unit] }).filter(file => file.path.startsWith('/etc/systemd/system/example-site-'));
  assert.deepEqual(files.map(file => file.path), ['/etc/systemd/system/example-site-a.service', '/etc/systemd/system/example-site-b.service']);
  for (const [file, slot] of [[files[0], 'a'], [files[1], 'b']]) {
    assert.match(file.text, /^RuntimeDirectoryPreserve=yes$/m);
    assert.match(file.text, new RegExp(`^Environment=SOCKET=/run/sites/place\\.example\\.test/http-${slot}\\.sock$`, 'm'));
  }
});

test('a standing probe is a kept-running unit: the probe program from this Workshop, its URLs in the row, and the one folder it writes', () => {
  const command = '/opt/node/bin/node /usr/local/lib/example-probe/probe.mjs --every-ms 5000 --log /var/lib/example-probe/requests.jsonl --log-max-bytes 1000000 https://place.example.test/?utm_content=check https://www.place.example.test/?utm_content=check';
  const files = renderWhatItRuns({ units: [{
    unit: 'example-probe.service', user: 'example-probe', state: '/var/lib/example-probe', node_bin: '/opt/node/bin', description: 'Asks the example sites from this computer',
    template: 'tools/start-a-computer/read-data/unit-templates/init-systemd-system.service', drop_ins: ['tools/start-a-computer/read-data/unit-templates/writable.conf'],
    writable: '/var/lib/example-probe', script: 'tools/start-a-computer/do-work/probe-while-applying.mjs', script_file: '/usr/local/lib/example-probe/probe.mjs', command,
  }] });
  assert.deepEqual(files.map(file => file.path), ['/etc/systemd/system/example-probe.service', '/usr/local/lib/example-probe/probe.mjs', '/etc/systemd/system/example-probe.service.d/writable.conf']);
  assert.match(files[0].text, /^ExecStart=\/opt\/node\/bin\/node \/usr\/local\/lib\/example-probe\/probe\.mjs --every-ms 5000 .* https:\/\/www\.place\.example\.test\/\?utm_content=check$/m);
  assert.match(files[0].text, /^ProtectSystem=strict$/m);
  assert.equal(files[1].text, readFileSync(new URL('../do-work/probe-while-applying.mjs', import.meta.url), 'utf8'), 'the probe is this Workshop\'s own');
  assert.match(files[2].text, /^\[Service\]\nReadWritePaths=\/var\/lib\/example-probe$/m);
  assert.doesNotMatch(files[2].text, /\{[a-z_]+\}/);
  assert.throws(() => renderWhatItRuns({ units: [{ unit: 'x.service', user: 'x', drop_ins: ['tools/start-a-computer/read-data/unit-templates/writable.conf'] }] }), /needs writable/);
});
