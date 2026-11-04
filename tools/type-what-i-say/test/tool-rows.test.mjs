import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dictate, typeDictatedText } from '../read-data/dictation.mjs';

const rows = Object.fromEntries(JSON.parse(readFileSync(new URL('../tool-rows.json', import.meta.url), 'utf8')).records.map(record => [record.payload.id, record.payload]));

test('dictate holds only the granted folder; typing at the cursor also names the capability it needs', () => {
  assert.deepEqual(rows['tool:dictate'].invoke.capabilities, ['change-a-folder']);
  assert.deepEqual(rows['tool:type-dictated-text'].invoke.capabilities, ['change-a-folder', 'type-into-the-front-app']);
  for (const row of Object.values(rows)) assert.deepEqual(row.invoke.stdin.folder, { fill: { from: 'task', field: 'grants.change-a-folder.folder' } });
});

test('the exports keep rows in the granted folder, refuse without one, and send insert to its own row', async () => {
  const folder = mkdtempSync(path.join(os.tmpdir(), 'dictation-'));
  await dictate({ input: { action: 'add', from: 'sample co', to: 'SampleCo' }, folder });
  assert.equal((await dictate({ input: { action: 'clean', text: 'hello sample co' }, folder })).text, 'hello SampleCo');
  assert.ok(readFileSync(path.join(folder, 'rows.json'), 'utf8').includes('SampleCo'));
  await assert.rejects(dictate({ input: { action: 'list' } }), /Grant a folder/);
  await assert.rejects(dictate({ input: { action: 'insert', text: 'x' }, folder }), /tool:type-dictated-text/);
  await assert.rejects(typeDictatedText({ input: { text: 'x' } }), /Grant a folder/);
});

test('polish is handed this computer\'s model: the dictate row asks the dictation-polish job of models-on-this-computer, and no server leaves the text', async () => {
  const { createServer } = await import('node:http');
  const { askLocal, localModelSettings } = await import('../../models-on-this-computer/read-data/models-on-this-computer.mjs');
  assert.ok(rows['tool:dictate'].invoke.files.package_files.some(spec => spec.package === 'models-on-this-computer' && spec.paths.includes('read-data')), 'the row packs the model owner');
  const asked = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      asked.push({ path: request.url, body: JSON.parse(body) });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ model: 'stand-in-4b', choices: [{ message: { role: 'assistant', content: JSON.stringify({ text: 'Hello, Trillion.' }) } }] }));
    });
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const settings = localModelSettings();
  const here = { ...settings, chat: settings.chat.map(row => ({ ...row, url: `http://127.0.0.1:${server.address().port}/v1/chat/completions` })) };
  const folder = mkdtempSync(path.join(os.tmpdir(), 'dictation-'));
  try {
    const polished = await dictate({ input: { action: 'clean', text: 'um hello trillion', polish: true }, folder }, { askModel: request => askLocal(request, here) });
    assert.equal(polished.text, 'Hello, Trillion.');
    const job = settings.jobs['dictation-polish'];
    const model = settings.chat.find(row => row.id === job.models[0]).model;
    assert.deepEqual(polished.model, { changed: true, said: null, by: model });
    assert.equal(asked[0].body.model, model, 'the job names the model asked');
    assert.deepEqual(asked[0].body.response_format, { type: 'json_object' });
    assert.equal(asked[0].body.temperature, 0);
  } finally {
    server.close();
  }
  const none = { ...settings, retry_after_seconds: 0, chat: settings.chat.map(row => ({ ...row, url: 'http://127.0.0.1:9/v1/chat/completions', timeout_seconds: 1 })) };
  const silent = await dictate({ input: { action: 'clean', text: 'keep this', command: 'make it formal' }, folder }, { askModel: request => askLocal(request, none) });
  assert.equal(silent.text, 'keep this');
  assert.match(silent.model.said, /left as it was/);
});
