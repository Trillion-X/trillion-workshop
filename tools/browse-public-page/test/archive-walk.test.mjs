import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readBody, readPublicPageOrArchive } from '../do-work/browse_public_page.mjs';
import { checkedWalk, walkArchive } from '../do-work/walk-archive.mjs';
import { cdxEntries, dateInText, dateOfUrl, eraOf, eraSpans, evenlyDated, inWindow, listingEntries, nextListing, pageDate, robotsRules, sitemapEntries, waybackQuery } from '../do-work/archive-facts.mjs';

const toolRecords = JSON.parse(readFileSync(new URL('../tool-rows.json', import.meta.url), 'utf8'));

// A made-up bakery newsletter: twelve issues, four to a listing page, newest first.
const SITE = 'https://crumbs.example.test';
const issues = Array.from({ length: 12 }, (_, index) => {
  const date = new Date(Date.UTC(2024, 11 - index * 5, 10));
  const iso = date.toISOString().slice(0, 10);
  return { n: 12 - index, iso, path: `/issues/${12 - index}-${['rye', 'oat', 'spelt', 'corn'][index % 4]}-bread`, title: `Issue ${12 - index}: ${['rye', 'oat', 'spelt', 'corn'][index % 4]} bread` };
});
const listing = pageNumber => {
  const mine = issues.slice((pageNumber - 1) * 4, pageNumber * 4);
  const next = pageNumber < 3 ? `<a href="/archive?page=${pageNumber + 1}">Older posts &raquo;</a>` : '';
  return `<html><head><title>Archive</title></head><body><nav><a href="/">Home</a><a href="/about">About</a></nav><ul>${mine.map(issue => `<li><a href="${issue.path}">${issue.title}</a> <time datetime="${issue.iso}T08:00:00Z">${issue.iso}</time></li>`).join('')}</ul>${next}</body></html>`;
};
const issuePage = issue => `<html><head><title>${issue.title}</title><meta property="article:published_time" content="${issue.iso}T09:00:00Z"></head><body><article><h1>${issue.title}</h1><p>Words of issue ${issue.n}.</p></article></body></html>`;

function bakery({ robots = 'User-agent: *\nDisallow: /private/\n', missingRobots = false } = {}) {
  const seen = [];
  const fetchPage = async url => {
    seen.push(url.pathname + url.search);
    const html = body => ({ status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: Buffer.from(body) });
    if (url.pathname === '/robots.txt') return missingRobots ? { status: 404, headers: {}, body: Buffer.alloc(0) } : { status: 200, headers: { 'content-type': 'text/plain' }, body: Buffer.from(robots) };
    if (url.pathname === '/archive') return html(listing(Number(url.searchParams.get('page') ?? 1)));
    const issue = issues.find(candidate => candidate.path === url.pathname);
    if (issue) return html(issuePage(issue));
    return { status: 404, headers: {}, body: Buffer.alloc(0) };
  };
  return { seen, fetchPage };
}
const noSleep = () => { const waits = []; return { waits, sleep: async milliseconds => { waits.push(milliseconds); } }; };
const walkOf = async (input, site = bakery()) => {
  const { waits, sleep } = noSleep();
  const result = await readPublicPageOrArchive(input, site.fetchPage, sleep);
  return { result, waits, seen: site.seen };
};

test('the tool row passes the whole input and ships every file the walk imports', () => {
  const row = toolRecords.records[0].payload;
  assert.deepEqual(row.invoke.stdin, { fill: { from: 'input' } });
  assert.deepEqual(row.invoke.files.package_files.paths, ['do-work/browse_public_page.mjs', 'do-work/page-facts.mjs', 'do-work/page-conventions.json', 'do-work/walk-archive.mjs', 'do-work/archive-facts.mjs']);
  assert.ok(row.input_schema.properties.walk);
  assert.deepEqual(row.input_schema.required, ['url']);
  assert.equal(row.input_schema.additionalProperties, false);
  assert.ok(row.output_schema.properties.walk);
});

test('without walk the read is the one-page read, unchanged', async () => {
  const { result, seen } = await walkOf({ url: `${SITE}/archive` });
  assert.deepEqual(seen, ['/archive']);
  assert.equal(result.walk, undefined);
  assert.equal(result.title, 'Archive');
});

