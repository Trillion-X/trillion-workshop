// tools/social-posts/test/publish-by-format.test.mjs: a mapped format's container, wait and publish, with stubbed Graph replies. The
// token is a stand-in; the test checks each request sent, the order of the steps, and that nothing is published unless the
// container is FINISHED.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatOf, publishByFormat } from '../read-data/publish-by-format.mjs';
import { pollUntilFinished } from '../read-data/poll-until-finished.mjs';

const TOKEN = 'stand-in-token-not-real';
const reply = (status, body) => ({ ok: status < 400, status, text: async () => JSON.stringify(body) });
const graphStub = ({ statuses = ['FINISHED'], containerId = 'container-1', mediaId = 'media-9', createFails = false } = {}) => {
  const sent = [];
  let polls = 0;
  const send = async (url, init = {}) => {
    sent.push({ url: String(url), method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : null });
    if (createFails && init.method === 'POST' && String(url).includes('/media?')) return reply(400, { error: { message: 'bad video' } });
    if (init.method === 'POST' && String(url).includes('/media?')) return reply(200, { id: containerId });
    if (String(url).includes('/media_publish')) return reply(200, { id: mediaId });
    polls += 1;
    return reply(200, { id: containerId, status_code: statuses[Math.min(polls - 1, statuses.length - 1)] });
  };
  return { sent, send, polls: () => polls };
};
const options = { auth: { accessToken: TOKEN, accountId: '17841452139268435' } };
const noSleep = async () => {};

test('the format map names reel and story, and an unmapped name has no spec', () => {
  assert.equal(formatOf('reel').container.media_type, 'REELS');
  assert.deepEqual(formatOf('reel').container.trial_params, { graduation_strategy: 'SS_PERFORMANCE' });
  assert.equal(formatOf('story').container.media_type, 'STORIES');
  assert.equal(formatOf('carousel'), null);
});

test('a reel makes its container with trial_params, waits until FINISHED, then publishes', async () => {
  const g = graphStub({ statuses: ['IN_PROGRESS', 'IN_PROGRESS', 'FINISHED'] });
  const outcome = await publishByFormat({ format: 'reel', options, accountId: '17841452139268435', mediaUrl: 'https://files.example.test/v.mp4', caption: 'words', send: g.send, sleep: noSleep });
  assert.deepEqual(g.sent[0].body, { media_type: 'REELS', caption: 'words', video_url: 'https://files.example.test/v.mp4', trial_params: { graduation_strategy: 'SS_PERFORMANCE' } });
  assert.match(g.sent[0].url, /\/17841452139268435\/media\?access_token=stand-in-token-not-real$/);
  assert.equal(g.polls(), 3);
  assert.match(g.sent[g.sent.length - 1].url, /\/container-1$|\/media_publish\?/);
  assert.deepEqual(g.sent[g.sent.length - 1].body, { creation_id: 'container-1' });
  assert.equal(outcome.state, 'published');
  assert.equal(outcome.post.postId, 'media-9');
});

test('a story makes its STORIES container with image_url and waits before publishing', async () => {
  const g = graphStub();
  const outcome = await publishByFormat({ format: 'story', options, accountId: '17841452139268435', mediaUrl: 'https://files.example.test/s.jpg', mediaKind: 'image', send: g.send, sleep: noSleep });
  assert.equal(g.sent[0].body.media_type, 'STORIES');
  assert.equal(g.sent[0].body.image_url, 'https://files.example.test/s.jpg');
  assert.equal(outcome.state, 'published');
});

test('an ERROR container is never published', async () => {
  const g = graphStub({ statuses: ['IN_PROGRESS', 'ERROR'] });
  const outcome = await publishByFormat({ format: 'reel', options, accountId: '17841452139268435', mediaUrl: 'https://x.test/v.mp4', send: g.send, sleep: noSleep });
  assert.equal(outcome.state, 'failed');
  assert.match(outcome.message, /ERROR/);
  assert.deepEqual(outcome.retryDisposition, { kind: 'never' });
  assert.ok(!g.sent.some(request => request.url.includes('media_publish')));
});

test('a container that never finishes is refused at the cap, and nothing is published', async () => {
  const g = graphStub({ statuses: ['IN_PROGRESS'] });
  const outcome = await publishByFormat({ format: 'reel', options, accountId: '17841452139268435', mediaUrl: 'https://x.test/v.mp4', send: g.send, sleep: noSleep, maxTries: 4 });
  assert.equal(outcome.state, 'failed');
  assert.match(outcome.message, /IN_PROGRESS after 4 status asks/);
  assert.equal(g.polls(), 4);
  assert.ok(!g.sent.some(request => request.url.includes('media_publish')));
});

test('a refused container request is a failed outcome carrying the app\'s own words', async () => {
  const g = graphStub({ createFails: true });
  const outcome = await publishByFormat({ format: 'reel', options, accountId: '17841452139268435', mediaUrl: 'https://x.test/v.mp4', send: g.send, sleep: noSleep });
  assert.equal(outcome.state, 'failed');
  assert.match(outcome.message, /bad video/);
});

test('a format with no token is refused before any request leaves', async () => {
  const g = graphStub();
  await assert.rejects(publishByFormat({ format: 'reel', options: { auth: {} }, accountId: '1', mediaUrl: 'https://x.test/v.mp4', send: g.send, sleep: noSleep }), /holds no token/);
  assert.equal(g.sent.length, 0);
});

test('the shared poll loop answers ok only for FINISHED and stops at ERROR at once', async () => {
  const seen = [];
  const statuses = ['IN_PROGRESS', 'FINISHED'];
  const done = await pollUntilFinished({ readStatus: async () => { seen.push(statuses.shift()); return seen.at(-1); }, maxTries: 5, everySeconds: 1, sleep: noSleep });
  assert.deepEqual(done, { ok: true, status_code: 'FINISHED', tries: 2 });
  const bad = await pollUntilFinished({ readStatus: async () => 'EXPIRED', maxTries: 5, everySeconds: 1, sleep: noSleep });
  assert.deepEqual(bad, { ok: false, status_code: 'EXPIRED', tries: 1 });
});
