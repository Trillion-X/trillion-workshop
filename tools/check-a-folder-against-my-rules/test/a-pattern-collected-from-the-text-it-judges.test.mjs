// A pattern may be collected from the TEXT IT JUDGES, not only written into the rule.
//
// This is the second pattern source. It exists because a rule cannot write down the names a
// document declares, since they differ per document, so "every reference also appears as a
// declaration" was previously sayable only at whole-file scope, where the engine reports one
// existential finding with no line and the whole file as evidence. That was measured and
// reverted once already, in a recorded finding set (its line 42).
//
// Every case below came from an adversarial review that attacked the design before it was
// built, as recorded in its design review:
// the collected-pattern-source notes.
// Each one is a defect the first draft would have shipped.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  fileConditionHolds,
  toRegExp,
  violationsInFile,
} from '../do-work/check-source-files-against-declared-rules.mjs';

const LINES = { split: '\\n' };

/** The shape the whole feature exists for: a line reading an address is a finding UNLESS the
 *  same file declares that name. Set difference, using the algebra that was already here. */
const declaredNames = { collected: { pattern: '"name"\\s*:\\s*"([a-z0-9-]+)"', capture: 1 } };

const referenceRule = {
  id: 'a-step-reads-an-address-nothing-declares',
  scope: {},
  violation: {
    unit: LINES,
    forbidden: { pattern: '"from"\\s*:\\s*"[^"]*::([a-z0-9-]+)"' },
    exempt: declaredNames,
  },
  message: 'this step reads an address nothing in the file declares',
};

const declaration = (name) => `{ "name": "${name}" }`;
const reference = (name) => `{ "from": "package::p::stored-bytes::${name}" }`;

test('a reference whose name the file declares is silent', () => {
  const text = [declaration('carrier-mjs'), reference('carrier-mjs')].join('\n');
  assert.deepEqual(violationsInFile(referenceRule, 'a.json', text), []);
});

test('a reference whose name nothing declares is a finding, at its line', () => {
  const text = [declaration('carrier-mjs'), reference('carrier-mjs'), reference('gone-mjs')].join('\n');
  const found = violationsInFile(referenceRule, 'a.json', text);
  assert.equal(found.length, 1);
  assert.equal(found[0].line, 3, 'the whole point: it names WHICH reference dangles');
});

// THE DEFECT THE DESIGN TURNS ON. An alternation built from nothing is `()`, which matches at
// every position, so a naive empty set would exempt the entire corpus and report it clean.
test('a file that declares NOTHING exempts nothing, rather than everything', () => {
  const text = [reference('one-mjs'), reference('two-mjs')].join('\n');
  const found = violationsInFile(referenceRule, 'a.json', text);
  assert.equal(found.length, 2, 'an empty collected set must never match');
});

// Without token boundaries a declared name spares any longer name containing it, which is the
// exact failure the rule exists to catch. The hyphen must be in the boundary class, or this is
// inert on a corpus where every name is hyphenated.
test('a declared name does not spare a longer undeclared one', () => {
  const text = [declaration('carrier-mjs'), reference('carrier-mjs-old')].join('\n');
  const found = violationsInFile(referenceRule, 'a.json', text);
  assert.equal(found.length, 1, 'carrier-mjs-old is not declared and must not ride on carrier-mjs');
});

test('before and after overrides let a rule anchor precisely instead', () => {
  const anchored = {
    ...referenceRule,
    violation: {
      ...referenceRule.violation,
      exempt: { collected: { ...declaredNames.collected, before: 'stored-bytes::', after: '"' } },
    },
  };
  const text = [declaration('carrier-mjs'), reference('carrier-mjs'), reference('gone-mjs')].join('\n');
  const found = violationsInFile(anchored, 'a.json', text);
  assert.equal(found.length, 1);
  assert.equal(found[0].line, 3);
});

