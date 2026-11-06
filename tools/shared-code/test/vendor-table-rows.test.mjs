// Ported from old trillion test/vendor-table-rows.test.mjs (tag old-trillion-before-worker-retire, b6ae0ebf81), deleted by
// Trillion-X/trillion #243. The reader is src/data-rows.mjs here, held to the frozen values in
// test/fixtures/vendor-tables-golden.json. The programs now read their tables from their own tools: the readers of a link
// from tools/audio-transcription/read-data/hear-here.mjs and of a channel's list from
// tools/run-on-a-persons-computer/list-a-channel.mjs, the speech programs and engines from
// tools/generate-speech/read-data/speak.mjs, the local models from tools/run-on-a-persons-computer/local-models.mjs; the
// storage origins from tools/price-and-sell-by-contract/records/cloud-files-origins.json. Left out, each searched in
// trillion-workshop tools/, trillion-apps web/ and trillion-rust src/ with nothing running found: test a (no
// oauth-client-records.json or fixedClientIds runs), the dataRows reads of the hear, speech and local-model records files and
// the records-file family test (those files are only kept, under from-old-trillion/), firstChoiceFor (old
// src/model-routes.mjs), test f (post-place-records.json is only kept) and the origin settings (no
// cloud-files-origin-settings.json runs). The installed-set and refusal tests read a records file of the golden sign-in
// apps, written here, where the old one read records/oauth-client-records.json.
import assert from 'node:assert/strict';
import test from 'node:test';
import golden from './fixtures/vendor-tables-golden.json' with { type: 'json' };
import { dataRowKinds, dataRows } from '../src/data-rows.mjs';
import originRecords from '../../price-and-sell-by-contract/records/cloud-files-origins.json' with { type: 'json' };
import { linkSettings } from '../../audio-transcription/read-data/hear-here.mjs';
import { speakSettings } from '../../generate-speech/read-data/speak.mjs';
import { localModelSettings } from '../../run-on-a-persons-computer/local-models.mjs';
import { listSettings } from '../../run-on-a-persons-computer/list-a-channel.mjs';

// The shipped sign-in apps as a records file: one row of kind oauth-client per golden value, in its order.
const oauthRecords = { records: golden.oauth_clients.map(payload => ({ id: `oauth-client:${payload.clientId}`, kind: 'oauth-client', payload })) };

test('c. each program reads its settings with its tables in place', () => {
  // The old hear-fetcher rows are read by two programs now: the channel lister keeps each whole row, `list` and all
  // (list-a-channel.json), and tool:hear-a-link keeps the same row without the `list` only the lister runs.
  assert.deepEqual(listSettings().fetchers, golden.hear_fetchers);
  assert.deepEqual(linkSettings().fetchers, golden.hear_fetchers.map(({ list, ...hearing }) => hearing));
  const speak = speakSettings();
  assert.deepEqual(speak.programs, golden.speech_programs);
  assert.deepEqual(speak.engines, golden.speech_engines);
  const models = localModelSettings();
  assert.deepEqual(models.chat, golden.local_chat);
  assert.deepEqual(models.jobs, golden.local_jobs);
  assert.deepEqual(models.classify, golden.local_classify);
  assert.deepEqual(models.offer, golden.local_offer);
  assert.ok(models.server && models.words, 'the rest of the settings file is still read');
});

test('c. a program that adjusts what it read never changes the shipped rows', () => {
  const first = localModelSettings();
  first.chat.length = 0;
  first.jobs.default.models.length = 0;
  assert.deepEqual(localModelSettings().chat, golden.local_chat);
  assert.deepEqual(localModelSettings().jobs, golden.local_jobs);
});

test('g. storage origins read as the old records did', () => {
  assert.deepEqual(dataRows('storage-origin', originRecords), golden.storage_origins);
});

test('the installed set, when it answers, is the table; when it does not, the shipped file is', () => {
  const mine = [{ id: 'oauth-client:mine', kind: 'oauth-client', payload: { clientId: 'mine' } }];
  assert.deepEqual(dataRows('oauth-client', oauthRecords, { installed: kind => (kind === 'oauth-client' ? mine : null) }), [{ clientId: 'mine' }]);
  assert.deepEqual(dataRows('oauth-client', oauthRecords, { installed: () => null }), golden.oauth_clients);
  assert.deepEqual(dataRows('oauth-client', oauthRecords, { installed: () => undefined }), golden.oauth_clients);
  assert.deepEqual(dataRows('oauth-client', oauthRecords, { installed: () => [] }), [], 'an installed set with none is none, not the shipped rows');
});

test('a kind the reader does not know, or a file without rows, is refused rather than read as empty', () => {
  assert.throws(() => dataRows('oauth-clients', oauthRecords), /not a kind of data row/);
  assert.throws(() => dataRows('oauth-client', {}), /no oauth-client rows/);
  assert.ok(dataRowKinds.includes('storage-origin'));
});
