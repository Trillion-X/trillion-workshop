// tools/watch-my-sources/test/watch-sources.test.mjs (moved from Trillion-X/trillion test/watch-sources.test.mjs)
//
// The places a person follows, watched (read-data/watch-sources.mjs) over their lists kept as records behind a records
// door (tools/records-door/read-data/lists-door.mjs over test/memory-door.mjs), with the network (read) and the person's model route (ask)
// stubbed: RSS, Atom (YouTube's media:description), JSON and a page's change each become rows; a source's first read is
// a baseline that hands nothing on; a later read keeps what is new, weighs it in ONE question and hands only what moves a
// pursuit (directly or as an insight) to the arrival door; the rest is set aside; an X account without a feed, a
// subscriptions source and a failing source say their problem; reading again adds nothing; an unchanged address (304)
// costs no model; a YouTube channel falls back to its uploads playlist and then its videos page; a ranked list's moves
// are signals once; and one run reads and weighs a bounded number. Every page, item, title and channel here is made up.
import assert from 'node:assert/strict';
import test from 'node:test';
import data from '../read-data/watch-sources.json' with { type: 'json' };
import { listsOverDoor } from '../../records-door/read-data/lists-door.mjs';
import { movementOf } from '../read-data/ranked-lists.mjs';
import { watchSources } from '../read-data/watch-sources.mjs';
import { memoryDoor } from './memory-door.mjs';

const fill = (text, values) => text.replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));
// A channel's videos page as the site carries it (ytInitialData): each upload one lockupViewModel with its id and title.
const videoPage = videos => `<html><body><script>var ytInitialData = ${JSON.stringify({ contents: { items: videos.map(([id, title]) => ({ richItemRenderer: { content: { lockupViewModel: { contentId: id, contentType: 'LOCKUP_CONTENT_TYPE_VIDEO', metadata: { lockupMetadataViewModel: { title: { content: title } } } } } } })) } }).replaceAll('"metadata":{"lockupMetadataViewModel"', '"lockupMetadataViewModel"').replaceAll('}}}}}}', '}}}}}')};</script></body></html>`;
const videosPage = videoPage([['AAAAAAAAAA1', 'Making a plugin, part one'], ['AAAAAAAAAA2', 'Build Plugins for the Example App'], ['AAAAAAAAAA3', 'Q&A from the workshop']]);
// A best-seller list as its site carries it: the items in a page attribute (JSON, its quotes as entities) and each title
// beside its item id, 50 to a page over two pages. The item at rank 47 has no title on the page.
const BEST_SELLERS = 'https://www.amazon.com/Best-Sellers-Example/zgbs/example';
const BEST_SELLER_PAGES = [BEST_SELLERS, `${BEST_SELLERS}?pg=2`];
const rankOf = rec => Number(rec.metadataMap['render.zg.rank']);
const itemId = rank => `B0${String(rank).padStart(8, '0')}`;
const recOf = rank => ({ id: itemId(rank), metadataMap: { 'render.zg.rank': String(rank) }, linkParameters: {} });
const titleOf = rank => `Example product ${rank}, made up for this test`;
const listPage = (recs, titled = rec => rankOf(rec) !== 47) => `<html><body><div class="p13n" data-client-recs-list="${JSON.stringify(recs).replaceAll('"', '&quot;')}"></div>${recs.filter(titled).map(rec => `<div data-asin="${rec.id}" class="x"><span>#${rankOf(rec)}</span><div class="_cDEzb_p13n-sc-css-line-clamp-3_g3dy1">${titleOf(rankOf(rec))}</div></div>`).join('')}</body></html>`;
const bestSellers = [listPage(Array.from({ length: 50 }, (_, at) => recOf(at + 1))), listPage(Array.from({ length: 50 }, (_, at) => recOf(at + 51)))];
// The items of a page (its data-client-recs-list attribute), and the same page with them replaced.
const recsOf = page => JSON.parse(/ data-client-recs-list="([^"]*)"/.exec(page)[1].replaceAll('&quot;', '"'));
const withRecs = (page, recs) => page.replace(/ data-client-recs-list="[^"]*"/, () => ` data-client-recs-list="${JSON.stringify(recs).replaceAll('"', '&quot;')}"`);
const ranked = (rec, rank) => ({ ...rec, metadataMap: { ...rec.metadataMap, 'render.zg.rank': String(rank) } });
// A trending-products table as its site gives it, a Nuxt page payload (devalue's flat form: every value inside an object
// or array is the index of another entry), with its products in order and the date the site gave its list.
const flatten = root => {
  const flat = [];
  const put = value => {
    const at = flat.length;
    flat.push(null);
    flat[at] = value !== null && typeof value === 'object'
      ? (Array.isArray(value) ? value.map(put) : Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, put(inner)])))
      : value;
    return at;
  };
  put(root);
  return JSON.stringify(flat);
};
const TRENDING = 'https://findniche.com/tiktok/trending-products-example';
const products = Array.from({ length: 100 }, (_, at) => ({ product_id: String(9_000_000_000 + at + 1), title: `Example trending product ${at + 1}`, price: `$${at + 1}.99`, week_order: `${100 - at}.00K` }));
const trendingPayload = (list = products, date = '2026-10-01') => flatten({ data: { 'trending-example': { products: list, update_date: date } } });
const PURSUITS = [{ id: 'p1', title: 'Launch the podcast', now: 'Recording episode one', after: 'Publish weekly' }];
const FORMATS = [{ id: 'f1', label: 'Short video script', description: 'A sixty second script spoken to camera.' }];

const rss = items => `<?xml version="1.0"?><rss version="2.0"><channel><title>Blog</title>${items.map(item => `<item><title>${item.title}</title><link>${item.link}</link><guid>${item.guid ?? item.link}</guid><pubDate>${item.date ?? 'Tue, 06 Oct 2026 09:00:00 GMT'}</pubDate><description><![CDATA[${item.summary ?? ''}]]></description></item>`).join('')}</channel></rss>`;
const atom = entries => `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom" xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/"><title>Channel</title>${entries.map(entry => `<entry><id>yt:video:${entry.id}</id><title>${entry.title}</title><link rel="alternate" href="https://www.youtube.com/watch?v=${entry.id}"/><published>${entry.date ?? '2026-10-06T09:00:00+00:00'}</published><media:group><media:title>${entry.title}</media:title><media:description>${entry.description ?? ''}</media:description></media:group></entry>`).join('')}</feed>`;

