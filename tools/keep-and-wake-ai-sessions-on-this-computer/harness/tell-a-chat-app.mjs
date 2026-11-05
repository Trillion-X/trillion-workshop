// harness/tell-a-chat-app.mjs
//
// Purpose
//   Tells a chat app open in the person's own signed-in browser that work waits for it in Trillion, by typing one
//   message into that chat and sending it, so a chat app that cannot be started any other way (ChatGPT on the web)
//   starts on the work now instead of on its next visit. A client program on the person's computer, like
//   harness/work-consumer.mjs (which runs it as a host row's `wake` command), never part of the hosted service.
//
//     node harness/tell-a-chat-app.mjs --host chatgpt-in-browser --message "<words>" [--session <chat id>] [--cdp http://127.0.0.1:9222]
//     node harness/tell-a-chat-app.mjs --host chatgpt-in-browser --check      exits 0 when one of its ways can reach a browser
//   The consumer runs it as that host row's `wake` and `check` commands (from this repository's folder), so the
//   consumer itself has no browser code; it exits 1 with the reason on stderr when the message was not sent.
//
// Non-negotiable invariants
//   1. It names no chat app and no browser. Where the chat is (`open`, `open_new`), where to type (`composer`), how
//      to send (`send`), what shows the chat is signed out (`signed_out`), and the ways to reach the browser
//      (`routes`, in order) are the host row's DATA in harness/work-consumer.json; selectors are lists tried in order,
//      since chat apps change their pages.
//   2. Two ways reach the person's own browser, tried in the row's order: `cdp`, the Chrome DevTools protocol at a
//      debugging address (a browser started with --remote-debugging-port), and `apple-events`, the browser's own
//      AppleScript `execute javascript` in a new tab of the named app (`app`: Arc, Google Chrome, ...). Both run the
//      same steps in the page (pageStep below), so the message is typed and sent the same way on either. It never
//      signs in, never reads a password or cookie, and closes only the tab it opened.
//   3. A way that cannot reach the browser (no debugging address answers, the app is not installed) is skipped for
//      the next; a way the computer refuses is reported in the plain words of the route's `refused` rows, which name
//      the setting to turn on. Once text is typed, no other way is tried, so a message is never sent twice.
//   4. A signed-out chat, a missing message box or a message still in the box after sending is reported as not
//      sent, with the reason in plain words; nothing is retried or guessed.
//
import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const fill = (template, values) => template.replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));
const wait = ms => new Promise(done => setTimeout(done, ms));

// One step inside the chat page, the same on every way of reaching the browser. It returns plain JSON.
function pageStep({ step, row, message }) {
  const first = selectors => selectors.map(selector => document.querySelector(selector)).find(Boolean) ?? null;
  const box = first(row.composer);
  const textOf = element => (('value' in element ? element.value : element.textContent) ?? '').trim();
  if (step === 'find') return box ? 'composer' : first(row.signed_out) ? 'signed_out' : '';
  if (step === 'type') {
    box.focus();
    if ('value' in box) {
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(box), 'value').set.call(box, message);
      box.dispatchEvent(new Event('input', { bubbles: true }));
    } else document.execCommand('insertText', false, message);
    return textOf(box) ? 'typed' : '';
  }
  if (step === 'send') {
    const button = (row.send.buttons ?? []).map(selector => document.querySelector(selector)).find(element => element && !element.disabled && element.getAttribute('aria-disabled') !== 'true');
    if (button) { button.click(); return 'button'; }
    return '';
  }
  if (step === 'enter') {
    box.dispatchEvent(new KeyboardEvent('keydown', { key: row.send.key, code: row.send.key, bubbles: true, cancelable: true }));
    return 'key';
  }
  if (step === 'cleared') return box && !textOf(box) ? 'cleared' : '';
  return '';
}
const stepScript = args => `JSON.stringify((${pageStep.toString()})(${JSON.stringify(args)}))`;
// A browser may hand back the page's JSON string once more wrapped in quotes.
const unwrap = text => { let value = text; while (typeof value === 'string') { try { value = JSON.parse(value); } catch { break; } } return value; };

// Reaching the browser through the Chrome DevTools protocol at a debugging address.
async function viaCdp(route, { cdp }) {
  const address = cdp ?? route.cdp;
  const answering = await fetch(`${address}/json/version`).then(answer => answer.ok, () => false);
  if (!answering) return { unavailable: `no browser answers at ${address}` };
  const { chromium } = await import('playwright');
  const connected = await chromium.connectOverCDP(address);
  const context = connected.contexts()[0] ?? await connected.newContext();
  let page = null;
  return {
    async open(url, timeout) { page = await context.newPage(); await page.goto(url, { waitUntil: 'domcontentloaded', timeout }); },
    async run(args) { return unwrap(await page.evaluate(stepScript(args))); },
    async close() { await page?.close().catch(() => {}); await connected.close().catch(() => {}); },
  };
}

