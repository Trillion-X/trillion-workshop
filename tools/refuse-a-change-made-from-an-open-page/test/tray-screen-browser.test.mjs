// Your tray in a real browser (src/workspace/tray-screen.tsx): where it can go loads through the shared screen states,
// an empty tray is the shared empty state with Pick things, each picked thing is a shared listing row saying when it
// was picked, with its own Take out, many things stay one row each, and Send hands the picked things and the note to
// the place chosen in Send to, with the saved action chosen in Your AI will (each folder its own menu), then empties
// the tray; a refused send keeps everything and says why; a tool chosen in Send to takes no action.
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { launchChromium } from '../../headless-browser/launch.mjs';
import firstAnswers from '../../keep-and-wake-ai-sessions-on-this-computer/src/workspace/first-answers.json' with { type: 'json' };
import { keptAnswerSettings } from '../src/kept-answers.mjs';

const root = new URL('..', import.meta.url).pathname;

const { outputFiles } = await build({
  absWorkingDir: root,
  stdin: {
    resolveDir: root, loader: 'tsx', contents: `
      import { mountTrayScreen } from './src/workspace/tray-screen';
      import { startTray, tray } from './src/workspace/tray';
      import { openSharing } from './src/workspace/sharing-sheet';
      import { mountRecordViews } from './parts/ui/show/record-views/record-views';
      import { setPlaceableSurfaceDragData } from './parts/ui/show/placeable-surface-intent/placeable-surface-intent';
      window.sent = [];
      window.refuse = false;
      window.down = false;
      window.queue = false;
      window.pausePublish = false;
      window.failAppend = false;
      const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
      window.fetch = async (url, init = {}) => {
        const path = String(url);
        if (path === '/work/api/sharing/collection/links' && init.method === 'POST') {
          const body = JSON.parse(init.body);
          window.sent.push({ path, body });
          window.shareCount = body.items.length;
          return reply(200, { share_id: 'bundle-test', code: 'new-collection', published: body.publish !== false, entry_count: window.shareCount });
        }
        if (path === '/work/api/sharing/collection/links/bundle-test/items' && init.method === 'POST') {
          const body = JSON.parse(init.body);
          window.sent.push({ path, body });
          if (window.failAppend) return reply(500, { error: 'The collection is busy.' });
          window.shareCount += body.items.length;
          return reply(200, { share_id: 'bundle-test', entry_count: window.shareCount, published: false });
        }
        if (path === '/work/api/sharing/collection/links/bundle-test/publish' && init.method === 'POST') {
          window.sent.push({ path, body: JSON.parse(init.body) });
          if (window.pausePublish) await new Promise(resolve => { window.releasePublish = resolve; });
          return reply(200, { share_id: 'bundle-test', entry_count: window.shareCount, published: true, address: 'https://tray.test/share/new-collection' });
        }
        if (path === '/work/api/sharing/collection/links/bundle-test/revoke' && init.method === 'POST') {
          window.sent.push({ path, body: JSON.parse(init.body) });
          return reply(200, { share_id: 'bundle-test', revoked_at: new Date().toISOString() });
        }
        if (path.startsWith('/work/api/share-destinations/deliver')) {
          window.sent.push({ path, body: JSON.parse(init.body) });
          const body = JSON.parse(init.body);
          if (window.down) return reply(503, { error: 'Trillion is busy' });
          if (window.queue) return reply(202, { queued: true, request_key: body.request_key, words: 'Kept.' });
          return window.refuse ? reply(400, { error: 'That place is not yours to send to.' }) : reply(200, { connected: body.to ? undefined : { pursuits: [{ id: 'pursuit:studio', title: 'Studio team' }] }, delivered: (body.to ?? []).map(id => (id === 'tool-place:tool:tell-trillions-makers' ? { id, label: 'Tell the people who make Trillion', said: 'The people who make Trillion have it.' } : { id, label: 'My Trillion' })), stopped_at: null });
        }
        if (path.startsWith('/work/api/share-destinations')) return reply(200, { destinations: [{ id: 'private', label: 'My Trillion', depth: 0, to: { private: true } }, { id: 'pursuit:studio', label: 'Studio team', depth: 0, others_count: 2, description: 'With Ana, Bo', to: { pursuit_id: 'pursuit:studio', space_id: 'space-1' } }, { id: 'pursuit:studio-launch', label: 'Launch', depth: 1, others_count: 0, to: { pursuit_id: 'pursuit:studio-launch' } }, { id: 'tool-place:tool:tell-trillions-makers', label: 'Tell the people who make Trillion', to: { tool_id: 'tool:tell-trillions-makers' } }], actions: [{ id: 'no-clue', label: 'No clue, you figure it out', words: 'Figure it out', folder: null }, { id: 'direction', label: 'Product direction', words: 'What this means for the product', folder: 'product' }], folders: [{ id: 'product', label: 'Product', folder: null }] });
        return reply(404, {});
      };
      window.tray = tray;
      window.openSharing = openSharing;
      window.mountMixedRecords = (element, withTab = true) => {
        startTray([{ id: 'records', label: 'Records', package_entry: { entry_name: 'records' } }]);
        return mountRecordViews(element, {
          label: 'Records',
          fields: [{ id: 'name', label: 'Name', read: row => row.name }],
          records: [
            { id: 'clip', name: 'Kitchen clip', share: 'file:clip' },
            { id: 'review', name: 'Review clips', share: 'workflow:review' },
            { id: 'idea', name: 'Campaign idea', share: 'decision:idea' },
          ],
          identify: row => row.id,
          shareRecord: row => row.share,
          views: [{ id: 'table', label: 'List' }], onlyTheseViews: true,
          ...(withTab ? { onDragOut: (ids, event) => setPlaceableSurfaceDragData(event.dataTransfer, { id: ids[0], title: ids[0] }, ids[0]) } : {}),
        });
      };
      const element = document.createElement('section'); element.id = 'screen'; element.style.height = '800px'; document.body.append(element);
      mountTrayScreen(element);
    ` },
  bundle: true, write: false, format: 'iife', platform: 'browser', target: 'es2022', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.url': 'document.baseURI' },
  loader: { '.css': 'empty', '.wasm': 'empty' }, external: ['node:*'], logLevel: 'error',
});

