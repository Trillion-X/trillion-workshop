// tools/social-posts/test/publish-by-format.test.mjs: a mapped format's containers, waits and publish, with stubbed Graph replies. The
// token is a stand-in; the test checks each request sent, the order of the steps, and that nothing is published unless every
// container it depends on is FINISHED.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatOf, publishByFormat } from '../read-data/publish-by-format.mjs';
import { pollUntilFinished } from '../read-data/poll-until-finished.mjs';

const TOKEN = 'stand-in-token-not-real';
const IG = '17841452139268435';
const reply = (status, body) => ({ ok: status < 400, status, text: async () => JSON.stringify(body) });
// Each container creation gets the next id (container-1, container-2, ...); every status ask answers the next status in line.
const graphStub = ({ statuses = ['FINISHED'], createFails = false } = {}) => {
  const sent = [];
  let polls = 0;
  let made = 0;
  const send = async (url, init = {}) => {
    sent.push({ url: String(url), method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : null });
    if (init.method === 'POST' && String(url).includes('/media?')) {
      if (createFails) return reply(400, { error: { message: 'bad video' } });
      made += 1;
      return reply(200, { id: `container-${made}` });
    }
    if (String(url).includes('/media_publish')) return reply(200, { id: `media-${sent.length}` });
    polls += 1;
    return reply(200, { id: 'x', status_code: statuses[Math.min(polls - 1, statuses.length - 1)] });
  };
  return { sent, send, polls: () => polls };
};
const options = { auth: { accessToken: TOKEN, accountId: IG } };
const noSleep = async () => {};
const reelMedia = [{ url: 'https://files.example.test/v.mp4', kind: 'video' }];

test('the format map names reel, story and carousel; an unmapped name has no spec', () => {
  assert.equal(formatOf('reel').container.media_type, 'REELS');
  assert.deepEqual(formatOf('reel').container.trial_params, { graduation_strategy: 'SS_PERFORMANCE' });
  assert.equal(formatOf('story').container.media_type, 'STORIES');
  assert.equal(formatOf('carousel').container.media_type, 'CAROUSEL');
  assert.equal(formatOf('nothing'), null);
});

test('a reel makes its container with trial_params, waits until FINISHED, then publishes', async () => {
  const g = graphStub({ statuses: ['IN_PROGRESS', 'IN_PROGRESS', 'FINISHED'] });
  const outcome = await publishByFormat({ format: 'reel', options, media: reelMedia, caption: 'words', send: g.send, sleep: noSleep });
  assert.deepEqual(g.sent[0].body, { media_type: 'REELS', caption: 'words', video_url: 'https://files.example.test/v.mp4', trial_params: { graduation_strategy: 'SS_PERFORMANCE' } });
  assert.match(g.sent[0].url, new RegExp(`/${IG}/media\\?access_token=stand-in-token-not-real$`));
  assert.equal(g.polls(), 3);
  assert.deepEqual(g.sent[g.sent.length - 1].body, { creation_id: 'container-1' });
  assert.equal(outcome.state, 'published');
  assert.equal(outcome.post.postId, 'media-5');
});

test('a story makes its STORIES container with image_url and waits before publishing', async () => {
  const g = graphStub();
  const outcome = await publishByFormat({ format: 'story', options, media: [{ url: 'https://files.example.test/s.jpg', kind: 'image' }], send: g.send, sleep: noSleep });
  assert.equal(g.sent[0].body.media_type, 'STORIES');
  assert.equal(g.sent[0].body.image_url, 'https://files.example.test/s.jpg');
  assert.equal(outcome.state, 'published');
});

test('a carousel makes one child per item, then the CAROUSEL container over them, then publishes', async () => {
  const g = graphStub();
  const media = [{ url: 'https://files.example.test/1.jpg', kind: 'image' }, { url: 'https://files.example.test/2.mp4', kind: 'video' }];
  const outcome = await publishByFormat({ format: 'carousel', options, media, caption: 'slides', send: g.send, sleep: noSleep });
  const creations = g.sent.filter(request => request.method === 'POST' && request.url.includes('/media?'));
  assert.deepEqual(creations.map(request => request.body), [
    { image_url: 'https://files.example.test/1.jpg', is_carousel_item: true },
    { media_type: 'VIDEO', video_url: 'https://files.example.test/2.mp4', is_carousel_item: true },
    { media_type: 'CAROUSEL', children: 'container-1,container-2', caption: 'slides' },
  ]);
  assert.deepEqual(g.sent[g.sent.length - 1].body, { creation_id: 'container-3' });
  assert.equal(outcome.state, 'published');
});

