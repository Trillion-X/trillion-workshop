import assert from 'node:assert/strict';
import test from 'node:test';

import {
  countByRuleAndPath,
  differenceFromRecorded,
  fileConditionHolds,
  reportByRule,
  ruleCoversPath,
  toRegExp,
  violationsAcrossFiles,
  violationsInFile,
} from '../do-work/check-source-files-against-declared-rules.mjs';

// The two rules that already exist in this repo as hand-written checks, expressed as DATA.
// They are the ground truth: if the engine cannot say these, it does not replace anything.

// Lines are not a unit the engine knows by name. They are a division of the text, declared
// the same way any other division is, which is why a rule can invent one the engine has
// never seen without an edit there. Named here only so these rules read clearly.
const LINES = { split: '\\n' };

const NO_BRAND_IN_MACHINE_PATHS = {
  id: 'no-brand-name-in-a-machine-path',
  why: 'a lock file or a temp file is already unique by the hash or id in its name, so a brand adds nothing a machine can use and smears the brand across directories that have no idea what it is',
  scope: { path_matches: '\\.(mjs|js|ts|tsx|sh)$' },
  applies_when: { content_matches: 'tmpdir\\(\\)|temp_dir\\(\\)|mkdtemp' },
  violation: {
    unit: LINES,
    forbidden: { pattern: '(acme|globex|initech)', flags: 'i' },
    exempt: 'remap-path-prefix',
  },
  message: 'a machine path carries a brand name',
};

const LONG_LIVED_MUST_NOT_FREEZE_THE_ADDRESS = {
  id: 'long-lived-process-must-not-freeze-the-runtime-address',
  why: 'the runtime picks its port at startup, so a process that outlives a restart and read the address once is talking to a dead port or to whoever else was handed that number, and neither reports an error',
  scope: { path_matches: '\\.mjs$', path_excludes: '\\.test\\.mjs$' },
  applies_when: {
    all: [
      { content_matches: 'CARRIER_URL(?!_FILE)' },
      { content_matches: 'while\\s*\\(\\s*true\\s*\\)|setInterval\\s*\\(' },
    ],
  },
  violation: { required: 'CARRIER_URL_FILE' },
  message: 'this process keeps running across a runtime restart but reads the address once',
};

const GROUND_TRUTH = [NO_BRAND_IN_MACHINE_PATHS, LONG_LIVED_MUST_NOT_FREEZE_THE_ADDRESS];

test('a long-lived process missing the address reference is reported once, for the file', () => {
  const text = 'const CARRIER_URL = env.CARRIER_URL;\nsetInterval(sweep, 1000);\n';
  const found = violationsInFile(LONG_LIVED_MUST_NOT_FREEZE_THE_ADDRESS, 'processes/worker.mjs', text);
  assert.equal(found.length, 1);
  assert.equal(found[0].line, null, 'a whole-file finding carries null, never a line that does not exist');
});

test('the same process is silent once it accepts the address reference', () => {
  const text = 'const url = env.CARRIER_URL ?? read(env.CARRIER_URL_FILE);\nsetInterval(sweep, 1000);\n';
  assert.deepEqual(violationsInFile(LONG_LIVED_MUST_NOT_FREEZE_THE_ADDRESS, 'processes/worker.mjs', text), []);
});

test('a one-shot process is not judged at all, because it cannot freeze anything', () => {
  const text = 'const CARRIER_URL = env.CARRIER_URL;\nawait runOnce();\n';
  assert.deepEqual(violationsInFile(LONG_LIVED_MUST_NOT_FREEZE_THE_ADDRESS, 'processes/once.mjs', text), []);
});

test('a brand in a shared temp path is reported at its line', () => {
  const text = 'import os from "os";\nconst lock = join(tmpdir(), `acme-worker-${id}.lock`);\n';
  const found = violationsInFile(NO_BRAND_IN_MACHINE_PATHS, 'processes/worker.mjs', text);
  assert.equal(found.length, 1);
  assert.equal(found[0].line, 2, 'a line finding is 1-based and points where a reader can look');
});

