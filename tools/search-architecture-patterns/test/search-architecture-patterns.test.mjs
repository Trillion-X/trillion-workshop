import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const tool = join(dirname(fileURLToPath(import.meta.url)), '..');
// The reference is not stored in this repository: point ARCHITECTURE_REFERENCE_PATH at its copy to run these checks.
const reference = process.env.ARCHITECTURE_REFERENCE_PATH ?? '';
const referenceReady = reference !== '' && existsSync(reference);

function search(query, referencePath = reference) {
  const stdout = execFileSync('python3', ['-I', join(tool, 'main.py'), query], {
    env: { ...process.env, ARCHITECTURE_REFERENCE_PATH: referencePath },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return JSON.parse(stdout);
}

test('index lists every numbered pattern once, in order', { skip: !referenceReady && 'reference file not present' }, () => {
  const out = search('index');
  assert.equal(out.total, out.patterns.length);
  assert.ok(out.total >= 105, `expected at least 105 patterns, got ${out.total}`);
  assert.deepEqual(out.patterns.map(p => p.number), Array.from({ length: out.total }, (_, i) => i + 1));
});

test('#1 returns the complete original Structured Error Taxonomy pattern', { skip: !referenceReady && 'reference file not present' }, () => {
  const out = search('#1');
  assert.equal(out.patterns.length, 1);
  assert.equal(out.patterns[0].number, 1);
  assert.match(out.patterns[0].title, /Structured Error Taxonomy/);
});

test('#N returns the pattern with that number', { skip: !referenceReady && 'reference file not present' }, () => {
  const out = search('#105');
  assert.equal(out.patterns.length, 1);
  assert.equal(out.patterns[0].number, 105);
  assert.ok(out.patterns[0].title.length > 0);
});

test('a task phrase ranks the matching pattern first and returns at most eight', { skip: !referenceReady && 'reference file not present' }, () => {
  const out = search('structured error taxonomy');
  assert.ok(out.patterns.length >= 1 && out.patterns.length <= 8);
  assert.equal(out.patterns[0].number, 1);
});

test('a reference whose numbers have a gap is refused, not searched', () => {
  const dir = mkdtempSync(join(tmpdir(), 'arch-patterns-'));
  try {
    const gapped = join(dir, 'reference.md');
    writeFileSync(gapped, [
      '### Pattern 1: First',
      '**What it solves:** One thing.',
      '### Pattern 3: Third',
      '**What it solves:** Another thing.',
      '',
    ].join('\n'));
    assert.throws(() => search('index', gapped), /number its patterns 1 through N exactly once/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