test('dragging a selected mixed set onto Your tray adds all references and preserves tab drag data', { timeout: 120000 }, async () => {
  const browser = await launchChromium();
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 850 } });
    await page.route('https://tray.test/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><body></body>' }));
    await page.goto('https://tray.test/');
    await page.addScriptTag({ content: outputFiles[0].text });
    await page.evaluate(() => {
      document.body.style.display = 'flex';
      document.body.style.gap = '24px';
      const source = document.createElement('section');
      source.id = 'records';
      source.setAttribute('data-trillion-screen', 'records');
      source.style.width = '560px';
      document.body.prepend(source);
      window.mountMixedRecords(source);
      document.getElementById('screen').style.width = '430px';
    });
    const row = id => page.locator(`[data-record-id="${id}"]`).first();
    await row('clip').click();
    await row('idea').click({ modifiers: ['Shift'] });
    assert.equal(await page.locator('#records [data-selected="true"]').count(), 3);
    const carried = await page.evaluate(() => {
      const dataTransfer = new DataTransfer();
      document.querySelector('[data-record-id="clip"]').dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer }));
      return { types: [...dataTransfer.types], records: JSON.parse(dataTransfer.getData('application/x-selected-records+json')).records };
    });
    assert.ok(carried.types.includes('application/x-placeable-surface+json'), 'existing tab drag remains');
    assert.ok(carried.types.includes('application/x-selected-records+json'), 'the whole shareable selection travels with it');
    assert.deepEqual(carried.records.map(item => item.record), ['file:clip', 'workflow:review', 'decision:idea']);
    await row('clip').dragTo(page.locator('[data-tray-screen]'), { targetPosition: { x: 180, y: 180 } });
    await page.getByText('3 picked').waitFor();
    assert.deepEqual(await page.evaluate(() => window.tray.read().things.map(thing => thing.share_record)), ['file:clip', 'workflow:review', 'decision:idea']);
    await row('clip').dragTo(page.locator('[data-tray-screen]'), { targetPosition: { x: 180, y: 180 } });
    assert.equal(await page.evaluate(() => window.tray.read().things.length), 3, 'dropping the same selection does not duplicate it');
    assert.equal(await page.locator('[data-tray-drop-active]').count(), 0, 'the visual drop cue clears');
    await page.locator('[data-tray-screen]').evaluate(element => {
      const dataTransfer = new DataTransfer();
      dataTransfer.setData('application/x-selected-records+json', JSON.stringify({ records: [
        { id: 'valid', record: 'list:valid', title: 'Valid row' }, { id: 'broken', title: 'Missing share reference' },
      ] }));
      element.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }));
    });
    assert.equal(await page.evaluate(() => window.tray.read().things.length), 3, 'a broken group adds none of its records');
    await page.getByRole('button', { name: 'More for your tray' }).click();
    await page.getByRole('menuitem', { name: 'Share with one link' }).click();
    await page.getByRole('button', { name: 'Make a share link' }).click();
    await page.waitForFunction(() => window.sent.some(one => one.path === '/work/api/sharing/collection/links'));
    const oneLink = (await page.evaluate(() => window.sent)).find(one => one.path === '/work/api/sharing/collection/links');
    assert.deepEqual(oneLink.body.items.map(item => item.record), ['file:clip', 'workflow:review', 'decision:idea']);
    await page.evaluate(() => {
      const source = document.createElement('section');
      source.id = 'no-tab';
      source.setAttribute('data-trillion-screen', 'records');
      source.style.width = '560px';
      document.body.prepend(source);
      window.mountMixedRecords(source, false);
    });
    await page.locator('#no-tab [data-record-id="review"]').waitFor();
    const withoutTab = await page.evaluate(() => {
      const source = document.getElementById('no-tab');
      const dataTransfer = new DataTransfer();
      source.querySelector('[data-record-id="review"]').dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer }));
      return [...dataTransfer.types];
    });
    assert.ok(withoutTab.includes('application/x-selected-records+json'), 'a shareable workflow row can drag without any tab callback');
    assert.ok(!withoutTab.includes('application/x-placeable-surface+json'));
    await page.keyboard.press('Escape');
    await page.locator('.sharing-collection-panel').waitFor({ state: 'hidden' });
    await page.locator('#no-tab [data-record-id="review"]').dragTo(page.locator('[data-tray-screen]'), { targetPosition: { x: 180, y: 180 } });
    assert.equal(await page.evaluate(() => window.tray.read().things.length), 3, 'a physical workflow drag also reaches the tray without duplicating it');
  } finally { await browser.close(); }
});

