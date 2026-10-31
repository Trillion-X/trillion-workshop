// The commands around the readers, with the network and yt-dlp stood in for. Every fixture is made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readAFeed } from '../do-work/read-a-feed.mjs';
import { searchThePublicWeb } from '../do-work/search-the-public-web.mjs';
import { fetchText } from '../do-work/fetch-text.mjs';
import { channelVideos, main, Refusal, savedList, videoCaptions } from '../do-work/research-from-this-computer.mjs';
import { writeAProfileRequest } from '../do-work/write-a-profile-request.mjs';

const answering = (body, status = 200, headers = {}) => async () => new Response(body, { status, headers });
const folder = () => mkdtempSync(join(tmpdir(), 'research-test-'));

test('a feed is fetched and read, newest first, cut at the limit', async () => {
  const entries = Array.from({ length: 5 }, (_, i) => `<entry><id>e${i}</id><title>Post ${i}</title><link href="https://news.example/${i}"/></entry>`).join('');
  const seen = [];
  const feed = await readAFeed({ url: 'https://news.example/feed.xml', limit: 3 }, async (url, options) => { seen.push([String(url), options.headers.accept]); return new Response(`<feed><title>Bakery Weekly</title>${entries}</feed>`); });
  assert.equal(feed.source, 'Bakery Weekly');
  assert.equal(feed.count, 3);
  assert.deepEqual(feed.items.map(item => item.item_id), ['e0', 'e1', 'e2']);
  assert.equal(feed.subject_ref, 'https://news.example/feed.xml');
  assert.deepEqual(seen.map(([url]) => url), ['https://news.example/feed.xml']);
  assert.match(seen[0][1], /atom/);
});

test('a feed request that cannot be answered says what to fix', async () => {
  await assert.rejects(readAFeed({}), /Send url/);
  await assert.rejects(readAFeed({ url: 'https://news.example/f', limit: 0 }), /limit is a whole number/);
  await assert.rejects(readAFeed({ url: 'ftp://news.example/f' }), /Only http and https/);
  await assert.rejects(readAFeed({ url: 'not an address' }), /absolute http or https/);
  await assert.rejects(readAFeed({ url: 'https://news.example/f' }, answering('gone', 404)), /HTTP 404/);
  await assert.rejects(readAFeed({ url: 'https://news.example/f' }, async () => { throw new Error('refused'); }), /could not be reached/);
});

test('an answer past the size limit is refused whether it says so or not', async () => {
  await assert.rejects(fetchText('https://news.example/f', { fetchPage: answering('x', 200, { 'content-length': '3000000' }) }), /2 MB/);
  const big = new Response(new ReadableStream({ start(controller) { for (let i = 0; i < 3; i++) controller.enqueue(new Uint8Array(1_000_000)); controller.close(); } }));
  await assert.rejects(fetchText('https://news.example/f', { fetchPage: async () => big }), /2 MB/);
});

test('a public web search reads the one results page and returns cited results', async () => {
  const requested = [];
  const html = '<a class="result__a" href="//search.example/l/?uddg=https%3A%2F%2Fbakery.example%2Fguide">Guide</a><a class="result__snippet">Tips.</a>';
  const found = await searchThePublicWeb({ query: 'bread & hydration' }, async url => { requested.push(String(url)); return new Response(html); });
  assert.deepEqual(requested, ['https://html.duckduckgo.com/html/?q=bread+%26+hydration']);
  assert.equal(found.count, 1);
  assert.equal(found.subject_ref, 'bread & hydration');
  assert.equal(found.items[0].citation.url, 'https://bakery.example/guide');
  await assert.rejects(searchThePublicWeb({ query: '' }), /Send query/);
});

