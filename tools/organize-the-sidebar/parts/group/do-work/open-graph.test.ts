// packages/group/do-work/open-graph.test.ts
//
// Proves the R11 rich-embed extractor: one pure parser turns ANY page's HTML into the
// LinkPreview DATA the card renders — Open Graph first, then Twitter Card, then bare HTML,
// attribute-order agnostic, entity-decoded, relative URLs absolutized, never throws. No
// per-site code (Pinterest/IG/YouTube all expose og:image → same path).

import { describe, expect, it } from '../../../../../test-helpers/vitest-shim.mjs';
import { parseOpenGraph, parseOpenGraphImages, metaContentAll, metaContent, decodeHtmlEntities, titleTag, faviconHref, absolutize, linkRelHref, itempropUrl, jsonLdField, jsonLdUrl, jsonLdVideoUrl, jsonLdNodeByType, jsonLdText } from '../../../do-work/open-graph.ts';

describe('parseOpenGraphImages — the multi-image GALLERY (R11 carousel, b194+)', () => {
  it('collects EVERY og:image (a multi-photo post → the carousel), deduped, in order', () => {
    const html = `<html><head>
      <meta property="og:image" content="https://cdn.example.com/1.jpg">
      <meta property="og:image" content="https://cdn.example.com/2.jpg">
      <meta property="og:image" content="https://cdn.example.com/1.jpg">
      <meta name="twitter:image" content="https://cdn.example.com/3.jpg">
    </head></html>`;
    expect(parseOpenGraphImages(html)).toEqual([
      'https://cdn.example.com/1.jpg', 'https://cdn.example.com/2.jpg', 'https://cdn.example.com/3.jpg',
    ]); // 1.jpg deduped, twitter:image merged
  });

  it('absolutizes relative image urls and drops unsafe schemes (fail-closed)', () => {
    const html = `<html><head>
      <meta property="og:image" content="/photos/a.png">
      <meta property="og:image" content="javascript:alert(1)">
    </head></html>`;
    expect(parseOpenGraphImages(html, 'https://site.test/post')).toEqual(['https://site.test/photos/a.png']);
  });

  it('the single-image parseOpenGraph().image is the first gallery image; empty HTML → []', () => {
    const html = `<html><head><meta property="og:image" content="https://x.test/hero.jpg"><meta property="og:image" content="https://x.test/2.jpg"></head></html>`;
    expect(parseOpenGraphImages(html)[0]).toBe(parseOpenGraph(html).image);
    expect(parseOpenGraphImages('')).toEqual([]);
  });

  it('metaContentAll returns every value of a repeated tag (first-order)', () => {
    const html = `<meta property="og:image" content="a"><meta property="og:image" content="b">`;
    expect(metaContentAll(html, 'og:image')).toEqual(['a', 'b']);
  });

  it('parseOpenGraph stores `images` ONLY for a genuine gallery (>1); single-image keeps just `image`', () => {
    const multi = `<html><head><meta property="og:image" content="https://x.test/1.jpg"><meta property="og:image" content="https://x.test/2.jpg"></head></html>`;
    const p = parseOpenGraph(multi);
    expect(p.image).toBe('https://x.test/1.jpg'); // hero = first
    expect(p.images).toEqual(['https://x.test/1.jpg', 'https://x.test/2.jpg']);
    // a single-image page: image set, images omitted (nothing changes for the common case)
    const single = parseOpenGraph(`<html><head><meta property="og:image" content="https://x.test/hero.jpg"></head></html>`);
    expect(single.image).toBe('https://x.test/hero.jpg');
    expect(single.images).toBeUndefined();
  });
});

