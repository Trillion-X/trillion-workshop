#!/usr/bin/env node
// harness/keep-web-chats.mjs
//
// Purpose
//   Keeps the person's web chat conversations (ChatGPT on the web, and any site given a row in keep-web-chats.json) in
//   their Trillion word for word, whether or not the chat's own AI managed to write to Trillion. ChatGPT on the web
//   checks each app action before sending it and, from 2026-09-30 to 2026-10-06, stopped Sam's Trillion writes
//   (take_work, write_file, record_messages, add_to_space, set_schedule) before they reached Trillion, so 49
//   conversations and the work in them never arrived. This reads each conversation through the site's own account
//   pages, in a tab of that site the person already has open in their own signed-in browser, and hands it to the
//   account's bring_in_chat tool, the road a chat export takes. A client program on the person's computer, started by
//   the wake-sessions helper (wake-handlers/keep-web-chats.mjs) every `every_seconds`; never part of the hosted service.
//
//     node harness/keep-web-chats.mjs            one pass now (the account key read from the Keychain by name)
//
// Non-negotiable invariants
//   1. Nothing here names a site, a browser or a page address: hosts, the browser app, where the page's sign-in hands
//      its token and where conversations are listed and read are the site row's DATA in keep-web-chats.json.
//   2. It only reads. It never opens a tab, a window or a page, never clicks or types, never reads a password or a
//      cookie: it runs in a tab of the site the person already has open, and when there is none it waits for the next
//      pass. The token the page's own sign-in hands it stays inside that page; only conversations leave it.
//   3. Words are kept exactly as the site returns them (src/chat-archives.mjs reads them; a message longer than one
//      kept message is kept in parts there), and bringing a conversation in again adds nothing twice, so a pass that
//      is cut off is simply done again.
//   4. The cursor (~/.trillion/keep-web-chats/<site>.json) moves only past conversations Trillion accepted, in the
//      order they were last changed, so a refused conversation is read again on the next pass.
//   5. The account key is handed in by the caller (the helper's own key) or read from the macOS Keychain by name, held
//      in memory and put only in the Authorization header.
//
import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireAccountKey } from './account-key.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const settings = JSON.parse(readFileSync(join(HERE, 'keep-web-chats.json'), 'utf8'));
const DAY = 86400000;
const expand = path => path.replace(/^~(?=\/|$)/, homedir());
const wait = ms => new Promise(done => setTimeout(done, ms));

/** A conversation's last-changed time in milliseconds, from an ISO time or seconds. */
export const changedMs = value => (typeof value === 'number' ? value * 1000 : Date.parse(value ?? ''));

/** Runs inside the page: one step of reading conversations, kept under one name between steps. Self-contained. */
export function pageStep({ step, site, since, since_ids = [], most, limit, most_list_pages, id, from, to }) {
  const key = '__trillionKeepWebChats';
  const pick = (value, path) => path.reduce((here, part) => (here == null ? undefined : here[part]), value);
  const held = globalThis[key];
  if (step === 'start') {
    globalThis[key] = { state: 'reading', bytes: {}, order: [] };
    (async () => {
      const kept = globalThis[key];
      try {
        const session = await (await fetch(site.session)).json();
        const headers = { Authorization: `Bearer ${pick(session, site.token_path)}` };
        const changed = item => { const value = pick(item, site.updated_path); return typeof value === 'number' ? value * 1000 : Date.parse(value ?? ''); };
        const wanted = [];
        // Newest first: every item changed after the cursor, down to an item older than it, or the end of the list.
        let done = false;
        for (let pageNo = 0, offset = 0; !done && pageNo < most_list_pages; pageNo += 1, offset += limit) {
          const page = await (await fetch(site.list.replace('{offset}', offset).replace('{limit}', limit), { headers })).json();
          const items = pick(page, site.items_path) ?? [];
          for (const item of items) {
            const at = changed(item);
            const conversation = pick(item, site.id_path);
            if (at < since) { done = true; break; }
            if (at > since || (at === since && !since_ids.includes(conversation))) wanted.push({ id: conversation, changed: at });
          }
          if (items.length < limit) done = true;
        }
        if (!done) throw new Error(`the list has more than ${most_list_pages} pages changed since the last kept conversation`);
        // The oldest `most` are kept, oldest first, so the cursor moves past each one as it is kept and none is skipped.
        wanted.sort((a, b) => a.changed - b.changed);
        for (const { id: conversation, changed } of wanted.slice(0, most)) {
          const text = await (await fetch(site.conversation.replace('{id}', encodeURIComponent(conversation)), { headers })).text();
          kept.bytes[conversation] = new TextEncoder().encode(text);
          kept.order.push({ id: conversation, changed, length: kept.bytes[conversation].length });
        }
        kept.state = 'read';
      } catch (error) { kept.state = 'failed'; kept.error = String(error?.message ?? error); }
    })();
    return { state: 'reading' };
  }
  if (!held) return { state: 'none' };
  if (step === 'status') return { state: held.state, error: held.error ?? null, order: held.state === 'read' ? held.order : null };
  if (step === 'chunk') {
    const part = held.bytes[id].subarray(from, to);
    let binary = '';
    for (let start = 0; start < part.length; start += 32768) binary += String.fromCharCode.apply(null, part.subarray(start, start + 32768));
    return { base64: btoa(binary) };
  }
  if (step === 'clear') { delete globalThis[key]; return { state: 'cleared' }; }
  return { state: 'unknown' };
}

