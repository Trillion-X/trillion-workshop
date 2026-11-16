// Source-first port; configuration is supplied by authenticated list rows.
import { makeHashCodeHexFromBytes, makeKeyedHashHexFromBytes } from 'trillion-workshop/tools/content-identity/read-data/identity.mjs';
const bytesFromHex = hex => Uint8Array.from(hex.match(/../g), byte => Number.parseInt(byte, 16));
import { classOf, sends } from 'trillion-workshop/tools/gate-telemetry-by-privacy/read-data/telemetry-gate.mjs';

export function createInteractions(settings, consent) {
// src/interactions.mjs
//
// PURPOSE
//   Every visit, click and use of Trillion, admitted and counted the same way wherever it happened (example.com, a
//   public page, the app in a browser, the Mac, the iPhone or the extension, an AI's tool call). A page sends batches
//   of self-describing events; this module checks each against its kind's row (records/interactions.json), keeps only
//   the facts that row names, fills the facts the Worker knows itself, and hands them to the interaction log
//   (src/interaction-log.mjs, its own store), never to a person's store. It also writes the page script, draws the
//   operator's Visitors screen answer from what the log read, and holds the visitor sketch.
//
// NON-NEGOTIABLE INVARIANTS
//   1. No kind, dimension, surface, step or path rule is named in code: each is a row of records/interactions.json.
//   2. A visitor is never kept. The address and browser are hashed under a random key made each day (the log's own),
//      and only the hash's bits reach the sketch; no address, cookie or id of a visitor is written anywhere.
//   3. A browser asking not to be tracked (Do Not Track, Global Privacy Control) is not counted: the script sends nothing
//      and the Worker drops what arrives with either header. Known robots are not counted.
//   4. A path keeps at most the parts its rule allows (a share code, a file name or a person's item never reaches a
//      count); a query keeps only the campaign facts the DATA names; a referrer keeps only its host.
//   5. A fact the Worker knows (where the page is, the device, the country, who is signed in) is never taken from the
//      page; a kind the page may not send (`from_page: false`) is refused from a page.
//   6. Every value is cut to `batch.value_chars`, every batch to `batch.most_events`, so no page can grow the log.
//   7. Every event passes the one telemetry gate (src/telemetry-gate.mjs) for its sink before it is counted: the privacy
//      class of the page or service it came from decides, and an unknown class sends nothing.
//   8. Error reports and usage counting are separate choices (src/interaction-consent.json purposes): a purpose the
//      browser withheld (its page storage or the collecting address's cookie, either one) is never counted, and a
//      purpose marked `anonymous` is kept without the account and without the visitor's day-only mark, whatever is chosen.
//

const INTERACTIONS = settings;
const INTERACTION_CONSENT = consent;
const KINDS = new Map(settings.kinds.map(kind => [kind.id, kind]));
const PURPOSES = new Map(consent.purposes.map(purpose => [purpose.id, purpose]));
const PURPOSE_OF_KIND = new Map(consent.purposes.flatMap(purpose => purpose.kinds.map(kind => [kind, purpose])));
/** Whether a kind's events are always kept without the account and the visitor's day-only mark. */
const anonymousKind = id => PURPOSE_OF_KIND.get(id)?.anonymous === true;

/** The purposes a browser withheld: the cookie of the collecting address (`cookieHeader`) and the page's own list
 *  (`fromPage`, the batch's `withheld_purposes`) together, either one enough; an id no purpose row names is ignored. */
function withheldPurposes(cookieHeader, fromPage = []) {
  const prefix = `${consent.cookie}=`;
  const cookie = text(cookieHeader).split(';').map(part => part.trim()).find(part => part.startsWith(prefix))?.slice(prefix.length) ?? '';
  let fromCookie = [];
  try { fromCookie = cookie ? JSON.parse(decodeURIComponent(cookie)) : []; } catch { fromCookie = []; }
  return new Set([...(Array.isArray(fromCookie) ? fromCookie : []), ...(Array.isArray(fromPage) ? fromPage : [])].filter(id => PURPOSES.has(id)));
}

/** The withheld set after one choice ({ purpose, allowed }); a purpose that is not a row, or allowed that is not a
 *  boolean, is refused with words from the DATA. */
function chooseConsent(withheld, { purpose, allowed } = {}) {
  if (!PURPOSES.has(purpose)) throw new Error(consent.words.unknown_purpose.replace('{purpose}', text(purpose) || '(none)').replace('{purposes}', [...PURPOSES.keys()].join(', ')));
  if (typeof allowed !== 'boolean') throw new Error(consent.words.allowed_not_boolean);
  const next = new Set(withheld);
  if (allowed) next.delete(purpose); else next.add(purpose);
  return next;
}

/** What the person chose, purpose by purpose, and the page storage keys to forget now that an identity-carrying
 *  purpose is withheld. */
const consentAnswer = withheld => ({
  purposes: consent.purposes.map(({ id, label, said, anonymous }) => ({ id, label, said, anonymous, allowed: !withheld.has(id) })),
  forget: consent.purposes.some(purpose => withheld.has(purpose.id) && !purpose.anonymous) ? consent.page_storage_keys : [],
});

/** The cookie that keeps the choice at the collecting address, readable on every page that sends to it. */
const consentCookie = withheld => `${consent.cookie}=${encodeURIComponent(JSON.stringify([...withheld].sort()))}; Max-Age=${consent.cookie_days * 86400}; Path=/; Secure; HttpOnly; SameSite=None`;
/** One kind's row of records/interactions.json, or undefined. */
const kindOf = id => KINDS.get(id);
const SKIP_AGENTS = new RegExp(settings.skip_agents, 'i');
const DEVICES = settings.devices.map(row => ({ id: row.id, agent: new RegExp(row.agent, 'i') }));
// The facts the Worker fills itself; a page's value for one of these is ignored.
const WORKER_FACTS = new Set(['surface', 'device', 'country', 'account']);
const text = value => (typeof value === 'string' ? value : typeof value === 'number' && Number.isFinite(value) ? String(value) : '');
const clip = value => text(value).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, settings.batch.value_chars);

