// tools/pull-from-connected-accounts/do-work/pull.mjs
//
// Pull a person's messages or saved items from one connected service into their own records.
//
// One run, for one source description (read-data/sources/<source>.json) and one account name:
//   1. take the token from the private pipe the run was handed (descriptor 4); with none, say so and touch nothing
//   2. ask the service who the token belongs to; refuse with a plain sentence when it says no
//   3. walk the description's requests (a list of parents, then each parent's messages or items), page by page
//   4. fold what came into what the records already hold (read-data/fold.mjs), once per identity, in order
//   5. write only the parts that changed, then the state (who, and how far the pull has read)
//
// The token is only ever in the request header (or the path the description names) and is scrubbed from every
// sentence this prints. A failed request is named in `errors` and never stops the others; the cursor moves only when
// a run had no failed request, so what a failure missed is read again next time (re-reading is safe: the fold dedups).
import { readFileSync } from 'node:fs';
import { at, evaluate, fill, isThere } from '../read-data/pointer.mjs';
import { compareValues, foldItems, identityOf } from '../read-data/fold.mjs';
import { loadSource } from '../read-data/sources.mjs';
import { PART_KIND, itemId, readParts, stateId, threadId } from '../read-data/snapshot.mjs';

const TOKEN_FD = 4;
const LIST_PAGES = 20;
const TRANSPORT_TRIES = 4;
const REQUEST_SECONDS = 30;
const WRITE_CHUNK = 200;
const isItem = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** The token on the private pipe: the whole text, or the access token inside a small JSON blob. Nothing when there is none. */
export function readToken(fd = TOKEN_FD) {
  let text;
  try { text = readFileSync(fd, 'utf8').trim(); } catch { return undefined; }
  if (!text) return undefined;
  if (!text.startsWith('{')) return text;
  try {
    const blob = JSON.parse(text);
    for (const holder of [blob.tokens, blob]) {
      for (const key of ['access_token', 'bot_token', 'token', 'value']) if (typeof holder?.[key] === 'string' && holder[key]) return holder[key];
    }
  } catch { /* not JSON: fall through to no token */ }
  return undefined;
}

function settingsOf(source, input) {
  const whole = (value, fallback, least, most, name) => {
    const number = value === undefined ? fallback : value;
    if (!Number.isInteger(number) || number < least || number > most) throw new Error(`${name} is a whole number from ${least} to ${most}.`);
    return number;
  };
  const account = input.account === undefined ? 'default' : input.account;
  if (typeof account !== 'string' || !account.trim() || account.length > 120) throw new Error('account is a name of 1 to 120 characters that tells this account from your other accounts on the same service (for example "work").');
  return {
    account,
    limit: whole(input.limit, source.defaults.limit, 1, 500, 'limit'),
    most_pages: whole(input.most_pages, source.defaults.most_pages, 1, 20, 'most_pages'),
    most_threads: whole(input.most_threads, source.defaults.most_threads, 1, 200, 'most_threads'),
  };
}

// One GET with the token presented the way the description says. Answers { body } or { error, status, refused } where
// refused means the service said the token is not good (HTTP 401 or 403, or its own ok:false answer).
function makeHttp(source, token, { fetch: send = globalThis.fetch, wait = ms => new Promise(done => setTimeout(done, ms)) }) {
  const scrub = text => String(text).split(token).join('(the token)');
  const headers = { ...(source.headers ?? {}) };
  let root = source.base;
  if (source.auth?.in === 'header') headers[source.auth.name] = `${source.auth.prefix ?? ''}${token}`;
  if (source.auth?.in === 'path') root = `${source.base}/${fill(source.auth.template, { token })}`;
  const seconds = (response, body) => {
    const from = source.rate_limit?.wait_from ?? {};
    const told = Number((from.header && response.headers.get(from.header)) ?? (from.body && at(body, from.body)));
    return Math.min(Number.isFinite(told) && told > 0 ? told : 1, source.rate_limit?.most_wait_seconds ?? 30);
  };

  return async function get(path, query = {}) {
    const url = `${root}${path}${Object.keys(query).length ? `?${new URLSearchParams(query)}` : ''}`;
    let limited = false;
    for (let attempt = 1; ; attempt += 1) {
      let response;
      try {
        response = await send(url, { method: 'GET', headers, signal: AbortSignal.timeout(REQUEST_SECONDS * 1000) });
      } catch {
        // The connection dropped before any answer: a short bounded retry. An answer, even a refusal, is never retried.
        if (attempt < TRANSPORT_TRIES) { await wait(1000 * attempt); continue; }
        return { error: `${path}: the service could not be reached`, status: 0 };
      }
      const text = await response.text();
      let body = null;
      try { body = JSON.parse(text); } catch { /* an answer that is not JSON stays null */ }
      if (response.status === 429 && !limited) { limited = true; await wait(seconds(response, body) * 1000); continue; }
      const saidNo = source.failure?.when_false !== undefined && at(body, source.failure.when_false) === false;
      if (!response.ok || saidNo) {
        const reason = (source.failure?.message ?? []).map(pointer => at(body, pointer)).find(isThere);
        return { error: scrub(`${path}: ${isThere(reason) ? reason : 'refused'} (HTTP ${response.status})`), status: response.status, refused: saidNo || response.status === 401 || response.status === 403 };
      }
      return { body };
    }
  };
}