test('a channel is listed through yt-dlp and a listing with nothing in it says why', () => {
  const calls = [];
  const run = (program, args) => { calls.push([program, args]); return { stdout: JSON.stringify({ id: 'vid-aaa', title: 'Shaping', channel: 'Sourdough Notes' }) + '\n', stderr: '' }; };
  const listed = channelVideos({ channel: '@sourdough', limit: 5, ytDlp: '/tools/yt-dlp', run });
  assert.equal(listed.count, 1);
  assert.equal(listed.source, 'Sourdough Notes');
  assert.equal(listed.subject_ref, '@sourdough');
  assert.equal(listed.listing_url, 'https://www.youtube.com/@sourdough/videos');
  assert.equal(calls[0][0], '/tools/yt-dlp');
  assert.deepEqual(calls[0][1].slice(0, 4), ['--flat-playlist', '--dump-json', '--playlist-end', '5']);
  assert.equal(calls[0][1].at(-1), 'https://www.youtube.com/@sourdough/videos');
  assert.throws(() => channelVideos({ channel: '@x', run: () => ({ stdout: '', stderr: 'Sign in to confirm' }) }), error => error.code === 'no-listing' && /Sign in to confirm/.test(error.message));
  assert.throws(() => channelVideos({ channel: '@x', run: () => ({ error: { code: 'ENOENT' } }) }), error => error.code === 'no-yt-dlp');
  assert.throws(() => channelVideos({ channel: '', run }), error => error instanceof Refusal && error.code === 'bad-request');
  assert.throws(() => channelVideos({ channel: '@x', limit: 0, run }), /limit is a whole number/);
});

test('a video\'s captions are read from the file yt-dlp leaves, the original language first, and the work folder goes away', () => {
  let left;
  const run = (program, args) => {
    const prefix = args[args.indexOf('-o') + 1];
    left = prefix;
    writeFileSync(`${prefix}.en.json3`, JSON.stringify({ events: [{ segs: [{ utf8: 'English words' }] }] }));
    writeFileSync(`${prefix}.en-orig.json3`, JSON.stringify({ events: [{ segs: [{ utf8: 'Original words' }] }] }));
    return { stdout: '', stderr: '' };
  };
  const got = videoCaptions({ video: 'vid-aaa', run });
  assert.equal(got.status, 'ready');
  assert.equal(got.transcript, 'Original words');
  assert.equal(got.char_count, 14);
  assert.equal(got.video_id, 'vid-aaa');
  assert.equal(got.url, 'https://www.youtube.com/watch?v=vid-aaa');
  assert.equal(existsSync(left.replace(/\/sub$/, '')), false);
  assert.equal(videoCaptions({ video: 'https://videos.example/watch?v=zzz', run }).video_id, 'zzz');
});

test("captions that exist only as WebVTT are read, and the options reach yt-dlp", () => {
  let asked;
  const run = (program, args) => {
    asked = args;
    writeFileSync(`${args[args.indexOf("-o") + 1]}.en.vtt`, "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nFold the dough\n");
    return { stdout: "", stderr: "" };
  };
  const got = videoCaptions({ video: "vid-aaa", jsRuntimes: "node", run });
  assert.equal(got.transcript, "Fold the dough");
  assert.equal(got.parser, "caption-vtt");
  assert.equal(got.status, "ready");
  assert.equal(asked[asked.indexOf("--sub-format") + 1], "json3/vtt");
  assert.equal(asked[asked.indexOf("--js-runtimes") + 1], "node");
  assert.ok(asked.includes("--write-subs") && asked.includes("--write-auto-sub"));
  videoCaptions({ video: "vid-aaa", run });
  assert.ok(!asked.includes("--js-runtimes"));
});

test('a video with no captions comes back empty with the reason, not as words', () => {
  const got = videoCaptions({ video: 'vid-bbb', run: () => ({ stdout: '', stderr: 'There are no subtitles for the requested languages' }) });
  assert.equal(got.status, 'empty');
  assert.equal(got.has_captions, false);
  assert.equal(got.transcript, '');
  assert.match(got.stderr_tail, /no subtitles/);
  assert.throws(() => videoCaptions({ video: ' ' }), error => error.code === 'bad-request');
});

