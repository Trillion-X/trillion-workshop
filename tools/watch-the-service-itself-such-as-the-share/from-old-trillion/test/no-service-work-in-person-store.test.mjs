// test/no-service-work-in-person-store.test.mjs
//
// Purpose: Trillion-wide work (work no signed-in person owns: everyone's rules and setup records, payment and event
// signatures, service secrets and OAuth clients, the service relay, client health) belongs to its own addressed owner
// (the service record book, a native resource, the native credential issuer), never to one person's store. On
// 2026-10-14 the operator account's store answered all of it for every account and refused writes for days. This guard
// counts, by shape (test/service-work-shapes.json), every call that reaches the operator's PersonStore.
//
// Non-negotiable invariants
//   1. Every file's count must equal its row in test/service-work-allowance.json: a new file or a higher count fails,
//      and a lower count fails until the allowance is lowered with it, so the allowance is always today's truth.
//   2. The allowance only shrinks: every file and count must be within the allowance as it was first recorded (read
//      from git history when the history is there), so no change can add service work by raising it. When the shapes
//      widen (an indirect form found later), the first allowance recorded with the wider shapes becomes their baseline,
//      and every earlier baseline still bounds the counts of its own shapes.
//   5. Shapes are only added: each shape as first recorded is still read exactly as it was, over at least the folders
//      first read, and the allowance names the shapes it was measured with.
//   3. Every row names the duties it still holds; a row that may stay says why (`allowed_because`).
//   4. Reading runs no code from the files it reads.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation, or from loosening the rule it states.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { serviceWorkCounts } from './service-work-counts.mjs';

const root = new URL('..', import.meta.url).pathname;
const ALLOWANCE = 'test/service-work-allowance.json';
const allowance = () => JSON.parse(readFileSync(`${root}/${ALLOWANCE}`, 'utf8')).files;

// The shapes the first allowance was measured with, before allowances named them.
const FIRST_PATTERNS = ['operator-store', 'operator-person-get', 'operator-person-for'];
const SHAPES = 'test/service-work-shapes.json';
const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const patternsOf = recorded => recorded.patterns ?? FIRST_PATTERNS;
// The first allowance recorded with each set of shapes (oldest commit first): every one keeps binding the counts of its
// own shapes, so widening the measurement starts a baseline for the new shapes and never frees the old ones.
const recordedBaselines = () => {
  try {
    const baselines = new Map();
    for (const commit of git(['log', '--reverse', '--format=%H', '--', ALLOWANCE]).trim().split('\n').filter(Boolean)) {
      const recorded = JSON.parse(git(['show', `${commit}:${ALLOWANCE}`]));
      const key = JSON.stringify(patternsOf(recorded));
      if (!baselines.has(key)) baselines.set(key, { patterns: patternsOf(recorded), files: recorded.files });
    }
    return [...baselines.values()];
  } catch { return []; }
};
// The shapes as first recorded: every one of them must still be read exactly as it was, so a measurement only widens.
const firstShapes = () => {
  try {
    const added = git(['log', '--diff-filter=A', '--format=%H', '--', SHAPES]).trim().split('\n').filter(Boolean).at(-1);
    return added ? JSON.parse(git(['show', `${added}:${SHAPES}`])) : null;
  } catch { return null; }
};
const firstRecordedShapes = () => firstShapes()?.patterns ?? null;
const firstRecordedFolders = () => firstShapes()?.folders ?? null;

test('no call sends Trillion-wide work into a person\'s store beyond the shrinking allowance', () => {
  const may = allowance();
  const counts = serviceWorkCounts();
  const grown = Object.entries(counts).filter(([file, count]) => count > (may[file]?.count ?? 0)).map(([file, count]) => `${file}: ${count} > allowed ${may[file]?.count ?? 0}`);
  const stale = Object.entries(may).filter(([file, row]) => (counts[file] ?? 0) < row.count).map(([file, row]) => `${file}: now ${counts[file] ?? 0}, lower the allowance from ${row.count}`);
  assert.deepEqual(grown, [], 'Service-wide work belongs to its own addressed owner (the service record book, a native resource), not a person\'s store');
  assert.deepEqual(stale, [], 'Lower test/service-work-allowance.json with every duty moved, so the allowance stays today\'s truth');
});

test('every row names its duties, and only a row that says why may stay', () => {
  for (const [file, row] of Object.entries(allowance())) {
    assert.ok(Array.isArray(row.duties) && row.duties.length && row.duties.every(duty => typeof duty === 'string' && duty.length > 10), `${file}: name the duties it still holds`);
    if ('allowed_because' in row) assert.ok(typeof row.allowed_because === 'string' && row.allowed_because.length > 20, `${file}: say why it may stay`);
  }
});

test('the allowance names the shapes it was measured with, and the shapes only widen', () => {
  const shapes = JSON.parse(readFileSync(`${root}/${SHAPES}`, 'utf8')).patterns;
  assert.deepEqual(JSON.parse(readFileSync(`${root}/${ALLOWANCE}`, 'utf8')).patterns, shapes.map(shape => shape.id), 'name every shape the counts were read with');
  const first = firstRecordedShapes();
  if (!first) return;
  const now = new Map(shapes.map(shape => [shape.id, JSON.stringify(shape)]));
  assert.deepEqual(first.filter(shape => now.get(shape.id) !== JSON.stringify(shape)).map(shape => shape.id), [], 'a shape once read is never removed or narrowed');
  const folders = JSON.parse(readFileSync(`${root}/${SHAPES}`, 'utf8')).folders;
  assert.deepEqual((firstRecordedFolders() ?? []).filter(folder => !folders.includes(folder)), [], 'a folder once read is always read');
});

test('the allowance only shrinks from what was first recorded', () => {
  // Each baseline bounds the counts of the shapes it was measured with; today's allowance never exceeds its own first one.
  const raised = [];
  for (const baseline of recordedBaselines()) {
    for (const [file, count] of Object.entries(serviceWorkCounts(root, { only: baseline.patterns }))) {
      if (count > (baseline.files[file]?.count ?? 0)) raised.push(`${file}: ${count} by ${baseline.patterns.join(', ')} exceeds first recorded ${baseline.files[file]?.count ?? 'nothing'}`);
    }
  }
  const today = JSON.stringify(JSON.parse(readFileSync(`${root}/${ALLOWANCE}`, 'utf8')).patterns ?? FIRST_PATTERNS);
  const own = recordedBaselines().find(baseline => JSON.stringify(baseline.patterns) === today);
  if (own) for (const [file, row] of Object.entries(allowance())) if (!own.files[file] || row.count > own.files[file].count) raised.push(`${file}: ${row.count} exceeds first recorded ${own.files[file]?.count ?? 'nothing'}`);
  assert.deepEqual(raised, []);
});