const idsOf = (list, policy) => new Set(list.map(item => identityOf(item, policy)).filter(id => id !== undefined));

// Walk one description walk: every level's requests, the last level's items collected. Returns what it gathered.
async function runWalk(walk, { source, settings, cursor, selfId, get, held, errors }) {
  const levels = walk.levels;
  const collected = { threads: new Map(), items: [], raw: [], records: [] };
  let threadsFetched = 0;
  const baseVars = { ...(source.vars ?? {}), self_id: selfId, limit: settings.limit, most_threads: settings.most_threads, cursor };

  async function level(index, vars, parent) {
    const here = levels[index];
    const last = index === levels.length - 1;
    const query = () => Object.fromEntries(Object.entries(here.query ?? {}).map(([name, template]) => [name, fill(template, vars)]).filter(([, value]) => value !== ''));
    const path = here.path.replace(/\{([A-Za-z0-9_]+)\}/g, (_, name) => encodeURIComponent(vars[name] ?? ''));
    if (last && walk.fold.layout === 'threads') {
      if (threadsFetched >= settings.most_threads) return;
      threadsFetched += 1;
      // The conversation is known before its messages are: a rename is kept even when no message came with it.
      const thread = walk.fold.thread;
      const id = evaluate(thread.id, { vars });
      if (id !== undefined) register(collected, id, evaluate(thread.title ?? thread.id, { vars }), thread.source ? parent : undefined);
    }
    const known = last && walk.fold.stop_when_known ? knownIds(walk, vars, held) : null;
    let page;
    for (let pages = 1; pages <= (last ? settings.most_pages : LIST_PAGES); pages += 1) {
      const answer = await get(path, page === undefined ? query() : { ...query(), [here.page.param]: page });
      if (answer.error) { errors.push(answer.error); return; }
      const list = at(answer.body, here.items ?? '');
      const entries = Array.isArray(list) ? list.filter(isItem) : [];
      if (!last) {
        for (const entry of entries) {
          if (!(here.keep ?? []).every(rule => rule.in.includes(at(entry, rule.at)))) continue;
          const bound = { ...vars };
          for (const [name, expression] of Object.entries(here.bind ?? {})) bound[name] = evaluate(expression, { item: entry, vars });
          await level(index + 1, bound, entry);
        }
      } else {
        gather(walk, entries, vars, parent, collected);
        // A page that holds only what is already held means everything older is held too: stop paging.
        const pageIds = [...idsOf(entries.map(entry => unwrapped(walk, entry)).filter(isItem), walk.fold)];
        if (known && pageIds.length && pageIds.every(id => known.has(id))) return;
      }
      page = nextPage(here, answer.body, entries, settings.limit);
      if (page === undefined) return;
    }
    // The pages ran out before the service's did. Where the cursor decides what the next pull asks for, moving it
    // now would skip the messages on the pages not read, so it stays and the pull says so.
    if (last && source.cursor) errors.push(`${path}: there are more pages than most_pages (${settings.most_pages}); raise most_pages to read them. The cursor did not move.`);
  }
  await level(0, baseVars, undefined);
  return collected;
}

