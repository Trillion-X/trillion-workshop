// src/link-previews.mjs
//
// PURPOSE
//   A link in a message shows as a card the first time its message is read, with no jump: the card is read once per
//   normalized address, after the message is kept (never on the request that kept it), and every message page then
//   carries what is known about the links in its messages, keyed by the link as written, with a state
//   (`pending`, `ready`, `failed`). A screen draws the card when it is `ready`, a plain link while `pending`, and a plain link
//   (retried later by itself) when `failed`; it never has to read the page itself.
//
// NON-NEGOTIABLE INVARIANTS
//   1. One preview per normalized address (BLAKE3 of the normalized form), however many messages or spellings carry it:
//      the same page behind two tracking tails is read once.
//   2. The page is read only by the one link reader (`readLink`, src/read-link.mjs readLinkCard, which re-judges every
//      redirect hop). Nothing here fetches.
//   3. Reading is off the path of keeping or reading a message: `ensure` writes pending rows and `settle` reads a bounded
//      few per turn, run after the answer (waitUntil). A failed read is kept as `failed` with when to try again, and a
//      `fetching` claim older than `fetching_stale_after_seconds` is taken again, so a turn that died never leaves a link pending forever.
//   4. A page never names a link it was not asked: only links written in the page's own messages are looked up, at most
//      `max_links_per_page`, and a card keeps only `card_fields`.
//   5. A preview lives while some kept message uses its address: each message that carries a link is one reference to it
//      (`link_preview_refs`), and forgetting a message (`release`) drops its references and the previews no message uses.
//   6. The tables are lazy and made again after deleteEverything (src/table-generation.mjs); every bound is DATA
//      (src/link-preview-rules.json).

import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { tableGeneration } from '../../keep-and-wake-ai-sessions-on-this-computer/src/table-generation.mjs';
import defaultRules from './link-preview-rules.json' with { type: 'json' };

