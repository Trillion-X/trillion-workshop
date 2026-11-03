// The copy guard (parts/ui/show/clipboard/copy-guard.ts): light ink painted on a dark look is not pasted as invisible colour.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ownInkShare, perceivedLuma, shouldGuard, structureBlocks, installCopyGuard } from '../show/copy-guard.ts';

test('light ink on a dark look is the look\'s own ink, dark ink on it is not', () => {
  assert.equal(ownInkShare(['rgb(255, 255, 255)', 'rgba(250, 250, 250, 1)'], 'dark'), 1);
  assert.equal(ownInkShare(['rgb(10, 10, 10)', 'rgb(255, 255, 255)'], 'dark'), 0.5);
  assert.equal(ownInkShare(['rgb(10, 10, 10)'], 'light'), 1);
  assert.equal(ownInkShare(['not a colour'], 'dark'), 0);
  assert.ok(Math.abs(perceivedLuma('#ffffff') - 1) < 1e-9);
});

test('only a look unlike the paste target, painted in its own ink, is guarded', () => {
  const light = ['rgb(250, 250, 250)'];
  assert.equal(shouldGuard(light, 'dark'), true);
  assert.equal(shouldGuard(light, 'light'), false, 'a light look matches the light paste target');
  assert.equal(shouldGuard(light, null), false);
  assert.equal(shouldGuard(['rgb(0, 0, 0)'], 'dark'), false, 'dark ink on a dark look (a light card) pastes fine');
});

test('the words keep their paragraphs and lines and nothing else', () => {
  const blocks = structureBlocks('first line\nline two\n\nnext');
  console.log('BLOCKS:', JSON.stringify(blocks));
  assert.deepEqual(blocks, [['first line', 'line two'], ['next']]);
});

test('without a page the installer does nothing', () => {
  assert.equal(typeof installCopyGuard(), 'function');
});
