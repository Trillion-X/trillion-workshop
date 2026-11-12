// The optimization may exclude only proved ASCII misses. Git still owns every final match.
import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess, { execFileSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gitReaders } from '../do-work/read-from-repositories.mjs';

function git(root, ...args) { return execFileSync('git', ['-C', root, ...args], {encoding: 'utf8'}).trim(); }
function fixture(t, large = true) {
  const root = mkdtempSync(join(tmpdir(), 'ascii-prefix-reader-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  git(root, 'init', '-q', '-b', 'main');
  const files = {
    'ascii/positive.txt': 'needleAlpha\nKEEPscope\nprefixQQsuffix\nneedle Gamma\nescaped[bracket]\n',
    'ascii/[literal]?.txt': 'needleBeta\n',
    'ascii/new\nline.txt': 'needleAlpha\n',
    'ascii/:(exclude)literal.txt': 'needleBeta\n',
    'unicode/kelvin.txt': 'KeepScope\n',
    'unicode/longs.txt': 'Selectſcope\n',
    'unicode/unrelated.txt': 'unrelated é 🦊\n',
    'invalid/prefix.txt': Buffer.concat([Buffer.from([255]), Buffer.from('KeepScope\n')]),
    'invalid/unrelated.txt': Buffer.from([255, 254, 10]),
    'binary/early.txt': Buffer.from('KeepScope\0\n'),
    'binary/late.txt': Buffer.concat([Buffer.from('KeepScope\n'), Buffer.alloc(10000, 0x78), Buffer.from([0])]),
    'pathHit-KeepScope.mjs': '',
  };
  if (large) files['archive/large-ascii.txt'] = Buffer.alloc((1 << 26) + 1, 0x78);
  for (const [path, value] of Object.entries(files)) { mkdirSync(dirname(join(root, path)), {recursive: true}); writeFileSync(join(root, path), value); }
  git(root, 'add', '-A'); git(root, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'synthetic search corpus');
  git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  return {root, name: root.split('/').at(-1)};
}
function trace(t, intercept = () => undefined) {
  const calls = [], original = childProcess.execFileSync;
  childProcess.execFileSync = function(file, args, options) {
    if (file === 'git') { calls.push({args: [...args], options}); const value = intercept(args, options); if (value !== undefined) return value; }
    return original.call(this, file, args, options);
  };
  syncBuiltinESMExports();
  t.after(() => { childProcess.execFileSync = original; syncBuiltinESMExports(); });
  return calls;
}

test('large ASCII prefilter preserves exact original Git case, Unicode, invalid UTF-8 and binary answers', (t) => {
  const {root, name} = fixture(t);
  const patterns = ['needleAlpha|needleBeta', 'KeepScope|SelectScope', 'prefix.{0,5}suffix|otherMarker',
    'needle[[:space:]]*Gamma', 'escaped\\[bracket\\]', 'nothingMatchesThis'];
  const baseline = gitReaders({root});
  const expected = patterns.map(pattern => baseline.searchCode(name, pattern));
  const calls = trace(t), optimized = gitReaders({root});
  optimized.prepareCodeSearch([name], patterns);
  assert.deepEqual(patterns.map(pattern => optimized.searchCode(name, pattern)), expected);
  assert.ok(expected[1].includes('pathHit-KeepScope.mjs'), 'path matching remains independent of content candidates');
  const detector = calls.find(call => call.args.includes('-P'));
  assert.ok(detector, 'large corpus uses the conservative byte classifier');
  assert.equal(detector.options.env.LC_ALL, 'C');
  assert.equal(calls.find(call => call.args.includes('-F')).options.env.LC_ALL, 'C', 'ASCII exclusion uses bytewise ASCII case; non-ASCII is already retained');
  const final = calls.filter(call => call.args.includes('--literal-pathspecs') && call.args.includes('-E'));
  assert.ok(final.length >= patterns.length);
  for (const call of final) {
    assert.ok(call.args.includes('-i') && call.args.includes('-I'));
    assert.equal(call.options.env.LC_ALL, process.env.LC_ALL);
    for (const path of ['unicode/unrelated.txt', 'invalid/unrelated.txt', 'binary/early.txt', 'binary/late.txt']) assert.ok(call.args.includes(path), 'unsafe bytes always remain candidates');
    assert.ok(!call.args.includes('archive/large-ascii.txt'), 'only a proved ASCII prefix miss is excluded');
  }
  assert.ok(calls.some(call => call.args.includes('--no-index') && call.args.includes('empty') && call.args.includes('-E')), 'original expressions compile even for no hits');
});

test('literal candidate path binding ignores inherited pathspec selectors', (t) => {
  const {root, name} = fixture(t), pattern = 'needleAlpha|needleBeta';
  const expected = gitReaders({root}).searchCode(name, pattern);
  const previous = process.env.GIT_GLOB_PATHSPECS;
  process.env.GIT_GLOB_PATHSPECS = '1';
  t.after(() => { if (previous === undefined) delete process.env.GIT_GLOB_PATHSPECS; else process.env.GIT_GLOB_PATHSPECS = previous; });
  const reader = gitReaders({root}); reader.prepareCodeSearch([name], [pattern]);
  assert.deepEqual(reader.searchCode(name, pattern), expected);
});

test('a missing byte classifier falls back to the complete original search', (t) => {
  const {root, name} = fixture(t), pattern = 'needleAlpha';
  const expected = gitReaders({root}).searchCode(name, pattern);
  const calls = trace(t, (args) => { if (args.includes('-P')) { const error = new Error('synthetic missing PCRE2'); error.status = 2; throw error; } });
  const reader = gitReaders({root}); reader.prepareCodeSearch([name], [pattern]);
  assert.deepEqual(reader.searchCode(name, pattern), expected);
  assert.ok(calls.some(call => call.args.includes('-E') && !call.args.includes('--literal-pathspecs') && !call.args.includes('--no-index')));
});

test('malformed original ERE cannot become a cached empty success', (t) => {
  const {root, name} = fixture(t), pattern = 'needle[[:invalidclass:]]';
  const calls = trace(t), reader = gitReaders({root});
  reader.prepareCodeSearch([name], [pattern]);
  assert.equal(reader.searchCode(name, pattern), null);
  assert.ok(calls.some(call => call.args.includes('--no-index') && call.args.includes('empty')));
});

test('an optional leading atom or unsupported branch keeps the ordinary complete search', (t) => {
  const {root, name} = fixture(t, false);
  const patterns = ['n?eedleAlpha', '(needleAlpha|needleBeta)', '^needleAlpha', 'needleAlpha|'];
  const expected = patterns.map(pattern => gitReaders({root}).searchCode(name, pattern));
  const calls = trace(t), reader = gitReaders({root}); reader.prepareCodeSearch([name], patterns);
  assert.deepEqual(patterns.map(pattern => reader.searchCode(name, pattern)), expected);
  assert.ok(!calls.some(call => call.args.includes('-P')));
  assert.ok(calls.some(call => call.args.includes('grep') && call.args.includes('-E') && !call.args.includes('--no-index')), 'unsupported patterns still execute the complete original query');
});


test('each expression excludes ASCII files needed only by another mandatory prefix', (t) => {
  const {root, name} = fixture(t);
  writeFileSync(join(root, 'archive/large-ascii.txt'), Buffer.concat([Buffer.from('needleAlpha\n'), Buffer.alloc(1 << 26, 0x78)]));
  git(root, 'add', '--', 'archive/large-ascii.txt');
  git(root, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'different mandatory prefix');
  git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  const patterns = ['needleAlpha', 'needleBeta'], baseline = gitReaders({root});
  const expected = patterns.map(pattern => baseline.searchCode(name, pattern));
  const calls = trace(t), reader = gitReaders({root}); reader.prepareCodeSearch([name], patterns);
  assert.deepEqual(patterns.map(pattern => reader.searchCode(name, pattern)), expected);
  const final = calls.filter(call => call.args.includes('--literal-pathspecs') && call.args.includes('-E'));
  const alpha = final.filter(call => call.args[call.args.indexOf('-e') + 1] === 'needleAlpha');
  const beta = final.filter(call => call.args[call.args.indexOf('-e') + 1] === 'needleBeta');
  assert.ok(alpha.some(call => call.args.includes('archive/large-ascii.txt')));
  assert.ok(beta.length > 0 && beta.every(call => !call.args.includes('archive/large-ascii.txt')));
  for (const call of final) for (const path of ['unicode/unrelated.txt', 'invalid/unrelated.txt', 'binary/early.txt', 'binary/late.txt']) {
    assert.ok(call.args.includes(path), 'per-expression filtering never drops unsafe candidates');
  }
});
