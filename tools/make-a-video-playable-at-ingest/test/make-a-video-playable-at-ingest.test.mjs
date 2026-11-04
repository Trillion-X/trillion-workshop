// tools/make-a-video-playable-at-ingest/test/make-a-video-playable-at-ingest.test.mjs: the tool's run over made-up input, and each row run the way the runner runs it.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { answerOf, rowOf, select } from '../../../test-helpers/run-a-row.mjs';
import { decideAVideoAtIngest } from '../do-work/make-a-video-playable-at-ingest.mjs';

const rows = JSON.parse(readFileSync(new URL('../tool-rows.json', import.meta.url), 'utf8'));

test('a MOV is converted to MP4 with the runner\'s arguments, an MP4 is kept, and the types converted are said', () => {
  const mov = decideAVideoAtIngest({ name: '/clips/take 1.mov', media_type: 'video/quicktime', byte_length: 1e6 });
  assert.equal(mov.action, 'convert');
  assert.equal(mov.plan.output_name, '/clips/take 1.mp4');
  assert.match(mov.converts, /QuickTime MOV, WebM, AVI/);
  assert.equal(decideAVideoAtIngest({ name: 'a.mp4', media_type: 'video/mp4' }).action, 'keep');
});

test('tool:decide-a-video-at-ingest runs as the container runner runs it, on its own sample', async () => {
  const row = rowOf(rows, 'tool:decide-a-video-at-ingest');
  const ran = await answerOf(row, row.verify[0].input);
  assert.equal(ran.status, 0, JSON.stringify(ran.error));
  assert.match(JSON.stringify(select(ran, row.result_selector + row.verify[0].output_selector.slice(1))), new RegExp(row.verify[0].contains));
});