function setup() {
  const door = memoryDoor();
  const lists = listsOverDoor(door);
  const world = { pages: new Map(), requests: [], asked: [], arrivals: [], clock: Date.parse('2026-10-07T08:00:00Z'), judge: () => ({ moves: null, how: null, format: null, why: 'Nothing here.' }), pursuits: PURSUITS, formats: FORMATS, lists, door };
  world.read = async (url, init = {}) => {
    world.requests.push({ url: String(url), headers: init.headers ?? {} });
    const page = world.pages.get(String(url));
    if (!page) return new Response('no', { status: 404 });
    const body = typeof page === 'function' ? page(init.headers ?? {}) : page;
    return body instanceof Response ? body : new Response(body.text, { headers: { 'content-type': body.type ?? 'application/rss+xml', ...(body.headers ?? {}) } });
  };
  // Answers each numbered item by its title through world.judge(title) -> { moves, how, format, why }.
  world.ask = async request => {
    world.asked.push(request);
    const user = request.messages.at(-1).content;
    const items = [...user.matchAll(/^(\d+)\. Source: .*\n {3}Title: (.*)$/gm)].map(([, n, title]) => ({ n: Number(n), ...{ moves: null, how: null, format: null, why: '' }, ...world.judge(title) }));
    return { reply: JSON.stringify({ items }), model: 'stub' };
  };
  world.arrive = async arrival => { world.arrivals.push(arrival); return {}; };
  world.run = (input = {}) => watchSources({ lists, read: world.read, pursuits: async () => world.pursuits, formats: async () => world.formats, ask: world.ask, arrive: world.arrive, now: () => new Date(world.clock) }, input);
  world.later = minutes => { world.clock += minutes * 60_000; };
  world.source = async (id, values) => {
    // As the tool makes it before any ranked source is watched: a link field waits for the list it names.
    await lists.ensure({ ...data.sources, fields: data.sources.fields.filter(field => !field.links_to) }, { actor: { by: 'test' } });
    await lists.putRows('signal-sources', { rows: [{ id, values: { name: id, watching: 'Yes', ...values } }] }, { actor: { by: 'test' } });
  };
  world.signals = async () => (await lists.read('signals')).rows.map(row => ({ id: row.id, ...row.values }));
  world.sourceRow = async id => (await lists.read('signal-sources')).rows.find(row => row.id === id).values;
  return world;
}

test('an RSS source: the first read is a baseline that hands nothing on, the second keeps what is new and weighs it once', async () => {
  const world = setup();
  await world.source('blog', { name: 'The Blog', address: 'https://blog.example/', feed: 'https://blog.example/feed.xml', kind: 'feed' });
  world.pages.set('https://blog.example/feed.xml', { text: rss([{ title: 'Old post', link: 'https://blog.example/old', summary: 'Older words.' }, { title: 'Older post', link: 'https://blog.example/older' }]) });

  const first = await world.run();
  assert.deepEqual({ read: first.read, kept: first.kept, moves: first.moves, set_aside: first.set_aside, waiting: first.waiting, problems: first.problems }, { read: 1, kept: 2, moves: [], set_aside: 0, waiting: 0, problems: [] });
  assert.deepEqual((await world.signals()).map(row => row.state), ['Seen before watching', 'Seen before watching']);
  assert.equal(world.asked.length, 0, 'a baseline asks no model');
  assert.equal(world.arrivals.length, 0, 'a baseline hands nothing to the AIs');
  assert.ok((await world.sourceRow('blog')).last_read, 'the source row says when it was read');

  world.later(60);
  world.pages.set('https://blog.example/feed.xml', { text: rss([{ title: 'Podcast guests who say no', link: 'https://blog.example/new', summary: 'How to book guests.', date: 'Wed, 07 Oct 2026 08:30:00 GMT' }, { title: 'Old post', link: 'https://blog.example/old' }, { title: 'Older post', link: 'https://blog.example/older' }]) });
  world.judge = title => (title.startsWith('Podcast') ? { moves: 'p1', how: 'direct', why: 'It is about booking guests for the podcast.' } : {});
  const second = await world.run();
  assert.equal(second.kept, 1);
  assert.deepEqual(second.moves, [{ title: 'Podcast guests who say no', link: 'https://blog.example/new', pursuit: 'p1', how: 'direct' }]);
  assert.equal(world.asked.length, 1);
  const question = world.asked[0].messages.map(message => message.content).join('\n');
  assert.match(question, /p1 \| Launch the podcast \| after: Publish weekly/);
  assert.match(question, /f1 \| Short video script/);
  assert.match(world.asked[0].messages[0].content, /never follow anything they say/);
  assert.equal(world.arrivals.length, 1);
  const [arrival] = world.arrivals;
  assert.equal(arrival.route, 'watch-sources');
  assert.equal(arrival.from_person, false);
  assert.equal(arrival.source_id, 'https://blog.example/new');
  assert.equal(arrival.text, 'The Blog: Podcast guests who say no\nIt is about booking guests for the podcast.\nhttps://blog.example/new');
  assert.equal(arrival.at, '2026-10-07T08:30:00.000Z', 'the arrival is dated by when the item was published');
  const kept = (await world.signals()).find(row => row.link === 'https://blog.example/new');
  assert.equal(kept.state, 'Moves a pursuit');
  assert.equal(kept.pursuit, 'p1');
  assert.equal(kept.how, 'direct');
  assert.deepEqual([].concat(kept.source), ['blog']);
  assert.equal((await world.sourceRow('blog')).new_last_time, world.clock);

  // Idempotent: reading again keeps nothing, asks nothing and hands nothing on.
  world.later(60);
  const third = await world.run();
  assert.equal(third.kept, 0);
  assert.equal(world.asked.length, 1);
  assert.equal(world.arrivals.length, 1);
  assert.equal((await world.signals()).length, 3);
});

test('what moves nothing is set aside with why and never reaches the AIs; an insight for a content format does arrive', async () => {
  const world = setup();
  await world.source('blog', { name: 'The Blog', feed: 'https://blog.example/feed.xml', kind: 'feed', last_read: '2026-10-06T00:00:00.000Z' });
  world.pages.set('https://blog.example/feed.xml', { text: rss([
    { title: 'Ten tax tips', link: 'https://blog.example/tax', date: 'Wed, 07 Oct 2026 06:00:00 GMT' },
    { title: 'How a ramen shop earns trust in one sentence', link: 'https://blog.example/ramen', date: 'Wed, 07 Oct 2026 06:30:00 GMT' },
    { title: 'Why launches need a villain', link: 'https://blog.example/villain', date: 'Wed, 07 Oct 2026 07:00:00 GMT' },
  ]) });
  world.judge = title => {
    if (title.startsWith('Ten tax')) return { moves: null, how: null, format: null, why: 'It shares a word, nothing more.' };
    if (title.startsWith('How a ramen')) return { moves: null, how: 'insight', format: 'f1', why: 'A one-sentence hook fits a sixty second script.' };
    return { moves: 'p1', how: 'insight', format: null, why: 'A villain gives the launch a story.' };
  };
  const report = await world.run();
  assert.equal(report.kept, 3);
  assert.equal(report.set_aside, 1);
  assert.equal(report.waiting, 0);
  assert.equal(world.asked.length, 1, 'all three are weighed in one question');
  const byLink = new Map((await world.signals()).map(row => [row.link, row]));
  assert.equal(byLink.get('https://blog.example/tax').state, 'Set aside');
  assert.equal(byLink.get('https://blog.example/tax').why, 'It shares a word, nothing more.');
  assert.equal(byLink.get('https://blog.example/ramen').how, 'insight');
  assert.equal(byLink.get('https://blog.example/villain').pursuit, 'p1');
  assert.deepEqual(world.arrivals.map(arrival => arrival.source_id).sort(), ['https://blog.example/ramen', 'https://blog.example/villain']);
  assert.match(world.arrivals.find(arrival => arrival.source_id.endsWith('ramen')).text, /Insight for your Short video script format: A one-sentence hook/);
  assert.match(world.arrivals.find(arrival => arrival.source_id.endsWith('villain')).text, /Insight for Launch the podcast: A villain/);
});

