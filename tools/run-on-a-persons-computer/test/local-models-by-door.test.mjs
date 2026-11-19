// The Mac helper's model settings name each server by its local door; the port is the one this computer reports
// (localPortOf), and a door it does not report is passed over in words, never guessed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { localModelSettings, installServer } from '../local-models.mjs';

test('the server and each model row get the reported port of their door, and an unreported door gets none', async () => {
  const own = JSON.parse(readFileSync(new URL('../local-models.json', import.meta.url), 'utf8'));
  assert.doesNotMatch(JSON.stringify(own.server), /127\.0\.0\.1|localhost|\d{4,5}/, 'no address or port in the settings');
  const rows = { chat: [{ id: 'near', door: 'local-model-server', path: '/v1/chat/completions', model: 'm' }, { id: 'far', door: 'local-judge-server', path: '/v1/chat/completions', model: 'j' }], classify: [], jobs: {}, offer: [], wired: {} };
  const settings = localModelSettings(rows, door => door === 'local-model-server' ? 40123 : null);
  assert.equal(settings.server.models, 'http://127.0.0.1:40123/api/tags');
  assert.equal(settings.server.pull, 'http://127.0.0.1:40123/api/pull');
  assert.equal(settings.chat[0].url, 'http://127.0.0.1:40123/v1/chat/completions');
  assert.equal(settings.chat[1].url, null);
  assert.equal(settings.chat[1].not_reported, 'This computer does not report a port named local-judge-server.');
  const none = localModelSettings(rows, () => null);
  assert.equal(none.server.models, null);
  let ensured = 0;
  assert.equal(await installServer(none.server, { ensure: async () => { ensured += 1; return { path: '/nowhere' }; } }), null);
  assert.equal(ensured, 0, 'a server whose door is not reported is never installed');
});
