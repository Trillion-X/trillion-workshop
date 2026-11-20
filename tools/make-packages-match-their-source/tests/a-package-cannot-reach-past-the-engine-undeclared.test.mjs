// packages/make-packages-match-their-source/tests/a-package-cannot-reach-past-the-engine-undeclared.test.mjs
//
// The border, tested the way an attacker would probe it. Every case here is a way the plugin
// could report clean while a reach shipped, or report a finding where none exists:
//
//   - a reach in a COMMENT or a STRING is prose, not a reach
//   - a reach inside a template literal's `${ }` IS a reach, the text around it is not
//   - `refetch(`, `foo.fetch(`, `x?.fetch(` are not the global `fetch(`
//   - a named import (`import { randomUUID } from 'node:crypto'`) is caught even though
//     `node:crypto` itself is not a forbidden specifier, because hashing is allowed and entropy is not
//   - a namespace import (`import * as c from 'node:crypto'; c.randomBytes()`) is caught
//   - a bare specifier the class lists (`axios`) is refused exactly like `node:http`
//   - a declaration is scoped to ONE package and ONE class: declaring file-io does not license spawn,
//     and one package's declaration does not license its sibling
//   - a sibling package's file inlined into this bundle is judged against the SIBLING's declaration
//   - a declaration naming a class the DATA file does not define is refused, so a typo cannot
//     silently license nothing
//   - a set with no reach-classes file does not build, so "no rules" cannot look like "clean"
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  codeOnly,
  declaredReachClasses,
  packageOwningFile,
  reachClassOfSpecifier,
  undeclaredReachesInSource,
} from '../do-work/package-entry-reach-past-the-engine.mjs';

const classes = {
  declaration_kind: 'reaches-past-the-engine',
  declaration_class_field: 'reach_class',
  reach_classes: [
    { reach_class: 'file-io', module_specifiers: ['^(node:)?fs(/promises)?$'], globals: [] },
    { reach_class: 'process-spawn', module_specifiers: ['^(node:)?child_process$'], globals: [] },
    {
      reach_class: 'network',
      module_specifiers: ['^(node:)?https?$', '^axios$'],
      globals: [{ identifier: 'fetch', uses: ['{token}\\s*\\('] }],
    },
    {
      reach_class: 'clock',
      module_specifiers: [],
      globals: [{ identifier: 'Date', uses: ['{token}\\s*\\.\\s*now\\s*\\(', 'new\\s+{token}\\s*\\(\\s*\\)'] }],
    },
    {
      reach_class: 'randomness',
      module_specifiers: ['^uuid$'],
      named_imports: [{ specifier: '^(node:)?crypto$', names: ['randomUUID', 'randomBytes'] }],
      globals: [{ identifier: 'Math', uses: ['{token}\\s*\\.\\s*random\\s*\\('] }],
    },
  ],
};

const none = new Set();
const classesOf = (findings) => findings.map((finding) => finding.reach_class);

test('a reach in code is a finding; the same text in a comment or a string is not', () => {
  const source = [
    '// Date.now() is what we used to call here',
    'const label = "Math.random() would be wrong";',
    "const other = 'fetch(url)';",
    'export const stamp = Date.now();',
  ].join('\n');
  const findings = undeclaredReachesInSource({ source, reachClasses: classes, declared: none });
  assert.deepEqual(classesOf(findings), ['clock']);
  assert.equal(findings[0].line, 4);
});

test('a template literal hides its text and exposes its expressions', () => {
  const source = 'export const s = `at ${Date.now()} we did not fetch(`;';
  const findings = undeclaredReachesInSource({ source, reachClasses: classes, declared: none });
  assert.deepEqual(classesOf(findings), ['clock']);
});

test('a nested template expression is still code', () => {
  const source = 'export const s = `outer ${ `inner ${Math.random()}` } end`;';
  const findings = undeclaredReachesInSource({ source, reachClasses: classes, declared: none });
  assert.deepEqual(classesOf(findings), ['randomness']);
});

test('a global is matched only as a free identifier', () => {
  const source = [
    'const refetch = () => 1; refetch();',
    'const client = { fetch: () => 1 }; client.fetch(); client?.fetch();',
    'const now = { Date: { now: () => 0 } }; now.Date.now();',
    'export const go = () => fetch(url);',
  ].join('\n');
  const findings = undeclaredReachesInSource({ source, reachClasses: classes, declared: none });
  assert.deepEqual(classesOf(findings), ['network']);
  assert.equal(findings[0].line, 4);
});

test('an English word in JSX text is prose, and a reach is a call or a construct', () => {
  // The exact 2026-09-05 incident: a surface's empty-state copy said "any browser fetch path"
  // and the border refused it, so a lane reworded customer copy to get past the build.
  const source = [
    'export const Empty = () => (',
    '  <Text>This package does not hardcode any browser fetch path, Date or Math here.</Text>',
    ');',
    'export const load = () => fetch("/x");',
  ].join('\n');
  const findings = undeclaredReachesInSource({ source, reachClasses: classes, declared: none });
  assert.deepEqual(classesOf(findings), ['network']);
  assert.equal(findings[0].line, 4);
});