test('a listing is read for its entries, their days and the older-page link', () => {
  const entries = listingEntries(listing(1), `${SITE}/archive`);
  assert.deepEqual(entries.map(entry => entry.url), issues.slice(0, 4).map(issue => SITE + issue.path));
  assert.deepEqual(entries.map(entry => entry.date), issues.slice(0, 4).map(issue => issue.iso));
  assert.ok(entries.every(entry => entry.date_source === 'time'));
  assert.equal(nextListing(listing(1), `${SITE}/archive`), `${SITE}/archive?page=2`);
  assert.equal(nextListing(listing(3), `${SITE}/archive?page=3`), null);
  assert.equal(nextListing('<head><link rel="next" href="/p/2"></head>', `${SITE}/p/1`), `${SITE}/p/2`);
});

test('days are read from addresses, words, pages and structured data, and never guessed', () => {
  assert.equal(dateOfUrl('https://a.example.test/2023/04/17/loaves'), '2023-04-17');
  assert.equal(dateOfUrl('https://a.example.test/2023-04-17-loaves'), '2023-04-17');
  assert.equal(dateOfUrl('https://a.example.test/2023/04/loaves'), '2023-04-01');
  assert.equal(dateOfUrl('https://a.example.test/2023/13/01/loaves'), null);
  assert.equal(dateOfUrl('https://a.example.test/issues/march-5-2022'), '2022-03-05');
  assert.equal(dateOfUrl('https://a.example.test/issues/4'), null);
  assert.equal(dateInText('Posted March 5, 2022 by Sam'), '2022-03-05');
  assert.equal(dateInText('5th Sept. 2021'), '2021-09-05');
  assert.equal(dateInText('2022-02-30'), null);
  assert.equal(dateInText('March is a month'), null);
  assert.deepEqual(pageDate('<meta name="date" content="2021-07-04">'), { date: '2021-07-04', source: 'meta' });
  assert.deepEqual(pageDate('<script type="application/ld+json">{"@type":"Article","datePublished":"2020-01-02T03:04:05Z"}</script>'), { date: '2020-01-02', source: 'structured-data' });
  assert.deepEqual(pageDate('<time datetime="2019-12-31">last day</time>'), { date: '2019-12-31', source: 'time' });
  assert.deepEqual(pageDate('<p>no day</p>'), { date: null, source: null });
});

test('a sitemap and a sitemap index are read as entries and child sitemaps', () => {
  const index = '<sitemapindex><sitemap><loc>https://crumbs.example.test/s1.xml</loc></sitemap><sitemap><loc>https://elsewhere.example.test/s2.xml</loc></sitemap></sitemapindex>';
  assert.deepEqual(sitemapEntries(index, SITE), { entries: [], sitemaps: ['https://crumbs.example.test/s1.xml'] });
  const set = '<urlset><url><loc>https://crumbs.example.test/2022/05/02/a</loc><lastmod>2023-01-01</lastmod></url><url><loc>https://crumbs.example.test/b</loc><lastmod>2021-06-30T10:00:00Z</lastmod></url><url><loc>https://crumbs.example.test/c</loc></url></urlset>';
  assert.deepEqual(sitemapEntries(set, SITE).entries.map(entry => [entry.date, entry.date_source]), [['2022-05-02', 'url'], ['2021-06-30', 'lastmod'], [null, null]]);
});

test('robots.txt: the named group wins over *, the longest rule wins, an allow beats an equal disallow', () => {
  const rules = robotsRules('User-agent: *\nDisallow: /\n\nUser-agent: TrillionPublicPageReader\nDisallow: /private\nAllow: /private/open\nCrawl-delay: 4\n', 'TrillionPublicPageReader/1.0');
  assert.equal(rules.allows('/issues/1'), true);
  assert.equal(rules.allows('/private/x'), false);
  assert.equal(rules.allows('/private/open/x'), true);
  assert.equal(rules.crawlDelay, 4);
  assert.equal(robotsRules('User-agent: *\nDisallow: /', 'x').allows('/a'), false);
  assert.equal(robotsRules('', 'x').allows('/a'), true);
  assert.equal(robotsRules('User-agent: *\nDisallow: /*.pdf$', 'x').allows('/a.pdf'), false);
  assert.equal(robotsRules('User-agent: *\nDisallow: /*.pdf$', 'x').allows('/a.pdf.html'), true);
});

