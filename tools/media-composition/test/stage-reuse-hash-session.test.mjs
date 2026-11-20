import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { Worker } from 'node:worker_threads';
import { renameSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import { createStageHashSession, stageIdentity } from '../do-work/stage-reuse.mjs';

const workerFile = new URL('./stage-reuse-hash-worker.mjs', import.meta.url);

function renderInWorker(args) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerFile, { workerData: args });
    worker.once('message', resolve);
    worker.once('error', reject);
    worker.once('exit', code => { if (code !== 0) reject(new Error(`hash worker exited ${code}`)); });
  });
}

test('a render hash session preserves the exact stage identity and reuses only an unchanged file digest', () => {
  const dir = tempFolder(join(tmpdir(), 'stage-hash-session-'));
  const input = join(dir, 'source.bin'), out = join(dir, 'stage.mp4');
  writeFileSync(input, 'alpha bytes');
  const args = ['-i', input, '-c', 'copy', out];
  const session = createStageHashSession();

  const uncached = stageIdentity(args);
  assert.equal(stageIdentity(args, session), uncached, 'the canonical sidecar identity is byte-for-byte unchanged');
  assert.deepEqual(session.identity(input), { bytes: makeHashCodeHexFromBytes(Buffer.from('alpha bytes')), reused: true });
  assert.equal(stageIdentity(args, createStageHashSession()), uncached, 'separate render sessions produce the same identity');
});

test('replacement, same-size mutation with restored mtime, and deletion invalidate a cached digest', () => {
  const dir = tempFolder(join(tmpdir(), 'stage-hash-version-'));
  const input = join(dir, 'source.bin'), parked = join(dir, 'parked.bin'), replacement = join(dir, 'replacement.bin');
  writeFileSync(input, 'alpha');
  const session = createStageHashSession();
  assert.equal(session.identity(input).reused, false);
  const original = statSync(input);

  writeFileSync(replacement, 'bravo');
  utimesSync(replacement, original.atime, original.mtime);
  renameSync(input, parked);
  renameSync(replacement, input);
  assert.notEqual(statSync(input).ino, original.ino, 'replacement has a distinct file identity');
  const replaced = session.identity(input);
  assert.equal(replaced.reused, false);
  assert.equal(replaced.bytes, makeHashCodeHexFromBytes(Buffer.from('bravo')));

  // Whole seconds avoid Date/microsecond rounding silently changing mtime
  // while the test claims it was restored.
  const restoredSeconds = 1_700_000_000;
  utimesSync(input, restoredSeconds, restoredSeconds);
  assert.equal(session.identity(input).reused, false);
  const replacedStat = statSync(input, { bigint: true });
  writeFileSync(input, 'delta');
  utimesSync(input, restoredSeconds, restoredSeconds);
  const changedStat = statSync(input, { bigint: true });
  assert.equal(changedStat.ino, replacedStat.ino);
  assert.equal(changedStat.size, replacedStat.size);
  assert.equal(changedStat.mtimeNs, replacedStat.mtimeNs, 'mtime is restored exactly, not only to the same Date value');
  assert.notEqual(changedStat.ctimeNs, replacedStat.ctimeNs, 'the fixture isolates status-change time as the invalidator');
  const mutated = session.identity(input);
  assert.equal(mutated.reused, false, 'ctime invalidates a same-size edit even when mtime is restored');
  assert.equal(mutated.bytes, makeHashCodeHexFromBytes(Buffer.from('delta')));
  unlinkSync(input);
  assert.throws(() => session.identity(input), /ENOENT/, 'deleting a cached input cannot return its old digest');
});

test('a mutation during the read is rejected and its mixed digest is never cached', () => {
  const dir = tempFolder(join(tmpdir(), 'stage-hash-mutation-'));
  const input = join(dir, 'source.bin');
  writeFileSync(input, 'alpha');
  const session = createStageHashSession();
  const before = statSync(input);
  const originalReadSync = fs.readSync;
  let mutated = false;
  try {
    fs.readSync = (...args) => {
      if (!mutated) {
        mutated = true;
        writeFileSync(input, 'bravo');
        utimesSync(input, before.atime, before.mtime);
      }
      return originalReadSync(...args);
    };
    syncBuiltinESMExports();
    assert.throws(() => session.identity(input), /changed while its identity was checked/);
  } finally {
    fs.readSync = originalReadSync;
    syncBuiltinESMExports();
  }
  assert.equal(mutated, true, 'the injected mutation ran during the streamed hash');
  assert.equal(session.identity(input).reused, false, 'the rejected digest was not cached');
  assert.equal(session.identity(input).bytes, makeHashCodeHexFromBytes(Buffer.from('bravo')));
  assert.equal(session.identity(input).reused, true);
});

test('a read error leaves no digest cached for the next successful attempt', () => {
  const dir = tempFolder(join(tmpdir(), 'stage-hash-read-error-'));
  const input = join(dir, 'source.bin');
  writeFileSync(input, 'alpha');
  const session = createStageHashSession();
  const originalReadSync = fs.readSync;
  let failed = false;
  try {
    fs.readSync = (...args) => {
      if (!failed) {
        failed = true;
        const error = new Error('injected read failure');
        error.code = 'EIO';
        throw error;
      }
      return originalReadSync(...args);
    };
    syncBuiltinESMExports();
    assert.throws(() => session.identity(input), /injected read failure/);
  } finally {
    fs.readSync = originalReadSync;
    syncBuiltinESMExports();
  }
  assert.equal(failed, true);
  assert.equal(session.identity(input).reused, false, 'the failed hash was not cached');
  assert.equal(session.identity(input).bytes, makeHashCodeHexFromBytes(Buffer.from('alpha')));
  assert.equal(session.identity(input).reused, true);
});

test('the digest cache has a fixed entry bound', () => {
  const dir = tempFolder(join(tmpdir(), 'stage-hash-bound-'));
  const firstPath = join(dir, 'first.bin'), secondPath = join(dir, 'second.bin');
  writeFileSync(firstPath, 'first'); writeFileSync(secondPath, 'second');
  const session = createStageHashSession({ maxEntries: 1 });
  assert.equal(session.identity(firstPath).reused, false);
  assert.equal(session.identity(secondPath).reused, false);
  assert.equal(session.identity(firstPath).reused, false, 'the least recently used entry was evicted');
});

test('independent worker renders can hash the same source concurrently without sharing cache state', async () => {
  const dir = tempFolder(join(tmpdir(), 'stage-hash-workers-'));
  const input = join(dir, 'source.bin'), out = join(dir, 'stage.mp4');
  writeFileSync(input, Buffer.alloc(2 * 1024 * 1024, 17));
  const args = ['-i', input, '-c', 'copy', out];
  const [left, right] = await Promise.all([renderInWorker(args), renderInWorker(args)]);
  assert.equal(left, right);
  assert.equal(left, stageIdentity(args));
});