test('a carousel with an item that is not FINISHED is not made into a carousel and nothing is published', async () => {
  const g = graphStub({ statuses: ['IN_PROGRESS'] });
  const media = [{ url: 'https://files.example.test/1.jpg', kind: 'image' }, { url: 'https://files.example.test/2.jpg', kind: 'image' }];
  const outcome = await publishByFormat({ format: 'carousel', options, media, send: g.send, sleep: noSleep, maxTries: 2 });
  assert.equal(outcome.state, 'failed');
  assert.match(outcome.message, /item container container-1 is IN_PROGRESS after 2 status asks/);
  assert.equal(g.sent.filter(request => request.body?.media_type === 'CAROUSEL').length, 0);
  assert.ok(!g.sent.some(request => request.url.includes('media_publish')));
});

test('an ERROR container is never published', async () => {
  const g = graphStub({ statuses: ['IN_PROGRESS', 'ERROR'] });
  const outcome = await publishByFormat({ format: 'reel', options, media: reelMedia, send: g.send, sleep: noSleep });
  assert.equal(outcome.state, 'failed');
  assert.match(outcome.message, /ERROR/);
  assert.deepEqual(outcome.retryDisposition, { kind: 'never' });
  assert.ok(!g.sent.some(request => request.url.includes('media_publish')));
});

test('a container that never finishes is refused at the cap, and nothing is published', async () => {
  const g = graphStub({ statuses: ['IN_PROGRESS'] });
  const outcome = await publishByFormat({ format: 'reel', options, media: reelMedia, send: g.send, sleep: noSleep, maxTries: 4 });
  assert.equal(outcome.state, 'failed');
  assert.match(outcome.message, /IN_PROGRESS after 4 status asks/);
  assert.equal(g.polls(), 4);
  assert.ok(!g.sent.some(request => request.url.includes('media_publish')));
});

test('a refused container request is a failed outcome carrying the app\'s own words', async () => {
  const g = graphStub({ createFails: true });
  const outcome = await publishByFormat({ format: 'reel', options, media: reelMedia, send: g.send, sleep: noSleep });
  assert.equal(outcome.state, 'failed');
  assert.match(outcome.message, /bad video/);
});

test('a reel with a cover sends a plain cover story after it publishes, reported beside the main post', async () => {
  const g = graphStub();
  const outcome = await publishByFormat({ format: 'reel', options, media: reelMedia, cover: 'https://files.example.test/cover.jpg', send: g.send, sleep: noSleep });
  const story = g.sent.find(request => request.body?.media_type === 'STORIES');
  assert.deepEqual(story.body, { media_type: 'STORIES', image_url: 'https://files.example.test/cover.jpg' });
  assert.ok(g.sent.indexOf(story) > g.sent.findIndex(request => request.url.includes('media_publish')), 'the story comes after the main post');
  assert.equal(outcome.state, 'published');
  assert.equal(outcome.delivery.cover_story.state, 'published');
  assert.equal(outcome.delivery.cover_story.link_sticker, false);
});

test('a carousel with no cover publishes the carousel and says the cover story was not sent', async () => {
  const g = graphStub();
  const media = [{ url: 'https://files.example.test/1.jpg', kind: 'image' }, { url: 'https://files.example.test/2.jpg', kind: 'image' }];
  const outcome = await publishByFormat({ format: 'carousel', options, media, send: g.send, sleep: noSleep });
  assert.equal(outcome.state, 'published');
  assert.equal(outcome.delivery.cover_story.state, 'not sent');
  assert.ok(!g.sent.some(request => request.body?.media_type === 'STORIES'));
});

test('a failed cover story does not turn the published main post into a failure', async () => {
  const g = graphStub();
  const failingStory = async (url, init = {}) => (init.method === 'POST' && String(url).includes('/media?') && JSON.parse(init.body).media_type === 'STORIES' ? reply(400, { error: { message: 'story refused' } }) : g.send(url, init));
  const outcome = await publishByFormat({ format: 'reel', options, media: reelMedia, cover: 'https://files.example.test/cover.jpg', send: failingStory, sleep: noSleep });
  assert.equal(outcome.state, 'published');
  assert.equal(outcome.delivery.cover_story.state, 'failed');
  assert.match(outcome.delivery.cover_story.message, /story refused/);
});

test('a format with no token is refused before any request leaves', async () => {
  const g = graphStub();
  await assert.rejects(publishByFormat({ format: 'reel', options: { auth: {} }, accountId: '1', media: reelMedia, send: g.send, sleep: noSleep }), /holds no token/);
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
