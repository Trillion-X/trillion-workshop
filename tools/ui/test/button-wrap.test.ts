// A button keeps its label on one line unless it is given `wrap`: then a long label wraps inside the pill instead of running
// past the screen.
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderAView } from '../../compare-two-movements-side-by-side/tests/render-a-view.ts';

const entry = new URL('./button-as-view.tsx', import.meta.url).pathname;

test('a button never wraps its label unless it is given wrap', async () => {
  const plain = await renderAView(entry, { children: 'A long label' });
  assert.match(plain, /whitespace-nowrap/);
  assert.doesNotMatch(plain, /whitespace-normal/);
  const wrapped = await renderAView(entry, { children: 'A long label', wrap: true });
  assert.match(wrapped, /whitespace-normal/);
  assert.doesNotMatch(wrapped, /wrap="/);
});
