import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { markStage, reusable, stageIdentity } from '../do-work/stage-reuse.mjs';

const scratch = tmpdir();

test('a resumed stage is reused only when its sidecar matches the exact args and input files it was made from', () => {
  const dir = mkdtempSync(join(scratch, 'resume-'));
  const input = join(dir, 'in.txt');
  const out = join(dir, 'stage.bin');
  writeFileSync(input, 'alpha');
  writeFileSync(out, 'OUTPUT BYTES');
  const argsA = ['-i', input, '-c', 'copy', out];
  markStage(out, stageIdentity(argsA));

  // (a) same args, same inputs: reusable.
  assert.equal(reusable(out, argsA), true);

  // (b) different args (a changed encode command): not reusable.
  const argsB = ['-i', input, '-c:v', 'libx264', out];
  assert.equal(reusable(out, argsB), false);

  // (b2) same args, but the input file changed size: not reusable.
  writeFileSync(input, 'alpha, edited to a new size');
  assert.equal(reusable(out, argsA), false);

  // (c) an output with no sidecar is never reusable.
  const bare = join(dir, 'bare.bin');
  writeFileSync(bare, 'OUTPUT BYTES');
  assert.equal(reusable(bare, ['-i', input, '-c', 'copy', bare]), false);
});

test('a concat stage binds the bytes it names, so a rebuilt clip invalidates downstream resume', () => {
  const dir = mkdtempSync(join(scratch, 'resume-concat-'));
  const clip = join(dir, 'changed clip.mp4'), list = join(dir, 'list.txt'), out = join(dir, 'spine.mp4');
  writeFileSync(clip, 'AAAA'); writeFileSync(out, 'old spine');
  writeFileSync(list, "file 'changed clip.mp4'\n");
  const args = ['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', out];
  markStage(out, stageIdentity(args)); assert.equal(reusable(out, args), true);
  writeFileSync(clip, 'BBBB');
  assert.equal(reusable(out, args), false, 'the unchanged list cannot qualify a rebuilt source clip');
  writeFileSync(list, "file 'unclosed\n");
  assert.throws(() => stageIdentity(args), /cannot be bound/);
});
