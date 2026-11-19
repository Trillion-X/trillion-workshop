// tools/better-auth-official/test/busy.test.mjs
//
// A busy sign-in server (a 429 or any 5xx) is said in the terminal's busy words, the same DATA row the terminal prints (command.json, words.sign_in_busy),
// through the pages' shared alert with Try again. A stand-in server answers 429, 500 and 503 over real HTTP; any other answer is not busy.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { isBusy, busyWords } from '../pages/busy.mjs';
import command from '../../use-your-tools-from-a-shell/do-work/command.json' with { type: 'json' };

const client = readFileSync(new URL('../pages/sign-in-client.mjs', import.meta.url), 'utf8');
const sentence = command.words.sign_in_busy;

// The status a stand-in sign-in server answers the page's request with, as the page's fetch reads it.
async function answerOf(status) {
  const server = createServer((request, response) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end('{}'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const answer = await fetch(`http://127.0.0.1:${server.address().port}/api/auth/get-session`);
    return answer.status;
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

test('a 429 and a 503 from the sign-in server are busy, and the page says the terminal\'s busy words for the site', async () => {
  for (const status of [429, 503]) {
    const seen = await answerOf(status);
    assert.equal(seen, status);
    assert.ok(isBusy(seen), `${status} is busy`);
    assert.equal(busyWords(sentence, 'Acme'), sentence.replace('{site_name}', 'Acme'), `${status} says the terminal's words`);
  }
});

test('every 5xx is busy, and the words name no unfilled gap', async () => {
  for (const status of [500, 502, 504]) assert.ok(isBusy(await answerOf(status)), `${status}`);
  assert.doesNotMatch(busyWords(sentence, 'Acme'), /\{site_name\}/);
});

test('answers that are not busy never get the busy words', async () => {
  for (const status of [200, 400, 401, 403, 404]) assert.equal(isBusy(await answerOf(status)), false, `${status}`);
  assert.equal(isBusy(undefined), false, 'no answer at all (network down) is not busy');
});

test('the page takes the sentence from the build and routes every failed answer through refusal', () => {
  assert.match(client, /import busySentence from 'sign-in-busy-sentence';/);
  assert.match(client, /from '\.\/busy\.mjs'/);
  assert.match(client, /const refusal = \(error, fallback = words\.failed, next\) => isBusy\(error\?\.status\) \? fail\(busyWords\(busySentence, siteName\), 'try-again'\) : fail\(fallback, next\);/);
  assert.doesNotMatch(client, /status === 429|status >= 500|too_many/);
});

test('the bundle holds the busy sentence and none of the terminal\'s other words', () => {
  const bundle = readFileSync(new URL('../pages/assets/sign-in.js', import.meta.url), 'utf8');
  assert.ok(bundle.includes(JSON.stringify(sentence).slice(1, -1)), 'the sentence is in the bundle');
  assert.ok(!bundle.includes(command.words.no_credential), 'another terminal word is not');
});