test('one tray action sends a prior share, file and workflow in one link while ordinary URLs remain links', { timeout: 120000 }, async () => {
  const browser = await launchChromium();
  try {
    const page = await browser.newPage({ viewport: { width: 900, height: 800 } });
    await page.route('https://tray.test/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><body></body>' }));
    await page.goto('https://tray.test/');
    await page.addScriptTag({ content: outputFiles[0].text });
    await page.locator('#screen [data-screen-state="empty"]').waitFor();
    await page.evaluate(() => window.tray.add([
      { key: 'prior', kind: 'Link', label: 'Earlier collection', share_url: 'https://tray.test/share/earlier' },
      { key: 'file', kind: 'File', label: 'Kitchen clip', share_record: 'file:clip' },
      { key: 'workflow', kind: 'Workflow', label: 'Review clips', share_record: 'workflow:review' },
      { key: 'outside', kind: 'Link', label: 'Reference', share_url: 'https://example.com/reference' },
      { key: 'download', kind: 'Link', label: 'Original download', share_url: 'https://tray.test/share/earlier/items/0/download' },
    ]));
    await page.locator('#screen').getByText('5 picked').waitFor();
    await page.getByRole('button', { name: 'More for your tray' }).click();
    await page.getByRole('menuitem', { name: 'Share with one link' }).click();
    await page.getByText('5 items in one link').waitFor();
    await page.getByRole('button', { name: 'Make a share link' }).click();
    await page.waitForFunction(() => window.sent.some(one => one.path === '/work/api/sharing/collection/links'));
    const requests = (await page.evaluate(() => window.sent)).filter(one => one.path === '/work/api/sharing/collection/links');
    assert.equal(requests.length, 1, 'one public link request covers the whole selection');
    assert.deepEqual(requests[0].body.items, [
      { kind: 'share', code: 'earlier', title: 'Earlier collection' },
      { kind: 'record', record: 'file:clip', title: 'Kitchen clip' },
      { kind: 'record', record: 'workflow:review', title: 'Review clips' },
      { kind: 'link', url: 'https://example.com/reference', title: 'Reference' },
      { kind: 'link', url: 'https://tray.test/share/earlier/items/0/download', title: 'Original download' },
    ]);
  } finally { await browser.close(); }
});

