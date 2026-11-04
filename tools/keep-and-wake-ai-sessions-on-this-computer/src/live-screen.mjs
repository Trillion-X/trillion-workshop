// A person's own screen stays current while it is open. Every write to their store (a decision saved, an answer, a
// payment, a connection) advances one number, the screen revision, and every open screen is told the new number over
// a WebSocket the store holds (Durable Object hibernation, so an idle screen costs nothing). The screen then reads
// itself again and repaints in place. The page the Worker served carries the revision it read before any of its
// answers (first-answers.json screen_revision), so the socket's first revision reloads no screen when nothing changed
// since, and a change that lands between drawing and listening is not missed.
//
// Invariants:
// - The revision advances only when the store's SQLite reports rows changed (`total_changes()`), checked once per
//   turn after any statement that is not a read, so a read never repaints anyone and a burst of writes is one change.
// - A change the person sees that is kept elsewhere (a space they are in, src/spaces.mjs) advances the same
//   revision through `changedElsewhere`, in the same turn-batched way, so the screen has one channel for every change.
// - The revision's own write goes through the unwatched handle, so recording a change is not itself a change. What is
//   written is a ceiling a block above the revision given out, so a busy screen writes one row per block, not per turn.
// - A write only some reads show (`changedFor(reads, run)`: how a device stands, shown on the catch-up screen) moves no
//   revision: its rows count as seen, and every open screen is told the reads it changed (`{ changed: [read] }`, turn-
//   batched), so only a screen drawn from one of them reads itself again and every other screen, kept copy and copy
//   kept at the edge by revision stays as it was (2026-10-05: each open wrote how the device stood, moving the revision
//   about three times, and every open screen of every device read everything again each time).
// - Every message can name heads (`heads(name, read)`): `{ revision, heads: { told: 812, records: 90211 } }` says the
//   newest notice is 812 and the last record written 90211, so a device that keeps the last one it saw reads (its
//   notices, its copy's settle) only when that moved (2026-10-07: 4.5 revisions a second on the busiest account, and
//   the Mac app read its notices on each). A narrow change (`{ changed, heads }`) carries them too.
// - A socket belongs to the store it was opened on, and the Worker opens it only for the signed-in person, from this
//   service's own pages (src/worker.mjs /work/live).
// - The stream route (src/agent-delivery.mjs): a helper on the person's computer opens the same socket through
//   /mcp/api/live naming the agents it hosts. Its socket is tagged per agent, is sent each of their events, never
//   screen revisions, and counts as listening only while its pings (answered without waking the store) are fresh.
// - Every socket carries the sign-in that opened it ({ id, issued_at, browser_generation }, named by the Worker, never
//   by the caller). Taking a sign-in back ends what it already opened: `endSockets(refused)` closes every socket whose
//   sign-in the store no longer accepts, so each way of taking access back (disconnect everything, one browser, one key,
//   one app, a password change) is one call over the same test, and a socket with no sign-in on it is closed (fail closed).
// - A revision can name what changed (`describe(describer)`, src/live-keys.mjs): `{ revision, writes: { at, version,
//   records: [{ id, fields }] } }`, ids and field ids only, never values, so a page reads again only the screens a change
//   touches (src/record-depends.mjs). The describer is asked once per revision whether or not a screen is open, so what
//   it names is always the changes since the revision before. A revision moved by a change kept elsewhere names nothing
//   (every screen reads again), and so does one the describer cannot name in full.

import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import resumeRules from './live-resume.json' with { type: 'json' };
import { sqlMayChangeRows } from './sql-writes.mjs';
import { answerRequest, helloFrame, windowFrames } from './live-protocol.mjs';
import { SQL_STATEMENT_EXECUTION, sqlStatementExecutionWitness, beginSqlStatement, refuseSqlStatementBeforeExecution, sqlStatementWasNotExecuted } from '../../sql-statement-execution.mjs';