test('eras are equal thirds of the dated span; the sample is spread across a group', () => {
  const spans = eraSpans(['2020-01-01', '2020-12-31', '2022-01-01']);
  assert.deepEqual(spans.map(span => span.name), ['early', 'middle', 'recent']);
  assert.equal(spans[0].from, '2020-01-01');
  assert.equal(spans[2].to, '2022-01-01');
  assert.equal(eraOf('2020-01-01', spans), 'early');
  assert.equal(eraOf('2022-01-01', spans), 'recent');
  assert.equal(eraOf(null, spans), null);
  assert.equal(eraSpans([null]), null);
  const group = ['2020-01-01', '2020-02-01', '2020-03-01', '2020-04-01', '2020-05-01'].map(date => ({ date }));
  assert.deepEqual(evenlyDated(group, 3).map(entry => entry.date), ['2020-01-01', '2020-03-01', '2020-05-01']);
  assert.deepEqual(evenlyDated(group, 1).map(entry => entry.date), ['2020-03-01']);
  assert.equal(evenlyDated(group, 9).length, 5);
  assert.equal(inWindow('2020-03-01', { from: '2020-03-01', to: '2020-03-01' }), true);
  assert.equal(inWindow(null, {}), false);
});

test('the walk checks what it is asked for', () => {
  assert.deepEqual(checkedWalk({}), { source: 'listing', collapse: 'month', window: undefined, eras: undefined, count: 10, listingPages: 10, delaySeconds: 2 });
  for (const [input, expected] of [
    [{ delay_seconds: 1 }, /delay_seconds/],
    [{ delay_seconds: 31 }, /delay_seconds/],
    [{ count: 201 }, /count/],
    [{ count: 1.5 }, /count/],
    [{ max_listing_pages: 0 }, /max_listing_pages/],
    [{ eras: ['ancient'] }, /eras must name/],
    [{ eras: [] }, /eras must name/],
    [{ window: { from: '2020-1-1' } }, /window.from/],
    [{ window: { from: '2021-01-01', to: '2020-01-01' } }, /not be after/],
    [{ window: { from: '2020-01-01' }, eras: ['early'] }, /not both/],
    [{ source: 'cache' }, /source must be/],
    [{ source: 'wayback', collapse: 'week' }, /collapse must be/],
    [[], /object/],
  ]) assert.throws(() => checkedWalk(input), expected);
});

test('a walk follows the older links, reads the newest entries in listing order and paces every request', async () => {
  const { result, waits, seen } = await walkOf({ url: `${SITE}/archive`, walk: { count: 3, delay_seconds: 2 } });
  assert.equal(result.title, 'Archive');
  assert.equal(result.walk.listing_pages.length, 3);
  assert.deepEqual(result.walk.listing_pages.map(page => page.kind), ['listing', 'listing', 'listing']);
  assert.equal(result.walk.entries_seen, 12);
  assert.equal(result.walk.dated, 12);
  assert.equal(result.walk.reached_oldest, true);
  assert.equal(result.walk.stopped, 'listing pages ended');
  assert.deepEqual(result.walk.pages.map(page => page.title), issues.slice(0, 3).map(issue => issue.title));
  assert.deepEqual(result.walk.pages.map(page => [page.date, page.date_source]), issues.slice(0, 3).map(issue => [issue.iso, 'meta']));
  assert.deepEqual(seen, ['/robots.txt', '/archive', '/archive?page=2', '/archive?page=3', ...issues.slice(0, 3).map(issue => issue.path)]);
  assert.equal(result.walk.requests, 7);
  assert.deepEqual(waits, Array(6).fill(2000));
});

test('eras read count entries from each era chosen, from the oldest to the newest day the listings showed', async () => {
  const { result } = await walkOf({ url: `${SITE}/archive`, walk: { eras: ['early', 'recent'], count: 2 } });
  assert.equal(result.walk.eras.length, 3);
  assert.deepEqual(result.walk.eras.map(era => era.name), ['early', 'middle', 'recent']);
  assert.deepEqual(result.walk.eras.map(era => era.read), [2, 0, 2]);
  assert.equal(result.walk.eras.reduce((total, era) => total + era.seen, 0), 12);
  assert.deepEqual(result.walk.pages.map(page => page.era), ['early', 'early', 'recent', 'recent']);
  assert.equal(result.walk.span.from, issues[11].iso);
  assert.equal(result.walk.span.to, issues[0].iso);
  assert.ok(result.walk.pages.every(page => !page.error));
});

