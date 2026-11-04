// tools/move-code-between-trees/read-data/imports.mjs
//
// The modules a source file asks for, where each one is, and how to say the same request from somewhere else. Pure
// text work: the caller reads files and hands in their text and a way to ask whether a path exists.
import { posix } from 'node:path';

const CODE = /\.(?:mjs|cjs|js|jsx|ts|tsx|mts|cts)$/;
export const isCode = path => CODE.test(path);

// Comments become spaces of the same length, so every match keeps its place in the original text. Strings and template
// text are left alone, so `// not a comment` inside a string survives.
function blankComments(text) {
  let out = '';
  for (let at = 0; at < text.length;) {
    const two = text.slice(at, at + 2);
    const quote = text[at];
    if (two === '//') { const end = text.indexOf('\n', at); const stop = end < 0 ? text.length : end; out += ' '.repeat(stop - at); at = stop; continue; }
    if (two === '/*') { const end = text.indexOf('*/', at + 2); const stop = end < 0 ? text.length : end + 2; out += text.slice(at, stop).replace(/[^\n]/g, ' '); at = stop; continue; }
    if (quote === '"' || quote === "'" || quote === '`') {
      let end = at + 1;
      while (end < text.length && text[end] !== quote) { if (text[end] === '\\') end += 1; else if (quote !== '`' && text[end] === '\n') break; end += 1; }
      out += text.slice(at, end + 1); at = end + 1; continue;
    }
    out += text[at]; at += 1;
  }
  return out;
}

// Every module request in the text, with where its specifier sits: static imports and re-exports, imports for effect,
// dynamic imports of a literal, require of a literal, and `new URL('<relative>', import.meta.url)`. Each is
// { specifier, start, end, how }, start and end bounding the specifier's characters inside its quotes.
export function requestsIn(text) {
  const code = blankComments(text);
  const found = [];
  const add = (match, how) => {
    const specifier = match.groups.spec;
    // No module name starts with a backslash: such a match is the text of a regular expression (/from '\.\.\/x'/).
    if (specifier.startsWith('\\')) return;
    // Nor with an open bracket: such a match is a regular expression built in text (`from '([^']+)'`).
    if (/^[(\[]/.test(specifier)) return;
    // Nor with a template placeholder: such a match is text a template fills at run time (from '${root}parts/x'), a
    // request of the page being built, not of this file.
    if (specifier.startsWith('${')) return;
    const start = match.index + match[0].lastIndexOf(specifier, match[0].length - 1);
    found.push({ specifier, start, end: start + specifier.length, how, whole: [match.index, match.index + match[0].length] });
  };
  for (const m of code.matchAll(/(?<![.\w$@])(?:import|export)\s+(?:type\s+)?[^'"`;()]*?\bfrom\s*(['"])(?<spec>[^'"\n]+)\1/g)) add(m, 'static');
  // An import for its effect starts a statement: the word import at the end of a string ('import' || x) is not one.
  for (const m of code.matchAll(/(?<=^|[;{}\n])[ \t]*import\s*(['"])(?<spec>[^'"\n]+)\1/g)) add(m, 'effect');
  for (const m of code.matchAll(/(?<![.\w$@])import\(\s*(['"`])(?<spec>[^'"`$\n]+)\1\s*[,)]/g)) add(m, 'dynamic');
  for (const m of code.matchAll(/(?<![.\w$@])require\(\s*(['"])(?<spec>[^'"\n]+)\1\s*\)/g)) add(m, 'require');
  for (const m of code.matchAll(/new\s+URL\(\s*(['"])(?<spec>\.{1,2}\/[^'"\n]+)\1\s*,\s*import\.meta\.url\s*\)/g)) add(m, 'url');
  const seen = new Set();
  return found.filter(item => { const key = `${item.start}`; if (seen.has(key)) return false; seen.add(key); return true; })
    .sort((a, b) => a.start - b.start);
}

export const isRelative = specifier => specifier.startsWith('./') || specifier.startsWith('../');

// The tree path a relative request names, trying the endings a bundler tries when none is written.
export function resolveRequest(fromPath, specifier, exists) {
  if (!isRelative(specifier)) return null;
  const bare = specifier.split(/[?#]/)[0];
  const base = posix.normalize(posix.join(posix.dirname(fromPath), bare));
  if (base.startsWith('../')) return null;
  const tries = [base, ...['.mjs', '.js', '.ts', '.tsx', '.jsx', '.json', '.cjs'].map(end => base + end),
    ...['index.mjs', 'index.js', 'index.ts', 'index.tsx'].map(name => posix.join(base, name))];
  if (/\.js$/.test(base)) tries.push(base.replace(/\.js$/, '.ts'), base.replace(/\.js$/, '.tsx'));
  return tries.find(path => exists(path)) ?? null;
}

// How a file at `fromPath` asks for the file at `toPath`, written the way the original request was written: when the
// original left out the ending (or wrote .js for a .ts file), so does the new one.
export function requestFor(fromPath, toPath, originalSpecifier, originalTarget) {
  let relative = posix.relative(posix.dirname(fromPath), toPath);
  if (!relative.startsWith('.')) relative = `./${relative}`;
  const writtenEnd = posix.extname(originalSpecifier.split(/[?#]/)[0]);
  const targetEnd = posix.extname(originalTarget);
  const suffix = originalSpecifier.slice(originalSpecifier.split(/[?#]/)[0].length);
  if (/\/index\.[a-z]+$/.test(originalTarget) && !/index(\.[a-z]+)?$/.test(originalSpecifier.split(/[?#]/)[0])) {
    return relative.replace(/\/index\.[a-z]+$/, '') + suffix;
  }
  if (writtenEnd === targetEnd) return relative + suffix;
  if (!writtenEnd || !['.mjs', '.js', '.ts', '.tsx', '.jsx', '.json', '.cjs'].includes(writtenEnd)) return relative.slice(0, -targetEnd.length) + suffix;
  return relative.slice(0, -targetEnd.length) + writtenEnd + suffix;
}

// The text with each listed specifier replaced: [{ start, end, specifier }]. Every other byte stays.
export function replaceRequests(text, changes) {
  let out = '';
  let at = 0;
  for (const change of [...changes].sort((a, b) => a.start - b.start)) {
    out += text.slice(at, change.start) + change.specifier;
    at = change.end;
  }
  return out + text.slice(at);
}

// A tree's own import names (`imports` in its package.json, such as `#name` or `#folder/*`): the path each names.
export function aliasesOf(manifest) {
  const map = Object.entries(manifest?.imports ?? {}).map(([key, value]) => [key, typeof value === 'string' ? value : value?.import ?? value?.default]).filter(([, value]) => typeof value === 'string');
  return specifier => {
    if (!specifier.startsWith('#')) return null;
    for (const [key, value] of map) {
      if (!key.includes('*')) { if (key === specifier) return posix.normalize(value); continue; }
      const [head, tail] = key.split('*');
      if (specifier.startsWith(head) && specifier.endsWith(tail) && specifier.length >= head.length + tail.length) {
        return posix.normalize(value.replace('*', specifier.slice(head.length, specifier.length - tail.length)));
      }
    }
    return null;
  };
}

// The tree path a request names: a relative path, or one of the tree's own import names.
export function targetOf(fromPath, specifier, exists, alias) {
  if (isRelative(specifier)) return resolveRequest(fromPath, specifier, exists);
  const named = alias?.(specifier);
  if (!named) return null;
  return resolveRequest('_', `./${named}`, exists);
}