const TAG = 'screen';
const agentTag = agent_id => `agent:${agent_id}`;
// A helper pings every 30 seconds; a socket silent for longer than this is not listening (src/agent-delivery.mjs).
const STREAM_FRESH_MS = 90_000;
// The close code a socket gets when the sign-in that opened it is taken back (4000-4999 are the application's own).
export const SIGN_IN_ENDED = 4401;
/** Where a reconnecting page says it left off ({ epoch, after }, src/live-resume.json), or null for a first connection. */
export function resumeOf(searchParams) {
  const epoch = searchParams?.get?.(resumeRules.query.epoch);
  const after = Number(searchParams?.get?.(resumeRules.query.after));
  return epoch && Number.isInteger(after) && after >= 0 ? { epoch: epoch.slice(0, 64), after } : null;
}
// The Worker names the sign-in a socket is opened with on its request to the store; a caller's own header is replaced.
const SIGN_IN_HEADER = 'x-trillion-socket-sign-in';
/** The store's request to open a socket, carrying the sign-in ({ id, issued_at, browser_generation? }) that asked. */
export function socketRequest(url, request, signIn) {
  const opened = new Request(url, request);
  opened.headers.set(SIGN_IN_HEADER, JSON.stringify(signIn));
  return opened;
}
/** The sign-in a socket request carries, or null when it names none a store can check. */
export function signInOfSocket(request) {
  try {
    const signIn = JSON.parse(request.headers.get(SIGN_IN_HEADER) ?? 'null');
    if (!signIn || typeof signIn.id !== 'string' || !signIn.id || typeof signIn.issued_at !== 'string') return null;
    return { id: signIn.id, issued_at: signIn.issued_at, ...(Number.isInteger(signIn.browser_generation) ? { browser_generation: signIn.browser_generation } : {}) };
  } catch { return null; }
}
// Every statement's billed rows (the cursor's final rowsRead/rowsWritten) are added to its template's running total, and
// each minute or bounded statement window, the costliest templates are logged by fingerprint with statement counts: a
// store's cost is mostly many small statements a minute, which a per-statement threshold never sees (2026-10-04: 3.5
// billion rows read an hour with no single statement over 20 000). Templates are ranked by what they are billed: a row
// written costs what a thousand rows read cost, so 18 000 history rows deleted a minute outrank a million rows read
// (2026-10-05: the writes that were most of the bill never reached the top eight when reads and writes counted alike).
const SQL_COST_WINDOW_MS = 60_000;
// Workers' clocks need not advance during synchronous SQL. Bound a diagnostic
// window by new statements too, so a CPU reset does not erase all attribution.
const SQL_COST_WINDOW_STATEMENTS = 4_096;
const SQL_COST_READS_PER_WRITE = 1_000;
const SQL_COST_WINDOW_ROWS = 100_000;
const SQL_COST_TOP = 8;
const billed = row => row.rows_read + SQL_COST_READS_PER_WRITE * row.rows_written;
const SQL_COST_CALLER_EVERY = 64;
// A template is asked which code ran it only once its billed rows in the window reach this: reading the stack is the
// costly part of watching, and a cheap template never shows in a report (2026-10-06 profile: 10% of a store's CPU).
const SQL_COST_CALLER_FROM = 1_000;
const SQL_COST_CALLERS = 4;
// Deep enough to reach past the store's own write and transaction wrappers (about ten frames) to the code that wrote.
const SQL_COST_CALLER_DEPTH = 24;
// The named functions that ran a statement, nearest first ("current < read < placeMessage"): every frame up to the cursor
// wrapper's own is dropped by the wrappers' runtime names (the deployed bundle renames functions, so names are compared
// as the running code has them), and anonymous frames are left out; every named frame after them is kept as it is.
// The stack is read as structured frames, never formatted with each frame's file: a file name can be very long (a test
// loads the bundle from a data: address, and 32 frames of it once overflowed the longest string a stack may be).
const frameName = frame => {
  const name = frame.getFunctionName() ?? frame.getMethodName();
  if (!name) return null;
  const type = frame.isToplevel() ? null : frame.getTypeName();
  return type && !name.startsWith(`${type}.`) ? `${type}.${name}` : name;
};
function callerFrames() {
  const { stackTraceLimit: limit, prepareStackTrace: prepare } = Error;
  Error.stackTraceLimit = 32;
  Error.prepareStackTrace = (_, frames) => frames.map(frameName);
  let stack;
  try { stack = new Error().stack; } finally { Error.stackTraceLimit = limit; Error.prepareStackTrace = prepare; }
  // A runtime that formats stacks its own way still answers text: its frame names are read from that.
  return Array.isArray(stack) ? stack.filter(Boolean) : [...String(stack ?? '').matchAll(/\n\s+at (?:async )?([^\s(]+) \(/g)].map(match => match[1]);
}
function callerChain() {
  const frames = callerFrames();
  const own = new Set([callerFrames.name, callerChain.name, observedCursor.name, watchedSql.name, reportCost.name]);
  const after = frames.slice(0, 8).findLastIndex(name => own.has(name));
  const names = [];
  // Past the wrappers a frame is never dropped for its name alone: the bundle gives short names that repeat (a
  // messages read calling the record store's read shows twice as Object.read), and dropping a repeat or a name like a
  // wrapper's hid which code ran a costly template.
  for (const name of frames.slice(after + 1)) {
    if (name.includes('<anonymous>') || name.startsWith('Test')) continue;
    names.push(name);
    if (names.length >= SQL_COST_CALLER_DEPTH) break;
  }
  return names.join(' < ');
}
const encode = new TextEncoder();

// A statement's shape locates its source without logging values, quoted names or number literals; a table numbered
// in its name (one table per written run of records) is one shape. The same statement text is worked out once (a
// bounded map, emptied when full): a store runs the same few hundred statements over and over.
const TEMPLATES_REMEMBERED = 2048;
const templatesOf = new Map();
export function sqlTemplateFingerprint(query) {
  const text = String(query);
  const known = templatesOf.get(text);
  if (known) return known;
  const fingerprint = templateFingerprint(text);
  if (templatesOf.size >= TEMPLATES_REMEMBERED) templatesOf.clear();
  templatesOf.set(text, fingerprint);
  return fingerprint;
}
function templateFingerprint(query) {
  const template = String(query).replace(/'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`/g, '?')
    .replace(/\b(?:0x[\da-f]+|\d+(?:\.\d+)?)\b/gi, '?').replace(/_\d+\b/g, '_?').replace(/\s+/g, ' ').trim().toLowerCase();
  return bytesToHex(blake3(encode.encode(template))).slice(0, 16);
}

export function sqlStatementShape(query) {
  return String(query).replace(/'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[(?:[^\]]|\]\])*\]|--[^\n]*|\/\*[\s\S]*?\*\//g, '?')
    .replace(/\b(?:0x[\da-f]+|\d+(?:\.\d+)?)\b/gi, '?').replace(/\s+/g, ' ').trim();
}
function reportSqlFailure(query, error) {
  const shape = sqlStatementShape(query);
  console.error('person store SQL failed', { query_template: sqlTemplateFingerprint(query), shape: shape.slice(0, 500), callers: callerChain(), reason: String(error?.message ?? error).slice(0, 300) });
}

// The running totals per template; `now` and `report` are given in tests.
export function sqlCostObserver(report = details => console.warn('person store SQL cost', details), now = () => Date.now()) {
  const counted = new WeakMap();
  let totals = new Map();
  let windowStatements = 0;
  let windowBilled = 0;
  let windowStarted = now();
  const flush = at => {
    const rows = [...totals.values()];
    const read = rows.reduce((sum, row) => sum + row.rows_read, 0);
    const written = rows.reduce((sum, row) => sum + row.rows_written, 0);
    if (read + SQL_COST_READS_PER_WRITE * written >= SQL_COST_WINDOW_ROWS) {
      const top = rows.sort((a, b) => billed(b) - billed(a)).slice(0, SQL_COST_TOP);
      report({ seconds: Math.round((at - windowStarted) / 1000), rows_read: read, rows_written: written, statements: rows.reduce((sum, row) => sum + row.statements, 0), top });
    }
    totals = new Map();
    windowStatements = 0;
    windowBilled = 0;
    windowStarted = at;
  };
  return (query, cursor) => {
    if (!cursor || typeof cursor !== 'object') return;
    const before = counted.get(cursor);
    const rowsRead = Number(cursor.rowsRead) || 0;
    const rowsWritten = Number(cursor.rowsWritten) || 0;
    counted.set(cursor, { rowsRead, rowsWritten });
    const template = before?.template ?? sqlTemplateFingerprint(query);
    counted.get(cursor).template = template;
    const row = totals.get(template) ?? { query_template: template, operation: /^\s*(select|with|insert|update|delete|replace|create|drop|alter|pragma)\b/i.exec(query)?.[1]?.toLowerCase() ?? 'other', statements: 0, rows_read: 0, rows_written: 0, callers: {} };
    const billedBefore = billed(row);
    if (!before) { row.statements += 1; windowStatements += 1; }
    row.rows_read += rowsRead - (before?.rowsRead ?? 0);
    row.rows_written += rowsWritten - (before?.rowsWritten ?? 0);
    windowBilled += rowsRead - (before?.rowsRead ?? 0) + SQL_COST_READS_PER_WRITE * (rowsWritten - (before?.rowsWritten ?? 0));
    // Which code runs the template: the function names on the stack when its billed rows in the window first reach
    // SQL_COST_CALLER_FROM, and on every SQL_COST_CALLER_EVERY-th statement after, so one costly template reached from
    // several places shows each (names only, never values).
    const costly = billed(row) >= SQL_COST_CALLER_FROM;
    if (costly && (billedBefore < SQL_COST_CALLER_FROM || (!before && row.statements % SQL_COST_CALLER_EVERY === 0))) {
      const chain = callerChain();
      if (chain && (chain in row.callers || Object.keys(row.callers).length < SQL_COST_CALLERS)) row.callers[chain] = (row.callers[chain] ?? 0) + 1;
    }
    totals.set(template, row);
    const at = now();
    if (at - windowStarted >= SQL_COST_WINDOW_MS
      || (windowStatements >= SQL_COST_WINDOW_STATEMENTS && windowBilled >= SQL_COST_WINDOW_ROWS)) flush(at);
  };
}

// Named, so the caller chain starts past it whatever the bundle names it.
function reportCost(observeCost, query, cursor) { observeCost(query, cursor); }
function observedCursor(cursor, query, observeCost, beforeCursorRead = null) {
  if (!observeCost) return cursor;
  const wrapIterator = iterator => new Proxy(iterator, {
    get(target, key) {
      if ((key === 'next' || key === 'toArray') && typeof target[key] === 'function') return (...args) => {
        beforeCursorRead?.(query, cursor);
        try { return target[key](...args); } catch (error) { reportSqlFailure(query, error); throw error; } finally { reportCost(observeCost, query, cursor); }
      };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  let proxy;
  proxy = new Proxy(cursor, {
    get(target, key) {
      if (key === Symbol.iterator) return () => (typeof target.next === 'function' ? proxy : wrapIterator(target[Symbol.iterator]()));
      // Only methods the cursor has are wrapped: a caller asking whether one exists gets the true answer.
      if (key === 'raw' && typeof target.raw === 'function') return () => wrapIterator(target.raw());
      if ((key === 'next' || key === 'toArray' || key === 'one') && typeof target[key] === 'function') return (...args) => {
        beforeCursorRead?.(query, cursor);
        try { return target[key](...args); } catch (error) { reportSqlFailure(query, error); throw error; } finally { reportCost(observeCost, query, cursor); }
      };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  reportCost(observeCost, query, cursor); // A write without RETURNING has completed when exec returns.
  return proxy;
}

// The store's SQL handle, telling `noticeWrite` after every statement that may have written, and `writes`
// (src/sql-writes.mjs) which table it wrote.
export function watchedSql(sql, noticeWrite, observeCost = null, writes = null, beforeStatement = null, runWrite = null, beforeCursorRead = null) {
  const handle = new Proxy(sql, {
    get(target, key) {
      if (key === SQL_STATEMENT_EXECUTION) return sqlStatementExecutionWitness(handle);
      if (key === 'exec') {
        return (query, ...bindings) => {
          beginSqlStatement(handle);
          const execute = () => {
            try { beforeStatement?.(query); }
            catch (error) { refuseSqlStatementBeforeExecution(handle, error); throw error; }
            let cursor;
            try { cursor = target.exec(query, ...bindings); }
            catch (error) {
              // A nested watched handle can also refuse before reaching physical SQL.
              if (sqlStatementWasNotExecuted(target, error)) refuseSqlStatementBeforeExecution(handle, error);
              throw error;
            }
            writes?.note(query);
            if (!/^\s*(select|with|pragma)\b/i.test(query)) noticeWrite();
            return observedCursor(cursor, query, observeCost, beforeCursorRead);
          };
          return runWrite && sqlMayChangeRows(query) ? runWrite(execute) : execute();
        };
      }
      const value = Reflect.get(target, key, target);
      // A frozen own method must be returned unchanged by a Proxy (ES invariant); the native SQL
      // presentation installs its rebuild owner this way. Its closure already has the right receiver.
      const own = Reflect.getOwnPropertyDescriptor(target, key);
      if (own && !own.configurable && !own.writable && 'value' in own) return value;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return handle;
}

// How far ahead of the revision given out the written ceiling is raised: one row written per this many revisions.
const REVISIONS_PER_WRITE = 1024;
const revisionTable = sql => sql.exec('CREATE TABLE IF NOT EXISTS screen_revision (id INTEGER PRIMARY KEY CHECK (id = 1), revision INTEGER NOT NULL)');

export function liveScreen(ctx, sql, { changesSql = sql, deliver = null, attachment = null, schedule = null, boot = undefined } = {}) {
  const later=work=>schedule?schedule(work):queueMicrotask(work);
  revisionTable(sql);
  // Bookkeeping reads must not run a cost observer that persists more neutral rows while measuring them.
  // The count as last read, kept until anything may have written since: a counted write (noticeWrite) or a neutral one.
  // Back-to-back neutral writes share it, so each costs one read, not two.
  // Only within one turn: what another handle writes between turns is never taken for a neutral write's.
  let knownTotal = null, forgetting = false;
  const totalChanges = () => {
    knownTotal = changesSql.exec('SELECT total_changes() AS n').one().n;
    if (!forgetting) { forgetting = true; queueMicrotask(() => { forgetting = false; knownTotal = null; }); }
    return knownTotal;
  };
  // What is written is a ceiling, never the revision itself: every revision this instance gives out is at or below it,
  // and a new instance starts one past it, so a revision is never given out twice even when changes went unwritten.
  // The ceiling is written only when someone can see a revision above it (an open screen, or a page given it in its
  // first answers), then raised a block ahead: a store with screens open gave out a revision on every write turn and
  // wrote each one, about 530 rows a minute on the busiest account (2026-10-07, 12% of its rows written); now one row
  // per block.
  // Include observer persistence from all construction reads before the live owner is assigned.
  let ceiling = sql.exec('SELECT revision FROM screen_revision WHERE id = 1').toArray()[0]?.revision ?? 0;
  let seen = totalChanges();
  // Nested handles/scopes may already account for some of this delta. Absorb only the remainder, including on
  // throw/rollback, while preserving genuine writes pending before the scope. SQLite counts rolled-back writes.
  let quietDepth = 0;
  // A counted write waiting to be told (pending, or held by coalesce) has rows of its own beside a neutral write's, so
  // only then must a neutral scope count its own rows exactly. Otherwise every row written since `seen` is neutral (a
  // counted write tells noticeWrite in the same statement), and they are counted seen once, at the end of the turn:
  // a neutral write cost two total_changes() reads each (2026-10-15: 389 of one account deletion's 1,080 statements).
  let neutralUnseen = false;
  const seeNeutralLater = () => {
    if (neutralUnseen) return;
    neutralUnseen = true;
    later(() => { neutralUnseen = false; if (!pending && !deferred && !elsewhere) seen = knownTotal ?? totalChanges(); });
  };
  const quietly = (run, changed = null) => {
    // Synchronous nested scopes are already wholly neutral to their outer owner. Scoped notifications need their
    // own delta, and reuse the same two raw reads rather than adding a second pair around neutral reconciliation.
    const outer = !quietDepth;
    if (!outer && !changed) return run();
    if (outer && !changed && !pending && !deferred && !elsewhere) {
      quietDepth += 1;
      // Nothing was waiting on entry, so a write this scope told (pending now) is one of its own neutral rows: count every
      // row seen at once, and the settle it scheduled finds nothing new unless a counted write follows.
      try { return run(); } finally { quietDepth -= 1; knownTotal = null; if (pending || deferred || elsewhere) seen = totalChanges(); else seeNeutralLater(); }
    }
    const before = knownTotal ?? totalChanges();
    // Neutral rows the fast path left to the end of the turn, with nothing counted waiting: they are seen as of now.
    if (outer && neutralUnseen && !pending && !deferred && !elsewhere) seen = before;
    const countedBefore = seen;
    quietDepth += 1;
    let succeeded = false;
    try { const result = run(); succeeded = true; return result; }
    finally {
      quietDepth -= 1;
      const delta = totalChanges() - before;
      if (outer) seen += delta - (seen - countedBefore);
      if (succeeded && delta) changed?.();
    }
  };
  let revision = ceiling + 1;
  // Its own write counts as seen, so keeping the ceiling never moves the revision.
  const keep = () => {
    if (revision <= ceiling) return;
    quietly(() => {
      ceiling = revision + REVISIONS_PER_WRITE;
      sql.exec('INSERT INTO screen_revision (id, revision) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET revision = excluded.revision', ceiling);
    });
  };
  let pending = false;
  let elsewhere = false;
  let coalescing = 0;
  let deferred = false;
  const listeners = [];
  // The reads written to this turn by `changedFor`, told to every open screen at the end of the turn.
  const narrow = new Set();
  // The reads nudged this turn (`nudge`), told to every open socket at the end of the turn in one frame.
  const nudged = new Set();
  // A helper's ping is answered by the platform itself, so an idle stream never wakes this store.
  if (typeof WebSocketRequestResponsePair !== 'undefined') ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));

  // What each revision also names (`heads(name, read)`): the newest seq of a list a device reads after a cursor of its
  // own, so a device whose cursor is already there reads nothing (src/kept-list.mjs invariant 5). Read once per message.
  const headReads = new Map();
  // The newest number of each scope that numbers its notices (`counters(name, read)`): a page that sees a number past
  // the next one it expected has a hole, and asks once to fill it (src/live-protocol.mjs createCounters).
  const counterReads = new Map();
  const readAll = (reads, what) => {
    const out = {};
    for (const [name, read] of reads) { try { const value = read(); if (value !== null && value !== undefined) out[name] = value; } catch (error) { console.warn(what, name, String(error?.message ?? error)); } }
    return out;
  };
  const withHeads = frame => {
    if (!headReads.size && !counterReads.size) return JSON.stringify(frame);
    return JSON.stringify({ ...frame, ...(headReads.size ? { heads: readAll(headReads, 'revision head') } : {}), ...(counterReads.size ? { counters: readAll(counterReads, 'revision counter') } : {}) });
  };
  // What names the changes of each revision (`describe`), and its answer read without letting a failure stop a revision.
  let describer = null;
  const describeSafely = () => { try { return describer(); } catch (error) { console.warn('revision writes', String(error?.message ?? error)); return null; } };
  // Narrow frames are numbered and the last few kept, so a socket that reconnects is sent what it missed (src/live-resume.json).
  // This store's epoch changes whenever it starts afresh (it hibernates or restarts): a page that sees a new one knows
  // the subscriptions it held here are gone and asks again, and cannot resume from a number of another epoch. Each socket's subscription set lives only here, in memory.
  const epoch = crypto.randomUUID();
  let seq = 0;
  const recent = [];
  const stamped = frame => {
    seq += 1;
    const numbered = { ...frame, seq, epoch };
    recent.push({ seq, frame: numbered });
    if (recent.length > resumeRules.most_frames_replayed) recent.shift();
    return numbered;
  };
  const message = () => withHeads({ revision, epoch, seq });
  const socketState = new WeakMap();
  const catchUps = new Map();
  // The windowed lists this store offers, the second messages sent after the first frame, and what a page is told after each change.
  const windowLists = new Map();
  const supplementals = new Map();
  const readWindow = (list, from, to) => windowLists.get(list)?.(from, to) ?? null;
  const tellWindows = sockets => {
    if (!windowLists.size) return;
    for (const socket of sockets) {
      const state = socketState.get(socket);
      if (!state?.windows) continue;
      try { for (const frame of windowFrames(state, readWindow)) send(socket, JSON.stringify({ ops: frame })); } catch (error) { console.warn('window ops', String(error?.message ?? error)); }
    }
  };
  const send = (socket, text) => { try {
    if (deliver) deliver(socket, text); else socket.send(text);
  } catch { /* a socket closing as we send */ } };
  const tell = socket => {
    // Supplied delivery reads current revision/heads within its own admission;
    // opening the carrier must not execute owner SQL outside that invocation.
    if(deliver){send(socket,JSON.stringify({revision:0,epoch,seq}));return;}
    // The first frame also carries the hello (src/live-protocol.mjs): this store's epoch and any boot instruction.
    keep(); send(socket, withHeads({ revision, epoch, seq, hello: helloFrame({ epoch, ...(boot ? { boot } : {}) }) }));
    // The second messages: what a page can draw once it has the first, each read after the first frame has gone out.
    for (const [name, read] of supplementals) ctx.waitUntil?.(Promise.resolve().then(read).then(value => { if (value) send(socket, JSON.stringify({ supplemental: { name, ...value } })); }, error => console.warn('supplemental', name, String(error?.message ?? error))));
  };
  // A page that reconnects is sent the narrow frames it missed, or told once to read everything again when they are gone.
  const catchUp = (socket, given) => {
    if (!given) return;
    const held = given.epoch === epoch && given.after <= seq && (given.after === seq || (recent.length > 0 && recent[0].seq <= given.after + 1));
    if (!held) { send(socket, JSON.stringify({ reset: true, epoch, seq })); return; }
    for (const kept of recent) if (kept.seq > given.after) send(socket, withHeads(kept.frame));
  };
  function settle() {
    pending = false;
    if (coalescing) { deferred = true; return; }
    const total = totalChanges();
    if (!elsewhere && total === seen) return;
    const fromElsewhere = elsewhere;
    elsewhere = false;
    revision += 1;
    seen = total;
    const writes = describer ? describeSafely() : null;
    const sockets = ctx.getWebSockets(TAG);
    if (sockets.length) { keep(); const text = withHeads({ revision, ...(writes && !fromElsewhere ? { writes } : {}) }); for (const socket of sockets) send(socket, text); tellWindows(sockets); }
    const failedListener = error => console.warn('revision listener', String(error?.message ?? error));
    for (const listener of listeners) {
      try {
        const heard = listener(revision);
        // Admission may await a saved policy or capacity recovery. Keep that
        // continuation alive without delaying screens or sibling listeners.
        if (heard instanceof Promise) ctx.waitUntil?.(heard.catch(failedListener));
      } catch (error) { failedListener(error); }
    }
  }

  return {
    revision: () => { if(schedule&&pending)settle();keep(); return revision; },
    // Names a head every revision carries: `read()` answers the newest seq of something a device reads after its own
    // cursor (null leaves it out). A device that has seen that seq skips its read.
    heads(name, read) { headReads.set(name, read); },
    counters(name, read) { counterReads.set(name, read); },
    // Names what each revision changed (src/live-keys.mjs recordChangeDescriber): asked once now, so the first revision
    // after it names only what changed since, then once per revision.
    describe(describe) { describer = describe; describeSafely(); },
    // Names a scope whose notices are numbered 1, 2, 3: `read(after)` answers { through, items } of what it holds after
    // that number, so a page that finds a hole asks once (the `catch_up` request) instead of reading everything again.
    catchUp(scope, read) { catchUps.set(scope, read); },
    // Offers a windowed list: `read(from, to)` answers { rows, total, read } or null. A page asks with a `window` request
    // and is then sent the ops after every change (src/live-protocol.mjs windowFrames).
    windows(list, read) { windowLists.set(list, read); },
    // A second message sent to each page after its first frame: `read()` answers { ...fields } (sent as `supplemental`
    // with `name`) or nothing.
    supplemental(name, read) { supplementals.set(name, read); },
    // Tells every open screen a kind of state is stale ({ kind, id?, version }): no revision moves, and the page reads
    // that kind again only when the version differs from the one it holds (src/live-protocol.mjs createDirty).
    dirty(notice) {
      const text = JSON.stringify({ dirty: notice });
      for (const socket of ctx.getWebSockets(TAG)) send(socket, text);
    },
    // A typed badge event ({ event, amount }): no revision moves; the page moves the count the event names (new-work.json badge_events).
    badge(event) {
      const text = JSON.stringify({ badge: event });
      for (const socket of ctx.getWebSockets(TAG)) send(socket, text);
    },
    // A request frame a page sent ({ id, type, ... }): answered with { reply_to, ... } (src/live-protocol.mjs answerRequest).
    request(socket, text) {
      if (typeof text !== 'string') return;
      let state = socketState.get(socket);
      if (!state) socketState.set(socket, state = { subscribed: [] });
      const reply = answerRequest(text, state, { epoch, providers: { catch_up: (scope, after) => catchUps.get(scope)?.(after), window: readWindow } });
      if (reply) send(socket, JSON.stringify(reply));
    },
    // Something beside the open screens that hears each new revision (the person's store's search follower notice).
    onRevision(listener) { listeners.push(listener); },
    noticeWrite() {
      knownTotal = null;
      if(schedule&&quietDepth)return;
      if (pending) return;
      pending = true;
      later(settle);
    },
    // Holds revisions while one logical operation crosses synchronous and asynchronous owners. Scoped reads still
    // send their narrow change frame; all remaining writes publish together when the operation finishes.
    async coalesce(run) {
      coalescing += 1;
      try { return await run(); }
      finally {
        coalescing -= 1;
        if (!coalescing && deferred) { deferred = false; this.noticeWrite(); }
      }
    },
    // Runs a synchronous write no screen draws until a later write finishes it (an upload's chunks and spans, whose
    // finish is itself a change): its rows count as already seen, so a stream of them never makes every open screen
    // read itself again. A write made elsewhere in the same turn still changes the revision.
    quietly,
    // Runs a synchronous write that only the reads named show: no revision moves, and every open screen is told
    // which reads changed, so only the screens drawn from them read again. Nothing is told when no row changed.
    changedFor(reads, run) {
      return quietly(run, () => {
        if (!reads.length) return;
        if (!narrow.size) later(() => {
          const reads = [...narrow];
          narrow.clear();
          // Numbered and kept even when nobody listens: a page that is reconnecting is exactly the one that missed it.
          const frame = stamped({ changed: reads });
          const sockets = ctx.getWebSockets(TAG);
          if (!sockets.length) return;
          const text = withHeads(frame);
          for (const socket of sockets) send(socket, text);
          tellWindows(sockets);
        });
        for (const read of reads) narrow.add(read);
      });
    },
    // Tells every open screen socket that a read changed, with no write and no revision. A helper on the account's live
    // connection without an agent name (the device tools host) hears it there and takes work from it (src/agents.mjs,
    // in-memory asks). Screens read again only what they draw, so an unknown read costs them nothing. Several nudges in
    // one turn go out as one frame.
    nudge(read) {
      if (!nudged.size) later(() => {
        const reads = [...nudged];
        nudged.clear();
        const frame = stamped({ changed: reads });
        const sockets = ctx.getWebSockets(TAG);
        if (!sockets.length) return;
        const text = withHeads(frame);
        for (const socket of sockets) send(socket, text);
        tellWindows(sockets);
      });
      nudged.add(read);
    },
    // The store deleted everything (PersonStore.deleteEverything): the revision is kept in a table made again.
    madeAgain() {
      knownTotal = null;
      revisionTable(sql);
      seen = totalChanges();
      ceiling = sql.exec('SELECT revision FROM screen_revision WHERE id = 1').toArray()[0]?.revision ?? 0;
      revision = ceiling + 1;
      pending = false;
      elsewhere = false;
      deferred = false;
      narrow.clear();
    },
    // Something this person sees changed outside their store: their open screens read themselves again all the same.
    changedElsewhere() {
      elsewhere = true;
      this.noticeWrite();
    },
    // The store's end of a screen's socket: it hears the current revision at once, then every change.
    open(signIn, resume = null) {
      const [screen, store] = Object.values(new WebSocketPair());
      ctx.acceptWebSocket(store, [TAG]);
      store.serializeAttachment({ opened_at: Date.now(), sign_in: signIn ?? null, ...(attachment?.() ?? {}) });
      tell(store);
      catchUp(store, resume);
      return new Response(null, { status: 101, webSocket: screen });
    },
    // The store's end of a helper's stream for the agents it hosts: it hears which agents it carries, then their events.
    openStream(agentIds, signIn) {
      const [helper, store] = Object.values(new WebSocketPair());
      ctx.acceptWebSocket(store, agentIds.map(agentTag));
      store.serializeAttachment({ opened_at: Date.now(), sign_in: signIn ?? null, ...(attachment?.() ?? {}) });
      send(store, JSON.stringify({ hosted: agentIds }));
      return new Response(null, { status: 101, webSocket: helper });
    },
    // Sends one value down every stream holding this agent; true when at least one took it.
    sendTo(agent_id, value) {
      let sent = false;
      for (const socket of ctx.getWebSockets(agentTag(agent_id))) { try { send(socket, JSON.stringify(value)); sent = true; } catch { /* a socket closing as we send */ } }
      return sent;
    },
    // Closes every open socket whose sign-in `refused(signIn)` says is taken back (a socket without one is closed too);
    // the number closed. Nothing more is sent down a closed socket, and a helper reconnecting is refused by the Worker.
    endSockets(refused) {
      let ended = 0;
      for (const socket of ctx.getWebSockets()) {
        const signIn = socket.deserializeAttachment?.()?.sign_in ?? null;
        if (signIn && !refused(signIn)) continue;
        try { socket.close(SIGN_IN_ENDED, 'This sign-in was disconnected. Sign in again.'); } catch { /* already closed */ }
        ended += 1;
      }
      return ended;
    },
    // Whether a stream for this agent answered a ping (or opened) within the last STREAM_FRESH_MS.
    listening(agent_id, nowMs = Date.now()) {
      return ctx.getWebSockets(agentTag(agent_id)).some(socket => {
        const pinged = ctx.getWebSocketAutoResponseTimestamp?.(socket)?.getTime() ?? 0;
        const opened = socket.deserializeAttachment?.()?.opened_at ?? 0;
        return nowMs - Math.max(pinged, opened) <= STREAM_FRESH_MS;
      });
    },
  };
}
