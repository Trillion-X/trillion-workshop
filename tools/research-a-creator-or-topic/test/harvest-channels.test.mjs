// tools/research-a-creator-or-topic/test/harvest-channels.test.mjs
//
// tool:keep-channels-latest-videos-and-captions against a stand-in yt-dlp (test/stand-in/yt-dlp) that answers a
// made-up site from a plan file, and the stand-in records door. Every channel, video and word here is made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openRecordsDoor } from 'trillion-workshop/tools/records-door/read-data/records-door.mjs';
import { startFakeDoor } from 'trillion-workshop/tools/records-door/test/fake-door.mjs';
import { findProgram, keepChannelsLatestVideosAndCaptions as keep, pickCaptionFile, readRequest, readSettings } from '../do-work/harvest-channels.mjs';
import { readCaptionLines } from '../do-work/sources.mjs';

const shipped = readSettings();
const rows = JSON.parse(readFileSync(new URL('../tool-rows.json', import.meta.url), 'utf8')).records.map(record => record.payload);
const row = rows.find(payload => payload.id === 'tool:keep-channels-latest-videos-and-captions');
const WATCH = 'https://videos.example/watch?v=';
const LOAVES = 'https://videos.example/@loaf-lab';
const JAMS = 'https://videos.example/playlist?list=PL-jams';
const json3 = lines => JSON.stringify({ events: [{ tStartMs: 0 }, ...lines.map(([ms, words]) => ({ tStartMs: ms, segs: [{ utf8: words }] }))] });
const asking = { seeds: [LOAVES], newest: 3, caption_languages: ['en.*'] };

// The shipped settings, with the stand-in as the program, no waits and the made-up site's watch address.
const settingsWith = (changes = {}) => ({
  ...shipped,
  program: { ...shipped.program, places: [fileURLToPath(new URL('./stand-in/', import.meta.url))], places_under_home: [] },
  watch_address_start: WATCH,
  seconds_between_requests: { least: 0, most: 0 },
  ...changes,
});

