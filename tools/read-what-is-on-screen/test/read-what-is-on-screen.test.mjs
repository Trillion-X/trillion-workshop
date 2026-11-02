// tools/read-what-is-on-screen/test/read-what-is-on-screen.test.mjs
//
// The command around the reader, run with a stand-in reader (a small program that answers like the real one), and the
// real reader's secret scrubbing, run for real with its real rules on text typed here (it reads no window). The
// reader's reading of a live window needs the Accessibility grant and the person's own windows, so no test does that.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BOUNDS, READER, RULES, SWIFT, answerOf, read, readerArguments } from '../do-work/read-what-is-on-screen.mjs';

const rules = JSON.parse(readFileSync(RULES, 'utf8'));
const aSwift = process.platform === 'darwin' && spawnSync(SWIFT, ['--version']).status === 0;

// A stand-in for the swift command: a shell script that runs `body`.
function standIn(body) {
  const folder = mkdtempSync(join(tmpdir(), 'reader-test-'));
  const program = join(folder, 'swift');
  writeFileSync(program, `#!/bin/sh\n${body}\n`);
  chmodSync(program, 0o755);
  return { program, done: () => rmSync(folder, { recursive: true, force: true }) };
}

test('the reader is run with the rules file and the watch the request asks for, and its captures come back', async () => {
  const fake = standIn(`printf '{"captures":[],"asked":"%s"}\\n' "$*"`);
  try {
    const answer = await read({ watch_seconds: 20, tick_seconds: 30 }, { swift: fake.program });
    assert.deepEqual(answer.captures, []);
    assert.equal(answer.asked, `${READER} --rules ${RULES} --watch-seconds 20 --tick-seconds 30`);
  } finally { fake.done(); }
});

test('a request that names nothing watches for the default time; one outside the bounds is refused with the bounds', () => {
  assert.deepEqual(readerArguments({}).slice(3), ['--watch-seconds', '50', '--tick-seconds', '60']);
  assert.deepEqual(readerArguments(undefined).slice(3), ['--watch-seconds', '50', '--tick-seconds', '60']);
  assert.throws(() => readerArguments({ watch_seconds: 4 }), /watch_seconds must be a number from 5 to 240/);
  assert.throws(() => readerArguments({ watch_seconds: BOUNDS.watch_seconds.most + 1 }), /from 5 to 240/);
  assert.throws(() => readerArguments({ tick_seconds: 9 }), /tick_seconds must be a number from 10 to 600/);
  assert.throws(() => readerArguments({ tick_seconds: '60' }), /tick_seconds must be a number/);
  assert.throws(() => readerArguments({ watch_seconds: Number.NaN }), /watch_seconds must be a number/);
});

test('Accessibility off comes back in words, as the reader said it', async () => {
  const fake = standIn(`printf '{"needs_access":"accessibility","said":"Turn it on."}\\n'`);
  try {
    assert.deepEqual(await read({}, { swift: fake.program }), { needs_access: 'accessibility', said: 'Turn it on.' });
  } finally { fake.done(); }
});

test('what the reader prints before its last line does not matter; a reader that fails says why', async () => {
  const noisy = standIn(`echo "warning: something"; printf '{"captures":[{"app":"x"}]}\\n'`);
  const silent = standIn(`echo "swift: cannot find the developer tools" >&2; exit 1`);
  const rubbish = standIn(`echo "not json"`);
  try {
    assert.equal((await read({}, { swift: noisy.program })).captures[0].app, 'x');
    const failed = await read({}, { swift: silent.program });
    assert.match(failed.error, /The reader gave no answer\. It said: .*cannot find the developer tools/);
    assert.match((await read({}, { swift: rubbish.program })).error, /gave no answer/);
    assert.match((await read({}, { swift: join(tmpdir(), 'no-such-swift') })).error, /gave no answer/);
  } finally { noisy.done(); silent.done(); rubbish.done(); }
});

test('answerOf reads the last line only and gives an error for no line at all', () => {
  assert.deepEqual(answerOf('{"a":1}\n{"b":2}\n'), { b: 2 });
  assert.match(answerOf('', 'one\ntwo\nthree\nfour').error, /two three four/);
  assert.match(answerOf(undefined).error, /gave no answer/);
});

