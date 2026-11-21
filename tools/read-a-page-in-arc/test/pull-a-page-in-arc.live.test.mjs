// tools/read-a-page-in-arc/test/pull-a-page-in-arc.live.test.mjs: the pull in the real Arc browser on this Mac. It needs Arc running and
// signed in to Google. It reads example.com with its links, saves the signed-in Google Doc as text under the save root, and reads a
// Notion page before and after scrolling its pane. The lengths it prints are the numbers a report needs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { pullAPageInArc } from '../pull-a-page-in-arc.mjs';

const run = promisify(execFile);
const activeTabUrl = async () => (await run('osascript', ['-e', 'tell application "Arc" to return URL of (active tab of front window)'])).stdout.trim();
const saveRoot = join(homedir(), 'Library/Application Support/pulled-pages-in-arc');
const pullScript = new URL('../pull-a-page-in-arc.mjs', import.meta.url).pathname;
/** One pull in its own process, as the workshop runs it: the input on standard input, the answer on standard output. */
const pullInProcess = (input) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [pullScript]);
  let out = '';
  child.stdout.on('data', (chunk) => { out += chunk; });
  child.on('error', reject);
  child.on('close', () => resolve(JSON.parse(out)));
  child.stdin.end(JSON.stringify(input));
});

test('reads example.com in Arc with its links, and closes its tab', async () => {
  const answer = await pullAPageInArc({ url: 'https://example.com/', links: true });
  assert.equal(answer.error, undefined, answer.error);
  assert.equal(answer.title, 'Example Domain');
  assert.match(answer.text, /documentation/);
  assert.equal(answer.truncated, false);
  assert.ok(answer.links.some((link) => link.href === 'https://iana.org/help/example-domains' && link.text === 'Learn more'), 'the Learn more link is answered');
  assert.ok(answer.links.every((link) => /^https?:\/\//.test(link.href)));
  assert.notEqual(await activeTabUrl(), 'https://example.com/', 'the tab is closed');
  console.log(`example.com: ${answer.text_chars_total} characters, ${answer.links.length} links (${answer.links_found} found)`);
});

test('saves the signed-in Google Doc as text, named by the BLAKE3 of the bytes', async () => {
  const answer = await pullAPageInArc({
    url: 'https://docs.google.com/document/d/1UWN6ERMPHBbJJmw5PNVzAOsdoezudrWMs-qmloccFds/edit?tab=t.0',
    save: { folder: saveRoot },
  });
  assert.equal(answer.error, undefined, answer.error);
  assert.ok(answer.file.bytes > 0, 'the file has bytes');
  assert.match(answer.file.name, /^[0-9a-f]{64}\.txt$/);
  const bytes = readFileSync(answer.file.path);
  assert.equal(bytes.length, answer.file.bytes);
  assert.equal(bytesToHex(blake3(bytes)), answer.file.blake3);
  assert.equal(answer.file.name, `${answer.file.blake3}.txt`);
  assert.equal(answer.file.from_url, 'https://docs.google.com/document/d/1UWN6ERMPHBbJJmw5PNVzAOsdoezudrWMs-qmloccFds/mobilebasic');
  console.log(`Google Doc: ${answer.file.bytes} bytes, ${answer.file.name}`);
});

test('reads the Notion page before and after scrolling its pane', async () => {
  const url = 'https://cream-group-bf6.notion.site/The-12M-AI-Meta-Creative-Library-11-Formats-Every-Prompt-and-the-72-Hour-Kill-Rule-3b271e569508819e8629d17c77df5a40';
  const answer = await pullAPageInArc({ url, scroll_selector: '.notion-scroller' });
  assert.equal(answer.error, undefined, answer.error);
  assert.match(answer.title, /AI Meta Creative Library/);
  assert.ok(answer.scroll.text_chars_before > 0);
  assert.ok(answer.text_chars_total > answer.scroll.text_chars_before, 'scrolling the pane brings in more text');
  assert.ok(['notion_blocks', 'stable'].includes(answer.scroll.stopped_by), answer.scroll.stopped_by);
  assert.equal(answer.notion_error, undefined);
  assert.ok(answer.text_chars_total >= 10000, 'the whole library is read, not its header');
  assert.ok(answer.merge.api_chars > answer.scroll.text_chars_before, 'the API read holds more than the page view had');
  console.log(`Notion: ${answer.scroll.text_chars_before} characters before, ${answer.text_chars_total} after (${answer.scroll.notion_blocks ?? answer.scroll.steps} blocks or steps, ${answer.scroll.stopped_by})`);
  assert.notEqual(await activeTabUrl(), url, 'the tab is closed');
});

test('two pulls at the same time, in two processes, each read their own page', async () => {
  const [one, two] = await Promise.all([
    pullInProcess({ url: 'https://example.com/' }),
    pullInProcess({ url: 'https://www.iana.org/help/example-domains' }),
  ]);
  assert.equal(one.error, undefined, one.error);
  assert.equal(two.error, undefined, two.error);
  assert.equal(one.title, 'Example Domain');
  assert.match(two.url, /iana\.org/);
  assert.notEqual(one.title, two.title);
  console.log(`two at once: "${one.title}" and "${two.title}"`);
});

test('a Notion page with no scroll pane of that name reads its own page (not the other one)', async () => {
  for (const url of [
    'https://rural-lifeboat-196.notion.site/3addb9d7074d81d2ba5ed847785ba527',
    'https://shiny-college-b22.notion.site/How-We-Helped-Callum-41803c9f6feb81fcba54ea736c704adc',
  ]) {
    const answer = await pullAPageInArc({ url, scroll_selector: '.no-such-pane-here' });
    assert.equal(answer.error, undefined, `${url}: ${answer.error}`);
    assert.ok(answer.text_chars_total > 0, url);
    assert.equal(answer.scroll.pane_found, null, 'a Notion read uses its API, not the pane');
    console.log(`${new URL(url).hostname}: ${answer.text_chars_total} characters, ${answer.scroll.stopped_by}, first line ${JSON.stringify(answer.text.split('\n')[0])}`);
  }
});

test('a Google Drive file the in-tab fetch cannot read is saved by Arc\'s own download, named by its BLAKE3', async () => {
  // Needs a Drive file the signed-in person can see: DRIVE_FILE_URL names it (for example a .wav). Skipped when unset.
  const driveUrl = process.env.DRIVE_FILE_URL;
  if (!driveUrl) return;
  const answer = await pullAPageInArc({ url: driveUrl, save: { folder: saveRoot } });
  assert.equal(answer.error, undefined, answer.error);
  assert.equal(answer.via, 'browser-download');
  assert.equal(bytesToHex(blake3(readFileSync(answer.file.path))), answer.file.blake3);
  assert.ok(answer.file.bytes > 0);
  console.log(`Drive file: ${answer.file.bytes} bytes, ${answer.file.name}`);
});

