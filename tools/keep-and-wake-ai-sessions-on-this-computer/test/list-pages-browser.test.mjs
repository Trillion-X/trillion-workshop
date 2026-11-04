// test/list-pages-browser.test.mjs
//
// A list of any length draws its first page of rows as soon as that one page is read (src/workspace/list-records.ts
// invariant 5, lists-screen.tsx invariant 6): a list of 12,000 rows draws after one read of read_page_rows rows, never a
// read of every row; scrolling to the end of what is drawn reads the next page; a search reads the rest, so a row no
// page held yet is found; and a rule the records door decides itself (src/lists.json store_narrows) is read there with
// `where`, so only the rows it keeps reach the page.
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { launchChromium } from '../../headless-browser/launch.mjs';
import { listRecords, recordsRoad } from './records-road-for-tests.mjs';
import lists from '../src/lists.json' with { type: 'json' };

const root = new URL('..', import.meta.url).pathname;
const PAGE_ROWS = lists.limits.read_page_rows;
const ROWS = 12_000;

const PAGE = `
  import { startRecords } from './src/workspace/records';
  import { mountListScreen } from './src/workspace/lists-screen';
  startRecords({});
  const host = document.createElement('div');
  host.style.cssText = 'height: 860px; display: flex; flex-direction: column; overflow: auto';
  document.body.append(host);
  window.__host = host;
  mountListScreen(host, { surfaceInput: window.__surfaceInput });
`;

const name = index => `Row ${String(index).padStart(5, '0')}`;
const rare = 7;

// A list of ROWS rows on its own road, with a saved view keeping only the one rare row (a rule the door decides).
const reading = () => recordsRoad(listRecords({
  id: 'reading', label: 'Reading', row_type: 'reading', title_field: 'name', fields: [
    { id: 'name', label: 'Name', kind: 'text' },
    { id: 'shelf', label: 'Shelf', kind: 'choice', choices: ['Near', 'Far', 'Rare'] },
  ],
  views: [{ id: 'rare', label: 'Rare', search: '', rules: { kind: 'group', combinator: 'and', negate: false, rules: [
    { kind: 'rule', field: 'shelf', operator: 'is_any_of', params: { values: ['Rare'] } },
  ] } }],
}, Array.from({ length: ROWS }, (_, at) => ({ id: `r${String(at + 1).padStart(5, '0')}`, values: { name: name(at + 1), shelf: at + 1 === rare ? 'Rare' : at % 2 ? 'Near' : 'Far' } }))));

let bundle;
const opened = async (road, surfaceInput) => {
  bundle ??= (await build({
    absWorkingDir: root, stdin: { resolveDir: root, loader: 'tsx', contents: PAGE }, bundle: true, write: false, format: 'iife', platform: 'browser',
    target: 'es2022', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"', 'import.meta.url': 'document.baseURI' },
    loader: { '.css': 'empty', '.wasm': 'dataurl' }, logLevel: 'error',
  })).outputFiles[0].text;
  const browser = await launchChromium();
  const tab = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  tab.on('pageerror', error => errors.push(String(error)));
  await tab.route('https://records.test/', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body></body></html>' }));
  await tab.route('https://records.test/work/api/**', road.route);
  await tab.goto('https://records.test/');
  await tab.evaluate(input => { window.__surfaceInput = input; }, surfaceInput);
  await tab.addScriptTag({ content: bundle });
  return { browser, tab, errors, rowReads: () => road.lists.filter(input => input.type === 'record:reading') };
};

test('a 12,000-row list draws after one page is read, reads the next on scroll and the rest for a search', { timeout: 240_000 }, async () => {
  const { browser, tab, errors, rowReads } = await opened(reading(), { id: 'reading' });
  try {
    // The door answers ids greatest first: the first page is the newest rows, drawn after one read of one page.
    await tab.getByText(name(ROWS)).first().waitFor({ timeout: 20000 });
    assert.deepEqual(rowReads().map(input => [input.limit, input.after ?? null]), [[PAGE_ROWS, null]], 'one page read before the first draw');
    await tab.getByText(`Showing the first ${PAGE_ROWS} rows`).waitFor({ timeout: 20000 });

    // Scrolling to the end of what is drawn reads the next page, from where the first ended.
    await tab.evaluate(() => { window.__host.scrollTop = window.__host.scrollHeight; });
    await tab.getByText(`Showing the first ${PAGE_ROWS * 2} rows`).waitFor({ timeout: 20000 });
    const [, second] = rowReads();
    assert.equal(second.limit, PAGE_ROWS);
    assert.equal(second.after, `record:reading:r${String(ROWS - PAGE_ROWS + 1).padStart(5, '0')}`);

    // A search is decided over every row: the rest are read, and a row no page held is found.
    await tab.getByRole('searchbox').first().fill(name(rare));
    await tab.getByText(name(rare)).first().waitFor({ timeout: 60000 });
    await tab.locator('.record-views-status').waitFor({ state: 'detached', timeout: 60000 });
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('a saved view whose rule the door decides reads only the rows it keeps', { timeout: 240_000 }, async () => {
  const { browser, tab, errors, rowReads } = await opened(reading(), { id: 'reading', saved_view: 'rare' });
  try {
    await tab.getByText(name(rare)).first().waitFor({ timeout: 20000 });
    await tab.locator('.record-views-status').waitFor({ state: 'detached', timeout: 20000 });
    const narrowed = rowReads().filter(input => input.where);
    assert.ok(narrowed.length > 0, 'the rule is read at the door');
    assert.ok(narrowed.every(input => JSON.stringify(input.where) === '{"shelf":"Rare"}'));
    // Every row was read at the door, 999 a call, and only the one it keeps reached the page.
    assert.equal(narrowed.length, Math.ceil(ROWS / 999));
    assert.equal(rowReads().filter(input => !input.where).length, 1, 'only the first page was read before the view was known');
    assert.equal(await tab.locator('[data-record-id]').count(), 1);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