describe('parseOpenGraph — raw HTML → rich LinkPreview (R11)', () => {
  it('pulls og:image/title/description (the rich card, not a bare link)', () => {
    const html = `<html><head>
      <meta property="og:title" content="Amazing Board">
      <meta property="og:description" content="A vision board about pottery">
      <meta property="og:image" content="https://cdn.example.com/hero.jpg">
    </head></html>`;
    expect(parseOpenGraph(html)).toEqual({
      title: 'Amazing Board',
      description: 'A vision board about pottery',
      image: 'https://cdn.example.com/hero.jpg',
    });
  });

  it('attribute order does not matter (content before OR after the property attr)', () => {
    const a = `<meta property="og:image" content="https://x/y.png">`;
    const b = `<meta content="https://x/y.png" property="og:image">`;
    expect(parseOpenGraph(a).image).toBe('https://x/y.png');
    expect(parseOpenGraph(b).image).toBe('https://x/y.png');
  });

  it('falls back og → twitter → bare HTML per field', () => {
    const html = `<html><head>
      <title>Bare Title</title>
      <meta name="twitter:image" content="https://x/tw.png">
      <meta name="description" content="meta desc">
    </head></html>`;
    const p = parseOpenGraph(html);
    expect(p.image).toBe('https://x/tw.png'); // no og:image → twitter:image
    expect(p.title).toBe('Bare Title');       // no og/twitter title → <title>
    expect(p.description).toBe('meta desc');   // no og/twitter desc → <meta name=description>
  });

  it('og:image wins over twitter:image when both present (order = richness)', () => {
    const html = `
      <meta property="og:image" content="https://x/og.png">
      <meta name="twitter:image" content="https://x/tw.png">`;
    expect(parseOpenGraph(html).image).toBe('https://x/og.png');
  });

  it('EMERGENT: <link rel="image_src"> image fallback (Pinterest/WordPress/FB-share, no og:image)', () => {
    const html = `<title>Old Pin</title><link rel="image_src" href="https://i.pinimg.com/x/legacy.jpg">`;
    expect(parseOpenGraph(html).image).toBe('https://i.pinimg.com/x/legacy.jpg');
  });

  it('EMERGENT: schema.org itemprop="image" fallback (recipe/news page, no OG/Twitter/image_src)', () => {
    const meta = `<meta itemprop="image" content="https://recipes.example/pie.jpg"><title>Pie</title>`;
    expect(parseOpenGraph(meta).image).toBe('https://recipes.example/pie.jpg');
    // works from a <link>/<img> microdata carrier too (content|href|src, order-agnostic)
    const img = `<img src="https://n.example/thumb.jpg" itemprop="image" alt="x">`;
    expect(parseOpenGraph(img).image).toBe('https://n.example/thumb.jpg');
  });

  it('image fallback ORDER: og:image > image_src > itemprop (richness wins)', () => {
    const all = `
      <meta property="og:image" content="https://x/og.png">
      <link rel="image_src" href="https://x/legacy.png">
      <meta itemprop="image" content="https://x/micro.png">`;
    expect(parseOpenGraph(all).image).toBe('https://x/og.png');
    const noOg = `
      <link rel="image_src" href="https://x/legacy.png">
      <meta itemprop="image" content="https://x/micro.png">`;
    expect(parseOpenGraph(noOg).image).toBe('https://x/legacy.png'); // image_src beats itemprop
  });

  it('EMERGENT: JSON-LD "image" fallback (Instagram/Pinterest/news structured data, no OG tags)', () => {
    const str = `<script type="application/ld+json">{"@type":"Article","image":"https://cdn.ig/pic.jpg"}</script>`;
    expect(parseOpenGraph(str).image).toBe('https://cdn.ig/pic.jpg');
    // ImageObject {url} form
    const obj = `<script type="application/ld+json">{"image":{"@type":"ImageObject","url":"https://cdn/o.jpg"}}</script>`;
    expect(parseOpenGraph(obj).image).toBe('https://cdn/o.jpg');
    // array form (first wins)
    const arr = `<script type="application/ld+json">{"image":["https://cdn/a.jpg","https://cdn/b.jpg"]}</script>`;
    expect(parseOpenGraph(arr).image).toBe('https://cdn/a.jpg');
  });

  it('JSON-LD image is found inside a nested @graph, and a malformed block is skipped (fail-open)', () => {
    const graph = `
      <script type="application/ld+json">{ not valid json }</script>
      <script type="application/ld+json">{"@graph":[{"@type":"WebPage"},{"@type":"Recipe","image":"https://r/pie.jpg"}]}</script>`;
    expect(parseOpenGraph(graph).image).toBe('https://r/pie.jpg');
  });

  it('EMERGENT: JSON-LD headline/name → title and description → description (JSON-LD-only page)', () => {
    const post = `<script type="application/ld+json">{"@type":"Article","headline":"Ten Serve Drills","description":"A field guide.","image":"https://x/i.jpg"}</script>`;
    const p = parseOpenGraph(post);
    expect(p.title).toBe('Ten Serve Drills'); // no og:title, no <title> → JSON-LD headline
    expect(p.description).toBe('A field guide.'); // no meta description → JSON-LD description
    // `name` is the title fallback when there is no `headline`
    expect(parseOpenGraph(`<script type="application/ld+json">{"name":"Just a Name"}</script>`).title).toBe('Just a Name');
  });

  it('title/description ORDER: og + <title> beat JSON-LD', () => {
    const html = `
      <title>Real Page Title</title>
      <meta name="description" content="Real meta description">
      <script type="application/ld+json">{"headline":"LD headline","description":"LD desc"}</script>`;
    const p = parseOpenGraph(html);
    expect(p.title).toBe('Real Page Title'); // <title> wins over JSON-LD headline
    expect(p.description).toBe('Real meta description'); // meta description wins over JSON-LD
  });

  it('image fallback ORDER: image_src beats JSON-LD beats itemprop', () => {
    const all = `
      <link rel="image_src" href="https://x/legacy.png">
      <script type="application/ld+json">{"image":"https://x/ld.png"}</script>
      <meta itemprop="image" content="https://x/micro.png">`;
    expect(parseOpenGraph(all).image).toBe('https://x/legacy.png');
    const noLegacy = `
      <script type="application/ld+json">{"image":"https://x/ld.png"}</script>
      <meta itemprop="image" content="https://x/micro.png">`;
    expect(parseOpenGraph(noLegacy).image).toBe('https://x/ld.png'); // JSON-LD beats itemprop
  });

  it('absolutizes a relative <link rel="image_src"> / itemprop image against the page URL', () => {
    expect(parseOpenGraph(`<link rel="image_src" href="/pin/hero.jpg">`, 'https://p.com/deep').image)
      .toBe('https://p.com/pin/hero.jpg');
  });

  it('absolutizes a relative og:image/favicon against the page URL', () => {
    const html = `
      <meta property="og:image" content="/img/hero.jpg">
      <link rel="icon" href="/favicon.ico">`;
    const p = parseOpenGraph(html, 'https://site.example.com/page');
    expect(p.image).toBe('https://site.example.com/img/hero.jpg');
    expect(p.favicon).toBe('https://site.example.com/favicon.ico');
  });

  it('decodes HTML entities in meta content', () => {
    const html = `<meta property="og:title" content="Tom &amp; Jerry&#39;s &quot;Show&quot;">`;
    expect(parseOpenGraph(html).title).toBe('Tom & Jerry\'s "Show"');
  });

  it('Pinterest/IG-style page (og:image) needs ZERO per-site code', () => {
    const pin = `<meta property="og:image" content="https://i.pinimg.com/originals/ab/cd.jpg"><title>Pin</title>`;
    expect(parseOpenGraph(pin).image).toBe('https://i.pinimg.com/originals/ab/cd.jpg');
  });

  it('empty / imageless HTML → empty-ish preview (fail-open, never fabricates, never throws)', () => {
    expect(parseOpenGraph('')).toEqual({});
    expect(parseOpenGraph('<html><body>no meta here</body></html>')).toEqual({});
    // A page with only a title yields just the title (no fake image).
    expect(parseOpenGraph('<title>Just A Title</title>')).toEqual({ title: 'Just A Title' });
  });

  it('picks the FIRST og:image when a page lists several', () => {
    const html = `
      <meta property="og:image" content="https://x/1.png">
      <meta property="og:image" content="https://x/2.png">`;
    expect(parseOpenGraph(html).image).toBe('https://x/1.png');
  });

  it('EMERGENT: pulls og:video (playable embed) + og:site_name (Sam\'s "…or a video")', () => {
    const html = `<html><head>
      <meta property="og:title" content="Serve slow-mo">
      <meta property="og:image" content="https://x/poster.jpg">
      <meta property="og:video:secure_url" content="https://x/clip.mp4">
      <meta property="og:site_name" content="Lakeside Pottery School">
    </head></html>`;
    const p = parseOpenGraph(html);
    expect(p.video).toBe('https://x/clip.mp4');
    expect(p.siteName).toBe('Lakeside Pottery School');
    expect(p.image).toBe('https://x/poster.jpg'); // poster still present alongside the video
  });

  it('og:video fallback order (secure_url → url → og:video → twitter:player) + absolutized', () => {
    expect(parseOpenGraph(`<meta property="og:video" content="/v/clip.mp4">`, 'https://s.com/p').video)
      .toBe('https://s.com/v/clip.mp4');
    expect(parseOpenGraph(`<meta name="twitter:player" content="https://s.com/embed">`).video)
      .toBe('https://s.com/embed');
    // secure_url wins over plain og:video.
    const both = `<meta property="og:video" content="http://x/a.mp4"><meta property="og:video:secure_url" content="https://x/b.mp4">`;
    expect(parseOpenGraph(both).video).toBe('https://x/b.mp4');
  });

  it('EMERGENT: JSON-LD VideoObject video fallback (Instagram Reels / Pinterest video pins)', () => {
    const obj = `<script type="application/ld+json">{"@type":"VideoObject","contentUrl":"https://cdn/reel.mp4","embedUrl":"https://cdn/e"}</script>`;
    expect(parseOpenGraph(obj).video).toBe('https://cdn/reel.mp4'); // contentUrl beats embedUrl
    // a `video` property carrying a VideoObject, and the bare-string + embedUrl-only forms
    const prop = `<script type="application/ld+json">{"video":{"@type":"VideoObject","embedUrl":"https://cdn/embed-only"}}</script>`;
    expect(parseOpenGraph(prop).video).toBe('https://cdn/embed-only');
    const str = `<script type="application/ld+json">{"video":"https://cdn/plain.mp4"}</script>`;
    expect(parseOpenGraph(str).video).toBe('https://cdn/plain.mp4');
  });

  it('video fallback ORDER: og:video wins over JSON-LD video', () => {
    const both = `
      <meta property="og:video:secure_url" content="https://x/og.mp4">
      <script type="application/ld+json">{"video":"https://x/ld.mp4"}</script>`;
    expect(parseOpenGraph(both).video).toBe('https://x/og.mp4');
  });

  it('TYPE-SAFE: a VideoObject video is not confused with an earlier ImageObject contentUrl (YouTube form)', () => {
    // Top-level VideoObject (no `video` wrapper). An ImageObject with its OWN contentUrl appears
    // FIRST — a naive contentUrl search would wrongly grab the image; the @type lookup does not.
    const yt = `<script type="application/ld+json">{"@graph":[
      {"@type":"ImageObject","contentUrl":"https://x/thumb.jpg"},
      {"@type":"VideoObject","contentUrl":"https://x/watch.mp4","embedUrl":"https://x/embed"}
    ]}</script>`;
    expect(parseOpenGraph(yt).video).toBe('https://x/watch.mp4'); // the VIDEO node's url, not the image's
    // jsonLdNodeByType returns the whole node, type-matched across @graph
    const node = jsonLdNodeByType(yt, 'VideoObject') as Record<string, unknown>;
    expect(node?.contentUrl).toBe('https://x/watch.mp4');
    expect(jsonLdNodeByType(yt, 'AudioObject')).toBeUndefined();
  });

  it('no video/siteName → those keys are simply absent (fail-open)', () => {
    const p = parseOpenGraph(`<meta property="og:image" content="https://x/i.png">`);
    expect(p.video).toBeUndefined();
    expect(p.siteName).toBeUndefined();
    expect(p.image).toBe('https://x/i.png');
  });
});