test('reviewing a mixed link loads file posters without requesting video bytes', { timeout: 120000 }, async () => {
  const browser = await launchChromium();
  try {
    const page = await browser.newPage({ viewport: { width: 900, height: 800 } });
    const mediaRequests = [];
    page.on('request', request => {
      const path = new URL(request.url()).pathname;
      if (path.startsWith('/share/new-collection/items/')) mediaRequests.push({ path, range: request.headers().range ?? null });
    });
    await page.route('https://tray.test/**', route => {
      const path = new URL(route.request().url()).pathname;
      if (/^\/share\/new-collection\/items\/\d+\/poster$/.test(path)) return route.fulfill({
        contentType: 'image/svg+xml',
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2" fill="#6f77cb"/></svg>',
      });
      if (/^\/share\/new-collection\/items\/\d+\/preview$/.test(path)) return route.fulfill({ status: 500, body: 'Unexpected video request' });
      return route.fulfill({ contentType: 'text/html', body: '<!doctype html><body></body>' });
    });
    await page.goto('https://tray.test/');
    await page.addScriptTag({ content: outputFiles[0].text });
    await page.locator('#screen [data-screen-state="empty"]').waitFor();
    await page.evaluate(() => window.tray.add([
      { key: 'file-a', kind: 'File', label: 'First clip', share_record: 'file:clip-a' },
      { key: 'file-b', kind: 'File', label: 'Second clip', share_record: 'file:clip-b' },
      { key: 'prior', kind: 'Link', label: 'Earlier collection', share_url: 'https://tray.test/share/earlier' },
      { key: 'file-after-nested', kind: 'File', label: 'Later clip', share_record: 'file:clip-c' },
      { key: 'workflow', kind: 'Workflow', label: 'Review clips', share_record: 'workflow:review' },
    ]));
    await page.getByRole('button', { name: 'More for your tray' }).click();
    await page.getByRole('menuitem', { name: 'Share with one link' }).click();
    const panel = page.locator('.sharing-collection-panel');
    await panel.getByRole('button', { name: 'Make a share link' }).click();
    await panel.getByRole('button', { name: 'Copy link' }).waitFor();
    await page.waitForFunction(() => {
      const images = [...document.querySelectorAll('.sharing-collection-panel [data-renderer="video-poster"] img')];
      return images.length === 2 && images.every(image => image.complete && image.naturalWidth > 0);
    });
    assert.equal(await panel.locator('video').count(), 0, 'the sender list must never mount a video player');
    assert.equal(await panel.locator('[data-renderer="type-icon"]').count(), 3, 'the nested share, later file and workflow stay in the link without guessing a flattened file index');
    assert.deepEqual(mediaRequests, [
      { path: '/share/new-collection/items/0/poster', range: null },
      { path: '/share/new-collection/items/1/poster', range: null },
    ], 'only addressable file posters load; no preview ranges or guessed nested indices start');
  } finally { await browser.close(); }
});

test('an oversized note keeps a mixed tray intact and makes no incomplete public link', { timeout: 120000 }, async () => {
  const browser = await launchChromium();
  try {
    const page = await browser.newPage({ viewport: { width: 900, height: 800 } });
    await page.route('https://tray.test/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><body></body>' }));
    await page.goto('https://tray.test/');
    await page.addScriptTag({ content: outputFiles[0].text });
    await page.locator('#screen [data-screen-state="empty"]').waitFor();
    await page.evaluate(() => window.tray.add([
      { key: 'file', kind: 'File', label: 'Kitchen clip', share_record: 'file:clip' },
      { key: 'note', kind: 'Words', label: 'Long note', share_text: 'a'.repeat(20001) },
    ]));
    await page.getByRole('button', { name: 'More for your tray' }).click();
    await page.getByRole('menuitem', { name: 'Share with one link' }).click();
    await page.getByRole('alert').getByText('Long note has more than 20,000 characters. Shorten the selected words before sharing.').waitFor();
    assert.equal(await page.locator('.sharing-collection-panel').count(), 0);
    assert.equal(await page.evaluate(() => window.tray.read().things.length), 2);
    assert.equal(await page.evaluate(() => window.sent.length), 0);
  } finally { await browser.close(); }
});