test('the rules never read a password manager, the keychain, settings or a private window, and hold the secret patterns', () => {
  for (const bundle of ['com.apple.keychainaccess', 'com.apple.systempreferences', 'com.1password.1password', 'com.bitwarden.desktop', 'org.keepassxc.keepassxc']) {
    assert.ok(rules.never_read_bundles.includes(bundle), bundle);
  }
  for (const word of ['Incognito', '(Private)', 'Private Browsing']) assert.ok(rules.never_read_title_words.includes(word), word);
  assert.ok(rules.secret_patterns.length >= 10);
  assert.doesNotMatch(rules.words.needs_access, /Trillion/);
  assert.ok(rules.limits.nodes > 0 && rules.limits.characters > 0 && rules.limits.depth > 0 && rules.limits.poll_ms > 0);
});

// The reader's own scrubbing, with the real rules. Each secret is built here from pieces so no secret-shaped text sits in this file.
const run = (args, input) => spawnSync(SWIFT, [READER, ...args], { input, encoding: 'utf8' });

test('the real reader removes keys, tokens, card numbers and password values from text, and keeps ordinary words', { skip: !aSwift }, () => {
  const secrets = {
    anthropic: `sk-ant-${'a1'.repeat(15)}`,
    stripe: `sk_${'live'}_${'Z9'.repeat(10)}`,
    slack: `xox${'b'}-${'1234567890'}-abcdefghij`,
    github: `gh${'p'}_${'Q7'.repeat(18)}`,
    aws: `AKIA${'ABCDEFGH12345678'}`,
    jwt: `eyJ${'abcdefgh'}.${'ijklmnop'}.${'qrstuvwx'}`,
    card: '4111 1111 1111 1111',
    assignment: `pass${'word'}: hunter22secret`,
    pem: `-----BEGIN ${'RSA PRIVATE'} KEY-----\nMIIBOgIBAAJBAK\n-----END ${'RSA PRIVATE'} KEY-----`,
  };
  const plain = 'Notes for the Tuesday meeting: three agenda items and a short summary of the budget.';
  const input = [plain, ...Object.values(secrets)].join('\n');
  const answer = JSON.parse(run(['--rules', RULES, '--scrub'], input).stdout.trim().split('\n').at(-1));
  const lines = answer.text.split('\n');
  assert.equal(lines[0], plain);
  const leaks = ['a1a1a1a1', 'Z9Z9Z9', '1234567890', 'Q7Q7Q7', 'ABCDEFGH12345678', 'abcdefgh', '4111', 'hunter22secret', 'MIIBOgIBAAJBAK'];
  for (const leak of leaks) assert.ok(!answer.text.includes(leak), `${leak} is still there`);
  assert.ok(answer.text.match(/\[removed\]/g).length >= Object.keys(secrets).length);
});

test('the real reader stops, in words, on a secret pattern that does not compile and on a missing rules file', { skip: !aSwift }, () => {
  const folder = mkdtempSync(join(tmpdir(), 'reader-rules-'));
  try {
    const broken = join(folder, 'rules.json');
    writeFileSync(broken, JSON.stringify({ ...rules, secret_patterns: ['(unclosed'] }));
    const stopped = run(['--rules', broken, '--scrub'], 'hello');
    assert.equal(stopped.status, 2);
    assert.match(JSON.parse(stopped.stdout.trim()).error, /secret pattern does not compile: \(unclosed/);
    const none = run(['--scrub'], 'hello');
    assert.equal(none.status, 2);
    assert.match(JSON.parse(none.stdout.trim()).error, /--rules <rules\.json> is required/);
    const missing = run(['--rules', join(folder, 'absent.json'), '--scrub'], 'hello');
    assert.equal(missing.status, 2);
    assert.match(JSON.parse(missing.stdout.trim()).error, /rules file cannot be read/);
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test('the reader type-checks as Swift', { skip: !aSwift }, () => {
  const folder = mkdtempSync(join(tmpdir(), 'reader-typecheck-'));
  try {
    execFileSync('/usr/bin/swiftc', ['-typecheck', READER], { stdio: 'pipe', cwd: folder });
  } finally { rmSync(folder, { recursive: true, force: true }); }
});
