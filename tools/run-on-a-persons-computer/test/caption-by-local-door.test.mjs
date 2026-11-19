// The caption model's server is named by its local door: the port is the one the Mac app's sealed declaration reports
// (local-door.mjs localPortOf), never a number in the shared settings.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { captionWith } from '../observe-visual.mjs';
import { localPortOf } from '../../keep-and-wake-ai-sessions-on-this-computer/harness/local-door.mjs';

const runtime = '/Applications/Some.app/Contents/MacOS/node';
const declared = ports => file => {
  assert.equal(file, '/Applications/Some.app/Contents/Resources/computer-reader.json');
  return JSON.stringify({ local_runtime: { computer: { report: { local_ports: ports } } } });
};

test('a local door\'s port is the one the app\'s sealed declaration reports, or none', () => {
  assert.equal(localPortOf('local-model-server', { runtime, read: declared({ 'local-model-server': 11434 }) }), 11434);
  assert.equal(localPortOf('local-model-server', { runtime, read: declared({ 'model-pool': 8092 }) }), null);
  assert.equal(localPortOf('local-model-server', { runtime, read: declared({ 'local-model-server': 80 }) }), null);
  assert.equal(localPortOf('local-model-server', { runtime, read: () => { throw new Error('no app'); } }), null);
});

test('the caption model is asked at its door\'s reported port, and not at all when the door is not reported', async () => {
  const row = { door: 'local-model-server', path: '/api/generate', model: 'm', timeout_seconds: 5 };
  const asked = [];
  const fetchImpl = async url => { asked.push(url); return { ok: true, json: async () => ({ response: JSON.stringify({ category: 'Tennis', title: 'A forehand at contact' }) }) }; };
  const seen = await captionWith(row, Buffer.from('px'), '', fetchImpl, name => name === 'local-model-server' ? 40123 : null);
  assert.deepEqual(asked, ['http://127.0.0.1:40123/api/generate']);
  assert.equal(seen.category, 'Tennis');
  assert.equal(await captionWith(row, Buffer.from('px'), '', fetchImpl, () => null), null);
  assert.equal(asked.length, 1, 'an unreported door is never asked');
});

test('the shared settings name the caption server by door, with no address or port', () => {
  for (const file of ['../../bring-in-new-items-from-this-computer/computer/computer-sources.json', '../../set-up-my-account/read-data/computer-sources.json']) {
    const row = JSON.parse(readFileSync(new URL(file, import.meta.url), 'utf8')).visual_caption;
    assert.equal(row.door, 'local-model-server');
    assert.equal(row.url, undefined);
  }
});
