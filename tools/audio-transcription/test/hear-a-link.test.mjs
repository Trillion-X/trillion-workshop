// tools/audio-transcription/test/hear-a-link.test.mjs
//
// read-data/hear-here.mjs (tool:hear-a-link): a link's captions win when the page has them, otherwise
// its sound is heard on the computer, and a link that yields no words always fails with why, never an empty answer.
// Moved from the product repo's test/hear-a-link.test.mjs with its assertions.
// The link reader here is node itself, standing in for yt-dlp through the same fetcher row shape.
import assert from 'node:assert/strict';
import test from 'node:test';
import { captionWords, hearALink } from '../read-data/hear-here.mjs';

const linkTools = { hear: hearALink };

const VTT = `WEBVTT
Kind: captions

00:00:01.000 --> 00:00:03.000
<c>hello</c> there

00:00:03.000 --> 00:00:05.500
hello there
general &amp; friends
`;

// A fetcher row whose three commands are node one-liners: info prints the page's facts, captions writes a captions
// file only when `withCaptions`, sound writes a sound file (or fails with `soundError`).
const fetcherRow = ({ withCaptions = false, soundError = null, infoError = null } = {}) => {
  const run = code => [process.execPath, '-e', code];
  return {
    id: 'node-reader', label: 'a link reader', check: [process.execPath], program: process.execPath, update_hint: 'update it',
    info: run(infoError ? `process.stderr.write(${JSON.stringify(infoError)}); process.exit(1)` : 'console.log(JSON.stringify({ title: "A talk", duration: 61 }))'),
    captions: [...run(withCaptions ? `require("fs").writeFileSync(process.argv[1] + "/captions.en.vtt", ${JSON.stringify(VTT)})` : 'process.exit(1)'), '{folder}'],
    sound: [...run(soundError ? `process.stderr.write(${JSON.stringify(soundError)}); process.exit(1)` : 'require("fs").writeFileSync(process.argv[1] + "/sound.opus", "bytes")'), '{folder}'],
  };
};

test('captions are read as speech: tags out, a rolled-over line kept once', () => {
  const read = captionWords(VTT);
  assert.equal(read.text, 'hello there general & friends');
  assert.deepEqual(read.segments.map(segment => [segment.start, segment.text]), [[1, 'hello there'], [3, 'general & friends']]);
});

test('a page with captions answers its captions without fetching the sound', async () => {
  let heard = false;
  const answer = await linkTools.hear({ url: 'https://video.example/watch' }, {}, { fetchers: [fetcherRow({ withCaptions: true })], hear: async () => { heard = true; return {}; } });
  assert.equal(answer.source, 'captions');
  assert.equal(answer.text, 'hello there general & friends');
  assert.equal(answer.title, 'A talk');
  assert.equal(answer.language, 'en');
  assert.equal(heard, false);
});

test('a page with no captions is heard on the computer, and the sound is kept with its words', async () => {
  let kept = null;
  const answer = await linkTools.hear({ url: 'https://video.example/watch' }, { door: {} }, {
    fetchers: [fetcherRow()],
    hear: async file => { assert.match(file, /sound\.opus$/); return { text: 'spoken words', segments: [{ start: 0, end: 1, text: 'spoken words' }], language: 'en', heard_whole: true, produced_by: 'ears on this computer' }; },
    keep: async input => { kept = input; return { identity: `1f:${'a'.repeat(64)}`, name: '/Heard links/A talk.opus' }; },
  });
  assert.equal(answer.source, 'heard');
  assert.equal(answer.text, 'spoken words');
  assert.equal(answer.produced_by, 'ears on this computer');
  assert.equal(answer.file, `1f:${'a'.repeat(64)}`);
  assert.equal(kept.title, 'A talk');
  assert.equal(kept.words.text, 'spoken words');
});

test('no words never comes back empty: each road says why', async () => {
  const url = 'https://video.example/watch';
  await assert.rejects(linkTools.hear({ url }, {}, { fetchers: [] }), /no program that reads video links/);
  await assert.rejects(linkTools.hear({ url }, {}, { fetchers: [fetcherRow()] }), /no captions, and no Whisper model was given/);
  await assert.rejects(linkTools.hear({ url }, {}, { fetchers: [fetcherRow()], hear: async () => ({ text: '  ', segments: [] }) }), /nobody speaks in it/);
  await assert.rejects(linkTools.hear({ url }, {}, { fetchers: [fetcherRow({ soundError: 'ERROR: HTTP Error 403: Forbidden' })], hear: async () => ({}) }), /refused this computer's copy of a link reader; updating it often fixes this \(update it\)/);
  await assert.rejects(linkTools.hear({ url }, {}, { fetchers: [fetcherRow({ infoError: 'ERROR: Unsupported URL' })] }), /Could not read https:\/\/video.example\/watch on this computer: Unsupported URL/);
  await assert.rejects(linkTools.hear({ url: 'not a link' }, {}, { fetchers: [fetcherRow()] }), /Send the link/);
});
