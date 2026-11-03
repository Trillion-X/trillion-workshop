// test/load-code.test.mjs
//
// The one loader of code the page fetches later (parts/ui/show/load-later/load-code.ts): a fetch that failed is asked
// again at a new address once the page is shown, and only a failed ask checks the address, so a file a newer build
// replaced is said then; a device that is offline is told so at once; code that failed while running, or a module
// without the value asked for, is never asked again; and a failure the page cannot mend in place asks for a reload. The
// browser keeps a failed module fetch (test/load-code-browser.test.mjs shows it in Chromium); here the page is a
// stand-in.

import test from 'node:test';
import assert from 'node:assert/strict';
import { CodeLoadFailure, failedFetchAddress, loadCode } from '../parts/ui/show/load-later/load-code.ts';

const fetchFailed = url => new TypeError(`Failed to fetch dynamically imported module: ${url}`);

/** A stand-in page: `checks` answers each HEAD in turn, `imports` answers each fresh import in turn (a function is
 *  called and may hold its answer back), `online` each look at the connection in turn. */
function place({ checks = [], imports = [], online = [] } = {}) {
  const seen = { ready: 0, slept: [], checked: [], imported: [] };
  return {
    seen,
    place: {
      ready: async () => { seen.ready += 1; },
      online: () => online.length ? online.shift() : true,
      sleep: async ms => { seen.slept.push(ms); },
      check: async url => { seen.checked.push(url); return checks.shift() ?? 'present'; },
      importFresh: async url => {
        seen.imported.push(url);
        const next = imports.shift();
        const answer = typeof next === 'function' ? await next() : next;
        if (answer instanceof Error) throw answer;
        return answer;
      },
    },
  };
}

const reasonOf = async promise => promise.then(() => 'arrived', error => (error instanceof CodeLoadFailure ? error.reason : `other: ${error}`));
const nothingAsked = { ready: 0, slept: [], checked: [], imported: [] };

test('a failed fetch names its file only when the browser said which', () => {
  assert.equal(failedFetchAddress(fetchFailed('https://app.test/workspace/named/a-1.js')), 'https://app.test/workspace/named/a-1.js');
  assert.equal(failedFetchAddress(new TypeError('error loading dynamically imported module: https://app.test/b.js.')), 'https://app.test/b.js');
  assert.equal(failedFetchAddress(new TypeError('Importing a module script failed.')), null);
  assert.equal(failedFetchAddress(new ReferenceError('mountX is not defined')), undefined);
});

test('code that arrives is picked from its module and nothing else is asked', async () => {
  const stand = place();
  assert.equal(await loadCode(async () => ({ mount: 'm' }), module => module.mount, { place: stand.place }), 'm');
  assert.deepEqual(stand.seen, nothingAsked);
});

test('a module without the value pick takes is broken, and a missing pick is refused before anything is fetched', async () => {
  const stand = place();
  assert.equal(await reasonOf(loadCode(async () => ({ Composer: 'c' }), module => module.Compose, { place: stand.place })), 'broken');
  let loaded = false;
  assert.equal(await reasonOf(loadCode(async () => { loaded = true; return {}; }, undefined, { place: stand.place })), 'broken');
  assert.equal(loaded, false);
  assert.deepEqual(stand.seen, nothingAsked);
});

test('a dropped fetch is asked again at a new address once the page is shown, and arrives without a check', async () => {
  const url = 'https://app.test/workspace/named/screen-dropped.js';
  const stand = place({ imports: [fetchFailed(`${url}?again=1`), { mount: 'mended' }], checks: ['unreached'] });
  const mount = await loadCode(async () => { throw fetchFailed(url); }, module => module.mount, { place: stand.place, waits: [10, 20, 40] });
  assert.equal(mount, 'mended');
  // The first new ask failed too and the server was not reached, so the next try asked again after a longer wait.
  assert.deepEqual(stand.seen.slept, [10, 20]);
  assert.equal(stand.seen.ready, 2, 'every new ask waits for a shown page first');
  assert.deepEqual(stand.seen.imported, [`${url}?again=1`, `${url}?again=2`]);
  assert.deepEqual(stand.seen.checked, [url], 'the address is checked only after an ask failed');
});

test('a page that may not check addresses still heals: the new ask comes first', async () => {
  const url = 'https://app.test/workspace/named/screen-in-a-frame.js';
  const stand = place({ imports: [{ mount: 'healed' }], checks: ['unreached', 'unreached'] });
  assert.equal(await loadCode(async () => { throw fetchFailed(url); }, module => module.mount, { place: stand.place, waits: [1, 1] }), 'healed');
  assert.deepEqual(stand.seen.checked, []);
});