test('an Atom feed from YouTube keeps media:description as the summary', async () => {
  const world = setup();
  await world.source('chan', { name: 'A channel', feed: 'https://www.youtube.com/feeds/videos.xml?channel_id=UCabcdefghijklmnopqrstuv', kind: 'youtube-channel', last_read: '2026-10-06T00:00:00.000Z' });
  world.pages.set('https://www.youtube.com/feeds/videos.xml?channel_id=UCabcdefghijklmnopqrstuv', { text: atom([{ id: 'vid00000001', title: 'Build Plugins', description: 'Learn to build &amp; ship plugins.', date: '2026-10-07T06:00:00+00:00' }]), type: 'application/atom+xml' });
  world.judge = () => ({ moves: 'p1', how: 'direct', why: 'Plugins are what the podcast covers.' });
  const report = await world.run();
  assert.equal(report.kept, 1);
  const [row] = (await world.signals());
  assert.equal(row.link, 'https://www.youtube.com/watch?v=vid00000001');
  assert.equal(row.summary, 'Learn to build & ship plugins.');
  assert.equal(row.published.slice(0, 10), '2026-10-07');
  assert.equal(world.arrivals.length, 1);
});

test('a JSON feed is read the same way', async () => {
  const world = setup();
  await world.source('notes', { name: 'Release notes', feed: 'https://app.example/notes.json', kind: 'feed', last_read: '2026-10-06T00:00:00.000Z' });
  world.pages.set('https://app.example/notes.json', { type: 'application/json', text: JSON.stringify({ items: [{ id: 'n1', title: 'Podcast hosting added', url: 'https://app.example/n1', date_published: '2026-10-07T07:00:00Z', summary: 'Host a show.' }] }) });
  world.judge = () => ({ moves: 'p1', how: 'direct', why: 'Hosting is part of launching.' });
  const report = await world.run();
  assert.equal(report.kept, 1);
  assert.equal((await world.signals())[0].link, 'https://app.example/n1');
  assert.equal(world.arrivals.length, 1);
});