const unwrapped = (walk, entry) => {
  const wrappers = walk.levels.at(-1).unwrap;
  if (!wrappers) return entry;
  return wrappers.map(pointer => at(entry, pointer)).find(isItem);
};

function nextPage(level, body, entries, limit) {
  const rule = level.page;
  if (!rule) return undefined;
  if (rule.next) {
    if (rule.requires && !isThere(at(body, rule.requires))) return undefined;
    const token = at(body, rule.next);
    return isThere(token) ? String(token) : undefined;
  }
  // A page that came back full may have older items behind it; the next page starts at this page's last item.
  if (rule.from_last && entries.length >= limit) {
    const token = at(entries.at(-1), rule.from_last);
    return isThere(token) ? String(token) : undefined;
  }
  return undefined;
}

// The identities already held where this walk's items will land, so paging can stop at the first page it already has.
function knownIds(walk, vars, held) {
  if (walk.fold.layout === 'items') return new Set([...(held.items.get(walk.fold.into)?.keys() ?? [])]);
  const thread = evaluate(walk.fold.thread.id, { vars });
  const messages = thread === undefined ? [] : held.threads.get(thread)?.thread.messages ?? [];
  return idsOf(messages, walk.fold);
}

function register(collected, id, title, source) {
  if (!collected.threads.has(id)) collected.threads.set(id, { title: undefined, source: undefined, records: [] });
  const thread = collected.threads.get(id);
  thread.title = title ?? thread.title;
  thread.source = source ?? thread.source;
  return thread;
}

function gather(walk, entries, vars, parent, collected) {
  for (const entry of entries) {
    collected.raw.push(entry);
    const record = unwrapped(walk, entry);
    if (!isItem(record)) continue;
    collected.records.push(record);
    if (walk.fold.layout === 'items') { collected.items.push(record); continue; }
    const thread = walk.fold.thread;
    const id = evaluate(thread.id, { item: record, vars });
    if (id === undefined) continue;
    register(collected, id, evaluate(thread.title ?? thread.id, { item: record, vars }), thread.source ? parent : undefined).records.push(record);
  }
}

// What the cursor becomes: the later of what it was and the greatest value seen (plus the description's step).
function advanced(rule, prior, gathered) {
  const seen = (rule.over === 'raw' ? gathered.raw : gathered.records).map(item => at(item, rule.by)).filter(isThere);
  if (!seen.length) return prior;
  const greatest = seen.reduce((best, value) => (compareValues(value, best) > 0 ? value : best));
  const next = rule.plus ? Number(greatest) + rule.plus : greatest;
  return prior !== null && prior !== undefined && compareValues(prior, next) >= 0 ? prior : next;
}

function wordsFor(source, result) {
  if (result.status === 'needs_login') return `${source.label} did not accept the token (or none was given). Give the held token for ${source.label} again, then pull again.`;
  if (result.status === 'unreachable') return `${source.label} could not be reached, so nothing was pulled. Try again shortly.`;
  const what = result.new_messages ? `${result.new_messages} new messages in ${result.threads} conversations` : result.new_items ? `${result.new_items} new items` : 'nothing new';
  const failed = result.errors.length ? `; ${result.errors.length} request${result.errors.length === 1 ? '' : 's'} failed (see errors), so the cursor did not move` : '';
  return `Pulled ${what} from ${source.label}${failed}.`;
}

/**
 * Pull one source for one account. `context` is what run-an-export hands over (`door`) plus, for tests, `token`, `fetch`,
 * `wait` and `now`.
 */
