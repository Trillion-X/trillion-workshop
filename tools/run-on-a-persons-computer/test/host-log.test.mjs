// test/host-log.test.mjs
//
// What the Mac host does with the lines it logs (computer/host-log.mjs, started by computer/mac-tools.mjs start): the original
// log always gets the line, a sealed local file keeps it for the holder of the reader's private key only when a reader key is
// set, and a failure line becomes a sampled, scrubbed report only when a sink exists.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hostLog } from '../host-log.mjs';
import { settingsOf, start } from '../mac-tools.mjs';
import { generateReaderKeys, openAll } from '../sealed-log.mjs';

test('nothing is sealed or reported until the DATA rows are filled: the shipped host only passes lines on', () => {
  const seen = [];
  const home = mkdtempSync(join(tmpdir(), 'hostlog-'));
  const log = hostLog({ settings: settingsOf(), log: line => seen.push(line), home });
  log({ mac_tools_start_failed: 'x' });
  log.close();
  assert.deepEqual(seen, [{ mac_tools_start_failed: 'x' }]);
  assert.equal(existsSync(join(home, settingsOf().host_log.sealed.file)), false);
});

test('started by the host, a failure line is passed on, sealed for the reader, and reported once if the launch is sampled', async () => {
  const readers = generateReaderKeys();
  const home = mkdtempSync(join(tmpdir(), 'hostlog-'));
  const shipped = settingsOf();
  const settings = { ...shipped, host_log: { ...shipped.host_log, sealed: { ...shipped.host_log.sealed, reader_public_key: readers.publicKey.toString('base64') } } };
  const seen = [], reported = [];
  const reporter = { report: async (kind, body) => { reported.push([kind, body]); return { sent: true }; } };
  const log = hostLog({ settings, log: line => seen.push(line), home, reporter });
  log({ ok: 'fine' });
  log({ mac_tools_publish_failed: 'cannot reach /Users/example/x' });
  log.close();
  assert.equal(seen.length, 2);
  assert.deepEqual(reported.map(row => row[0]), ['crash'], 'only the failure line is reported');
  const bytes = readFileSync(join(home, settings.host_log.sealed.file));
  assert.ok(!bytes.toString('latin1').includes('mac_tools_publish_failed'), 'the file holds no plain text');
  const opened = openAll({ privateKey: readers.privateKey, bytes }).batches.map(batch => batch.toString()).join('');
  assert.match(opened, /"ok":"fine"/);
  assert.match(opened, /mac_tools_publish_failed/);

  const lines = [];
  const host = start({ key: 'k', origin: 'http://127.0.0.1:9', settings: { ...settings, on_start: [] }, home, log: line => lines.push(line), call: async () => { throw Object.assign(new Error('no account'), { account_identity_unavailable: true }); }, argv: [] });
  host.log({ mac_tools_take_failed: 'from the started host' });
  await host.stop();
  assert.ok(lines.length > 0, 'the host logged through the wrapper');
  const second = openAll({ privateKey: readers.privateKey, bytes: readFileSync(join(home, settings.host_log.sealed.file)) }).batches.map(batch => batch.toString()).join('');
  assert.match(second, /from the started host/, 'what the started host logged was sealed');
  assert.ok(lines.some(line => line.mac_tools_take_failed), 'and still printed');
});
