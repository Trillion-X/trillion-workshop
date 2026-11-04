// test/list-a-channel.test.mjs
//
// computer/list-a-channel.mjs (tool:list-every-video-on-a-channel): a channel's tabs and the extra lists its rules name
// are read and joined into one list of videos, each once, with its kind and the count the page states; a link that
// lists nothing always fails with why. The link reader here is node itself, standing in for yt-dlp through the same
// fetcher row shape: its `list` command prints the answer kept for the link it is given.
import assert from 'node:assert/strict';
import test from 'node:test';
import { channelTools, listSettings } from '../list-a-channel.mjs';

const CHANNEL = 'https://videos.example/@maker';
const UPLOADS = 'https://videos.example/list/UPmaker';
const video = (id, extra = {}) => ({ _type: 'url', id, url: `https://videos.example/watch/${id}`, title: `Video ${id}`, ...extra });
// What each link lists: the channel page holds its tabs (long videos and shorts); the uploads list holds every upload.
const PAGES = {
  [CHANNEL]: {
    _type: 'playlist', id: '@maker', title: 'Maker', channel: 'Maker', channel_id: 'CHmaker', playlist_count: 2,
    entries: [
      { _type: 'playlist', webpage_url: `${CHANNEL}/videos`, entries: [video('a', { duration: 600, view_count: 10 }), video('b', { duration: 300 })] },
      { _type: 'playlist', webpage_url: `${CHANNEL}/shorts`, entries: [video('s1', { url: 'https://videos.example/shorts/s1', thumbnails: [{ url: 'small.jpg', width: 90 }, { url: 'big.jpg', width: 720 }] })] },
      { _type: 'url', ie_key: 'SiteTab', id: 'CHmaker-live', url: `${CHANNEL}/streams` },
    ],
  },
  [UPLOADS]: {
    _type: 'playlist', id: 'UPmaker', title: 'Uploads', playlist_count: 4,
    entries: [video('a', { duration: 600 }), video('s1', { duration: 31, view_count: 5 }), video('b'), video('c', { live_status: 'was_live' })],
  },
  'https://videos.example/list/plain': { _type: 'playlist', id: 'plain', title: 'A list', playlist_count: 3, entries: [video('x'), video('y')] },
  'https://videos.example/list/empty': { _type: 'playlist', id: 'empty', entries: [] },
};
// A fetcher row whose `list` command is a node one-liner printing the kept answer for {url} (or failing for `refuse`).
const fetcherRow = ({ refuse = null } = {}) => ({
  id: 'node-reader', label: 'a link reader', check: [process.execPath], program: process.execPath, update_hint: 'update it',
  list: [process.execPath, '-e', `const pages = ${JSON.stringify(PAGES)}; const url = process.argv[1];
    if (${JSON.stringify(refuse)} && url === ${JSON.stringify(refuse)}) { process.stderr.write('ERROR: HTTP Error 403: Forbidden'); process.exit(1); }
    if (!pages[url]) { process.stderr.write('ERROR: Unsupported URL: ' + url); process.exit(1); }
    console.log(JSON.stringify(pages[url]));`, '{url}'],
});
// The rules of this made-up site, in the shape of the shipped video-list-rule rows.
const rules = [
  {
    id: 'maker-channel',
    when: [{ field: 'url', matches: '^https://videos\\.example/@[^/]+(/(videos|shorts))?$' }],
    read_also: [{ from: { field: 'channel_id', matches: '^CH(.+)$' }, url: 'https://videos.example/list/UP{1}', stated_count: 'playlist_count' }],
    skip: [{ field: 'ie_key', matches: 'Tab$' }],
    kinds: [
      { kind: 'short', when: [{ field: 'url', matches: '/shorts/' }] },
      { kind: 'video', when: [{ field: 'list_url', matches: '/videos$' }] },
    ],
  },
  { id: 'live-status', kinds: [{ kind: 'live', when: [{ field: 'live_status', matches: '^was_live$' }] }] },
];

