// Ported from Trillion-X/trillion test/saved-pages-adoption.test.mjs: the F-0835 case over ingestDecision. Its finish_file_upload
// half stays with the old tree (src/file-tools.mjs calls the decision).
import test from 'node:test';
import assert from 'node:assert/strict';
import { ingestDecision } from '../src/ingest-normalization.mjs';

test('F-0835 video ingest: one playable format, supported list and reason in the words', async () => {
  const mov = ingestDecision({ name: '/clips/take 1.mov', media_type: 'video/quicktime', byte_length: 1e6 });
  assert.equal(mov.action, 'convert');
  assert.equal(mov.plan.output_name, '/clips/take 1.mp4');
  assert.ok(mov.plan.args.includes('libx264') && mov.plan.args.includes('{input}'));
  const gif = ingestDecision({ name: 'loop.gif', media_type: 'image/gif', byte_length: 10 });
  assert.ok(gif.plan.args.includes('-an'));
  assert.equal(ingestDecision({ name: 'a.bin', media_type: 'application/octet-stream', byte_length: 5 }).action, 'keep');
  assert.equal(ingestDecision({ name: 'a.webm', media_type: '', byte_length: 5 }).action, 'convert');
  assert.equal(ingestDecision({ name: 'a.mp4', media_type: 'video/mp4' }).action, 'keep');
  assert.equal(ingestDecision({ name: 'a.txt', media_type: 'text/plain' }).said, null);
  const huge = ingestDecision({ name: 'big.avi', media_type: 'video/x-msvideo', byte_length: 5 * 1024 ** 3 });
  assert.equal(huge.action, 'keep');
  assert.match(huge.said, /5120 MiB, more than the 4096 MiB one conversion takes/);
  const odd = ingestDecision({ name: 'a.ogv', media_type: 'video/ogg', byte_length: 5 });
  assert.match(odd.said, /video\/ogg is not a video type Trillion converts.*Converts: QuickTime MOV, WebM, AVI/);
});
