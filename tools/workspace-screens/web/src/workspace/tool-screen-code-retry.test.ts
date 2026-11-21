// The pane's Try again for a tool's own code: a module whose fetch failed is asked again at a new address (the browser
// keeps the failed one for the page), and the value arrives without any page reload. tool-screen.tsx opens every code
// fetch through loadCode, so these cases are the ones a pane meets. Each case names its own file: the loader keeps the
// copy it mended per address for the life of the page.
import assert from 'node:assert/strict';
import test from 'node:test';
import { CodeLoadFailure, loadCode, type CodeLoadPlace } from '../../../../ui/show/load-later/load-code.ts';

const origin = 'https://host.example/modules';
const failedFetch = (file: string) => new TypeError(`Failed to fetch dynamically imported module: ${origin}/${file}`);

function place(overrides: Partial<CodeLoadPlace> = {}): CodeLoadPlace & { imported: string[] } {
  const imported: string[] = [];
  return {
    ready: async () => {},
    online: () => true,
    sleep: async () => {},
    check: async () => 'present',
    importFresh: async url => { imported.push(url); return { mount: () => 'mounted' }; },
    ...overrides,
    imported,
  };
}

test('a failed module fetch is mended at a new address and the pane gets the module', async () => {
  const file = 'retry-a/screen.js';
  const fake = place();
  const value = await loadCode(async () => { throw failedFetch(file); }, module => module, { place: fake, waits: [0] });
  assert.equal(typeof (value as { mount?: unknown }).mount, 'function');
  assert.deepEqual(fake.imported, [`${origin}/${file}?again=1`]);
});

test('a file the server has replaced is said as replaced, so the pane shows that and not a reload', async () => {
  const file = 'retry-b/screen.js';
  const fake = place({ importFresh: async () => { throw failedFetch(file); }, check: async () => 'gone' });
  await assert.rejects(
    loadCode(async () => { throw failedFetch(file); }, module => module, { place: fake, waits: [0] }),
    error => error instanceof CodeLoadFailure && error.reason === 'replaced',
  );
});

test('a module without the value its pane takes is broken, and no new ask is made', async () => {
  const fake = place();
  await assert.rejects(
    loadCode(async () => ({}), (module: { mount?: unknown }) => module.mount as undefined, { place: fake, waits: [0] }),
    error => error instanceof CodeLoadFailure && error.reason === 'broken',
  );
  assert.deepEqual(fake.imported, []);
});
