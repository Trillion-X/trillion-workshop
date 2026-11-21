// tools/read-a-page-in-arc/read-a-page-in-arc.mjs
//
// PURPOSE
//   Reads one public page in the person's Arc browser through its AppleScript interface, the route the browser work uses when
//   no browser extension is connected. It opens the URL in a tab of Arc's front window, waits for the page to finish
//   loading, reads its title, address and visible text, and closes that tab. Click nothing: the tab is only read.
//
//     node read-a-page-in-arc.mjs < input.json
//
//   input.json: { "url": "https://..." }. Prints one JSON line: { title, url, text } or { error }.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Only http and https addresses are opened; any other scheme is refused before Arc is touched.
//   2. The address reaches osascript as an argument (argv), never inside the script text, so it cannot change the script.
//   3. The tab the run opened is closed in every case, including when the read fails.
//   4. The visible text is capped at `most_text_chars`; the wait for the page is bounded by `most_wait_seconds`.
import { execFile } from 'node:child_process';
import { text } from 'node:stream/consumers';
import { promisify } from 'node:util';

const run = promisify(execFile);
const most_text_chars = 20000;
const most_wait_seconds = 30;

// The AppleScript: the address is item 1 of argv. The tab is the front window's active tab, and it is closed after the read.
const SCRIPT = `
on run argv
  tell application "Arc"
    tell front window
      make new tab with properties {URL:(item 1 of argv)}
    end tell
  end tell
  set theAnswer to ""
  try
    repeat ${most_wait_seconds} times
      delay 1
      tell application "Arc"
        set theState to execute (active tab of front window) javascript "document.readyState"
      end tell
      if theState contains "complete" then exit repeat
    end repeat
    tell application "Arc"
      set theAnswer to execute (active tab of front window) javascript "JSON.stringify({title: document.title, url: location.href, text: (document.body ? document.body.innerText : '').slice(0, ${most_text_chars})})"
    end tell
  on error errMsg
    set theAnswer to "ERROR:" & errMsg
  end try
  tell application "Arc"
    close (active tab of front window)
  end tell
  return theAnswer
end run
`;

/** Reads one page: { title, url, text } or { error }. */
export async function readPageInArc(input, { exec = run } = {}) {
  const url = typeof input?.url === 'string' ? input.url.trim() : '';
  if (!/^https?:\/\/\S+$/i.test(url)) return { error: 'The address must be an http or https address.' };
  let out;
  try {
    ({ stdout: out } = await exec('osascript', ['-e', SCRIPT, url], { timeout: (most_wait_seconds + 30) * 1000 }));
  } catch (error) {
    return { error: `Arc did not answer: ${String(error.stderr || error.message).trim().slice(0, 300)}` };
  }
  // osascript prints the returned text as an AppleScript string literal, so it is unquoted before its JSON is read.
  let answer;
  try {
    answer = JSON.parse(out.trim());
  } catch {
    return { error: 'Arc answered with a page that could not be read.' };
  }
  if (answer.startsWith('ERROR:')) return { error: answer.slice(6).slice(0, 300) };
  try {
    const page = JSON.parse(answer);
    return { title: page.title, url: page.url, text: page.text };
  } catch {
    return { error: 'Arc answered with a page that could not be read.' };
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const input = JSON.parse((await text(process.stdin)) || '{}');
  console.log(JSON.stringify(await readPageInArc(input)));
}
