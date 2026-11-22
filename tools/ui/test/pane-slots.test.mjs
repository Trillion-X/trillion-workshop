// tools/ui/test/pane-slots.test.mjs
//
// Two copies of the shared mount code (each its own bundle, as a screen module is) draw into one pane element through
// its slots: loading, then the screen, then a failure, then the screen again. No error is thrown, nothing is removed by
// hand, and the slot shown is the one asked for. Runs the real code in Chromium.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const entry = fileURLToPath(new URL('./pane-slots.entry.tsx', import.meta.url));
const copy = async name => (await build({ entryPoints: [entry], bundle: true, format: 'iife', globalName: name, write: false, jsx: 'transform', define: { 'process.env.NODE_ENV': '"production"' } })).outputFiles[0].text;

test('two copies of the shared mount share one pane through its slots, with no error', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.setContent('<!doctype html><body><div id="pane"></div></body>');
    await page.addScriptTag({ content: `var CopyA;${await copy('CopyA')}` });
    await page.addScriptTag({ content: `var CopyB;${await copy('CopyB')}` });
    const seen = await page.evaluate(async () => {
      const pane = document.getElementById('pane');
      const read = () => [...pane.querySelectorAll('[data-pane-slot]')].map(slot => ({ kind: slot.dataset.paneSlot, hidden: slot.hidden, words: slot.textContent }));
      const frame = () => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)));
      const a = window.CopyA, b = window.CopyB;
      a.mount(pane, 'state', 'Opening your list');
      await frame(); const loading = read();
      b.mount(pane, 'screen', 'Your list');
      await frame(); const screen = read();
      a.release(pane, 'state');
      a.mount(pane, 'state', 'Could not open');
      await frame(); const failure = read();
      a.release(pane, 'state');
      b.mount(pane, 'screen', 'Your list again');
      await frame(); const again = read();
      pane.replaceChildren();
      a.mount(pane, 'state', 'Back after a hand empty');
      await frame(); const emptied = read();
      return { loading, screen, failure, again, emptied };
    });
    assert.deepEqual(errors, []);
    assert.equal(seen.loading.find(s => s.kind === 'state').words, 'Opening your list');
    assert.equal(seen.loading.find(s => s.kind === 'state').hidden, false);
    assert.equal(seen.screen.find(s => s.kind === 'screen').words, 'Your list');
    assert.equal(seen.screen.find(s => s.kind === 'state').hidden, true);
    assert.equal(seen.failure.find(s => s.kind === 'state').words, 'Could not open');
    assert.equal(seen.failure.find(s => s.kind === 'screen').hidden, true);
    assert.equal(seen.again.find(s => s.kind === 'screen').words, 'Your list again');
    assert.equal(seen.again.find(s => s.kind === 'screen').hidden, false);
    assert.equal(seen.emptied.find(s => s.kind === 'state').words, 'Back after a hand empty');
    assert.equal(seen.emptied.find(s => s.kind === 'state').hidden, false);
  } finally {
    await browser.close();
  }
});