// The defect that made the first real run useless. The file-level gate says only that this
// file builds a machine path SOMEWHERE; it never said this line is one. With the brand as the
// sole line pattern, every brand-bearing line in such a file was a finding: 360 of them over
// the package set, almost all environment variable names and import specifiers. A guard that
// reports 360 things, of which 6 are real, is a guard somebody deletes.
test('a brand is only a finding on a line that is itself a machine path', () => {
  const conjunction = {
    ...NO_BRAND_IN_MACHINE_PATHS,
    violation: {
      unit: LINES,
      forbidden: [{ pattern: 'tmpdir\\(\\)|mkdtemp' }, { pattern: 'acme', flags: 'i' }],
      exempt: ['remap-path-prefix'],
    },
  };
  const text = [
    'const base = tmpdir();',                          // a machine path, no brand
    'const url = env.ACME_TARGET_CARRIER_URL;',    // a brand, not a path
    'const lock = join(tmpdir(), `acme-${id}`);',  // both: the only finding
  ].join('\n');

  const found = violationsInFile(conjunction, 'a.mjs', text);
  assert.equal(found.length, 1, 'several forbidden patterns mean AND, so neither line alone is a finding');
  assert.equal(found[0].line, 3);
});

test('several exempt patterns each spare a line on their own, because exemption is OR', () => {
  const rule = {
    id: 'r',
    scope: {},
    violation: { unit: LINES, forbidden: 'brand', exempt: ['remap-path-prefix', '^\\s*(//|\\*|#)'] },
  };
  // Prose about a path is not a path: only what runs counts. Both exemptions are needed and
  // neither implies the other, which is why they compose the opposite way to `forbidden`.
  const text = '  // brand goes here\nRUSTFLAGS="--remap-path-prefix=/x/brand=root";\nconst p = "brand";';
  const found = violationsInFile(rule, 'a.sh', text);
  assert.equal(found.length, 1);
  assert.equal(found[0].line, 3);
});

test('an exemption spares the line without weakening the rule for every other line', () => {
  const text = 'const a = join(tmpdir(), "x");\nRUSTFLAGS="--remap-path-prefix=/home/acme=root";\n';
  assert.deepEqual(violationsInFile(NO_BRAND_IN_MACHINE_PATHS, 'build.sh', text), []);
});

test('a rule ignores files outside its scope', () => {
  assert.equal(ruleCoversPath(NO_BRAND_IN_MACHINE_PATHS, 'notes/acme.md'), false);
  assert.equal(ruleCoversPath(LONG_LIVED_MUST_NOT_FREEZE_THE_ADDRESS, 'processes/worker.test.mjs'), false);
});

test('the condition algebra composes without a discriminator string', () => {
  const text = 'alpha beta';
  assert.equal(fileConditionHolds({ all: [{ content_matches: 'alpha' }, { content_matches: 'beta' }] }, text), true);
  assert.equal(fileConditionHolds({ all: [{ content_matches: 'alpha' }, { content_matches: 'gamma' }] }, text), false);
  assert.equal(fileConditionHolds({ any: [{ content_matches: 'gamma' }, { content_matches: 'beta' }] }, text), true);
  assert.equal(fileConditionHolds({ content_absent: 'gamma' }, text), true);
  assert.equal(fileConditionHolds(null, text), true, 'no condition means the rule always applies');
});

test('a flag is a field, so an inline PCRE prefix cannot silently mean nothing', () => {
  const insensitive = { id: 'r', scope: {}, violation: { unit: LINES, forbidden: { pattern: 'brand', flags: 'i' } } };
  assert.equal(violationsInFile(insensitive, 'a.mjs', 'BRAND').length, 1);

  const sensitive = { id: 'r', scope: {}, violation: { unit: LINES, forbidden: 'brand' } };

  assert.equal(violationsInFile(sensitive, 'a.mjs', 'BRAND').length, 0);

  // `(?i)` is PCRE, not JavaScript. Written inline it does not turn on a flag: it is parsed
  // as a group and the rule silently means something else. Rejecting non-patterns keeps a
  // rule author from discovering that at match time, or worse, never.
  assert.throws(() => toRegExp({ flags: 'i' }), /a pattern is a string, or \{pattern, flags\}/);
});

test('an unrecognised condition fails loudly rather than passing quietly', () => {
  assert.throws(() => fileConditionHolds({ nonsense: 'x' }, 'text'), /unrecognised condition/);
});

test('a violation with neither forbidden nor required is a broken rule, not a silent pass', () => {
  const broken = { id: 'broken', violation: { unit: 'line' } };
  assert.throws(() => violationsInFile(broken, 'a.mjs', 'x'), /neither forbidden nor required/);
});

