import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { makeHashCodeHexFromJson } from '../../content-identity/read-data/identity.mjs';
import { RULES, findingsInText, lookFiles, oneLookFindings } from '../do-work/check-one-look.mjs';

const checker = fileURLToPath(new URL('../do-work/check-one-look.mjs', import.meta.url));
const root = process.cwd();
const rulesFound = (file, text) => findingsInText(file, text).map(finding => finding.rule);
const cli = (args, input = '') => spawnSync(process.execPath, [checker, '--root', root, ...args], { input, encoding: 'utf8' });

test('all37 original rule semantics remain identical apart from source path relocation', () => {
  const semantic = RULES.rules.map(rule => Object.fromEntries(Object.entries(rule).filter(([key]) => !['files', 'files_also', 'not_files'].includes(key))));
  assert.equal(semantic.length, 37);
  assert.equal(makeHashCodeHexFromJson(semantic), '1f:a2d7a467f7dad316bcdf5bba11283d49578b585bc6bee761a39b996b56874b83');
  for (const scope of ['tools', 'web', 'parts', 'src', 'computer', 'extension', 'ios', 'macos', 'records']) assert.ok(RULES.roots.includes(scope), scope);
});

test('current and legacy source paths preserve the refused and accepted look probes', () => {
  const cases = [
    ['show/probe.css', "blockquote{font-family:'Iowan Old Style',Georgia,serif}", 'blockquote{font-family:var(--font-display)}', 'font-not-from-look'],
    ['show/probe.css', ".title{font:600 24px/1.3 'SF Pro Display',sans-serif}", '.title{font:600 24px/1.3 var(--font-display)}', 'font-not-from-look'],
    ['show/probe.css', '.needs-card{border-left:4px solid var(--color-destructive)}', '.needs-card{border:1px solid var(--color-destructive)}', 'accent-bar-card'],
    ['show/probe.css', ".task-check[data-slot='checkbox']{border-radius:999px}", ".task-check[data-slot='checkbox']{border-radius:var(--radius-check)}", 'check-shape-not-from-look'],
    ['show/probe.css', ".task-check[data-slot='checkbox']{margin-top:.3rem}", ".task-check[data-slot='checkbox']{margin-top:0}", 'check-offset-not-from-look'],
    ['show/probe.css', '.retry-button{background:var(--color-primary);color:#fff}', '.retry-button{background:var(--button-primary-bg);box-shadow:var(--button-highlight),var(--button-shadow)}', 'raw-coloured-button'],
    ['show/probe.css', '.section-label{font-size:11px;text-transform:uppercase;letter-spacing:.08em}', '.section-label{font-size:var(--font-size-caption)}', 'label-keeps-its-case'],
  ];
  for (const prefix of ['tools/screen-look/', 'web/parts/screen-look/', 'parts/screen-look/']) {
    for (const [file, off, on, rule] of cases) {
      assert.ok(rulesFound(prefix + file, off).includes(rule), `${prefix + file}: ${rule} refuses`);
      assert.ok(!rulesFound(prefix + file, on).includes(rule), `${prefix + file}: ${rule} accepts`);
    }
  }
  for (const prefix of ['tools/any-owner/', 'web/parts/', 'parts/']) {
    const file = prefix + 'ui/show/Probe.tsx';
    assert.ok(rulesFound(file, '<button className="bg-red-500 text-white" onClick={go}>Go</button>').includes('raw-coloured-button'));
    assert.ok(!rulesFound(file, '<Button variant="primary" onClick={go}>Go</Button>').includes('raw-coloured-button'));
  }
  assert.ok(rulesFound('ios/App/Probe.swift', 'Text(words).font(.custom("Georgia", size: 18))').includes('font-not-from-look'));
  assert.ok(!rulesFound('ios/App/Probe.swift', 'Text(words).font(Typeface.body)').includes('font-not-from-look'));
});

test('module-load work remains refused while the same work inside a call remains accepted', () => {
  for (const file of ['tools/any-owner/do-work/probe.mjs', 'web/src/probe.mjs', 'web/parts/probe.ts', 'src/probe.mjs', 'parts/probe.ts', 'computer/probe.mjs']) {
    for (const source of ['const id = crypto.randomUUID();', 'const id = Math.random();', 'const id = crypto.getRandomValues(new Uint8Array(8));']) {
      assert.deepEqual(rulesFound(file, source), ['no-randomness-at-module-load'], file);
    }
    for (const source of ['function id() { return crypto.randomUUID(); }', 'const id = () => Math.random();', 'const note = "crypto.randomUUID()";']) {
      assert.deepEqual(rulesFound(file, source), [], file);
    }
  }
});