describe('open-graph leaf helpers', () => {
  it('metaContent is case-insensitive on tag/key and quote-agnostic', () => {
    expect(metaContent(`<META PROPERTY='og:image' CONTENT='https://x/a.png'>`, 'og:image')).toBe('https://x/a.png');
  });
  it('titleTag collapses whitespace and decodes', () => {
    expect(titleTag(`<title>  Hello\n  World &amp; Co  </title>`)).toBe('Hello World & Co');
  });
  it('faviconHref matches shortcut/apple-touch icons too (a config of linkRelHref)', () => {
    expect(faviconHref(`<link rel="shortcut icon" href="/a.ico">`)).toBe('/a.ico');
    expect(faviconHref(`<link rel="apple-touch-icon" href="https://x/b.png">`)).toBe('https://x/b.png');
  });
  it('linkRelHref is the generic <link> reader: any rel keyword, first match, absolutized', () => {
    const html = `<link rel="image_src" href="/pin.jpg"><link rel="canonical" href="https://x/c">`;
    expect(linkRelHref(html, 'image_src', 'https://x/p')).toBe('https://x/pin.jpg');
    expect(linkRelHref(html, 'canonical')).toBe('https://x/c');
    expect(linkRelHref(html, 'nope')).toBeUndefined();
  });
  it('itempropUrl reads content|href|src off the itemprop-carrying tag, order-agnostic', () => {
    expect(itempropUrl(`<meta itemprop="image" content="https://x/a.jpg">`, 'image')).toBe('https://x/a.jpg');
    expect(itempropUrl(`<link href="https://x/b.jpg" itemprop="image">`, 'image')).toBe('https://x/b.jpg');
    expect(itempropUrl(`<div>no microdata</div>`, 'image')).toBeUndefined();
  });
  it('jsonLdField finds a field across blocks/arrays/@graph; malformed skipped; generic on field', () => {
    expect(jsonLdField(`<script type="application/ld+json">{"name":"Pie","image":"x.jpg"}</script>`, 'name')).toBe('Pie');
    expect(jsonLdField(`<script type="application/ld+json">{"@graph":[{"headline":"H"}]}</script>`, 'headline')).toBe('H');
    expect(jsonLdField(`<script type="application/ld+json">{bad}</script>`, 'image')).toBeUndefined();
    expect(jsonLdField(`<div>no ld</div>`, 'image')).toBeUndefined();
  });
  it('jsonLdUrl normalizes string | {url} | array-of-either to the first URL', () => {
    expect(jsonLdUrl('https://x/a.jpg')).toBe('https://x/a.jpg');
    expect(jsonLdUrl({ '@type': 'ImageObject', url: 'https://x/o.jpg' })).toBe('https://x/o.jpg');
    expect(jsonLdUrl(['https://x/1.jpg', 'https://x/2.jpg'])).toBe('https://x/1.jpg');
    expect(jsonLdUrl([{ url: 'https://x/obj.jpg' }])).toBe('https://x/obj.jpg');
    expect(jsonLdUrl(42)).toBeUndefined();
  });
  it('jsonLdText takes a string or the first string of an array, trimmed', () => {
    expect(jsonLdText('  hi ')).toBe('hi');
    expect(jsonLdText(['first', 'second'])).toBe('first');
    expect(jsonLdText([{ x: 1 }, 'realstring'])).toBe('realstring');
    expect(jsonLdText(99)).toBeUndefined();
  });
  it('jsonLdVideoUrl prefers contentUrl > embedUrl > url on a VideoObject; string + array too', () => {
    expect(jsonLdVideoUrl('https://x/a.mp4')).toBe('https://x/a.mp4');
    expect(jsonLdVideoUrl({ contentUrl: 'https://x/c.mp4', embedUrl: 'https://x/e', url: 'https://x/u' })).toBe('https://x/c.mp4');
    expect(jsonLdVideoUrl({ embedUrl: 'https://x/e' })).toBe('https://x/e');
    expect(jsonLdVideoUrl({ url: 'https://x/u' })).toBe('https://x/u');
    expect(jsonLdVideoUrl([{ embedUrl: 'https://x/first' }, 'https://x/second'])).toBe('https://x/first');
    expect(jsonLdVideoUrl({})).toBeUndefined();
  });
  it('absolutize leaves absolute + data URLs alone, resolves relative', () => {
    expect(absolutize('https://x/a.png', 'https://y')).toBe('https://x/a.png');
    expect(absolutize('data:image/png;base64,AA', 'https://y')).toBe('data:image/png;base64,AA');
    expect(absolutize('/a.png', 'https://y.com/deep/path')).toBe('https://y.com/a.png');
    expect(absolutize('/a.png')).toBe('/a.png'); // no base → unchanged, never throws
  });
  it('decodeHtmlEntities handles numeric + named without over-decoding &amp;lt;', () => {
    expect(decodeHtmlEntities('a &amp;lt; b')).toBe('a &lt; b');
    expect(decodeHtmlEntities('&#39;&#x2764;&#39;')).toBe("'❤'");
  });
});