test('a saved list is read from a file on this computer, in either shape, and the unreadable say so', () => {
  const dir = folder();
  writeFileSync(join(dir, 'list.json'), JSON.stringify([{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }]));
  writeFileSync(join(dir, 'broken.json'), '{nope');
  const read = savedList({ file: join(dir, 'list.json') });
  assert.equal(read.count, 2);
  assert.equal(read.subject_ref, join(dir, 'list.json'));
  assert.equal(savedList({ file: join(dir, 'list.json'), limit: 1 }).count, 1);
  assert.throws(() => savedList({ file: join(dir, 'broken.json') }), error => error.code === 'unreadable-file' && /not valid JSON/.test(error.message));
  assert.throws(() => savedList({ file: join(dir, 'missing.json') }), error => error.code === 'unreadable-file');
  assert.throws(() => savedList({ file: join(dir, 'list.json'), shape: 'other' }), error => error.code === 'bad-request');
  assert.throws(() => savedList({ file: join(dir, 'list.json'), shape: 'browser-sidebar' }), error => error.code === 'unreadable-file' && /No default profile/.test(error.message));
});

test('the command writes the whole answer to --out and prints only a summary', () => {
  const dir = folder();
  const out = join(dir, 'answer.json');
  const run = (program, args) => {
    writeFileSync(`${args[args.indexOf('-o') + 1]}.en.json3`, JSON.stringify({ events: [{ segs: [{ utf8: 'Some long spoken words' }] }] }));
    return { stdout: '', stderr: '' };
  };
  const summary = main(['captions', '--video', 'vid-aaa', '--out', out], run);
  assert.equal(summary.transcript, undefined);
  assert.equal(summary.char_count, 22);
  assert.equal(summary.out, out);
  assert.equal(JSON.parse(readFileSync(out, 'utf8')).transcript, 'Some long spoken words');
  assert.throws(() => main(['captions', '--video', 'vid-aaa'], run), error => error.code === 'bad-request' && /--out/.test(error.message));
  assert.throws(() => main(['unknown', '--out', out], run), /channel, captions or saved-list/);
  assert.throws(() => main(['channel', '--channel'], run), /needs a value/);
});

test('run as a program, the command prints {"failed"} and exits 2 when it cannot do the job', async () => {
  const dir = folder();
  const result = await new Promise(resolve => {
    execFile('node', [new URL('../do-work/research-from-this-computer.mjs', import.meta.url).pathname, 'saved-list', '--file', join(dir, 'none.json'), '--out', join(dir, 'o.json')],
      (error, stdout) => resolve({ code: error?.code, last: JSON.parse(stdout.trim().split('\n').at(-1)) }));
  });
  assert.equal(result.code, 2);
  assert.equal(result.last.failed.code, 'unreadable-file');
});

test('a profile request puts the person\'s instruction before each piece of material, one request per piece', () => {
  const asked = writeAProfileRequest({
    subject_ref: 'sourdough-notes', instruction: 'Look for how they open a lesson. Material: ',
    evidence: [{ id: 'vid-aaa', text: 'Fold the dough.' }, { id: 'vid-bbb', text: '  ' }, { id: 'vid-ccc', text: 'Score it.' }],
  });
  assert.equal(asked.profile_ref, 'profile:sourdough-notes');
  assert.deepEqual(asked.skipped, ['vid-bbb']);
  assert.deepEqual(asked.requests.map(request => request.request_id), ['sourdough-notes:vid-aaa', 'sourdough-notes:vid-ccc']);
  assert.equal(asked.requests[0].instruction_text, 'Look for how they open a lesson. Material: Fold the dough.');
  assert.equal(asked.requests[0].status, 'requested');
  assert.equal(asked.requests[0].output_kind, 'profile');
  const whole = writeAProfileRequest({ subject_ref: 'a topic', instruction: 'Read: ', material: 'All of it', profile_ref: 'profile:mine', output_kind: 'notes' });
  assert.equal(whole.requests[0].request_id, 'a topic');
  assert.equal(whole.requests[0].profile_ref, 'profile:mine');
  assert.equal(whole.requests[0].output_kind, 'notes');
});

test('a profile request with no subject, no instruction or nothing to profile says what to send', () => {
  assert.throws(() => writeAProfileRequest({ instruction: 'x', material: 'y' }), /Send subject_ref/);
  assert.throws(() => writeAProfileRequest({ subject_ref: 's', material: 'y' }), /Send instruction/);
  assert.throws(() => writeAProfileRequest({ subject_ref: 's', instruction: 'x', evidence: [{ id: 'a', text: '' }] }), /nothing to profile/);
});
