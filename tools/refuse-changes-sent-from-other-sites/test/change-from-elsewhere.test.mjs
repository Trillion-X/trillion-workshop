// Carried from old trillion test/change-from-elsewhere.test.mjs (tag old-trillion-before-worker-retire, b6ae0ebf81),
// deleted by Trillion-X/trillion #243. Its second test read src/worker.mjs, which went with the Worker, to see every
// signed-in road ask this check before the session. The engine judges a change once at its signed-in entry now, and
// trillion-rust src/workspace_domain.rs a_change_from_another_site_is_refused_and_a_read_is_not tests that; the first
// test is the old one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { changeFromElsewhere } from '../src/change-from-elsewhere.mjs';

const app = 'https://app.gettrillion.ai';
const ask = (method, headers = {}) => new Request(`${app}/work/api/anything`, { method, headers });

test('a change a customer site sends with a signed-in visitor is refused; the app, other programs and reads pass', () => {
  // A script on a customer site: the same site as the app, so the sign-in cookie would ride along.
  assert.equal(changeFromElsewhere(ask('POST', { origin: 'https://field-notes.sites.gettrillion.ai', 'sec-fetch-site': 'same-site' }), app), true);
  assert.equal(changeFromElsewhere(ask('DELETE', { origin: 'https://4593376eacfd58191f1d9d47df6250ac.app.gettrillion.ai' }), app), true);
  assert.equal(changeFromElsewhere(ask('PUT', { 'sec-fetch-site': 'cross-site' }), app), true);
  // The app's own pages.
  assert.equal(changeFromElsewhere(ask('POST', { origin: app, 'sec-fetch-site': 'same-origin' }), app), false);
  // A program that is not a browser says neither, and is judged by its own key.
  assert.equal(changeFromElsewhere(ask('POST'), app), false);
  // Reading never changes anything.
  assert.equal(changeFromElsewhere(ask('GET', { origin: 'https://field-notes.sites.gettrillion.ai', 'sec-fetch-site': 'same-site' }), app), false);
});
