// Building and installing the public receptionist on its rented host: prepare (create), inspect (read), build and
// install (run), and the refusals. ssh never runs here: a stand-in answers for it and keeps what it was asked. git runs
// for real on a throwaway repository. Every host here is synthetic (192.0.2.x, example.com).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BINARY, BOOTSTRAP_TEST, receptionistBuild } from '../do-work/receptionist-build.mjs';
import { rowsOf } from '../../../test-helpers/tool-rows.mjs';
import { runRow, select } from '../../../test-helpers/run-a-row.mjs';

const KEY = '/run/held/rented-host-admin-key';
const host = { address: '192.0.2.10', ssh_port: 2222, admin_user: 'builder', host_key: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleExampleExampleExampleExampleExample' };
const rust = { toolchain: '1.93.0', cargo_home: '/srv/rust/cargo', rustup_home: '/srv/rust/rustup' };
const base = { host, source_root: '/srv/receptionist/source', rust };
const prepare = { ...base, build_packages: ['build-essential', 'pkg-config', 'libssl-dev'], swap: { path: '/srv/receptionist/build-swap', size: '4G' } };

// A stand-in for ssh, run the way execFileSync runs (and, when `git` is set, real git): keeps each call, reads the
// pinned known_hosts while it exists, and answers stdout or throws with the exit status as execFileSync does.
function standIn({ status = 0, stdout = 'ok\n', git = false } = {}) {
  const calls = [];
  const run = (file, args, options) => {
    if (file === '/usr/bin/git') {
      if (!git) throw new Error('git must not run');
      return execFileSync('git', args, options);
    }
    const pinned = args.find(arg => arg.startsWith('UserKnownHostsFile='))?.slice('UserKnownHostsFile='.length);
    calls.push({ file, args, input: options.input, timeout: options.timeout, known_hosts: pinned && readFileSync(pinned, 'utf8'), pinned });
    if (status) throw Object.assign(new Error(`Command failed: ${file}`), { status, stdout, stderr: 'host said no' });
    return stdout;
  };
  return { run, calls };
}

test('prepare (create): sends the build-machine setup on stdin, with the given packages, swap and pinned Rust version', () => {
  const { run, calls } = standIn({ stdout: 'receptionist-build-host-prepared\n' });
  const answer = receptionistBuild('prepare', prepare, KEY, { run });
  assert.deepEqual(answer, { operation: 'prepare', output: 'receptionist-build-host-prepared\n' });
  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.equal(call.file, '/usr/bin/ssh');
  assert.deepEqual(call.args.slice(-3), ['builder@192.0.2.10', '/bin/sh', '-s']);
  assert.ok(call.args.includes(KEY) && call.args.includes('2222'));
  assert.equal(call.known_hosts, `[192.0.2.10]:2222 ${host.host_key}\n`);
  assert.equal(existsSync(call.pinned), false, 'the pinned known_hosts file is removed after the run');
  for (const part of ['apt-get install -y -qq build-essential pkg-config libssl-dev', "fallocate -l 4G '/srv/receptionist/build-swap'",
    "install -d -m 755 '/srv/receptionist/source'", '--default-toolchain 1.93.0', "export CARGO_HOME='/srv/rust/cargo' RUSTUP_HOME='/srv/rust/rustup'"]) {
    assert.ok(call.input.includes(part), part);
  }
  assert.doesNotMatch(call.input, /sshd|authorized_keys|useradd/, 'the tunnel user and sshd settings are not this tool\'s');
});

test('inspect (read): reads the host with the given ports, service user and toolchain, and changes nothing', () => {
  const { run, calls } = standIn({ stdout: 'Linux build 6.1\nrustc 1.93.0\n' });
  const answer = receptionistBuild('inspect', { ...base, ports: [443, 9443], service_user: 'door' }, KEY, { run });
  assert.equal(answer.output, 'Linux build 6.1\nrustc 1.93.0\n');
  const command = calls[0].args.at(-1);
  for (const part of ["'/srv/rust/cargo/bin/rustc' +1.93.0 --version", "find '/srv/receptionist/source'", '(:443\\b|:9443\\b)', 'passwd -S door']) assert.ok(command.includes(part), part);
  assert.doesNotMatch(command, /chmod|install -d|apt-get|cargo build/);
  assert.equal(calls[0].input, undefined);
  const plain = receptionistBuild('inspect', base, KEY, { run: standIn().run });
  assert.equal(plain.operation, 'inspect');
});

test('build (run): archives one committed tree with real git, sends it and builds that commit', () => {
  const repository = mkdtempSync(join(tmpdir(), 'receptionist-source-'));
  try {
    const git = (...args) => spawnSync('git', ['-C', repository, '-c', 'user.name=Sample', '-c', 'user.email=sample@example.com', ...args], { encoding: 'utf8' });
    git('init', '-q');
    writeFileSync(join(repository, 'Cargo.toml'), '[package]\nname = "sample"\n');
    git('add', '.');
    git('commit', '-q', '-m', 'sample');
    writeFileSync(join(repository, 'not-committed.txt'), 'local state\n');
    const commit = git('rev-parse', 'HEAD').stdout.trim();
    const { run, calls } = standIn({ git: true, stdout: `source-commit: ${commit}\n` });
    const answer = receptionistBuild('build', { ...base, repository }, KEY, { run });
    assert.deepEqual({ ...answer, output: undefined }, { operation: 'build', state: 'built', commit, directory: `/srv/receptionist/source/${commit}`,
      executable: `/srv/receptionist/source/${commit}/target/release/${BINARY}`, output: undefined });
    const [call] = calls;
    assert.ok(Buffer.isBuffer(call.input), 'the archive goes as bytes');
    const listed = spawnSync('tar', ['-tf', '-'], { input: call.input, encoding: 'utf8' }).stdout.split('\n').filter(Boolean);
    assert.deepEqual(listed, ['Cargo.toml'], 'only committed source travels');
    const command = call.args.at(-1);
    for (const part of [`'/srv/rust/cargo/bin/cargo' +1.93.0 build --locked --release --bin ${BINARY}`, BOOTSTRAP_TEST, `tar -xf - -C '/srv/receptionist/source/${commit}'`]) assert.ok(command.includes(part), part);
    assert.equal(call.timeout, 20 * 60_000);
    assert.throws(() => receptionistBuild('build', { ...base, repository, revision: 'no-such-branch' }, KEY, { run }), /revision no-such-branch could not be read from .*Needed a single revision/s);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test('install (run): checks the built file, makes it runnable and puts a copy at install_path in one rename', () => {
  const commit = 'a'.repeat(40);
  const { run, calls } = standIn({ stdout: '-rwxr-xr-x\n' });
  const answer = receptionistBuild('install', { ...base, commit, install_path: '/srv/receptionist/bin/receptionist' }, KEY, { run });
  assert.deepEqual({ ...answer, output: undefined }, { operation: 'install', state: 'installed', commit, executable: '/srv/receptionist/bin/receptionist', output: undefined });
  assert.equal(calls.length, 2, 'one call checks and makes runnable, one places the copy');
  const command = calls.map(call => call.args.at(-1)).join('\n');
  const built = `/srv/receptionist/source/${commit}/target/release/${BINARY}`;
  for (const part of [`test -f '${built}'`, `chmod 0755 '${built}'`, "mv -f '/srv/receptionist/bin/receptionist.new' '/srv/receptionist/bin/receptionist'"]) assert.ok(command.includes(part), part);
  const inPlace = receptionistBuild('install', { ...base, commit }, KEY, { run: standIn().run });
  assert.equal(inPlace.executable, built);
});

test('a dry run answers what it would run and runs nothing', () => {
  const never = () => { throw new Error('nothing may run'); };
  const planned = receptionistBuild('build', { ...base, repository: '/nowhere', revision: 'b'.repeat(40), dry_run: true }, KEY, { run: never });
  assert.equal(planned.dry_run, true);
  assert.equal(planned.commit, 'b'.repeat(40));
  assert.equal(planned.ssh.at(-1), 'builder@192.0.2.10');
  assert.match(planned.remote_command, /cargo' \+1\.93\.0 build/);
  assert.throws(() => receptionistBuild('build', { ...base, repository: '/nowhere', revision: 'main', dry_run: true }, KEY, { run: never }), /full 40-character commit/);
});

test('refusals name the field and how to fix it, before anything runs', () => {
  const never = () => { throw new Error('nothing may run'); };
  const refused = (operation, input, pattern) => assert.throws(() => receptionistBuild(operation, input, KEY, { run: never }), pattern);
  refused('deploy', prepare, /give one of prepare, inspect, build, install/);
  refused('prepare', null, /one JSON object/);
  refused('prepare', { ...prepare, host: { ...host, address: '192.0.2.10;id' } }, /host\.address/);
  refused('prepare', { ...prepare, host: { ...host, ssh_port: 70000 } }, /host\.ssh_port/);
  refused('prepare', { ...prepare, rust: { ...rust, toolchain: 'stable' } }, /exact Rust version/);
  refused('prepare', { ...prepare, rust: undefined }, /rust is missing/);
  refused('prepare', { ...prepare, rust: { ...rust, cargo_home: 'relative/cargo' } }, /rust\.cargo_home/);
  refused('prepare', { ...prepare, source_root: "/srv/x'; rm -rf /; '" }, /source_root/);
  refused('prepare', { ...prepare, source_root: '/srv/../etc' }, /source_root/);
  refused('prepare', { ...prepare, build_packages: ['curl; reboot'] }, /build_packages/);
  refused('prepare', { ...prepare, swap: { path: '/swap', size: '4T' } }, /swap was refused/);
  refused('inspect', { ...base, ports: [0] }, /ports/);
  refused('inspect', { ...base, service_user: 'Door Person' }, /service_user/);
  refused('build', { ...base, repository: 'relative' }, /repository/);
  refused('build', { ...base, repository: '/r', revision: '--upload-pack=x' }, /revision/);
  refused('install', { ...base, commit: 'HEAD' }, /commit was refused/);
  refused('install', { ...base, commit: 'a'.repeat(40), install_path: '/srv/bin/' }, /install_path/);
});

test('a host that fails says which operation, on which host, and what it printed', () => {
  const { run } = standIn({ status: 1, stdout: 'error[E0432]: unresolved import\n' });
  assert.throws(() => receptionistBuild('install', { ...base, commit: 'c'.repeat(40) }, KEY, { run }), /install on 192\.0\.2\.10 failed \(exit 1\): error\[E0432\].*host said no/s);
});

test('every row runs as the engine runs it: its sample answers what its verify says, and a refusal is { error }', async () => {
  const rows = rowsOf('build-and-install-the-public-receptionist').map(({ payload }) => payload);
  assert.deepEqual(rows.map(row => row.invoke.argv[2]), ['prepare', 'inspect', 'build', 'install']);
  for (const row of rows) {
    for (const check of row.verify) {
      const ran = await runRow(row, check.input, check);
      assert.equal(ran.code, 0, `${row.id}: ${ran.stdout}${ran.stderr}`);
      const value = select(select(ran.last, row.result_selector), check.output_selector);
      assert.ok(String(value).includes(check.contains), `${row.id}: ${check.output_selector} holds ${check.contains}`);
      // No host, path, port, user or toolchain is written into the row: each is a declared input.
      for (const field of ['host', 'source_root']) assert.ok(row.input_schema.required.includes(field), `${row.id} requires ${field}`);
    }
    const refused = await runRow(row, { ...row.verify[0].input, host: { ...host, address: 'not a host' } }, {});
    assert.equal(refused.code, 1);
    assert.match(refused.last.error, /host\.address was refused/);
  }
  const written = JSON.stringify(rows.map(row => row.invoke));
  assert.doesNotMatch(written, /192\.0\.2|example\.com|1\.93|\/srv\/|\/opt\/trillion|root@/, 'invoke names no host, path, user or toolchain');
});
