// tools/read-a-page-in-arc/test/pull-a-page-in-arc.test.mjs: the pull against a fake Arc. The fake answers osascript's calls the way
// Arc does (a JS string comes back as an AppleScript string literal) and runs the page scripts in a sandbox with a small page model.
// Nothing here touches the real browser; the live checks are in pull-a-page-in-arc.live.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { htmlToText, pullAPageInArc, settings as realSettings } from '../pull-a-page-in-arc.mjs';

const noSleep = async () => {};
const fastSleep = (ms) => new Promise((done) => setTimeout(done, Math.min(ms, 5)));

/** AppleScript prints a returned string as a literal: quotes, with \ and " escaped. */
const literal = (value) => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/**
 * A fake Arc: `pages` maps an address to a page model; `log` counts what the run opened, closed and evaluated. Tabs are kept by
 * their ids (the window is one id), and a call on an id that is not open fails the way Arc's own error does.
 */
function fakeArc(pages) {
  const log = { opened: [], closed: 0, evaluated: 0, osascript: 0, ids: [] };
  const tabs = new Map();
  let next = 0;
  const exec = async (file, argv) => {
    log.osascript += 1;
    assert.equal(file, 'osascript');
    const operation = argv[2];
    if (operation === 'open') {
      const address = argv[3];
      if (!pages[address]) throw Object.assign(new Error('no such page'), { stderr: 'no such page' });
      next += 1;
      const id = `tab-${next}`;
      const tab = makeTab(pages[address], pages[address].redirect_to ?? address);
      tabs.set(id, tab);
      log.opened.push(address);
      pages[address].onOpen?.();
      log.ids.push(id);
      return { stdout: `window-1|${id}\n` };
    }
    if (operation === 'close') {
      const id = argv[4];
      if (!tabs.has(id)) throw Object.assign(new Error('Can’t get tab id'), { stderr: 'Can’t get tab id' });
      tabs.delete(id);
      log.closed += 1;
      return { stdout: 'closed\n' };
    }
    assert.equal(operation, 'js');
    const id = argv[4];
    const tab = tabs.get(id);
    if (!tab) throw Object.assign(new Error('Can’t get tab id'), { stderr: 'Can’t get tab id' });
    log.evaluated += 1;
    const value = vm.runInContext(argv[5], tab.context);
    assert.equal(typeof value, 'string', 'every page script answers a JSON text');
    return { stdout: `${literal(value)}\n` };
  };
  return { exec, log, isOpen: () => tabs.size > 0 };
}

/** A scrolling pane that, like Notion's, keeps only the rows in view: its innerText is the visible rows, and scrollTop is clamped. */
function makePane({ lines, lineHeight, viewport }) {
  const scrollHeight = lines.length * lineHeight;
  let scrollTop = 0;
  return {
    clientHeight: viewport,
    scrollHeight,
    get scrollTop() { return scrollTop; },
    set scrollTop(value) { scrollTop = Math.max(0, Math.min(value, scrollHeight - viewport)); },
    get innerText() {
      const first = Math.floor(scrollTop / lineHeight);
      return lines.slice(first, first + viewport / lineHeight).join('\n');
    },
  };
}

/** The page model in a vm sandbox: document, window (scrolling), location, fetch with the page's downloads, and btoa. */
function makeTab(spec, address) {
  const scrolls = { count: 0 };
  const height = () => spec.baseHeight + Math.min(scrolls.count, spec.growSteps ?? 0) * (spec.growBy ?? 0);
  const bodyText = () => spec.text + (spec.lazyText && scrolls.count >= spec.lazyAfter ? `\n${spec.lazyText}` : '');
  const anchors = (spec.anchors ?? []).map((anchor) => ({ href: anchor.href, innerText: anchor.text ?? '', title: '', getAttribute: () => null }));
  const pane = spec.pane ? makePane(spec.pane) : null;
  const sandbox = {
    document: {
      readyState: spec.readyState ?? 'complete',
      title: spec.title,
      get body() {
        return { get innerText() { return bodyText(); }, get scrollHeight() { return height(); } };
      },
      documentElement: { get scrollHeight() { return height(); } },
      querySelector: (selector) => (spec.pane && selector === spec.pane.selector ? pane : null),
      querySelectorAll: () => anchors,
    },
    location: { href: address, origin: new URL(address).origin, pathname: new URL(address).pathname },
    scrollTo: () => { scrolls.count += 1; },
    URL,
    btoa,
    fetch: (downloadAddress, options) => {
      if (spec.notion && downloadAddress.includes('/api/v3/')) {
        const body = JSON.parse(options.body);
        spec.notion.calls.push({ path: new URL(downloadAddress).pathname, body });
        try {
          const answer = spec.notion.answer(new URL(downloadAddress).pathname, body);
          const payload = answer.signedUrls ? answer : { recordMap: answer, cursor: { stack: [] } };
          return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(payload) });
        } catch (error) {
          return Promise.reject(error);
        }
      }
      const download = spec.downloads?.[downloadAddress];
      if (!download) return Promise.reject(new TypeError('Failed to fetch'));
      download.seen?.push({ address: downloadAddress, credentials: options?.credentials });
      const bytes = Uint8Array.from(download.body);
      return Promise.resolve({
        ok: (download.status ?? 200) < 300,
        status: download.status ?? 200,
        headers: { get: (name) => (name === 'content-type' ? download.type : null) },
        arrayBuffer: () => Promise.resolve(bytes.buffer),
      });
    },
  };
  sandbox.window = sandbox;
  return { context: vm.createContext(sandbox) };
}

