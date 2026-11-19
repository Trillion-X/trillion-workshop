// extension/src/browser-runs.mjs
//
// PURPOSE
//   Makes this browser the place the person's AI reads and acts on pages signed in as them: a tool run on the person's
//   own computer reaches the browser through the native messaging host's relay (src/computer-relay.mjs), and this
//   answers each request with the function its tool id names (browser-runs.json `tools`), so an AI can read a page that
//   needs their sign-in, or one that refuses requests from servers.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Only a request the person's own computer relays over the connection the person allowed is answered; what a page
//      says goes nowhere else.
//   2. A page is read or acted on in a window this opens for that run, never brought forward, and closed when done; the person's
//      own tabs are never read or moved.
//   3. Which tools run here, the timings and every word are DATA (extension/browser-runs.json); nothing here names a site.
//   4. Every request is answered: with the answer, or with `error` saying why, so the request never waits for nothing.

import settings from '../browser-runs.json' with { type: 'json' };
import { driveMyBrowser } from './browser-session.mjs';

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

/** Answers one relayed request with the function its tool id names: the answer, or `{ error }` in words. */
export async function runBrowserTool(toolId, input, { runs = RUNS, config = settings } = {}) {
  try {
    const run = runs[config.tools[toolId]];
    if (!run) throw new Error(fill(config.words.not_kept, { tool: toolId }));
    return { result: await run(input ?? {}) };
  } catch (error) {
    return { error: String(error?.message ?? error) };
  }
}