// Reaching the browser through its own AppleScript: a new tab, `execute javascript` in it, then closing that tab.
function osascript(source, args) {
  return new Promise(resolve => execFile('osascript', ['-', ...args], { timeout: 30_000 }, (error, stdout, stderr) => resolve(error ? { error: `${stderr || error.message}`.trim() } : { out: stdout.trim() })).stdin.end(source));
}
async function viaAppleEvents(route) {
  if (process.platform !== 'darwin') return { unavailable: 'this computer has no AppleScript' };
  const app = JSON.stringify(route.app);
  const installed = await osascript(`on run argv\nreturn id of application ${app}\nend run`, []);
  if (installed.error) return { unavailable: `${route.app} is not installed on this computer` };
  // The tab this program opened, found by its id in every window (a window's tabs are read in one request).
  const find = 'set found to {}\nrepeat with w in windows\ntell w\nset tabIds to id of every tab\nrepeat with i from 1 to count of tabIds\nif item i of tabIds is item 1 of argv then set found to {w, i}\nend repeat\nend tell\nend repeat';
  const refused = error => (route.refused ?? []).find(row => error.includes(row.contains))?.say ?? `${route.app} did not run the step: ${error}`;
  let tab = null;
  return {
    async open(url) {
      const made = await osascript(`on run argv\ntell application ${app}\nif (count of windows) is 0 then make new window\ntell front window\nmake new tab with properties {URL:(item 1 of argv)}\nreturn id of active tab\nend tell\nend tell\nend run`, [url]);
      if (made.error) throw new Error(refused(made.error));
      tab = made.out;
    },
    async run(args) {
      const ran = await osascript(`on run argv\ntell application ${app}\n${find}\nif found is {} then error "The tab was closed."\ntell item 1 of found to tell tab (item 2 of found) to return execute javascript (item 2 of argv)\nend tell\nend run`, [tab, stepScript(args)]);
      if (ran.error) throw new Error(refused(ran.error));
      return unwrap(ran.out);
    },
    async close() {
      if (tab) await osascript(`on run argv\ntell application ${app}\n${find}\nif found is not {} then tell item 1 of found to tell tab (item 2 of found) to close\nend tell\nend run`, [tab]);
    },
  };
}

// The ways this program can reach a browser, by the `kind` a route row names.
const WAYS = { cdp: viaCdp, 'apple-events': viaAppleEvents };

async function poll(reached, args, wanted, ms) {
  const deadline = Date.now() + ms;
  for (;;) {
    const got = await reached.run(args);
    if (wanted.includes(got) || Date.now() > deadline) return got;
    await wait(300);
  }
}

/** Types `message` into the chat named by `browser` (a host row's `browser` DATA) and sends it, trying its routes in order. */
export async function tellChatApp({ browser: row, cdp = null, session = null, message }) {
  const address = session ? fill(row.open, { session }) : row.open_new;
  const reasons = [];
  for (const route of row.routes) {
    const way = WAYS[route.kind];
    if (!way) { reasons.push(`this program has no way called ${route.kind}`); continue; }
    const reached = await way(route, { cdp });
    if (reached.unavailable) { reasons.push(reached.unavailable); continue; }
    let typed = false;
    try {
      await reached.open(address, row.wait_ms);
      const found = await poll(reached, { step: 'find', row }, ['composer', 'signed_out'], row.wait_ms);
      if (found !== 'composer') { reasons.push(found === 'signed_out' ? `the chat at ${address} is signed out in ${route.app ?? 'that browser'}; sign in there once` : `no message box was found at ${address}`); continue; }
      typed = (await reached.run({ step: 'type', row, message })) === 'typed';
      if (!typed) { reasons.push(`the message could not be typed at ${address}`); continue; }
      const sent = await poll(reached, { step: 'send', row }, ['button'], row.send.buttons?.length ? row.wait_ms : 0);
      if (sent !== 'button' && row.send.key) await reached.run({ step: 'enter', row });
      const cleared = await poll(reached, { step: 'cleared', row }, ['cleared'], row.wait_ms);
      return cleared === 'cleared' ? { started: true, how: `sent in ${new URL(address).host} through ${route.app ?? route.kind}` } : { started: false, why: `The message was typed at ${address} but is still in the box, so it was not sent.` };
    } catch (error) {
      if (typed) return { started: false, why: `The message was typed at ${address} but sending stopped: ${error.message}` };
      reasons.push(error.message);
    } finally {
      await reached.close();
    }
  }
  return { started: false, why: `Not sent: ${reasons.join('; ')}.` };
}

/** Which of the row's routes can reach a browser now (the consumer's `check`). */
export async function routesAnswering({ browser: row, cdp = null }) {
  const answering = [];
  for (const route of row.routes) {
    const reached = await WAYS[route.kind]?.(route, { cdp });
    if (reached && !reached.unavailable) { answering.push(route.app ?? route.kind); await reached.close(); }
  }
  return answering;
}

const isEntryScript = () => {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};
if (isEntryScript()) {
  const rules = (await import('./work-consumer.json', { with: { type: 'json' } })).default;
  const args = Object.fromEntries(process.argv.slice(2).reduce((found, value, index, all) => (value.startsWith('--') ? [...found, [value.slice(2), all[index + 1]?.startsWith('--') || all[index + 1] === undefined ? 'true' : all[index + 1]]] : found), []));
  const host = rules.hosts[args.host];
  if (!host?.browser) throw new Error(`--host is one of: ${Object.entries(rules.hosts).filter(([, row]) => row.browser).map(([id]) => id).join(', ')}.`);
  const cdp = args.cdp && args.cdp !== 'true' ? args.cdp : null;
  if (args.check) {
    const answering = await routesAnswering({ browser: host.browser, cdp });
    process.stdout.write(`${answering.length ? `reachable through ${answering.join(', ')}` : 'no browser can be reached'}\n`);
    process.exit(answering.length ? 0 : 1);
  }
  if (!args.message) throw new Error('--message (the words to send) is needed.');
  const outcome = await tellChatApp({ browser: host.browser, cdp, session: args.session && args.session !== 'true' ? args.session : null, message: args.message });
  if (!outcome.started) {
    process.stderr.write(`${outcome.why}\n`);
    process.exit(1);
  }
  process.stdout.write(`${outcome.how}\n`);
}
