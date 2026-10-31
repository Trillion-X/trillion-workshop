// The readers, ported from the old research-workspace package's contract tests (test_gather_generic.py and
// test_source_library.py). The old tests ran the readers as strings inside the old runtime's steps; these call them.
// Every fixture is made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  captionFileOrder, channelListingUrl, MAX_SAVED_ITEMS, readBrowserSidebar, readCaptionFile, readCaptionWords, readChannelListing, readFeed,
  readSavedList, readSearchResults, readVttWords, searchUrl,
} from '../do-work/sources.mjs';

test('a channel listing gives one item per video with its watch address, and skips lines that are not videos', () => {
  const lines = [
    { id: 'vid-aaa', title: 'Shaping a loaf', channel: 'Sourdough Notes', upload_date: '20260601', duration_string: '8:21', view_count: 1200 },
    { id: 'vid-bbb', title: 'Scoring' },
    { no_id: true },
  ].map(row => JSON.stringify(row)).join('\n') + '\nnot json at all';
  const listing = readChannelListing(lines);
  assert.equal(listing.items.length, 2);
  assert.equal(listing.source, 'Sourdough Notes');
  assert.deepEqual(listing.items[0], {
    item_id: 'vid-aaa', title: 'Shaping a loaf', duration: ['8:21'], published: '20260601', view_count: 1200,
    url: 'https://www.youtube.com/watch?v=vid-aaa', description: '',
  });
  assert.equal(listing.items[1].view_count, null);
  assert.equal(readChannelListing('', 'https://videos.example/watch?v=').source, '');
  assert.equal(readChannelListing(lines, 'https://videos.example/watch?v=').items[1].url, 'https://videos.example/watch?v=vid-bbb');
});

test('a channel is found from a link, a channel id, a handle or a bare name', () => {
  assert.equal(channelListingUrl('https://videos.example/@sourdough/'), 'https://videos.example/@sourdough/videos');
  assert.equal(channelListingUrl('https://videos.example/@sourdough/videos'), 'https://videos.example/@sourdough/videos');
  assert.equal(channelListingUrl('https://videos.example/@sourdough/shorts/'), 'https://videos.example/@sourdough/shorts');
  assert.equal(channelListingUrl('https://videos.example/@sourdough/streams'), 'https://videos.example/@sourdough/streams');
  assert.equal(channelListingUrl('https://videos.example/playlist?list=PL-bread'), 'https://videos.example/playlist?list=PL-bread');
  assert.equal(channelListingUrl(`UC${'a'.repeat(22)}`), `https://www.youtube.com/channel/UC${'a'.repeat(22)}/videos`);
  assert.equal(channelListingUrl('@sourdough'), 'https://www.youtube.com/@sourdough/videos');
  assert.equal(channelListingUrl('sourdough'), 'https://www.youtube.com/@sourdough/videos');
  assert.throws(() => channelListingUrl('  '), /Say which channel/);
});

test('an Atom feed gives its title and each entry with the id it names', () => {
  const atom = '<feed xmlns="http://www.w3.org/2005/Atom" xmlns:yt="http://example.org/ns">'
    + '<title>Bakery Weekly</title>'
    + '<entry><yt:videoId>abc</yt:videoId><title>Tray &amp; oven</title>'
    + '<link rel="alternate" href="https://videos.example/abc"/><published>2026-06-01</published>'
    + '<summary><![CDATA[<p>All about trays</p>]]></summary></entry>'
    + '<entry><title>No id, no link</title></entry></feed>';
  const feed = readFeed(atom);
  assert.equal(feed.source, 'Bakery Weekly');
  assert.equal(feed.items.length, 1);
  assert.deepEqual(feed.items[0], {
    item_id: 'abc', title: 'Tray & oven', published: '2026-06-01', url: 'https://videos.example/abc', description: 'All about trays',
  });
});

test('an RSS feed gives its channel title and its items, an item with only a link takes the link as its id, and &amp;lt; stays text', () => {
  const rss = '<rss><channel><title>Flour News</title>'
    + '<item><title>Rye &amp;lt;b&amp;gt;</title><link>https://news.example/rye</link><guid>g-1</guid><pubDate>Mon, 01 Jun 2026</pubDate><description>Rye.</description></item>'
    + '<item><title>Spelt</title><link>https://news.example/spelt</link></item></channel></rss>';
  const feed = readFeed(rss);
  assert.equal(feed.source, 'Flour News');
  assert.deepEqual(feed.items.map(item => item.item_id), ['g-1', 'https://news.example/spelt']);
  assert.equal(feed.items[0].title, 'Rye &lt;b&gt;');
  assert.deepEqual(readFeed('not a feed'), { source: '', items: [] });
});