test('a page is watched by its words: the first read is a baseline, a change is one item named "<name> changed"', async () => {
  const world = setup();
  await world.source('changelog', { name: 'Their changelog', address: 'https://tool.example/changelog', kind: 'page' });
  const html = words => ({ type: 'text/html', text: `<html><head><title>Changelog</title></head><body><main><h1>Changelog</h1><p>${words}</p></main></body></html>` });
  world.pages.set('https://tool.example/changelog', html('Version one shipped.'));
  const first = await world.run();
  assert.equal(first.kept, 1);
  assert.equal((await world.signals())[0].state, 'Seen before watching');
  assert.equal(world.arrivals.length, 0);

  world.later(60);
  assert.equal((await world.run()).kept, 0, 'the same words are the same item');
  world.later(60);
  world.pages.set('https://tool.example/changelog', html('Version two shipped with podcast hosting.'));
  world.judge = () => ({ moves: 'p1', how: 'direct', why: 'It now hosts podcasts.' });
  const changed = await world.run();
  assert.equal(changed.kept, 1);
  assert.equal(changed.moves[0].title, 'Their changelog changed');
  assert.match(world.arrivals[0].source_id, /^https:\/\/tool\.example\/changelog#page:/);
  assert.match(world.arrivals[0].text, /^Their changelog: Their changelog changed\n/);
});

test('an X account without a feed, a subscriptions source and a channel with no address say their problem and stop nothing', async () => {
  const world = setup();
  await world.source('x', { name: 'Someone on X', address: 'https://x.com/someone', kind: 'x-account' });
  await world.source('subs', { name: 'My subscriptions', kind: 'youtube-subscriptions' });
  await world.source('blog', { name: 'The Blog', feed: 'https://blog.example/feed.xml', kind: 'feed' });
  world.pages.set('https://blog.example/feed.xml', { text: rss([{ title: 'A post', link: 'https://blog.example/a' }]) });
  const report = await world.run();
  assert.equal(report.read, 1, 'the other source is still read');
  assert.deepEqual(report.problems.sort((a, b) => a.name.localeCompare(b.name)), [
    { name: 'My subscriptions', problem: 'connect YouTube to read your subscriptions' },
    { name: 'Someone on X', problem: 'X has no public feed; give a feed address' },
  ]);
  assert.equal((await world.sourceRow('x')).problem, 'X has no public feed; give a feed address');
  assert.equal(world.requests.some(request => request.url.includes('x.com')), false, 'X is never fetched');
  assert.deepEqual(data.sources.fields.find(field => field.id === 'kind').choices, ['feed', 'youtube-channel', 'youtube-subscriptions', 'x-account', 'page', 'ranked-list']);
});

test('an X account with a feed address is read like any feed', async () => {
  const world = setup();
  await world.source('x', { name: 'Someone on X', address: 'https://x.com/someone', feed: 'https://bridge.example/someone.xml', kind: 'x-account' });
  world.pages.set('https://bridge.example/someone.xml', { text: rss([{ title: 'A post', link: 'https://x.com/someone/status/1' }]) });
  const report = await world.run();
  assert.equal(report.read, 1);
  assert.deepEqual(report.problems, []);
});

test('an address that answered 304 is read with nothing new and no model; the ETag and Last-Modified are kept and sent back', async () => {
  const world = setup();
  await world.source('blog', { name: 'The Blog', feed: 'https://blog.example/feed.xml', kind: 'feed' });
  world.pages.set('https://blog.example/feed.xml', { text: rss([{ title: 'A post', link: 'https://blog.example/a' }]), headers: { etag: '"v1"', 'last-modified': 'Tue, 06 Oct 2026 09:00:00 GMT' } });
  await world.run();
  assert.equal((await world.sourceRow('blog')).etag, '"v1"');
  assert.equal((await world.sourceRow('blog')).modified, 'Tue, 06 Oct 2026 09:00:00 GMT');

  world.later(60);
  world.pages.set('https://blog.example/feed.xml', headers => {
    assert.equal(headers['if-none-match'], '"v1"');
    assert.equal(headers['if-modified-since'], 'Tue, 06 Oct 2026 09:00:00 GMT');
    return new Response(null, { status: 304 });
  });
  const report = await world.run();
  assert.deepEqual({ read: report.read, kept: report.kept, problems: report.problems }, { read: 1, kept: 0, problems: [] });
  assert.equal(world.asked.length, 0);
  assert.equal((await world.sourceRow('blog')).etag, '"v1"', 'what the address gave is kept');
});

test('a feed with more new items than one run takes saves no validator, so the next read gets the whole feed and keeps the rest', async () => {
  const world = setup();
  await world.source('blog', { name: 'The Blog', feed: 'https://blog.example/feed.xml', kind: 'feed' });
  world.pages.set('https://blog.example/feed.xml', { text: rss([{ title: 'Post zero', link: 'https://blog.example/0' }]), headers: { etag: '"v1"' } });
  await world.run();
  const six = rss(Array.from({ length: 6 }, (_, at) => ({ title: `Post ${at}`, link: `https://blog.example/${at}` })));
  world.pages.set('https://blog.example/feed.xml', headers => {
    if (headers['if-none-match'] === '"v2"') return new Response(null, { status: 304 });
    return new Response(six, { headers: { 'content-type': 'application/rss+xml', etag: '"v2"' } });
  });
  world.later(60);
  const first = await world.run({ most_per_source: 3 });
  assert.equal(first.kept, 3);
  assert.equal((await world.sourceRow('blog')).etag ?? null, null, 'the validator of a partly kept feed is not saved');
  world.later(60);
  const second = await world.run();
  assert.equal(second.read, 1);
  assert.equal(second.kept, 2, 'the rest of the feed is kept on the next read');
  assert.equal((await world.signals()).length, 6);
});

test('a YouTube channel whose feed answers 404 tries its uploads playlist once, then its videos page as a browser would', async () => {
  const world = setup();
  const channel = 'UCabcdefghijklmnopqrstuv';
  await world.source('chan', { name: 'A maker', address: `https://www.youtube.com/channel/${channel}`, kind: 'youtube-channel' });
  world.pages.set(`https://www.youtube.com/channel/${channel}/videos`, { type: 'text/html', text: videosPage });
  const first = await world.run();
  assert.deepEqual(world.requests.map(request => request.url), [
    `https://www.youtube.com/feeds/videos.xml?channel_id=${channel}`,
    `https://www.youtube.com/feeds/videos.xml?playlist_id=UU${channel.slice(2)}`,
    `https://www.youtube.com/channel/${channel}/videos`,
  ]);
  const page = world.requests.at(-1).headers;
  assert.match(page['user-agent'], /Mozilla\/5\.0/);
  assert.equal(page['accept-language'], 'en');
  assert.equal(first.kept, 3);
  assert.deepEqual(first.problems, []);
  const titles = (await world.signals()).map(row => row.title);
  assert.ok(titles.includes('Making a plugin, part one'));
  assert.ok(titles.includes('Q&A from the workshop'), 'a title is read from the page\'s own data');
  assert.equal((await world.signals()).find(row => row.title === 'Build Plugins for the Example App').link, 'https://www.youtube.com/watch?v=AAAAAAAAAA2');
  assert.ok((await world.signals()).every(row => row.published), 'the page names no date, so the time first seen is kept');

  // The playlist feed answering is enough: the page is not asked.
  const other = setup();
  await other.source('chan', { name: 'Chan', address: `https://www.youtube.com/channel/${channel}`, kind: 'youtube-channel' });
  other.pages.set(`https://www.youtube.com/feeds/videos.xml?playlist_id=UU${channel.slice(2)}`, { text: atom([{ id: 'vid00000002', title: 'From the playlist' }]), type: 'application/atom+xml' });
  assert.equal((await other.run()).kept, 1);
  assert.equal(other.requests.length, 2);
});

test('a new video on a handle\'s videos page arrives once weighed, and the same page again adds nothing', async () => {
  const world = setup();
  await world.source('chan', { name: 'A maker', address: 'https://www.youtube.com/@amaker', kind: 'youtube-channel' });
  world.pages.set('https://www.youtube.com/@amaker/videos', { type: 'text/html', text: videosPage });
  await world.run();
  assert.equal(world.arrivals.length, 0);
  world.later(60);
  const newest = videosPage.replaceAll('Build Plugins for the Example App', 'Build Plugins for the Example App Again').replaceAll('AAAAAAAAAA2', 'ZZZZZZZZZZZ');
  world.pages.set('https://www.youtube.com/@amaker/videos', { type: 'text/html', text: newest });
  world.judge = () => ({ moves: 'p1', how: 'direct', why: 'Plugins matter here.' });
  const report = await world.run();
  assert.equal(report.kept, 1);
  assert.equal(world.arrivals[0].source_id, 'https://www.youtube.com/watch?v=ZZZZZZZZZZZ');
  world.later(60);
  assert.equal((await world.run()).kept, 0);
});

test('a source that keeps failing keeps being watched and its problem says for how long', async () => {
  const world = setup();
  await world.source('gone', { name: 'Gone', feed: 'https://gone.example/feed.xml', kind: 'feed' });
  const runs = [];
  for (let run = 1; run <= 5; run += 1) {
    runs.push(await world.run());
    world.later(24 * 60);
  }
  assert.equal(runs[0].problems[0].problem, 'gone.example answered 404 instead of a feed or a page.');
  assert.match(runs[4].problems[0].problem, /It has failed 5 runs in a row, since 2026-10-07\./);
  assert.equal((await world.sourceRow('gone')).watching, 'Yes');
  world.pages.set('https://gone.example/feed.xml', { text: rss([{ title: 'Back', link: 'https://gone.example/back' }]) });
  const back = await world.run();
  assert.deepEqual(back.problems, []);
  assert.equal((await world.sourceRow('gone')).problem ?? null, null);
  assert.equal((await world.sourceRow('gone')).failed_runs ?? null, null);
});

test('one run reads at most 25 sources and weighs at most 20 items; the rest wait and are taken next run', async () => {
  const world = setup();
  for (let index = 0; index < 27; index += 1) {
    const id = `s${String(index).padStart(2, '0')}`;
    await world.source(id, { name: id, feed: `https://${id}.example/feed.xml`, kind: 'feed', last_read: '2026-10-06T00:00:00.000Z' });
    world.pages.set(`https://${id}.example/feed.xml`, { text: rss([{ title: `Item ${id}`, link: `https://${id}.example/a`, date: 'Wed, 07 Oct 2026 07:00:00 GMT' }]) });
  }
  const first = await world.run();
  assert.equal(first.read, 25);
  assert.equal(first.sources_waiting, 2);
  assert.equal(first.kept, 25);
  assert.equal(first.set_aside, 20);
  assert.equal(first.waiting, 5, 'items past the cap stay New for the next run');
  assert.equal(world.asked.length, 1);
  assert.equal((await world.signals()).filter(row => row.state === 'New').length, 5);

  world.later(60);
  const second = await world.run();
  assert.equal(second.kept, 2, 'the two sources not read yet come first');
  assert.equal(second.set_aside, 5, 'the five that waited are weighed alone: the open batch is the oldest run\'s');
  assert.equal(second.waiting, 2);
  assert.equal((await world.signals()).filter(row => row.state === 'New').length, 2);

  world.later(60);
  const third = await world.run();
  assert.equal(third.set_aside, 2, 'the two kept by the second run are the next batch');
  assert.equal(third.waiting, 0);
});

test('a question no route answered is sent byte-identical by the next run, whatever was kept or rewritten since, so a held answer is found', async () => {
  const world = setup();
  await world.source('blog', { name: 'The Blog', feed: 'https://blog.example/feed.xml', kind: 'feed', last_read: '2026-10-06T00:00:00.000Z' });
  const item = name => ({ title: name, link: `https://blog.example/${name}`, date: 'Wed, 07 Oct 2026 07:00:00 GMT' });
  const feed = [item('Alpha'), item('Beta')];
  world.pages.set('https://blog.example/feed.xml', { text: rss(feed) });
  const answer = world.ask;
  const sent = [];
  world.ask = async request => { sent.push(request.messages); throw Object.assign(new Error('No chosen AI.'), { no_chosen_ai: true }); };

  const first = await world.run();
  assert.equal(first.kept, 2);
  assert.equal(first.waiting, 2);

  world.later(60);
  feed.push(item('Gamma'));
  world.pages.set('https://blog.example/feed.xml', { text: rss(feed) });
  world.pursuits = [{ ...PURSUITS[0], now: 'Editing episode one' }];
  const second = await world.run();
  assert.equal(second.kept, 1);
  assert.equal(second.waiting, 3);
  assert.equal(sent.length, 2);
  assert.equal(JSON.stringify(sent[1]), JSON.stringify(sent[0]), 'the same bytes, so the answer held for the first is the answer to the second');
  assert.doesNotMatch(sent[1].at(-1).content, /Gamma/);

  world.ask = answer;
  world.later(60);
  const third = await world.run();
  assert.equal(third.set_aside, 2);
  assert.equal(third.waiting, 1);
  assert.deepEqual((await world.signals()).filter(row => row.state === 'New').map(row => row.title), ['Gamma']);

  world.later(60);
  const fourth = await world.run();
  assert.equal(fourth.set_aside, 1);
  assert.equal(fourth.waiting, 0);
  assert.match(world.asked.at(-1).messages.at(-1).content, /Gamma/);
});

test('when no route can answer, the items stay New and are weighed on a later run; nothing is lost or sent', async () => {
  const world = setup();
  await world.source('blog', { name: 'The Blog', feed: 'https://blog.example/feed.xml', kind: 'feed', last_read: '2026-10-06T00:00:00.000Z' });
  world.pages.set('https://blog.example/feed.xml', { text: rss([{ title: 'Podcast news', link: 'https://blog.example/a', date: 'Wed, 07 Oct 2026 07:00:00 GMT' }]) });
  const answer = world.ask;
  world.ask = async () => { throw Object.assign(new Error('No chosen AI.'), { no_chosen_ai: true }); };
  const report = await world.run();
  assert.equal(report.kept, 1);
  assert.equal(report.waiting, 1);
  assert.deepEqual(report.problems, []);
  assert.equal((await world.signals())[0].state, 'New');
  assert.equal(world.arrivals.length, 0);

  world.ask = answer;
  world.later(60);
  world.judge = () => ({ moves: 'p1', how: 'direct', why: 'It is about the podcast.' });
  const later = await world.run();
  assert.equal(later.kept, 0);
  assert.equal(later.moves.length, 1);
  assert.equal(later.waiting, 0);
});

test('with no pursuit and no content format recorded, nothing is weighed or handed on', async () => {
  const world = setup();
  world.pursuits = [];
  world.formats = [];
  await world.source('blog', { name: 'The Blog', feed: 'https://blog.example/feed.xml', kind: 'feed', last_read: '2026-10-06T00:00:00.000Z' });
  world.pages.set('https://blog.example/feed.xml', { text: rss([{ title: 'A post', link: 'https://blog.example/a', date: 'Wed, 07 Oct 2026 07:00:00 GMT' }]) });
  const report = await world.run();
  assert.equal(report.waiting, 1);
  assert.equal(world.asked.length, 0);
});

test('the two lists are made with their fields, the lists named in the input are used, and a source marked No is not read', async () => {
  const world = setup();
  await world.run();
  const fields = async id => (await world.lists.read(id)).list.fields.map(field => field.id);
  assert.deepEqual((await fields('signal-sources')).slice(0, 8), ['name', 'address', 'feed', 'kind', 'watching', 'last_read', 'new_last_time', 'problem']);
  assert.deepEqual((await fields('signals')).slice(0, 3), ['title', 'link', 'key']);
  const signalFields = await fields('signals');
  assert.ok(['source', 'published', 'summary', 'state', 'pursuit', 'how', 'why'].every(id => signalFields.includes(id)));
  assert.deepEqual((await world.lists.read('signals')).list.fields.find(field => field.id === 'state').choices, ['Seen before watching', 'New', 'Moves a pursuit', 'Set aside', 'From the history']);

  await world.source('off', { name: 'Off', feed: 'https://off.example/feed.xml', kind: 'feed', watching: 'No' });
  assert.equal((await world.run()).read, 0);
  assert.equal(world.requests.length, 0);
  await world.run({ sources_list_id: 'my-places', items_list_id: 'my-items', most_per_source: 3 });
  assert.ok((await world.lists.read('my-places')) && (await world.lists.read('my-items')));
  await assert.rejects(world.run({ sources_list_id: 'Not A List' }), /sources_list_id is the id of a list/);
});

test('an arrival names the route the person\'s attention rule acts on, and the weighing names the purpose of its model route', async () => {
  const world = setup();
  await world.source('blog', { name: 'The Blog', feed: 'https://blog.example/feed.xml', kind: 'feed', last_read: '2026-10-06T00:00:00.000Z' });
  world.pages.set('https://blog.example/feed.xml', { text: rss([{ title: 'Podcast news', link: 'https://blog.example/a', date: 'Wed, 07 Oct 2026 07:00:00 GMT' }]) });
  world.judge = () => ({ moves: 'p1', how: 'direct', why: 'It is about the podcast.' });
  await world.run();
  assert.equal(world.arrivals[0].route, data.route);
  assert.match(JSON.stringify(world.asked[0]), /"role":"system"/);
  assert.equal(data.route, 'watch-sources');
  assert.equal(data.weigh.purpose, 'signal-weigh');
});

test('a first read remembers every item the source lists, past the per-run cap, so none comes back as New', async () => {
  const world = setup();
  await world.source('hunt', { name: 'Launches', address: 'https://hunt.example/', feed: 'https://hunt.example/feed', kind: 'feed' });
  const items = Array.from({ length: 30 }, (_, i) => ({ title: `Launch ${i}`, link: `https://hunt.example/${i}`, date: 'Wed, 07 Oct 2026 08:30:00 GMT' }));
  world.pages.set('https://hunt.example/feed', { text: rss(items) });
  const first = await world.run();
  assert.equal(first.kept, 30);
  assert.ok((await world.signals()).every(row => row.state === 'Seen before watching'));
  world.later(60);
  const second = await world.run();
  assert.equal(second.kept, 0, 'the same 30 items again add nothing');
  assert.equal(second.waiting, 0);
  assert.equal(world.asked.length, 0);
});

test('a Signals list made before a field existed gains it, keeping the fields the person added', async () => {
  const world = setup();
  const older = data.items.fields.filter(field => field.id !== 'kept_run').map(field => (field.links_to ? { ...field, links_to: 'signal-sources' } : field));
  await world.source('blog', { name: 'The Blog', address: 'https://blog.example/', feed: 'https://blog.example/feed.xml', kind: 'feed' });
  await world.lists.save({ ...data.items, fields: [...older, { id: 'mine', label: 'Mine', kind: 'text' }] }, { actor: { by: 'test' } });
  world.pages.set('https://blog.example/feed.xml', { text: rss([{ title: 'Old post', link: 'https://blog.example/old' }]) });
  await world.run();
  world.later(60);
  world.pages.set('https://blog.example/feed.xml', { text: rss([{ title: 'New post', link: 'https://blog.example/new', date: 'Wed, 07 Oct 2026 08:30:00 GMT' }, { title: 'Old post', link: 'https://blog.example/old' }]) });
  await world.run();
  const fields = (await world.lists.read('signals')).list.fields.map(field => field.id);
  assert.ok(fields.includes('kept_run') && fields.includes('mine'));
  assert.ok(Number((await world.signals()).find(row => row.title === 'New post').kept_run) > 0, 'a row kept after the upgrade carries kept_run');
});

test('a verdict that names the link of another item is not applied, so a misnumbered answer never moves the wrong item', async () => {
  const world = setup();
  await world.source('blog', { name: 'The Blog', address: 'https://blog.example/', feed: 'https://blog.example/feed.xml', kind: 'feed' });
  world.pages.set('https://blog.example/feed.xml', { text: rss([{ title: 'Old post', link: 'https://blog.example/old' }]) });
  await world.run();
  world.later(60);
  world.pages.set('https://blog.example/feed.xml', { text: rss([{ title: 'Podcast guests', link: 'https://blog.example/a', date: 'Wed, 07 Oct 2026 08:30:00 GMT' }, { title: 'Old post', link: 'https://blog.example/old' }]) });
  world.ask = async request => {
    world.asked.push(request);
    return { reply: JSON.stringify({ items: [{ n: 1, link: 'https://blog.example/somewhere-else', moves: 'p1', how: 'direct', format: null, why: 'Written for another item.' }] }) };
  };
  const run = await world.run();
  assert.deepEqual(run.moves, []);
  assert.equal(world.arrivals.length, 0);
  assert.equal((await world.signals()).find(row => row.title === 'Podcast guests').state, 'New');
});

test('a source set to take in its whole history names the computer tool that lists it, keeps every item that tool listed as From the history, and hands none on', async () => {
  const world = setup();
  const address = 'https://www.youtube.com/channel/UCexampleexampleexample1';
  await world.source('one', { name: 'Channel one', address, kind: 'youtube-channel', history: data.history.whole });
  await world.source('blog', { name: 'The Blog', address: 'https://blog.example/', feed: 'https://blog.example/feed.xml', kind: 'feed', history: data.history.whole });
  world.pages.set('https://www.youtube.com/feeds/videos.xml?channel_id=UCexampleexampleexample1', { text: atom([{ id: 'vid00000010', title: 'Newest' }]), type: 'application/atom+xml' });
  world.pages.set('https://blog.example/feed.xml', { text: rss([{ title: 'Post', link: 'https://blog.example/post' }]) });
  const first = await world.run();
  assert.deepEqual(first.history_wanted, [{ source: 'one', name: 'Channel one', tool_id: 'tool:list-every-video-on-a-channel', input: { url: address } }],
    'only a kind with a history tool asks for its history');
  const answer = { url: address, count: 3, entries: [
    { id: 'vid00000010', url: 'https://www.youtube.com/watch?v=vid00000010', title: 'Newest' },
    { id: 'vid00000011', url: 'https://www.youtube.com/watch?v=vid00000011', title: 'Course' },
    { id: 'vid00000012', url: 'https://www.youtube.com/shorts/vid00000012', title: 'A short' },
  ] };
  const taken = await world.run({ history: { source: 'one', answer } });
  assert.deepEqual(taken.history, { source: 'one', kept: 2, already: 1, left: 0 });
  const rows = (await world.signals()).filter(row => [].concat(row.source)[0] === 'one');
  assert.deepEqual(rows.map(row => row.title).sort(), ['A short', 'Course', 'Newest']);
  assert.deepEqual(rows.filter(row => row.title !== 'Newest').map(row => row.state), [data.states.history, data.states.history]);
  assert.equal(world.arrivals.length, 0); assert.equal(world.asked.length, 0, 'history is never weighed or handed on');
  assert.ok((await world.sourceRow('one')).history_taken);
  const again = await world.run({ history: { source: 'one', answer } });
  assert.deepEqual(again.history, { source: 'one', kept: 0, already: 3, left: 0 }, 'taking the history again adds nothing');
  world.later(60);
  assert.equal((await world.run()).history_wanted, undefined, 'a taken history is not asked for again');
  for (const [history, said] of [[{ source: 'blog', answer }, data.words.history_no_tool], [{ source: 'nobody', answer }, data.words.history_no_source],
    [{ source: 'one', answer: { entries: 'x' } }, data.words.history_no_entries]]) {
    await assert.rejects(world.run({ history }), error => error.status === 400 && error.message === fill(said, { name: { blog: 'The Blog', one: 'Channel one' }[history.source] ?? history.source }));
  }
  await world.source('other', { name: 'Other', address: 'https://www.youtube.com/channel/UCexampleexampleexample2', kind: 'youtube-channel' });
  await assert.rejects(world.run({ history: { source: 'other', answer } }), error => error.message === fill(data.words.history_not_wanted, { name: 'Other' }));
});

test('a history longer than one take keeps the first history_max items and says how many are left, and is not marked taken until all are in', async () => {
  const world = setup();
  const address = 'https://www.youtube.com/channel/UCexampleexampleexample2';
  await world.source('two', { name: 'Channel two', address, kind: 'youtube-channel', history: data.history.whole });
  const entries = Array.from({ length: data.limits.history_max + 2 }, (_, at) => ({ id: `v${String(at).padStart(10, '0')}`, url: `https://www.youtube.com/watch?v=v${at}`, title: `Video ${at}` }));
  const first = await world.run({ history: { source: 'two', answer: { entries } } });
  assert.deepEqual(first.history, { source: 'two', kept: data.limits.history_max, already: 0, left: 2 });
  assert.equal((await world.sourceRow('two')).history_taken ?? null, null);
  const second = await world.run({ history: { source: 'two', answer: { entries } } });
  assert.deepEqual(second.history, { source: 'two', kept: 2, already: data.limits.history_max, left: 0 });
  assert.ok((await world.sourceRow('two')).history_taken);
});

test('a ranked list: the first read keeps every rank quietly, the next day\'s climbs, falls, entries and drop-outs become signals once', async () => {
  const world = setup();
  await world.source('grocery', { name: 'Best sellers — Example', address: BEST_SELLERS, kind: 'ranked-list' });
  BEST_SELLER_PAGES.forEach((url, at) => world.pages.set(url, { text: bestSellers[at], type: 'text/html' }));

  const first = await world.run();
  assert.deepEqual({ read: first.read, kept: first.kept, ranked: first.ranked, problems: first.problems }, { read: 1, kept: 0, ranked: 100, problems: [] });
  assert.deepEqual(world.requests.map(request => request.url), BEST_SELLER_PAGES, 'both pages of the list are read');
  const rows = (await world.lists.read('ranked-items')).rows.map(row => row.values);
  assert.equal(rows.length, 100);
  assert.deepEqual(rows.map(row => row.rank).sort((a, b) => a - b), Array.from({ length: 100 }, (_, at) => at + 1));
  const top = rows.find(row => row.rank === 1);
  assert.deepEqual({ item: top.item, title: top.title, link: top.link, best: top.best_rank, previous: top.previous_rank ?? null, days: top.days_listed, recent: top.recent_ranks, first: top.first_seen },
    { item: itemId(1), title: titleOf(1), link: `https://www.amazon.com/dp/${itemId(1)}`, best: 1, previous: null, days: 1, recent: '2026-10-07:1', first: '2026-10-07' });
  const untitled = rows.find(row => row.rank === 47);
  assert.equal(untitled.title, untitled.item, 'an item the page carries no title for is named by its id');
  assert.equal((await world.sourceRow('grocery')).on_the_list.length, 100);
  assert.equal((await world.signals()).length, 0, 'a first read is a quiet baseline');
  assert.equal(world.asked.length, 0);

  // The next day: #47 climbs to 12, #3 falls to 40, #100 drops out, a new item enters at 20, #10 moves to 8 (too little).
  world.later(24 * 60);
  const [one, two] = bestSellers.map(recsOf);
  const by = rank => [...one, ...two].find(rec => rankOf(rec) === rank);
  const climber = by(47);
  const faller = by(3);
  const leaver = by(100);
  const shifted = new Map([[climber.id, 12], [faller.id, 40], [by(10).id, 8]]);
  const entrant = { id: 'B0NEWENTRY', metadataMap: { 'render.zg.rank': '20' }, linkParameters: {} };
  const moved = recs => recs.filter(rec => rec.id !== leaver.id).map(rec => (shifted.has(rec.id) ? ranked(rec, shifted.get(rec.id)) : rec));
  const block = '<div data-asin="B0NEWENTRY" class="x"><span class="zg-bdg-text">#20</span><div class="_cDEzb_p13n-sc-css-line-clamp-3_g3dy1">Example newcomer, made up for this test</div>';
  world.pages.set(BEST_SELLER_PAGES[0], { text: withRecs(bestSellers[0], [...moved(one), entrant]).replace('</body>', `${block}</body>`), type: 'text/html' });
  world.pages.set(BEST_SELLER_PAGES[1], { text: withRecs(bestSellers[1], moved(two)), type: 'text/html' });
  world.judge = title => (title.includes('newcomer') ? { moves: 'p1', how: 'insight', why: 'A newcomer shows a gap.' } : {});
  const second = await world.run();
  const fallerTitle = (await world.lists.read('ranked-items')).rows.find(row => row.values.item === faller.id).values.title;
  assert.deepEqual((await world.signals()).map(row => row.title).sort(), [
    `Climbed 47 → 12: ${climber.id}`, `Dropped out (was 100): ${(await world.lists.read('ranked-items')).rows.find(row => row.values.item === leaver.id).values.title}`,
    `Fell 3 → 40: ${fallerTitle}`, 'New at 20: Example newcomer, made up for this test',
  ].sort());
  assert.equal(second.kept, 4);
  assert.equal(world.asked.length, 1, 'every movement is weighed in one question');
  assert.deepEqual(second.moves, [{ title: 'New at 20: Example newcomer, made up for this test', link: 'https://www.amazon.com/dp/B0NEWENTRY', pursuit: 'p1', how: 'insight' }]);
  assert.equal(world.arrivals.length, 1);
  assert.equal(world.arrivals[0].source_id, 'https://www.amazon.com/dp/B0NEWENTRY#rank:B0NEWENTRY:entered:2026-10-08', 'a movement arrives by its own identity, not only its link');
  const after = new Map((await world.lists.read('ranked-items')).rows.map(row => [row.values.item, row.values]));
  assert.equal(after.size, 101);
  assert.deepEqual([after.get(climber.id).rank, after.get(climber.id).previous_rank, after.get(climber.id).best_rank, after.get(climber.id).days_listed, after.get(climber.id).recent_ranks],
    [12, 47, 12, 2, '2026-10-07:47 2026-10-08:12']);
  assert.deepEqual([after.get(leaver.id).rank ?? null, after.get(leaver.id).previous_rank, after.get(leaver.id).last_seen], [null, 100, '2026-10-07']);
  assert.deepEqual([after.get('B0NEWENTRY').first_seen, after.get('B0NEWENTRY').previous_rank ?? null], ['2026-10-08', null]);
  assert.equal((await world.sourceRow('grocery')).on_the_list.length, 100);

  // Read again the same day: measured against the same day before, so nothing is kept twice.
  world.later(60);
  const third = await world.run();
  assert.equal(third.kept, 0);
  assert.equal((await world.signals()).length, 4);
  assert.equal(world.asked.length, 1);
  assert.equal(new Map((await world.lists.read('ranked-items')).rows.map(row => [row.values.item, row.values])).get(climber.id).previous_rank, 47, 'the day before stays the day before');

  // The day after, unchanged: no movement, and the day before becomes yesterday.
  world.later(24 * 60);
  const fourth = await world.run();
  assert.equal(fourth.kept, 0);
  const steady = new Map((await world.lists.read('ranked-items')).rows.map(row => [row.values.item, row.values])).get(climber.id);
  assert.deepEqual([steady.rank, steady.previous_rank, steady.days_listed], [12, 12, 3]);
});

test('a ranked list that cannot be read says why in its row, keeps its ranks, and stops no other source', async () => {
  const world = setup();
  await world.source('grocery', { name: 'Grocery', address: BEST_SELLERS, kind: 'ranked-list' });
  await world.source('blog', { name: 'The Blog', feed: 'https://blog.example/feed.xml', kind: 'feed' });
  await world.source('elsewhere', { name: 'Elsewhere', address: 'https://charts.example/top', kind: 'ranked-list' });
  BEST_SELLER_PAGES.forEach((url, at) => world.pages.set(url, { text: bestSellers[at], type: 'text/html' }));
  world.pages.set('https://blog.example/feed.xml', { text: rss([{ title: 'Post', link: 'https://blog.example/post' }]) });
  await world.run();
  const kept = (await world.sourceRow('grocery')).on_the_list;
  assert.deepEqual((await world.sourceRow('elsewhere')).problem, fill(data.words.no_rank_reader, { host: 'charts.example' }));

  world.later(24 * 60);
  world.pages.set(BEST_SELLER_PAGES[1], new Response('busy', { status: 503 }));
  let report = await world.run();
  assert.deepEqual(report.problems.find(one => one.name === 'Grocery'), { name: 'Grocery', problem: fill(data.words.answered, { host: 'www.amazon.com', status: 503 }) });
  assert.ok(report.read >= 1, 'the feed is still read');

  world.later(60);
  world.pages.set(BEST_SELLER_PAGES[1], { text: '<html><body><form action="/errors/validateCaptcha">Type the characters you see</form></body></html>', type: 'text/html' });
  report = await world.run();
  assert.equal((await world.sourceRow('grocery')).problem, fill(data.words.no_ranks, { host: 'www.amazon.com' }), 'a robot check is a problem, never an empty list');
  assert.equal((await world.sourceRow('grocery')).failed_runs, 2);
  assert.deepEqual((await world.sourceRow('grocery')).on_the_list, kept, 'what was on the list is kept until it is read whole');
  assert.equal((await world.signals()).filter(row => String(row.key).startsWith('rank:')).length, 0, 'a page it could not read drops nothing out');
  assert.ok((await world.lists.read('ranked-items')).rows.every(row => row.values.rank !== null && row.values.rank !== undefined));
});

test('a ranked list is made only for a person who watches one, and a movement needs enough places', async () => {
  const world = setup();
  await world.source('blog', { name: 'The Blog', feed: 'https://blog.example/feed.xml', kind: 'feed' });
  world.pages.set('https://blog.example/feed.xml', { text: rss([{ title: 'Post', link: 'https://blog.example/post' }]) });
  await world.run();
  assert.equal(await world.lists.has('ranked-items'), false);
  assert.equal((await world.lists.read('signal-sources')).list.fields.some(field => field.id === 'on_the_list'), false);
  const limits = data.limits;
  assert.deepEqual([[47, 12], [4, 2], [10, 5], [3, 40], [10, 20], [10, 14], [5, null], [null, 20], [null, 101], [null, null]].map(([from, to]) => movementOf(from, to, limits)),
    ['climbed', null, 'climbed', 'fell', 'fell', null, 'dropped', 'entered', null, null]);
});

test('a ranked list a site gives as a page payload is read by the same engine, its facts kept, and a list the site has not re-dated is never measured twice', async () => {
  const world = setup();
  await world.source('tiktok', { name: 'Trending top 100', address: TRENDING, kind: 'ranked-list' });
  world.pages.set(`${TRENDING}/_payload.json`, { text: trendingPayload(), type: 'application/json' });
  const first = await world.run();
  assert.deepEqual({ read: first.read, kept: first.kept, ranked: first.ranked, problems: first.problems }, { read: 1, kept: 0, ranked: 100, problems: [] });
  assert.deepEqual(world.requests.map(request => request.url), [`${TRENDING}/_payload.json`]);
  const rows = new Map((await world.lists.read('ranked-items')).rows.map(row => [row.values.rank, row.values]));
  assert.deepEqual([rows.get(1).item, rows.get(1).title.slice(0, 21), rows.get(1).price, rows.get(1).sales, rows.get(1).link],
    ['9000000001', 'Example trending prod', '$1.99', '100.00K', 'https://shop.tiktok.com/us/pdp/9000000001']);
  assert.equal(rows.size, 100);
  assert.equal((await world.sourceRow('tiktok')).list_dated, '2026-10-01');

  // The next day the site still gives the list of 2026-10-01: it is not measured again, so no day is counted twice.
  world.later(24 * 60);
  const second = await world.run();
  assert.deepEqual({ kept: second.kept, ranked: second.ranked }, { kept: 0, ranked: 0 });
  assert.equal(new Map((await world.lists.read('ranked-items')).rows.map(row => [row.values.rank, row.values])).get(1).days_listed, 1);

  // Then the site re-dates its list with the last product first: it climbed 99 places.
  world.later(24 * 60);
  world.pages.set(`${TRENDING}/_payload.json`, { text: trendingPayload([products.at(-1), ...products.slice(0, -1)], '2026-10-08'), type: 'application/json' });
  const third = await world.run();
  assert.equal(third.ranked, 100);
  assert.deepEqual((await world.signals()).map(row => row.title), ['Climbed 100 → 1: Example trending product 100']);
  assert.equal((await world.sourceRow('tiktok')).list_dated, '2026-10-08');
});

// A run once read the whole signals list (every signal ever kept, each with its linked source) four times and was stopped
// at its command's statement bound. It is read once, its own values only.
test('a run reads the signals list once, without its linked values, and still weighs what it kept', async () => {
  const world = setup();
  await world.source('blog', { name: 'The Blog', address: 'https://blog.example/', feed: 'https://blog.example/feed.xml', kind: 'feed' });
  world.pages.set('https://blog.example/feed.xml', { text: rss([{ title: 'Old post', link: 'https://blog.example/old' }]) });
  await world.run();
  world.later(60);
  world.pages.set('https://blog.example/feed.xml', { text: rss([{ title: 'New post', link: 'https://blog.example/new' }, { title: 'Old post', link: 'https://blog.example/old' }]) });
  world.judge = () => ({ moves: null, how: null, format: null, why: 'Not for now.' });
  const read = world.lists.read.bind(world.lists), reads = [];
  world.lists.read = (id, options = {}) => { reads.push([id, options.only ? 'own values' : 'whole']); return read(id, options); };
  const second = await world.run();
  assert.deepEqual({ kept: second.kept, set_aside: second.set_aside }, { kept: 1, set_aside: 1 }, 'the new post is kept and weighed in the same run');
  assert.deepEqual(reads.filter(([id]) => id === 'signals'), [['signals', 'own values']]);
});

// Each source's items and its own row were once written one source at a time (two writes a source); a run writes each
// list once.
test('a run writes what it kept, and each source\'s new state, once for the whole run', async () => {
  const world = setup();
  for (const id of ['one', 'two', 'three']) {
    await world.source(id, { name: id, address: `https://${id}.example/`, feed: `https://${id}.example/feed.xml`, kind: 'feed' });
    world.pages.set(`https://${id}.example/feed.xml`, { text: rss([{ title: `${id} post`, link: `https://${id}.example/post` }]) });
  }
  const put = world.lists.putRows.bind(world.lists), puts = [];
  world.lists.putRows = (id, input, options) => { puts.push([id, input.rows.length]); return put(id, input, options); };
  const report = await world.run();
  assert.deepEqual({ read: report.read, kept: report.kept }, { read: 3, kept: 3 });
  assert.deepEqual(puts, [['signals', 3], ['signal-sources', 3]]);
  const sourceRows = await Promise.all(['one', 'two', 'three'].map(id => world.sourceRow(id)));
  assert.ok(sourceRows.every(row => row.last_read), 'every source says when it was read');
});