const video = (id, title, extra = {}) => ({ info: { id, title, channel: 'Loaf Lab', duration: 300, view_count: 40, formats: [{ format_id: 'f1' }], ...extra.info }, ...extra });
function site(changes = {}) {
  const plan = {
    [`${LOAVES}/videos`]: {
      videos: [
        { id: 'vid-aaa', title: 'Shaping a loaf', channel: 'Loaf Lab', upload_date: '20260105', duration_string: '5:00', view_count: 40 },
        { id: 'vid-bbb', title: 'Scoring' },
        { id: 'vid-ccc', title: 'Proofing' },
        { id: 'vid-ddd', title: 'Cooling' },
      ],
    },
    [JAMS]: { videos: [{ id: 'vid-eee', title: 'Plum jam', channel: 'Jar Shelf' }, { id: 'vid-aaa', title: 'Shaping a loaf' }] },
    [`${WATCH}vid-aaa`]: video('vid-aaa', 'Shaping a loaf', {
      captions: { 'fr.json3': json3([[0, 'Plier']]), 'en.vtt': 'WEBVTT\n\n00:00.000 --> 00:01.000\nfold\n', 'en.json3': json3([[0, 'Fold the dough'], [2500, 'then shape it']]) },
      comments: [{ id: 'c1', text: 'Nice crumb', author: 'A baker', like_count: 3, author_thumbnail: 'https://videos.example/a.png' }],
    }),
    [`${WATCH}vid-bbb`]: video('vid-bbb', 'Scoring'),
    [`${WATCH}vid-ccc`]: { error: 'Video unavailable' },
    [`${WATCH}vid-ddd`]: video('vid-ddd', 'Cooling', { captions: { 'en.json3': json3([[0, 'Let it cool']]) } }),
    [`${WATCH}vid-eee`]: video('vid-eee', 'Plum jam', { captions: { 'en-orig.vtt': 'WEBVTT\n\n00:01.500 --> 00:03.000\nStir the plums\n' } }),
    ...changes,
  };
  const folder = mkdtempSync(join(tmpdir(), 'harvest-'));
  process.env.STAND_IN_PLAN = join(folder, 'plan.json');
  process.env.STAND_IN_LOG = join(folder, 'calls.jsonl');
  writeFileSync(process.env.STAND_IN_PLAN, JSON.stringify(plan));
  writeFileSync(process.env.STAND_IN_LOG, '');
  const out = join(folder, 'out');
  const lines = path => readFileSync(path, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
  return {
    out,
    calls: () => lines(join(folder, 'calls.jsonl')),
    captions: () => lines(join(out, 'captions.jsonl')),
    comments: () => lines(join(out, 'comments.jsonl')),
    listing: () => JSON.parse(readFileSync(join(out, 'listing.json'), 'utf8')),
  };
}

test('it lists each seed\'s newest videos and keeps the captions, description and timed lines of each, one request at a time', async () => {
  const made = site();
  const answer = await keep(asking, {}, { settings: settingsWith(), out: made.out });
  assert.equal(answer.stopped, 'finished');
  assert.equal(answer.again, null);
  assert.equal(answer.requests, 4);
  assert.deepEqual(answer.captions, { ready: 1, empty: 1, failed: [{ video_id: 'vid-ccc', reason: 'ERROR: [site] Video unavailable' }] });
  assert.deepEqual(answer.seeds, [{ seed: LOAVES, listing_url: `${LOAVES}/videos`, source: 'Loaf Lab', listed: 3, kept: 3, comments_kept: 0, finished: true }]);
  const calls = made.calls();
  assert.deepEqual(calls[0].slice(-3), ['--playlist-end', '3', `${LOAVES}/videos`]);
  assert.deepEqual(calls.slice(1).map(call => call.at(-1)), ['vid-aaa', 'vid-bbb', 'vid-ccc'].map(id => `${WATCH}${id}`));
  for (const call of calls) {
    assert.ok(call.includes('--ignore-config'));
    assert.equal(call[call.indexOf('--js-runtimes') + 1], `node:${process.execPath}`);
  }
  assert.equal(calls[1][calls[1].indexOf('--sub-langs') + 1], 'en.*');
  assert.ok(!calls[1].includes('--write-comments'));
  const [first, second, third] = made.captions();
  assert.deepEqual(first, {
    video_id: 'vid-aaa', url: `${WATCH}vid-aaa`, seed: LOAVES, status: 'ready', language: 'en', format: 'json3',
    lines: [[0, 'Fold the dough'], [2.5, 'then shape it']], info: { id: 'vid-aaa', title: 'Shaping a loaf', channel: 'Loaf Lab', duration: 300, view_count: 40 },
  });
  assert.equal(second.status, 'empty');
  assert.equal(third.status, 'failed');
  assert.deepEqual(made.comments(), []);
  assert.deepEqual(made.listing().seeds[0].items[0], {
    video_id: 'vid-aaa', title: 'Shaping a loaf', url: `${WATCH}vid-aaa`, published: '20260105', duration: '5:00', view_count: 40, kept_before: false,
  });
  assert.equal(made.listing().seeds[0].items.length, 3);
});

test('a video already kept is listed and never fetched again, across seeds too', async () => {
  const made = site();
  const answer = await keep({ ...asking, seeds: [LOAVES, JAMS], newest: 2, skip_ids: ['vid-bbb'] }, {}, { settings: settingsWith(), out: made.out });
  assert.deepEqual(made.calls().map(call => call.at(-1)), [`${LOAVES}/videos`, `${WATCH}vid-aaa`, JAMS, `${WATCH}vid-eee`]);
  assert.deepEqual(made.listing().seeds.map(seed => seed.items.map(item => [item.video_id, item.kept_before])), [[['vid-aaa', false], ['vid-bbb', true]], [['vid-eee', false], ['vid-aaa', true]]]);
  assert.deepEqual(made.captions()[1].lines, [[1.5, 'Stir the plums']]);
  assert.equal(made.captions()[1].format, 'vtt');
  assert.deepEqual(answer.seeds.map(seed => [seed.listed, seed.kept]), [[2, 2], [2, 2]]);
});

test('a refusal ends the run at once and says how long to wait, doubling for each refusal in a row', async () => {
  const made = site({ [`${WATCH}vid-bbb`]: { refuse: 'Sign in to confirm you’re not a bot' } });
  const answer = await keep({ ...asking, seeds: [LOAVES, JAMS], refusals_in_a_row: 2 }, {}, { settings: settingsWith(), out: made.out });
  assert.equal(answer.stopped, 'refusal');
  assert.equal(answer.wait_minutes, shipped.pause_after_refusal.first_minutes * 4);
  assert.deepEqual(answer.again, { ...asking, seeds: [LOAVES, JAMS], skip_ids: ['vid-aaa'], refusals_in_a_row: 3 });
  assert.equal(made.calls().length, 3);
  assert.deepEqual(made.captions().map(line => line.video_id), ['vid-aaa']);

  const capped = site({ [`${WATCH}vid-aaa`]: { refuse: 'HTTP Error 429: Too Many Requests' } });
  const many = await keep({ ...asking, refusals_in_a_row: 50 }, {}, { settings: settingsWith(), out: capped.out });
  const { first_minutes: first, doublings_at_most: doublings } = shipped.pause_after_refusal;
  assert.equal(many.wait_minutes, first * 2 ** doublings);
  assert.deepEqual(many.again.skip_ids, []);
});

test('a run that ends for any other reason starts the next one with no refusals counted', async () => {
  const made = site();
  const answer = await keep({ ...asking, refusals_in_a_row: 2 }, {}, { settings: settingsWith({ requests_per_run_at_most: 2 }), out: made.out });
  assert.equal(answer.stopped, 'requests');
  assert.equal(answer.wait_minutes, undefined);
  assert.deepEqual(answer.again, { ...asking, skip_ids: ['vid-aaa'] });
  assert.equal(made.listing().seeds.length, 1);
});

test('waits are drawn from the range between requests, and no request starts without the time it needs', async () => {
  const made = site();
  let clock = 0;
  const waits = [];
  const settings = settingsWith({ seconds_between_requests: { least: 2, most: 6 }, least_seconds_for_a_request: 8 });
  const answer = await keep({ ...asking, budget_seconds: 20 }, {}, {
    settings, out: made.out, now: () => clock, random: () => 0.75, sleep: async seconds => { waits.push(seconds); clock += seconds; },
  });
  assert.deepEqual(waits, [5, 5]);
  assert.equal(answer.requests, 3);
  assert.equal(answer.stopped, 'budget');
  assert.deepEqual(answer.again.skip_ids, ['vid-aaa', 'vid-bbb']);
});

test('a request still running when the budget ends is stopped, and its video is left for the next run', async () => {
  const made = site({ [`${WATCH}vid-aaa`]: { ...video('vid-aaa', 'Shaping a loaf'), wait_seconds: 5 } });
  const answer = await keep({ ...asking, budget_seconds: 2 }, {}, { settings: settingsWith({ least_seconds_for_a_request: 1 }), out: made.out });
  assert.equal(answer.stopped, 'budget');
  assert.deepEqual(made.captions(), []);
  assert.deepEqual(answer.again.skip_ids, []);
  assert.ok(answer.seconds < 4.5, `stopped after ${answer.seconds} s`);
});

test('comments, when asked for, come from the same request with only the kept fields', async () => {
  const made = site();
  const answer = await keep({ ...asking, newest: 1, also: ['comments'], comments_per_video: 5 }, {}, { settings: settingsWith(), out: made.out });
  const call = made.calls()[1];
  assert.ok(call.includes('--write-comments'));
  assert.ok(call.some(arg => arg.includes('max_comments=5,')));
  assert.equal(answer.comments, 1);
  assert.deepEqual(made.comments(), [{ video_id: 'vid-aaa', comments: [{ id: 'c1', author: 'A baker', text: 'Nice crumb', like_count: 3 }] }]);
  assert.equal(answer.seeds[0].comments_kept, 1, 'the seed says how many comments were kept');
});

test('a file that would pass its bound ends the run before the line that does not fit', async () => {
  const whole = site();
  await keep(asking, {}, { settings: settingsWith(), out: whole.out });
  const firstLine = Buffer.byteLength(`${JSON.stringify(whole.captions()[0])}\n`);
  const made = site();
  const answer = await keep(asking, {}, { settings: settingsWith({ file_bytes_at_most: firstLine + 1 }), out: made.out });
  assert.equal(answer.stopped, 'files');
  assert.deepEqual(made.captions().map(line => line.video_id), ['vid-aaa']);
  assert.deepEqual(answer.again.skip_ids, ['vid-aaa']);

  const small = site();
  const one = await keep({ ...asking, newest: 1 }, {}, { settings: settingsWith({ file_bytes_at_most: 200 }), out: small.out });
  assert.deepEqual(one.captions.failed, [{ video_id: 'vid-aaa', reason: 'its captions are larger than one file holds' }]);
  assert.equal(one.stopped, 'finished');
});

test('rows go into the list through the door, over the row already held', async () => {
  const door = await startFakeDoor({
    rights: row.invoke.records.rights,
    mostWrites: row.invoke.records.most_writes,
    records: [{ id: 'record:sources:vid-aaa', type: 'record:sources', value: { note: 'kept by hand', name: 'old name' } }],
  });
  try {
    const made = site();
    const rowsAsked = { one_per: 'video', id: { fact: 'video_id' }, fields: { name: { fact: 'title' }, url: { fact: 'url' }, words: { text: '{caption_status} in {caption_language}' }, kind: { value: 'video' } } };
    const answer = await keep({ ...asking, newest: 2, rows: rowsAsked }, { door: openRecordsDoor({ descriptor: door.descriptor }) }, { settings: settingsWith(), out: made.out });
    assert.deepEqual(answer.rows, { written: 2, refused: [] });
    assert.deepEqual(door.kept.get('record:sources:vid-aaa').value, { note: 'kept by hand', name: 'Shaping a loaf', url: `${WATCH}vid-aaa`, words: 'ready in en', kind: 'video' });
    assert.deepEqual(door.kept.get('record:sources:vid-bbb').value, { name: 'Scoring', url: `${WATCH}vid-bbb`, words: 'empty in ', kind: 'video' });

    const seedRows = { one_per: 'seed', id: { text: 'loaves' }, fields: { name: { fact: 'source' }, listed: { fact: 'listed' }, kept: { fact: 'kept' } } };
    const bySeed = await keep({ ...asking, newest: 2, skip_ids: ['vid-aaa', 'vid-bbb'], rows: seedRows }, { door: openRecordsDoor({ descriptor: door.descriptor }) }, { settings: settingsWith(), out: made.out });
    assert.deepEqual(bySeed.rows, { written: 1, refused: [] });
    assert.deepEqual(door.kept.get('record:sources:loaves').value, { name: 'Loaf Lab', listed: 2, kept: 2 });

    const byLink = await keep({ ...asking, newest: 1, skip_ids: ['vid-aaa'], rows: { ...seedRows, id: { fact: 'seed' } } }, { door: openRecordsDoor({ descriptor: door.descriptor }) }, { settings: settingsWith(), out: made.out });
    assert.deepEqual(byLink.rows, { written: 0, refused: [{ for: LOAVES, reason: 'its id is empty or holds a /' }] });
  } finally { await door.close(); }
});

test('rows the door refuses leave the run\'s videos to be settled again', async () => {
  const door = await startFakeDoor({ rights: [] });
  try {
    const made = site();
    const answer = await keep({ ...asking, newest: 1, skip_ids: ['vid-zzz'], rows: { one_per: 'video', id: { fact: 'video_id' }, fields: { name: { fact: 'title' } } } },
      { door: openRecordsDoor({ descriptor: door.descriptor }) }, { settings: settingsWith(), out: made.out });
    assert.equal(answer.rows.written, 0);
    assert.match(answer.rows.error, /^current_workspace_rights_refused: /);
    assert.deepEqual(answer.again.seeds, [LOAVES]);
    assert.deepEqual(answer.again.skip_ids, ['vid-zzz']);
  } finally { await door.close(); }
});

const DATED = 'https://videos.example/@dated-lab';
const dated = [
  ['vid-d10', '20260610'], ['vid-d09', '20260520'], ['vid-d08', '20260410'], ['vid-d07', '20260301'], ['vid-d06', '20260215'],
  ['vid-d05', '20260110'], ['vid-d04', '20251220'], ['vid-d03', '20250601'], ['vid-nodate', ''],
];
const datedSite = () => site({
  [`${DATED}/videos`]: { videos: dated.map(([id, upload_date]) => ({ id, title: id, upload_date })) },
  ...Object.fromEntries(dated.map(([id]) => [`${WATCH}${id}`, video(id, id, { captions: { 'en.json3': json3([[0, id]]) } })])),
});
const keptIds = (made, seed = 0) => made.listing().seeds[seed].items.map(item => item.video_id);

test('a seed can carry the id of the row it updates and its own newest, and rows update that row', async () => {
  const door = await startFakeDoor({
    rights: row.invoke.records.rights,
    mostWrites: row.invoke.records.most_writes,
    records: [{ id: 'record:sources:outlet-p01', type: 'record:sources', value: { note: 'kept by hand' } }],
  });
  try {
    const made = site();
    const seeds = [{ seed: LOAVES, id: 'outlet-p01', newest: 1 }, { seed: JAMS, id: 'outlet-p02' }];
    const rowsAsked = { one_per: 'seed', fields: { name: { fact: 'source' }, listed: { fact: 'listed' } } };
    const answer = await keep({ seeds, newest: 2, caption_languages: ['en.*'], rows: rowsAsked }, { door: openRecordsDoor({ descriptor: door.descriptor }) }, { settings: settingsWith(), out: made.out });
    assert.deepEqual(answer.rows, { written: 2, refused: [] });
    assert.deepEqual(answer.seeds.map(seed => [seed.row_id, seed.listed]), [['outlet-p01', 1], ['outlet-p02', 2]]);
    assert.deepEqual(door.kept.get('record:sources:outlet-p01').value, { note: 'kept by hand', name: 'Loaf Lab', listed: 1 });
    assert.deepEqual(door.kept.get('record:sources:outlet-p02').value, { name: 'Jar Shelf', listed: 2 });

    const later = site();
    const stopped = await keep({ seeds, newest: 2, caption_languages: ['en.*'] }, {}, { settings: settingsWith({ requests_per_run_at_most: 1 }), out: later.out });
    assert.deepEqual(stopped.again.seeds, seeds);
  } finally { await door.close(); }
});

test('days and eras choose from the listing: the newest inside the days, or an even share of each span', async () => {
  const inWindow = datedSite();
  await keep({ seeds: [DATED], newest: 3, between: { from: '2026-01-01', to: '2026-05-31' }, caption_languages: ['en.*'] }, {}, { settings: settingsWith(), out: inWindow.out });
  assert.deepEqual(inWindow.calls()[0].slice(-3), ['--playlist-end', String(shipped.window_list_at_most), `${DATED}/videos`]);
  assert.deepEqual(keptIds(inWindow), ['vid-d09', 'vid-d08', 'vid-d07']);

  const eras = datedSite();
  const answer = await keep({ seeds: [DATED], newest: 4, eras: 2, caption_languages: ['en.*'] }, {}, { settings: settingsWith(), out: eras.out });
  assert.deepEqual(eras.listing().seeds[0].items.map(item => [item.video_id, item.era]), [['vid-d10', 2], ['vid-d09', 2], ['vid-d03', 1]]);
  assert.equal(answer.seeds[0].undated, 1);
  assert.equal(answer.seeds[0].listed, 3, 'a span with fewer videos than its share gives what it has');

  const odd = datedSite();
  await keep({ seeds: [DATED], newest: 3, eras: 2, caption_languages: ['en.*'] }, {}, { settings: settingsWith(), out: odd.out });
  assert.deepEqual(keptIds(odd), ['vid-d10', 'vid-d09', 'vid-d03']);

  const none = datedSite();
  const empty = await keep({ seeds: [DATED], newest: 3, between: { from: '2030-01-01' }, caption_languages: ['en.*'] }, {}, { settings: settingsWith(), out: none.out });
  assert.equal(empty.seeds[0].error, 'the site listed no videos inside the days asked for');
  assert.equal(empty.again, null);
});

test('a comment mix reads comments for videos spread across the seed and keeps some of each kind, once each', async () => {
  const comment = (id, text, timestamp) => ({ id, text, timestamp, author: 'a', like_count: 1 });
  const comments = [
    comment('c1', 'Is this the same dough?', 300), comment('c2', 'You are wrong, this is nonsense', 100), comment('c3', 'first', 50),
    comment('c4', 'Nice', 900), comment('c5', 'Why not rest it longer?', 400), comment('c6', 'Disagree with the scoring', 700),
  ];
  const made = datedSite();
  const plan = JSON.parse(readFileSync(process.env.STAND_IN_PLAN, 'utf8'));
  plan[`${WATCH}vid-d09`] = video('vid-d09', 'vid-d09', { comments });
  writeFileSync(process.env.STAND_IN_PLAN, JSON.stringify(plan));
  const asked = { seeds: [DATED], newest: 2, caption_languages: ['en.*'], comment_mix: { videos: 1, read: 20, question: 1, disagreement: 1, oldest: 1, newest: 1 } };
  const answer = await keep(asked, {}, { settings: settingsWith(), out: made.out });
  assert.equal(answer.comments, 1);
  const calls = made.calls();
  assert.deepEqual(calls.map(call => call.includes('--write-comments')), [false, false, true]);
  assert.ok(calls[2].some(arg => arg.includes('max_comments=20,')));
  const [line] = made.comments();
  assert.equal(line.video_id, 'vid-d09');
  assert.equal(line.read, 6);
  assert.deepEqual(line.comments.map(item => [item.kind, item.id]), [['question', 'c1'], ['disagreement', 'c2'], ['oldest', 'c3'], ['newest', 'c4']]);
});

test('the input is checked whole before any request', () => {
  const settings = settingsWith();
  const refused = (input, words) => assert.throws(() => readRequest(input, settings), words);
  refused({ seeds: [LOAVES], newest: 3 }, /caption_languages is a list of 1 to/);
  refused({ ...asking, newest: 0 }, /newest is a whole number from 1 to/);
  refused({ ...asking, seeds: [] }, /seeds is a list of 1 to/);
  refused({ ...asking, caption_languages: ['en us'] }, /language codes/);
  refused({ ...asking, colour: 'red' }, /Unknown input: colour/);
  refused({ ...asking, also: ['audio'] }, /also holds only: comments/);
  refused({ ...asking, also: ['comments'] }, /comments_per_video is a whole number/);
  refused({ ...asking, comments_per_video: 3 }, /goes with also/);
  refused({ ...asking, budget_seconds: shipped.budget_seconds.most + 1 }, /budget_seconds is a whole number/);
  refused({ ...asking, rows: { one_per: 'channel', id: { fact: 'seed' }, fields: { a: { fact: 'seed' } } } }, /one_per/);
  refused({ ...asking, rows: { one_per: 'seed', id: { fact: 'seed', text: 'x' }, fields: { a: { fact: 'seed' } } } }, /rows.id is one of/);
  refused({ ...asking, rows: { one_per: 'seed', id: { fact: 'seed' }, fields: {} } }, /names at least one field/);
  refused({ ...asking, newest: undefined }, /newest is needed: .* has none of its own/);
  refused({ ...asking, seeds: [{ seed: LOAVES, colour: 'red' }] }, /Each seed is words/);
  refused({ ...asking, seeds: [{ seed: LOAVES, id: 'a/b' }] }, /id is a word without a \//);
  refused({ ...asking, between: { from: '2026-13-40' } }, /between is/);
  refused({ ...asking, between: { from: '2026-05-01', to: '2026-01-01' } }, /not after/);
  refused({ ...asking, eras: 1 }, /eras is a whole number from 2 to/);
  refused({ ...asking, comment_mix: { videos: 1 } }, /at least one comment/);
  refused({ ...asking, comment_mix: { videos: 1, question: 1 }, also: ['comments'], comments_per_video: 2 }, /two ways to ask/);
  refused({ ...asking, rows: { one_per: 'seed', fields: { a: { fact: 'seed' } } } }, /rows.id is needed/);
  assert.equal(readRequest({ seeds: [{ seed: LOAVES, newest: 2 }], caption_languages: ['en.*'] }, settings).seeds[0].newest, 2);
  assert.equal(readRequest(asking, settings).budget, shipped.budget_seconds.default);
});

test('the program is found in the folders the settings name, and a missing one is refused in plain words', () => {
  const settings = settingsWith();
  assert.equal(findProgram(settings.program), fileURLToPath(new URL('./stand-in/yt-dlp', import.meta.url)));
  assert.throws(() => findProgram({ ...settings.program, name: 'no-such-program-here' }), /no-such-program-here was not found on this computer/);
});

test('caption files are read into timed lines, and picked by the order of the languages asked for', () => {
  assert.deepEqual(readCaptionLines('v.en.json3', json3([[0, 'Fold '], [1234, 'Fold'], [2000, ' the\ndough ']])), [[0, 'Fold'], [2, 'the dough']]);
  const vtt = 'WEBVTT\nKind: captions\n\n1\n00:00:01.250 --> 00:00:02.000\n<c>Fold</c> &amp; shape\n\n00:00:02.000 --> 00:00:03.000\nFold &amp; shape\nthe loaf\n\nNOTE made up\n\n01:02:03.500 --> 01:02:04.000\nend';
  assert.deepEqual(readCaptionLines('v.en.vtt', vtt), [[1.25, 'Fold & shape'], [2, 'the loaf'], [3723.5, 'end']]);
  assert.deepEqual(readCaptionLines('v.en.json3', 'not json'), []);
  const names = ['vid-aaa.info.json', 'vid-aaa.fr.json3', 'vid-aaa.en.vtt', 'vid-aaa.en.json3', 'vid-aaa.en-orig.vtt', 'other.en.json3'];
  assert.deepEqual(pickCaptionFile(names, 'vid-aaa', ['en-orig', 'en']), { name: 'vid-aaa.en-orig.vtt', kind: 'vtt', language: 'en-orig', rank: 0 });
  assert.equal(pickCaptionFile(names, 'vid-aaa', ['en.*', '-live_chat']).name, 'vid-aaa.en.json3');
  assert.equal(pickCaptionFile(names, 'vid-aaa', ['de']), null);
  assert.equal(pickCaptionFile(['vid-aaa.en-de.json3', 'vid-aaa.en.json3'], 'vid-aaa', ['en.*']).name, 'vid-aaa.en.json3');
});

test('the row packs what the tool reads, keeps its files by the settings\' bound, and holds the rights the settings name', () => {
  const { invoke } = row;
  const at = invoke.files.package_files.find(item => item.package === 'research-a-creator-or-topic');
  assert.equal(invoke.workdir, at.at);
  assert.deepEqual(invoke.outputs.map(output => [output.name, output.path, output.max_bytes]), [
    ['listing', `${at.at}/out/listing.json`, shipped.file_bytes_at_most],
    ['captions', `${at.at}/out/captions.jsonl`, shipped.file_bytes_at_most],
    ['comments', `${at.at}/out/comments.jsonl`, shipped.file_bytes_at_most],
  ]);
  assert.deepEqual(invoke.records.rights, [{ kind: shipped.records.type, prefix: shipped.records.id_start, operations: ['records:read', 'records:write'] }]);
  assert.equal(invoke.records.most_writes, shipped.records.writes_at_most);
  assert.equal(row.input_schema.properties.budget_seconds.maximum, shipped.budget_seconds.most);
  assert.equal(row.input_schema.properties.newest.maximum, shipped.newest_at_most);
  assert.equal(row.input_schema.properties.eras.maximum, shipped.eras_at_most);
  assert.equal(row.input_schema.properties.comment_mix.properties.videos.maximum, shipped.comment_mix.videos_at_most);
  assert.equal(row.input_schema.properties.comment_mix.properties.question.maximum, shipped.comment_mix.each_at_most);
  assert.equal(row.input_schema.properties.seeds.maxItems, shipped.seeds_at_most);
  assert.equal(row.input_schema.properties.comments_per_video.maximum, shipped.comments_per_video_at_most);
  assert.equal(row.input_schema.properties.skip_ids.maxItems, shipped.skip_ids_at_most);
  assert.equal(row.input_schema.properties.caption_languages.maxItems, shipped.languages_at_most);
  assert.ok(shipped.budget_seconds.most * 1000 < 120000, 'a run ends before the engine\'s deadline');
  assert.ok(shipped.seconds_between_requests.least > 0 && shipped.seconds_between_requests.least <= shipped.seconds_between_requests.most);
});