test('a search is encoded, bounded and refused when empty or too long', () => {
  assert.ok(searchUrl('bread flour & hydration').endsWith('q=bread+flour+%26+hydration'));
  assert.throws(() => searchUrl(''), /Send query/);
  assert.throws(() => searchUrl('x'.repeat(501)), /Send query/);
  assert.doesNotThrow(() => searchUrl('x'.repeat(500)));
});

test('search results keep the address each result cites, not the engine address, and no more than the limit', () => {
  const html = '<div class="result"><a class="result__a" href="//search.example/l/?uddg=https%3A%2F%2Fbakery.example%2Fguide">Baking <b>Guide</b></a>'
    + '<a class="result__snippet">Primary guidance &amp; tips.</a></div>'
    + '<div class="result"><a class="result__a" href="javascript:void(0)">Not a page</a></div>'
    + '<div class="result"><a class="result__a" href="https://second.example/page">Second</a></div>';
  const found = readSearchResults(html);
  assert.equal(found.source, 'DuckDuckGo HTML');
  assert.equal(found.items.length, 2);
  assert.equal(found.items[0].url, 'https://bakery.example/guide');
  assert.equal(found.items[0].title, 'Baking Guide');
  assert.equal(found.items[0].description, 'Primary guidance & tips.');
  assert.deepEqual(found.items[0].citation, { url: 'https://bakery.example/guide', retrieved_via: 'DuckDuckGo HTML' });
  assert.equal(found.items[1].url, 'https://second.example/page');
  assert.equal(readSearchResults(html, 1).items.length, 1);
  const many = Array.from({ length: 30 }, (_, i) => `<a class="result__a" href="https://site${i}.example/">r${i}</a>`).join('');
  assert.equal(readSearchResults(many).items.length, 10);
});

test('a saved source catalog is read into items with a license status that defaults to unknown', () => {
  const catalog = { schema: 'source-list', description: 'Bakery sources', sources: [
    { slug: 'fixture-source', source_url: 'https://library.example/', status: 'discovered', license_status: 'unknown', probe: { title: 'Fixture library' } },
  ] };
  const read = readSavedList(JSON.stringify(catalog));
  assert.equal(read.source, 'Source catalog');
  assert.equal(read.items.length, 1);
  assert.equal(read.items[0].item_id, 'fixture-source');
  assert.equal(read.items[0].title, 'Fixture library');
  assert.equal(read.items[0].license_status, 'unknown');
  assert.equal(read.items[0].lifecycle_status, 'discovered');
  assert.equal(read.items[0].container_path, 'Bakery sources');
});

test('saved bookmarks take their id from the status number in the link, and a row with no id gets a stable one', () => {
  const capture = { mode: 'bookmarks', refreshed_at: '2026-09-02T00:00:00Z', bookmarks: [
    { url: 'https://posts.example/someone/status/123', text: 'Filter thingy example', who: 'someone' },
    { text: 'No link here' },
    'not a row',
  ] };
  const read = readSavedList(JSON.stringify(capture));
  assert.equal(read.source, 'bookmarks capture');
  assert.equal(read.items.length, 2);
  assert.equal(read.items[0].item_id, 'status:123');
  assert.equal(read.items[0].source_type, 'bookmark');
  assert.equal(read.items[0].title, 'Filter thingy example');
  assert.equal(read.items[1].item_id, readSavedList(JSON.stringify(capture)).items[1].item_id);
  assert.match(read.items[1].item_id, /^saved:/);
});

test('a saved list can be a plain array or hold its rows under items, and it is cut at 5000', () => {
  assert.equal(readSavedList(JSON.stringify([{ id: 'a', title: 'A' }])).source, 'Saved array');
  assert.equal(readSavedList(JSON.stringify({ items: [{ id: 'a' }] })).source, 'items');
  const large = JSON.stringify({ sources: Array.from({ length: 20_000 }, (_, i) => ({ slug: `large-${i}`, source_url: `https://library.example/${i}` })) });
  const read = readSavedList(large);
  assert.equal(read.items.length, MAX_SAVED_ITEMS);
  assert.equal(read.items[0].item_id, 'large-0');
  assert.equal(readSavedList(large, 3).items.length, 3);
  assert.throws(() => readSavedList('{nope'), /not valid JSON/);
});

