import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findBrowser } from '../do-work/browser.mjs';
import { compareWith, fixesFrom, judgeExpectation, learnedFrom, matchTarget, offeredActions, verdictOf } from '../do-work/judge.mjs';
import { startShop } from './fixture-shop.mjs';

const script = fileURLToPath(new URL('../do-work/walk-through-an-app.mjs', import.meta.url));
const fixtures = fileURLToPath(new URL('./fixtures', import.meta.url));
const conventions = JSON.parse(readFileSync(new URL('../do-work/walk-conventions.json', import.meta.url), 'utf8'));
const rows = JSON.parse(readFileSync(new URL('../tool-rows.json', import.meta.url), 'utf8')).records.map(record => record.payload);

const run = (job, request) => new Promise((done, failed) => {
  const child = spawn(process.execPath, [script, job], { stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout.on('data', chunk => { out += chunk; });
  child.stderr.on('data', chunk => { err += chunk; });
  child.on('error', failed);
  child.on('close', code => {
    const last = out.trim().split('\n').at(-1);
    try { done({ code, answer: JSON.parse(last) }); } catch { failed(new Error(`No JSON line (exit ${code}): ${out}${err}`)); }
  });
  child.stdin.end(JSON.stringify(request));
});

const controls = [
  { index: 0, role: 'link', name: 'Cart' },
  { index: 1, role: 'button', name: 'Save' },
  { index: 2, role: 'button', name: 'Save' },
  { index: 3, role: 'textbox', name: 'Quantity', value: '2' },
  { index: 4, role: 'checkbox', name: 'Gift wrap', checked: false },
  { index: 5, role: 'button', name: 'Delete', disabled: true },
];

test('a target names exactly one control by role and name, and is refused when it names none or several', () => {
  assert.equal(matchTarget(controls, { role: 'link', name: 'cart' }).control.index, 0);
  assert.equal(matchTarget(controls, { role: 'textbox', name_contains: 'quant' }).control.index, 3);
  assert.equal(matchTarget(controls, { role: 'button', name: 'Save' }).problem, 'ambiguous');
  assert.equal(matchTarget(controls, { role: 'button', name: 'Save', nth: 1 }).control.index, 2);
  assert.equal(matchTarget(controls, { role: 'button', name: 'Pay' }).problem, 'missing');
  assert.equal(matchTarget(controls, {}).problem, 'no-target');
});

test('each expectation kind says whether it held and what was there', () => {
  const facts = { screen: { url: 'http://shop.test/cart', title: 'Cart', text: 'Cart\nTotal: $58' }, controls, console_errors: [], failed_requests: [{ url: '/api', status: 500 }] };
  const held = expect => judgeExpectation(expect, facts).held;
  assert.equal(held({ kind: 'text_visible', text: 'total: $58' }), true);
  assert.equal(held({ kind: 'text_absent', text: 'Error' }), true);
  assert.equal(held({ kind: 'url_contains', text: '/cart' }), true);
  assert.equal(held({ kind: 'title_contains', text: 'cart' }), true);
  assert.equal(held({ kind: 'control_present', target: { role: 'link', name: 'Cart' } }), true);
  assert.equal(held({ kind: 'control_absent', target: { role: 'link', name: 'Checkout' } }), true);
  assert.equal(held({ kind: 'field_value', target: { role: 'textbox', name: 'Quantity' }, equals: '2' }), true);
  assert.equal(held({ kind: 'checked', target: { role: 'checkbox', name: 'Gift wrap' }, equals: false }), true);
  assert.equal(held({ kind: 'no_console_errors' }), true);
  const failed = judgeExpectation({ kind: 'no_failed_requests' }, facts);
  assert.equal(failed.held, false);
  assert.deepEqual(failed.observed, [{ url: '/api', status: 500 }]);
  assert.match(judgeExpectation({ kind: 'looks_nice' }, facts).observed, /Unknown expectation kind/);
});

test('offered actions are do objects that name one enabled control each', () => {
  const offered = offeredActions(controls, conventions.controls.offered_actions_by_role);
  assert.deepEqual(offered.find(item => item.target.name === 'Cart'), { action: 'click', target: { role: 'link', name: 'Cart' } });
  assert.deepEqual(offered.filter(item => item.target.name === 'Save').map(item => item.target.nth), [0, 1]);
  assert.deepEqual(offered.find(item => item.target.name === 'Quantity'), { action: 'fill', target: { role: 'textbox', name: 'Quantity' }, needs: ['value'] });
  assert.equal(offered.some(item => item.target.name === 'Delete'), false);
  for (const item of offered) assert.ok(matchTarget(controls, item.target).control, `${JSON.stringify(item.target)} names one control`);
});

test('the report: verdicts, the fix handoff, what was learned and how a re-run compares', () => {
  const journeys = [{
    id: 'buy', goal: 'Buy two mugs', log: '/e/log.jsonl', video: null,
    steps: [
      { id: 'open', intent: 'Open the cart', do: { action: 'click', target: { role: 'link', name: 'Cart' } }, status: 'passed', expectations: [] },
      { id: 'total', intent: 'See the total', do: { action: 'click', target: { role: 'button', name: 'Update' } }, status: 'failed', url: 'http://shop.test/cart', screenshot: '/e/2.png', console_errors: [], failed_requests: [], expectations: [{ kind: 'text_visible', text: '$58', held: false, observed: 'Total: $29' }] },
      { id: 'save', intent: 'Save', status: 'skipped' },
    ],
  }];
  assert.equal(verdictOf(['passed', 'blocked']), 'blocked');
  assert.equal(verdictOf(['passed', 'failed', 'blocked']), 'failed');
  const [fix] = fixesFrom(journeys, { app_url: 'http://shop.test/', version: 'abc123' });
  assert.equal(fix.step, 'total');
  assert.deepEqual(fix.expected, [{ kind: 'text_visible', text: '$58' }]);
  assert.deepEqual(fix.observed, [{ kind: 'text_visible', observed: 'Total: $29' }]);
  assert.deepEqual(fix.reproduce.map(item => item.step), ['open', 'total']);
  assert.equal(fix.version, 'abc123');
  assert.deepEqual(learnedFrom(journeys), [{ journey: 'buy', step: 'open', do: { action: 'click', target: { role: 'link', name: 'Cart' } } }]);
  const now = [{ id: 'buy', steps: [{ id: 'open', status: 'passed' }, { id: 'total', status: 'passed' }, { id: 'save', status: 'passed' }, { id: 'pay', status: 'failed' }] }];
  assert.deepEqual(compareWith({ journeys }, now).map(item => item.state), ['still_passing', 'fixed', 'now_passing', 'new']);
  assert.equal(compareWith(null, now), null);
});

test('every row runs this folder\'s command in the person\'s own computer with the right job', () => {
  assert.deepEqual(rows.map(row => row.id), ['tool:walk-through-an-app-like-its-users', 'tool:map-an-apps-screens-and-controls', 'tool:read-what-a-running-app-shows']);
  assert.deepEqual(rows.map(row => row.invoke.argv.at(-1)), ['walk', 'map', 'observe']);
  for (const row of rows) {
    assert.deepEqual(row.placements, ['placement:your-computer', 'placement:caller-sandbox']);
    for (const path of row.invoke.files.package_files.paths) assert.ok(existsSync(fileURLToPath(new URL(`../${path}`, import.meta.url))), path);
  }
});

test('a request without journeys or with a bad address is refused with what to change', async () => {
  assert.match((await run('walk', { app_url: 'http://localhost:1/' })).answer.error, /journeys must be a list/);
  assert.match((await run('walk', { app_url: 'ftp://x', journeys: [{ id: 'a', steps: [{}] }] })).answer.error, /http, https, file or data/);
  assert.match((await run('fly', {})).answer.error, /walk or map/);
});

let browserProblem = null;
try { findBrowser(conventions.browser, process.env.WALK_BROWSER); } catch (error) { browserProblem = error.message; }

test('a broken shop fails with evidence and a fix handoff; after the fix, a re-run reports it fixed', { skip: browserProblem ?? false, timeout: 180000 }, async () => {
  const shop = await startShop({ broken: true });
  const evidence = mkdtempSync(join(tmpdir(), 'walk-test-'));
  try {
    const journeys = [
      {
        id: 'buy-two-mugs',
        goal: 'A customer can buy two mugs, save the cart and attach a receipt',
        steps: [
          { id: 'open-cart', intent: 'Open the cart', do: { action: 'click', target: { role: 'link', name: 'Cart' } }, expect: [{ kind: 'url_contains', text: '/cart' }] },
          { id: 'two', intent: 'Ask for two mugs', do: { action: 'fill', target: { role: 'textbox', name: 'Quantity' }, value: '2' }, expect: [{ kind: 'field_value', target: { role: 'textbox', name: 'Quantity' }, equals: '2' }] },
          { id: 'total', intent: 'See the total for two', do: { action: 'click', target: { role: 'button', name: 'Update total' } }, expect: [{ kind: 'text_visible', text: 'Total: $58' }] },
          { id: 'save', intent: 'Save the cart', do: { action: 'click', target: { role: 'button', name: 'Save cart' } }, expect: [{ kind: 'text_visible', text: 'Saved' }, { kind: 'no_failed_requests' }, { kind: 'no_console_errors' }] },
          { id: 'receipt', intent: 'Attach a receipt', do: { action: 'upload', target: { role: 'file', name: 'Receipt' }, files: ['receipt.txt'] }, expect: [{ kind: 'text_visible', text: 'Chosen: receipt.txt' }] },
        ],
      },
      { id: 'read-about', goal: 'A visitor can read about the shop', steps: [{ id: 'about', intent: 'Open the about page', expect: [{ kind: 'title_contains', text: 'About' }] }] },
    ];
    const first = (await run('walk', { app_url: shop.url, version: 'broken', journeys, fixtures_folder: fixtures, evidence_folder: join(evidence, 'first') })).answer.result;
    assert.equal(first.verdict, 'failed');
    const buy = first.journeys[0];
    assert.deepEqual(buy.steps.map(step => step.status), ['passed', 'passed', 'failed', 'skipped', 'skipped']);
    assert.equal(first.fixes.length, 1);
    const [fix] = first.fixes;
    assert.equal(fix.step, 'total');
    assert.match(fix.observed[0].observed, /Total: \$29/);
    assert.ok(statSync(fix.evidence.screenshot).size > 1000, 'the failed step has a picture');
    assert.match(readFileSync(fix.evidence.log, 'utf8'), /"kind":"step_done","step":"total","status":"failed"/);
    assert.equal(first.decisions_needed.length, 1);
    const about = first.decisions_needed[0].offered.find(item => item.target.name === 'About');
    assert.deepEqual(about, { action: 'click', target: { role: 'link', name: 'About' } });
    assert.ok(existsSync(first.report_file));

    shop.setBroken(false);
    const learned = [{ journey: 'read-about', step: 'about', do: about }];
    const second = (await run('walk', { app_url: shop.url, version: 'fixed', journeys, learned, previous_report: first, fixtures_folder: fixtures, evidence_folder: join(evidence, 'second') })).answer.result;
    assert.equal(second.verdict, 'passed', JSON.stringify(second.fixes));
    const states = Object.fromEntries(second.compared_with_previous.map(item => [`${item.journey}/${item.step}`, item.state]));
    assert.equal(states['buy-two-mugs/total'], 'fixed');
    assert.equal(states['buy-two-mugs/open-cart'], 'still_passing');
    assert.equal(states['buy-two-mugs/receipt'], 'now_passing');
    assert.equal(states['read-about/about'], 'now_passing');
    assert.ok(second.learned.some(item => item.journey === 'read-about' && item.do.target.name === 'About'), 'the decided step is learned for next time');

    shop.setBroken(true);
    const third = (await run('walk', { app_url: shop.url, journeys, previous_report: second, fixtures_folder: fixtures, evidence_folder: join(evidence, 'third') })).answer.result;
    assert.equal(third.compared_with_previous.find(item => item.step === 'total').state, 'newly_failing', 'a regression after the fix is caught');
    assert.equal(third.journeys[1].verdict, 'passed', 'the learned step replays from the previous report');
  } finally {
    await shop.close();
    rmSync(evidence, { recursive: true, force: true });
  }
});

test('the map lists each same-origin screen with its controls', { skip: browserProblem ?? false, timeout: 120000 }, async () => {
  const shop = await startShop({ broken: false });
  const evidence = mkdtempSync(join(tmpdir(), 'walk-map-'));
  try {
    const map = (await run('map', { app_url: shop.url, evidence_folder: evidence })).answer.result;
    assert.deepEqual(map.screens.map(screen => new URL(screen.url).pathname).sort(), ['/', '/about', '/cart']);
    const cart = map.screens.find(screen => screen.url.endsWith('/cart'));
    assert.ok(cart.controls.some(control => control.role === 'button' && control.name === 'Update total'));
    assert.ok(cart.offered.some(item => item.action === 'upload' && item.target.name === 'Receipt'));
    assert.ok(statSync(cart.screenshot).size > 1000);
  } finally {
    await shop.close();
    rmSync(evidence, { recursive: true, force: true });
  }
});
