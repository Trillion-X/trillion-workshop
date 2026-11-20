import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createOwnedWorkspace, retireDeadOwnedWorkspaces } from './owned-workspace.mjs';

const root = () => tempFolder(join(tmpdir(), 'owned-workspace-test-'));

test('release removes only the workspace created by this owner', () => {
  const ownerRoot = root();
  try {
    const first = createOwnedWorkspace(ownerRoot);
    const second = createOwnedWorkspace(ownerRoot);
    const firstOwner = JSON.parse(readFileSync(join(first.path, '.owner.json'), 'utf8'));
    assert.equal(firstOwner.process_identity.length <= 128, true);
    assert.equal(firstOwner.process_identity.includes(process.argv.join(' ')), false);
    assert.notEqual(first.path, second.path);
    first.release();
    assert.equal(existsSync(first.path), false);
    assert.equal(existsSync(second.path), true);
    second.release();
  } finally {
    rmSync(ownerRoot, { recursive: true, force: true });
  }
});

test('retirement removes a dead owner and preserves a live owner', () => {
  const ownerRoot = root();
  try {
    const live = createOwnedWorkspace(ownerRoot);
    const dead = join(ownerRoot, 'work-dead-owner');
    mkdirSync(dead);
    writeFileSync(join(dead, '.owner.json'), `${JSON.stringify({
      pid: 2_147_483_647,
      process_identity: 'no-longer-running',
      token: 'dead',
    })}\n`);
    assert.equal(retireDeadOwnedWorkspaces(ownerRoot), 1);
    assert.equal(existsSync(dead), false);
    assert.equal(existsSync(live.path), true);
    live.release();
  } finally {
    rmSync(ownerRoot, { recursive: true, force: true });
  }
});

test('retirement removes every entry no live owner holds, and only the link of a symlink', () => {
  const ownerRoot = root();
  const elsewhere = root();
  try {
    const live = createOwnedWorkspace(ownerRoot);
    const malformed = join(ownerRoot, 'work-malformed-owner');
    mkdirSync(malformed);
    writeFileSync(join(malformed, '.owner.json'), '{}\n');
    // Named folders placed by hand or another tool have no owner record.
    const handMade = join(ownerRoot, 'google-acquire-broad-candidate');
    mkdirSync(handMade);
    writeFileSync(join(handMade, 'big.bin'), 'x');
    const stray = join(ownerRoot, 'stray-file.txt');
    writeFileSync(stray, 'x');
    const leftover = join(ownerRoot, '.retired-work-old-1-abc');
    mkdirSync(leftover);
    const target = join(elsewhere, 'kept');
    mkdirSync(target);
    writeFileSync(join(target, '.owner.json'), '{}\n');
    const linked = join(ownerRoot, 'work-linked-owner');
    symlinkSync(target, linked);
    assert.equal(retireDeadOwnedWorkspaces(ownerRoot), 5);
    for (const gone of [malformed, handMade, stray, leftover, linked]) {
      assert.equal(existsSync(gone), false, gone);
    }
    assert.equal(existsSync(target), true, 'a symlink target outside the root is never followed');
    assert.equal(existsSync(live.path), true);
    live.release();
  } finally {
    rmSync(ownerRoot, { recursive: true, force: true });
    rmSync(elsewhere, { recursive: true, force: true });
  }
});

test('a workspace being assembled by a live creator is kept, a dead creator\'s is retired', () => {
  const ownerRoot = root();
  try {
    const assembling = join(ownerRoot, `.pending-${process.pid}-abc`);
    mkdirSync(assembling);
    const abandoned = join(ownerRoot, '.pending-2147483647-abc');
    mkdirSync(abandoned);
    assert.equal(retireDeadOwnedWorkspaces(ownerRoot), 1);
    assert.equal(existsSync(assembling), true);
    assert.equal(existsSync(abandoned), false);
  } finally {
    rmSync(ownerRoot, { recursive: true, force: true });
  }
});

test('a dead parent workspace remains until its owned process group is gone', async (context) => {
  if (process.platform === 'win32') context.skip('POSIX process groups are not available');
  const ownerRoot = root();
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    detached: true,
    stdio: 'ignore',
  });
  try {
    await once(child, 'spawn');
    const dead = join(ownerRoot, 'work-dead-parent-live-group');
    mkdirSync(dead);
    writeFileSync(join(dead, '.owner.json'), `${JSON.stringify({
      pid: 2_147_483_647,
      process_identity: 'no-longer-running',
      process_group_id: child.pid,
      token: 'dead-parent-live-group',
    })}\n`);
    assert.equal(retireDeadOwnedWorkspaces(ownerRoot), 0);
    assert.equal(existsSync(dead), true);
    process.kill(-child.pid, 'SIGKILL');
    await once(child, 'exit');
    assert.equal(retireDeadOwnedWorkspaces(ownerRoot), 1);
    assert.equal(existsSync(dead), false);
  } finally {
    try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    rmSync(ownerRoot, { recursive: true, force: true });
  }
});

test('release preserves a workspace while its owned process group is live', async () => {
  const ownerRoot = root();
  const controller = new AbortController();
  const workspace = createOwnedWorkspace(ownerRoot);
  let releaseWhileLive;
  try {
    await assert.rejects(workspace.run(process.execPath, [
      '-e',
      'process.stdout.write("ready");setInterval(() => {}, 1000)',
    ], {
      signal: controller.signal,
      graceMs: 20,
      onStdout: () => {
        releaseWhileLive = workspace.release();
        controller.abort(new Error('Observed live release refusal'));
      },
    }), /Observed live release refusal/);
    assert.equal(releaseWhileLive, false);
    assert.equal(existsSync(workspace.path), true);
    assert.equal(workspace.release(), true);
    assert.equal(existsSync(workspace.path), false);
  } finally {
    rmSync(ownerRoot, { recursive: true, force: true });
  }
});

test('workspace-run binds the group before work and clears it only after termination', async () => {
  const ownerRoot = root();
  const controller = new AbortController();
  const workspace = createOwnedWorkspace(ownerRoot);
  let activeGroupId;
  try {
    await assert.rejects(workspace.run(process.execPath, [
      '-e',
      'process.stdout.write("ready");setInterval(() => {}, 1000)',
    ], {
      signal: controller.signal,
      graceMs: 20,
      onStdout: () => {
        const activeOwner = JSON.parse(readFileSync(join(workspace.path, '.owner.json'), 'utf8'));
        activeGroupId = activeOwner.process_group_id;
        controller.abort(new Error('Observed bound group'));
      },
    }), /Observed bound group/);
    assert.equal(Number.isSafeInteger(activeGroupId), true);
    const stoppedOwner = JSON.parse(readFileSync(join(workspace.path, '.owner.json'), 'utf8'));
    assert.equal(stoppedOwner.process_group_id, undefined);
    assert.equal(workspace.release(), true);
  } finally {
    rmSync(ownerRoot, { recursive: true, force: true });
  }
});
