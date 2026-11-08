// test/service-work-counts.mjs
//
// Purpose: counts, per source file, the calls that send Trillion-wide work into one person's store (the shapes in
// test/service-work-shapes.json), for test/no-service-work-in-person-store.test.mjs. Comments are not counted.
// Reading runs no code.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import shapes from './service-work-shapes.json' with { type: 'json' };
import { maintainedServiceSources } from './service-work-sources.mjs';

// A whole comment line, or a comment after code that follows whitespace; text inside strings is left as it is.
const withoutComments = text => text.split('\n').map(line => (/^\s*(?:\/\/|\/\*|\*)/.test(line) ? '' : line.replace(/\s\/\/\s.*$/, ''))).join('\n');

/** Each file's count of matches, for files holding any; `only` (pattern ids) counts those shapes alone. */
export function serviceWorkCounts(cwd, { only = null } = {}) {
  if (cwd === undefined) return serviceWorkCountsFromSources(maintainedServiceSources(), { only });
  let listed;
  try { listed = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '--', ...shapes.folders], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }).split('\n'); }
  catch { listed = shapes.folders.filter(folder => existsSync(`${cwd}/${folder}`)).flatMap(folder => readdirSync(`${cwd}/${folder}`, { recursive: true }).map(path => `${folder}/${path}`)).filter(path => !path.includes('node_modules/')); }
  const files = listed.filter(Boolean).filter(file => !/\.test\./.test(file));
  if (!files.length) throw new Error('The service-work source scope is empty or unavailable');
  return serviceWorkCountsFromSources(files.map(file => ({ path: file, key: file, text: readFileSync(`${cwd}/${file}`, 'utf8') })), { only });
}

/** The same eight shapes and original language domains over qualified source records. */
export function serviceWorkCountsFromSources(sources, { only = null } = {}) {
  if (!Array.isArray(sources) || !sources.length) throw new Error('The service-work source scope is empty or unavailable');
  const reads = (shape, file) => (shape.extensions ?? shapes.extensions).some(extension => file.endsWith(extension));
  const counts = {};
  for (const source of sources) {
    if (typeof source.path !== 'string' || typeof source.text !== 'string') throw new Error('A service-work source could not be read');
    const file = source.key ?? source.path;
    if (!shapes.patterns.some(shape => reads(shape, source.path) && (!only || only.includes(shape.id)))) continue;
    const text = withoutComments(source.text);
    let count = 0;
    for (const shape of shapes.patterns) {
      if (!reads(shape, source.path) || (only && !only.includes(shape.id))) continue;
      const except = shape.except_line ? new RegExp(shape.except_line) : null;
      for (const match of text.matchAll(new RegExp(shape.pattern, 'g'))) {
        const line = text.slice(text.lastIndexOf('\n', match.index) + 1, text.indexOf('\n', match.index) >>> 0 || undefined);
        if (except?.test(line)) continue;
        count += 1;
      }
    }
    if (count) counts[file] = (counts[file] ?? 0) + count;
  }
  return counts;
}
