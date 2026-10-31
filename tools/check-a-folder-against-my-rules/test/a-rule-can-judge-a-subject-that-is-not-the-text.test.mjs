/**
 * file: tools/check-a-folder-against-my-rules/test/a-rule-can-judge-a-subject-that-is-not-the-text.test.mjs
 *
 * Can a declared rule judge something OTHER than the contents of the file?
 *
 * Every rule shipped so far judges file text, and that made a whole class of rule inexpressible:
 * anything about the NAME. A deploy folder had accumulated 116 copies called
 * `.sequence-14-kept-20260714`, `.previous-20260618162448` and `.FAILED-BOOT`, 15GB of them, and
 * no rule could say so, because the only string this judge could see was what was inside them.
 *
 * The lazy fix is `if (rule.judges === 'path')`. That is the closed enum this package already
 * refused once for units, where `unit: "file" | "line"` became `{split: <pattern>}` so that the
 * handler stopped knowing the names of the things it handles. The same answer applies here: the
 * rule NAMES A KEY, and the handler looks it up in whatever the caller supplied. Nothing in the
 * judge knows the word "path" or the word "text".
 *
 * So the test is not "does the path rule work". It is whether the SEAM is real: a rule reaches a
 * subject by name, a subject that was never supplied fails loudly rather than covering nothing,
 * and every rule written before this existed still judges text without saying so.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { violationsInFile } from '../do-work/check-source-files-against-declared-rules.mjs';

const NAME_CARRIES_ITS_VERSION = {
  id: 'a-file-name-may-not-carry-its-own-version',
  subject: { named: 'path' },
  scope: { path_matches: '^deploy/' },
  violation: {
    forbidden: [{ pattern: '[./-](previous|sequence|kept|backup)-[0-9a-zA-Z]|FAILED-' }],
  },
  message: 'a file name carries its own version',
};

test('a rule judges the subject it names, so a filename rule is expressible at all', () => {
  const found = violationsInFile(
    NAME_CARRIES_ITS_VERSION,
    'deploy/http-app-open-source-bundle.sequence-18-kept-20260714',
    'the contents are irrelevant and deliberately clean',
  );
  assert.equal(found.length, 1);
  assert.equal(found[0].rule_id, 'a-file-name-may-not-carry-its-own-version');
  // The EVIDENCE is the path, not a line of the file. A reader who cannot see which string was
  // judged cannot tell a name finding from a content finding in the same report.
  assert.match(found[0].evidence, /sequence-18-kept/);
  // Whole-subject units carry `line: null`, never 0, for the reason unitsOf documents: 0 is a
  // line that does not exist and would send a reader somewhere that is not there.
  assert.equal(found[0].line, null);
});

test('the file contents cannot rescue a bad name, which is the whole point of naming the subject', () => {
  // Text that WOULD match the pattern, under a name that does not. A judge still reading text
  // would report this, and reporting it would be wrong: the rule is about the name.
  const found = violationsInFile(
    NAME_CARRIES_ITS_VERSION,
    'deploy/public-entry-server.cjs',
    'const label = "restored from backup-2 and the previous-1 attempt, FAILED-BOOT";',
  );
  assert.deepEqual(found, []);
});

test('a subject the caller never supplied THROWS, because covering nothing silently is how a guard reports clean forever', () => {
  const reachesForSomethingAbsent = { ...NAME_CARRIES_ITS_VERSION, subject: { named: 'owner' } };
  assert.throws(
    () => violationsInFile(reachesForSomethingAbsent, 'deploy/anything.sequence-1-kept-2026', 'text'),
    // The message names what was asked for AND what was available, because the author of a rule
    // that reaches for the wrong key needs to see the set they could have named.
    /judges "owner".*Available: path, text/s,
  );
});

test('a subject declared without a name is refused rather than treated as absent', () => {
  const malformed = { ...NAME_CARRIES_ITS_VERSION, subject: {} };
  assert.throws(
    () => violationsInFile(malformed, 'deploy/anything.sequence-1-kept-2026', 'text'),
    /without \{named: <key>\}/,
  );
});

test('every rule written before this existed still judges text, having never said so', () => {
  const judgesTextByDefault = {
    id: 'no-todo-left-behind',
    scope: { path_matches: '\\.mjs$' },
    violation: { unit: { split: '\\n' }, forbidden: [{ pattern: 'TODO' }] },
  };
  // The PATH here contains the word the rule forbids. A default that silently switched to the
  // path would report this, so this asserts the default is text by catching the opposite error.
  const found = violationsInFile(judgesTextByDefault, 'src/TODO-later.mjs', 'const a = 1;\nTODO: fix\n');
  assert.equal(found.length, 1);
  assert.equal(found[0].line, 2);
  assert.match(found[0].evidence, /TODO: fix/);
});
