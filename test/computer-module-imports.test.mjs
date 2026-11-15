// Every relative module request in the computer tool names a file that is in the tree. Repository integration QA
// joins that source owner to the shared module-syntax reader instead of keeping a second regular-expression parser.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isRelative, requestsIn } from '../tools/move-code-between-trees/read-data/imports.mjs';

const folder = fileURLToPath(new URL('../tools/run-on-a-persons-computer', import.meta.url));

function codeFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : codeFiles(file);
    return /\.(mjs|cjs|js)$/.test(entry.name) ? [file] : [];
  });
}

test('every relative import in tools/run-on-a-persons-computer resolves to a file in the tree', () => {
  const missing = [];
  for (const file of codeFiles(folder)) {
    const text = fs.readFileSync(file, 'utf8');
    for (const request of requestsIn(text).filter(({ specifier }) => isRelative(specifier))) {
      if (fs.existsSync(path.resolve(path.dirname(file), request.specifier))) continue;
      const line = text.slice(0, request.start).split('\n').length;
      missing.push(`${path.relative(folder, file)}:${line} ${request.specifier}`);
    }
  }
  assert.deepEqual(missing, []);
});
