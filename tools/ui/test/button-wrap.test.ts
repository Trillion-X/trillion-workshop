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

// A call to action weighs what the look's --cta-font-weight says (else --button-font-weight), and a plain button's weight
// is not the call to action's: the face comes from the Button's own emphasis, in any container.
test('a button with emphasis cta takes its weight from the look\'s cta weight', async () => {
  const cta = await renderAView(entry, { children: 'See pricing', variant: 'primary', emphasis: 'cta' });
  assert.match(cta, /var\(--cta-font-weight,var\(--button-font-weight,600\)\)/);
  const plain = await renderAView(entry, { children: 'See pricing', variant: 'primary' });
  assert.doesNotMatch(plain, /--cta-font-weight/);
});

// The strong face fills with the look's strongest ink, and `arrow` draws a trailing arrow after the label.
test('a strong button wears the strongest ink and an arrow follows its label when asked', async () => {
  const strong = await renderAView(entry, { children: 'Checkout', variant: 'strong', arrow: true });
  assert.match(strong, /--button-strong-bg/);
  assert.match(strong, /<svg/);
  const plain = await renderAView(entry, { children: 'Checkout', variant: 'strong' });
  assert.doesNotMatch(plain, /<svg/);
});