test('every caller of one failed file shares the one mended copy, also when they fail at the same time', async () => {
  const url = 'https://app.test/workspace/named/shared-module.js';
  let arrive;
  const stand = place({ imports: [() => new Promise(resolve => { arrive = resolve; })] });
  const failing = async () => { throw fetchFailed(url); };
  const both = Promise.all([
    loadCode(failing, module => module.first, { place: stand.place, waits: [1] }),
    loadCode(failing, module => module.second, { place: stand.place, waits: [1] }),
  ]);
  await new Promise(resolve => setTimeout(resolve, 10));
  arrive({ first: 'one', second: 'two' });
  assert.deepEqual(await both, ['one', 'two']);
  assert.deepEqual(stand.seen.imported, [`${url}?again=1`], 'the module is fetched and run once, not once per caller');
  const later = await loadCode(failing, module => module.first, { place: stand.place, waits: [1] });
  assert.equal(later, 'one');
  assert.equal(stand.seen.imported.length, 1, 'a caller after it is served by the same copy');
});

test('a file a newer build replaced is said after the failed ask and never imported again', async () => {
  const url = 'https://app.test/workspace/named/screen-replaced.js';
  const stand = place({ imports: [fetchFailed(`${url}?again=1`)], checks: ['gone'] });
  assert.equal(await reasonOf(loadCode(async () => { throw fetchFailed(url); }, module => module, { place: stand.place, waits: [1, 1, 1] })), 'replaced');
  assert.deepEqual(stand.seen.imported, [`${url}?again=1`]);
  assert.deepEqual(stand.seen.checked, [url]);
});

test('code that failed while running is broken and never asked again', async () => {
  const stand = place();
  assert.equal(await reasonOf(loadCode(async () => { throw new ReferenceError('window is not defined'); }, module => module, { place: stand.place })), 'broken');
  assert.deepEqual(stand.seen, nothingAsked);
  const url = 'https://app.test/workspace/named/screen-throws.js';
  const again = place({ imports: [new SyntaxError('Unexpected token')] });
  assert.equal(await reasonOf(loadCode(async () => { throw fetchFailed(url); }, module => module, { place: again.place, waits: [1, 1] })), 'broken');
  assert.equal(again.seen.imported.length, 1);
});

test('a failure that names no file is asked once more, then asks for a reload', async () => {
  // Safari does not say which file failed: asking again mends it where the browser does not keep the failure.
  let asks = 0;
  const healed = place();
  assert.equal(await loadCode(async () => { asks += 1; if (asks === 1) throw new TypeError('Importing a module script failed.'); return { mount: 'second ask' }; }, module => module.mount, { place: healed.place, waits: [5] }), 'second ask');
  assert.deepEqual(healed.seen.slept, [5]);
  const kept = place();
  assert.equal(await reasonOf(loadCode(async () => { throw new TypeError('Importing a module script failed.'); }, module => module, { place: kept.place, waits: [5] })), 'stuck');
  assert.deepEqual(kept.seen.checked, []);
});

test('a file the server has that still fails twice means a lost import, and asks for a reload', async () => {
  const url = 'https://app.test/workspace/named/screen-with-lost-import.js';
  const lostImport = place({ imports: [fetchFailed(`${url}?again=1`), fetchFailed(`${url}?again=2`)], checks: ['present', 'present'] });
  assert.equal(await reasonOf(loadCode(async () => { throw fetchFailed(url); }, module => module, { place: lostImport.place, waits: [1, 1, 1, 1] })), 'stuck');
  assert.deepEqual(lostImport.seen.imported, [`${url}?again=1`, `${url}?again=2`], 'each ask uses an address the browser has not failed before');
});

test('an offline device is unreached at once and spends no tries; the next ask after it is back arrives', async () => {
  const url = 'https://app.test/workspace/named/screen-offline.js';
  const offline = place({ online: [false] });
  assert.equal(await reasonOf(loadCode(async () => { throw fetchFailed(url); }, module => module, { place: offline.place, waits: [1, 2, 3] })), 'unreached');
  assert.deepEqual(offline.seen, nothingAsked, 'nothing is waited for or asked while offline');
  const back = place({ imports: [{ mount: 'back' }] });
  assert.equal(await loadCode(async () => { throw fetchFailed(url); }, module => module.mount, { place: back.place, waits: [1] }), 'back');
});

test('a server that is never reached within the tries is unreached', async () => {
  const url = 'https://app.test/workspace/named/screen-unreached.js';
  const stand = place({ imports: [1, 2, 3].map(n => fetchFailed(`${url}?again=${n}`)), checks: ['unreached', 'unreached', 'unreached'] });
  assert.equal(await reasonOf(loadCode(async () => { throw fetchFailed(url); }, module => module, { place: stand.place, waits: [1, 2, 3] })), 'unreached');
  assert.deepEqual(stand.seen.slept, [1, 2, 3]);
  assert.equal(stand.seen.imported.length, 3, 'at most one ask per try');
});
