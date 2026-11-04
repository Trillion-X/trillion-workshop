import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import storeSize from '../../record-log/do-work/store-size.json' with { type: 'json' };

// The size limit of one object's store is data in src/store-size.json; the record log's merge room reads that one value instead of keeping a
// second copy of 10 GiB (the two had to be changed together).
test('the record log takes its database limit from store-size.json, not a copy', () => {
  const source = fs.readFileSync(new URL('../parts/record-log/do-work/kept-runs.mjs', import.meta.url), 'utf8');
  assert.match(source, /database_limit_bytes: storeSize\.limit_bytes/);
  assert.doesNotMatch(source, /10 \* 1024 \* 1024 \* 1024/);
  assert.equal(storeSize.limit_bytes, 10 * 1024 ** 3);
});
