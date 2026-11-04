// Every relative module request in this folder names a file that is in the tree.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const folder = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const request = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*|new URL\(\s*)['"](\.{1,2}\/[^'"]*)['"]/g;

function codeFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const place = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : codeFiles(place);
    return /\.(mjs|cjs|js)$/.test(entry.name) ? [place] : [];
  });
}

test('every relative import in tools/run-on-a-persons-computer resolves to a file in the tree', () => {
  const missing = [];
  for (const file of codeFiles(folder)) {
    const text = fs.readFileSync(file, 'utf8');
    for (const match of text.matchAll(request)) {
      if (fs.existsSync(path.resolve(path.dirname(file), match[1]))) continue;
      const line = text.slice(0, match.index).split('\n').length;
      missing.push(`${path.relative(folder, file)}:${line} ${match[1]}`);
    }
  }
  assert.deepEqual(missing, []);
});
