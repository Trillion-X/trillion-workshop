// Shared test-only custody comparison. Complete assertion token streams retain literal contents, arguments,
// nested calls and callbacks; comments and formatting outside literals are insignificant.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { transformSync } from 'esbuild';
import esprima from 'esprima';

// Whether the options object that follows a test's name (`test('name', { skip: ... }, fn)`) holds `skip` or `todo`, as a
// property or a shorthand: such a test is listed but never runs. (`test.skip(` and `test.todo(` are not `test(`, so their
// names are never found at all, and a commented-out test is gone before the tokens are read.)
function skippedByOptions(tokens, comma) {
  if (tokens[comma]?.value !== ',' || tokens[comma + 1]?.value !== '{') return false;
  let depth = 0;
  for (let index = comma + 1; index < tokens.length; index++) {
    const { type, value } = tokens[index];
    if (type === 'Punctuation' || type === 'Punctuator') {
      if (value === '{') depth++;
      if (value === '}' && --depth === 0) return false;
    }
    if (depth === 1 && type === 'Identifier' && (value === 'skip' || value === 'todo') && ['{', ','].includes(tokens[index - 1]?.value)) return true;
  }
  return false;
}

export function signatures(source) {
  // The compiler prints canonical numeric spellings accepted by the locked lexer. It does not bundle or execute.
  const code = transformSync(source, { loader: 'js', target: 'esnext', logLevel: 'silent' }).code;
  const tokens = esprima.tokenize(code);
  const names = [], assertions = [], tests = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.type !== 'Identifier' || tokens[index - 1]?.value === '.') continue;
    if (token.value === 'test' && tokens[index + 1]?.value === '(' && tokens[index + 2]?.type === 'String') {
      names.push(esprima.parseScript(tokens[index + 2].value).body[0].expression.value);
      tests.push({ name: names.at(-1), assertions: [], skipped: skippedByOptions(tokens, index + 3) });
    }
    if (token.value !== 'assert' || tokens[index + 1]?.value !== '.' || tokens[index + 2]?.type !== 'Identifier' || tokens[index + 3]?.value !== '(') continue;
    let depth = 0, end = index + 3;
    for (; end < tokens.length; end++) {
      if (tokens[end].type !== 'Punctuator') continue;
      if (tokens[end].value === '(') depth++;
      if (tokens[end].value === ')' && --depth === 0) break;
    }
    assert.ok(end < tokens.length, 'an assertion call must close');
    const call = tokens.slice(index, end + 1).map(({ type, value }) => [type, value]);
    assertions.push(call);
    tests.at(-1)?.assertions.push(call);
  }
  return { names, assertions, tests };
}

// A retired test is named, with the file and test that replace it and why: its name and every assertion inside it leave
// the original's streams, and nothing else of the original may change. Only a test of the original can be retired,
// and a replaced test's replacement must exist (checked by the custody test that reads the entry).
export function retained(original, consumer, label, retired = []) {
  const before = signatures(original), after = signatures(consumer);
  for (const name of retired) assert.ok(before.names.includes(name), `${label}: only a test of the original can be retired: ${name}`);
  const kept = before.tests.filter(test => !retired.includes(test.name));
  const expected = { names: kept.map(test => test.name), assertions: kept.flatMap(test => test.assertions) };
  assert.deepEqual(after.names, expected.names, `${label}: original literal test names changed`);
  assert.deepEqual(after.assertions, expected.assertions, `${label}: original assertion calls changed`);
  return expected;
}

// What is wrong with one retirement entry, or null. Every retired test says why and either names the test that replaces
// it (`replaced_by` file and `replaced_by_test`, which must exist there and must run: a skipped or todo test is no
// replacement) or carries an explicit `no_replacement_because` of at least six words. Every `because` is at least six
// words too; a retirement may never be silent or thin.
const wordsOf = text => String(text ?? '').trim().split(/\s+/).filter(Boolean).length;
export function retirementProblem(retired, readReplacement) {
  if (!retired?.name || !retired.because) return 'a retirement names the test and says why';
  if (wordsOf(retired.because) < 6) return `${retired.name}: because says why in at least six words`;
  if (retired.replaced_by_test || retired.replaced_by) {
    if (!retired.replaced_by || !retired.replaced_by_test) return `${retired.name}: a replacement names both its file and its test`;
    let source;
    try { source = readReplacement(retired.replaced_by); } catch { return `${retired.name}: the replacement file cannot be read: ${retired.replaced_by}`; }
    const replacement = signatures(source).tests.find(test => test.name === retired.replaced_by_test);
    if (!replacement) return `${retired.name}: the replacement test does not exist: ${retired.replaced_by_test}`;
    if (replacement.skipped) return `${retired.name}: the replacement test is skipped or todo, so it never runs: ${retired.replaced_by_test}`;
    if (replacement.assertions.length === 0) return `${retired.name}: the replacement test asserts nothing: ${retired.replaced_by_test}`;
    return null;
  }
  return wordsOf(retired.no_replacement_because) >= 6 ? null : `${retired.name}: with no replacement, no_replacement_because says why in at least six words`;
}

// The list of retired tests is pinned outside this repository: the control plane's DATA (test-retirement-pins.json) holds
// the BLAKE3 identity each repository's record of retired tests must have, so one commit here cannot drop a test and
// approve its own list. The pins are read from the control plane checkout's committed HEAD, never its working folder.
export const pinsFile = 'data/test-retirement-pins.json';
export function controlPlane() {
  return process.env.TRILLION_CONTROL_PLANE ?? join(homedir(), 'control-plane');
}
export function readPins(root = controlPlane()) {
  return execFileSync('git', ['-C', root, 'show', `HEAD:${pinsFile}`], { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] });
}

// What is wrong with the record at `path` (`identity` is its BLAKE3 identity now) against the pins read by `readPinned`
// for `repository`, or null. A pin file that cannot be read or parsed, a repository or path with no pin, and a different
// identity all refuse: an unreadable pin proves nothing.
export function pinProblem(repository, path, identity, readPinned) {
  let pins;
  try { pins = JSON.parse(readPinned()).pins; } catch { return `the pins of retired tests cannot be read (${pinsFile} at the control plane's committed HEAD): refused, not assumed`; }
  const pinned = pins?.[repository]?.[path];
  if (typeof pinned !== 'string' || !/^1f:[0-9a-f]{64}$/.test(pinned)) return `${repository}: ${path} has no pin in ${pinsFile}`;
  return pinned === identity ? null : `${path} is not the record pinned in ${pinsFile}: changing which tests are retired takes its own commit in the control plane`;
}
