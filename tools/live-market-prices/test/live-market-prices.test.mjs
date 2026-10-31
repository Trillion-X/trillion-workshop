// tools/live-market-prices/test/live-market-prices.test.mjs
//
// Runs this folder's Python tests: the two carried normalizer scripts (28 and 35 checks), the price-bars normalizer
// tests and the seam tests. They are plain scripts, so each is run with `python3 -I` and judged by its exit code and its
// own count of what passed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const here = import.meta.dirname;
const run = file => spawnSync('python3', ['-I', join(here, file)], { encoding: 'utf8', timeout: 60_000 });

test('the market-list normalizer passes its 28 checks', () => {
  const result = run('normalize-gamma-markets.test.py');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /28 passed, 0 failed/);
});

test('the order-book normalizer passes its 35 checks', () => {
  const result = run('normalize-order-book.test.py');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /35 passed, 0 failed/);
});

test('the price-bars normalizer passes its 5 tests', () => {
  const result = run('normalize-price-bars.test.py');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /Ran 5 tests/);
  assert.match(result.stderr, /OK/);
});

test('the wrapper, with a fake HTTP, reads markets, books and bars, sends its User-Agent, keeps held fields to the request and is honest about failures', () => {
  const result = run('read-market-prices.seam.py');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /Ran 14 tests/);
  assert.match(result.stderr, /OK/);
});

test('the rows name the three commands and the data row names a User-Agent that holds no old brand', () => {
  const rows = JSON.parse(readFileSync(join(here, '..', 'tool-rows.json'), 'utf8')).records.map(({ payload }) => payload);
  assert.deepEqual(rows.map(row => row.id).sort(), ['tool:list-public-prediction-markets', 'tool:read-prediction-market-order-book', 'tool:read-price-bars-from-my-market-data-account']);
  const source = JSON.parse(readFileSync(join(here, '..', 'sources', 'public-markets-api.json'), 'utf8'));
  assert.match(source.user_agent, /github\.com\/Trillion-X\/trillion-workshop/);
});
