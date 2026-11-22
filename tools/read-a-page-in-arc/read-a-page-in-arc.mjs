import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
// tools/read-a-page-in-arc/read-a-page-in-arc.mjs
//
// PURPOSE
//   Reads one public page in the person's Arc browser through its AppleScript interface, the route the browser work uses when
//   no browser extension is connected. It opens the URL in a tab of its own, waits for the page to finish loading, reads its
//   title, address and visible text, and closes that tab. Click nothing: the tab is only read.
//
//     node read-a-page-in-arc.mjs < input.json
//
//   input.json: { "url": "https://..." }. Prints one JSON line: { title, url, text } or { error }.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Only http and https addresses are opened; any other scheme is refused before Arc is touched.
//   2. The tab is addressed by its window and tab id (arc-tab.mjs), never as "the active tab": a read gets its own page.
//   3. The tab the run opened is closed in every case, including when the read fails.
//   4. A tab that lands on another host is refused, not read.
//   5. The visible text is capped at `most_text_chars`; the wait for the page is bounded by `most_wait_seconds`.
import { text } from 'node:stream/consumers';
import { arcSaid, arcTab } from './arc-tab.mjs';
import { readyStateScript, stashPageScript, textPieceScript } from './page-scripts.mjs';

const most_text_chars = 20000;
const most_wait_seconds = 30;
const hostOf = (address) => new URL(address).hostname.toLowerCase().replace(/^www\./, '');
const pause = (ms) => new Promise((done) => setTimeout(done, ms));

/** Reads one page: { title, url, text } or { error }. */
export async function readPageInArc(input, { exec } = {}) {
  const url = typeof input?.url === 'string' ? input.url.trim() : '';
  if (!/^https?:\/\/\S+$/i.test(url)) return { error: 'The address must be an http or https address.' };
  const tab = arcTab({ exec, timeout_ms: 25000 });
  try {
    await tab.open(url);
    const deadline = Date.now() + most_wait_seconds * 1000;
    await pause(1000);
    while ((await tab.evaluate(readyStateScript())) !== 'complete') {
      if (Date.now() >= deadline) return { error: `The page did not finish loading within ${most_wait_seconds} seconds.` };
      await pause(1000);
    }
    const page = await tab.evaluate(stashPageScript(most_text_chars));
    if (hostOf(page.url) !== hostOf(url)) {
      return { error: `Arc opened ${page.url}, not the address asked (${url}). Nothing was read.` };
    }
    const cap = Math.min(page.textChars, most_text_chars);
    const body = cap > 0 ? await tab.evaluate(textPieceScript(0, cap)) : '';
    return { title: page.title, url: page.url, text: body };
  } catch (error) {
    return { error: `Arc did not answer: ${arcSaid(error)}` };
  } finally {
    await tab.close().catch(() => {});
  }
}

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  const input = JSON.parse((await text(process.stdin)) || '{}');
  console.log(JSON.stringify(await readPageInArc(input)));
}
