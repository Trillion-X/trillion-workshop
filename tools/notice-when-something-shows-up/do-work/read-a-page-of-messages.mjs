import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
/**
 * notice-when-something-shows-up/do-work/read-a-page-of-messages.mjs
 *
 * Purpose
 *   Read one page of the messages already in the person's own Mac's Messages database, newest first, and answer them as the
 *   facts a watcher tells for a new message. It tells the engine nothing: the caller (a backfill workflow) keeps them and
 *   comes back with the position this page ended at.
 *
 * Non-negotiable invariants
 *   - Read only, through the same copy-and-read the watcher uses (imessage-chat-database.mjs), so the answer's facts are the
 *     watcher's facts byte for byte: the same key, the same time, the same `after`.
 *   - A page is small: at most max_facts facts and max_bytes bytes of facts, so the answer stays a few kilobytes.
 *   - A Mac that refuses the database answers an error naming the setting to change, never an empty page.
 *
 * Input (stdin JSON)
 *   where       the source's name, told as each fact's where (default "imessage")
 *   database    the Messages database, absolute or under the home folder (default Library/Messages/chat.db)
 *   before_row  the position to read below (a row id); left out, from the newest message
 *   max_facts   most facts in the page (default 40)
 *   max_bytes   most bytes of facts in the page (default 12000)
 *   include_own true to take the person's own sends too (default false)
 *   kinds       the kinds each fact carries (default [])
 *
 * Answer (stdout JSON): {facts: [{where, place, change, at, key, by, after, kinds}], next_before_row, done, bytes}
 */
import { userInfo } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { openCopy, pageBefore, readDatabase, readSettings } from "./mechanisms/imessage-chat-database.mjs";

const refused = (error) => /authorization denied|not permitted|unable to open|operation not permitted|EPERM|EACCES/i.test(String(error?.message ?? error));

function homeFolder() {
  try { return userInfo().homedir; } catch { return process.env.HOME ?? "/"; }
}

/** One page for an input; `open` and `home` are for tests. */
export function readAPage(input, { open = openCopy, home = homeFolder() } = {}) {
  const own = readSettings({ where: input.where, database: input.database, include_own: input.include_own, kinds: input.kinds ?? [] });
  const file = path.isAbsolute(own.database) ? own.database : path.join(home, own.database);
  let db;
  try {
    db = open(file);
    return pageBefore(own, readDatabase(db), { before_row: input.before_row, max_facts: input.max_facts, max_bytes: input.max_bytes });
  } catch (error) {
    if (!refused(error)) throw error;
    return { error: "Messages refused the database: give the app that runs this engine Full Disk Access (System Settings > Privacy & Security > Full Disk Access)." };
  } finally {
    db?.close?.();
  }
}

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  try {
    const answer = readAPage(text.trim() ? JSON.parse(text) : {});
    process.stdout.write(`${JSON.stringify(answer)}\n`);
    if (answer.error) process.exitCode = 1;
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ error: String(error?.message ?? error) })}\n`);
    process.exitCode = 1;
  }
}
