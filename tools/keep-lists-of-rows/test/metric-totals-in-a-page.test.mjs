// A metric card's totals are the list engine's `measure`, in a browser page as on the server. This bundles the metric math for a
// browser (no Node: no process, no fs) and runs it in a context that has only what a page has: before the page loads the formula
// engine's wasm a card shows no reading and says why; once it is loaded the totals are the engine's. The page loads the formula
// engine's own module (its init on the content-named wasm file the build writes, workspace-screens web/scripts/build-workspace.mjs)
// and hands that module to the list engine.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const wasm = readFileSync(new URL(import.meta.resolve('trillion-workshop/tools/formula-engine/built-stored-bytes/formula-engine/formula_engine_bg.wasm')));

// The page: the metric math and the list engine's loader, bundled for a browser and run where `process` does not exist.
async function openPage() {
  const built = await build({
    stdin: {
      contents: `export * from 'trillion-workshop/tools/keep-lists-of-rows/read-data/metric-aggregation.ts';\nexport { loadMeasureEngine, measureEngineReady, provideMeasureEngine } from 'trillion-workshop/tools/query-and-change-list-rows/src/list-aggregates.mjs';\nexport * as engine from 'trillion-workshop/tools/formula-engine/built-stored-bytes/formula-engine/formula_engine.js';\n// The page's own request object, made in the page (the module's init reads a plain object of the page's own kind).\nexport const loaded = bytes => ({ module: bytes });`,
      resolveDir: `${here}/..`, loader: 'ts',
    },
    bundle: true, format: 'iife', globalName: 'page', platform: 'browser', write: false, logLevel: 'silent',
  });
  const page = vm.createContext({ WebAssembly, TextDecoder, TextEncoder, console, URL });
  vm.runInContext(built.outputFiles[0].text, page);
  assert.equal(vm.runInContext('typeof process', page), 'undefined', 'the page has no Node');
  return page.page;
}

const model = { fields: [{ id: 'amount', paths: [] }] };
const record = amount => ({ fieldValues: new Map([['amount', amount]]) });
const spec = (op, extra = {}) => ({ aggregation: { op, fieldId: 'amount' }, format: 'integer', ...extra });

test('a card shows no reading until the page has the formula engine, then the engine\'s totals', async () => {
  const page = await openPage();
  const records = [record(3), record(4), record(5)];
  assert.equal(page.measureEngineReady(), false);
  const before = page.computeMetricValue(spec('sum'), records, model);
  assert.equal(before.value, null);
  assert.match(before.error, /formula engine/);

  await page.loadMeasureEngine(async () => { page.engine.initSync(page.loaded(new Uint8Array(wasm))); return page.engine; });
  assert.equal(page.measureEngineReady(), true);
  const answers = Object.fromEntries(['sum', 'average', 'min', 'max', 'latest', 'first', 'count', 'count-values', 'median', 'distinct']
    .map(op => [op, page.computeMetricValue(spec(op), records, model).value]));
  assert.deepEqual(answers, { sum: 12, average: 4, min: 3, max: 5, latest: 5, first: 3, count: 3, 'count-values': 3, median: 4, distinct: 3 });
  assert.equal(page.computeMetricValue(spec('average'), [], model).value, null, 'no values is no reading, never a made-up zero');
  assert.match(page.computeMetricValue(spec('nonesuch'), records, model).error, /Unknown aggregation/);
});

test('a page says how to load the engine and the first screen to ask has it loaded, once', async () => {
  const page = await openPage();
  let fetched = 0;
  page.provideMeasureEngine(async () => { fetched += 1; page.engine.initSync(page.loaded(new Uint8Array(wasm))); return page.engine; });
  await Promise.all([page.loadMeasureEngine(), page.loadMeasureEngine()]);
  await page.loadMeasureEngine();
  assert.equal(fetched, 1);
  assert.equal(page.computeMetricValue(spec('sum'), [record(1), record(2)], model).value, 3);
});