test('a class row with a bare-token use is refused when the DATA file is read', async () => {
  const { writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const { readReachClasses, reachClassesFileName } = await import('../do-work/package-entry-reach-past-the-engine.mjs');
  const root = tempFolder(path.join(tmpdir(), 'reach-classes-'));
  const bare = { ...classes, reach_classes: [{ reach_class: 'network', module_specifiers: [], globals: [{ identifier: 'fetch', uses: ['{token}'] }] }] };
  await writeFile(path.join(root, reachClassesFileName), JSON.stringify(bare));
  await assert.rejects(() => readReachClasses(root), /bare "fetch"/);
});

test('the construct-now form of the clock is a reach; a date from a value is not', () => {
  const source = 'const a = new Date();\nconst b = new Date(1700000000000);\nconst c = new Date(stored);';
  const findings = undeclaredReachesInSource({ source, reachClasses: classes, declared: none });
  assert.deepEqual(classesOf(findings), ['clock']);
  assert.equal(findings[0].line, 1);
});

test('a named import of an entropy function is caught though the module itself is allowed', () => {
  const source = "import { createHash, randomUUID as id } from 'node:crypto';\nexport const h = createHash('sha256');";
  const findings = undeclaredReachesInSource({ source, reachClasses: classes, declared: none });
  assert.deepEqual(classesOf(findings), ['randomness']);
  assert.match(findings[0].evidence, /randomUUID/);
});

test('a namespace import used for entropy is caught at the call', () => {
  const source = "import * as c from 'crypto';\nexport const h = c.createHash('sha256');\nexport const r = c.randomBytes(8);";
  const findings = undeclaredReachesInSource({ source, reachClasses: classes, declared: none });
  assert.deepEqual(classesOf(findings), ['randomness']);
  assert.equal(findings[0].line, 3);
});

test('a require binding is read the same way as an import', () => {
  const source = "const { randomBytes } = require('node:crypto');";
  const findings = undeclaredReachesInSource({ source, reachClasses: classes, declared: none });
  assert.deepEqual(classesOf(findings), ['randomness']);
});

test('a declared class is silent and every other class still reports', () => {
  const source = 'export const t = Date.now(); export const r = Math.random();';
  const findings = undeclaredReachesInSource({ source, reachClasses: classes, declared: new Set(['clock']) });
  assert.deepEqual(classesOf(findings), ['randomness']);
});

test('a specifier is classified by pattern, third-party or builtin alike', () => {
  assert.equal(reachClassOfSpecifier('node:fs', classes), 'file-io');
  assert.equal(reachClassOfSpecifier('fs/promises', classes), 'file-io');
  assert.equal(reachClassOfSpecifier('axios', classes), 'network');
  assert.equal(reachClassOfSpecifier('https', classes), 'network');
  assert.equal(reachClassOfSpecifier('uuid', classes), 'randomness');
  assert.equal(reachClassOfSpecifier('node:path', classes), null);
  assert.equal(reachClassOfSpecifier('./fs-helpers', classes), null);
  assert.equal(reachClassOfSpecifier('@bitfield/runtime-kit', classes), null);
});

test('a declaration is one package, one class', () => {
  const data = {
    package: 'example',
    things: [
      { type: 'record', payload: { kind: 'reaches-past-the-engine', reach_class: 'file-io' } },
      { type: 'record', payload: { kind: 'something-else', reach_class: 'process-spawn' } },
    ],
  };
  const declared = declaredReachClasses(data, classes);
  assert.deepEqual([...declared], ['file-io']);
});

test('a declaration naming an undefined class is refused, never silently ignored', () => {
  const data = { package: 'example', things: [{ type: 'record', payload: { kind: 'reaches-past-the-engine', reach_class: 'fileio' } }] };
  assert.throws(() => declaredReachClasses(data, classes), /does not define/);
});

test('a declaration with no class is refused', () => {
  const data = { package: 'example', things: [{ type: 'record', payload: { kind: 'reaches-past-the-engine' } }] };
  assert.throws(() => declaredReachClasses(data, classes), /must name one reach_class/);
});

test('ownership is by position under packages/, and node_modules is nobody', () => {
  const root = '/set/packages';
  assert.equal(packageOwningFile('/set/packages/alpha/do-work/a.ts', root), 'alpha');
  assert.equal(packageOwningFile('/set/packages/alpha/node_modules/dep/index.js', root), null);
  assert.equal(packageOwningFile('/set/node_modules/@bitfield/runtime-kit/src/index.ts', root), null);
  assert.equal(packageOwningFile('/elsewhere/packages/alpha/a.ts', root), null);
  assert.equal(packageOwningFile('/set/packages', root), null);
});

test('a class judged for derivations is silent in a surface and loud in a target; everything-classes are loud in both', () => {
  const scoped = {
    ...classes,
    reach_classes: classes.reach_classes.map((reachClass) => ({
      ...reachClass,
      judged_for: reachClass.reach_class === 'clock' || reachClass.reach_class === 'randomness' ? 'derivations' : 'everything',
    })),
  };
  const source = 'export const t = Date.now(); export const r = Math.random(); export const p = fetch(url);';
  assert.deepEqual(classesOf(undeclaredReachesInSource({ source, reachClasses: scoped, declared: none, isDerivation: false })), ['network']);
  assert.deepEqual(
    classesOf(undeclaredReachesInSource({ source, reachClasses: scoped, declared: none, isDerivation: true })).sort(),
    ['clock', 'network', 'randomness'],
  );
  assert.equal(reachClassOfSpecifier('uuid', scoped, { isDerivation: false }), null);
  assert.equal(reachClassOfSpecifier('uuid', scoped, { isDerivation: true }), 'randomness');
  assert.equal(reachClassOfSpecifier('node:fs', scoped, { isDerivation: false }), 'file-io');
});

test('an unknown judged_for value throws rather than silently judging nothing or everything', () => {
  const broken = { ...classes, reach_classes: [{ ...classes.reach_classes[3], judged_for: 'targets' }] };
  assert.throws(() => undeclaredReachesInSource({ source: 'Date.now()', reachClasses: broken, declared: none }), /judged_for must be/);
});

test('codeOnly keeps every newline so line numbers survive blanking', () => {
  const source = '/* a\nb */ "x\n" `t\n${1}\n` // c\nlast';
  assert.equal(codeOnly(source).split('\n').length, source.split('\n').length);
});