const osascript = (source, args, timeout) => new Promise(resolve => {
  execFile('osascript', ['-', ...args], { timeout, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => resolve(error ? { error: `${stderr || error.message}`.trim() } : { out: stdout.trim() })).stdin.end(source);
});

/** The person's open tab on the site's host, as { window, tab } ids, or null when none is open. Reads only. */
async function openTab(site) {
  const found = await osascript(`on run argv
tell application (item 1 of argv)
repeat with w in windows
set ids to id of (every tab of w whose URL contains (item 2 of argv))
if ids is not {} then return (id of w as text) & "|" & (item 1 of ids)
end repeat
end tell
return ""
end run`, [site.browser_app, site.host], 60_000);
  if (found.error || !found.out) return null;
  const [window, tab] = found.out.split('|');
  return { window, tab };
}

/** Runs one page step in that tab and returns its JSON answer. */
async function inTab(site, where, args) {
  const script = `JSON.stringify((${pageStep.toString()})(${JSON.stringify(args)}))`;
  const ran = await osascript(`on run argv
tell application (item 1 of argv)
tell (tab id (item 3 of argv) of window id ((item 2 of argv) as integer)) to return execute javascript (item 4 of argv)
end tell
end run`, [site.browser_app, where.window, where.tab, script], 120_000);
  if (ran.error) throw new Error(`${site.browser_app} did not run the read: ${ran.error}`);
  let value = ran.out;
  while (typeof value === 'string') { try { value = JSON.parse(value); } catch { break; } }
  return value;
}

/** Hands one conversation to the account's bring_in_chat tool; resolves to its answer or throws its refusal. */
export async function bringIn({ origin, key, app, conversation, post = fetch }) {
  const answer = await post(`${origin}/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'bring_in_chat', arguments: { conversation, app } } }),
  });
  const text = await answer.text();
  const reply = JSON.parse(text.slice(text.indexOf('{')));
  if (reply.error) throw new Error(reply.error.message ?? JSON.stringify(reply.error));
  const words = (reply.result?.content ?? []).map(part => part.text ?? '').join('\n');
  if (reply.result?.isError) throw new Error(words.slice(0, 400));
  return JSON.parse(words.slice(0, words.lastIndexOf('}') + 1));
}

const cursorFile = site => join(expand(settings.cursor_folder), `${site.id}.json`);
const readCursor = (site, now) => {
  try {
    const cursor = JSON.parse(readFileSync(cursorFile(site), 'utf8'));
    return { kept_through_ms: cursor.kept_through_ms, kept_ids_at_ms: cursor.kept_ids_at_ms ?? [] };
  } catch { return { kept_through_ms: now - settings.first_look_back_days * DAY, kept_ids_at_ms: [] }; }
};
// The cursor after one kept conversation: its time, and the ids kept at that same time, so a tie with it is not skipped.
const writeCursor = (site, before, ms, id) => {
  mkdirSync(expand(settings.cursor_folder), { recursive: true });
  const path = cursorFile(site);
  const next = { kept_through_ms: ms, kept_ids_at_ms: before.kept_through_ms === ms ? [...before.kept_ids_at_ms, id] : [id], kept_at: new Date().toISOString() };
  writeFileSync(`${path}.next`, JSON.stringify(next));
  renameSync(`${path}.next`, path);
  return next;
};

/** One pass over one site: reads what changed since its cursor and keeps it. Returns what happened; never throws. */
export async function keepSite(site, { origin, key, now = Date.now, log = () => {} }) {
  try {
    const where = await openTab(site);
    if (!where) return { site: site.id, kept: 0, said: `no ${site.host} tab is open in ${site.browser_app}` };
    let cursor = readCursor(site, now());
    await inTab(site, where, { step: 'start', site, since: cursor.kept_through_ms, since_ids: cursor.kept_ids_at_ms, most: settings.most_per_pass, limit: settings.page_size, most_list_pages: settings.most_list_pages });
    let status;
    for (const deadline = Date.now() + settings.wait_ms; ;) {
      status = await inTab(site, where, { step: 'status' });
      if (status.state !== 'reading' || Date.now() > deadline) break;
      await wait(3000);
    }
    if (status.state !== 'read') return { site: site.id, kept: 0, said: status.error ?? `the read did not finish (${status.state})` };
    let kept = 0;
    for (const { id, changed, length } of status.order) {
      const chunks = [];
      for (let from = 0; from < length; from += settings.chunk_bytes) {
        chunks.push(Buffer.from((await inTab(site, where, { step: 'chunk', id, from, to: from + settings.chunk_bytes })).base64, 'base64'));
      }
      const conversation = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      try {
        await bringIn({ origin, key, app: site.app, conversation });
      } catch (error) { log(`keep-web-chats: ${site.id} ${id} was not kept: ${error.message}`); break; }
      cursor = writeCursor(site, cursor, changed, id);
      kept += 1;
    }
    await inTab(site, where, { step: 'clear' }).catch(() => {});
    return { site: site.id, kept, said: `${kept} of ${status.order.length} conversations kept` };
  } catch (error) { return { site: site.id, kept: 0, said: error.message }; }
}

/** One pass over every site row. */
export async function keepWebChats({ origin, key, log = () => {} }) {
  const results = [];
  for (const site of settings.sites) results.push(await keepSite(site, { origin, key, log }));
  return results;
}

const isEntryScript = () => {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};
if (isEntryScript()) {
  const read = JSON.parse(readFileSync(join(HERE, 'record-every-message.json'), 'utf8'));
  const key = requireAccountKey({ item: read.keychain_item, timeout: 2000 });
  for (const result of await keepWebChats({ origin: read.origin, key, log: line => process.stderr.write(`${line}\n`) })) process.stdout.write(`${result.site}: ${result.said}\n`);
}