test('the generic sharing sheet refuses a late oversized note before creating any draft', { timeout: 120000 }, async () => {
  const browser = await launchChromium();
  try {
    const page = await browser.newPage({ viewport: { width: 900, height: 800 } });
    await page.route('https://tray.test/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><body></body>' }));
    await page.goto('https://tray.test/');
    await page.addScriptTag({ content: outputFiles[0].text });
    await page.evaluate(() => window.openSharing('selection', {
      title: '101 items',
      items: [
        ...Array.from({ length: 100 }, (_, index) => ({ record: `file:clip-${index}`, title: `Clip ${index}` })),
        { text: 'a'.repeat(20001), title: 'Long note' },
      ],
    }));
    const panel = page.locator('.sharing-collection-panel');
    await panel.getByText('101 items in one link').waitFor();
    await panel.getByRole('button', { name: 'Make a share link' }).click();
    await page.getByRole('alert').getByText('Long note has more than 20,000 characters. Shorten it before sharing.').waitFor();
    assert.equal(await page.evaluate(() => window.sent.length), 0, 'a late invalid text item must prevent the first draft request');
    assert.equal(await panel.getByText('101 items in one link').count(), 1, 'the full selection remains available for correction');
  } finally { await browser.close(); }
});

test('240 mixed tray picks become one link only after bounded ordered batches publish', { timeout: 120000 }, async () => {
  const browser = await launchChromium();
  try {
    const page = await browser.newPage({ viewport: { width: 900, height: 800 } });
    await page.route('https://tray.test/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><body></body>' }));
    await page.goto('https://tray.test/');
    await page.addScriptTag({ content: outputFiles[0].text });
    await page.locator('#screen [data-screen-state="empty"]').waitFor();
    const picked = [
      ...Array.from({ length: 237 }, (_, index) => ({ key: `file-${index}`, kind: 'File', label: `Clip ${index}`, share_record: `file:clip-${index}` })),
      { key: 'workflow', kind: 'Workflow', label: 'Review clips', share_record: 'workflow:review' },
      { key: 'prior', kind: 'Link', label: 'Earlier collection', share_url: 'https://tray.test/share/earlier' },
      { key: 'words', kind: 'Words', label: 'Instructions', share_text: 'Use the best scenes.' },
    ];
    await page.evaluate(items => { window.tray.add(items); window.pausePublish = true; }, picked);
    await page.locator('#screen').getByText('240 picked').waitFor();
    assert.equal(await page.locator('#screen [data-slot="listing-card"]').count(), 32, 'the tray mounts only its visible page');
    assert.match(await page.locator('#screen [data-tray-pages]').textContent(), /Showing 1–32 of 240/);
    await page.locator('#screen [data-tray-pages]').getByRole('button', { name: 'Next' }).click();
    assert.match(await page.locator('#screen [data-tray-pages]').textContent(), /Showing 33–64 of 240/);
    await page.getByRole('button', { name: 'More for your tray' }).click();
    await page.getByRole('menuitem', { name: 'Share with one link' }).click();
    const panel = page.locator('.sharing-collection-panel');
    await panel.getByText('240 items in one link').waitFor();
    assert.equal(await panel.locator('.sharing-collection-item').count(), 32, 'the sharing sheet also mounts one visible page');
    await panel.getByRole('button', { name: 'Make a share link' }).click();
    await page.waitForFunction(() => window.sent.some(one => one.path.endsWith('/publish')));
    assert.equal(await panel.getByRole('button', { name: 'Copy link' }).count(), 0, 'the draft address stays hidden until publication answers');
    const requests = await page.evaluate(() => window.sent.filter(one => one.path.startsWith('/work/api/sharing/collection/links')));
    assert.deepEqual(requests.map(one => one.path), [
      '/work/api/sharing/collection/links',
      '/work/api/sharing/collection/links/bundle-test/items',
      '/work/api/sharing/collection/links/bundle-test/items',
      '/work/api/sharing/collection/links/bundle-test/publish',
    ]);
    assert.deepEqual(requests.slice(0, 3).map(one => one.body.items.length), [100, 100, 40]);
    assert.equal(requests[0].body.publish, false);
    assert.equal(requests[0].body.expected_total, 240);
    assert.deepEqual(requests.slice(1, 3).map(one => one.body.expected_count), [100, 200]);
    const sentItems = requests.slice(0, 3).flatMap(one => one.body.items);
    assert.deepEqual(sentItems.slice(0, 2), [
      { kind: 'record', record: 'file:clip-0', title: 'Clip 0' },
      { kind: 'record', record: 'file:clip-1', title: 'Clip 1' },
    ]);
    assert.deepEqual(sentItems.slice(-3), [
      { kind: 'record', record: 'workflow:review', title: 'Review clips' },
      { kind: 'share', code: 'earlier', title: 'Earlier collection' },
      { kind: 'text', text: 'Use the best scenes.', title: 'Instructions' },
    ]);
    await page.evaluate(() => window.releasePublish());
    await panel.getByRole('button', { name: 'Copy link' }).waitFor();
    assert.equal(await panel.locator('.sharing-collection-item').count(), 32);
  } finally { await browser.close(); }
});

