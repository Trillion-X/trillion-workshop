// tools/run-tools-in-my-signed-in-browser/do-work/read-a-page-in-a-scriptable-browser.mjs
//
// PURPOSE
//   The second route of tool:read-a-page-in-a-scriptable-browser, for when no browser extension is connected to this computer:
//   it opens the page as a new tab in a scriptable browser app the person is signed in to (the run names its bundle id through
//   the automate-an-app capability; Arc is company.thebrowser.Browser), waits for the tab to load, reads what the page shows with
//   one fixed read-only script, and closes the tab. It answers { url, title, text, links, images } or an error in words.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Read-only: the page script is one fixed string. It reads the title, the visible text, the links and the image urls. It never
//      types, clicks, submits, selects or sets anything on the page.
//   2. Only the url varies. It is parsed and must be http or https; the canonical form is what goes into the script, escaped for
//      AppleScript.
//   3. The app is the bundle id the run names. Its shape is checked, and an app that is not running is refused, never launched.
//   4. The tab is closed when the run ends, after a failure too.
//   5. A refusal is said in words: Automation not allowed (-1743) is needs_access "automation"; an app not open is
//      "app_not_running"; any other failure is its first line.
//   6. Cookies, tokens and stored browser data are never read: the script asks the page only for what it shows.
//
// USAGE
//   node read-a-page-in-a-scriptable-browser.mjs   (stdin: { url, computer: { "automate-an-app": { app } } }; the last line is { result })
import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { text } from 'node:stream/consumers';

const LIMIT = { text: 20000, links: 500, images: 200 };
const APP = /^[A-Za-z0-9][A-Za-z0-9.-]{2,199}$/;
const NOT_ALLOWED = /-1743|not allowed to send Apple events|Not authorized to send Apple events/i;
const NOT_RUNNING = /app_not_running/;

// Read-only: nothing here types, clicks, submits, selects or sets a value on the page.
export const PAGE_SCRIPT = `JSON.stringify({ title: document.title, text: (document.body ? document.body.innerText : '').slice(0, ${LIMIT.text}), links: [...document.links].slice(0, ${LIMIT.links}).map(a => ({ text: (a.innerText || '').trim().slice(0, 200), href: a.href })).filter(link => link.href), images: [...document.images].slice(0, ${LIMIT.images}).map(image => image.currentSrc || image.src).filter(Boolean) })`;

const firstLine = text => String(text ?? '').split('\n').map(line => line.trim()).find(Boolean)?.slice(0, 300) ?? 'no output';

// A string literal for AppleScript: backslashes and quotes escaped, nothing else can end it.
const appleText = value => `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

// The canonical http or https address, or null.
export function webAddress(value) {
  try {
    const { protocol, href } = new URL(String(value ?? ''));
    return protocol === 'http:' || protocol === 'https:' ? href : null;
  } catch {
    return null;
  }
}

// The one AppleScript run: refuses an app that is not open, opens the tab, waits for it to load, reads the page, closes the tab
// (also when reading fails).
export function scriptFor({ app, url }) {
  const named = appleText(app);
  return [
    `if application id ${named} is not running then error "app_not_running" number 9001`,
    'set theTab to missing value',
    'try',
    `tell application id ${named} to set theTab to make new tab at end of tabs of window 1 with properties {URL:${appleText(url)}}`,
    'repeat 60 times',
    `tell application id ${named} to set stillLoading to loading of theTab`,
    'if stillLoading is false then exit repeat',
    'delay 0.5',
    'end repeat',
    'delay 2',
    `tell application id ${named} to set pageJSON to execute theTab javascript ${appleText(PAGE_SCRIPT)}`,
    `tell application id ${named} to close theTab`,
    'on error errText number errNum',
    `if theTab is not missing value then tell application id ${named} to close theTab`,
    'error errText number errNum',
    'end try',
    'return pageJSON',
  ].join('\n');
}

// The page's answer from osascript's printed line: the JSON the page script returned.
export function pageFrom(stdout, url) {
  let page;
  try {
    page = JSON.parse(String(stdout ?? '').trim());
  } catch {
    return { error: 'unexpected_answer', said: `The browser answered something that is not a page: ${firstLine(stdout)}` };
  }
  if (typeof page?.title !== 'string' || typeof page?.text !== 'string' || !Array.isArray(page?.links) || !Array.isArray(page?.images)) {
    return { error: 'unexpected_answer', said: 'The browser answered a page without its title, text, links and images.' };
  }
  return { url, title: page.title.slice(0, 300), text: page.text, links: page.links, images: page.images, said: 'The page was read in the browser on this Mac, and its tab was closed.' };
}

export function refusalFrom(error) {
  const text = `${error?.stderr ?? ''}\n${error?.message ?? ''}`;
  if (NOT_ALLOWED.test(text)) return { needs_access: 'automation', said: 'Allow the app that runs this tool to control the browser in System Settings, Privacy & Security, Automation.' };
  if (NOT_RUNNING.test(text)) return { error: 'app_not_running', said: 'The browser is not open on this Mac. Open it, then ask again: this run does not start it.' };
  return { error: 'osascript_failed', said: firstLine(error?.stderr || error?.message) };
}

const defaultRun = (file, args) => new Promise((done, fail) => execFile(file, args, { timeout: 90000, maxBuffer: 1048576 }, (error, stdout, stderr) => (error ? fail(Object.assign(error, { stderr })) : done(stdout))));

export function readPage(input, { run = defaultRun } = {}) {
  const url = webAddress(input?.url);
  if (!url) return Promise.resolve({ error: 'bad_url', said: 'The url must be an http or https address.' });
  const app = input?.computer?.['automate-an-app']?.app;
  if (!APP.test(String(app ?? ''))) return Promise.resolve({ error: 'no_app', said: 'Name the browser app as its bundle id in computer["automate-an-app"].app.' });
  return run('/usr/bin/osascript', ['-e', scriptFor({ app, url })]).then(stdout => pageFrom(stdout, url), refusalFrom);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const input = JSON.parse((await text(process.stdin)) || '{}');
  readPage(input).then(result => process.stdout.write(`${JSON.stringify({ result })}\n`));
}