test('a browser sidebar gives the default profile\'s tabs and folders, and withholds addresses that look private', () => {
  const sidebar = { sidebar: { containers: [{
    items: [
      'ROOT', { childrenIds: ['FOLDER', 'TAB-SENSITIVE', 'TAB-MISSING'] },
      'FOLDER', { id: 'FOLDER', title: 'Recipes', createdAt: 700000000, childrenIds: ['TAB-1'], data: { list: {} } },
      'TAB-1', { id: 'TAB-1', createdAt: 700000000, childrenIds: [], data: { tab: { savedURL: 'https://bakery.example/docs', savedTitle: 'Docs' } } },
      'TAB-SENSITIVE', { id: 'TAB-SENSITIVE', createdAt: 700000000, childrenIds: [], data: { tab: { savedURL: 'https://console.bakery.example/account/123?token=secret' } } },
    ],
    spaces: [
      'OTHER', { id: 'OTHER', title: 'Work', profile: { default: false }, containerIDs: ['pinned', 'ROOT'] },
      'SPACE', { id: 'SPACE', title: 'Home', profile: { default: true }, containerIDs: ['pinned', 'ROOT'] },
    ],
  }] } };
  const read = readBrowserSidebar(JSON.stringify(sidebar));
  assert.equal(read.source, 'Home');
  const byId = Object.fromEntries(read.items.map(item => [item.item_id, item]));
  assert.equal(byId['tab:TAB-1'].url, 'https://bakery.example/docs');
  assert.equal(byId['tab:TAB-1'].title, 'Docs');
  assert.equal(byId['tab:TAB-1'].container_path, 'Home / Pinned / Recipes');
  assert.equal(byId['tab:FOLDER'].source_type, 'folder');
  assert.match(byId['tab:TAB-1'].published, /^2023-/);
  const sensitive = byId['tab:TAB-SENSITIVE'];
  assert.equal(sensitive.url, '');
  assert.equal(sensitive.title, 'Private page');
  assert.match(sensitive.description, /withheld/);
  assert.equal(sensitive.sensitive, true);
  assert.equal(byId['tab:TAB-MISSING'], undefined);
  assert.throws(() => readBrowserSidebar(JSON.stringify({ sidebar: { containers: [] } })), /No default profile/);
});

test('caption words join every spoken segment, and the original-language file is read first', () => {
  const json3 = JSON.stringify({ events: [{ segs: [{ utf8: 'Fold the' }, { utf8: '\n' }, { utf8: 'dough' }] }, { segs: [{ utf8: ' gently\nnow' }] }, {}] });
  assert.equal(readCaptionWords(json3), 'Fold the dough gently now');
  assert.equal(readCaptionWords('not json'), '');
  assert.deepEqual(captionFileOrder(['sub.fr.json3', 'sub.en.vtt', 'sub.en.json3', 'sub.en-orig.json3', 'notes.txt']), ['sub.en-orig.json3', 'sub.en.json3', 'sub.en.vtt', 'sub.fr.json3']);
});

test('WebVTT captions give the spoken lines without timings, cue ids, tags or a line said twice running', () => {
  const vtt = 'WEBVTT\nKind: captions\nLanguage: en\n\n1\n00:00:00.000 --> 00:00:01.400\nThere’s no way I&#39;m\n\n2\n00:00:01.400 --> 00:00:03.000 align:start\n<c>Fold</c> the dough\nFold the dough\n\nNOTE a comment\n\n00:00:03.000 --> 00:00:04.000\n2026\n';
  assert.equal(readVttWords(vtt), 'There’s no way I\'m Fold the dough 2026');
  assert.equal(readVttWords(''), '');
  assert.equal(readCaptionFile('sub.en.vtt', vtt), readVttWords(vtt));
  assert.equal(readCaptionFile('sub.en.json3', JSON.stringify({ events: [{ segs: [{ utf8: 'Hi' }] }] })), 'Hi');
});
