import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  agreementReport,
  mirrorsBehind,
  mirrorsMissingMarkers,
  newestUnit,
  readMirrorSet,
  unitsIn,
} from '../do-work/check-documents-agree-with-their-source.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** A texts map becomes the reader the engine takes, so no test touches a disk. */
const reader = (texts) => (document) => texts[document] ?? '';

// ─────────────────────────── finding units ───────────────────────────

test('a text with no unit yields none, and that is not an error', () => {
  assert.deepEqual(unitsIn('nothing here', 'N(\\d{3})'), []);
  assert.equal(newestUnit('nothing here', 'N(\\d{3})'), null);
});

test('the newest unit is the numerically largest, not the last written', () => {
  // The whole reason the capture group exists. String ordering would call N99 the newest of these
  // and the check would then pass forever while every mirror sat behind.
  const text = 'N218 appears first, then N217, then N099';
  assert.equal(newestUnit(text, 'N(\\d{3})').raw, 'N218');
});

test('a three-digit pattern cannot see a four-digit unit, which is a real future trap', () => {
  // Recorded rather than fixed: the pattern in use is exactly three digits, so N1000 will
  // be invisible to it. The engine does what the descriptor says; the descriptor is where this gets
  // widened, and it costs a DATA edit rather than a source edit.
  assert.equal(newestUnit('N1000 is here', 'N(\\d{3})').raw, 'N100');
});

test('a pattern with no capture falls back to the last match, and says so by ordering', () => {
  const found = newestUnit('alpha beta gamma', '[a-z]+');
  assert.equal(found.raw, 'gamma');
});

test('a pattern that can match empty does not hang', () => {
  // A caller's over-permissive pattern is not a reason to refuse to report anything, but a
  // zero-length match with the global flag spins forever if it is not advanced past.
  const found = unitsIn('abc', 'x*');
  assert.ok(Array.isArray(found));
});

// ─────────────────────────── refusals ───────────────────────────

test('a set naming no mirrors is refused, because it would report clean over nothing', () => {
  assert.throws(
    () => readMirrorSet({ source: 'a.md', mirrors: [], unit_pattern: 'N(\\d{3})' }),
    /names no mirrors/,
  );
});

test('a set naming no source is refused', () => {
  assert.throws(() => readMirrorSet({ mirrors: [{ document: 'b.md' }] }), /must name its source/);
});

test('a set with no unit pattern is refused, since nothing would identify a unit', () => {
  assert.throws(
    () => readMirrorSet({ source: 'a.md', mirrors: [{ document: 'b.md' }] }),
    /declares no unit_pattern/,
  );
});

test('a mirror entry with no document is refused', () => {
  assert.throws(
    () => readMirrorSet({ source: 'a.md', mirrors: [{}], unit_pattern: 'N(\\d{3})' }),
    /names no document/,
  );
});

// ─────────────────────────── falling behind ───────────────────────────

test('a mirror carrying the newest unit is not behind, even though it is far shorter', () => {
  // Constraint 6 of the plan, asserted: being a summary is the mirror's PURPOSE. A check demanding
  // the mirror carry every unit is the obvious implementation and is wrong.
  const set = readMirrorSet({
    source: 'source.md',
    mirrors: [{ document: 'summary.md' }],
    unit_pattern: 'N(\\d{3})',
  });
  const texts = { 'source.md': 'N001 N002 N003 N218 with long prose', 'summary.md': 'only N218' };
  const result = mirrorsBehind(set, reader(texts));
  assert.equal(result.newest, 'N218');
  assert.deepEqual(result.behind, []);
});

test('a mirror missing the newest unit is reported with what it is missing', () => {
  const set = readMirrorSet({
    source: 'source.md',
    mirrors: [{ document: 'stale.md' }],
    unit_pattern: 'N(\\d{3})',
  });
  const texts = { 'source.md': 'N217 N218', 'stale.md': 'N217 only' };
  const result = mirrorsBehind(set, reader(texts));
  assert.equal(result.behind.length, 1);
  assert.equal(result.behind[0].document, 'stale.md');
  assert.equal(result.behind[0].missing, 'N218');
  assert.equal(result.behind[0].carries, 1);
});

test('a source carrying no unit blames the source, never every mirror', () => {
  const set = readMirrorSet({
    source: 'empty.md',
    mirrors: [{ document: 'a.md' }, { document: 'b.md' }],
    unit_pattern: 'N(\\d{3})',
  });
  const result = mirrorsBehind(set, reader({ 'empty.md': 'no units', 'a.md': 'N218' }));
  assert.equal(result.sourceCarriesNoUnit, true);
  assert.deepEqual(result.behind, []);
});

