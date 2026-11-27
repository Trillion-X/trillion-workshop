// tools/audio-transcription/test/hear-a-link.test.mjs
//
// read-data/hear-here.mjs (tool:hear-a-link): a link's captions win when the page has them, otherwise
// its sound is heard on the computer, and a link that yields no words always fails with why, never an empty answer.
// Moved from the product repo's test/hear-a-link.test.mjs with its assertions.
// The link reader here is node itself, standing in for yt-dlp through the same fetcher row shape.
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { captionWords, hearALink, linkSettings, refusedThisCopy } from '../read-data/hear-here.mjs';
import { captionWords as recoveredCaptions, refusedThisCopy as recoveredRefusal } from '../read-data/read-link-captions.mjs';
import { createLinkFetcher } from '../read-data/run-link-fetcher.mjs';

const linkTools = { hear: hearALink };

test('public caption and refusal exports are the recovered helper functions', () => {
  assert.equal(captionWords, recoveredCaptions);
  assert.equal(refusedThisCopy, recoveredRefusal);
});

test('requested confinement refuses before any unconfined process when its runner is unavailable', async () => {
  let ran = false;
  const run = createLinkFetcher({ execFile: () => { ran = true; }, fill: value => value });
  await assert.rejects(run({ check: ['reader'], info: ['reader'] }, 'info', { folder: '/case' }, 5, { enabled: true, tier: 'workspace' }), /provide the current constrained process runner/);
  assert.equal(ran, false);
});

test('the recovered confinement branch calls the supplied current runner with its complete scope', async () => {
  let asked = null;
  const run = createLinkFetcher({ execFile: () => assert.fail('the unconfined path must not run'), fill: value => value === '{folder}' ? '/case' : value });
  const row = { check: ['reader'], program: '/granted/reader', info: ['reader', '--folder', '{folder}'], env: { MODE: 'test' } };
  const answer = await run(row, 'info', { folder: '/case' }, 5, { enabled: true, tier: 'workspace' }, async (...args) => { asked = args; return { stdout: 'scoped answer' }; });
  assert.equal(answer, 'scoped answer');
  assert.deepEqual(asked, ['/granted/reader', ['--folder', '/case'], { tier: 'workspace', workspace: '/case', timeout_ms: 5000, scoped_env: { MODE: 'test' } }]);
});

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
const fetcherRow = ({ withCaptions = false, soundError = null, infoError = null, title = 'A talk' } = {}) => {
  const run = code => [process.execPath, '-e', code];
  return {
    id: 'node-reader', label: 'a link reader', check: [process.execPath], program: process.execPath, update_hint: 'update it',
    info: run(infoError ? `process.stderr.write(${JSON.stringify(infoError)}); process.exit(1)` : `console.log(JSON.stringify({ title: ${JSON.stringify(title)}, duration: 61 }))`),
    captions: [...run(withCaptions ? `require("fs").writeFileSync(process.argv[1] + "/captions.en.vtt", ${JSON.stringify(VTT)})` : 'process.exit(1)'), '{folder}'],
    sound: [...run(soundError ? `process.stderr.write(${JSON.stringify(soundError)}); process.exit(1)` : 'require("fs").writeFileSync(process.argv[1] + "/sound.opus", "bytes")'), '{folder}'],
  };
};

const namedReader = (name, title) => {
  const row = fetcherRow({ withCaptions: true, title });
  row.check = [name, '--version'];
  row.search_path = [];
  delete row.program;
  for (const part of ['info', 'captions', 'sound']) row[part] = [name, ...row[part].slice(1)];
  return row;
};
const nodeReader = title => ({ ...namedReader(basename(process.execPath), title), search_path: [dirname(process.execPath)] });
const settingsWithRows = fetchers => ({ ...linkSettings(), fetchers });

test('the existing eligibility owner skips an unavailable first reader and uses the available alternate', async () => {
  const answer = await hearALink({ url: 'https://video.example/watch' }, {}, { settings: settingsWithRows([
    namedReader('synthetic-unavailable-reader-first', 'unavailable'), nodeReader('available alternate'),
  ]) });
  assert.equal(answer.title, 'available alternate');
  assert.equal(answer.source, 'captions');
  assert.equal(answer.text, 'hello there general & friends');
});

test('an explicit link_reader is checked by the existing owner and the chosen executable is used', async () => {
  const folder = tempFolder(join(tmpdir(), 'reader-choice-'));
  const chosen = join(folder, 'chosen-reader');
  symlinkSync(process.execPath, chosen);
  const first = namedReader('synthetic-template-reader', 'template');
  first.info = ['synthetic-template-reader', '-e', 'console.log(JSON.stringify({ title: process.argv0, duration: 61 }))'];
  const answer = await hearALink({ url: 'https://video.example/watch', link_reader: chosen }, {}, { settings: settingsWithRows([first, nodeReader('unchosen')]) });
  assert.equal(answer.title, chosen);
  assert.equal(answer.source, 'captions');
});

test('an explicit executable path never substitutes a different installation from PATH', async () => {
  const folder = tempFolder(join(tmpdir(), 'reader-choice-'));
  const exact = join(folder, basename(process.execPath));
  await assert.rejects(hearALink({ url: 'https://video.example/watch', link_reader: exact }, {}, { settings: settingsWithRows([nodeReader('other installation')]) }), /no program that reads video links/);
});

test('a list with no eligible reader fails through the existing owner before fetching', async () => {
  await assert.rejects(hearALink({ url: 'https://video.example/watch' }, {}, { settings: settingsWithRows([
    namedReader('synthetic-unavailable-reader-first', 'first'), namedReader('synthetic-unavailable-reader-second', 'second'),
  ]) }), /no program that reads video links/);
});

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

test('a page with no captions is heard on the computer, and the answer holds its words and keeps nothing', async () => {
  const answer = await linkTools.hear({ url: 'https://video.example/watch' }, {}, {
    fetchers: [fetcherRow()],
    hear: async file => { assert.match(file, /sound\.opus$/); return { text: 'spoken words', segments: [{ start: 0, end: 1, text: 'spoken words' }], language: 'en', heard_whole: true, produced_by: 'ears on this computer' }; },
  });
  assert.equal(answer.source, 'heard');
  assert.equal(answer.text, 'spoken words');
  assert.equal(answer.produced_by, 'ears on this computer');
  assert.equal(answer.title, 'A talk');
  assert.equal('file' in answer || 'kept_error' in answer, false);
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

test('tool:hear-a-link answers the words with no door and declares no records or files write right', async () => {
  const { hearALink } = await import('../read-data/hear-here.mjs');
  const answer = await hearALink({ url: 'https://video.example/watch' }, {}, {
    fetchers: [fetcherRow()],
    hear: async () => ({ text: 'spoken words', segments: [{ start: 0, end: 1, text: 'spoken words' }], language: 'en', heard_whole: true }),
  });
  assert.equal(answer.text, 'spoken words');
  assert.equal(answer.source, 'heard');
  const rows = JSON.parse(readFileSync(new URL('../what-this-tool-does-and-how-to-run-it.json', import.meta.url), 'utf8')).records;
  const row = rows.map(r => r.payload).find(p => p.id === 'tool:hear-a-link');
  assert.equal(row.invoke.records, undefined);
  assert.equal('keep_sound' in row.input_schema.properties, false);
});