test('a window reads entries inside it, spread across it, and stops walking once the listing is older than it', async () => {
  const from = issues[7].iso;
  const to = issues[2].iso;
  const { result, seen } = await walkOf({ url: `${SITE}/archive`, walk: { window: { from, to }, count: 2, max_listing_pages: 5 } });
  assert.deepEqual(result.walk.pages.map(page => page.date), [issues[7].iso, issues[2].iso].sort());
  assert.equal(result.walk.listing_pages.length, 3);
  const older = await walkOf({ url: `${SITE}/archive`, walk: { window: { from: issues[1].iso }, count: 1 } });
  assert.equal(older.result.walk.stopped, 'the listing is older than the window');
  assert.equal(older.result.walk.listing_pages.length, 2);
  assert.ok(!seen.includes('/archive?page=4'));
});

test('count 0 only measures: the listings, entries and days, no entry page read', async () => {
  const { result, seen } = await walkOf({ url: `${SITE}/archive`, walk: { count: 0 } });
  assert.equal(result.walk.pages.length, 0);
  assert.equal(result.walk.entries_seen, 12);
  assert.deepEqual(seen, ['/robots.txt', '/archive', '/archive?page=2', '/archive?page=3']);
});

test('the listing page limit stops the walk and says so', async () => {
  const { result } = await walkOf({ url: `${SITE}/archive`, walk: { count: 0, max_listing_pages: 2 } });
  assert.equal(result.walk.listing_pages.length, 2);
  assert.equal(result.walk.reached_oldest, false);
  assert.equal(result.walk.stopped, 'listing page limit of 2 reached');
});

test('robots.txt is obeyed and its crawl delay lengthens the wait; a missing one allows all', async () => {
  const blocked = await walkOf({ url: `${SITE}/archive`, walk: { count: 2 } }, bakery({ robots: 'User-agent: *\nDisallow: /issues/\nCrawl-delay: 5\n' }));
  assert.ok(blocked.result.walk.pages.every(page => /robots\.txt does not allow/.test(page.error)));
  assert.equal(blocked.result.walk.delay_seconds, 5);
  assert.ok(blocked.waits.every(wait => wait === 5000));
  assert.ok(!blocked.seen.some(path => path.startsWith('/issues/')));
  await assert.rejects(readPublicPageOrArchive({ url: `${SITE}/archive`, walk: { count: 1 } }, bakery({ robots: 'User-agent: *\nDisallow: /' }).fetchPage, async () => {}), /does not allow the start address/);
  await assert.rejects(readPublicPageOrArchive({ url: `${SITE}/archive`, walk: {} }, async url => (url.pathname === '/robots.txt' ? { status: 503, headers: {}, body: Buffer.alloc(0) } : bakery().fetchPage(url)), async () => {}), /robots\.txt could not be read/);
  await assert.rejects(readPublicPageOrArchive({ url: `${SITE}/archive`, walk: {} }, bakery({ robots: 'User-agent: *\nCrawl-delay: 120\n' }).fetchPage, async () => {}), /asks for 120 seconds/);
  const open = await walkOf({ url: `${SITE}/archive`, walk: { count: 1 } }, bakery({ missingRobots: true }));
  assert.equal(open.result.walk.pages.length, 1);
});

test('one entry that cannot be read is recorded and the walk goes on', async () => {
  const site = bakery();
  const inner = site.fetchPage;
  site.fetchPage = async url => (url.pathname === issues[1].path ? { status: 500, headers: {}, body: Buffer.alloc(0) } : inner(url));
  const { result } = await walkOf({ url: `${SITE}/archive`, walk: { count: 3 } }, site);
  assert.deepEqual(result.walk.pages.map(page => page.error ?? page.title), [issues[0].title, 'The page returned HTTP 500.', issues[2].title]);
});

