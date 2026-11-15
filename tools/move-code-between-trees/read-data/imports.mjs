// tools/move-code-between-trees/read-data/imports.mjs
//
// The modules a source file asks for, where each one is, and how to say the same request from somewhere else. Pure
// text work: the caller reads files and hands in their text and a way to ask whether a path exists.
import { posix } from 'node:path';
import { parse } from '@babel/parser';

const CODE = /\.(?:mjs|cjs|js|jsx|ts|tsx|mts|cts)$/;
export const isCode = path => CODE.test(path);

// Every module request in the text, with where its specifier sits: static imports and re-exports, imports for effect,
// dynamic imports of a literal, require of a literal, and `new URL('<relative>', import.meta.url)`. Each is
// { specifier, start, end, how }, start and end bounding the specifier's characters inside its quotes.
// Babel owns source syntax and offsets: text in a comment, string, template quasi or regular expression is never
// executable import syntax. Template expressions are executable and remain traversed. The parser accepts the same
// JS/TS/JSX families as isCode; a valid TypeScript angle assertion uses its non-JSX grammar. Invalid source throws,
// rather than silently presenting an unparsed file as having no requests.
export function requestsIn(text) {
  const options = { sourceType: 'unambiguous', allowAwaitOutsideFunction: true, allowReturnOutsideFunction: true,
    createImportExpressions: true, plugins: ['typescript', 'jsx', 'decorators-legacy', 'deprecatedImportAssert'] };
  let ast;
  try { ast = parse(text, options); }
  catch (error) {
    try { ast = parse(text, { ...options, plugins: options.plugins.filter(plugin => plugin !== 'jsx') }); }
    catch { throw error; }
  }
  const found = [];
  const literal = node => node?.type === 'StringLiteral' ? node.value
    : node?.type === 'TemplateLiteral' && node.expressions.length === 0 ? node.quasis[0].value.cooked : null;
  const add = (node, value, how) => {
    const specifier = literal(value);
    if (typeof specifier !== 'string') return;
    // Nor with a template placeholder: such a match is text a template fills at run time (from '${root}parts/x'), a
    // request of the page being built, not of this file.
    if (specifier.startsWith('${')) return;
    found.push({ specifier, start: value.start + 1, end: value.end - 1, how, whole: [node.start, node.end] });
  };
  const metaUrl = node => node?.type === 'MemberExpression' && !node.computed && node.property?.name === 'url'
    && node.object?.type === 'MetaProperty' && node.object.meta?.name === 'import' && node.object.property?.name === 'meta';
  const pending = [ast.program];
  while (pending.length) {
    const node = pending.pop();
    if (!node || typeof node !== 'object') continue;
    if (node.type === 'ImportDeclaration') add(node, node.source, node.specifiers.length ? 'static' : 'effect');
    else if (node.type === 'ExportNamedDeclaration' || node.type === 'ExportAllDeclaration') add(node, node.source, 'static');
    else if (node.type === 'ImportExpression') add(node, node.source, 'dynamic');
    else if ((node.type === 'CallExpression' || node.type === 'OptionalCallExpression')
      && node.callee?.type === 'Identifier' && node.callee.name === 'require' && node.arguments.length === 1) add(node, node.arguments[0], 'require');
    else if (node.type === 'TSExternalModuleReference') add(node, node.expression, 'require');
    else if (node.type === 'TSImportType') add(node, node.argument, 'dynamic');
    else if (node.type === 'NewExpression' && node.callee?.type === 'Identifier' && node.callee.name === 'URL'
      && node.arguments.length === 2 && metaUrl(node.arguments[1]) && isRelative(literal(node.arguments[0]) ?? '')) add(node, node.arguments[0], 'url');
    for (const [key, value] of Object.entries(node)) {
      if (['loc', 'extra', 'comments', 'leadingComments', 'trailingComments', 'innerComments'].includes(key)) continue;
      if (Array.isArray(value)) pending.push(...value);
      else if (value && typeof value === 'object') pending.push(value);
    }
  }
  return found.sort((a, b) => a.start - b.start);
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
