// The TypeScript program runs as it is under node: started the way the engine starts it (`node do-work/echo.ts`, the
// input on standard input), and imported by a test, both with no build.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { echo } from '../do-work/echo.ts';

const folder = fileURLToPath(new URL('..', import.meta.url));

test('the program started as the row starts it answers its words and says the types were stripped', () => {
  const out = execFileSync(process.execPath, ['do-work/echo.ts'], { cwd: folder, input: JSON.stringify({ words: 'typed and run' }) }).toString();
  const answer = JSON.parse(out);
  assert.equal(answer.result.words, 'typed and run');
  assert.equal(answer.result.node, process.version);
  assert.equal(answer.result.types_stripped, true);
});

test('input with no words is refused with what it should hold', () => {
  assert.throws(() => echo({}), /"words"/);
  assert.throws(() => echo({ words: '' }), /1 to 4000/);
});
