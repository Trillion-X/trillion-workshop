// Every look file's comments open before they close. A comment that closes without opening (its "/*" lost, as when
// b3ce3bb01 dropped the first-line path headers and their openers with them) is read by a browser as a selector, and
// every rule after it, in the file and in every sheet the file is joined into, is dropped with no error.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

const folder = new URL('../show/', import.meta.url);

test('every look file opens each comment it closes', () => {
  const broken = readdirSync(folder).filter(file => file.endsWith('.css'))
    .filter(file => readFileSync(new URL(file, folder), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').includes('*/'));
  assert.deepEqual(broken, []);
});
