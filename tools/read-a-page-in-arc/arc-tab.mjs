// tools/read-a-page-in-arc/arc-tab.mjs
//
// PURPOSE
//   The three things a read does to Arc, each one osascript call: open a tab of its own at an address and learn its window and
//   tab ids, run one piece of JavaScript in that tab and get its value back, and close that tab. Every call after the open
//   names the tab by its id inside its window's id, never "the active tab of the front window", so two reads at once each
//   read their own page. The address, ids and JavaScript go to osascript as argv, never inside the AppleScript text.
//
//   Arc answers a string as an AppleScript string literal. The JavaScript of every call returns a JSON text, so `evaluate`
//   decodes twice: once for the literal, once for the JSON.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const most_output_bytes = 64 * 1024 * 1024;

// The operation is item 1 of argv. "open": item 2 is the address; it answers "windowId|tabId" of the tab it made.
// "js": items 2 and 3 are the window and tab ids, item 4 the JavaScript. "close": items 2 and 3 are the ids.
const SCRIPT = `
on run argv
  set theOp to item 1 of argv
  tell application "Arc"
    if theOp is "open" then
      set theWindow to (id of front window) as text
      tell front window to make new tab with properties {URL:(item 2 of argv)}
      set theTab to (id of (active tab of window id theWindow)) as text
      return theWindow & "|" & theTab
    else if theOp is "js" then
      set theResult to execute (tab id (item 3 of argv) of window id (item 2 of argv)) javascript (item 4 of argv)
      return theResult
    else
      close (tab id (item 3 of argv) of window id (item 2 of argv))
      return "closed"
    end if
  end tell
end run
`;

/** Arc's own words for a tab or window that is no longer open. */
const GONE = /Can.t get (tab|window) id|Can.t get (tab|window)|Can.t get tab|missing value/i;

/**
 * The Arc tab of one read: { open(address), evaluate(javascript), close() }. `open` answers the tab's place: { window, tab }.
 * Each call is bounded by timeout_ms; a tab that has only just opened may not answer scripts yet, so a call can time out.
 */
export function arcTab({ exec = run, timeout_ms }) {
  let place = null;
  async function call(args) {
    try {
      const { stdout } = await exec('osascript', ['-e', SCRIPT, ...args], { timeout: timeout_ms, maxBuffer: most_output_bytes });
      return stdout;
    } catch (error) {
      if (GONE.test(String(error.stderr || error.message))) throw new Error('The tab this read opened is no longer open in Arc.');
      throw error;
    }
  }
  return {
    async open(address) {
      const [window, tab] = (await call(['open', address])).trim().split('|');
      if (!window || !tab) throw new Error('Arc did not say which tab it opened.');
      place = { window, tab };
      return place;
    },
    async evaluate(javascript) {
      if (!place) throw new Error('No tab is open for this read.');
      const literal = JSON.parse((await call(['js', place.window, place.tab, javascript])).trim());
      return JSON.parse(literal);
    },
    async close() {
      if (!place) return;
      const { window, tab } = place;
      place = null;
      await call(['close', window, tab]);
    },
  };
}
