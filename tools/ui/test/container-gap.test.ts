// A container's gap reaches the room a section puts between two large blocks: 2xl is 40px and 3xl is 60px.
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderAView } from '../../compare-two-movements-side-by-side/tests/render-a-view.ts';

const entry = new URL('./container-as-view.tsx', import.meta.url).pathname;

test('a container gap of 2xl and 3xl draws 40px and 60px', async () => {
  assert.match(await renderAView(entry, { gap: '2xl', children: 'a' }), /gap-10/);
  assert.match(await renderAView(entry, { gap: '3xl', children: 'a' }), /gap-15/);
});