test('a failed later batch revokes the closed draft and never exposes a link', { timeout: 120000 }, async () => {
  const browser = await launchChromium();
  try {
    const page = await browser.newPage({ viewport: { width: 900, height: 800 } });
    await page.route('https://tray.test/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><body></body>' }));
    await page.goto('https://tray.test/');
    await page.addScriptTag({ content: outputFiles[0].text });
    await page.locator('#screen [data-screen-state="empty"]').waitFor();
    await page.evaluate(() => {
      window.tray.add(Array.from({ length: 101 }, (_, index) => ({ key: `file-${index}`, kind: 'File', label: `Clip ${index}`, share_record: `file:clip-${index}` })));
      window.failAppend = true;
    });
    await page.getByRole('button', { name: 'More for your tray' }).click();
    await page.getByRole('menuitem', { name: 'Share with one link' }).click();
    const panel = page.locator('.sharing-collection-panel');
    await panel.getByRole('button', { name: 'Make a share link' }).click();
    await page.waitForFunction(() => window.sent.some(one => one.path.endsWith('/revoke')));
    assert.equal(await panel.getByRole('button', { name: 'Copy link' }).count(), 0);
    assert.equal(await panel.getByRole('button', { name: 'Make a share link' }).isDisabled(), false);
    const paths = await page.evaluate(() => window.sent.map(one => one.path));
    assert.deepEqual(paths, [
      '/work/api/sharing/collection/links',
      '/work/api/sharing/collection/links/bundle-test/items',
      '/work/api/sharing/collection/links/bundle-test/items',
      '/work/api/sharing/collection/links/bundle-test/revoke',
    ]);
  } finally { await browser.close(); }
});

const thing = index => ({ key: `row:${index}`, kind: 'Row', label: `Launch plan ${index}`, icon: 'Rows3', screen: 'decisions', screen_label: 'Decisions' });

