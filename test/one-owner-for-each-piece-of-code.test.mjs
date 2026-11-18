// Each piece of code under tools/ has one owner (test-helpers/copied-code.mjs): a tool that needs another tool's code
// imports it from the owner, which names it in its part.json, rather than holding a copy that drifts. The copies the
// Workshop still holds are counted in test/copied-code.json; the count may only go down. When it rises, the test names
// the groups that the files changed since that count was written are in. The outcome is a count of 0.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copiedCode, codeOf } from '../test-helpers/copied-code.mjs';

const repo = new URL('..', import.meta.url).pathname;
const COUNT = 'test/copied-code.json';
const ref = process.env.COPIED_CODE_REF ?? 'HEAD';

test('no more code is copied between tools than was', () => {
  const { total: allowed } = JSON.parse(execFileSync('git', ['-C', repo, 'show', `${ref}:${COUNT}`], { encoding: 'utf8' }));
  const { groups, total } = copiedCode({ repo, ref });
  if (total <= allowed) return;
  const since = execFileSync('git', ['-C', repo, 'log', '-1', '--format=%H', ref, '--', COUNT], { encoding: 'utf8' }).trim();
  const changed = new Set(execFileSync('git', ['-C', repo, 'diff', '--name-only', since, ref], { encoding: 'utf8' }).split('\n'));
  const named = groups.filter(paths => paths.some(path => changed.has(path))).map(paths => paths.join('  =  '));
  assert.fail(`${total} copied code files, ${allowed} allowed. Groups holding files changed since the count was written:\n${named.join('\n')}\n\nImport the owner's file (its tool's part.json names it) and delete the copy.`);
});

test('two files are copies when only their import lines and path comment differ', () => {
  const a = "// tools/a/read-data/x.ts\nimport { y } from './y.ts';\nimport {\n  z,\n} from './z.ts';\nexport const x = y + z;\n";
  const b = "// tools/b/do-work/x.ts\nimport { y } from '../../a/read-data/y.ts';\nimport {\n  z,\n} from '../../a/read-data/z.ts';\nexport const x = y + z;\n";
  assert.equal(codeOf(a), codeOf(b));
  assert.notEqual(codeOf(a), codeOf(a.replace('y + z', 'y - z')));
  assert.equal(codeOf("import { a } from './a.ts';\nexport { a } from './a.ts';\n"), '');
});