test('product identity boundaries treat underscore and hyphen as separators', () => {
  const productIdentity = {
    collected: {
      from_subject: 'package_set_identity',
      pattern: '^identity\\t(.+)$',
      flags: 'm',
      capture: 1,
      match_flags: 'i',
      before: '(?<![a-z0-9])',
      after: '(?![a-z0-9])',
    },
  };
  const rule = {
    id: 'generic-source-may-not-name-product',
    scope: {},
    violation: { unit: LINES, forbidden: productIdentity },
  };
  const text = [
    'const a = "acme_config";',
    'const b = "acme-school";',
    'const c = "methodology";',
  ].join('\n');
  const found = violationsInFile(
    rule,
    'source.ts',
    text,
    { package_set_identity: 'identity\tacme' },
  );
  assert.deepEqual(found.map((row) => row.line), [1, 2]);
});

// THE TRAP. `patternList` used `value.map(toRegExp)`, and Array.prototype.map passes the array
// INDEX as the second argument. With a subject-aware toRegExp, every pattern in a LIST would
// collect from a number. Literals ignore it, so every other test in this package passes with
// the bug present. This is the only case that catches it.
test('a collected pattern inside a LIST collects from the subject, not from its array index', () => {
  const inAList = {
    ...referenceRule,
    violation: { ...referenceRule.violation, exempt: ['^\\s*//', declaredNames] },
  };
  const text = [declaration('carrier-mjs'), reference('carrier-mjs'), reference('gone-mjs')].join('\n');
  const found = violationsInFile(inAList, 'a.json', text);
  assert.equal(found.length, 1, 'the declared name must still exempt its own reference from inside a list');
  assert.equal(found[0].line, 3);
});

// Collection is legal ONLY in exempt, because exempt is OR-composed and an empty set there
// leaves the rule armed. In forbidden an empty set makes the conjunction false for every unit
// of every file, a silent clean sweep; in required it makes every unit a finding.
// ⭐ REPLACED 2026-09-05, and the replacement is stronger than what it removes.
//
// This test used to assert that `collected` in `forbidden` or `required` is refused outright. That
// refusal was dropped. What goes wrong is the silence of an empty collected set:
// in `forbidden` the AND-conjunction is false for every unit of every file, so the run reports the
// whole corpus clean; in `required` it is false for every unit, so every unit becomes a finding.
// Neither is an answer. Banning the mechanism also outlawed a whole family of legitimate rules,
// "this document's own declared name must not appear inside its own identifiers", which is exactly
// the shape needed to catch a package forking a shared concept under its own name.
//
// So the refusal now targets the empty set rather than the slot, and the family is expressible.
test('a collected pattern IS legal in forbidden and required, and collects normally', () => {
  const text = '{ "name": "alpha" }\nalpha appears here\nbeta appears here';
  const rule = { id: 'r', scope: {}, violation: { unit: LINES, forbidden: declaredNames } };
  const found = violationsInFile(rule, 'a.json', text);
  assert.equal(found.length, 2, 'the declaration line and the usage line both contain alpha');
  assert.ok(found.every((f) => f.evidence.includes('alpha')));
});

test('an EMPTY collected set in forbidden or required THROWS, because neither polarity is an answer', () => {
  // Nothing in this text declares a name, so the set is empty. Before, `forbidden` would have
  // reported the corpus clean and `required` would have made every line a finding, both silently.
  const nothingDeclared = 'no declarations here at all';

  const inForbidden = { id: 'r', scope: {}, violation: { unit: LINES, forbidden: declaredNames } };
  assert.throws(() => violationsInFile(inForbidden, 'a.json', nothingDeclared), /collected nothing/);

  const inRequired = { id: 'r', scope: {}, violation: { unit: LINES, required: declaredNames } };
  assert.throws(() => violationsInFile(inRequired, 'a.json', nothingDeclared), /collected nothing/);

  // And the same empty set in `exempt` is FINE, because OR-composition means it spares nothing and
  // leaves the rule fully armed. That asymmetry is the whole reason the refusal is per slot.
  const inExempt = { id: 'r', scope: {}, violation: { unit: LINES, forbidden: 'declarations', exempt: declaredNames } };
  assert.equal(violationsInFile(inExempt, 'a.json', nothingDeclared).length, 1);
});

