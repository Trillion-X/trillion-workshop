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
/** Arc's own words for a call that did not reach it (-609): one retry after a short wait. */
const CONNECTION_INVALID = /-609|Connection is invalid/i;
/** Arc's own words for this Mac not allowing the run to control Arc (-1743): never retried. */
const NOT_ALLOWED = /-1743|not allowed to send Apple events|Not authorized to send Apple events/i;

/** The most characters of osascript's own error line an answer carries. */
const MOST_SAID_CHARS = 500;

/**
 * What a failed osascript call said, in one line: its last non-empty line of standard error (osascript's own
 * "<start>:<end>: <kind> error: <message> (<code>)"), never the first characters. Under the engine's sandbox the
 * system frameworks write several lines before it ("Connection Invalid error for service
 * com.apple.hiservices-xpcservice", "Error received in message reply handler"), and a first-300-characters cut answered
 * only those, hiding -2741 (Nov 22 2026, a read whose grant named Messages). The line's own error code is kept; a line
 * without one gets the process's exit code.
 */
export function arcSaid(error) {
  const lines = String(error?.stderr || error?.message || '').split('\n').map(line => line.trim()).filter(Boolean);
  const line = (lines.at(-1) || 'no words').slice(0, MOST_SAID_CHARS);
  if (/\(-?\d+\)$/.test(line) || typeof error?.code !== 'number') return line;
  return `${line} (exit ${error.code})`;
}

/**
 * The Arc tab of one read: { open(address), evaluate(javascript), close() }. `open` answers the tab's place: { window, tab }.
 * Each call is bounded by timeout_ms; a tab that has only just opened may not answer scripts yet, so a call can time out.
 */
export function arcTab({ exec = run, timeout_ms, retry_wait_ms = 2000 }) {
  let place = null;
  async function call(args, retried = false) {
    try {
      const { stdout } = await exec('osascript', ['-e', SCRIPT, ...args], { timeout: timeout_ms, maxBuffer: most_output_bytes });
      return stdout;
    } catch (error) {
      const said = String(error.stderr || error.message);
      if (NOT_ALLOWED.test(said)) throw new Error('Arc refused control from this Mac (-1743): allow automation for Arc in System Settings, Privacy & Security, Automation, then ask again.');
      if (CONNECTION_INVALID.test(said) && !retried) {
        await new Promise(done => setTimeout(done, retry_wait_ms));
        return call(args, true);
      }
      if (GONE.test(said)) throw new Error('The tab this read opened is no longer open in Arc.');
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
