import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installedSiteCommand } from '../read-data/installed-site.mjs';

const rules = { state_folder: '~/.{cli}/cli', site_file: 'site.json' };
function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'site-data-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return { home, keep(name, text) {
    const folder = join(home, '.' + name, 'cli'); mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'site.json'), text); return folder;
  } };
}

test('strict lookup reads the explicit command from the one installed site', t => {
  const f = fixture(t); f.keep('site-a', JSON.stringify({ cli: 'site-a', site_name: 'A site' }));
  assert.equal(installedSiteCommand({ home: f.home, rules }), 'site-a');
});
test('strict lookup never uses the invocation-name fallback for malformed or incomplete site DATA', t => {
  const f = fixture(t);
  for (const text of ['', '{', '{}', 'null', '[]', '{"cli":null}', '{"cli":[]}', '{"cli":"sh -c"}', '{"cli":"other-site"}']) {
    f.keep('site-a', text);
    assert.throws(() => installedSiteCommand({ home: f.home, rules }), /Installed site DATA/);
  }
});
test('strict lookup refuses absent and ambiguous installed sites', t => {
  const f = fixture(t);
  assert.throws(() => installedSiteCommand({ home: f.home, rules }), /Exactly one installed site/);
  f.keep('site-a', '{"cli":"site-a"}'); f.keep('site-b', '{"cli":"site-b"}');
  assert.throws(() => installedSiteCommand({ home: f.home, rules }), /Exactly one installed site/);
});
test('strict lookup refuses a site-file path that is a directory rather than readable JSON', t => {
  const f = fixture(t); const folder = join(f.home, '.site-a', 'cli', 'site.json'); mkdirSync(folder, { recursive: true });
  assert.throws(() => installedSiteCommand({ home: f.home, rules }), /readable JSON/);
});

test('strict lookup refuses duplicate members including escaped command keys', t => {
  const f = fixture(t);
  for (const text of [
    '{"cli":"other-site","cli":"site-a"}',
    '{"cli":"other-site","cl\\u0069":"site-a"}',
    '{"cli":"site-a","cli":"site-a"}',
    '{"cli":"site-a","metadata":{"x":1,"x":2}}',
  ]) {
    f.keep('site-a', text);
    assert.throws(() => installedSiteCommand({ home: f.home, rules }), /readable JSON/);
  }
  f.keep('site-a', '{"cli":"site-a","metadata":[{"x":1},{"x":2}],"text":"\\\"cli\\\": other"}');
  assert.equal(installedSiteCommand({ home: f.home, rules }), 'site-a');
});

test('strict lookup refuses repaired UTF-8 and preserves valid Unicode DATA', t => {
  const f = fixture(t);
  f.keep('site-a', Buffer.concat([Buffer.from('{"cli":"site-a","site_name":"'), Buffer.from([0xff]), Buffer.from('"}')]));
  assert.throws(() => installedSiteCommand({ home: f.home, rules }), /readable JSON/);
  f.keep('site-a', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"cli":"site-a"}')]));
  assert.throws(() => installedSiteCommand({ home: f.home, rules }), /readable JSON/);
  f.keep('site-a', '{"cli":"site-a","site_name":"Café 網站"}');
  assert.equal(installedSiteCommand({ home: f.home, rules }), 'site-a');
});