// ─────────────────────────── markers ───────────────────────────

test('a required marker missing from one mirror is reported for that mirror only', () => {
  const set = readMirrorSet({
    source: 'source.md',
    mirrors: [{ document: 'has.md' }, { document: 'lacks.md' }],
    unit_pattern: 'N(\\d{3})',
    required_markers: ['SYNC CONTRACT'],
  });
  const texts = { 'has.md': 'SYNC CONTRACT here', 'lacks.md': 'nothing' };
  const missing = mirrorsMissingMarkers(set, reader(texts));
  assert.equal(missing.length, 1);
  assert.equal(missing[0].document, 'lacks.md');
  assert.equal(missing[0].marker, 'SYNC CONTRACT');
});

test('a mirror may override the set markers, so a marker can be required of some and not all', () => {
  // This is what lets a real set can demand the sync contract of its canonical files
  // while sparing the two identity anchors, without the engine knowing which is which.
  const set = readMirrorSet({
    source: 'source.md',
    mirrors: [
      { document: 'canonical.md' },
      { document: 'anchor.md', required_markers: [] },
    ],
    unit_pattern: 'N(\\d{3})',
    required_markers: ['SYNC CONTRACT'],
  });
  const missing = mirrorsMissingMarkers(set, reader({ 'canonical.md': '', 'anchor.md': '' }));
  assert.equal(missing.length, 1);
  assert.equal(missing[0].document, 'canonical.md');
});

test('an empty required list spares everything rather than failing everything', () => {
  const set = readMirrorSet({
    source: 'source.md',
    mirrors: [{ document: 'a.md' }],
    unit_pattern: 'N(\\d{3})',
  });
  assert.deepEqual(mirrorsMissingMarkers(set, reader({ 'a.md': '' })), []);
});

// ─────────────────────────── the whole report ───────────────────────────

test('the report is structured, so it says WHAT rather than THAT', () => {
  const report = agreementReport(
    {
      source: 'source.md',
      mirrors: [{ document: 'ok.md' }, { document: 'stale.md' }],
      unit_pattern: 'N(\\d{3})',
      required_markers: ['MARK'],
    },
    reader({ 'source.md': 'N218 MARK', 'ok.md': 'N218 MARK', 'stale.md': 'N217' }),
  );
  assert.equal(report.agrees, false);
  assert.equal(report.newest_unit, 'N218');
  assert.equal(report.behind[0].document, 'stale.md');
  assert.equal(report.missing_markers[0].document, 'stale.md');
});

test('a set that agrees says so', () => {
  const report = agreementReport(
    { source: 's.md', mirrors: [{ document: 'm.md' }], unit_pattern: 'N(\\d{3})' },
    reader({ 's.md': 'N218', 'm.md': 'N218' }),
  );
  assert.equal(report.agrees, true);
});

// ─────────────────── the same engine, a radically different subject ───────────────────

test('a completely different mirror set runs through the same functions with no branch', () => {
  // The generalisation test from the plan, executed rather than asserted in prose: translated
  // documentation lagging an original, with a different id shape and a different marker. If any
  // domain assumption had leaked into the engine, this is where it would surface.
  const report = agreementReport(
    {
      source: 'guide.en.md',
      mirrors: [{ document: 'guide.fr.md' }, { document: 'guide.ja.md' }],
      unit_pattern: 'RFC-(\\d+)',
      required_markers: ['TRANSLATION STATUS'],
    },
    reader({
      'guide.en.md': 'RFC-7 RFC-42 covered',
      'guide.fr.md': 'RFC-42 TRANSLATION STATUS: current',
      'guide.ja.md': 'RFC-7 TRANSLATION STATUS: current',
    }),
  );
  assert.equal(report.newest_unit, 'RFC-42');
  assert.equal(report.behind.length, 1);
  assert.equal(report.behind[0].document, 'guide.ja.md');
  assert.deepEqual(report.missing_markers, []);
});

test('the engine names no word from the domain that motivated it', () => {
  // The BUDAG test, executed. If any of these appears in the engine, the flow got welded into the
  // mechanism and the package serves one customer instead of every customer.
  const engine = readFileSync(
    path.join(HERE, '../do-work/check-documents-agree-with-their-source.mjs'),
    'utf8',
  );
  for (const word of [
    'lesson',
    'AGENTS',
    'CLAUDE',
    'orchestra',
    'slim',
    'memory-lessons',
    'N217',
    'N218',
  ]) {
    assert.ok(
      !engine.includes(word),
      `the engine names "${word}", so the first configuration leaked into the mechanism`,
    );
  }
});