export async function pullFromAnAccount(sourceId, input, context = {}) {
  const source = loadSource(sourceId);
  const settings = settingsOf(source, input);
  const answer = (fields) => { const result = { source: sourceId, account: settings.account, self_id: null, threads: 0, items: 0, new_messages: 0, new_items: 0, cursor: null, errors: [], ...fields }; return { ...result, said: wordsFor(source, result) }; };
  const token = 'token' in context ? context.token : readToken();
  if (!token) return answer({ status: 'needs_login' });
  const get = makeHttp(source, token, context);

  const who = await get(source.identity.path, source.identity.query);
  const selfId = who.body === undefined ? undefined : evaluate(source.identity.self_id, { item: who.body });
  if (selfId === undefined) {
    // A token the service refuses (or one that names nobody) needs a new login; a service that did not answer does not.
    const refused = who.error ? who.refused : true;
    return answer({ status: refused ? 'needs_login' : 'unreachable', errors: who.error ? [who.error] : [] });
  }

  const door = context.door;
  const held = await readParts(door, sourceId, settings.account);
  const prior = held.state?.cursor ?? source.cursor?.start ?? null;
  const errors = [];
  const writes = [];
  let seq = [...held.threads.values(), ...[...held.items.values()].flatMap(items => [...items.values()])].reduce((most, value) => Math.max(most, value.seq), 0);
  const threadIds = new Set(held.threads.keys());
  const itemKeys = new Set([...held.items].flatMap(([collection, items]) => [...items.keys()].map(id => `${collection}\u0000${id}`)));
  let newMessages = 0;
  let newItems = 0;
  let cursor = prior;
  const gatheredAll = { raw: [], records: [] };

  for (const walk of source.walks) {
    const gathered = await runWalk(walk, { source, settings, cursor: prior, selfId, get, held, errors });
    gatheredAll.raw.push(...gathered.raw);
    gatheredAll.records.push(...gathered.records);
    if (walk.fold.layout === 'threads') {
      for (const [id, thread] of gathered.threads) {
        const before = held.threads.get(id);
        const folded = foldItems(before?.thread.messages ?? [], thread.records, walk.fold);
        const next = { ...(before?.thread ?? {}), id, title: thread.title ?? before?.thread.title ?? id, messages: folded.items };
        if (thread.source !== undefined) next.source = thread.source;
        newMessages += folded.added;
        if (!before && !folded.items.length) continue;
        if (!before || JSON.stringify(before.thread) !== JSON.stringify(next)) {
          writes.push({ id: threadId(sourceId, settings.account, id), type: PART_KIND, value: { kind: 'thread', seq: before?.seq ?? (seq += 1), thread: next } });
          threadIds.add(id);
        }
      }
    } else {
      const holding = held.items.get(walk.fold.into) ?? new Map();
      const heldList = [...holding.values()].sort((a, b) => a.seq - b.seq).map(value => value.item);
      const folded = foldItems(heldList, gathered.items, walk.fold);
      for (const item of folded.items) {
        const id = identityOf(item, walk.fold);
        const before = holding.get(id);
        if (before && JSON.stringify(before.item) === JSON.stringify(item)) continue;
        if (!before) newItems += 1;
        itemKeys.add(`${walk.fold.into}\u0000${id}`);
        writes.push({ id: itemId(sourceId, settings.account, walk.fold.into, id), type: PART_KIND, value: { kind: 'item', seq: before?.seq ?? (seq += 1), collection: walk.fold.into, identity: id, item } });
      }
    }
  }
  if (source.cursor && !errors.length) cursor = advanced(source.cursor.advance, prior, gatheredAll);

  const state = { kind: 'state', source: sourceId, account: settings.account, self_id: selfId, cursor, pulled_at: (context.now ?? (() => new Date().toISOString()))() };
  for (let from = 0; from < writes.length; from += WRITE_CHUNK) await door.write(writes.slice(from, from + WRITE_CHUNK));
  await door.write([{ id: stateId(sourceId, settings.account), type: PART_KIND, value: state }]);

  return answer({
    status: errors.length ? 'partial' : 'pulled',
    self_id: selfId,
    threads: threadIds.size,
    items: itemKeys.size,
    new_messages: newMessages,
    new_items: newItems,
    cursor,
    errors,
  });
}

// One export per source, so a row names the source it pulls and nothing else.
export const pullDiscord = (input, context) => pullFromAnAccount('discord', input, context);
export const pullSlack = (input, context) => pullFromAnAccount('slack', input, context);
export const pullTelegram = (input, context) => pullFromAnAccount('telegram', input, context);
export const pullInstagramMessages = (input, context) => pullFromAnAccount('instagram-messages', input, context);
export const pullMessengerMessages = (input, context) => pullFromAnAccount('messenger-messages', input, context);
export const pullXBookmarks = (input, context) => pullFromAnAccount('x-bookmarks', input, context);
export const pullPinterestPins = (input, context) => pullFromAnAccount('pinterest-pins', input, context);