/** The surface row a page's host belongs to: its exact hosts first, then the longest host suffix that matches. */
function surfaceOf(host) {
  const name = text(host).toLowerCase().replace(/:\d+$/, '');
  const exact = settings.surfaces.find(row => (row.hosts ?? []).includes(name));
  if (exact) return exact;
  return settings.surfaces
    .filter(row => typeof row.host_suffix === 'string' && name.endsWith(row.host_suffix))
    .sort((a, b) => b.host_suffix.length - a.host_suffix.length)[0] ?? null;
}

/** A path cut to what its rule keeps: the surface's own depth, or the first path rule whose prefix matches. */
function cutPath(path, surface) {
  const clean = text(path).split(/[?#]/)[0] || '/';
  const parts = clean.split('/').filter(Boolean);
  const rule = settings.path_rules.find(row => clean.startsWith(row.prefix));
  const keep = Number.isInteger(surface?.path_keep) ? surface.path_keep : rule ? rule.keep : parts.length;
  const kept = parts.slice(0, keep).map(part => decodeURIComponentSafe(part).slice(0, 60));
  return clip(`/${kept.join('/')}${parts.length > keep ? `/${settings.rest_word}` : ''}`);
}
function decodeURIComponentSafe(part) { try { return decodeURIComponent(part); } catch { return part; } }

/** A client failure or slow request keeps only declared route families, never a name or id after them. */
function clientHealthPath(path) {
  const parts = text(path).split(/[?#]/)[0].split('/').filter(Boolean);
  const first = `/${parts[0] ?? ''}`;
  if (!settings.client_health.path_groups.includes(first)) return '/other';
  if (first === '/work' && parts[1] === 'api' && settings.client_health.work_api_groups.includes(parts[2])) {
    return cutPath(path, { path_keep: 3 });
  }
  return cutPath(path, { path_keep: 1 });
}

/** The device class of a browser, from the first device row whose pattern matches. */
const deviceOf = agent => DEVICES.find(row => row.agent.test(text(agent)))?.id ?? '';
/** Whether a request comes from a robot the DATA names, or from no browser at all. */
const isRobot = agent => !text(agent) || SKIP_AGENTS.test(text(agent));
/** Whether the request asks not to be tracked. */
const asksNotToTrack = headers => headers.get('dnt') === '1' || headers.get('sec-gpc') === '1';

/** The host of a referrer address, or '' (none, unreadable, or the page's own host). */
function referrerHost(value, pageHost) {
  try {
    const host = new URL(text(value)).hostname.replace(/^www\./, '');
    return host && host !== text(pageHost).replace(/^www\./, '') ? clip(host) : '';
  } catch { return clip(text(value).replace(/^www\./, '')); }
}

/** The hour an event is counted in, as `YYYY-MM-DDTHH`. */
const hourOf = ms => new Date(ms).toISOString().slice(0, 13);

/**
 * One batch from a page, admitted: `body` is what the page sent ({ events: [...] , shell }), `seen` is what the Worker
 * knows ({ host, agent, country, account, now, declined }). → { events: [{ hour, surface, kind, dims }], refused,
 * withheld, declined } where `dims` holds only the facts the kind's row names, in the row's order, `withheld` counts the
 * events whose page's privacy class may not feed their sink (client health or page events), and `declined` the events
 * of a purpose the browser withheld (`seen.declined`, a Set from withheldPurposes). An anonymous purpose's event never
 * carries the account.
 */
function admitPageBatch(body, seen) {
  const surface = surfaceOf(seen.host);
  const rows = Array.isArray(body?.events) ? body.events.slice(0, settings.batch.most_events) : [];
  if (!surface) return { events: [], refused: rows.length, withheld: 0, declined: 0 };
  const events = [];
  let refused = (Array.isArray(body?.events) ? body.events.length : 0) - rows.length;
  let withheld = 0;
  let declined = 0;
  for (const row of rows) {
    const kind = KINDS.get(text(row?.kind));
    if (!kind || !kind.from_page) { refused += 1; continue; }
    if (seen.declined?.has(PURPOSE_OF_KIND.get(kind.id)?.id)) { declined += 1; continue; }
    if (!sends(classOf({ surface: surface.id, path: text(row.path) }), kind.fix_work ? 'client_health' : 'page_events')) { withheld += 1; continue; }
    const fromPage = {
      ...row,
      path: kind.fix_work ? clientHealthPath(row.path) : cutPath(row.path, surface),
      referrer: referrerHost(row.referrer, seen.host),
      to: row.to ? destination(row, seen.host) : '',
      shell: clip(body.shell) || settings.default_shell,
    };
    const admitted = countable(kind, surface, fromPage, { ...seen, account: surface.account && !anonymousKind(kind.id) ? seen.account : '' });
    if (admitted) events.push(admitted);
    else refused += 1;
  }
  return { events, refused, withheld, declined };
}

/** An event the Worker itself saw (a tool run, a checkout step), counted like a page's: `facts` by dimension. null when
 *  the privacy class of the surface it happened on may not feed server events (the telemetry gate). */
function serverEvent(kindId, facts, seen = {}) {
  const kind = KINDS.get(kindId);
  if (!kind) throw new Error(`No interaction kind ${kindId}.`);
  const surface = facts.surface ?? 'service';
  if (!sends(classOf({ surface, path: '/' }), 'server_events')) return null;
  const event = countable(kind, { id: surface }, facts, { country: '', ...seen, account: facts.account ?? seen.account ?? '' });
  if (!event) throw new Error(`Invalid facts for interaction kind ${kindId}.`);
  return event;
}

// Where a click went: its path cut by the destination's own rules, with the destination's host when it left the page's.
function destination(row, pageHost) {
  const host = text(row.to_host).toLowerCase() || text(pageHost);
  const path = cutPath(row.to, surfaceOf(host));
  return clip(host === text(pageHost).toLowerCase() ? path : `${host}${path}`);
}

function countable(kind, surface, from, seen) {
  const dims = {};
  for (const name of kind.dimensions) {
    const value = name === 'device' ? deviceOf(seen.agent) : WORKER_FACTS.has(name) ? clip(seen[name]) : clip(from[name]);
    // A client-health dimension is a closed vocabulary. An exception message, URL query, stack, user text or token
    // cannot be smuggled into the operator's log by calling the collector directly.
    if (value && (!kind.allowed_values?.[name] || kind.allowed_values[name].includes(value))) dims[name] = value;
  }
  if (kind.allowed_values && Object.keys(kind.allowed_values).some(name => !dims[name])) return null;
  return { hour: hourOf(seen.now ?? Date.now()), surface: surface.id, kind: kind.id, dims };
}

/** The one key an event is counted under: its hour, surface, kind and facts, facts in their row's order. */
const countKey = event => JSON.stringify([event.hour, event.surface, event.kind, JSON.stringify(event.dims)]);
/** Whether an event's kind counts its visitors. */
const countsVisitors = event => Boolean(KINDS.get(event.kind)?.visitors);

// The visitor sketch (HyperLogLog, 2^SKETCH_BITS registers): how many different visitors, never which. Physics: the
// registers are fixed by the estimator's error (about 3.2% at 1024), not by any DATA choice.
const SKETCH_BITS = 10;
const REGISTERS = 1 << SKETCH_BITS;
const emptySketch = () => new Uint8Array(REGISTERS);

/** Adds a visitor hash (at least 8 bytes) to a sketch in place. */
function sketchAdd(registers, hash) {
  let bits = 0n;
  for (let i = 0; i < 8; i += 1) bits = (bits << 8n) | BigInt(hash[i]);
  const index = Number(bits >> BigInt(64 - SKETCH_BITS));
  // The rank is one more than the count of leading zeros in the bits after the index bits.
  const restBits = 64 - SKETCH_BITS;
  const rest = bits & ((1n << BigInt(restBits)) - 1n);
  const rank = rest === 0n ? restBits + 1 : restBits - rest.toString(2).length + 1;
  if (rank > registers[index]) registers[index] = rank;
  return registers;
}

/** Merges `from` into `into` in place (the larger register wins), so two sketches count their visitors together. */
function sketchMerge(into, from) {
  for (let i = 0; i < REGISTERS; i += 1) if (from[i] > into[i]) into[i] = from[i];
  return into;
}

/** How many different visitors a sketch holds, estimated. */
function sketchCount(registers) {
  let sum = 0;
  let zeros = 0;
  for (let i = 0; i < REGISTERS; i += 1) { sum += 2 ** -registers[i]; if (registers[i] === 0) zeros += 1; }
  const alpha = 0.7213 / (1 + 1.079 / REGISTERS);
  const raw = alpha * REGISTERS * REGISTERS / sum;
  return Math.round(raw <= 2.5 * REGISTERS && zeros > 0 ? REGISTERS * Math.log(REGISTERS / zeros) : raw);
}

/** A visitor's hash under the day's key: their address and browser, never kept themselves. */
const visitorHash = (dayKey, address, agent) => bytesFromHex(makeKeyedHashHexFromBytes(dayKey, new TextEncoder().encode(`${text(address)}\n${text(agent)}`)));

/** Which log shard a visitor's events go to, so each visitor is counted in one shard and shards add up. */
function shardOf(address, agent, shards = settings.shards) {
  if (shards <= 1) return 0;
  return Number.parseInt(makeHashCodeHexFromBytes(new TextEncoder().encode(`${text(address)}\n${text(agent)}`)).slice(3, 5), 16) % shards;
}

/** The interaction log a shard is kept in. */
const interactionLog = (env, shard = 0) => env.interactionLog(shard);

/** Counts events the Worker itself saw (never awaited by what the person waits for; a failure is logged, not thrown).
 *  `visitor` ({ address, agent }) is who saw them, when a kind counts visitors (the visitor mark a price was shown to).
 *  An event the telemetry gate withheld (serverEvent's null) is not counted. */
async function noteInteractions(env, given, visitor = null) {
  const events = given.filter(Boolean);
  if (!env?.interactionLog || !events.length) return;
  try { await interactionLog(env, visitor ? shardOf(visitor.address, visitor.agent) : 0).keep({ events, visitor }); }
  catch (error) { console.error('interactions not counted:', String(error?.message ?? error)); }
}

/** The hours from `days` days ago (at most `most_read_days`) to this hour, as the log reads them. */
function readRange(days = settings.read_days, now = Date.now()) {
  const kept = Math.min(Math.max(1, Math.floor(days)), settings.most_read_days);
  return { since: `${new Date(now - (kept - 1) * 86_400_000).toISOString().slice(0, 10)}T00`, until: new Date(now).toISOString().slice(0, 13) };
}

/** Every shard read over `range`; [] where this service keeps no interaction log. */
const readInteractions = (env, range) => (env?.interactionLog
  ? Promise.all(Array.from({ length: Math.max(1, settings.shards) }, (_, shard) => interactionLog(env, shard).read(range)))
  : Promise.resolve([]));

/** Different visitors per value of `by` among a kind's visitor scopes matching `where` (facts), over every shard. */
function visitorsBy(reads, { kind, where = {}, by }) {
  const out = {};
  for (const read of reads) for (const row of read.visitors.scopes ?? []) {
    if (row.kind !== kind || !(by in row.scope) || !Object.entries(where).every(([fact, value]) => row.scope[fact] === value)) continue;
    out[row.scope[by]] = (out[row.scope[by]] ?? 0) + row.visitors;
  }
  return out;
}

/** How many events of a kind matching `where` (facts) per value of `by`, over every shard. */
function eventsBy(reads, { kind, where = {}, by }) {
  const out = {};
  for (const read of reads) for (const row of read.totals ?? []) {
    if (row.kind !== kind) continue;
    const dims = typeof row.dims === 'string' ? JSON.parse(row.dims) : row.dims ?? {};
    if (!(by in dims) || !Object.entries(where).every(([fact, value]) => dims[fact] === value)) continue;
    out[dims[by]] = (out[dims[by]] ?? 0) + Number(row.n);
  }
  return out;
}

/** The facts a funnel's `measures.interactions` rows ask for, from what the log read: each row ({ stage, kind, where,
 *  visitors, converted }) becomes one fact at its stage standing for `count` events or different visitors. */
function funnelFacts(reads, rows, stageField = 'stage') {
  const totals = reads.flatMap(read => read.totals.map(row => ({ ...row, dims: JSON.parse(row.dims) })));
  return rows.flatMap(row => {
    const where = row.where ?? {};
    const count = row.visitors
      ? reads.flatMap(read => read.visitors.scopes ?? []).filter(scope => scope.kind === row.kind && matches({ surface: scope.surface, dims: scope.scope }, where) && Object.keys(scope.scope).every(fact => fact in where)).reduce((n, scope) => n + scope.visitors, 0)
      : totals.filter(total => total.kind === row.kind && matches(total, where)).reduce((n, total) => n + Number(total.n), 0);
    return count ? [{ [stageField]: row.stage, count, ...(row.converted ? { converted: true } : {}), event: `interactions:${row.kind}` }] : [];
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// The page script: one function, sent with its settings, that runs on every page. It names no page: what is clickable,
// which facts a click keeps, the shells and the depths all come from the settings it is handed.

/* eslint-disable no-var */
function capturePage(config) {
  var w = window, d = document, n = navigator;
  if (w.__trillionInteractions) return;
  w.__trillionInteractions = true;
  if (n.doNotTrack === '1' || w.doNotTrack === '1' || n.globalPrivacyControl === true) return;
  var queue = [];
  var timer = null;
  var shell = config.default_shell;
  // The purposes this browser withheld (error reports and usage counting are separate choices): kept in the page's own
  // storage so a withheld kind is never sent, and in the collecting address's cookie by choose().
  var consent = config.consent;
  var withheld = [];
  try { withheld = JSON.parse(w.localStorage.getItem(consent.page_key) || '[]') || []; } catch (e) { withheld = []; }
  function declined(kind) { return withheld.indexOf(consent.purpose_of[kind]) >= 0; }
  w.trillionCounting = {
    choices: function () {
      return consent.purposes.map(function (row) { return { id: row.id, label: row.label, allowed: withheld.indexOf(row.id) < 0 }; });
    },
    choose: function (purpose, allowed) {
      var row = null;
      for (var p = 0; p < consent.purposes.length; p += 1) if (consent.purposes[p].id === purpose) row = consent.purposes[p];
      if (!row || typeof allowed !== 'boolean') return false;
      withheld = withheld.filter(function (id) { return id !== purpose; });
      if (!allowed) {
        withheld.push(purpose);
        queue = queue.filter(function (event) { return !declined(event.kind); });
        if (!row.anonymous) {
          for (var k = 0; k < consent.storage_keys.length; k += 1) {
            try { w.sessionStorage.removeItem(consent.storage_keys[k]); } catch (e) { /* nothing kept */ }
            try { w.localStorage.removeItem(consent.storage_keys[k]); } catch (e) { /* nothing kept */ }
          }
        }
      }
      try { w.localStorage.setItem(consent.page_key, JSON.stringify(withheld)); } catch (e) { /* the cookie still holds it */ }
      try { fetch(consent.path, { method: 'POST', body: JSON.stringify({ purpose: purpose, allowed: allowed }), keepalive: true, credentials: 'include', mode: 'no-cors' }); } catch (e) { /* the page's own storage still holds it */ }
      return true;
    },
    // A page's live socket closed (src/workspace/store-changes.ts): its close code by name and how long it lived, never
    // its reason words.
    liveClosed: function (code, ms) {
      health('live_close', config.client_health.live_close_categories[String(code)] || 'other', location.pathname, ms);
    },
  };
  for (var s = 0; s < config.shells.length; s += 1) {
    var row = config.shells[s];
    if (row.in_frame && w.parent && w.parent !== w) { shell = row.id; break; }
    if (row.has_handler && w.webkit && w.webkit.messageHandlers && w.webkit.messageHandlers[row.has_handler]) { shell = row.id; break; }
    if (row.has_global) {
      var at = w;
      for (var g = 0; g < row.has_global.length && at; g += 1) { try { at = at[row.has_global[g]]; } catch (e) { at = null; } }
      if (at) { shell = row.id; break; }
    }
  }
  function send() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!queue.length) return;
    if (restUntil) { if (Date.now() < restUntil) { queue.length = 0; return; } restUntil = 0; }
    var body = JSON.stringify({ shell: shell, withheld_purposes: withheld, events: queue.splice(0, config.batch.most_events) });
    var sent = false;
    try { sent = n.sendBeacon && n.sendBeacon(config.collect, body); } catch (e) { sent = false; }
    if (sent) failures = 0;
    else {
      try {
        var request = fetch(config.collect, { method: 'POST', body: body, keepalive: true, credentials: 'include', mode: 'no-cors' });
        if (request && request.then) request.then(function () { failures = 0; }, failed); else failures = 0;
      } catch (e) { failed(); }
    }
    if (queue.length) send();
  }
  // After `breaker.failures` sends in a row that went nowhere, nothing is sent for `breaker.rest_seconds`: what arrives in
  // that time is dropped, never kept on the device or retried, so a broken network costs counts and not storage or traffic.
  var failures = 0;
  var restUntil = 0;
  function failed() {
    failures += 1;
    if (failures >= config.batch.breaker.failures) { failures = 0; restUntil = Date.now() + config.batch.breaker.rest_seconds * 1000; }
  }
  function add(event) {
    if (declined(event.kind)) return;
    queue.push(event);
    if (queue.length >= config.batch.most_events) send();
    else if (!timer) timer = setTimeout(send, config.batch.send_every_seconds * 1000);
  }
  // These observations carry only a closed error category, a cut route and a timing bucket. Never send an exception's
  // message, stack, resource URL, response body or person data. This also runs in the Mac/iPhone WebViews and AI frames.
  function bucket(ms) {
    var limits = config.client_health.duration_buckets;
    var names = ['under-200ms', '200-500ms', '500-1000ms', '1-2s', '2-5s', 'over-5s'];
    for (var i = 0; i < limits.length; i += 1) if (ms < limits[i]) return names[i];
    return names[names.length - 1];
  }
  function health(kind, category, path, ms) {
    var event = { kind: kind, category: category, path: path || location.pathname };
    if (ms !== undefined) event.bucket = bucket(ms);
    add(event);
  }
  var overflowReported = {};
  function checkLayout() {
    setTimeout(function () {
      var wide = d.documentElement && d.documentElement.scrollWidth > w.innerWidth + 2;
      var key = location.pathname;
      if (wide && !overflowReported[key]) { overflowReported[key] = true; health('client_error', 'layout', key); }
    }, 250);
  }
  if (d.readyState === 'complete') checkLayout();
  else w.addEventListener('load', checkLayout, { once: true });
  w.addEventListener('resize', checkLayout);
  w.addEventListener('error', function (event) {
    health('client_error', event.target && event.target !== w ? 'resource' : 'script');
  }, true);
  w.addEventListener('unhandledrejection', function () { health('client_error', 'promise'); });
  // A timing is a sample only when the page stayed visible and online for all of it: a tab put away or a connection
  // lost during a load measures the person, not Trillion, so that timing is left out of the budget's buckets.
  function pageTime() { return w.performance && w.performance.now ? w.performance.now() : 0; }
  var interruptedAt = (d.visibilityState === 'hidden' || n.onLine === false) ? pageTime() : -1;
  d.addEventListener('visibilitychange', function () { if (d.visibilityState === 'hidden') interruptedAt = pageTime(); });
  w.addEventListener('offline', function () { interruptedAt = pageTime(); });
  if (w.PerformanceObserver) {
    try {
      new PerformanceObserver(function (list) {
        var entries = list.getEntries();
        for (var i = 0; i < entries.length; i += 1) {
          var entry = entries[i];
          var whole = entry.startTime > interruptedAt;
          if (entry.entryType === 'navigation') { if (whole) health('client_load', 'navigation', location.pathname, entry.duration); }
          else if (entry.entryType === 'resource' && (entry.initiatorType === 'fetch' || entry.initiatorType === 'xmlhttprequest')) {
            var path = '';
            try { var address = new URL(entry.name, location.href); if (address.origin === location.origin) path = address.pathname; } catch (ignored) { /* no route */ }
            if (path && path !== config.collect) {
              if (entry.responseStatus >= 500) health('client_error', 'request', path);
              if (whole && (entry.duration >= config.client_health.slow_ms || Math.random() < 1 / config.client_health.resource_sample)) health('client_load', 'request', path, entry.duration);
            }
          }
        }
      }).observe({ entryTypes: ['navigation', 'resource'] });
    } catch (ignored) { /* an older browser still reports errors */ }
  }
  function campaign() {
    var out = {};
    try {
      var params = new URLSearchParams(location.search);
      for (var c = 0; c < config.campaign_params.length; c += 1) { var v = params.get(config.campaign_params[c]); if (v) out[config.campaign_params[c]] = v.slice(0, 120); }
    } catch (e) { /* no campaign */ }
    return out;
  }
  function visit(kind) {
    var event = campaign();
    event.kind = kind;
    event.path = location.pathname;
    event.referrer = d.referrer || '';
    return event;
  }
  var idle = config.batch.session_idle_minutes * 60000;
  function touch() {
    var now = Date.now(), last = 0;
    try { last = Number(sessionStorage.getItem('trillion-visit') || 0); sessionStorage.setItem('trillion-visit', String(now)); } catch (e) { last = 0; }
    if (!last || now - last > idle) add(visit('session_start'));
  }
  var depths = {};
  var path = location.pathname;
  function view() {
    path = location.pathname;
    depths = {};
    touch();
    add(visit('page_view'));
  }
  view();
  function changed() { if (location.pathname !== path) { view(); checkLayout(); } }
  ['pushState', 'replaceState'].forEach(function (name) {
    var original = history[name];
    history[name] = function () { var answer = original.apply(this, arguments); setTimeout(changed, 0); return answer; };
  });
  w.addEventListener('popstate', changed);
  function words(el) {
    return (el.getAttribute('aria-label') || el.innerText || el.value || el.title || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  }
  d.addEventListener('click', function (e) {
    var el = e.target && e.target.closest ? e.target.closest(config.clickable) : null;
    if (!el) return;
    var name = '';
    for (var a = 0; a < config.stable_attributes.length && !name; a += 1) name = el.getAttribute(config.stable_attributes[a]) || '';
    if (!name && el.id && !/\d{3,}|[a-f0-9]{10,}/i.test(el.id)) name = '#' + el.id;
    if (!name && config.click_words && !(config.words_never_inside && el.closest(config.words_never_inside))) name = words(el);
    if (!name) name = el.tagName.toLowerCase() + (el.getAttribute('role') ? '[' + el.getAttribute('role') + ']' : '');
    var event = { kind: 'click', path: location.pathname, target: name };
    if (el.href) { try { var to = new URL(el.href, location.href); event.to = to.pathname; event.to_host = to.host; } catch (x) { /* no destination */ } }
    touch();
    add(event);
    // A link that leaves this page takes the queue with it unless it goes now: the page's own events would
    // otherwise wait for a pagehide that some browsers never fire for the page being left.
    if (el.href && !e.metaKey && !e.ctrlKey && !e.shiftKey && e.button === 0 && el.target !== '_blank') send();
  }, true);
  var ticking = false;
  w.addEventListener('scroll', function () {
    if (ticking) return;
    ticking = true;
    setTimeout(function () {
      ticking = false;
      var full = Math.max(d.documentElement.scrollHeight, d.body ? d.body.scrollHeight : 0);
      var seen = full > 0 ? Math.min(100, ((w.scrollY + w.innerHeight) / full) * 100) : 100;
      for (var i = 0; i < config.scroll_depths.length; i += 1) {
        var depth = config.scroll_depths[i];
        if (seen >= depth - 1 && !depths[depth]) { depths[depth] = true; add({ kind: 'scroll', path: location.pathname, depth: String(depth) }); }
      }
    }, 300);
  }, { passive: true });
  d.addEventListener('visibilitychange', function () { if (d.visibilityState === 'hidden') send(); });
  w.addEventListener('pagehide', send);
}
/* eslint-enable no-var */

/** The page script for a page on `pageHost`, sending to `origin`: the function above with its settings. */
function captureScript(origin, pageHost) {
  const surface = surfaceOf(pageHost) ?? {};
  const config = {
    collect: `${origin}${settings.collect_path}`,
    default_shell: settings.default_shell,
    shells: settings.shells,
    batch: settings.batch,
    campaign_params: settings.campaign_params,
    clickable: settings.clickable,
    stable_attributes: settings.stable_attributes,
    click_words: surface.click_words !== false,
    words_never_inside: surface.words_never_inside ?? '',
    scroll_depths: settings.scroll_depths,
    client_health: settings.client_health,
    consent: {
      path: `${origin}${consent.consent_path}`, page_key: consent.page_key, storage_keys: consent.page_storage_keys,
      purposes: consent.purposes.map(({ id, label, anonymous }) => ({ id, label, anonymous })),
      purpose_of: Object.fromEntries([...PURPOSE_OF_KIND].map(([kind, purpose]) => [kind, purpose.id])),
    },
  };
  return `(${capturePage.toString()})(${JSON.stringify(config)});`;
}

// ---------------------------------------------------------------------------------------------------------------------
// The Visitors screen: what the log read, as the shared record set's answer (records/interactions.json `screen`).

const SURFACE_LABELS = new Map(settings.surfaces.map(row => [row.id, row.label]));
const surfaceLabel = id => SURFACE_LABELS.get(id) ?? id;
const add = (map, key, by, make) => { const row = map.get(key) ?? make(); map.set(key, row); by(row); return row; };
const top = (map, limit = 50) => [...map.values()].sort((a, b) => b.count - a.count).slice(0, limit);
const matches = (row, where = {}) => Object.entries(where).every(([field, value]) => (field === 'surface' ? row.surface : row.dims[field]) === value);

/**
 * The screen's answer from what every shard read (`reads`: each { totals, hours, visitors }, src/interaction-log.mjs
 * read), with people's names from `names` (account id → name).
 */
function interactionsAnswer(reads, { names = new Map(), since, until, readAt = new Date().toISOString(), usage = null } = {}) {
  const totals = reads.flatMap(read => read.totals.map(row => ({ ...row, dims: JSON.parse(row.dims) })));
  const pages = new Map();
  const clicks = new Map();
  const sources = new Map();
  const features = new Map();
  const tools = new Map();
  const aiScreens = new Map();
  const aiPresses = new Map();
  const people = new Map();
  const devices = new Map();
  const countries = new Map();
  const pageOf = row => add(pages, `${row.surface}\u0001${row.dims.path ?? '/'}`, () => {}, () => ({
    id: `${row.surface}${row.dims.path ?? '/'}`, surface: row.surface, surface_label: surfaceLabel(row.surface), page: row.dims.path ?? '/',
    visitors: 0, views: 0, clicks: 0, deep: 0, from: new Map(),
    inside: `/work/api/interactions/page?surface=${encodeURIComponent(row.surface)}&path=${encodeURIComponent(row.dims.path ?? '/')}`,
  }));
  for (const row of totals) {
    const n = Number(row.n);
    if (row.kind === 'page_view') {
      pageOf(row).views += n;
      if (row.surface === 'app' && row.dims.path) add(features, row.dims.path, item => { item.count += n; }, () => ({ screen: row.dims.path, count: 0 }));
      if (row.dims.account) add(people, row.dims.account, item => { item.count += n; }, () => ({ account: row.dims.account, person: names.get(row.dims.account) ?? row.dims.account.slice(0, 8), count: 0 }));
    } else if (row.kind === 'session_start') {
      const source = row.dims.utm_source || row.dims.ref || row.dims.from || row.dims.referrer || 'Direct';
      add(sources, source, item => { item.count += n; }, () => ({ source, count: 0 }));
      add(pageOf(row).from, source, item => { item.count += n; }, () => ({ source, count: 0 }));
      if (row.dims.device) add(devices, row.dims.device, item => { item.count += n; }, () => ({ device: row.dims.device, count: 0 }));
      if (row.dims.country) add(countries, row.dims.country, item => { item.count += n; }, () => ({ country: row.dims.country, count: 0 }));
    } else if (row.kind === 'click') {
      pageOf(row).clicks += n;
      const label = row.dims.target ?? '';
      add(clicks, `${row.surface}\u0001${row.dims.path}\u0001${label}`, item => { item.count += n; }, () => ({ label: `${label} (${row.dims.path ?? '/'})`, target: label, page: row.dims.path ?? '/', surface_label: surfaceLabel(row.surface), count: 0 }));
      if (row.dims.account) add(people, row.dims.account, item => { item.count += n; }, () => ({ account: row.dims.account, person: names.get(row.dims.account) ?? row.dims.account.slice(0, 8), count: 0 }));
    } else if (row.kind === 'scroll' && row.dims.depth === String(settings.scroll_depths.at(-1))) {
      pageOf(row).deep += n;
    } else if (row.kind === 'tool_run') {
      add(tools, row.dims.tool ?? '', item => { item.count += n; }, () => ({ tool: row.dims.tool ?? '', count: 0 }));
      if (row.dims.account) add(people, row.dims.account, item => { item.count += n; }, () => ({ account: row.dims.account, person: names.get(row.dims.account) ?? row.dims.account.slice(0, 8), count: 0 }));
    } else if (row.kind === 'ai_screen') {
      const screen = row.dims.screen ?? '/';
      const client = row.dims.client ?? 'unknown';
      const item = add(aiScreens, `${client}\u0001${screen}`, () => {}, () => ({ id: `${client}${screen}`, screen, ai_app: client, shown: 0, presses: 0, full_opens: 0 }));
      if (row.dims.action === 'shown') item.shown += n;
      if (row.dims.action === 'pressed') {
        item.presses += n;
        const target = row.dims.target ?? 'control';
        add(aiPresses, `${client}\u0001${screen}\u0001${target}`, press => { press.count += n; },
          () => ({ label: `${target} (${screen}, ${client})`, target, screen, ai_app: client, count: 0 }));
      }
      if (row.dims.action === 'full_open') item.full_opens += n;
    }
  }
  for (const read of reads) for (const row of read.visitors.pages) {
    const page = pages.get(`${row.surface}\u0001${row.path}`);
    if (page) page.visitors += row.visitors;
  }
  const funnel = settings.funnel.map(step => {
    const count = step.visitors
      ? reads.reduce((sum, read) => sum + read.visitors.kinds.filter(row => row.kind === step.kind && matches({ surface: row.surface, dims: {} }, step.where)).reduce((n, row) => n + row.visitors, 0), 0)
      : totals.filter(row => row.kind === step.kind && matches(row, step.where)).reduce((n, row) => n + Number(row.n), 0);
    return { step: step.label, id: step.id, count };
  });
  // Who came back: of the accounts counted on any day before the last day read, those counted on more than one day.
  const cameBack = (settings.returns ?? []).flatMap(step => {
    const seen = new Map();
    for (const read of reads) {
      for (const row of read.account_days ?? []) {
        if (row.kind === step.kind && matches({ surface: row.surface, dims: {} }, step.where)) add(seen, row.account, days => days.add(row.day), () => new Set());
      }
    }
    const lastDay = [...seen.values()].flatMap(days => [...days]).sort().at(-1);
    const early = [...seen.values()].filter(days => [...days].sort()[0] < lastDay);
    return [
      { step: step.started_label, id: `${step.id}-started`, count: early.length },
      { step: step.returned_label, id: `${step.id}-returned`, count: early.filter(days => days.size > 1).length },
    ];
  });
  const hours = new Map();
  for (const read of reads) {
    for (const row of read.hours) add(hours, `${row.hour}\u0001${row.surface}`, item => { item.views += Number(row.n); }, () => ({ at: `${row.hour}:00:00.000Z`, surface_label: surfaceLabel(row.surface), views: 0, visitors: 0 }));
    for (const row of read.visitors.hours) add(hours, `${row.hour}\u0001${row.surface}`, item => { item.visitors += row.visitors; }, () => ({ at: `${row.hour}:00:00.000Z`, surface_label: surfaceLabel(row.surface), views: 0, visitors: 0 }));
  }
  const items = [...pages.values()].map(({ from, deep, ...page }) => ({
    ...page,
    read_to_end: page.views ? `${Math.round((deep / page.views) * 100)}%` : '',
    top_source: top(from, 1)[0]?.source ?? '',
  })).sort((a, b) => b.visitors - a.visitors || b.views - a.views);
  const { inside_view: _inside, ...view } = settings.screen;
  return {
    view, items, since, until, read_at: readAt,
    hours: [...hours.values()].sort((a, b) => a.at.localeCompare(b.at)),
    funnel, came_back: cameBack, clicks: top(clicks), sources: top(sources), features: top(features), tools: top(tools),
    ai_screens: [...aiScreens.values()].sort((a, b) => b.shown - a.shown || b.full_opens - a.full_opens).slice(0, 200), ai_presses: top(aiPresses, 200), people: top(people),
    devices: top(devices), countries: top(countries),
    ...(usage ? { usage } : {}),
  };
}

/** One page's clicks and how far down it was read, as the record set one level down. */
function pageAnswer(reads, { surface, path, since, until }) {
  const totals = reads.flatMap(read => read.totals.map(row => ({ ...row, dims: JSON.parse(row.dims) })))
    .filter(row => row.surface === surface && (row.dims.path ?? '/') === path);
  const clicks = new Map();
  const depths = new Map();
  for (const row of totals) {
    if (row.kind === 'click') add(clicks, `${row.dims.target}\u0001${row.dims.to ?? ''}`, item => { item.count += Number(row.n); }, () => ({ id: `${row.dims.target}${row.dims.to ?? ''}`, label: row.dims.target ?? '', to: row.dims.to ?? '', count: 0 }));
    if (row.kind === 'scroll') add(depths, row.dims.depth, item => { item.count += Number(row.n); }, () => ({ depth: `${row.dims.depth}%`, count: 0 }));
  }
  return { view: settings.screen.inside_view, items: top(clicks, 200), depths: [...depths.values()].sort((a, b) => parseInt(a.depth, 10) - parseInt(b.depth, 10)), since, until };
}

return { INTERACTIONS, INTERACTION_CONSENT, anonymousKind, withheldPurposes, chooseConsent, consentAnswer, consentCookie, kindOf, surfaceOf, cutPath, deviceOf, isRobot, asksNotToTrack, referrerHost, hourOf, admitPageBatch, serverEvent, countKey, countsVisitors, SKETCH_BITS, emptySketch, sketchAdd, sketchMerge, sketchCount, visitorHash, shardOf, interactionLog, noteInteractions, readRange, readInteractions, visitorsBy, eventsBy, funnelFacts, capturePage, captureScript, interactionsAnswer, pageAnswer };
}
