// tools/send-messages/do-work/check-texting.mjs
//
// PURPOSE
//   A read-only check that Messages on the person's Mac can be scripted from a run, before anything is sent: one script,
//   compiled and run by the system's osascript, reads how many chats Messages has and the service type of each of its
//   accounts (iMessage, SMS, ...). It sends nothing, and the answer holds no address, name or message text.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Read-only: the script reads counts and service types and nothing else; it has no send, no set and no make.
//   2. Nothing personal leaves: no account id, handle, chat name or text is in the answer.
//   3. A refusal by the system is said in words: Automation not allowed (-1743) is needs_access "automation"; a script
//      Messages' dictionary could not compile (-2741) is error "cannot_read_messages_terms"; any other failure is its
//      first line.
//
// USAGE
//   node check-texting.mjs        (the computer row; its request is ignored, last line of output is { result })
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const SCRIPT = [
  'tell application "Messages"',
  'set kinds to {}',
  'repeat with oneAccount in (every account)',
  'set end of kinds to ((service type of oneAccount) as text)',
  'end repeat',
  'set chatCount to count chats',
  'end tell',
  'set AppleScript\'s text item delimiters to ","',
  'return (chatCount as text) & tab & (kinds as text)',
].join('\n');

const NOT_ALLOWED = /-1743|not allowed to send Apple events|Not authorized to send Apple events/i;
const NO_TERMS = /-2741|Expected class name but found identifier/;

const firstLine = text => String(text ?? '').split('\n').map(line => line.trim()).find(Boolean)?.slice(0, 300) ?? 'no output';
// osascript's own error line ("44:155: execution error: ... (-10810)"); the system's log lines before it (a service it could
// not reach) are not the reason, so the reason is that line when there is one, else the first line.
const reasonOf = text => String(text ?? '').split('\n').map(line => line.trim()).filter(Boolean).reverse()
  .find(line => /\berror\b.*\(-?\d+\)\s*$/.test(line))?.slice(0, 300) ?? firstLine(text);

// The answer from osascript's printed line: "<chats>\t<kind>,<kind>".
export function answerFrom(stdout) {
  const [chats, kinds = ''] = String(stdout).trim().split('\t');
  const count = Number(chats);
  if (!Number.isInteger(count) || count < 0) return { error: 'unexpected_answer', said: `Messages answered something that is not a count: ${firstLine(stdout)}` };
  const types = kinds.split(',').map(kind => kind.trim()).filter(Boolean);
  return { chats: count, accounts: types.length, service_types: [...new Set(types)].sort(), said: 'Messages on this Mac can be scripted: its terms compiled and it answered.' };
}

export function refusalFrom(error) {
  const text = `${error?.stderr ?? ''}\n${error?.message ?? ''}`;
  if (NOT_ALLOWED.test(text)) return { needs_access: 'automation', said: 'Allow the app that runs this tool to control Messages in System Settings, Privacy & Security, Automation.' };
  if (NO_TERMS.test(text)) return { error: 'cannot_read_messages_terms', said: `The script could not use Messages' own terms: ${reasonOf(error?.stderr || error?.message)}` };
  return { error: 'osascript_failed', said: reasonOf(error?.stderr || error?.message) };
}

export function checkMessages({ run = (file, args) => new Promise((done, fail) => execFile(file, args, { timeout: 30000, maxBuffer: 65536 }, (error, stdout, stderr) => (error ? fail(Object.assign(error, { stderr })) : done(stdout)))) } = {}) {
  return run('/usr/bin/osascript', ['-e', SCRIPT]).then(answerFrom, refusalFrom);
}

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  checkMessages().then(result => process.stdout.write(`${JSON.stringify({ result })}\n`));
}
