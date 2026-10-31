// Can a SINGLE regular expression, with no new engine capability, report a reference whose
// declaration is absent from the same document?
//
// This exists because a plan claimed it cannot, and an independent review said that claim is
// probably false and could not execute it. A root cause stated wrongly is a root the next
// person re-derives, so it gets measured rather than argued.
//
// The trick under test is JavaScript-specific: V8 supports VARIABLE-LENGTH lookbehind, which
// PCRE does not, and a backreference to a group captured earlier is visible inside a lookbehind
// that follows it. Lookahead alone is not enough, and that is not hypothetical: in
// autonomous-agent-tick's manifest the declarations sit at lines 6 to 61 and again at 1825
// while the references run from 948 to 2963, so declarations appear on BOTH sides of a
// reference and a forward-only assertion reports every reference whose declaration precedes it.

import assert from 'node:assert/strict';
import test from 'node:test';

/** A reference whose name is declared nowhere in the document, in one pattern.
 *
 *  Read it as: match a reference and capture its name; assert no declaration of that exact
 *  name appears AFTER this point; assert none appears BEFORE it. The capture is pinned on the
 *  right by the literal closing quote, so backtracking cannot widen it to find a luckier name. */
const DANGLING_REFERENCE = /stored-bytes::([a-z0-9-]+)"(?![\s\S]*"name"\s*:\s*"\1")(?<!"name"\s*:\s*"\1"[\s\S]*)/;

const declaration = (name) => `      { "name": "${name}", "source_path": "processes/${name}.mjs" }`;
const reference = (name) => `          { "from": "package::p::stored-bytes::${name}" }`;

test('the engine this repo runs on supports the construct at all', () => {
  // If a future runtime drops variable-length lookbehind, every assertion below would pass
  // for the wrong reason: the pattern would throw at construction, not match nothing. Prove
  // the construct is live before trusting any result that depends on it.
  assert.doesNotThrow(() => new RegExp('(?<!a[\\s\\S]*)b'), 'variable-length lookbehind is unavailable');
  assert.doesNotThrow(() => new RegExp('(x)(?<!\\1[\\s\\S]*)'), 'a backreference inside a lookbehind is unavailable');
});

test('a declaration BEFORE its reference is correctly resolved, which lookahead alone gets wrong', () => {
  const text = [declaration('carrier-mjs'), reference('carrier-mjs')].join('\n');
  assert.equal(DANGLING_REFERENCE.test(text), false);

  // The forward-only form is what a rule author reaches for first, and it is wrong here.
  const lookaheadOnly = /stored-bytes::([a-z0-9-]+)"(?![\s\S]*"name"\s*:\s*"\1")/;
  assert.equal(lookaheadOnly.test(text), true, 'lookahead alone reports a resolved reference as dangling');
});

test('a declaration AFTER its reference is correctly resolved', () => {
  const text = [reference('carrier-mjs'), declaration('carrier-mjs')].join('\n');
  assert.equal(DANGLING_REFERENCE.test(text), false);
});

test('a reference with no declaration anywhere IS reported', () => {
  const text = [declaration('carrier-mjs'), reference('surface-human-work-once-mjs')].join('\n');
  assert.equal(DANGLING_REFERENCE.test(text), true);
});

test('one dangling reference among many resolved ones is still reported', () => {
  const text = [
    declaration('carrier-mjs'),
    declaration('sweep-decisions-once-mjs'),
    reference('carrier-mjs'),
    reference('sweep-decisions-once-mjs'),
    reference('evaluate-conditions-once-mjs'),
    reference('carrier-mjs'),
  ].join('\n');
  assert.equal(DANGLING_REFERENCE.test(text), true);
});

test('the real shape, declarations on BOTH sides of the references', () => {
  const text = [
    declaration('carrier-mjs'),
    declaration('produce-grounded-mjs'),
    reference('carrier-mjs'),
    reference('produce-grounded-mjs'),
    reference('spawn-check-mjs'),
    declaration('spawn-check-mjs'),
  ].join('\n');
  assert.equal(DANGLING_REFERENCE.test(text), false, 'every reference resolves, in either direction');
});

// NOT a limit, and this was predicted wrong before it was run. Recorded because the wrong
// prediction is the useful part.
//
// The guess was that a longer declared name CONTAINS the shorter one and would spare it, the
// same substring hole a collected exemption has. It does not, and the reason is exact: the
// assertion is `"name"\s*:\s*"\1"` WITH the closing quote, so `"carrier-mjs-old"` cannot
// satisfy a search for `"carrier-mjs"`. The declaration's own delimiter does the anchoring
// for free.
//
// This inverts one comparison between the two approaches. A collected set built as a bare
// alternation loses that context, because it is tested against a unit rather than against the
// declaration site, which is why a collected exemption needs explicit token boundaries to
// reach the safety this one-line pattern already has.
test('a prefix collision is correctly REPORTED, because the closing quote anchors the declaration', () => {
  const text = [declaration('carrier-mjs-old'), reference('carrier-mjs')].join('\n');
  assert.equal(
    DANGLING_REFERENCE.test(text),
    true,
    'carrier-mjs is not declared, only carrier-mjs-old is, and the pattern says so',
  );

  // The converse, so this is not passing for an accident of direction.
  const reversed = [declaration('carrier-mjs'), reference('carrier-mjs-old')].join('\n');
  assert.equal(DANGLING_REFERENCE.test(reversed), true, 'the longer undeclared name is reported too');
});

// THE DECIDING LIMIT. `test` is existential: it answers whether the document contains at least
// one dangling reference, and nothing more. The engine reports findings per UNIT, and the only
// unit that can hold both a reference and its distant declaration is the whole file. So this
// pattern can only ever produce one finding per file, carrying `line: null`, with the whole
// file as its evidence, and a per-path count of 1 that absorbs every later regression in that
// file silently.
//
// That is not a guess about the engine, it is measured and already written down in
// a recorded finding set (its line 42), where whole-file units
// were tried for another rule and reverted because `unit` governs displayed CONTENT as well as
// granularity: the report printed all 17 files in full and became unreadable.
test('DECIDING LIMIT: the pattern is existential, so it cannot say WHICH reference dangles', () => {
  const text = [
    declaration('carrier-mjs'),
    reference('carrier-mjs'),
    reference('first-dangler-mjs'),
    reference('second-dangler-mjs'),
  ].join('\n');

  assert.equal(DANGLING_REFERENCE.test(text), true, 'it knows something is wrong');

  // And per line, which is the granularity a usable report needs, it knows nothing: no line
  // carries both a reference and the declaration that would resolve it.
  const perLine = text.split('\n').filter((line) => DANGLING_REFERENCE.test(line));
  assert.equal(perLine.length, 3, 'every reference line looks dangling in isolation, including the resolved one');
});
