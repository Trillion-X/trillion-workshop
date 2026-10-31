// openBrowser against a stand-in browser (test/stand-in/pipe-browser.mjs) that speaks only the pipe.
import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { BrowserProblem, openBrowser } from '../devtools.mjs';

const standIn = fileURLToPath(new URL('./stand-in/pipe-browser.mjs', import.meta.url));
const started = async (mode, ...options) => {
  process.env.STAND_IN_MODE = mode;
  return openBrowser(standIn, { width: 800, height: 600, ...options[0] });
};

test('the browser is started with the pipe and no port, and answers calls and events over descriptors 3 and 4', async () => {
  const browser = await started('answer');
  try {
    const heard = [];
    browser.on(event => heard.push(event.method));
    const { result } = await browser.send('Runtime.evaluate', { expression: 'switches' });
    assert.ok(result.value.includes('--remote-debugging-pipe'));
    assert.ok(!result.value.some(arg => arg.startsWith('--remote-debugging-port')), 'no TCP port is asked for');
    assert.ok(result.value.includes('--window-size=800,600'));
    assert.deepEqual(heard, ['Page.loadEventFired']);
    await assert.rejects(browser.send('Nope.nothing'), /no such method Nope.nothing \(-32601\)/);
  } finally { browser.close(); }
});

test('a browser that ends at start is told as a BrowserProblem with its own words, not left waiting', async () => {
  await assert.rejects(started('exit'), error => error instanceof BrowserProblem && /exit 7/.test(error.message) && /refused to start/.test(error.message));
});