describe('open-graph red-team — hostile HTML hardening (cont.98 batch-27)', () => {
  // #1 — safeAssetUrl (via parseOpenGraph): an active-content scheme in an extracted asset URL is dropped
  // at the parse boundary, so it can never reach a future href/innerHTML sink.
  it('drops javascript:/vbscript:/data:text/html image + video URLs, keeps http(s)/data:image', () => {
    const hostile = parseOpenGraph(
      '<meta property="og:image" content="javascript:alert(1)">' +
      '<meta property="og:video" content="vbscript:msgbox(1)">',
    );
    expect(hostile.image).toBeUndefined();
    expect(hostile.video).toBeUndefined();

    const dataHtml = parseOpenGraph('<meta property="og:image" content="data:text/html,<script>alert(1)</script>">');
    expect(dataHtml.image).toBeUndefined();

    const safe = parseOpenGraph(
      '<meta property="og:image" content="https://cdn.example.com/a.png">' +
      '<meta property="og:image:alt" content="x">' +
      '<meta property="og:video" content="data:image/gif;base64,AA">',
    );
    expect(safe.image).toBe('https://cdn.example.com/a.png');
    expect(safe.video).toBe('data:image/gif;base64,AA');
  });

  // #2 — pathologically deep JSON-LD must NOT stack-overflow the recursive walk (depth cap fails open).
  // The fixture is built ITERATIVELY (wrapping outward from the leaf) — a recursive builder would itself
  // overflow the stack at CONSTRUCTION before the code under test runs (cont.98 batch-22 lesson).
  it('does not overflow on JSON-LD nested far past the depth cap (fails open, returns undefined)', () => {
    // Build the JSON STRING iteratively (wrapping outward) — JSON.stringify on a 5000-deep object would
    // itself overflow the stack at construction, masking whether the code under test is safe.
    let json = '{"image":"https://deep.example/x.png"}';
    for (let i = 0; i < 5000; i++) json = `{"child":${json}}`;
    const html = `<script type="application/ld+json">${json}</script>`;
    expect(() => jsonLdField(html, 'image')).not.toThrow();
    expect(jsonLdField(html, 'image')).toBeUndefined(); // buried below MAX_JSONLD_DEPTH → not reached, no crash
  });

  it('still finds a JSON-LD field within the depth cap', () => {
    let json = '{"image":"https://shallow.example/y.png"}';
    for (let i = 0; i < 5; i++) json = `{"child":${json}}`;
    const html = `<script type="application/ld+json">${json}</script>`;
    expect(jsonLdField(html, 'image')).toBe('https://shallow.example/y.png');
  });

  // #3 — a multi-megabyte attacker HTML is capped before the ~30 full-document scans (DoS guard); real
  // <head> metadata is never dropped because it sits well before the cap.
  it('caps giant HTML without dropping real head metadata and without hanging', () => {
    const head = '<meta property="og:title" content="Real Title">';
    const giant = head + 'x'.repeat(8_000_000);
    const preview = parseOpenGraph(giant);
    expect(preview.title).toBe('Real Title');
  });

  it('empty / falsy HTML yields an empty preview (never throws)', () => {
    expect(parseOpenGraph('')).toEqual({});
  });
});