/** Settings with some sections replaced, the rest as in pull-settings.json. */
const withSettings = (changes) => {
  const merged = structuredClone(realSettings);
  for (const [section, values] of Object.entries(changes)) Object.assign(merged[section], values);
  return merged;
};

const tempRoot = () => mkdtempSync(join(tmpdir(), 'pull-a-page-in-arc-'));

test('refuses an address that is not http or https, without touching Arc', async () => {
  const arc = fakeArc({});
  const answer = await pullAPageInArc({ url: 'file:///etc/hosts' }, { exec: arc.exec, sleep: noSleep });
  assert.equal(arc.log.osascript, 0);
  assert.match(answer.error, /http or https/);
});

test('refuses a save folder outside the root, without touching Arc', async () => {
  const root = tempRoot();
  try {
    const arc = fakeArc({ 'https://docs.google.com/document/d/ID1/edit': { title: 'Doc', text: '' } });
    const settings = withSettings({ save: { root } });
    for (const folder of ['/etc', join(root, '..', 'escape'), '/tmp/pulled', 'relative/folder']) {
      const answer = await pullAPageInArc({ url: 'https://docs.google.com/document/d/ID1/edit', save: { folder } }, { exec: arc.exec, settings, sleep: noSleep });
      assert.match(answer.error, /absolute|inside/, folder);
    }
    assert.equal(arc.log.osascript, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('refuses inputs it does not take, bad bounds and links with save, without touching Arc', async () => {
  const arc = fakeArc({});
  const run = (input) => pullAPageInArc(input, { exec: arc.exec, sleep: noSleep });
  assert.match((await run({ url: 'https://example.com/', click: true })).error, /field it does not take/);
  assert.match((await run({ url: 'https://example.com/', follow: { same_site_only: true, most_pages: 31 } })).error, /1 to 30/);
  assert.match((await run({ url: 'https://example.com/', follow: { same_site_only: true, most_pages: 0 } })).error, /1 to 30/);
  assert.match((await run({ url: 'https://example.com/', follow: { same_site_only: true, most_pages: 2, match: '(' } })).error, /valid regular expression/);
  assert.match((await run({ url: 'https://docs.google.com/document/d/ID1/edit', links: true, save: { folder: '~/x' } })).error, /one job/);
  assert.match((await run({ url: 'https://example.com/', save: { folder: '~/x' } })).error, /no file to save/);
  assert.equal(arc.log.osascript, 0);
});

test('reads a page: title, address and whole text, not truncated, and closes its tab', async () => {
  const arc = fakeArc({ 'https://example.com/': { title: 'Example Domain', text: 'This domain is for use in documentation.' } });
  const answer = await pullAPageInArc({ url: 'https://example.com/' }, { exec: arc.exec, sleep: noSleep });
  assert.equal(answer.error, undefined, answer.error);
  assert.equal(answer.title, 'Example Domain');
  assert.equal(answer.url, 'https://example.com/');
  assert.equal(answer.text, 'This domain is for use in documentation.');
  assert.equal(answer.truncated, false);
  assert.equal(answer.text_chars_total, 'This domain is for use in documentation.'.length);
  assert.equal(answer.links, undefined);
  assert.deepEqual(arc.log.opened, ['https://example.com/']);
  assert.equal(arc.log.closed, 1);
  assert.equal(arc.isOpen(), false);
});

test('caps the text at most_chars, says so, and reassembles chunks exactly, even across a split surrogate pair', async () => {
  const text = `${'a'.repeat(49999)}😀${'b'.repeat(70000)}`;
  const arc = fakeArc({ 'https://long.example/': { title: 'Long', text } });
  const settings = withSettings({ text: { most_chars: 100000, chunk_chars: 50000 } });
  const answer = await pullAPageInArc({ url: 'https://long.example/' }, { exec: arc.exec, settings, sleep: noSleep });
  assert.equal(answer.truncated, true);
  assert.equal(answer.text_chars_total, text.length);
  assert.equal(answer.text.length, 100000);
  assert.equal(answer.text, text.slice(0, 100000));
  assert.equal(arc.log.closed, 1);
});

test('reports text that is not truncated as truncated: false at the bound exactly', async () => {
  const text = 'c'.repeat(100000);
  const arc = fakeArc({ 'https://exact.example/': { title: 'Exact', text } });
  const settings = withSettings({ text: { most_chars: 100000, chunk_chars: 30000 } });
  const answer = await pullAPageInArc({ url: 'https://exact.example/' }, { exec: arc.exec, settings, sleep: noSleep });
  assert.equal(answer.truncated, false);
  assert.equal(answer.text, text);
});

test('scrolls until the height stops growing, so lazy-loaded text is read', async () => {
  const arc = fakeArc({
    'https://lazy.example/': {
      title: 'Lazy', text: 'Top of the page', lazyText: 'LAZY SECTION', lazyAfter: 2, baseHeight: 1000, growBy: 1000, growSteps: 3,
    },
  });
  const answer = await pullAPageInArc({ url: 'https://lazy.example/' }, { exec: arc.exec, settings: realSettings, sleep: noSleep });
  assert.equal(answer.error, undefined, answer.error);
  assert.match(answer.text, /LAZY SECTION/);
  assert.equal(answer.scroll.stopped_by, 'stable');
  assert.equal(answer.scroll.text_chars_before, 'Top of the page'.length);
  assert.ok(answer.scroll.steps <= realSettings.scroll.most_steps);
});

test('a virtualized pane is read from its top to its end, so the rows scrolled out of view are kept in order', async () => {
  const lines = Array.from({ length: 60 }, (_, i) => `row ${i + 1}`);
  const arc = fakeArc({ 'https://pane.example/': { title: 'Pane', text: 'header', pane: { selector: '.notion-scroller', lines, lineHeight: 10, viewport: 50 } } });
  const answer = await pullAPageInArc({ url: 'https://pane.example/', scroll_selector: '.notion-scroller' }, { exec: arc.exec, settings: realSettings, sleep: noSleep });
  assert.equal(answer.error, undefined, answer.error);
  assert.equal(answer.text, lines.join('\n'));
  assert.equal(answer.scroll.stopped_by, 'stable');
  assert.equal(answer.text_chars_total, lines.join('\n').length);
});

test('stops scrolling at the step bound when the page keeps growing', async () => {
  const arc = fakeArc({ 'https://endless.example/': { title: 'Endless', text: 'x', baseHeight: 1000, growBy: 10, growSteps: 1000000 } });
  const settings = withSettings({ scroll: { most_steps: 4, pause_ms: 0, stable_rounds: 3 } });
  const answer = await pullAPageInArc({ url: 'https://endless.example/' }, { exec: arc.exec, settings, sleep: noSleep });
  assert.equal(answer.scroll.steps, 4);
  assert.equal(answer.scroll.stopped_by, 'most_steps');
});

test('a scroll_selector that names no element falls back to scrolling the window, and says so', async () => {
  const arc = fakeArc({ 'https://example.com/': { title: 'E', text: 'plain text' } });
  const answer = await pullAPageInArc({ url: 'https://example.com/', scroll_selector: '.notion-scroller' }, { exec: arc.exec, settings: realSettings, sleep: noSleep });
  assert.equal(answer.error, undefined, answer.error);
  assert.equal(answer.text, 'plain text');
  assert.equal(answer.scroll.pane_found, false);
  assert.equal(arc.log.opened.length, arc.log.closed);
});

test('answers every link once, http or https only, and bounds the count', async () => {
  const anchors = [
    { href: 'https://links.example/a#one', text: 'A one' },
    { href: 'https://links.example/a#two', text: 'A two' },
    { href: 'mailto:someone@example.com', text: 'mail' },
    { href: 'javascript:void(0)', text: 'js' },
    { href: 'https://links.example/b', text: 'B' },
    { href: 'https://links.example/c', text: 'C' },
    { href: 'https://links.example/d', text: 'D' },
    { href: 'https://links.example/e', text: 'E' },
  ];
  const arc = fakeArc({ 'https://links.example/': { title: 'Links', text: 'x', anchors } });
  const everything = await pullAPageInArc({ url: 'https://links.example/', links: true }, { exec: arc.exec, sleep: noSleep });
  assert.deepEqual(everything.links.map((link) => link.href), [
    'https://links.example/a', 'https://links.example/b', 'https://links.example/c', 'https://links.example/d', 'https://links.example/e',
  ]);
  assert.equal(everything.links[0].text, 'A one');
  assert.equal(everything.links_found, 5);
  assert.equal(everything.links_truncated, false);

  const bounded = withSettings({ links: { most_links: 2, most_text_chars: 200 } });
  const few = await pullAPageInArc({ url: 'https://links.example/', links: true }, { exec: arc.exec, settings: bounded, sleep: noSleep });
  assert.equal(few.links.length, 2);
  assert.equal(few.links_found, 5);
  assert.equal(few.links_truncated, true);
  assert.equal(arc.log.opened.length, arc.log.closed);
});

test('follow reads the same-site pages one after another, each as its own entry, and bounds them', async () => {
  const anchors = [
    { href: 'https://hub.example/p1', text: 'Part one' },
    { href: 'https://hub.example/p2', text: 'Part two' },
    { href: 'https://hub.example/p3', text: 'Part three' },
    { href: 'https://hub.example/p4', text: 'Part four' },
    { href: 'https://hub.example/p5', text: 'Part five' },
    { href: 'https://other.example/x', text: 'Elsewhere' },
  ];
  const pages = { 'https://hub.example/': { title: 'Hub', text: 'hub', anchors } };
  for (const n of [1, 2, 3, 4, 5]) pages[`https://hub.example/p${n}`] = { title: `Page ${n}`, text: `text of ${n}` };
  pages['https://other.example/x'] = { title: 'Other', text: 'other' };
  const arc = fakeArc(pages);

  const twoPages = await pullAPageInArc({ url: 'https://hub.example/', follow: { same_site_only: true, most_pages: 2 } }, { exec: arc.exec, settings: realSettings, sleep: noSleep });
  assert.equal(twoPages.error, undefined, twoPages.error);
  assert.deepEqual(twoPages.follow.pages.map((page) => page.title), ['Page 1', 'Page 2']);
  assert.equal(twoPages.follow.pages[1].text, 'text of 2');
  assert.equal(twoPages.follow.considered, 5);
  assert.equal(twoPages.follow.stopped_by, null);
  assert.equal(twoPages.links, undefined, 'links are answered only when asked for');
  assert.equal(arc.log.opened.length, arc.log.closed, 'every tab the run opened is closed');

  const matched = await pullAPageInArc({ url: 'https://hub.example/', follow: { same_site_only: false, most_pages: 10, match: 'p[34]|elsewhere' } }, { exec: arc.exec, settings: realSettings, sleep: noSleep });
  assert.deepEqual(matched.follow.pages.map((page) => page.url), ['https://hub.example/p3', 'https://hub.example/p4']);

  const everywhere = await pullAPageInArc({ url: 'https://hub.example/', follow: { same_site_only: false, most_pages: 10 } }, { exec: arc.exec, settings: realSettings, sleep: noSleep });
  assert.equal(everywhere.follow.pages.length, 6);
  assert.equal(everywhere.follow.pages[5].title, 'Other');
});

test('follow stops at the total text bound and says why', async () => {
  const anchors = [{ href: 'https://big.example/1', text: 'one' }, { href: 'https://big.example/2', text: 'two' }, { href: 'https://big.example/3', text: 'three' }];
  const pages = { 'https://big.example/': { title: 'Big', text: 'hub', anchors } };
  for (const n of [1, 2, 3]) pages[`https://big.example/${n}`] = { title: `B${n}`, text: 'y'.repeat(50) };
  const arc = fakeArc(pages);
  const settings = withSettings({ follow: { most_total_text_chars: 60 } });
  const answer = await pullAPageInArc({ url: 'https://big.example/', follow: { same_site_only: true, most_pages: 3 } }, { exec: arc.exec, settings, sleep: noSleep });
  assert.equal(answer.follow.pages.length, 2);
  assert.equal(answer.follow.stopped_by, 'total_text_chars');
  assert.equal(arc.log.opened.length, arc.log.closed);
});

test('a linked page that fails is one entry with its error, and the run goes on', async () => {
  const anchors = [{ href: 'https://mixed.example/ok', text: 'ok' }, { href: 'https://mixed.example/missing', text: 'missing' }, { href: 'https://mixed.example/last', text: 'last' }];
  const pages = {
    'https://mixed.example/': { title: 'Mixed', text: 'hub', anchors },
    'https://mixed.example/ok': { title: 'Ok', text: 'fine' },
    'https://mixed.example/last': { title: 'Last', text: 'end' },
  };
  const arc = fakeArc(pages);
  const answer = await pullAPageInArc({ url: 'https://mixed.example/', follow: { same_site_only: true, most_pages: 3 } }, { exec: arc.exec, sleep: noSleep });
  assert.equal(answer.follow.pages.length, 3);
  assert.equal(answer.follow.pages[1].url, 'https://mixed.example/missing');
  assert.match(answer.follow.pages[1].error, /no such page/);
  assert.equal(answer.follow.pages[2].title, 'Last');
  assert.equal(arc.log.opened.length, arc.log.closed);
});

test('a page that fails while it is read still closes its tab, and says what failed', async () => {
  const arc = fakeArc({ 'https://example.com/': { title: 'E', text: 'x', readyState: 'loading' } });
  const settings = withSettings({ wait: { most_seconds: 0, poll_ms: 0, settle_ms: 0 } });
  const answer = await pullAPageInArc({ url: 'https://example.com/' }, { exec: arc.exec, settings, sleep: noSleep });
  assert.match(answer.error, /did not finish loading/);
  assert.equal(arc.log.opened.length, 1);
  assert.equal(arc.log.closed, 1);
  assert.equal(arc.isOpen(), false);
});

test('saves a Google Doc as text read from its signed-in page, named by BLAKE3 of the text with .txt', async () => {
  const root = tempRoot();
  try {
    const html = '<!DOCTYPE html><html><head><title>Plan - Google Docs</title><script>var x = 1;</script></head><body><p>Hello&nbsp;doc &amp; ünïcode.</p><p>Second line</p></body></html>';
    const body = new TextEncoder().encode(html);
    const seen = [];
    const downloads = { 'https://docs.google.com/document/d/DOC1/mobilebasic': { type: 'text/html; charset=utf-8', body, seen } };
    const arc = fakeArc({ 'https://docs.google.com/document/d/DOC1/edit?tab=t.0': { title: 'Plan - Google Docs', text: 'x', downloads } });
    const settings = withSettings({ save: { root } });
    const answer = await pullAPageInArc({ url: 'https://docs.google.com/document/d/DOC1/edit?tab=t.0', save: { folder: join(root, 'docs') } }, { exec: arc.exec, settings, sleep: noSleep });
    assert.equal(answer.error, undefined, answer.error);
    const text = htmlToText(html);
    const expectedHash = bytesToHex(blake3(new TextEncoder().encode(text)));
    assert.equal(answer.file.blake3, expectedHash);
    assert.equal(answer.file.name, `${expectedHash}.txt`);
    assert.equal(answer.file.path, join(realpathSync(root), 'docs', `${expectedHash}.txt`));
    assert.equal(answer.file.bytes, Buffer.byteLength(text));
    assert.equal(answer.file.media_type, 'text/plain; charset=utf-8');
    assert.equal(answer.file.from_url, 'https://docs.google.com/document/d/DOC1/mobilebasic');
    assert.equal(answer.title, 'Plan - Google Docs');
    assert.deepEqual(seen, [{ address: 'https://docs.google.com/document/d/DOC1/mobilebasic', credentials: 'include' }]);
    assert.equal(readFileSync(answer.file.path, 'utf8'), 'Hello doc & ünïcode.\nSecond line\n');
    assert.equal(arc.log.opened.length, arc.log.closed);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('saves a Google Doc as html keeps the fetched bytes exactly', async () => {
  const root = tempRoot();
  try {
    const body = new TextEncoder().encode('<html><body>kept as is</body></html>');
    const downloads = { 'https://docs.google.com/document/d/DOC4/mobilebasic': { type: 'text/html', body } };
    const arc = fakeArc({ 'https://docs.google.com/document/d/DOC4/edit': { title: 'D', text: 'x', downloads } });
    const settings = withSettings({ save: { root } });
    const answer = await pullAPageInArc({ url: 'https://docs.google.com/document/d/DOC4/edit', save: { folder: root, format: 'html' } }, { exec: arc.exec, settings, sleep: noSleep });
    assert.equal(answer.error, undefined, answer.error);
    assert.equal(answer.file.name, `${bytesToHex(blake3(body))}.html`);
    assert.deepEqual(Buffer.from(readFileSync(answer.file.path)), Buffer.from(body));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('htmlToText keeps the visible text: no scripts, tags or raw line breaks; entities decoded; block ends become lines', () => {
  assert.equal(htmlToText('<html><script>var a = "<b>";</script><style>p{}</style><h1>T&amp;C &#39;q&#39;</h1>\n<p>One&nbsp;\n two</p><p>three</p>&#x1F600;</html>'),
    "T&C 'q'\nOne two\nthree\n😀\n");
  assert.equal(htmlToText('<p>a</p><p></p><p></p><p></p><p>b</p>'), 'a\n\nb\n');
});

test('a file bigger than the piece size comes back whole in pieces', async () => {
  const root = tempRoot();
  try {
    const body = new Uint8Array(300001);
    for (let i = 0; i < body.length; i += 1) body[i] = (i * 31 + (i >> 8)) & 255;
    const downloads = { 'https://files.example/data.bin': { type: 'application/octet-stream', body } };
    const arc = fakeArc({ 'https://files.example/page': { title: 'Files', text: 'x', downloads } });
    const settings = withSettings({ save: { root, chunk_chars: 1000 } });
    const answer = await pullAPageInArc({ url: 'https://files.example/page', save: { folder: root, file_url: 'https://files.example/data.bin' } }, { exec: arc.exec, settings, sleep: noSleep });
    assert.equal(answer.error, undefined, answer.error);
    assert.equal(answer.file.name, `${bytesToHex(blake3(body))}.bin`);
    assert.deepEqual(Buffer.from(readFileSync(answer.file.path)), Buffer.from(body));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a Google Sheet export that answers a web page (sign-in) saves nothing and says so', async () => {
  const root = tempRoot();
  try {
    const downloads = { 'https://docs.google.com/spreadsheets/d/SHEET2/export?format=csv': { type: 'text/html; charset=utf-8', body: new TextEncoder().encode('<html>sign in</html>') } };
    const arc = fakeArc({ 'https://docs.google.com/spreadsheets/d/SHEET2/edit': { title: 'Sheet', text: 'x', downloads } });
    const settings = withSettings({ save: { root } });
    const answer = await pullAPageInArc({ url: 'https://docs.google.com/spreadsheets/d/SHEET2/edit', save: { folder: root } }, { exec: arc.exec, settings, sleep: noSleep });
    assert.match(answer.error, /web page instead of the file/);
    assert.deepEqual(readdirSync(root), []);
    assert.equal(arc.log.opened.length, arc.log.closed);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a file the in-tab fetch cannot read is saved by Arc\'s own download: moved into the save folder by its BLAKE3, the partial copy ignored', async () => {
  const dir = tempRoot();
  try {
    const downloads = join(dir, 'Downloads');
    const root = join(dir, 'pulled');
    mkdirSync(downloads);
    const body = new TextEncoder().encode('RIFF fake wave bytes');
    const arc = fakeArc({
      'https://drive.google.com/file/d/F1/view': { title: 'Drive file', text: 'x' },
      'https://drive.usercontent.google.com/download?id=F1&export=download': {
        title: 'download',
        text: '',
        onOpen: () => {
          writeFileSync(join(downloads, 'text_crisp5.wav.crdownload'), body.subarray(0, 4));
          setTimeout(() => {
            rmSync(join(downloads, 'text_crisp5.wav.crdownload'));
            writeFileSync(join(downloads, 'text_crisp5.wav'), body);
          }, 30);
        },
      },
    });
    const settings = withSettings({ save: { root, downloads_folder: downloads, poll_ms: 5, most_download_seconds: 5 } });
    const answer = await pullAPageInArc({ url: 'https://drive.google.com/file/d/F1/view', save: { folder: root } }, { exec: arc.exec, settings, sleep: fastSleep });
    assert.equal(answer.error, undefined, answer.error);
    assert.equal(answer.via, 'browser-download');
    const hash = bytesToHex(blake3(body));
    assert.equal(answer.file.name, `${hash}.wav`);
    assert.equal(answer.file.path, join(realpathSync(root), `${hash}.wav`));
    assert.equal(answer.file.bytes, body.length);
    assert.equal(answer.file.blake3, hash);
    assert.equal(answer.file.from_url, 'https://drive.usercontent.google.com/download?id=F1&export=download');
    assert.deepEqual(readFileSync(answer.file.path), Buffer.from(body));
    assert.deepEqual(readdirSync(downloads), [], 'the file left Downloads: it was moved, not copied');
    assert.equal(arc.log.opened.length, arc.log.closed, 'both tabs are closed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a browser download that never finishes is refused in words, moves nothing, and closes its tab', async () => {
  const dir = tempRoot();
  try {
    const downloads = join(dir, 'Downloads');
    const root = join(dir, 'pulled');
    mkdirSync(downloads);
    const arc = fakeArc({
      'https://drive.google.com/file/d/F2/view': { title: 'Drive file', text: 'x' },
      'https://drive.usercontent.google.com/download?id=F2&export=download': { title: 'download', text: '' },
    });
    const settings = withSettings({ save: { root, downloads_folder: downloads, poll_ms: 5, most_download_seconds: 0 } });
    const answer = await pullAPageInArc({ url: 'https://drive.google.com/file/d/F2/view', save: { folder: root } }, { exec: arc.exec, settings, sleep: fastSleep });
    assert.match(answer.error, /did not finish within 0 seconds/);
    assert.deepEqual(readdirSync(downloads), []);
    assert.equal(arc.log.opened.length, arc.log.closed);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the Google address rules: a Doc is txt by default, a Sheet csv, a Slides deck pdf, and an unknown format is refused', async () => {
  const root = tempRoot();
  try {
    const sheet = { 'https://docs.google.com/spreadsheets/d/S9/export?format=csv': { type: 'text/csv', body: new TextEncoder().encode('a,b\n1,2\n') } };
    const deck = { 'https://docs.google.com/presentation/d/P9/export/pdf': { type: 'application/pdf', body: new Uint8Array([37, 80, 68, 70]) } };
    const arc = fakeArc({
      'https://docs.google.com/spreadsheets/d/S9/edit': { title: 'S', text: 'x', downloads: sheet },
      'https://docs.google.com/presentation/d/P9/edit': { title: 'P', text: 'x', downloads: deck },
    });
    const settings = withSettings({ save: { root } });
    const csv = await pullAPageInArc({ url: 'https://docs.google.com/spreadsheets/d/S9/edit', save: { folder: root } }, { exec: arc.exec, settings, sleep: noSleep });
    assert.equal(csv.file.name.endsWith('.csv'), true);
    const pdf = await pullAPageInArc({ url: 'https://docs.google.com/presentation/d/P9/edit', save: { folder: root } }, { exec: arc.exec, settings, sleep: noSleep });
    assert.equal(pdf.file.name.endsWith('.pdf'), true);
    assert.equal(pdf.file.from_url, 'https://docs.google.com/presentation/d/P9/export/pdf');
    const refused = await pullAPageInArc({ url: 'https://docs.google.com/presentation/d/P9/edit', save: { folder: root, format: 'exe' } }, { exec: arc.exec, settings, sleep: noSleep });
    assert.match(refused.error, /short extension|can be saved as/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the save folder is made under the root, and nothing is written outside it', async () => {
  const root = tempRoot();
  try {
    const body = new TextEncoder().encode('one');
    const arc = fakeArc({ 'https://docs.google.com/document/d/DOC3/edit': { title: 'D', text: 'x', downloads: { 'https://docs.google.com/document/d/DOC3/mobilebasic': { type: 'text/html', body } } } });
    const settings = withSettings({ save: { root } });
    const folder = join(root, 'nested', 'deeper');
    const answer = await pullAPageInArc({ url: 'https://docs.google.com/document/d/DOC3/edit', save: { folder } }, { exec: arc.exec, settings, sleep: noSleep });
    assert.equal(answer.error, undefined, answer.error);
    assert.equal(existsSync(join(folder, answer.file.name)), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the tool row names the pull, its input schema is closed, and its time bounds cover the follow run and a page', async () => {
  const rows = JSON.parse(readFileSync(new URL('../tool-rows.json', import.meta.url), 'utf8'));
  const record = rows.records.find((item) => item.payload.id === 'tool:pull-a-page-in-arc');
  assert.ok(record, 'the pull row exists');
  const { payload } = record;
  assert.equal(payload.invoke.kind, 'computer');
  assert.deepEqual(payload.invoke.argv, ['node', '/opt/read-a-page-in-arc/pull-a-page-in-arc.mjs']);
  assert.equal(payload.input_schema.additionalProperties, false);
  assert.deepEqual(payload.input_schema.required, ['url']);
  assert.ok(payload.verify[0].requires.includes('test/pull-a-page-in-arc.test.mjs'));
  const perPage = (realSettings.wait.most_seconds + realSettings.scroll.most_seconds) * 1000;
  assert.ok(payload.invoke.max_run_ms >= realSettings.follow.most_run_seconds * 1000 + perPage + 60000, 'the row time covers a follow run and the last page');
  assert.ok(payload.invoke.max_run_ms >= realSettings.save.most_download_seconds * 1000);
  const old = rows.records.find((item) => item.payload.id === 'tool:read-a-page-in-arc');
  assert.equal(old.payload.invoke.argv[1], '/opt/read-a-page-in-arc/read-a-page-in-arc.mjs', 'the read tool row is untouched');
});

test('a tab that lands on another host is refused, and the tab is closed', async () => {
  const arc = fakeArc({ 'https://from.example/': { title: 'Elsewhere', text: 'not the page', redirect_to: 'https://elsewhere.example/landing' } });
  const answer = await pullAPageInArc({ url: 'https://from.example/' }, { exec: arc.exec, settings: realSettings, sleep: noSleep });
  assert.match(answer.error, /not the address asked/);
  assert.equal(answer.text, undefined);
  assert.equal(arc.log.opened.length, arc.log.closed);
  assert.equal(arc.isOpen(), false);
});

test('two reads at the same time each get their own page, by their own tab id', async () => {
  const arc = fakeArc({
    'https://one.example/': { title: 'One', text: 'the first page' },
    'https://two.example/': { title: 'Two', text: 'the second page' },
  });
  const [first, second] = await Promise.all([
    pullAPageInArc({ url: 'https://one.example/' }, { exec: arc.exec, settings: realSettings, sleep: noSleep }),
    pullAPageInArc({ url: 'https://two.example/' }, { exec: arc.exec, settings: realSettings, sleep: noSleep }),
  ]);
  assert.equal(first.title, 'One');
  assert.equal(first.text, 'the first page');
  assert.equal(second.title, 'Two');
  assert.equal(second.text, 'the second page');
  assert.equal(new Set(arc.log.ids).size, 2, 'each read opened its own tab');
  assert.equal(arc.log.opened.length, arc.log.closed);
});

test('a Notion page is read through its API: blocks in order, a closed toggle filled in, child pages listed as links', async () => {
  const origin = 'https://example.notion.site';
  const id = 'aaaaaaaabbbbccccddddeeeeeeeeeeee';
  const blockOf = (value) => ({ value: { value: { alive: true, ...value } } });
  const notion = {
    calls: [],
    answer: (path, body) => {
      if (path === '/api/v3/loadPageChunk') {
        assert.equal(body.page.id, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
        return { block: {
          'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee': blockOf({ type: 'page', properties: { title: [['Library']] }, content: ['10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', '11111111-2222-3333-4444-555555555555'] }),
          '10000000-0000-0000-0000-000000000001': blockOf({ type: 'header', properties: { title: [['Intro']] }, content: [] }),
          '10000000-0000-0000-0000-000000000002': blockOf({ type: 'toggle', properties: { title: [['More']] }, content: ['10000000-0000-0000-0000-000000000003'] }),
          '11111111-2222-3333-4444-555555555555': blockOf({ type: 'page', properties: { title: [['Sub page']] }, content: [] }),
        } };
      }
      assert.equal(path, '/api/v3/syncRecordValuesSpace');
      return { block: {
        '10000000-0000-0000-0000-000000000003': blockOf({ type: 'bulleted_list', properties: { title: [['Hidden point']] }, content: [] }),
      } };
    },
  };
  const arc = fakeArc({ [`${origin}/Library-${id}`]: { title: 'Library', text: 'shell text', notion } });
  const answer = await pullAPageInArc({ url: `${origin}/Library-${id}` }, { exec: arc.exec, settings: realSettings, sleep: noSleep });
  assert.equal(answer.error, undefined, answer.error);
  assert.equal(answer.notion_error, undefined);
  assert.equal(answer.text, `# Intro\n> More\n  - Hidden point\n[Sub page](${origin}/11111111222233334444555555555555)`);
  assert.equal(answer.scroll.stopped_by, 'notion_blocks');
  assert.equal(answer.truncated, false);
  assert.equal(notion.calls.filter((call) => call.path === '/api/v3/syncRecordValuesSpace').length, 1, 'the missing toggle child is fetched once');
  assert.deepEqual(notion.calls[1].body.requests.map((request) => request.pointer.id), ['10000000-0000-0000-0000-000000000003']);
  assert.equal(arc.log.opened.length, arc.log.closed);
});

test('a Notion page whose API refuses falls back to scrolling the page, and says why', async () => {
  const origin = 'https://example.notion.site';
  const id = 'ffffffffeeeeddddccccbbbbbbbbbbbb';
  const notion = { calls: [], answer: () => { throw new Error('HTTP 401 from /api/v3/loadPageChunk'); } };
  const arc = fakeArc({ [`${origin}/Private-${id}`]: { title: 'Private', text: 'visible text', notion } });
  const answer = await pullAPageInArc({ url: `${origin}/Private-${id}` }, { exec: arc.exec, settings: realSettings, sleep: noSleep });
  assert.equal(answer.error, undefined, answer.error);
  assert.equal(answer.text, 'visible text');
  assert.match(answer.notion_error, /HTTP 401/);
  assert.equal(arc.log.opened.length, arc.log.closed);
});

test('a Notion page\'s attached file is signed in the page and saved by Arc\'s download, named by its BLAKE3 with its own extension', async () => {
  const dir = tempRoot();
  try {
    const downloads = join(dir, 'Downloads');
    const root = join(dir, 'pulled');
    mkdirSync(downloads);
    const origin = 'https://example.notion.site';
    const id = 'aaaaaaaabbbbccccddddeeeeeeeeeeee';
    const body = new TextEncoder().encode('PK fake zip bytes');
    const signed = [];
    const blockOf = (value) => ({ value: { value: { alive: true, ...value } } });
    const notion = {
      calls: [],
      answer: (path, requestBody) => {
        if (path === '/api/v3/loadPageChunk') return { block: {
          'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee': blockOf({ type: 'page', properties: { title: [['Skill']] }, content: ['20000000-0000-0000-0000-000000000001'] }),
          '20000000-0000-0000-0000-000000000001': blockOf({ type: 'file', properties: { title: [['scripts-skill.zip']], size: [['2.24 KiB']], source: [['attachment:d6118353-c008-4ac8-8a75-aee4db8a31e1:scripts-skill.zip']] }, format: {}, content: [] }),
        } };
        assert.equal(path, '/api/v3/getSignedFileUrls');
        signed.push(requestBody);
        return { signedUrls: ['https://files.example/signed/scripts-skill.zip?signature=x'] };
      },
    };
    const arc = fakeArc({
      [`${origin}/Skill-${id}`]: { title: 'Skill', text: 'x', notion },
      'https://files.example/signed/scripts-skill.zip?signature=x': {
        title: 'file',
        text: '',
        onOpen: () => writeFileSync(join(downloads, 'scripts-skill.zip'), body),
      },
    });
    const settings = withSettings({ save: { root, downloads_folder: downloads, poll_ms: 5, most_download_seconds: 5 } });
    const answer = await pullAPageInArc({ url: `${origin}/Skill-${id}`, save_attachments: { folder: join(root, 'skill') } }, { exec: arc.exec, settings, sleep: fastSleep });
    assert.equal(answer.error, undefined, answer.error);
    assert.deepEqual(signed[0].urls[0].permissionRecord, { table: 'block', id: '20000000-0000-0000-0000-000000000001' });
    assert.equal(answer.attachments.length, 1);
    const [file] = answer.attachments;
    assert.equal(file.error, undefined, file.error);
    assert.equal(file.original_name, 'scripts-skill.zip');
    const hash = bytesToHex(blake3(body));
    assert.equal(file.name, `${hash}.zip`);
    assert.equal(file.blake3, hash);
    assert.equal(file.bytes, body.length);
    assert.deepEqual(readFileSync(file.path), Buffer.from(body));
    assert.deepEqual(readdirSync(downloads), []);
    assert.equal(arc.log.opened.length, arc.log.closed);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