test('the tray: empty, one thing, many things, take out, send to the chosen place, a refused send keeps everything', { timeout: 120000 }, async () => {
  const browser = await launchChromium();
  try {
    const page = await browser.newPage({ viewport: { width: 900, height: 800 } });
    // A page with a secure origin of its own, as the app has: the tray keeps things in its storage and request keys are random ids.
    // It is signed in, as the Worker writes it into the page (src/worker.mjs: first-answers.json kept), since a share is
    // kept on the device only for the account signed in on it (src/workspace/share-outbox.ts).
    const signedIn = `<script type="application/json" id="${firstAnswers.kept.element_id}">${JSON.stringify(keptAnswerSettings({ userId: 'account-a', token: 'sign-in-a' }))}</script>`;
    await page.route('https://tray.test/**', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><body>${signedIn}</body>` }));
    await page.goto('https://tray.test/');
    await page.addScriptTag({ content: outputFiles[0].text });
    const screen = page.locator('#screen');

    // Empty: the shared empty state, whose way forward turns picking on.
    await screen.locator('[data-screen-state="empty"]').getByText('Nothing in your tray yet').waitFor();
    await screen.locator('[data-screen-state="empty"]').getByRole('button', { name: 'Pick things' }).click();
    assert.equal(await page.evaluate(() => window.tray.read().picking), true, 'Pick things turns picking on');
    await page.evaluate(() => window.tray.setPicking(false));
    assert.equal(await screen.getByRole('button', { name: 'Send', exact: true }).isDisabled(), true, 'nothing to send yet');

    // One thing: a shared listing row with its kind, when it was picked and where.
    await page.evaluate(item => window.tray.add([item]), thing(1));
    const row = screen.locator('[data-slot="listing-card"][data-listing-id="row:1"]');
    await row.waitFor();
    assert.equal(await row.getAttribute('data-form'), 'row');
    assert.match(await row.textContent(), /Launch plan 1/);
    assert.match(await row.textContent(), /just now/);
    assert.match(await row.textContent(), /Decisions/);
    await screen.getByText('1 picked').waitFor();
    assert.equal(await screen.getByRole('button', { name: 'Send', exact: true }).isDisabled(), false, 'picked things alone can be sent');

    // Add to it: every way to add is a named tile, out in the open (the same grid as the Send to Trillion popup).
    const ways = screen.locator('[data-add-to-it]');
    for (const name of ['Attach files', 'Draw']) assert.equal(await ways.getByRole('button', { name }).count(), 1, `${name} is a tile`);
    assert.equal(await screen.getByRole('button', { name: 'More ways to add' }).count(), 0, 'nothing is folded behind one icon');

    // Many things: one row each, and Take out removes one.
    await page.evaluate(items => window.tray.add(items), Array.from({ length: 30 }, (_, index) => thing(index + 2)));
    await screen.getByText('31 picked').waitFor();
    assert.equal(await screen.locator('[data-slot="listing-card"]').count(), 31);
    await screen.getByRole('button', { name: 'Take out Launch plan 5' }).click();
    await screen.getByText('30 picked').waitFor();
    assert.equal(await screen.locator('[data-listing-id="row:5"]').count(), 0);

    // By default no place is named: the pickers wait behind Choose where.
    assert.equal(await screen.locator('.composer-picker').count(), 0, 'the pickers are not shown until Choose where is opened');

    // A send that cannot reach the account is kept on the device, said as kept, and sent again with the same request_key.
    await screen.getByRole('textbox').first().click();
    await page.keyboard.type('Look at these');
    await page.evaluate(() => { window.down = true; window.sent = []; });
    await screen.getByRole('button', { name: 'Send', exact: true }).click();
    await screen.getByText('Kept. Trillion will deliver it as soon as your account answers.').waitFor();
    await screen.getByText('Waiting to send').waitFor();
    const [first] = await page.evaluate(() => window.sent);
    assert.equal('to' in first.body, false, 'a default send names no place');
    assert.equal(first.body.items.length, 30);
    assert.equal(first.body.own_words, 'Look at these');
    const keptRows = await page.evaluate(() => JSON.parse(localStorage.getItem('trillion-share-outbox')));
    assert.equal(keptRows.length, 1, 'kept in localStorage');
    assert.equal(keptRows[0].request_key, first.body.request_key);
    await page.evaluate(() => { window.down = false; window.sent = []; window.dispatchEvent(new Event('online')); });
    await screen.getByText('Waiting to send').waitFor({ state: 'detached' });
    const [again] = await page.evaluate(() => window.sent);
    assert.equal(again.body.request_key, first.body.request_key, 'the retry is the same share');
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('trillion-share-outbox')).length), 0, 'cleared once the account answered');

    // The account keeping it at its edge (202 queued) is said as kept.
    await page.evaluate(item => { window.queue = true; window.sent = []; window.tray.add([item]); }, thing(60));
    await screen.getByRole('button', { name: 'Send', exact: true }).click();
    await screen.getByText('Kept. Trillion will deliver it as soon as your account answers.').waitFor();
    await page.evaluate(() => { window.queue = false; });
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('trillion-share-outbox')).length), 0, 'a queued answer is an answer');

    // The account connecting it to pursuits is said.
    await page.evaluate(item => { window.tray.add([item]); }, thing(61));
    await screen.getByRole('button', { name: 'Send', exact: true }).click();
    await screen.getByText('Trillion is on it: Studio team.').waitFor();

    // Choose where: their own Trillion first, then each space, then each tool.
    await page.evaluate(items => window.tray.add(items), [thing(1), ...Array.from({ length: 29 }, (_, index) => thing(index + 2))]);
    await screen.getByRole('button', { name: 'Choose where' }).click();
    await screen.locator('.composer-picker').first().click();
    const menu = page.getByRole('menu');
    await menu.waitFor();
    assert.deepEqual((await menu.getByRole('menuitemradio').or(menu.getByRole('menuitem')).allTextContents()).map(text => text.trim()), ['My Trillion', 'Studio team', 'Launch', "Tell the people who make Trillion"]);
    await page.keyboard.press('Escape');

    // Your AI will: the person's own saved actions, a folder opening its own menu.
    assert.equal(await screen.locator('.composer-picker').count(), 2, 'a place takes an action');
    await screen.locator('.composer-picker').nth(1).click();
    await page.getByRole('menu').getByRole('menuitem', { name: 'Product', exact: true }).hover();
    await page.getByRole('menuitem', { name: 'Product direction' }).click();
    assert.match(await screen.locator('.composer-picker').nth(1).textContent(), /Product direction/);

    // A refused send (in words, not a retryable failure) keeps the tray and the note, says why, and is not kept to retry.
    await screen.getByRole('textbox').first().click();
    await page.keyboard.type('Look at these');
    await page.evaluate(() => { window.refuse = true; });
    await screen.getByRole('button', { name: 'Send', exact: true }).click();
    await screen.getByRole('alert').waitFor();
    assert.equal(await screen.getByRole('alert').textContent(), 'That place is not yours to send to.');
    assert.equal(await screen.locator('[data-slot="listing-card"]').count(), 30, 'the tray is kept');
    assert.match(await screen.getByRole('textbox').first().textContent(), /Look at these/, 'the note is kept');
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('trillion-share-outbox')).length), 0, 'a refusal is not kept to retry');

    // Send: the picked things and the note go to the chosen place, and the tray empties.
    await page.evaluate(() => { window.refuse = false; window.sent = []; });
    await screen.getByRole('button', { name: 'Send', exact: true }).click();
    await screen.locator('[data-screen-state="empty"]').waitFor();
    const [delivered] = await page.evaluate(() => window.sent);
    assert.equal(delivered.path, '/work/api/share-destinations/deliver');
    assert.deepEqual(delivered.body.to, ['private']);
    assert.equal(delivered.body.items.length, 30);
    assert.equal(delivered.body.items[0].text, 'Row: Launch plan 1 (on Decisions)');
    assert.equal(delivered.body.own_words, 'Look at these');
    assert.equal(delivered.body.action, 'direction', 'the chosen action goes with it');
    await screen.getByText('Sent to My Trillion.').waitFor();

    // A tool place chosen in Send to is sent the picked things through the same delivery, with no action.
    await page.evaluate(item => window.tray.add([item]), thing(40));
    await screen.locator('.composer-picker').first().click();
    await page.getByRole('menu').getByText("Tell the people who make Trillion").click();
    assert.equal(await screen.locator('.composer-picker').count(), 1, 'a tool takes no action');
    await screen.getByRole('button', { name: 'Send', exact: true }).click();
    await screen.getByText('The people who make Trillion have it.').waitFor();
    const ran = (await page.evaluate(() => window.sent)).find(one => one.body.to?.[0] === 'tool-place:tool:tell-trillions-makers');
    assert.equal(ran.path, '/work/api/share-destinations/deliver');
    assert.equal(ran.body.action, undefined, 'a tool place takes no action');
    assert.deepEqual(ran.body.input.things.map(item => item.label), ['Launch plan 40']);
    assert.equal(ran.body.input.where, 'your own work');
  } finally { await browser.close(); }
});