test('a collected pattern with no subject at all is refused, naming the slot', () => {
  assert.throws(
    () => toRegExp(declaredNames, null, 'scope.path_matches'),
    /scope\.path_matches: a collected pattern has no subject/,
  );
  assert.throws(() => fileConditionHolds({ content_matches: declaredNames }, 'text'), /no subject to collect from/);
});

test('a capture that produces an empty string is refused, because it would match everywhere', () => {
  const optional = { collected: { pattern: '"name"\\s*:\\s*"([a-z-]*)"', capture: 1 } };
  const rule = { id: 'r', scope: {}, violation: { unit: LINES, forbidden: 'x', exempt: optional } };
  assert.throws(() => violationsInFile(rule, 'a.json', '{ "name": "" }\nx'), /would match everywhere/);
});

test('a capture group that does not exist is refused', () => {
  const missing = { collected: { pattern: '"name"\\s*:\\s*"([a-z-]+)"', capture: 4 } };
  const rule = { id: 'r', scope: {}, violation: { unit: LINES, forbidden: 'x', exempt: missing } };
  assert.throws(() => violationsInFile(rule, 'a.json', '{ "name": "a" }\nx'), /would match everywhere/);
});

test('collected requires an explicit capture number, so a whole-match default cannot mean a second thing', () => {
  const noCapture = { collected: { pattern: '"name"' } };
  const rule = { id: 'r', scope: {}, violation: { unit: LINES, forbidden: 'x', exempt: noCapture } };
  assert.throws(() => violationsInFile(rule, 'a.json', 'x'), /explicit capture group number/);
});

// A `g` matcher is stateful through lastIndex, and matchers are built once per file and reused
// across every unit, so a stateful one would alternate true and false down the units. The scan
// needs `g` and the produced matcher must not have it.
test('a collected scan carrying the g flag does not produce a stateful matcher', () => {
  const withG = { collected: { pattern: '"name"\\s*:\\s*"([a-z0-9-]+)"', capture: 1, flags: 'g' } };
  const rule = {
    id: 'r',
    scope: {},
    violation: { unit: LINES, forbidden: { pattern: '"from"' }, exempt: withG },
  };
  const text = [
    declaration('carrier-mjs'),
    reference('carrier-mjs'),
    reference('carrier-mjs'),
    reference('carrier-mjs'),
  ].join('\n');
  assert.deepEqual(violationsInFile(rule, 'a.json', text), [], 'every unit must be judged the same way');
});

test('a repeated declaration is collected once, so the alternation does not grow with the document', () => {
  const text = [declaration('a-mjs'), declaration('a-mjs'), declaration('a-mjs'), reference('a-mjs')].join('\n');
  assert.deepEqual(violationsInFile(referenceRule, 'a.json', text), []);
});

test('a declared name containing regex metacharacters is matched literally', () => {
  const dotted = { collected: { pattern: '"name"\\s*:\\s*"([a-z.]+)"', capture: 1 } };
  const rule = {
    id: 'r',
    scope: {},
    violation: { unit: LINES, forbidden: { pattern: '"from"' }, exempt: dotted },
  };
  // `a.c` as a regex would match `abc`. Escaped, it does not, so the second line stays a finding.
  const text = ['{ "name": "a.c" }', '{ "from": "abc" }'].join('\n');
  const found = violationsInFile(rule, 'a.json', text);
  assert.equal(found.length, 1, 'the dot must be a literal dot, not any character');
});

test('a literal pattern behaves identically whether or not a subject is passed', () => {
  assert.equal(toRegExp('abc').source, toRegExp('abc', 'some subject').source);
  assert.equal(toRegExp({ pattern: 'abc', flags: 'i' }).flags, 'i');
  // The existing contract, unchanged: a non-pattern still throws the same way.
  assert.throws(() => toRegExp({ flags: 'i' }), /a pattern is a string, or \{pattern, flags\}/);
});
