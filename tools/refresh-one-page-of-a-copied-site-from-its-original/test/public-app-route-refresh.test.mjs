import test from 'node:test';
import assert from 'node:assert/strict';
import { readPublicAppSourceRoute, publicAppRouteRefreshAssetPrefix } from '../src/public-app-route-refresh.mjs';

function sourceFetcher(rows) {
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push({ url, options });
    const row = rows[new URL(url).pathname];
    return row ? new Response(row.body, { status: row.status ?? 200, headers: {
      'content-type': row.type, ...(row.headers ?? {}),
    } }) : new Response('missing', { status: 404, headers: { 'content-type': 'text/plain' } });
  };
  return { fetcher, calls };
}

test('copies a route and rewrites its same-site HTML, CSS, JS and binary dependency closure under the route folder', async () => {
  const { fetcher, calls } = sourceFetcher({
    '/site/features/': { type: 'text/html', body: '<html><head><link rel="stylesheet" href="../css/page.css"></head><body><img src="/site/images/card.png"><script src="./page.js"></script></body></html>' },
    '/site/css/page.css': { type: 'text/css', body: '@import "./base.css"; @import url("./base.css"); .hero{background:url(../images/card.png)}' },
    '/site/css/base.css': { type: 'text/css', body: 'body{color:#123}' },
    '/site/images/card.png': { type: 'image/png', body: new Uint8Array([137, 80, 78, 71]) },
    '/site/features/page.js': { type: 'text/javascript', body: 'import "./chunk.mjs"; const icon="../images/card.png";' },
    '/site/features/chunk.mjs': { type: 'text/javascript', body: 'export const ready=true;' },
  });
  const result = await readPublicAppSourceRoute({ baseUrl: 'https://example.com/site/', sourceRoute: '/features/', targetRoute: 'features/index.html', scope: 'features-refresh', fetcher });
  assert.equal(result.target_path, 'features/index.html');
  assert.equal(result.file_count, 6);
  assert.match(result.files['features/index.html'], /href="\/features\/route-refresh-[a-f0-9]{16}\/external\/css\/page\.css"/);
  assert.match(result.files['features/index.html'], /src="\/features\/route-refresh-[a-f0-9]{16}\/external\/images\/card\.png"/);
  const cssPath = `${result.asset_prefix}/external/css/page.css`;
  assert.ok(result.files[cssPath].includes(`@import "/${result.asset_prefix}/external/css/base.css";`));
  assert.ok(result.files[cssPath].includes(`@import url("/${result.asset_prefix}/external/css/base.css");`));
  assert.deepEqual([...result.files[`${result.asset_prefix}/external/images/card.png`]], [137, 80, 78, 71]);
  assert.equal(calls.length, result.file_count);
  assert.ok(calls.every(call => call.options.redirect === 'manual'));
});

test('rejects off-site executable dependencies and off-site redirects', async () => {
  const external = sourceFetcher({ '/features/': { type: 'text/html', body: '<script src="https://cdn.example.net/app.js"></script>' } });
  await assert.rejects(readPublicAppSourceRoute({ baseUrl: 'https://example.com/', sourceRoute: '/features/', targetRoute: 'features/index.html', scope: 'features', fetcher: external.fetcher }), /external script or stylesheet/);
  const redirect = async () => new Response(null, { status: 302, headers: { location: 'https://other.example.net/features/' } });
  await assert.rejects(readPublicAppSourceRoute({ baseUrl: 'https://example.com/', sourceRoute: '/features/', targetRoute: 'features/index.html', scope: 'features', fetcher: redirect }), /redirects outside/);
  const externalImport = sourceFetcher({
    '/features/': { type: 'text/html', body: '<link rel="stylesheet" href="./page.css">' },
    '/features/page.css': { type: 'text/css', body: '@import "https://cdn.example.net/theme.css";' },
  });
  await assert.rejects(readPublicAppSourceRoute({ baseUrl: 'https://example.com/', sourceRoute: '/features/', targetRoute: 'features/index.html', scope: 'features', fetcher: externalImport.fetcher }), /static same-site asset/);
  const externalImage = sourceFetcher({ '/features/': { type: 'text/html', body: '<img src="https://cdn.example.net/card.png">' } });
  await assert.rejects(readPublicAppSourceRoute({ baseUrl: 'https://example.com/', sourceRoute: '/features/', targetRoute: 'features/index.html', scope: 'features', fetcher: externalImage.fetcher }), /static same-site asset/);
});

test('keeps a stable asset namespace for one route and scopes nested routes locally', () => {
  assert.equal(publicAppRouteRefreshAssetPrefix('features/index.html', 'features'), publicAppRouteRefreshAssetPrefix('features/index.html', 'features'));
  assert.match(publicAppRouteRefreshAssetPrefix('features/index.html', 'features'), /^features\/route-refresh-[a-f0-9]{16}$/);
  assert.match(publicAppRouteRefreshAssetPrefix('features/news/index.html', 'news'), /^features\/news\/route-refresh-[a-f0-9]{16}$/);
  assert.throws(() => publicAppRouteRefreshAssetPrefix('../index.html', 'features'), /invalid/i);
});
