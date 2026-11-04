import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { build } from 'esbuild';
import { launchChromium } from '../../headless-browser/launch.mjs';
import screens from '../../shared-code/src/workspace/screens.mjs';

const HARNESS = `import { mountPublicAppsScreen } from './src/workspace/public-apps-screen'; mountPublicAppsScreen(document.getElementById('root'));`;
const WORKSPACE_FONTS = new Set([
  'SF-Pro-Text-Regular.woff2', 'SF-Pro-Text-Medium.woff2', 'SF-Pro-Text-Semibold.woff2',
  'Recoleta-Regular.woff2', 'Recoleta-Medium.woff2', 'Recoleta-SemiBold.woff2',
  'Trillion-Regular.woff2', 'Trillion-Medium.woff2', 'Trillion-SemiBold.woff2',
]);

test('an indexed-file save received while Rename is busy is applied after Rename completes', { timeout: 180_000 }, async t => {
  const bundled = await build({
    absWorkingDir: process.cwd(), stdin: { contents: HARNESS, resolveDir: process.cwd(), sourcefile: 'indexed-collaboration-harness.tsx', loader: 'tsx' },
    bundle: true, write: false, outdir: 'indexed-collaboration-harness', format: 'iife', platform: 'browser', target: 'es2022', jsx: 'automatic', logLevel: 'silent', loader: { '.css': 'empty', '.wasm': 'empty' },
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  const script = bundled.outputFiles.find(file => file.path.endsWith('.js')).text;
  const styles = bundled.outputFiles.filter(file => file.path.endsWith('.css')).map(file => file.text).join('\n');
  const installationId = 'b'.repeat(32);
  const initialHtml = '<!doctype html><html><body><main><h1>Before peer save</h1></main></body></html>';
  const updatedHtml = '<!doctype html><html><body><main><h1>After peer save</h1><p>Arrived while Rename was busy</p></main></body></html>';
  let releaseRename;
  let renameStarted;
  const renameStartedPromise = new Promise(resolve => { renameStarted = resolve; });
  const renameHold = new Promise(resolve => { releaseRename = resolve; });
  let fileReads = 0;
  let secondFileReadResolve;
  const secondFileRead = new Promise(resolve => { secondFileReadResolve = resolve; });
  const browser = await launchChromium({ admission: { timeoutMs: 60_000, priority: 80, signal: t.signal } });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = [];
    const failedResponses = [];
    const unhandledRequests = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    page.on('response', response => {
      if (response.status() >= 400) failedResponses.push({ method: response.request().method(), url: response.url(), status: response.status() });
    });
    await page.addInitScript(() => {
      window.WebSocket = class {
        static CONNECTING = 0;
        static OPEN = 1;
        static CLOSING = 2;
        static CLOSED = 3;
        constructor(url) {
          this.url = String(url);
          this.readyState = window.WebSocket.OPEN;
          window.__presenceSocket = this;
          queueMicrotask(() => this.onopen?.());
        }
        send(message) { (window.__presenceSent ??= []).push(message); }
        close() { this.readyState = window.WebSocket.CLOSED; this.onclose?.(); }
      };
    });
    await page.route('https://app.gettrillion.ai/**', async route => {
      const request = route.request();
      const address = new URL(request.url());
      const path = address.pathname;
      const method = request.method();
      const respond = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
      if (path === '/sites' && method === 'GET') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body><main id="root"></main></body></html>' });
      if (path === '/work/api/records' && method === 'GET' && address.searchParams.get('label') === screens.address_label) {
        return respond({ records: { [screens.address_label]: screens.surfaces } });
      }
      if (path === '/workspace/fonts.css' && method === 'GET') return route.fulfill({ contentType: 'text/css', body: readFileSync('parts/screen-look/show/fonts.css') });
      const font = /^\/(?:workspace\/)?fonts\/([A-Za-z0-9-]+\.woff2)$/.exec(path);
      if (font && WORKSPACE_FONTS.has(font[1]) && method === 'GET') return route.fulfill({ contentType: 'font/woff2', body: readFileSync(`parts/screen-look/show/fonts/${font[1]}`) });
      if (path === '/favicon.ico' && method === 'GET') return route.fulfill({ contentType: 'image/x-icon', body: readFileSync('assets/favicon.ico') });
      if (path === '/favicon.svg' && method === 'GET') return route.fulfill({ contentType: 'image/svg+xml', body: readFileSync('assets/favicon.svg') });
      if (path === '/apple-touch-icon.png' && method === 'GET') return route.fulfill({ contentType: 'image/png', body: readFileSync('assets/apple-touch-icon.png') });
      if (path === '/trillion.webmanifest' && method === 'GET') return respond({ id: '/', name: 'Trillion', short_name: 'Trillion', start_url: '/', scope: '/', display: 'standalone', icons: [] });
      if (path === '/work/api/public-app/installations' && method === 'GET') {
        return respond({ installations: [{ installation_id: installationId, app_id: 'indexed-collab-proof', name: 'indexed-proof', public_url: 'https://indexed-proof.trillion.run/', status: 'active', can_manage_domains: true, custom_domains: [], domains_loaded: true }] });
      }
      if (path === '/work/api/spaces') return respond({ spaces: [] });
      if (path === '/work/api/workshop') return respond({ tools: [] });
      if (path === '/work/api/marketplace/configurations' || path === '/work/api/public-app/placeable' || path === '/work/api/media/library' || path === '/work/api/shared-library') return respond({ rows: [] });
      if (path === '/work/api/workflows') return respond({ workflows: [] });
      if (path === '/work/api/source-projects') return respond({ projects: [] });
      if (path === '/work/api/source-projects/site-link' && method === 'GET' && address.searchParams.get('installation_id') === installationId) {
        return respond({ installation_id: installationId, source_project_id: null });
      }
      if (path === `/work/api/public-app/installations/${installationId}`) {
        return respond({ id: 'indexed-collab-proof', actions: [], files: {}, file_index: { file_count: 1 }, revision: 'live-revision', public_url: 'https://indexed-proof.trillion.run/' });
      }
      if (path === `/work/api/public-app/installations/${installationId}/domains`) return respond({ custom_domains: [] });
      if (path === `/work/api/public-app/installations/${installationId}/project/assembly`) return respond({
        name: 'Indexed proof', sources: [], pages: [], targets: {}, editor_files: {}, source_files: {},
        revision: 'assembly-proof', source_files_revision: 'files-proof',
      });
      if (path === `/work/api/public-app/installations/${installationId}/native-build`) return respond({ available: false });
      if (path === `/work/api/public-app/installations/${installationId}/files`) return respond({ rows: [{ path: 'index.html', blob_ref: 'home-ref', media_type: 'text/html', size: initialHtml.length }], cursor: null });
      if (path === `/work/api/public-app/installations/${installationId}/file` && method === 'GET') {
        fileReads++;
        const readNumber = fileReads;
        await respond({ path: 'index.html', content: readNumber === 1 ? initialHtml : updatedHtml, revision: 'live-revision', draft_revision: readNumber === 1 ? null : 'peer-draft-revision' });
        if (readNumber === 2) secondFileReadResolve();
        return;
      }
      if (path === `/work/api/public-app/installations/${installationId}/versions`) return respond({ current_revision: 'live-revision', versions: [] });
      if (path === `/work/api/public-app/installations/${installationId}/analytics`) return respond({ page_views: 0, unique_visitors: 0, submissions: 0, days: [] });
      if (path === `/work/api/public-app/installations/${installationId}/name` && method === 'PUT') {
        renameStarted();
        await renameHold;
        return respond({ name: 'renamed-proof', public_url: 'https://renamed-proof.trillion.run/' });
      }
      unhandledRequests.push({ method, url: request.url() });
      return respond({ error: `Unhandled ${method} ${path}` }, 404);
    });

    await page.goto('https://app.gettrillion.ai/sites');
    if (styles) await page.addStyleTag({ content: styles });
    await page.addScriptTag({ content: script });
    await page.getByLabel('Visual app editor', { exact: true }).waitFor({ timeout: 45_000 });
    await page.waitForFunction(() => document.querySelector('iframe.gjs-frame')?.contentDocument?.querySelector('h1')?.textContent === 'Before peer save');
    await page.waitForFunction(() => window.__presenceSocket?.url?.includes('/work/live/board/public-app%3A'));
    const initialTimeOrigin = await page.evaluate(() => performance.timeOrigin);
    const settings = page.getByRole('radiogroup', { name: 'Site views', exact: true });
    await settings.getByRole('radio', { name: 'Settings', exact: true }).click();
    const siteName = page.getByLabel('Site name', { exact: true });
    await siteName.fill('renamed-proof');
    await page.getByRole('button', { name: 'Rename', exact: true }).click();
    await renameStartedPromise;
    assert.equal(await page.getByRole('button', { name: 'Rename', exact: true }).isDisabled(), true, 'Rename holds the screen busy');

    // The current page's real same-origin WebSocket handler receives a peer save while the rename request is pending.
    await page.evaluate(() => window.__presenceSocket.onmessage({ data: JSON.stringify({
      id: 'peer-tab', name: 'Peer', ts: Date.now(), doing: 'Saved', target: { text: 'index.html' },
    }) }));
    assert.equal(fileReads, 1, 'the file reread waits while Rename owns the screen');
    releaseRename();

    // The one queued notification must resume after the held request finishes, while the owner remains in Settings.
    await page.getByText('This site is now at https://renamed-proof.trillion.run/. The old address sends visitors there.', { exact: true }).waitFor();
    await secondFileRead;
    assert.equal(fileReads, 2, 'the queued peer notification caused one indexed-file reread');
    await settings.getByRole('radio', { name: 'Design', exact: true }).click();
    await page.getByLabel('Visual app editor', { exact: true }).waitFor({ timeout: 45_000 });
    await page.waitForFunction(() => document.querySelector('iframe.gjs-frame')?.contentDocument?.querySelector('h1')?.textContent === 'After peer save', null, { timeout: 45_000 });
    assert.equal(await page.evaluate(() => performance.timeOrigin), initialTimeOrigin, 'the browser page was not reloaded');
    assert.match(await page.locator('iframe.gjs-frame').first().evaluate(frame => frame.contentDocument.body.innerText), /Arrived while Rename was busy/);
    assert.equal(await page.evaluate(() => window.__presenceSocket.url), 'wss://app.gettrillion.ai/work/live/board/public-app%3A' + installationId, 'the app subscribed to its installation room on the real page origin');
    assert.deepEqual(unhandledRequests, [], `every requested HTTP resource needs a deliberate fixture: ${JSON.stringify(unhandledRequests)}`);
    assert.deepEqual(failedResponses, [], `HTTP errors: ${JSON.stringify(failedResponses)}`);
    assert.deepEqual(errors, [], `console errors: ${JSON.stringify(errors)}; failed responses: ${JSON.stringify(failedResponses)}; unhandled requests: ${JSON.stringify(unhandledRequests)}`);
  } finally {
    releaseRename?.();
    await browser.close();
  }
});