test('a sitemap start is walked through its children, its entries sampled by era, its own facts empty', async () => {
  const urls = Array.from({ length: 9 }, (_, index) => `<url><loc>${SITE}/${2020 + Math.floor(index / 3)}/0${1 + (index % 3) * 3}/10/post-${index}</loc></url>`);
  const site = bakery();
  const inner = site.fetchPage;
  const xml = body => ({ status: 200, headers: { 'content-type': 'application/xml' }, body: Buffer.from(body) });
  site.fetchPage = async url => {
    if (url.pathname === '/sitemap.xml') { site.seen.push(url.pathname); return xml(`<sitemapindex><sitemap><loc>${SITE}/s1.xml</loc></sitemap><sitemap><loc>${SITE}/s2.xml</loc></sitemap></sitemapindex>`); }
    if (url.pathname === '/s1.xml') { site.seen.push(url.pathname); return xml(`<urlset>${urls.slice(0, 5).join('')}</urlset>`); }
    if (url.pathname === '/s2.xml') { site.seen.push(url.pathname); return xml(`<urlset>${urls.slice(5).join('')}</urlset>`); }
    if (/post-/.test(url.pathname)) { site.seen.push(url.pathname); return { status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from(`<title>${url.pathname}</title><p>made up</p>`) }; }
    return inner(url);
  };
  const { result } = await walkOf({ url: `${SITE}/sitemap.xml`, walk: { eras: ['early', 'middle', 'recent'], count: 1 } }, site);
  assert.deepEqual(result.walk.listing_pages.map(page => page.kind), ['sitemap-index', 'sitemap', 'sitemap']);
  assert.equal(result.walk.entries_seen, 9);
  assert.deepEqual(result.walk.pages.map(page => page.era), ['early', 'middle', 'recent']);
  assert.deepEqual([result.title, result.text, result.links], ['', '', []]);
  assert.equal(result.walk.pages[0].date_source, 'url');
});

test('undated entries are never in an era, and eras without any dated entry are refused', async () => {
  const site = bakery();
  const inner = site.fetchPage;
  site.fetchPage = async url => (url.pathname === '/archive' ? { status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from('<ul><li><a href="/x/one">One</a></li><li><a href="/x/two">Two</a></li></ul>') } : inner(url));
  await assert.rejects(readPublicPageOrArchive({ url: `${SITE}/archive`, walk: { eras: ['early'] } }, site.fetchPage, async () => {}), /Eras need dated entries/);
});

test('every request stays on the start address\'s site and meets the same checks as a one-page read', async () => {
  await assert.rejects(readPublicPageOrArchive({ url: 'file:///etc/passwd', walk: {} }, bakery().fetchPage, async () => {}), /Only public HTTP and HTTPS/);
  await assert.rejects(readBody(`${SITE}/archive`, async () => ({ status: 200, headers: { 'content-type': 'application/xml' }, body: Buffer.from('<a/>') })), /HTML or plain-text/);
  const site = bakery();
  const inner = site.fetchPage;
  site.fetchPage = async url => (url.pathname === '/archive' ? { status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from('<ul><li><a href="https://elsewhere.example.test/2024/01/01/x">Off site</a></li><li><a href="/2024/01/02/y">On site</a></li></ul>') } : inner(url));
  const { result } = await walkOf({ url: `${SITE}/archive`, walk: { count: 0 } }, site);
  assert.equal(result.walk.entries_seen, 1);
  const { first, walk } = await walkArchive(`${SITE}/archive`, { count: 0 }, { read: address => readBody(address, site.fetchPage), sleep: async () => {} });
  assert.equal(first.status, 200);
  assert.equal(walk.requests, 2);
});

// A made-up page and its made-up snapshots in a made-up public index.
const PAGE = `${SITE}/menu`;
const stamps = ['20190315101112', '20190915101112', '20200315101112', '20201015101112', '20220115101112', '20220815101112', '20230115101112', '20240215101112', '20241115101112'];
const index = ['not a line', ...stamps.map(stamp => `${stamp} ${PAGE}`), `${stamps[0]} ${PAGE}`, '20241345101112 ' + PAGE].join('\n') + '\n';
function archiveOf({ robots = 'User-agent: *\nDisallow: /nothing\n', moved } = {}) {
  const seen = [];
  const hosts = new Set();
  const fetchPage = async url => {
    hosts.add(url.hostname);
    seen.push(url.pathname + url.search);
    const text = (status, body) => ({ status, headers: { 'content-type': 'text/plain' }, body: Buffer.from(body) });
    if (url.hostname === 'elsewhere.example.test') return { status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from('<title>Elsewhere</title>') };
    if (url.pathname === '/robots.txt') return text(200, robots);
    if (url.pathname === '/cdx/search/cdx') return text(200, index);
    const snapshot = /^\/web\/(\d{14})id_\/(.+)$/.exec(url.pathname);
    if (snapshot && moved === snapshot[1]) return { status: 302, headers: { location: 'https://elsewhere.example.test/x' }, body: Buffer.alloc(0) };
    if (snapshot) return { status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from(`<title>Menu of ${snapshot[1].slice(0, 4)}</title><p>Bread ${snapshot[1]}</p>`) };
    return { status: 404, headers: {}, body: Buffer.alloc(0) };
  };
  return { seen, hosts, fetchPage };
}

