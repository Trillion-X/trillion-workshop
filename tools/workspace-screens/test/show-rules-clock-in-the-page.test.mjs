// The page's show rules (web/src/workspace/show-rules.mjs showDecision, show-rules-map.mjs decideEvery) read a rule's
// hour from the timed-action engine the page bundle carries, never from the browser's Intl zone data. Bundled for a
// browser and run where there is no Node. Havana keeps UTC-4 after 2026-11-01 (tzdata 2026e and later); an older ICU
// (Node's 2025b here) moves it to UTC-5, so at 12:00 UTC on 2026-11-08 the engine reads 08:00 and that ICU read 07:00.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { build } from 'esbuild';

const web = new URL('../web/', import.meta.url).pathname;
const workshop = new URL('../../../', import.meta.url).pathname;
const formulaBytes = readFileSync(new URL('../../formula-engine/built-stored-bytes/formula-engine/formula_engine_bg.wasm', import.meta.url));
const AT = Date.parse('2026-11-08T12:00:00.000Z');

async function openPage() {
  const built = await build({
    stdin: {
      contents: `export { showDecision } from './src/workspace/show-rules.mjs';\nexport { decideEvery } from './src/workspace/show-rules-map.mjs';\nexport { default as data } from 'trillion-workshop/tools/set-up-my-account/read-data/show-rules.json';\nexport * as formula from 'trillion-workshop/tools/formula-engine/built-stored-bytes/formula-engine/formula_engine.js';\nexport const loaded = bytes => ({ module: bytes });`,
      resolveDir: web, loader: 'js',
    },
    alias: { 'trillion-workshop': workshop.replace(/\/$/, '') },
    bundle: true, format: 'iife', globalName: 'page', platform: 'browser', target: 'es2022', write: false, logLevel: 'silent',
  });
  const page = vm.createContext({ console, TextDecoder, TextEncoder, URL });
  vm.runInContext(built.outputFiles[0].text, page);
  assert.equal(vm.runInContext('typeof process', page), 'undefined', 'the page has no Node');
  page.page.formula.initSync(page.page.loaded(formulaBytes));
  return page.page;
}

const thing = { control: 'sidebar.hide', within: ['sidebar', 'sidebar.hide'] };
const rule = time_zone => ({
  id: 'hide-from-eight', subject: 'control', effect: 'hide', time_zone,
  when: { kind: 'group', combinator: 'and', negate: false, rules: [{ kind: 'rule', field: 'hour', operator: 'greater_than', params: { value: 7 } }] },
});

test('the page reads the hour in Havana from the engine: 08:00 hides a rule from eight, an hour earlier shows', async () => {
  const page = await openPage();
  const filterRows = ({ tree, fields, rows }) => page.formula.filterRecords({ records: rows, fields, tree });
  const decide = now => page.showDecision({ data: page.data, record: { rules: [rule('America/Havana')] }, subject: 'control', thing, now, filterRows });
  assert.equal(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Havana', hour: 'numeric', hourCycle: 'h23' }).format(new Date(AT)), '07', 'this Node\'s ICU is the older zone data the page no longer reads');
  assert.equal(decide(AT).hidden, true);
  assert.equal(decide(AT - 3_600_000).hidden, false);
  const every = now => [...page.decideEvery({ data: page.data, rules: [rule('America/Havana')], subject: 'control', things: [thing], now, filterRows }).hidden];
  assert.deepEqual(every(AT), [true], 'decideEvery reads the same hour');
  assert.deepEqual(every(AT - 3_600_000), [false]);
});
