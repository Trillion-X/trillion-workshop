// The screen modules the workspace build bundles must not name a value they never declare or import: a call to such a name
// is a ReferenceError the moment the screen draws, and the build does not catch it (esbuild bundles it). This runs the
// repo's TypeScript over those modules and fails on the "cannot find name" errors only (TS2304, TS2552); other type errors
// are existing debt and are counted, not failed, so the gate can tighten later. It skips with a message until TypeScript is
// installed in the Workshop (a devDependency the owner's npm ci installs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { screenModuleFiles } from '../web/scripts/no-owner-gate.mjs';

const WORKSHOP = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const require = createRequire(join(WORKSHOP, 'package.json'));

function typescriptBin() {
  try {
    return require.resolve('typescript/bin/tsc');
  } catch {
    return null;
  }
}

test('the screen modules name no value they do not declare (cannot-find-name gate)', { timeout: 600000 }, t => {
  const tsc = typescriptBin();
  if (!tsc) {
    t.skip('typescript is not installed in the Workshop yet (a devDependency the owner installs with npm ci); the gate runs once it is.');
    return;
  }
  const files = screenModuleFiles(WORKSHOP);
  const project = mkdtempSync(join(tmpdir(), 'screen-types-'));
  const list = join(project, 'tsconfig.json');
  writeFileSync(list, JSON.stringify({
    compilerOptions: { noEmit: true, jsx: 'react-jsx', module: 'esnext', moduleResolution: 'bundler', target: 'es2022', strict: false, skipLibCheck: true, allowJs: false, resolveJsonModule: true, allowImportingTsExtensions: true, types: [] },
    files,
  }));
  let output = '';
  try {
    output = execFileSync(process.execPath, [tsc, '-p', list, '--pretty', 'false'], { cwd: WORKSHOP, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 540000 });
  } catch (error) {
    output = String(error.stdout ?? '');
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
  const lines = output.split('\n').filter(line => /error TS\d+:/.test(line));
  const byCode = {};
  for (const line of lines) {
    const code = line.match(/error (TS\d+):/)[1];
    byCode[code] = (byCode[code] ?? 0) + 1;
  }
  const nameErrors = lines.filter(line => /error (TS2304|TS2552):/.test(line));
  console.log(`screen modules checked: ${files.length}; type errors by code: ${JSON.stringify(byCode)}`);
  assert.deepEqual(nameErrors, [], `names that are not declared or imported:\n${nameErrors.join('\n')}`);
});
