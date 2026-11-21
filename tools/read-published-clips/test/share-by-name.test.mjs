// The share step on a fake Files door and a fake database read: each clip's cut and stills are shared by NAME only, under the
// published folder, with the short link; a clip without a published name is never shared; the answer has no identity or name.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readPublishedClips, LINK_SECONDS } from '../do-work/read-published-clips-run.mjs';

const hex = char => char.repeat(64);
const name = char => `/published-clips/${hex(char)}.mp4`;
const stillsOf = char => ({ left: `/published-clips/${hex(char)}-left.jpg`, right: `/published-clips/${hex(char)}-right.jpg` });

// A fake files door: records each share and answers a link named after it.
function fakeDoor() {
  const calls = [];
  return { calls, files: async (operation, input) => { calls.push({ operation, input }); return { url: `https://files.example/${input.name_or_identity.split('/').pop()}?sig=x` }; } };
}

// The rows the fenced select answers (the read is run by the engine; the site never sees these rows).
const rows = [
  { id: 'record:recording-moment:clip-a', moment: 'comparison', kind: 'comparison', aspect: '16x9', cut: `1f:${hex('a')}`, picture: null, published_file_name: name('a'), captured_day: '2026-11-01', extra: { kind: 'comparison', pair: { left: { person: 'Learner A', day: '2026-10-01' }, right: { person: 'Learner A', day: '2026-11-01' } } } },
  { id: 'record:recording-moment:clip-r', moment: 'reel', kind: 'reel', aspect: '9x16', cut: `1f:${hex('r')}`, picture: null, published_file_name: name('r'), captured_day: '2026-11-02', extra: { kind: 'reel', aspect: '9x16' } },
];

test('each clip shares its cut and its comparison stills by name, under the published folder, for the short link', async () => {
  const door = fakeDoor();
  const answer = await readPublishedClips({ database: 'example', use: { purpose: 'publish', surface: 'site' } }, { door, runQuery: async () => ({ rows }) });
  const named = door.calls.map(call => call.input.name_or_identity);
  assert.ok(named.every(file => file.startsWith('/published-clips/')), 'every share is under the published folder');
  assert.ok(door.calls.every(call => call.operation === 'share_file' && call.input.seconds === LINK_SECONDS));
  assert.ok(named.includes(name('a')) && named.includes(stillsOf('a').left) && named.includes(stillsOf('a').right));
  assert.equal(answer.clips[0].cut_url, `https://files.example/${hex('a')}.mp4?sig=x`);
  assert.equal(answer.clips[0].pair.left.cut_url, undefined, 'a side carries its still, not a video');
  assert.ok(named.includes(`/published-clips/${hex('r')}.jpg`), 'a reel shares its cover, <id>.jpg');
  assert.equal(answer.clips[1].picture_url, `https://files.example/${hex('r')}.jpg?sig=x`);
  assert.equal(answer.clips[0].pair.left.picture_url, `https://files.example/${hex('a')}-left.jpg?sig=x`);
});

test('the answer carries links only: no identity, no name, no path', async () => {
  const door = fakeDoor();
  const answer = await readPublishedClips({ database: 'example', use: { purpose: 'publish', surface: 'site' } }, { door, runQuery: async () => ({ rows }) });
  const text = JSON.stringify(answer);
  assert.equal(text.includes('1f:'), false);
  assert.equal(text.includes('/published-clips/'), false);
});

test('a clip with no published name is never shared', async () => {
  const door = fakeDoor();
  await readPublishedClips({ database: 'example', use: { purpose: 'publish', surface: 'site' } }, { door, runQuery: async () => ({ rows: [] }) });
  assert.equal(door.calls.length, 0);
});

test('the request must name the database and the use, and a refused request shares nothing', async () => {
  const door = fakeDoor();
  await assert.rejects(readPublishedClips({ use: { purpose: 'publish', surface: 'site' } }, { door, runQuery: async () => ({ rows }) }), /database/);
  await assert.rejects(readPublishedClips({ database: 'example', purpose: 'publish', surface: 'site' }, { door, runQuery: async () => ({ rows }) }), /use/);
  assert.equal(door.calls.length, 0);
});