test('a unit that is neither absent nor a division fails loudly', () => {
  // `unit: 'paragraph'` used to be the canonical failure here, and it is now a rule author
  // naming a unit the engine is supposed to be able to take. What is still broken is a unit
  // that says nothing about how to divide the text.
  const broken = { id: 'broken', violation: { unit: { every: 2 }, forbidden: 'x' } };
  assert.throws(() => violationsInFile(broken, 'a.mjs', 'x'), /a unit is absent for the whole file/);
});

// The unit half of the claim the package rests on. Paragraphs were the example of a unit the
// engine would have had to learn; now the rule says how to find one and the engine never
// hears the word.
test('a unit nobody anticipated is added as one DATA row, with zero engine change', () => {
  const paragraphs = {
    id: 'no-brand-in-a-paragraph-about-paths',
    scope: {},
    violation: { unit: { split: '\\n\\s*\\n' }, forbidden: 'brand' },
  };
  const text = 'first paragraph\nstill first\n\nsecond has brand\n\nthird is fine\n';
  const found = violationsInFile(paragraphs, 'a.md', text);
  assert.equal(found.length, 1);
  assert.equal(found[0].line, 4, 'a divided unit reports the line it STARTS on, so the report stays findable');
});

test('a whole-file unit is the default, because the least a rule can say is that it judges what it was given', () => {
  const rule = { id: 'r', scope: {}, violation: { forbidden: 'brand' } };
  const found = violationsInFile(rule, 'a.mjs', 'one\ntwo brand\nthree\n');
  assert.equal(found.length, 1);
  assert.equal(found[0].line, null);
});

// The claim the whole package rests on. If this needs an engine edit, the design failed.
test('a rule nobody anticipated is added as one DATA row, with zero engine change', () => {
  const noOrdinalNames = {
    id: 'no-ordinal-in-a-name-we-own',
    why: 'an ordinal says only which one came later, never what changed or which invariant now holds',
    scope: { path_matches: '\\.mjs$' },
    violation: { unit: LINES, forbidden: "definition_id:\\s*'[^']*-v\\d+'" },
    message: 'an ordinal suffix is not a name',
  };
  const text = "const a = 1;\nconst id = { definition_id: 'action:do-the-thing-v3' };\n";
  const found = violationsInFile(noOrdinalNames, 'a.mjs', text);
  assert.equal(found.length, 1);
  assert.equal(found[0].line, 2);
  assert.equal(found[0].rule_id, 'no-ordinal-in-a-name-we-own');
});

test('rules run across many files and report grouped under why', () => {
  const files = [
    { path: 'processes/frozen.mjs', text: 'const u = env.CARRIER_URL;\nsetInterval(f, 1);\n' },
    { path: 'processes/branded.mjs', text: 'const p = join(tmpdir(), "globex-x.lock");\n' },
    { path: 'processes/fine.mjs', text: 'const u = env.CARRIER_URL ?? read(env.CARRIER_URL_FILE);\nsetInterval(f, 1);\n' },
  ];
  const found = violationsAcrossFiles(GROUND_TRUTH, files);
  assert.equal(found.length, 2);

  const report = reportByRule(GROUND_TRUTH, found);
  assert.equal(report.length, 2, 'a rule with no findings does not appear in the report');
  for (const entry of report) {
    assert.ok(entry.why.length > 0, 'every reported rule explains itself');
  }
});

// A recorded finding set is how a rule that already has violations gets enforced at all: the
// existing ones are debt, a new one fails. The half everyone forgets is the other direction.
test('a difference from a recorded set reports what got worse AND what got fixed', () => {
  const recorded = { 'rule-a': { 'x.mjs': 2, 'gone.mjs': 1 } };
  const found = countByRuleAndPath([
    { rule_id: 'rule-a', path: 'x.mjs', line: 3 },
    { rule_id: 'rule-a', path: 'x.mjs', line: 9 },
    { rule_id: 'rule-a', path: 'x.mjs', line: 11 },
    { rule_id: 'rule-b', path: 'new.mjs', line: 1 },
  ]);

  const { appeared, fixed, unverified } = differenceFromRecorded(found, recorded);
  assert.deepEqual(unverified, [], 'a caller that names no scanned paths gets the old behaviour');

  assert.deepEqual(appeared, [
    { rule_id: 'rule-a', path: 'x.mjs', found: 3, recorded: 2 },
    { rule_id: 'rule-b', path: 'new.mjs', found: 1, recorded: 0 },
  ], 'one more in a known file, and a rule with no record at all, are both new');

  assert.deepEqual(fixed, [
    { rule_id: 'rule-a', path: 'gone.mjs', found: 0, recorded: 1 },
  ], 'a paid debt must be reported, or the record outlives it and the number never falls');
});

