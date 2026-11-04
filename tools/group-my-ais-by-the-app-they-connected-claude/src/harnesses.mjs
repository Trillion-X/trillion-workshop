// src/harnesses.mjs
//
// The one reader of src/harnesses.json: every AI app or harness is a row there, and nothing else in the service names an
// app. Callers ask a row what it does (who records its turns, whether work is handed to it, when its reply is final).
import rows from '../../set-up-my-account/read-data/harnesses.json' with { type: 'json' };

const key = name => String(name ?? '').trim().toLowerCase();
const byName = new Map(rows.harnesses.flatMap(row => [row.app, ...row.names].map(name => [key(name), row])));

/** The row an app name (any spelling, any case) belongs to, or null. */
export const harnessOf = name => byName.get(key(name)) ?? null;

/** The row for an app, or the default row for an app with none. */
export const harnessFor = name => harnessOf(name) ?? rows.default;

/** The name an app's messages are kept under: its row's app, or the name as given, trimmed. */
export const canonicalApp = name => harnessOf(name)?.app ?? String(name ?? '').trim();

const escaped = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// A word is either an app's own name (its app or names: "Claude" is the Claude row) or a word that only describes it
// (its product or contains: the Claude Code row's product is "Claude"). The longest word wins; on a tie an app's own
// name wins, so a product word never takes a row whose own name it is.
const fragments = rows.harnesses.flatMap(row => [[row.app, true], ...row.names.map(name => [name, true]), [row.product, false], ...(row.contains ?? []).map(word => [word, false])]
  .filter(([word]) => key(word).length >= 3).map(([word, named]) => ({ row, named, word: key(word), found: new RegExp(`(^|[^a-z0-9])${escaped(key(word))}([^a-z0-9]|$)`) })))
  .sort((a, b) => b.word.length - a.word.length || Number(b.named) - Number(a.named));

/** The row a client name belongs to: its exact spelling, else the longest known word found whole inside it, or null. */
export const harnessWithin = name => harnessOf(name) ?? fragments.find(item => item.found.test(key(name)))?.row ?? null;

/**
 * The AI products a list of connected-AI evidence names, once each, in order, by display name (the row's `product`).
 * An entry is a name or a row declaring its `app`, `harness` or `name`. A key name or fragment that
 * holds no row's app, spelling or word as a whole word names no product and is left out, never shown raw.
 */
export function aiProducts(entries) {
  const products = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    // A personal key seen as several apps arrives as one joined name ("A and B and C", PersonStore.keyApps); each
    // part is an app of its own, so every product in it is named, not only the longest word found in the whole.
    const declared = (typeof entry === 'string' ? [entry] : [entry?.app, entry?.harness, entry?.name]).flatMap(name => (typeof name === 'string' ? name.split(/\s+and\s+/i) : [name]));
    const entryRows = typeof entry === 'string' ? declared.map(harnessWithin) : [declared.map(harnessWithin).find(Boolean)];
    for (const row of entryRows) if (row?.product && !products.includes(row.product)) products.push(row.product);
  }
  return products;
}

/** The apps whose turns a hook records from their transcript, so the AI itself does not. */
export const transcriptHookApps = () => rows.harnesses.filter(row => row.turns.recorded_by_ai === false).map(row => row.app);

/** Those apps as one phrase for a sentence: "A", "A and B", "A, B and C". */
export const transcriptHookNames = () => {
  const apps = transcriptHookApps();
  return apps.length < 2 ? apps.join('') : `${apps.slice(0, -1).join(', ')} and ${apps.at(-1)}`;
};

/** The row with this id, or null. */
export const harnessById = id => rows.harnesses.find(row => row.id === id) ?? null;

/** Every app name with a row. */
export const appNames = () => rows.harnesses.map(row => row.app);

/** A chat session's UUID, as a regular expression source. */
export const SESSION_ID = '[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}';

/** The row and session of a source chat id (`<row id>:<session UUID>`) whose app returns work by transcript, or null. */
export function sourceChat(sourceId) {
  const match = new RegExp(`^([a-z0-9-]+):(${SESSION_ID})$`).exec(sourceId ?? '');
  const row = match && harnessById(match[1]);
  return row?.source_return === 'transcript' ? { row, session: match[2] } : null;
}

const LIVE_MINUTES = 10;

/**
 * Whether an AI reply is the AI's final answer, by its app's row. `marked`: the sender said so (final_reply true), or
 * said nothing about it and gave no time. `recorded-live`: that, or no mark and a time within LIVE_MINUTES of now.
 */
export function isFinalReply(item, now = new Date()) {
  if (item?.speaker !== 'ai') return false;
  if (item.final_reply === true || (item.final_reply === undefined && item.at === undefined)) return true;
  if (item.final_reply !== undefined || harnessFor(item.app).replies.final_when !== 'recorded-live') return false;
  const gap = Math.abs(Date.parse(item.at) - now.getTime());
  return gap <= LIVE_MINUTES * 60_000;
}
