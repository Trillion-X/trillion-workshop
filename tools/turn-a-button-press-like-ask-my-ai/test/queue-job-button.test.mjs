// The shared "Ask my AI" button (parts/ui/show/queue-job) on Home's goals, bundled as the workspace bundles it and run in
// a real browser: pressing it sends the job's id, the goal and a fresh press key to /work/api/queue, then says it was
// sent, with the one loading mark while the AI works on it and a check once the person's notifications say it is done;
// a refused press leaves it ready and shows the Worker's own words; a free plan shows no button at all.
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { launchChromium } from '../../headless-browser/launch.mjs';
import queued from '../src/queued-work.json' with { type: 'json' };

const root = new URL('..', import.meta.url).pathname;
const home = free => ({ free, summaries: [], pursuits: [{ id: 'pursuit_7', title: 'Launch the pottery course', now: '12 students', after: '100 students' }], allowance: null, helped: [] });
const json = value => JSON.stringify(JSON.stringify(value));

async function homeScreen(page, { free = false, queueAnswer = { status: 200, body: { asked_id: 'asked:1', said: queued.words.done } } } = {}) {
  const { outputFiles } = await build({
    absWorkingDir: root,
    stdin: {
      resolveDir: root, loader: 'ts',
      contents: `
        import { mountHomeCard } from './src/workspace/home-screen';
        import { readAgain } from './src/workspace/person-notifications';
        window.log = [];
        // The person's notifications, as the test sets them; readAgain brings the page's center in line with them.
        window.notifications = [];
        window.readAgain = readAgain;
        window.fetch = async (input, init = {}) => {
          const url = String(input);
          window.log.push({ request: url, method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : null });
          const answers = { '/work/api/decisions': ${json(home(free))}, '/work/api/activity': ${json({ items: [], apps: {} })}, '/work/api/message-task-canvas': ${json({ messages: [], arrivals: [], activity: [] })}, '/work/api/ai-work?limit=1': ${json({ work: [] })}, '/work/api/workflows': ${json({ automations: [] })}, '/work/api/new-work': ${json({ counts: {}, clears_on_show: [], items: [], apps: {} })} };
          if (answers[url]) return new Response(answers[url], { headers: { 'content-type': 'application/json' } });
          if (url === '/work/api/notifications') return new Response(JSON.stringify({ items: window.notifications, unread: 0 }), { headers: { 'content-type': 'application/json' } });
          if (url === '/work/api/queue') return new Response(${JSON.stringify(JSON.stringify(queueAnswer.body))}, { status: ${queueAnswer.status}, headers: { 'content-type': 'application/json' } });
          return new Promise(() => {});
        };
        const element = document.createElement('section');
        element.id = 'screen';
        document.body.append(element);
        // Goals are Home's pursuits part (since 7e39e62e Home is made of its parts, each mounted as a pane mounts it).
        mountHomeCard(element, { surfaceInput: { card: 'pursuits' } });
      `,
    },
    bundle: true, write: false, format: 'iife', platform: 'browser', target: 'es2022', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"', 'import.meta.url': 'document.baseURI' },
    loader: { '.css': 'empty', '.wasm': 'empty' }, external: ['node:*'], logLevel: 'error',
  });
  await page.route('https://home.test/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head></head><body></body></html>' }));
  await page.goto('https://home.test/');
  page.on('pageerror', error => console.error(error.message));
  await page.addScriptTag({ content: outputFiles[0].text });
}

const label = queued.jobs.find(row => row.id === 'look-into-goal').label;

test('a goal on Home asks the person\'s own AI to look into it, and the button says it was sent', { timeout: 120000 }, async () => {
  const browser = await launchChromium();
  try {
    const page = await browser.newPage();
    await homeScreen(page);
    const ask = page.getByRole('button', { name: label });
    await ask.click();
    await page.getByRole('button', { name: queued.words.sent }).waitFor();
    const sent = (await page.evaluate(() => window.log)).filter(entry => entry.request === '/work/api/queue');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].method, 'POST');
    assert.equal(sent[0].body.job_id, 'look-into-goal');
    assert.deepEqual(sent[0].body.context, { pursuit_id: 'pursuit_7', title: 'Launch the pottery course' });
    assert.match(sent[0].body.press_key, /^[0-9a-f-]{36}$/);
    assert.equal(await page.getByRole('button', { name: queued.words.sent }).isDisabled(), true, 'one press is one job');
  } finally { await browser.close(); }
});

// One notification the store answers about the press asked:1, in the shape src/person-notifications.mjs gives.
const about = (state, running) => ({ id: `handoff:asked:1:${state}`, about: 'asked:1', kind: `work-${state}`, at: '2026-09-30T10:00:00.000Z',
  title: state === 'finished' ? 'Writer finished: Launch the pottery course' : 'Writer is working on it', detail: null, actions: [], read: false, waiting: running, running });

test('while the AI works on a sent job the button shows the loading mark, and a check once it is done', { timeout: 120000 }, async () => {
  const browser = await launchChromium();
  try {
    const page = await browser.newPage();
    await homeScreen(page);
    await page.getByRole('button', { name: label }).click();
    const sent = page.getByRole('button', { name: queued.words.sent });
    await sent.waitFor();
    assert.equal(await sent.getAttribute('data-state'), 'working');
    assert.equal(await sent.locator('[data-loading-mark]').count(), 1, 'the loading mark while no AI has finished it');
    await page.evaluate(item => { window.notifications = [item]; return window.readAgain(); }, about('taken', true));
    assert.equal(await sent.getAttribute('data-state'), 'working', 'an AI taking it is still work going on');
    await page.evaluate(item => { window.notifications = [item]; return window.readAgain(); }, about('finished', false));
    await page.locator('button[data-state="sent"]').waitFor();
    assert.equal(await sent.locator('[data-loading-mark]').count(), 0, 'a check once it is done');
  } finally { await browser.close(); }
});

test('a refused press leaves the button ready and shows the Worker\'s words', { timeout: 120000 }, async () => {
  const browser = await launchChromium();
  try {
    const page = await browser.newPage();
    await homeScreen(page, { queueAnswer: { status: 404, body: { error: queued.words.unknown_job } } });
    await page.getByRole('button', { name: label }).click();
    await page.getByText(queued.words.unknown_job).first().waitFor();
    assert.equal(await page.getByRole('button', { name: label }).isEnabled(), true);
  } finally { await browser.close(); }
});

test('on a free plan, which keeps nothing, a goal shows no button', { timeout: 120000 }, async () => {
  const browser = await launchChromium();
  try {
    const page = await browser.newPage();
    await homeScreen(page, { free: true });
    await page.getByText('Launch the pottery course').first().waitFor();
    assert.equal(await page.getByRole('button', { name: label }).count(), 0);
  } finally { await browser.close(); }
});
