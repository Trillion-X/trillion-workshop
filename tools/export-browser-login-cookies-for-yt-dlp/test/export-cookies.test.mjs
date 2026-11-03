// Runs the Python tests of this tool (test/test_export_cookies.py) on a made-up browser profile whose cookies are
// encrypted the way Chromium does it, with a made-up password (the keychain is never asked), and checks the row names
// the script that exists. Needs python3 with the cryptography package; without them the Python tests skip and say why.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const folder = fileURLToPath(new URL('..', import.meta.url));
const here = join(folder, 'test');
const row = JSON.parse(readFileSync(join(folder, 'tool-rows.json'), 'utf8')).records[0].payload;
const crypto = spawnSync('python3', ['-I', '-c', 'import cryptography'], { encoding: 'utf8' });
const skip = crypto.status === 0 ? false : 'needs python3 with the cryptography package; run the row\'s get_it commands';

test('the row runs on the person\'s computer and names the script that exists', () => {
  assert.equal(row.id, 'tool:export-browser-login-cookies-for-yt-dlp');
  assert.equal(row.invoke.kind, 'on-your-computer');
  assert.match(row.invoke.run, /tools\/export-browser-login-cookies-for-yt-dlp\/do-work\/export_cookies\.py --browser \{browser\} --profile \{profile\} --out \{output\}/);
  assert.ok(existsSync(join(folder, 'do-work', 'export_cookies.py')));
});

test('the Python tests of export-browser-login-cookies-for-yt-dlp pass', { skip }, () => {
  const run = spawnSync('python3', ['-I', '-m', 'unittest', 'discover', '-s', here, '-p', 'test_*.py'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.match(run.stderr, /\nOK/);
});
