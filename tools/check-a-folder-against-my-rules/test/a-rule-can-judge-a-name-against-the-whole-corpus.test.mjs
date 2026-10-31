// A rule that answers "does the thing this line NAMES still exist".
//
// Existence is a fact about the corpus, so no rule reading one document could hold it, and
// reference integrity was inexpressible rather than merely hard. The sibling test
// `can-one-pattern-answer-reference-integrity.test.mjs` measured the alternative honestly: a
// single lookbehind pattern CAN answer it within one file, but only existentially, producing one
// finding per file with `line: null`. That is the limit this route exists to pass, so both are
// kept: one proves what a document can say about itself, this proves what only the caller can say.
//
// The dangerous property under test is the SILENT one. Every failure mode below reports a clean
// run rather than an error, which is the exact way a guard stops being a guard.

import assert from 'node:assert/strict';
import test from 'node:test';

import { violationsAcrossFiles, violationsInFile } from '../do-work/check-source-files-against-declared-rules.mjs';

/** The shipped rule, in the shape it is stored in, minus the prose. */
const RULE = {
  id: 'a-declared-package-address-must-name-a-live-package',
  why: 'a declared address that resolves to nothing fails quietly at mount time',
  scope: { path_matches: 'things-to-store-and-run\\.json$' },
  violation: {
    unit: { split: '["\',\\n]' },
    forbidden: [{ pattern: 'package::[a-z0-9-]+::' }],
    exempt: [
      {
        collected: {
          from_subject: 'every_path',
          pattern: 'packages/([a-z0-9-]+)/things-to-store-and-run\\.json',
          capture: 1,
          before: 'package::',
          after: '::',
        },
      },
    ],
  },
  message: 'this address names a package that no longer exists on disk',
};

const corpus = (...names) => names.map((name) => `packages/${name}/things-to-store-and-run.json`).join('\n');
const address = (name, blob) => `          { "from": "package::${name}::stored-bytes::${blob}" }`;

test('an address naming a live package is not a finding', () => {
  const text = address('send-requests-to-an-engine', 'find-and-send-node-source');
  const found = violationsInFile(RULE, 'packages/content-generation/things-to-store-and-run.json', text, {
    every_path: corpus('content-generation', 'send-requests-to-an-engine'),
  });
  assert.deepEqual(found, []);
});

test('THE OCCASION: an address left behind by a rename IS a finding', () => {
  // Exactly what happened on 2026-09-05. The renamed package is correct, its tombstone is
  // correct, its rows are correctly retracted, and this consumer is wrong with nothing saying so.
  const text = address('send-requests-to-running-app', 'find-and-send-node-source');
  const found = violationsInFile(RULE, 'packages/content-generation/things-to-store-and-run.json', text, {
    every_path: corpus('content-generation', 'send-requests-to-an-engine'),
  });
  assert.equal(found.length, 1);
  assert.equal(found[0].rule_id, RULE.id);
  assert.equal(found[0].line, 1);
  assert.equal(found[0].evidence, 'package::send-requests-to-running-app::stored-bytes::find-and-send-node-source');
});

test('a live and a dead address on the SAME line: the dead one is still reported', () => {
  // The reason the unit splits on quotes and commas rather than on newlines. With line units the
  // live address vetoes the whole line and the dead one ships, which is a guard that reports clean
  // BECAUSE something correct is nearby.
  const text = '{ "a": "package::documents::stored-bytes::x", "b": "package::gone-away::stored-bytes::y" }';
  const found = violationsInFile(RULE, 'packages/p/things-to-store-and-run.json', text, {
    every_path: corpus('documents', 'p'),
  });
  assert.equal(found.length, 1);
  assert.equal(found[0].evidence, 'package::gone-away::stored-bytes::y');
});

test('a longer live name does not spare a shorter dead one', () => {
  // The substring hole the collected matcher's token boundaries exist for. `local-files` being
  // live must not exempt a reference to the retired `local`.
  const text = address('local', 'read-a-file');
  const found = violationsInFile(RULE, 'packages/p/things-to-store-and-run.json', text, {
    every_path: corpus('local-files', 'p'),
  });
  assert.equal(found.length, 1, 'local-files does not make local exist');
});

test('a shorter live name does not spare a longer dead one', () => {
  const text = address('documents-old', 'x');
  const found = violationsInFile(RULE, 'packages/p/things-to-store-and-run.json', text, {
    every_path: corpus('documents', 'p'),
  });
  assert.equal(found.length, 1, 'documents does not make documents-old exist');
});

test('the address VOCABULARY is in the record, so a different spelling is inert here', () => {
  // Proof the engine knows nothing. `mount::<name>::` is not this rule's shape, and this rule
  // ignores it rather than the engine having an opinion about it. A corpus using that spelling
  // writes its own record and edits no code.
  const text = '          { "from": "mount::send-requests-to-running-app::bytes::x" }';
  assert.deepEqual(
    violationsInFile(RULE, 'packages/p/things-to-store-and-run.json', text, { every_path: corpus('p') }),
    [],
  );
});

test('a rule naming a subject the caller did not supply THROWS, it does not report clean', () => {
  // The whole design turns on this. An absent corpus would collect nothing, an empty collected set
  // exempts nothing, and the rule would then report EVERY address in the repository as dangling.
  // The opposite polarity is worse and quieter. Neither is a finding value, so it is refused.
  assert.throws(
    () => violationsInFile(RULE, 'packages/p/things-to-store-and-run.json', address('documents', 'x')),
    /every_path/,
    'the error must name the subject that was missing',
  );
});

test('the corpus subject reaches every file of a multi-file run', () => {
  // violationsAcrossFiles forwards it, or the rule works in a unit test and throws on the first
  // real run, which is the least useful place to find out.
  const files = [
    { path: 'packages/a/things-to-store-and-run.json', text: address('documents', 'x') },
    { path: 'packages/b/things-to-store-and-run.json', text: address('gone-away', 'y') },
  ];
  const found = violationsAcrossFiles([RULE], files, { every_path: corpus('a', 'b', 'documents') });
  assert.equal(found.length, 1);
  assert.equal(found[0].path, 'packages/b/things-to-store-and-run.json');
});

test('an untracked package still counts as existing, because the corpus is what is ON DISK', () => {
  // Four manifests were on disk and never `git add`ed on 2026-09-05. Filtering the corpus by the
  // index would report every address naming them as dangling, which is a false accusation built
  // out of somebody else's pending commit. The runner therefore joins tracked and untracked.
  const text = address('native-artifact', 'project-app-open-bundle');
  const found = violationsInFile(RULE, 'packages/p/things-to-store-and-run.json', text, {
    every_path: corpus('p', 'native-artifact'),
  });
  assert.deepEqual(found, []);
});
