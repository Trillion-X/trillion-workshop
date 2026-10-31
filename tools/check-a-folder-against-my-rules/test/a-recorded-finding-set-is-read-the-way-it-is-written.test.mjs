// Reading a recorded finding set that humans WRITE, into the shape the comparison helpers use.
//
// These are two different shapes on purpose and the mismatch is the whole subject. A person
// writes `path:line`, because that is what they paste out of a report and what they can click.
// The comparison counts per PATH, because a line number moves whenever anything above it does,
// and a record that churns on unrelated edits is one people regenerate instead of read.
//
// Every case here is a way the conversion could be wrong SILENTLY, which is the only way it
// matters: a recorded set that reads wrong does not throw, it reports phantom fixes and phantom
// regressions, and the reader's conclusion is that the check is broken rather than the record.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  recordedCountsFrom,
  zeroBaselineState,
} from '../do-work/run-check-source-files-against-declared-rules.mjs';

const recorded = (known) => JSON.stringify({ known_findings: known });

test('two findings in one file count as two, whatever lines they sit on', () => {
  const counts = recordedCountsFrom(recorded({ 'a-rule': ['packages/p/x.json:12', 'packages/p/x.json:3000'] }));
  assert.deepEqual(counts, { 'a-rule': { 'packages/p/x.json': 2 } });
});

test('a whole-file finding is a bare path and keeps its whole path', () => {
  // A finding with no line carries `line: null` and prints as the path alone. Splitting on the
  // last colon unconditionally would silently truncate any path containing one.
  const counts = recordedCountsFrom(recorded({ 'a-rule': ['packages/p/styles/look-20260711.css'] }));
  assert.deepEqual(counts, { 'a-rule': { 'packages/p/styles/look-20260711.css': 1 } });
});

test('a path containing a colon is not mistaken for a line number', () => {
  const counts = recordedCountsFrom(recorded({ 'a-rule': ['packages/p/weird:name.json'] }));
  assert.deepEqual(counts, { 'a-rule': { 'packages/p/weird:name.json': 1 } });
});

test('a path containing a colon AND a line still splits at the line', () => {
  const counts = recordedCountsFrom(recorded({ 'a-rule': ['packages/p/weird:name.json:41'] }));
  assert.deepEqual(counts, { 'a-rule': { 'packages/p/weird:name.json': 1 } });
});

test('a rule recorded with no findings survives as an empty entry', () => {
  // It must not vanish. An empty entry is a rule that has been looked at and found clean, and
  // deleting it makes that indistinguishable from a rule nobody ever recorded.
  assert.deepEqual(recordedCountsFrom(recorded({ 'a-rule': [] })), { 'a-rule': {} });
});

test('a STRING where an array belongs throws, because it would otherwise iterate by character', () => {
  // Not hypothetical. A one-sentence note was written under `known_findings` on 2026-09-05, and
  // every `for...of` reading it walks the sentence CHARACTER BY CHARACTER, turning one line of
  // prose into several hundred phantom entries reported as fixed findings.
  assert.throws(
    () => recordedCountsFrom(recorded({ 'a-rule': 'ten entries came out of this list' })),
    /must be an array/,
  );
});

test('a file with no known_findings at all is an empty record, not a crash', () => {
  assert.deepEqual(recordedCountsFrom('{}'), {});
});

test('zero-baseline rules reject both live violations and attempts to record them', () => {
  const rules = [{ id: 'ownership', baseline_policy: 'zero' }, { id: 'ordinary' }];
  const violations = [
    { rule_id: 'ownership', path: 'packages/p/source.ts', line: 1 },
    { rule_id: 'ordinary', path: 'packages/p/other.ts', line: 1 },
  ];
  assert.deepEqual(zeroBaselineState(rules, violations, {
    known_findings: { ownership: ['packages/p/source.ts:1'] },
  }), {
    rule_ids: ['ownership'],
    violations: [violations[0]],
    recorded: [{ rule_id: 'ownership', path: 'packages/p/source.ts:1', recorded: 1 }],
  });
});
