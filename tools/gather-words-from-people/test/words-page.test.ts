import test from 'node:test';
import assert from 'node:assert/strict';
import { renderAView } from '../../compare-two-movements-side-by-side/tests/render-a-view.ts';

const entry = new URL('../show/Words.tsx', import.meta.url).pathname;
const page = {
  heading: 'Say a few words', body: 'Tell us how it went.', words_label: 'Your words', words_hint: 'A few sentences are plenty.',
  consent_legend: 'May we share them?', consent_note: 'You can change your mind.', button: 'Send', invalid: 'Try again.',
  thanks: { heading: 'Thank you so much', body: 'We have your words.' }, not_found: { heading: 'No such link', body: 'Ask again.' },
};
const consents = [{ id: 'name', label: 'Yes, with my name' }, { id: 'anon', label: 'Yes, without my name' }];
const disabledSend = /<button[^>]*disabled=""[^>]*>Send</;

test('the form draws every word of the page row and one tile per consent, none chosen', async () => {
  const html = await renderAView(entry, { page, consents });
  for (const word of ['Say a', 'Tell us how it went.', 'Your words', 'A few sentences are plenty.', 'May we share them?', 'You can change your mind.', 'Yes, with my name', 'Yes, without my name']) {
    assert.ok(html.includes(word), word);
  }
  assert.equal((html.match(/role="radio"/g) ?? []).length, 2);
  assert.doesNotMatch(html, /aria-checked="true"/);
});

test('Send waits for words and a consent', async () => {
  assert.match(await renderAView(entry, { page, consents }), disabledSend);
  assert.match(await renderAView(entry, { page, consents, said: 'Great', consent: null }), disabledSend);
  assert.match(await renderAView(entry, { page, consents, said: '   ', consent: 'name' }), disabledSend);
  assert.doesNotMatch(await renderAView(entry, { page, consents, said: 'Great', consent: 'name' }), disabledSend);
  assert.match(await renderAView(entry, { page, consents, said: 'Great', consent: 'name', sending: true }), disabledSend);
});

test('the chosen consent is the one marked, and the typed words are in the field', async () => {
  const html = await renderAView(entry, { page, consents, said: 'It went well', consent: 'anon' });
  assert.equal((html.match(/aria-checked="true"/g) ?? []).length, 1);
  assert.match(html, />It went well</);
});

test('an error shows as an alert', async () => {
  assert.match(await renderAView(entry, { page, consents, error: 'Try again.' }), /role="alert"[^>]*>Try again\./);
});

test('thanks and not-found draw only their own words, with no form', async () => {
  const thanks = await renderAView(entry, { page, consents, state: 'thanks' });
  assert.ok(thanks.includes('We have your words.'));
  assert.doesNotMatch(thanks, /<form|<textarea/);
  const missing = await renderAView(entry, { page, consents, state: 'not_found' });
  assert.ok(missing.includes('Ask again.'));
  assert.doesNotMatch(missing, /<form|<textarea/);
});

test('the screen is pure: it draws no script and no inline colour of its own', async () => {
  const html = await renderAView(entry, { page, consents, error: 'Try again.' });
  assert.doesNotMatch(html, /<script|#8a1c1c/);
});