test('relocated client sites retain only their original per-file rule exceptions', () => {
  const home = 'tools/assemble-and-publish-an-app-project/from-an-older-version/records/client-examples/';
  const examples = RULES.kept.filter(row => row.file.startsWith(home));
  assert.equal(examples.length, 11);
  for (const site of ['longevity', 'bakery', 'sports-club']) {
    const findings = findingsInText(home + site + '/styles.css', '.eyebrow{text-transform:uppercase;font-family:Georgia}');
    assert.ok(findings.find(item => item.rule === 'no-eyebrow')?.kept, site);
    assert.ok(findings.find(item => item.rule === 'label-keeps-its-case')?.kept, site);
    assert.equal(Boolean(findings.find(item => item.rule === 'font-not-from-look')?.kept), site === 'bakery');
  }
  assert.ok(findingsInText(home + 'new-site/styles.css', '.eyebrow{text-transform:uppercase}').every(item => !item.kept));
  assert.ok(findingsInText(home + 'bakery/styles.css', '.card{border-left:4px solid red}').some(item => item.rule === 'accent-bar-card' && !item.kept));
});

test('exact kept values apply in both current homes and never admit a new literal', () => {
  for (const file of ['tools/screen-look/show/frames-canvas.css', 'web/parts/screen-look/show/frames-canvas.css', 'tools/screen-look/show/public-app-editor.css', 'web/parts/screen-look/show/public-app-editor.css']) {
    const kept = findingsInText(file, '.probe{box-shadow:0 1px 2px rgb(0 0 0 / 0.08)}').filter(finding => finding.rule === 'colour-literal-outside-the-look');
    assert.ok(kept.length && kept.every(finding => finding.kept), file);
    const newLiteral = findingsInText(file, '.probe{color:#123456}').filter(finding => finding.rule === 'colour-literal-outside-the-look');
    assert.ok(newLiteral.length && newLiteral.every(finding => !finding.kept), file);
  }
});

test('CLI judges stdin under the explicit repository root and keeps diagnostics relative', () => {
  const file = 'web/parts/ui/show/Probe.tsx';
  const off = cli(['--text', file], '<button className="bg-red-500 text-white" onClick={go}>Go</button>');
  assert.equal(off.status, 1, off.stderr);
  assert.match(off.stderr, /^web\/parts\/ui\/show\/Probe\.tsx:1: raw-coloured-button:/);
  assert.ok(!off.stderr.includes(root));
  assert.equal(cli(['--text', file], '<Button variant="primary" onClick={go}>Go</Button>').status, 0);
  assert.equal(cli(['--text', 'README.md'], 'font-family: Georgia').status, 0);
  assert.equal(cli(['--text', 'web/parts/probe.test.mjs'], 'font-family: Georgia').status, 0);
});

test('CLI refuses missing roots, escaped paths and unsupported input instead of a silent empty result', () => {
  for (const args of [['--root'], ['--root', '/does-not-exist/one-look'], ['--text'], ['--text', '../outside.css'], ['--unknown']]) {
    const answer = cli(args, 'font-family: Georgia');
    assert.equal(answer.status, 2, JSON.stringify(args) + ': ' + answer.stderr);
    assert.match(answer.stderr, /one-look:/);
  }
});

test('explicit scan root includes all source files and stale kept values remain findings', () => {
  const fixture = tempFolder(join(tmpdir(), 'one-look-data-fixture-'));
  try {
    const content = {
      'tools/future/show/probe.css': 'blockquote{font-family:Georgia}',
      'web/src/probe.mjs': 'const id = Math.random();',
      'parts/legacy/show/probe.css': 'blockquote{font-family:Georgia}',
      'tools/screen-look/show/frames-canvas.css': '.probe{box-shadow:0 1px 2px rgb(0 0 0 / 0.08)}',
      'README.md': 'font-family:Georgia',
    };
    for (const [path, text] of Object.entries(content)) {
      const destination = join(fixture, path);
      mkdirSync(join(destination, '..'), { recursive: true });
      writeFileSync(destination, text);
    }
    assert.equal(lookFiles(fixture).length, 4);
    const found = oneLookFindings(undefined, fixture);
    for (const file of ['tools/future/show/probe.css', 'web/src/probe.mjs', 'parts/legacy/show/probe.css']) assert.ok(found.some(finding => finding.file === file), file);
    assert.ok(found.some(finding => finding.file === 'tools/screen-look/show/frames-canvas.css' && finding.line === 0 && /no longer holds/.test(finding.says)));
    assert.ok(found.every(finding => !finding.file.startsWith('/')));
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});
