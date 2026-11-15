// Assertions copied one to one from old-trillion-before-worker-retire; only import/configuration seams changed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fixtures from './policy-fixtures.json' with { type: 'json' };
import { createInteractions } from '../read-data/interactions.mjs';
import { createJourney } from '../read-data/journey.mjs';
import { createCustomersHQ } from '../read-data/customers-hq.mjs';
const reports = fixtures.reports;
const { INTERACTIONS, SKETCH_BITS, admitPageBatch, capturePage, captureScript, cutPath, funnelFacts, interactionsAnswer, serverEvent, sketchAdd, sketchCount, surfaceOf, visitorHash, visitorsBy } = createInteractions(fixtures.interactions, fixtures.consent);
const { journeyRow } = createJourney(reports, { readSharing: async () => ({ activity: false, content: false }) });
const { groupReports } = createCustomersHQ(reports, { readJourneys: async () => [], htmlPage: value => value });
const BROWSER = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15';

test('a page keeps only what its kind names, with the facts the Worker knows and paths cut', () => {
  const { events, refused } = admitPageBatch({ shell: 'mac', events: [
    { kind: 'page_view', path: '/share/secret-code', referrer: 'https://news.ycombinator.com/item?id=1', utm_source: 'hn', device: 'forged', account: 'someone-else', email: 'a@b.c' },
    { kind: 'tool_run', tool: 'forged' },
    { kind: 'click', path: '/files/Taxes 2025.pdf', target: 'Open', to: '/x' },
    { kind: 'ai_screen', screen: '/decisions', action: 'full_open', client: 'chatgpt.com', target: 'screen-open-in-trillion', account: 'forged' },
    { kind: 'made-up' },
  ] }, { host: 'app.gettrillion.ai', agent: BROWSER, country: 'GB', account: 'acct-1', now: Date.parse('2026-10-06T10:20:00Z') });
  assert.equal(refused, 2, 'a server-only kind and an unknown kind are refused from a page');
  assert.equal(events.length, 3);
  assert.deepEqual(events[0], { hour: '2026-10-06T10', surface: 'app', kind: 'page_view', dims: { path: `/share/${INTERACTIONS.rest_word}`, referrer: 'news.ycombinator.com', utm_source: 'hn', shell: 'mac', device: 'computer', country: 'GB', account: 'acct-1' } });
  assert.equal(events[1].dims.path, `/files/${INTERACTIONS.rest_word}`, "the app keeps only the screen, never a person's file name");
  assert.deepEqual(events[2].dims, { screen: '/decisions', action: 'full_open', client: 'chatgpt.com', target: 'screen-open-in-trillion', shell: 'mac', device: 'computer', country: 'GB' });
  assert.equal(JSON.stringify(events).includes('a@b.c'), false, 'a fact no kind names is never kept');
  assert.equal(cutPath('/share/abc/def', surfaceOf('gettrillion.ai')), `/share/${INTERACTIONS.rest_word}`, 'a share code never reaches a count');
  assert.equal(admitPageBatch({ events: [{ kind: 'page_view', path: '/' }] }, { host: 'gettrillion.ai', agent: BROWSER, account: 'acct-1' }).events[0].dims.account, undefined, 'a surface that counts no accounts keeps none');
});


test('client health accepts closed categories and timing buckets without exception text or account identity', () => {
  const report = admitPageBatch({ shell: 'iphone', events: [
    { kind: 'client_error', category: 'script', path: '/messages/private-thread', message: 'secret message', stack: 'token=secret' },
    { kind: 'client_load', category: 'request', bucket: '2-5s', path: '/work/api/files/private-name', account: 'forged' },
    { kind: 'client_error', category: 'resource', path: '/private-code-123?a=secret' },
    { kind: 'client_error', category: 'layout', path: '/messages/private-thread' },
    { kind: 'client_error', category: 'token=secret', path: '/messages/private-thread' },
    { kind: 'client_load', category: 'request', bucket: '3141ms', path: '/messages/private-thread' },
  ] }, { host: 'app.gettrillion.ai', agent: BROWSER, account: 'real-account' });
  assert.equal(report.refused, 2);
  assert.deepEqual(report.events.map(row => row.dims), [
    { path: `/messages/${INTERACTIONS.rest_word}`, shell: 'iphone', category: 'script' },
    { path: `/work/api/files/${INTERACTIONS.rest_word}`, shell: 'iphone', category: 'request', bucket: '2-5s' },
    { path: '/other', shell: 'iphone', category: 'resource' },
    { path: `/messages/${INTERACTIONS.rest_word}`, shell: 'iphone', category: 'layout' },
  ]);
  assert.ok(!JSON.stringify(report.events).includes('secret'));
  assert.ok(!JSON.stringify(report.events).includes('real-account'));
  const unknown = admitPageBatch({ shell: 'mac', events: [
    { kind: 'client_load', category: 'request', bucket: '2-5s', path: '/work/api/private-token/user-secret?key=secret' },
    { kind: 'client_load', category: 'request', bucket: '2-5s', path: '/work/api/scope/values?user=secret' },
  ] }, { host: 'app.gettrillion.ai', agent: BROWSER }).events;
  assert.deepEqual(unknown.map(row => row.dims.path), [`/work/${INTERACTIONS.rest_word}`, `/work/api/scope/${INTERACTIONS.rest_word}`]);
});