test('the Wayback request asks the public index for one snapshot per period, in the window when there is one', () => {
  const asked = new URL(waybackQuery(PAGE, { collapse: 'year', window: { from: '2020-01-01', to: '2022-12-31' } }));
  assert.equal(asked.origin + asked.pathname, 'https://web.archive.org/cdx/search/cdx');
  assert.equal(asked.searchParams.get('url'), PAGE);
  assert.equal(asked.searchParams.get('fl'), 'timestamp,original');
  assert.deepEqual(asked.searchParams.getAll('filter'), ['statuscode:200', 'mimetype:text/html']);
  assert.equal(asked.searchParams.get('collapse'), 'timestamp:4');
  assert.equal(asked.searchParams.get('from'), '20200101');
  assert.equal(asked.searchParams.get('to'), '20221231');
  assert.equal(new URL(waybackQuery(PAGE)).searchParams.get('collapse'), 'timestamp:6');
  assert.equal(new URL(waybackQuery(PAGE)).searchParams.has('from'), false);
});

test('a CDX answer is read as dated snapshots; a line that is not a real snapshot is skipped', () => {
  const entries = cdxEntries(index);
  assert.equal(entries.length, 9);
  assert.deepEqual(entries[0], { url: `https://web.archive.org/web/20190315101112id_/${PAGE}`, original: PAGE, title: '', date: '2019-03-15', date_source: 'snapshot' });
  assert.deepEqual(cdxEntries(''), []);
});

test('a Wayback walk reads count snapshots from each era through the index, with robots, pacing and only the archive\'s host', async () => {
  const site = archiveOf();
  const { waits, sleep } = noSleep();
  const result = await readPublicPageOrArchive({ url: PAGE, walk: { source: 'wayback', eras: ['early', 'middle', 'recent'], count: 1 } }, site.fetchPage, sleep);
  assert.deepEqual([...site.hosts], ['web.archive.org']);
  assert.equal(site.seen[0], '/robots.txt');
  assert.match(site.seen[1], /^\/cdx\/search\/cdx\?url=/);
  assert.equal(result.walk.listing_pages[0].kind, 'wayback-cdx');
  assert.equal(result.walk.entries_seen, 9);
  assert.deepEqual(result.walk.pages.map(page => page.era), ['early', 'middle', 'recent']);
  assert.deepEqual(result.walk.pages.map(page => page.date_source), ['snapshot', 'snapshot', 'snapshot']);
  assert.ok(result.walk.pages.every(page => page.snapshot_of === PAGE && /^Menu of \d{4}$/.test(page.title) && page.text.includes('Bread')));
  assert.equal(result.walk.requests, 5);
  assert.deepEqual(waits, Array(4).fill(2000));
  assert.deepEqual([result.title, result.text], ['', '']);
});

test('a Wayback walk with a window asks the index for those days and spreads count snapshots across them', async () => {
  const site = archiveOf();
  const { result } = await walkOf({ url: PAGE, walk: { source: 'wayback', collapse: 'day', window: { from: '2020-01-01', to: '2022-12-31' }, count: 2 } }, site);
  assert.match(site.seen[1], /collapse=timestamp%3A8/);
  assert.match(site.seen[1], /from=20200101&to=20221231/);
  assert.equal(result.walk.pages.length, 2);
});

test('a Wayback walk obeys the archive\'s robots.txt and records a snapshot that sends the reader elsewhere', async () => {
  await assert.rejects(readPublicPageOrArchive({ url: PAGE, walk: { source: 'wayback' } }, archiveOf({ robots: 'User-agent: *\nDisallow: /cdx' }).fetchPage, async () => {}), /does not allow the start address/);
  const { result } = await walkOf({ url: PAGE, walk: { source: 'wayback', eras: ['recent'], count: 1 } }, archiveOf({ moved: stamps[7] }));
  assert.deepEqual(result.walk.pages.map(page => page.error), ['The page redirected off its own site.']);
  const measure = await walkOf({ url: PAGE, walk: { source: 'wayback', count: 0 } }, archiveOf());
  assert.equal(measure.result.walk.pages.length, 0);
  assert.equal(measure.result.walk.entries_seen, 9);
});
