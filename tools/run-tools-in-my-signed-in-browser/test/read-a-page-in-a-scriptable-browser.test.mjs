// The scriptable-browser read against a stand-in osascript (nothing here opens a browser): the page comes back with its title,
// text, links and images; the script only reads and always closes its tab; a bad address or app is refused before anything runs;
// and each refusal is said in words.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PAGE_SCRIPT, pageFrom, readPage, refusalFrom, scriptFor, webAddress } from '../do-work/read-a-page-in-a-scriptable-browser.mjs';

const ARC = 'company.thebrowser.Browser';
const PAGE = JSON.stringify({ title: 'Bookmarks', text: 'a post', links: [{ text: 'open', href: 'https://x.com/a/status/1' }], images: ['https://pbs.twimg.com/media/1.jpg'] });

test('the page comes back with its title, text, links and images, and the browser is asked with the named app', async () => {
  const calls = [];
  const answer = await readPage({ url: 'https://x.com/i/bookmarks', computer: { 'automate-an-app': { app: ARC } } }, { run: async (file, args) => { calls.push([file, ...args]); return `${PAGE}\n`; } });
  assert.deepEqual(answer, { url: 'https://x.com/i/bookmarks', title: 'Bookmarks', text: 'a post', links: [{ text: 'open', href: 'https://x.com/a/status/1' }], images: ['https://pbs.twimg.com/media/1.jpg'], said: answer.said });
  assert.equal(calls[0][0], '/usr/bin/osascript');
  assert.match(calls[0][2], new RegExp(`application id "${ARC.replaceAll('.', '\\.')}"`));
});

test('the page answer must carry its four parts, and anything else is said in words', () => {
  assert.equal(pageFrom('not json', 'https://x.com/').error, 'unexpected_answer');
  assert.equal(pageFrom('{"title":"t"}', 'https://x.com/').error, 'unexpected_answer');
  assert.equal(pageFrom(PAGE, 'https://x.com/').title, 'Bookmarks');
});

test('the page script only reads: no click, type, submit, select, set or storage', () => {
  assert.doesNotMatch(PAGE_SCRIPT, /\b(click|submit|focus|select|dispatchEvent|innerHTML|value|cookie|localStorage|sessionStorage|fetch|remove|append)\b/);
  assert.doesNotMatch(PAGE_SCRIPT, /\bset\b/i);
  assert.match(PAGE_SCRIPT, /innerText/);
});

test('the script opens one tab, reads the page and closes that tab on success and on failure', () => {
  const script = scriptFor({ app: ARC, url: 'https://x.com/i/bookmarks' });
  assert.match(script, /make new tab at end of tabs of window 1 with properties \{URL:"https:\/\/x\.com\/i\/bookmarks"\}/);
  assert.equal((script.match(/close theTab/g) ?? []).length, 2);
  assert.match(script, /on error errText number errNum/);
  assert.doesNotMatch(script, /\bquit\b|\bdelete\b|\bkeystroke\b|\bclick\b/);
});

test('a url is parsed to its canonical address, and only http or https is accepted', () => {
  assert.equal(webAddress('https://x.com/i/bookmarks'), 'https://x.com/i/bookmarks');
  assert.equal(webAddress('javascript:alert(1)'), null);
  assert.equal(webAddress('file:///etc/passwd'), null);
  assert.equal(webAddress('not a url'), null);
});

test('a bad url or an app that is not a bundle id is refused before the browser is asked', async () => {
  const refuseWithoutRunning = async input => readPage(input, { run: async () => assert.fail('the browser must not be asked') });
  assert.equal((await refuseWithoutRunning({ url: 'file:///etc/passwd', computer: { 'automate-an-app': { app: ARC } } })).error, 'bad_url');
  assert.equal((await refuseWithoutRunning({ url: 'https://x.com/', computer: { 'automate-an-app': { app: 'x" & do shell script "id' } } })).error, 'no_app');
  assert.equal((await refuseWithoutRunning({ url: 'https://x.com/', computer: {} })).error, 'no_app');
});

test('Automation not allowed, an app not open and other failures are each said in words', async () => {
  const refuse = stderr => readPage({ url: 'https://x.com/', computer: { 'automate-an-app': { app: ARC } } }, { run: async () => { throw Object.assign(new Error('Command failed'), { stderr }); } });
  assert.equal((await refuse('execution error: Not authorized to send Apple events to Arc. (-1743)')).needs_access, 'automation');
  assert.equal((await refuse('execution error: app_not_running (9001)')).error, 'app_not_running');
  assert.deepEqual(await refuse('the program went away\nmore'), { error: 'osascript_failed', said: 'the program went away' });
  assert.equal(refusalFrom(undefined).error, 'osascript_failed');
});
