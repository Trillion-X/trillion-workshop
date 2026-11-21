// tools/read-a-page-in-arc/arc-tab.mjs
//
// PURPOSE
//   The three things a pull does to Arc, each one osascript call: open a tab in Arc's front window at an address, run one
//   piece of JavaScript in the active tab and get its value back, close the active tab. The address and the JavaScript go to
//   osascript as argv, never inside the AppleScript text, so neither can change the script.
//
//   Arc answers a string as an AppleScript string literal. The JavaScript of every call returns a JSON text, so `evaluate`
//   decodes twice: once for the literal, once for the JSON.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const most_output_bytes = 64 * 1024 * 1024;

// The operation is item 1 of argv: "open" (item 2 is the address), "js" (item 2 is the JavaScript), "close".
const SCRIPT = `
on run argv
  set theOp to item 1 of argv
  if theOp is "open" then
    tell application "Arc"
      tell front window to make new tab with properties {URL:(item 2 of argv)}
    end tell
    return "opened"
  else if theOp is "js" then
    tell application "Arc"
      set theResult to execute (active tab of front window) javascript (item 2 of argv)
    end tell
    return theResult
  else
    tell application "Arc"
      close (active tab of front window)
    end tell
    return "closed"
  end if
end run
`;

/**
 * The Arc tab of one pull: { open(address), evaluate(javascript), close() }. Arc must be running; one pull at a time.
 * Each call is bounded by timeout_ms; a tab that has only just opened may not answer scripts yet, so a call can time out.
 */
export function arcTab({ exec = run, timeout_ms }) {
  async function call(operation, payload) {
    const argv = ['-e', SCRIPT, operation];
    if (payload !== undefined) argv.push(payload);
    const { stdout } = await exec('osascript', argv, { timeout: timeout_ms, maxBuffer: most_output_bytes });
    return stdout;
  }
  return {
    async open(address) {
      await call('open', address);
    },
    async evaluate(javascript) {
      const literal = JSON.parse((await call('js', javascript)).trim());
      return JSON.parse(literal);
    },
    async close() {
      await call('close');
    },
  };
}