test('the page script counts a view and a visit, batches them, and sends nothing when asked not to track', () => {
  const run = ({ dnt = false, then = () => { while (timers.length) timers.shift()(); }, timers = [] } = {}, seeWindow = () => {}) => {
    const sent = [];
    const listeners = {};
    const storage = new Map();
    const later = fn => { timers.push(fn); return timers.length; };
    const window = { addEventListener: (name, fn) => { listeners[name] = fn; }, scrollY: 0, innerHeight: 800 };
    const env = {
      window, navigator: { doNotTrack: dnt ? '1' : null, sendBeacon: (url, body) => { sent.push({ url, body: JSON.parse(body) }); return true; } },
      document: { referrer: 'https://t.co/x', addEventListener: (name, fn) => { listeners[`document:${name}`] = fn; }, visibilityState: 'visible', documentElement: { scrollHeight: 800 }, body: { scrollHeight: 800 } },
      location: { pathname: '/', search: '?utm_source=x&code=secret', href: 'https://gettrillion.ai/?utm_source=x' },
      history: { pushState() {}, replaceState() {} },
      sessionStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
      URLSearchParams, URL, setTimeout: later, clearTimeout: () => {}, fetch: () => {},
    };
    const fn = new Function(...Object.keys(env), `(${capturePage.toString()})(${JSON.stringify(JSON.parse(captureScript('https://app.gettrillion.ai', 'gettrillion.ai').match(/\)\((\{.*\})\);$/)[1]))});`);
    fn(...Object.values(env));
    seeWindow(window);
    then(listeners);
    return sent;
  };
  const sent = run();
  const events = sent.flatMap(send => send.body.events);
  assert.deepEqual(events.map(event => event.kind).sort(), ['page_view', 'session_start']);
  assert.equal(events[0].utm_source, 'x');
  assert.equal(JSON.stringify(events).includes('secret'), false, 'only campaign facts leave the page');
  assert.equal(sent[0].url, 'https://app.gettrillion.ai/i');
  const errorTimers = [];
  const errors = run({ timers: errorTimers, then: listeners => {
    listeners.error({});
    listeners.unhandledrejection({});
    while (errorTimers.length) errorTimers.shift()();
  } }).flatMap(send => send.body.events).filter(event => event.kind === 'client_error');
  assert.deepEqual(errors.map(event => event.category), ['script', 'promise']);
  assert.ok(errors.every(event => !('message' in event) && !('stack' in event)));
  // A page's live socket close is counted by its code's closed name and how long it lived, any other code as other.
  const closeTimers = [];
  let counting;
  const closes = run({ timers: closeTimers, then: listeners => {
    counting.liveClosed(1013, 3000);
    counting.liveClosed(4999, 10);
    counting.liveClosed('early', 15000);
    while (closeTimers.length) closeTimers.shift()();
  } }, window => { counting = window.trillionCounting; }).flatMap(send => send.body.events).filter(event => event.kind === 'live_close');
  assert.deepEqual(closes.map(event => [event.category, event.bucket]), [['try-later-1013', '2-5s'], ['other', 'under-200ms'], ['early-given-up', 'over-5s']]);
  const admitted = admitPageBatch({ shell: 'browser', events: [{ kind: 'live_close', category: 'try-later-1013', bucket: '2-5s', path: '/files' },
    { kind: 'live_close', category: 'socket reason words', bucket: '2-5s', path: '/files' }] }, { host: 'app.gettrillion.ai', agent: BROWSER });
  assert.deepEqual([admitted.refused, admitted.events.map(row => row.dims.category)], [1, ['try-later-1013']]);
  assert.equal(run({ dnt: true }).length, 0);
  // A link that leaves the page sends the queue at the click, before any timer: the page being left keeps its events.
  const link = { href: 'https://app.gettrillion.ai/sign-in', target: '', tagName: 'A', id: '', getAttribute: name => (name === 'data-track' ? 'Get started' : null) };
  link.closest = () => link;
  const clicked = run({ then: listeners => listeners['document:click']({ target: link, button: 0 }) });
  assert.equal(clicked.length, 1, 'one send at the click, no timer run');
  assert.deepEqual(clicked[0].body.events.map(event => event.kind), ['session_start', 'page_view', 'click']);
  assert.equal(clicked[0].body.events[2].to_host, 'app.gettrillion.ai');
});


