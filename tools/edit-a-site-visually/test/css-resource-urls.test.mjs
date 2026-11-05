import test from 'node:test';
import assert from 'node:assert/strict';
import { mapCssResourceUrls } from '../parts/ui/read-data/css-resource-urls.mjs';

test('rewrites resource tokens while leaving comments and ordinary strings untouched', () => {
  const css = `/* url(/comment.png) @import "/comment.css" */
    .label::before { content: "url(/text.png)"; background: url("/real.png"); }
    @import /* note */ "/real.css";`;
  const mapped = mapCssResourceUrls(css, value => value.startsWith('/') ? `/site${value}` : value);
  assert.equal(mapped, `/* url(/comment.png) @import "/comment.css" */
    .label::before { content: "url(/text.png)"; background: url("/site/real.png"); }
    @import /* note */ "/site/real.css";`);
});

test('decodes CSS escapes before rewriting and quotes changed URLs safely', () => {
  const css = 'a{background:url(\\2f images\\2f hero\\20 art.png);mask:url("/icons/close.svg")}';
  const mapped = mapCssResourceUrls(css, value => value.startsWith('/') ? `/site${value}` : value);
  assert.equal(mapped, 'a{background:url("/site/images/hero art.png");mask:url("/site/icons/close.svg")}');
});

test('changed simple URLs preserve their quoting and malformed URLs stay unchanged', () => {
  const css = `a{background:url(../hero.png);mask:url('../mask.png');cursor:url(bad path.png)}`;
  assert.equal(mapCssResourceUrls(css, value => `/site/${value.replace('../', '')}`),
    `a{background:url(/site/hero.png);mask:url('/site/mask.png');cursor:url(bad path.png)}`);
});

test('preserves original bytes when the rewrite keeps the same logical URL', () => {
  const css = '/* keep */a{background:url(\\2f images\\2f hero.png);content:"url(/fake.png)"}@import \'\\2f theme.css\';';
  assert.equal(mapCssResourceUrls(css, value => value), css);
  assert.equal(mapCssResourceUrls(css, value => value.startsWith('/') ? value : `/${value}`), css);
});