test('a recorded set that matches exactly is silent in both directions', () => {
  const found = countByRuleAndPath([{ rule_id: 'r', path: 'a.mjs', line: 1 }]);
  assert.deepEqual(differenceFromRecorded(found, { r: { 'a.mjs': 1 } }), { appeared: [], fixed: [], unverified: [] });
});

// The case that produced this: a baseline row read `found 0, recorded 1, delete this entry`, and
// the file had not been repaired, it had been DELETED from the worktree while still tracked at
// HEAD. Following that advice records a repair nobody made.
test('a recorded path that was never scanned is unverified, not fixed', () => {
  const recorded = { 'rule-a': { 'deleted-from-disk.mjs': 1, 'really-repaired.mjs': 1 } };

  const { fixed, unverified } = differenceFromRecorded({}, recorded, ['really-repaired.mjs']);

  assert.deepEqual(fixed, [
    { rule_id: 'rule-a', path: 'really-repaired.mjs', found: 0, recorded: 1 },
  ], 'a file that was read and came back clean is a genuine repair');
  assert.equal(unverified.length, 1);
  assert.equal(unverified[0].path, 'deleted-from-disk.mjs');
  assert.equal(unverified[0].recorded, 1);
  assert.match(unverified[0].reason, /no evidence/);
});

test('a scanned path that came back clean is still fixed when the scan list is given', () => {
  const { appeared, fixed, unverified } = differenceFromRecorded(
    { r: { 'a.mjs': 1 } },
    { r: { 'a.mjs': 2 } },
    ['a.mjs'],
  );
  assert.deepEqual(appeared, []);
  assert.deepEqual(fixed, [{ rule_id: 'r', path: 'a.mjs', found: 1, recorded: 2 }]);
  assert.deepEqual(unverified, []);
});

// An empty scan list is a caller saying it looked at nothing, which is different from a caller
// saying nothing. Every recorded row is then unverified and none is a repair.
test('an empty scan list verifies nothing rather than fixing everything', () => {
  const { fixed, unverified } = differenceFromRecorded({}, { r: { 'a.mjs': 1, 'b.mjs': 2 } }, []);
  assert.deepEqual(fixed, []);
  assert.equal(unverified.length, 2);
});

test('counting is by path, so an edit that shifts every line changes nothing', () => {
  const before = countByRuleAndPath([
    { rule_id: 'r', path: 'a.mjs', line: 4 },
    { rule_id: 'r', path: 'a.mjs', line: 8 },
  ]);
  const afterAddingALineAtTheTop = countByRuleAndPath([
    { rule_id: 'r', path: 'a.mjs', line: 5 },
    { rule_id: 'r', path: 'a.mjs', line: 9 },
  ]);
  assert.deepEqual(before, afterAddingALineAtTheTop);
  assert.deepEqual(differenceFromRecorded(afterAddingALineAtTheTop, before), { appeared: [], fixed: [], unverified: [] });
});

test('nothing is reported for a clean corpus', () => {
  const files = [{ path: 'processes/fine.mjs', text: 'const x = 1;\n' }];
  assert.deepEqual(violationsAcrossFiles(GROUND_TRUTH, files), []);
  assert.deepEqual(reportByRule(GROUND_TRUTH, []), []);
});

test('a collected matcher can case-fold identities without becoming stateful', () => {
  const rule = {
    id: 'generic-package-identity',
    why: 'future identities are DATA',
    scope: { path_matches: '^packages/' },
    violation: {
      unit: { split: '\\n' },
      forbidden: [{
        collected: {
          from_subject: 'package_set_identity',
          pattern: '^identity\\t(.+)$',
          flags: 'm',
          capture: 1,
          match_flags: 'i',
        },
      }],
    },
    message: 'identity leaked',
  };
  const files = [{ path: 'packages/generic/show.ts', text: 'const a = "ACME APP";\nconst b = "acme app";' }];
  const found = violationsAcrossFiles([rule], files, {
    package_set_identity: 'identity\tAcme App',
  });
  assert.equal(found.length, 2);
});