test('a channel lists every upload once: its tabs and its uploads list joined, each video with its kind', async () => {
  const answer = await channelTools.list({ url: CHANNEL }, {}, { fetchers: [fetcherRow()], rules });
  assert.equal(answer.channel, 'Maker');
  assert.equal(answer.channel_id, 'CHmaker');
  assert.deepEqual(answer.entries.map(entry => [entry.id, entry.kind]), [['a', 'video'], ['s1', 'short'], ['b', 'video'], ['c', 'live']],
    'the uploads list decides the order; the tab entry that is a list is left out');
  assert.equal(answer.count, 4);
  assert.equal(answer.stated_count, 4, 'the count the uploads list states, not the channel page\'s count of tabs');
  assert.equal(answer.complete, true);
  const short = answer.entries.find(entry => entry.id === 's1');
  assert.equal(short.duration_seconds, 31);
  assert.equal(short.view_count, 5);
  assert.equal(short.thumbnail, 'big.jpg', 'a later list fills what the first left unknown, and the largest picture is the thumbnail');
  assert.equal(answer.entries.find(entry => entry.id === 'a').view_count, 10);
  assert.equal(answer.entries.find(entry => entry.id === 'b').duration_seconds, 300);
});

test('a playlist no rule names is listed as it is, with the count it states, and says when it is not whole', async () => {
  const answer = await channelTools.list({ url: 'https://videos.example/list/plain' }, {}, { fetchers: [fetcherRow()], rules });
  assert.deepEqual(answer.entries.map(entry => entry.id), ['x', 'y']);
  assert.equal(answer.stated_count, 3);
  assert.equal(answer.complete, false);
  assert.equal(answer.entries[0].kind, null);
  assert.equal(answer.unread, undefined);
});

test('an extra list that cannot be read never hides the others: it is named under unread', async () => {
  const answer = await channelTools.list({ url: CHANNEL }, {}, { fetchers: [fetcherRow({ refuse: UPLOADS })], rules });
  assert.deepEqual(answer.entries.map(entry => entry.id), ['a', 'b', 's1']);
  assert.equal(answer.unread.length, 1);
  assert.equal(answer.unread[0].url, UPLOADS);
  assert.match(answer.unread[0].error, /403/);
  assert.equal(answer.stated_count, null, 'a channel page counts its tabs, so with its uploads unread nobody states the count');
  assert.equal(answer.complete, null);
});

test('nothing listed never comes back empty: each road says why', async () => {
  await assert.rejects(channelTools.list({ url: CHANNEL }, {}, { fetchers: [], rules }), /no program that lists the videos/);
  await assert.rejects(channelTools.list({ url: 'not a link' }, {}, { fetchers: [fetcherRow()], rules }), /Send the link/);
  await assert.rejects(channelTools.list({ url: 'https://videos.example/list/empty' }, {}, { fetchers: [fetcherRow()], rules }), /lists no videos/);
  await assert.rejects(channelTools.list({ url: 'https://videos.example/unknown' }, {}, { fetchers: [fetcherRow()], rules }), /Could not list https:\/\/videos.example\/unknown on this computer: Unsupported URL/);
  await assert.rejects(channelTools.list({ url: CHANNEL }, {}, { fetchers: [fetcherRow({ refuse: CHANNEL })], rules }), /refused this computer's copy of a link reader; updating it often fixes this \(update it\)/);
});

test('the shipped rows: the link reader has a list command, and a YouTube channel reads its uploads list and its own page', () => {
  const settings = listSettings();
  const reader = settings.fetchers.find(row => Array.isArray(row.list));
  assert.ok(reader?.list.includes('{url}'), 'a link reader can list a link');
  const channel = settings.rules.filter(rule => (rule.when ?? []).every(test => new RegExp(test.matches).test('https://www.youtube.com/@SomeChannel')));
  const also = channel.flatMap(rule => rule.read_also ?? []);
  const id = 'UCabc123';
  const filled = also.map(row => row.url.replace('{1}', new RegExp(row.from.matches).exec(id)[1]));
  assert.deepEqual(filled, ['https://www.youtube.com/playlist?list=UUabc123', 'https://www.youtube.com/channel/UCabc123']);
  assert.ok(also.some(row => row.stated_count), 'the uploads list states the channel\'s count');
  assert.ok(!settings.rules.some(rule => rule.read_also && (rule.when ?? []).every(test => new RegExp(test.matches).test('https://www.youtube.com/playlist?list=PLx'))),
    'a playlist is never widened into its owner\'s uploads');
});