const URL_IN_TEXT = /https?:\/\/[^\s<>"'`)\]]+/gi;
const TRAILING = /[.,;:!?]+$/;
const READY = new WeakMap();

/** The normalized form of an address (rules: link-preview-rules.json), or null when it is not an http(s) address. */
export function normalizeLink(raw, rules = defaultRules) {
  let url;
  try { url = new URL(String(raw).trim()); } catch { return null; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  url.hash = '';
  const keep = [...url.searchParams.entries()].filter(([name]) => !rules.strip_params.includes(name.toLowerCase())
    && !rules.strip_param_prefixes.some(prefix => name.toLowerCase().startsWith(prefix)));
  url.search = '';
  for (const [name, value] of keep.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) url.searchParams.append(name, value);
  return url.href;
}

/** The links written in some words, as written, in order, once each, at most `max_links_per_message`. */
export function linksIn(text, rules = defaultRules) {
  const found = [];
  for (const match of String(text ?? '').matchAll(URL_IN_TEXT)) {
    const written = match[0].replace(TRAILING, '');
    if (normalizeLink(written, rules) && !found.includes(written)) found.push(written);
    if (found.length >= rules.max_links_per_message) break;
  }
  return found;
}

const keyOf = normalized => bytesToHex(blake3(new TextEncoder().encode(normalized))).slice(0, 32);
const trimmed = (card, rules) => Object.fromEntries(rules.card_fields.filter(field => card?.[field] != null && card[field] !== '')
  .map(field => [field, field === 'description' ? String(card[field]).slice(0, rules.description_chars) : card[field]]));

/** sql: the store's SQL handle; readLink(url): the card of one public link; now(): a Date. */
export function linkPreviews(sql, { readLink, now = () => new Date(), rules = defaultRules } = {}) {
  let tables = READY.get(sql);
  if (tables?.generation !== tableGeneration(sql)) READY.set(sql, tables = { generation: tableGeneration(sql), made: false });
  if (!tables.made) {
    sql.exec('CREATE TABLE IF NOT EXISTS link_previews (key TEXT PRIMARY KEY, url TEXT NOT NULL, state TEXT NOT NULL, card TEXT, at TEXT NOT NULL, retry_at TEXT)');
    sql.exec('CREATE TABLE IF NOT EXISTS link_preview_refs (key TEXT NOT NULL, message_id TEXT NOT NULL, PRIMARY KEY (key, message_id))');
    sql.exec('CREATE INDEX IF NOT EXISTS link_preview_refs_message ON link_preview_refs (message_id)');
    tables.made = true;
  }
  const iso = () => now().toISOString();
  const later = seconds => new Date(now().getTime() + seconds * 1000).toISOString();

  return {
    /** Keeps a pending row for each link in these messages' words that has none yet, and one reference from each message
     *  that has an `id` to each of its links; answers how many previews are new. */
    ensure(messages) {
      let added = 0;
      for (const message of messages) {
        for (const written of linksIn(message?.text, rules)) {
          const normalized = normalizeLink(written, rules);
          const before = sql.exec('SELECT 1 FROM link_previews WHERE key = ? LIMIT 1', keyOf(normalized)).toArray().length;
          if (message?.id) sql.exec('INSERT OR IGNORE INTO link_preview_refs (key, message_id) VALUES (?, ?)', keyOf(normalized), String(message.id));
          if (!before) {
            sql.exec('INSERT OR IGNORE INTO link_previews (key, url, state, at) VALUES (?, ?, ?, ?)', keyOf(normalized), normalized, 'pending', iso());
            added += 1;
          }
        }
      }
      return added;
    },
    /** The page's previews, keyed by the link as written: { state, card? }. Links of other messages are never named. */
    forMessages(messages) {
      const written = [];
      for (const message of messages) for (const link of linksIn(message?.text, rules)) if (!written.includes(link)) written.push(link);
      const previews = {};
      for (const link of written.slice(0, rules.max_links_per_page)) {
        const row = sql.exec('SELECT state, card FROM link_previews WHERE key = ? LIMIT 1', keyOf(normalizeLink(link, rules))).toArray()[0];
        previews[link] = !row ? { state: 'pending' } : row.state === 'ready' ? { state: 'ready', card: JSON.parse(row.card) } : { state: row.state === 'failed' ? 'failed' : 'pending' };
      }
      return previews;
    },
    /**
     * Reads up to `settle_per_turn` links that are pending, failed and due again, or claimed too long ago; answers how many it
     * settled. `writes(run)` wraps each synchronous burst of writes (the store tells only the screens that draw messages
     * about them, src/live-screen.mjs changedFor); the page reads happen between the bursts, outside any write.
     */
    async settle({ writes = run => run() } = {}) {
      const due = writes(() => {
        const at = iso();
        const stale = new Date(now().getTime() - rules.fetching_stale_after_seconds * 1000).toISOString();
        const rows = sql.exec(`SELECT key, url FROM link_previews WHERE state = 'pending' OR (state = 'failed' AND retry_at <= ?) OR (state = 'fetching' AND at <= ?)
          ORDER BY at LIMIT ?`, at, stale, rules.settle_per_turn).toArray();
        for (const row of rows) sql.exec("UPDATE link_previews SET state = 'fetching', at = ? WHERE key = ?", iso(), row.key);
        return rows;
      });
      const read = [];
      for (const row of due) {
        let card = null;
        try { card = await readLink(row.url); } catch { card = null; }
        read.push({ key: row.key, card });
      }
      writes(() => {
        for (const { key, card } of read) {
          const readable = card && !(card.unread && !card.title && !card.description && !card.image);
          if (readable) sql.exec("UPDATE link_previews SET state = 'ready', card = ?, at = ?, retry_at = NULL WHERE key = ?", JSON.stringify(trimmed(card, rules)), iso(), key);
          else sql.exec("UPDATE link_previews SET state = 'failed', card = NULL, at = ?, retry_at = ? WHERE key = ?", iso(), later(rules.retry_failed_after_seconds), key);
        }
      });
      return due.length;
    },
    /** These messages were forgotten: their references go, and so does any preview no remaining message uses; answers how many previews went. */
    release(messageIds) {
      let removed = 0;
      for (const id of messageIds ?? []) {
        const keys = sql.exec('SELECT key FROM link_preview_refs WHERE message_id = ? LIMIT 50', String(id)).toArray().map(row => row.key);
        sql.exec('DELETE FROM link_preview_refs WHERE message_id = ?', String(id));
        for (const key of keys) {
          if (sql.exec('SELECT 1 FROM link_preview_refs WHERE key = ? LIMIT 1', key).toArray().length) continue;
          sql.exec('DELETE FROM link_previews WHERE key = ?', key);
          removed += 1;
        }
      }
      return removed;
    },
    /** True while a link waits to be read (so the owner asks to run `settle` again), else false. */
    anyDue() {
      return sql.exec(`SELECT 1 FROM link_previews WHERE state IN ('pending', 'fetching') OR (state = 'failed' AND retry_at <= ?) LIMIT 1`, iso()).toArray().length > 0;
    },
  };
}
