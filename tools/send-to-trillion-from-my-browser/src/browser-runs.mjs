// extension/src/browser-runs.mjs
//
// PURPOSE
//   Makes this browser a place the person's Trillion can run work: placement:your-browser (executor `agent`, agent
//   `this-browser`) hands a run here as { tool_id, input }, and this answers it in the browser the person is signed in
//   to, so an AI can read a page that needs their sign-in, or one that refuses requests from servers. It publishes the
//   agent card, looks for work handed to it by name on an alarm (the account's /agents/publish, /handoffs/take and
//   /handoffs/finish, the routes computer/mac-tools.mjs uses), answers each run with the function its tool id names
//   (browser-runs.json `tools`), and finishes the work with the answer or `error` in words.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Only work handed to this browser by name (take_work only_mine) is taken, and only from the person's own account
//      it is signed in to; what a page says goes nowhere else.
//   2. A page is read or acted on in a window this opens for that run, never brought forward, and closed when done; the person's
//      own tabs are never read or moved.
//   3. Which tools run here, the timings and every word are DATA (extension/browser-runs.json); nothing here names a site.
//   4. Every run is finished: with the answer, or with `error` saying why, so the run never waits for nothing.

import settings from '../browser-runs.json' with { type: 'json' };
import { account, signedIn } from './trillion.mjs';
import { driveMyBrowser } from './browser-session.mjs';

const ALARM = 'browser-runs';
const fill = (template, values) => String(template ?? '').replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? ''));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Opens `url` in a window of its own that is not brought forward, waits until it has loaded, runs `work(tabId)`, and always closes it. */
async function inPageWindow(url, { browser, read, words }, work) {
  if (!/^https?:\/\//i.test(url)) throw new Error(words.needs_url);
  const window = await browser.windows.create({ url, focused: false, state: 'minimized', type: 'normal' });
  const tabId = window.tabs?.[0]?.id;
  try {
    const until = Date.now() + read.most_seconds * 1000;
    for (;;) {
      const tab = await browser.tabs.get(tabId);
      if (tab.status === 'complete') break;
      if (Date.now() > until) throw new Error(fill(words.too_slow, { url, seconds: read.most_seconds }));
      await wait(250);
    }
    await wait(read.settle_ms);
    return await work(tabId);
  } catch (error) {
    throw new Error(fill(words.not_read, { url, error: String(error?.message ?? error) }));
  } finally {
    await browser.windows.remove(window.id).catch(() => {});
  }
}

/** Reads one page in its own unfocused window: { url, title, text, links } as the loaded page shows them. */
export async function readPage(input, { browser = chrome, read = settings.read_page, words = settings.words } = {}) {
  const url = String(input?.url ?? '');
  return inPageWindow(url, { browser, read, words }, async tabId => {
    const page = await browser.tabs.sendMessage(tabId, { read_page: { max_text: read.max_text, max_links: read.max_links } });
    if (!page || page.error) throw new Error(page?.error ?? 'the page did not answer');
    return page;
  });
}

/**
 * Acts on one page in its own unfocused window, as the person's signed-in browser: `steps` (extension/page-actions.json actions) are
 * validated first, then done in order; `dry_run` only locates. The answer says what each step did and reads the page again after,
 * so the caller sees what really changed.
 */
export async function actOnPage(input, { browser = chrome, read = settings.read_page, act = settings.act, words = settings.words } = {}) {
  const url = String(input?.url ?? '');
  if (!Array.isArray(input?.steps) || !input.steps.length) throw new Error(words.needs_steps);
  return inPageWindow(url, { browser, read, words }, async tabId => {
    const done = await browser.tabs.sendMessage(tabId, { act_on_page: { steps: input.steps, dry_run: input.dry_run === true } });
    if (!done || done.error) throw new Error(done?.error ?? 'the page did not answer');
    if (input.dry_run === true) return done;
    await wait(act.settle_ms);
    const after = await browser.tabs.sendMessage(tabId, { read_page: { max_text: act.after_text, max_links: act.after_links } }).catch(() => null);
    return { ...done, after: after && !after.error ? after : null };
  });
}

const RUNS = { readPage, actOnPage, driveMyBrowser };

/** One look for work: publishes the card, takes each run handed to this browser and finishes it. */
// The card lists every tool this browser runs, as computer/mac-tools.mjs does, and is sent again only every
// `publish_every_minutes`, so looking for work every half minute costs the account a read, not a write.
let publishedAt = 0;
export async function takeRuns({ call = account, runs = RUNS, config = settings, now = Date.now() } = {}) {
  const agent_id = config.agent.agent_id;
  if (now - publishedAt >= config.publish_every_minutes * 60_000) {
    await call('/agents/publish', { ...config.agent, skills: Object.keys(config.tools).map(id => ({ id, name: id })), takes_work: true });
    await call('/agents/capacity', { agent_id, ...config.capacity });
    await call('/agents/presence', { agent_id });
    publishedAt = now;
  }
  for (let taken = 0; taken < config.capacity.max_concurrent; taken += 1) {
    const work = await call('/handoffs/take', { agent_id, only_mine: true });
    const job = work?.handoff ?? null;
    if (!job?.handoff_id) return taken;
    const toolId = job.input?.tool_id;
    const run = runs[config.tools[toolId]];
    let result;
    try {
      if (!run) throw new Error(fill(config.words.not_kept, { tool: toolId }));
      result = await run(job.input?.input ?? {});
    } catch (error) {
      result = { error: String(error?.message ?? error) };
    }
    await call('/handoffs/finish', { handoff_id: job.handoff_id, agent_id, ...(work.generation !== undefined ? { generation: work.generation } : {}), result, summary: result.error ?? 'This browser answered.' });
  }
  return config.capacity.max_concurrent;
}

let looking = null;
async function look() {
  if (looking || !(await signedIn())) return;
  looking = takeRuns().catch(() => {}).finally(() => { looking = null; });
  await looking;
}

if (globalThis.chrome?.alarms) {
  chrome.alarms.create(ALARM, { periodInMinutes: settings.every_minutes });
  chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === ALARM) look(); });
  look();
}