test('a valid day key can make distinct visitors collide in an approximate sketch', () => {
  const key = new Uint8Array(32);
  new DataView(key.buffer).setUint32(0, 336);
  const registers = new Uint8Array(1 << SKETCH_BITS);
  for (const address of ['203.0.113.7', '198.51.100.9']) sketchAdd(registers, visitorHash(key, address, 'price'));
  assert.equal(registers.filter(Boolean).length, 1);
  assert.equal(sketchCount(registers), 1, 'a sketch estimates; arbitrary entropy cannot promise exact small counts');
});


test('who came back counts the accounts used on a day before the last and those used on another day too', () => {
  const day = (date, account, extra = {}) => ({ day: date, surface: 'app', kind: 'page_view', account, ...extra });
  const read = { totals: [], hours: [], visitors: { hours: [], kinds: [], pages: [] }, account_days: [
    day('2026-10-01', 'a'), day('2026-10-03', 'a'),
    day('2026-10-01', 'b'),
    day('2026-10-03', 'c'),
    day('2026-10-02', 'd'), day('2026-10-02', 'd', { kind: 'click' }),
    day('2026-10-01', 'site-reader', { surface: 'site' }), day('2026-10-02', 'site-reader', { surface: 'site' }),
  ] };
  const counts = Object.fromEntries(interactionsAnswer([read]).came_back.map(row => [row.id, row.count]));
  assert.equal(counts['app-accounts-started'], 3, 'a, b and d were used before the last day; c first appeared on it; the site is another surface');
  assert.equal(counts['app-accounts-returned'], 1, 'only a was used on another day too');
  assert.deepEqual(interactionsAnswer([{ totals: [], hours: [], visitors: { hours: [], kinds: [], pages: [] } }]).came_back.map(row => row.count), [0, 0]);
});


test('a journey keeps only what its kind names, route groups only, and words only with content', () => {
  const page = journeyRow('page_view', { path: '/decisions', email: 'a@b.c' }, { note: 'secret' }, { content: true, now: 5 });
  assert.deepEqual(page, { at: 5, surface: 'app', kind: 'page_view', label: '/decisions', facts: {} });
  assert.equal(journeyRow('nothing_known', {}), null);
  const notice = { title: 'Welcome' };
  const body = { body: 'Dear Sam, here is your private plan' };
  assert.deepEqual(journeyRow('notice', { kind: 'welcome', ...notice }, body, { content: false }).facts, { title: 'Welcome' });
  assert.equal(journeyRow('notice', { kind: 'welcome', ...notice }, body, { content: true }).facts.words.body, body.body);
  assert.equal(journeyRow('report', { kind: 'bug' }, { note: 'x'.repeat(500) }, { content: false }).facts.words, undefined);
});


test('reports are grouped by kind, then where, newest first', () => {
  const grouped = groupReports([
    { id: '1', kind: 'an idea', where: 'Files', sent_at: '2026-10-01', note: 'a' },
    { id: '2', kind: 'a bug report', where: 'Files', sent_at: '2026-10-02', note: 'b' },
    { id: '3', kind: 'a bug report', where: 'Files', sent_at: '2026-10-03', note: 'c', sent_by: 'ai' },
    { id: '4', kind: 'a bug report', where: '', note: 'd' },
  ]);
  assert.deepEqual(grouped.map(group => group.kind), ['a bug report', 'an idea']);
  assert.equal(grouped[0].count, 3);
  assert.equal(grouped[0].wheres[0].where, 'Files');
  assert.equal(grouped[0].wheres[0].reports[0].sent_by, 'screen');
});
