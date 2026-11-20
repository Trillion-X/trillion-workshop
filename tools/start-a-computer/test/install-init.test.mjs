import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { INIT_ROWS, installInit, removeInit, renderInit, selectInit } from '../do-work/install-init.mjs';

const values = { label: 'example-carrier', command: ['/opt/example/bin/program', '--config', '/opt/ex ample/a&b.toml'], home: '/home/example', uid: 501, user: 'example', state: '/var/example', log_file: '/var/example/example.log', description: 'Carries an example', image: 'registry.example.test/example:1' };

test('every shipped init row renders a file and steps for its kind of computer', () => {
  const by = Object.fromEntries(INIT_ROWS.map(row => [row.id, renderInit(row, values)]));
  assert.equal(by['launchd-user-agent'].path, '/home/example/Library/LaunchAgents/example-carrier.plist');
  assert.match(by['launchd-user-agent'].text, /<string>\/opt\/ex ample\/a&amp;b\.toml<\/string>/);
  assert.deepEqual(by['launchd-user-agent'].load, [['/bin/launchctl', 'bootstrap', 'gui/501', '/home/example/Library/LaunchAgents/example-carrier.plist']]);
  assert.equal(by['launchd-system-daemon'].path, '/Library/LaunchDaemons/example-carrier.plist');
  assert.match(by['systemd-user-unit'].text, /ExecStart="\/opt\/example\/bin\/program" "--config" "\/opt\/ex ample\/a&b\.toml"/);
  assert.match(by['systemd-user-unit'].text, /WantedBy=default\.target/);
  assert.match(by['systemd-system-unit'].text, /User=example/);
  assert.equal(by['systemd-system-unit'].path, '/etc/systemd/system/example-carrier.service');
  assert.match(by['quadlet-container'].text, /Image=registry\.example\.test\/example:1/);
  assert.match(by['startup-task'].text, /<Command>\/opt\/example\/bin\/program<\/Command><Arguments>"--config" "\/opt\/ex ample\/a&amp;b\.toml"<\/Arguments>/);
  assert.deepEqual(by['startup-task'].load.at(-1), ['schtasks', '/Run', '/TN', 'example-carrier']);
});

test('a row is chosen by what the computer is and the scope asked for', () => {
  assert.equal(selectInit(INIT_ROWS, { platform: 'darwin', arch: 'arm64' }, 'user').id, 'launchd-user-agent');
  assert.equal(selectInit(INIT_ROWS, { platform: 'darwin', arch: 'arm64' }, 'system').id, 'launchd-system-daemon');
  assert.equal(selectInit(INIT_ROWS, { platform: 'linux', arch: 'x64' }, 'user').id, 'systemd-user-unit');
  assert.equal(selectInit(INIT_ROWS, { platform: 'linux', arch: 'x64' }, 'container').id, 'quadlet-container');
  assert.equal(selectInit(INIT_ROWS, { platform: 'win32', arch: 'x64' }, 'system').id, 'startup-task');
  assert.throws(() => selectInit(INIT_ROWS, { platform: 'plan9' }, 'user'), /no init row/);
});

test('a row that needs a value the request lacks, or a command that is not an argv, is refused', () => {
  const quadlet = INIT_ROWS.find(row => row.id === 'quadlet-container');
  const { image, ...without } = values;
  assert.throws(() => renderInit(quadlet, without), /needs image/);
  assert.throws(() => renderInit(INIT_ROWS[0], { ...values, command: 'a string' }), /needs command/);
  assert.throws(() => renderInit({ ...INIT_ROWS[0], text: 'x {unknown_field}' }, values), /needs unknown_field/);
});

test('a synthetic init row works with no code change: file written, old unloaded, waited on, new loaded', t => {
  const dir = tempFolder(join(tmpdir(), 'init-row-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const row = { id: 'synthetic-init', scope: 'user', match: { platform: 'made-up' }, text: 'run={command} as {label}\n', file: `${dir}/{label}.conf`, mode: '0600', unload: [['stop-it', '{label}']], absent: 'nothing runs', gone: ['is-it-there', '{label}'], gone_within_ms: 1000, load: [['start-it', '{file}']] };
  const calls = []; let there = 2;
  const run = (command, args) => {
    calls.push([command, ...args]);
    if (command === 'is-it-there' && --there < 0) throw new Error('gone');
  };
  const done = installInit(row, { label: 'synthetic', command: ['/bin/x', 'a b'] }, { run, pause: () => {} });
  assert.equal(readFileSync(`${dir}/synthetic.conf`, 'utf8'), 'run=/bin/x a b as synthetic\n');
  assert.deepEqual(calls, [['stop-it', 'synthetic'], ['is-it-there', 'synthetic'], ['is-it-there', 'synthetic'], ['is-it-there', 'synthetic'], ['start-it', `${dir}/synthetic.conf`]]);
  assert.equal(done.replaced, true);
  // nothing running: the refusal the row names is not an error, and nothing is waited on
  const first = [];
  const refused = installInit(row, { label: 'synthetic', command: ['/bin/x'] }, { run: (command, args) => { first.push(command); if (command === 'stop-it') throw Object.assign(new Error('failed'), { stderr: 'nothing runs here' }); }, pause: () => {} });
  assert.deepEqual(first, ['stop-it', 'start-it']); assert.equal(refused.replaced, false);
  // any other refusal is an error
  assert.throws(() => installInit(row, { label: 'synthetic', command: ['/bin/x'] }, { run: command => { if (command === 'stop-it') throw Object.assign(new Error('boom'), { stderr: 'permission denied' }); }, pause: () => {} }), /boom/);
  removeInit(row, { label: 'synthetic', command: ['/bin/x'] }, { run: command => { if (command === 'is-it-there') throw new Error('gone'); }, pause: () => {} });
  assert.equal(existsSync(`${dir}/synthetic.conf`), false);
});
