// test/service-work-counts.mjs
//
// Purpose: counts, per source file, the calls that send Trillion-wide work into one person's store (the shapes in
// test/service-work-shapes.json), for test/no-service-work-in-person-store.test.mjs. Comments are not counted.
// Reading runs no code.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import shapes from './service-work-shapes.json' with { type: 'json' };

// A whole comment line, or a comment after code that follows whitespace; text inside strings is left as it is.
const withoutComments = text => text.split('\n').map(line => (/^\s*(?:\/\/|\/\*|\*)/.test(line) ? '' : line.replace(/\s\/\/\s.*$/, ''))).join('\n');

/** Each file's count of matches, for files holding any; `only` (pattern ids) counts those shapes alone. */
export function serviceWorkCounts(cwd = new URL('..', import.meta.url).pathname, { only = null } = {}) {
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '--', ...shapes.folders], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\n').filter(Boolean).filter(file => !/\.test\./.test(file));
  const reads = (shape, file) => (shape.extensions ?? shapes.extensions).some(extension => file.endsWith(extension));
  const counts = {};
  for (const file of files) {
    if (!shapes.patterns.some(shape => reads(shape, file) && (!only || only.includes(shape.id)))) continue;
    let text;
    try { text = withoutComments(readFileSync(`${cwd}/${file}`, 'utf8')); } catch { continue; }
    let count = 0;
    for (const shape of shapes.patterns) {
      if (!reads(shape, file) || (only && !only.includes(shape.id))) continue;
      const except = shape.except_line ? new RegExp(shape.except_line) : null;
      for (const match of text.matchAll(new RegExp(shape.pattern, 'g'))) {
        const line = text.slice(text.lastIndexOf('\n', match.index) + 1, text.indexOf('\n', match.index) >>> 0 || undefined);
        if (except?.test(line)) continue;
        count += 1;
      }
    }
    if (count) counts[file] = count;
  }
  return counts;
}
