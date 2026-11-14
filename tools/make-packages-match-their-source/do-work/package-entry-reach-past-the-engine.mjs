// packages/make-packages-match-their-source/do-work/package-entry-reach-past-the-engine.mjs
//
// PURPOSE:
//   The border. A package module that reaches past the engine, for a file, a clock, entropy,
//   a process, the network or the environment, creates state or non-determinism the log does
//   not know about, and replay stops reproducing it. This plugin makes such a reach a BUILD
//   FAILURE in package-authored source, unless the package's own manifest declares that it
//   owns that reach. Nothing else in the corpus needs to know the rule exists: a bundle that
//   was built has already passed it.
//
// NON-NEGOTIABLE INVARIANTS:
//   - This file names no builtin, no reach class and no package. What a reach IS lives in
//     `package-entry-reach-classes.json` at the set root; WHO owns one lives in that package's
//     `things-to-store-and-run.json`. Adding a class is a row; owning one is a record.
//   - Judged at the bundle, never at the file list. A reach inlined from a sibling package
//     ships identically, so a sibling's file is judged against the SIBLING's own declaration.
//   - Syntax-aware. Strings and comments are blanked before any global is matched, so prose
//     naming `Date.now()` is not a finding and code calling it is.
//   - Refusal is loud and exact: package, file, line, class, evidence, and the two ways out.
//   - Third-party dependencies under `node_modules` are not read. Their reach is bounded by the
//     specifier list: a package cannot import `axios` any more than it can import `node:http`.
//
// KEY CONCEPTS:
//   reach class      a named category of reaching past the engine, DATA
//   declaration      a manifest record whose kind is the file's `declaration_kind` and whose
//                    `declaration_class_field` names one class; scoped to that package and class
//   package-authored any file under `<set>/packages/<name>/` with no `node_modules` segment
import { readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import path from 'node:path';

export const reachClassesFileName = 'package-entry-reach-classes.json';

/** Read the DATA file that says what a reach is. Throws when absent: a set with no reach
 *  classes is a set where every bundle ships every reach, and that must not look like a
 *  clean build. */
export async function readReachClasses(packageSetRoot) {
  const file = path.join(packageSetRoot, reachClassesFileName);
  const parsed = JSON.parse(await readFile(file, 'utf8'));
  if (!Array.isArray(parsed?.reach_classes) || typeof parsed.declaration_kind !== 'string'
    || typeof parsed.declaration_class_field !== 'string') {
    throw new Error(`${file} must declare reach_classes, declaration_kind and declaration_class_field`);
  }
  for (const reachClass of parsed.reach_classes) {
    if (typeof reachClass?.reach_class !== 'string' || reachClass.reach_class === '') {
      throw new Error(`${file}: every reach class needs a non-empty reach_class`);
    }
    for (const { identifier, uses } of reachClass.globals ?? []) {
      for (const use of uses ?? []) {
        // A use must be a shape an English word cannot take: something after the token. A bare
        // `{token}` matched the word "fetch" inside customer copy and cost a lane a copy edit.
        if (use.replace('{token}', '').trim() === '') {
          throw new Error(`${file}: reach class ${reachClass.reach_class} uses a bare "${identifier}"; a global reach is a call or a construct, write "{token}\\\\s*\\\\(" or "new\\\\s+{token}\\\\s*\\\\("`);
        }
      }
    }
  }
  return parsed;
}

/** The classes one package declares it owns, from its manifest text. */
export function declaredReachClasses(packageData, reachClasses) {
  const declared = new Set();
  for (const thing of packageData?.things ?? []) {
    const payload = thing?.payload;
    if (payload?.kind !== reachClasses.declaration_kind) continue;
    const reachClass = payload[reachClasses.declaration_class_field];
    if (typeof reachClass !== 'string' || reachClass === '') {
      throw new Error(`${packageData.package}: a ${reachClasses.declaration_kind} record must name one ${reachClasses.declaration_class_field}`);
    }
    if (!reachClasses.reach_classes.some((candidate) => candidate.reach_class === reachClass)) {
      throw new Error(`${packageData.package}: declares ${reachClasses.declaration_class_field} "${reachClass}", which ${reachClassesFileName} does not define`);
    }
    declared.add(reachClass);
  }
  return declared;
}

/** Blank strings and comments to spaces, keeping every newline, so a match index still maps
 *  to a line and a reach named in prose is never a finding. Template literals keep their
 *  `${ ... }` expressions as code, because `${Date.now()}` is a call.
 *
 *  JSX TEXT IS NOT BLANKED, on purpose, and that is why no class row may use a bare `{token}`.
 *  Found 2026-09-05: the sentence "any browser fetch path" in a surface's empty state was refused
 *  as a network reach and the lane reworded customer copy to get past the build. Telling JSX
 *  text from a comparison operand needs a parser, and a heuristic on `>` misreads `a > b`. The
 *  structural answer is in the DATA: a reach is a CALL or a CONSTRUCT (`fetch(`, `new WebSocket(`,
 *  `Date.now(`), and an English word is never followed by `(`. `readReachClasses` refuses a
 *  bare-token use so the trap cannot be re-armed by a row. */
export function codeOnly(source) {
  const out = source.split('');
  const blank = (from, to) => {
    for (let index = from; index < to; index += 1) if (out[index] !== '\n') out[index] = ' ';
  };
  const length = source.length;
  let index = 0;
  // Template nesting: each entry is the brace depth at which the enclosing template resumes.
  const templateResume = [];
  let braceDepth = 0;
  const skipTemplate = (start) => {
    // Called at the opening backtick. Blank until the closing backtick, but re-enter code at
    // `${`, remembering the depth so the matching `}` returns to blanking.
    let cursor = start + 1;
    while (cursor < length) {
      const char = source[cursor];
      if (char === '\\') { cursor += 2; continue; }
      if (char === '`') { blank(start, cursor + 1); return cursor + 1; }
      if (char === '$' && source[cursor + 1] === '{') {
        blank(start, cursor + 2);
        templateResume.push(braceDepth);
        braceDepth += 1;
        return cursor + 2;
      }
      cursor += 1;
    }
    blank(start, length);
    return length;
  };
  while (index < length) {
    const char = source[index];
    const next = source[index + 1];
    if (char === '/' && next === '/') {
      let end = source.indexOf('\n', index);
      if (end === -1) end = length;
      blank(index, end);
      index = end;
      continue;
    }
    if (char === '/' && next === '*') {
      let end = source.indexOf('*/', index + 2);
      end = end === -1 ? length : end + 2;
      blank(index, end);
      index = end;
      continue;
    }
    if (char === '"' || char === "'") {
      let cursor = index + 1;
      while (cursor < length && source[cursor] !== char && source[cursor] !== '\n') {
        if (source[cursor] === '\\') cursor += 1;
        cursor += 1;
      }
      blank(index, Math.min(cursor + 1, length));
      index = cursor + 1;
      continue;
    }
    if (char === '`') {
      index = skipTemplate(index);
      continue;
    }
    if (char === '{') { braceDepth += 1; index += 1; continue; }
    if (char === '}') {
      braceDepth -= 1;
      if (templateResume.length > 0 && templateResume[templateResume.length - 1] === braceDepth) {
        templateResume.pop();
        // Back inside the template literal: blank from here to its end or next `${`.
        index = skipTemplate(index) ;
        continue;
      }
      index += 1;
      continue;
    }
    index += 1;
  }
  return out.join('');
}

function lineOf(text, index) {
  let line = 1;
  for (let cursor = 0; cursor < index; cursor += 1) if (text[cursor] === '\n') line += 1;
  return line;
}

// A global is matched only where it is a free identifier: not a property (`foo.fetch`),
// not the tail of a longer name (`refetch`), not an optional-chain member (`x?.fetch`),
// not an object-literal key (`{ fetch: ... }`), not a declared binding
// (`const fetch =`, `function fetch(`, `import { fetch }`), which is code shadowing the
// global on purpose and reaching nowhere.
const FREE_IDENTIFIER_BEHIND = '(?<![\\w$.])(?<!\\b(?:const|let|var|function|class)\\s+)';
const FREE_IDENTIFIER_AHEAD = '(?![\\w$])(?!\\s*:(?!:))';

function globalUsePattern(identifier, use) {
  const token = `${FREE_IDENTIFIER_BEHIND}${identifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}${FREE_IDENTIFIER_AHEAD}`;
  return new RegExp(use.split('{token}').join(token), 'g');
}

/** Import statements naming a specifier: the local names they bind. Handles
 *  `import x from`, `import * as x from`, `import { a, b as c } from`, and
 *  `const x = require(...)` / `const { a } = require(...)`. */
function importsOf(source, code, specifierPattern) {
  const spec = new RegExp(specifierPattern);
  const bindings = { locals: new Set(), named: new Set() };
  // Scanned on the ORIGINAL text, because the specifier is a string and blanking erased it;
  // kept only where the keyword survives blanking, so an import inside a comment is prose.
  const statements = source.matchAll(/\bimport\s+([^;]*?)\s+from\s+(['"])([^'"]+)\2|\b(?:const|let|var)\s+([^=;]+?)\s*=\s*require\s*\(\s*(['"])([^'"]+)\5\s*\)/g);
  for (const statement of statements) {
    if (code[statement.index] === ' ') continue;
    const clause = statement[1] ?? statement[4];
    const specifier = statement[3] ?? statement[6];
    if (!spec.test(specifier)) continue;
    const braces = clause.match(/\{([^}]*)\}/);
    if (braces) {
      for (const piece of braces[1].split(',')) {
        const [imported, alias] = piece.split(/\s+as\s+|\s*:\s*/).map((part) => part.trim());
        if (imported) bindings.named.add(imported);
        if (alias) bindings.named.add(alias);
      }
    }
    const outside = clause.replace(/\{[^}]*\}/, '');
    const namespace = outside.match(/\*\s*as\s+([\w$]+)/);
    if (namespace) bindings.locals.add(namespace[1]);
    const defaultName = outside.replace(/\*\s*as\s+[\w$]+/, '').replace(/[,\s]/g, '');
    if (defaultName) bindings.locals.add(defaultName);
  }
  return bindings;
}

/** Whether a class is judged for this build. `judged_for: "derivations"` applies only to an
 *  entry the engine runs against the log; a surface's clock and randomness are inputs the log
 *  records, not derivations of it. Absent means everything, because the least a row can say is
 *  that it holds. */
export function classAppliesToBuild(reachClass, { isDerivation }) {
  const judgedFor = reachClass.judged_for ?? 'everything';
  if (judgedFor === 'everything') return true;
  if (judgedFor === 'derivations') return isDerivation;
  throw new Error(`reach class ${reachClass.reach_class}: judged_for must be "everything" or "derivations", got ${JSON.stringify(judgedFor)}`);
}

/** Every reach in one source text that the owning package has not declared. Pure. */
export function undeclaredReachesInSource({ source, reachClasses, declared, isDerivation = true }) {
  const code = codeOnly(source);
  const findings = [];
  for (const reachClass of reachClasses.reach_classes) {
    if (declared.has(reachClass.reach_class)) continue;
    if (!classAppliesToBuild(reachClass, { isDerivation })) continue;
    for (const { identifier, uses } of reachClass.globals ?? []) {
      for (const use of uses) {
        for (const match of code.matchAll(globalUsePattern(identifier, use))) {
          findings.push({ reach_class: reachClass.reach_class, line: lineOf(code, match.index), evidence: match[0].trim() });
        }
      }
    }
    for (const { specifier, names } of reachClass.named_imports ?? []) {
      const bindings = importsOf(source, code, specifier);
      for (const name of names) {
        if (bindings.named.has(name)) {
          findings.push({ reach_class: reachClass.reach_class, line: null, evidence: `imports ${name} from a module matching ${specifier}` });
        }
        for (const local of bindings.locals) {
          const pattern = new RegExp(`${FREE_IDENTIFIER_BEHIND}${local}\\s*\\.\\s*${name}\\s*\\(`, 'g');
          for (const match of code.matchAll(pattern)) {
            findings.push({ reach_class: reachClass.reach_class, line: lineOf(code, match.index), evidence: match[0].trim() });
          }
        }
      }
    }
  }
  return findings.sort((left, right) => (left.line ?? 0) - (right.line ?? 0));
}

/** The class an import specifier belongs to, or null. Pure. */
export function reachClassOfSpecifier(specifier, reachClasses, { isDerivation = true } = {}) {
  for (const reachClass of reachClasses.reach_classes) {
    if (!classAppliesToBuild(reachClass, { isDerivation })) continue;
    for (const pattern of reachClass.module_specifiers ?? []) {
      if (new RegExp(pattern).test(specifier)) return reachClass.reach_class;
    }
  }
  return null;
}

/** Which package owns a file, by its position under the set's `packages/` folder, or null when
 *  the file is not package-authored (a dependency, the runtime kit, builder output). */
export function packageOwningFile(filePath, packagesRoot) {
  const relative = path.relative(packagesRoot, filePath);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  const segments = relative.split(path.sep);
  if (segments.includes('node_modules')) return null;
  return segments[0];
}

function explain({ packageName, filePath, packagesRoot, findings, reachClasses }) {
  const relative = path.relative(packagesRoot, filePath).split(path.sep).join('/');
  const lines = findings.map((finding) => `  [${finding.reach_class}] ${finding.evidence}${finding.line === null ? '' : ` at line ${finding.line}`}`);
  return `${relative} reaches past the engine without declaring it:\n${lines.join('\n')}\n`
    + `Two ways out. This package OWNS the reach: add a record with kind "${reachClasses.declaration_kind}" and `
    + `${reachClasses.declaration_class_field} "<class>" to packages/${packageName}/things-to-store-and-run.json. `
    + `It does not: read the value from the runtime context the engine hands every target, or send a `
    + `request to the package that owns it.`;
}

/** The esbuild plugin. Registered FIRST among load plugins so a refused file never reaches a
 *  transform. Returns null for every file it does not refuse, so sibling plugins still run. */
export function createReachPastTheEnginePlugin({ packageSetRoot, reachClasses, isDerivation }) {
  if (typeof isDerivation !== 'boolean') {
    throw new Error('createReachPastTheEnginePlugin needs isDerivation: whether this entry is one the engine runs against the log');
  }
  const packagesRoot = realpathSync(path.join(packageSetRoot, 'packages'));
  const declaredCache = new Map();
  const declaredFor = async (packageName) => {
    if (!declaredCache.has(packageName)) {
      declaredCache.set(packageName, (async () => {
        const manifest = path.join(packagesRoot, packageName, 'things-to-store-and-run.json');
        const data = JSON.parse(await readFile(manifest, 'utf8'));
        return declaredReachClasses(data, reachClasses);
      })());
    }
    return declaredCache.get(packageName);
  };
  const ownerOf = (filePath) => {
    let resolved = filePath;
    try { resolved = realpathSync(filePath); } catch { /* an unresolvable importer is not package source */ }
    return packageOwningFile(resolved, packagesRoot);
  };
  return {
    name: 'bitfield-package-entry-reach-past-the-engine',
    setup(build) {
      build.onResolve({ filter: /.*/ }, async (args) => {
        if (!args.importer) return null;
        const packageName = ownerOf(args.importer);
        if (packageName === null) return null;
        const reachClass = reachClassOfSpecifier(args.path, reachClasses, { isDerivation });
        if (reachClass === null) return null;
        const declared = await declaredFor(packageName);
        if (declared.has(reachClass)) return null;
        return {
          errors: [{
            text: explain({
              packageName, filePath: args.importer, packagesRoot, reachClasses,
              findings: [{ reach_class: reachClass, line: null, evidence: `imports "${args.path}"` }],
            }),
          }],
        };
      });
      build.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, async (args) => {
        const packageName = ownerOf(args.path);
        if (packageName === null) return null;
        const declared = await declaredFor(packageName);
        const source = await readFile(args.path, 'utf8');
        const findings = undeclaredReachesInSource({ source, reachClasses, declared, isDerivation });
        if (findings.length === 0) return null;
        return { errors: [{ text: explain({ packageName, filePath: args.path, packagesRoot, findings, reachClasses }) }] };
      });
    },
  };
}
