// tools/check-how-an-installed-app-is-hardened/test/app-hardening.test.mjs
//
// An installed app's hardening is read from its files and codesign, never by launching it (read-data/app-hardening.mjs):
// the Electron fuse block is found by its sentinel and read per wire version; weak fuses, forbidden entitlements, a missing
// hardened runtime and a recorded integrity hash that nothing enforces are findings in words. The last test reads a REAL
// installed Electron app on this Mac when one is present.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { auditApp, hardeningSettings, readFuses, signingFacts } from '../read-data/app-hardening.mjs';

const settings = hardeningSettings();
const block = (states, version = 1) => Buffer.concat([Buffer.from('xx'), Buffer.from(settings.sentinel), Buffer.from([version, states.length]), Buffer.from(states.map(s => s.charCodeAt(0))), Buffer.from('yy')]);
// RunAsNode, CookieEncryption, NodeOptions, Inspect, AsarIntegrity, OnlyLoadFromAsar, V8Snapshot, FileProtocol
const DEFAULTS = block(['1', '0', '1', '1', '0', '0', '0', '1']);
const HARD = block(['0', '1', '0', '0', '1', '1', '0', 'r']);
function bundle({ fuses, plist = '<plist/>' }) {
  const app = join(mkdtempSync(join(tmpdir(), 'hard-')), 'Sample.app');
  mkdirSync(join(app, 'Contents/Frameworks/Electron Framework.framework/Versions/A'), { recursive: true });
  if (fuses) writeFileSync(join(app, settings.framework_path), fuses);
  writeFileSync(join(app, 'Contents/Info.plist'), plist);
  return app;
}
const signed = (extra = {}) => async () => ({ signed: true, hardened: true, entitlements: [], ...extra });

test('the fuse block is read by its sentinel, per wire version, with removed and unknown states named', () => {
  assert.deepEqual(readFuses(DEFAULTS, settings).fuses, { RunAsNode: 'on', EnableCookieEncryption: 'off', EnableNodeOptionsEnvironmentVariable: 'on', EnableNodeCliInspectArguments: 'on',
    EnableEmbeddedAsarIntegrityValidation: 'off', OnlyLoadAppFromAsar: 'off', LoadBrowserProcessSpecificV8Snapshot: 'off', GrantFileProtocolExtraPrivileges: 'on' });
  assert.equal(readFuses(HARD, settings).fuses.GrantFileProtocolExtraPrivileges, 'removed');
  assert.equal(readFuses(Buffer.from('no block here'), settings), null);
  assert.equal(readFuses(block(['1'], 9), settings).fuses, null, 'an unknown wire version has no table');
});

test('an app left at the defaults is found weak in each place, in words, and one that is hardened is clean', async () => {
  const weak = await auditApp(bundle({ fuses: DEFAULTS, plist: '<key>ElectronAsarIntegrity</key>' }), { settings, facts: signed({ hardened: false, entitlements: ['com.apple.security.cs.disable-library-validation'] }) });
  const kinds = weak.map(item => item.kind + (item.name ? `:${item.name}` : ''));
  for (const wanted of ['not_hardened', 'entitlement:com.apple.security.cs.disable-library-validation', 'fuse:RunAsNode', 'fuse:EnableNodeOptionsEnvironmentVariable', 'fuse:EnableNodeCliInspectArguments',
    'fuse:EnableEmbeddedAsarIntegrityValidation', 'fuse:OnlyLoadAppFromAsar', 'fuse:EnableCookieEncryption', 'integrity_not_enforced']) assert.ok(kinds.includes(wanted), wanted);
  assert.match(weak.find(item => item.name === 'RunAsNode').said, /RunAsNode is on in Sample.app/);
  assert.deepEqual(await auditApp(bundle({ fuses: HARD }), { settings, facts: signed() }), []);
});

test('what cannot be read is a finding: unsigned, a framework with no block, an unknown version, a path that is no app', async () => {
  assert.equal((await auditApp(bundle({ fuses: HARD }), { settings, facts: async () => ({ signed: false, hardened: false, entitlements: [] }) }))[0].kind, 'unsigned');
  assert.equal((await auditApp(bundle({ fuses: Buffer.from('nothing') }), { settings, facts: signed() }))[0].kind, 'no_sentinel');
  assert.equal((await auditApp(bundle({ fuses: block(['1'], 7) }), { settings, facts: signed() }))[0].kind, 'unknown_version');
  assert.equal((await auditApp(join(tmpdir(), 'not-an-app-here'), { settings }))[0].kind, 'no_app');
  assert.deepEqual(await auditApp(bundle({}), { settings, facts: signed() }), [], 'an app with no Electron framework has no fuses to find');
});

test('codesign output is parsed for the runtime flag and the true entitlements', async () => {
  const run = async (file, args) => (args.includes('--entitlements')
    ? { stdout: '<dict><key>com.apple.security.get-task-allow</key><true/><key>other</key><false/></dict>', stderr: '' }
    : { stdout: '', stderr: 'CodeDirectory v=20500 size=1 flags=0x10000(runtime) hashes=1' });
  assert.deepEqual(await signingFacts('/x.app', run), { signed: true, hardened: true, entitlements: ['com.apple.security.get-task-allow'] });
});

const REAL = ['/Applications/Antigravity.app', '/Applications/Cursor.app', '/Applications/Discord.app'].find(path => existsSync(join(path, settings.framework_path)));
test('LIVE-READ: a real installed Electron app is read from disk without being launched', { skip: !REAL }, async () => {
  const findings = await auditApp(REAL);
  console.log(`# ${REAL}: ${findings.length ? findings.map(item => item.said).join(' | ') : 'clean'}`);
  assert.ok(Array.isArray(findings));
  assert.ok(!findings.some(item => ['no_sentinel', 'unknown_version', 'no_app'].includes(item.kind)), 'the real fuse block was found and read');
});
