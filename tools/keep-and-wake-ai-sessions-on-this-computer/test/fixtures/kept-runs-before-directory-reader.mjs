// parts/record-log/do-work/kept-runs.mjs
//
// ONE ORDERED KEY SPACE OVER ANY SQLITE, WRITTEN A PAGE AT A TIME.
//
// Purpose
//   A sorted map from text keys to JSON values whose writes cost rows in proportion to the BYTES that changed, never to
//   how many keys changed. Changes collect in memory (the memtable, newest), and are written out together as a run:
//   an immutable table of pages, each page one row holding many sorted entries (about page_bytes of them). Runs are
//   merged a few at a time into bigger runs, and a run that was merged away is dropped whole. On a host that bills per
//   row written (Cloudflare Durable Object SQLite bills every row and every index entry), a thousand changed keys cost
//   about the pages they fill, not a thousand rows plus their indexes.
//
// Non-negotiable invariants
//   1. Durability is the caller's job. The memtable is memory only: a host keeps its own log of what it put here and
//      replays it after a restart or a rolled-back transaction (record-log-store.mjs keeps that log). flush() writes the
//      memtable as one run in one transaction, and the caller says in the same transaction how far its log is now
//      covered (flush({ covered })), so the run and the log position can never disagree.
//   2. A run is immutable. Every table this module owns has no secondary index; a run table's integer page number is its
//      rowid. Retiring a run is DROP TABLE, which writes no row, never a delete per page.
//   3. The newest version of a key wins: the memtable, then runs from the newest age to the oldest. A removed key is a
//      tombstone until a merge that includes the oldest run lets it go. Merges only ever combine runs adjacent in age,
//      so one key's versions keep their order.
//   4. Memory is bounded by bytes: the memtable (memtable_bytes: the host flushes when full() while idle; a write only once overfull() at memtable_hold times that or at its log-tail bound), pages read
//      (cache_bytes, least recently used let go first), and per run only its first key and an optional membership filter
//      (about ten bits a key; a merge resumed after a restart publishes without one, since rebuilding it from all
//      completed output pages could monopolize the store). A run's page fences (first key of each page) are not held: a key's page is found by halving the
//      page numbers in one statement, so opening the store reads a row per run however many pages the
//      runs hold. Nothing ever reads a whole run into memory, and a merge holds one page of each run it combines plus
//      the page it is writing.
//   5. A merge is resumable work in bounded steps (step()): its progress (the last key written, the pages written and
//      the values it let go) is kept in the database after every step, so a restart continues it, and readers keep
//      reading the old runs until the step that finishes it swaps them, in one transaction.
//   6. The module names no product, no record kind and no field. Keys are text compared as JavaScript strings; values
//      are any JSON, `undefined` never stored.
//
// Key concepts
//   memtable   Map key -> value (or a tombstone) plus the same keys kept sorted, so a range read merges it in order.
//   run        { run, age, pages, keys, bytes, first, last, filter } ; table `${prefix}_run_${run}` holds rows
//              (page INTEGER PRIMARY KEY, first TEXT, body TEXT). Rows with a negative page hold the run's membership
//              filter, a chunk each; filter_bits = 0 means the run has no filter and missing keys read one page.
//   blocks     a membership filter kept for a run that has none (fillFilters: a merge resumed after a restart, or one
//              over the resident filter budget, publishes its run without one), marked by filter_bits = -blocks. Each
//              key's bits lie in one 512-bit block, and FILTER_ROW_BLOCKS blocks are one row (page -1 - row), so a
//              probe reads one small row through the page cache and nothing is held resident. Without it, an absent
//              key cost a halving over the run's pages: about 19 rows a probe in a run of 50,000 pages (the owner's
//              store, 2026-10-10: a 2.2 GB run with no filter, so every new id written read about 245 rows).
//   page       body = a header line `{"p":[shared...],"s":[suffix...],"o":[offset...],"b":{index:[ref, parts]}}` then
//              the entries' value texts end to end. Key i is the first p[i] characters of key i-1 followed by s[i] (keys
//              in a page share long prefixes, so the header is small and the page holds more). Entry i's value is the
//              text between offsets i and i+1 after the header; an empty one is a tombstone; one named in "b" is a value
//              too big for a page, kept in `${prefix}_big` under ref. A read parses the header and only the one value
//              it wants, never the whole page, and a merge copies value texts from page to page without parsing them. Pages written before this layout
//              (body = JSON [[key, value] | [key] | [key, ref, parts]]) are still read; merges rewrite them.
//   age        the order runs were made in; a merged run takes the age of the newest run it combined.
//   big value  a value whose JSON passes big_bytes is written once to `${prefix}_big` as parts and moves with its key
//              from run to run; it is deleted when a merge lets its key's version go.
//
// Security
//   No credential, no network. Table names are built from the prefix the host gives (code, never a person) and integer
//   run numbers; every key and value is bound as a parameter.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

const TOMB = Symbol('removed');
const FILTER_BITS_PER_KEY = 10;
const FILTER_HASHES = 7;
const FILTER_CHUNK = 512 * 1024; // bytes of filter per row
const FILTER_BLOCK_BITS = 512; // a blocked filter's block: every bit of one key lies in it
const FILTER_ROW_BLOCKS = 64; // blocks of a blocked filter per row (4 KB), the most one probe reads
const BIG_PART = 1024 * 1024; // characters of a big value per row
const BIG_CLEANUP_PARTS = 16;
const BIG_CLEANUP_REFS = 16;

// Private, non-enumerable progress on opted-in interrupted exact-key ranges.
// Accepted winners include tombstones; unvisited keys are never certified absent.
export const KEPT_RANGE_PROGRESS = Symbol('kept-range-budget-progress');

export class KeptRangeBudgetExceeded extends Error {
  constructor() { super('The selected kept values exceed this read group\'s memory budget.'); this.code = 'kept_range_budget'; }
}

export const KEPT_RUNS_DEFAULTS = {
  page_bytes: 64 * 1024,
  big_bytes: 512 * 1024,
  memtable_bytes: 2 * 1024 * 1024,
  // The memtable may grow to this many times memtable_bytes before a write must wait for it to be written out; below
  // that, writing it out (and merging) is the host's idle work (step()), never a write's.
  memtable_hold: 4,
  // The most log rows the memtable may hold before a write writes it out too. The memtable is bounded by bytes, and
  // small writes are many rows to a byte, so this also bounds recovery replay work after a restart.
  tail_rows: 512,
  cache_bytes: 2 * 1024 * 1024,
  // Filters only avoid page reads for absent keys. A large account still answers correctly when some are omitted.
  // Large fragmented stores need the persisted membership filters resident: a
  // missing filter turns each absent key into a run-page SQL read on cold replay.
  // This is a cap, not reserved memory; small stores keep only their actual filters.
  filter_bytes: 8 * 1024 * 1024,
  // A run with no membership filter is given a blocked one as idle work (fillFilters): pages read in one call, and the
  // pages read between the saves that let a restart continue where the last save left off.
  fill_pages: 512,
  fill_save_pages: 8192,
  // How many runs a backlog merge (over max_runs) combines at once, and the fewest a size merge waits for.
  fan_in: 4,
  // An older run joins a merge of the runs younger than it while it holds no more than this many times their pages.
  // Page counts measure copy work even when equally sized pages compress differently.
  size_ratio: 1,
  // An older run of about the same size as the runs younger than it also joins: no more than this many times their
  // average pages. Write-outs come out a little larger or smaller each time, so with size_ratio alone four of them
  // (47, 52, 60 and 41 pages) never merged and a settled store kept every read probing four runs until max_runs; a
  // run this many times the average is still a larger tier and never rides along.
  tier_spread: 1.5,
  // A complete idle fold is due only after overwritten values make up this share of live run bytes. This limits
  // retained versions without changing the ordinary size-tier merge cadence.
  compaction_debt_ratio: 0.25,
  compaction_debt_min_bytes: 1024 * 1024,
  // A running fold yields to disjoint age-adjacent backlog groups, retaining its cursor and remaining space
  // reservation; one original slice between groups prevents steady arrivals from starving the fold.
  // Idle work gives a backlog above this many runs priority over size merges. Opening or writing a store must never
  // merge the whole backlog synchronously: a large account can have hundreds of runs and hold every request for minutes.
  max_runs: 24,
  // A merge writes its whole output before its inputs go, so it needs about their size again in free space. Where the
  // host reports the database's size, a merge starts only when its inputs, times space_factor (pages are not full and
  // carry their b-tree), fit under space_share of database_limit_bytes; else the next merge that fits is taken. On the
  // owner's store on 2026-10-10 a full fold over a 2.2 GB run ran the database into its 10 GiB limit, where every write
  // fails, including the merge's own.
  database_limit_bytes: 10 * 1024 * 1024 * 1024,
  space_share: 0.9,
  space_factor: 1.5,
};

// Two 32-bit FNV-1a hashes of a key's UTF-16 code units, for the membership filter (not a security function), left in
// hashA and hashB so a filter add or probe allocates nothing.
let hashA = 0;
let hashB = 0;
function hash(key) {
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ 0x5bd1e995;
  for (let index = 0; index < key.length; index += 1) {
    const code = key.charCodeAt(index);
    a = Math.imul(a ^ code, 0x01000193);
    b = Math.imul(b ^ code, 0x5bd1e995);
    b ^= b >>> 15;
  }
  hashA = a >>> 0;
  hashB = (b | 1) >>> 0;
}
function filterAdd(bits, size, key) {
  hash(key);
  for (let k = 0; k < FILTER_HASHES; k += 1) { const at = ((hashA + Math.imul(k, hashB)) >>> 0) % size; bits[at >>> 3] |= 1 << (at & 7); }
}
function filterHas(bits, size, key) {
  hash(key);
  for (let k = 0; k < FILTER_HASHES; k += 1) { const at = ((hashA + Math.imul(k, hashB)) >>> 0) % size; if (!(bits[at >>> 3] & (1 << (at & 7)))) return false; }
  return true;
}
const filterSize = keys => Math.max(64, Math.ceil((Math.max(1, keys) * FILTER_BITS_PER_KEY) / 8) * 8);
// A blocked filter: hashA picks the key's block, and hashB, stirred once a bit, its FILTER_HASHES bits in that block.
const blockCount = keys => Math.max(1, Math.ceil((Math.max(1, keys) * FILTER_BITS_PER_KEY) / FILTER_BLOCK_BITS));
const BLOCK_BYTES = FILTER_BLOCK_BITS / 8;
function blockBits(bits, base, add) {
  let h = hashB;
  for (let k = 0; k < FILTER_HASHES; k += 1) {
    const at = h >>> 23;
    const mask = 1 << (at & 7);
    if (add) bits[base + (at >>> 3)] |= mask;
    else if (!(bits[base + (at >>> 3)] & mask)) return false;
    h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  }
  return true;
}
function blockAdd(bits, blocks, key) { hash(key); blockBits(bits, (hashA % blocks) * BLOCK_BYTES, true); }
// A filter chunk is kept as bytes; chunks written before were base64 text, and both are read.
function readChunk(body, into, at) {
  if (typeof body !== 'string') { const bytes = new Uint8Array(body); into.set(bytes, at); return bytes.length; }
  const raw = atob(body);
  for (let index = 0; index < raw.length; index += 1) into[at + index] = raw.charCodeAt(index);
  return raw.length;
}

// The index of the last entry whose key is <= key in a sorted list of keys (or of [key, ...] entries), -1 when none.
function floorIndex(list, key, keyOf = item => item) {
  let lo = 0;
  let hi = list.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (keyOf(list[mid]) <= key) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return found;
}
// The index of the first entry whose key is >= key, list.length when none.
function ceilIndex(list, key, keyOf = item => item) {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (keyOf(list[mid]) < key) lo = mid + 1; else hi = mid;
  }
  return lo;
}
const entryKey = entry => entry[0];

// ---- pages ---------------------------------------------------------------------------------------------------------
// A page read from its row. keys: its sorted keys; entry(i): [key, value] | [key] (tombstone) | [key, ref, parts] (big),
// parsing only that value; tomb(i), big(i) and text(i) (the value's JSON text) let a merge copy an entry unparsed.
class PackedPage {
  constructor(body, keys, offsets, bigs, base, parseJson = JSON.parse, common = '') { this.common = common; this.body = body; this.keys = keys; this.offsets = offsets; this.bigs = bigs; this.base = base; this.parseJson = parseJson; }
  get length() { return this.keys.length; }
  big(index) { return this.bigs[index] ?? null; }
  tomb(index) { return this.offsets[index] === this.offsets[index + 1] && !this.bigs[index]; }
  text(index) { return this.tomb(index) || this.big(index) ? '' : this.common + this.body.slice(this.base + this.offsets[index], this.base + this.offsets[index + 1]); }
  chars(index) { return this.tomb(index) || this.big(index) ? 0 : this.common.length + this.offsets[index + 1] - this.offsets[index]; }
  entry(index) {
    const key = this.keys[index];
    const big = this.bigs[index];
    if (big) return [key, big[0], big[1]];
    if (this.offsets[index] === this.offsets[index + 1]) return [key];
    return [key, this.parseJson(this.text(index), { kind: 'value', key })];
  }
  get bytes() { return 64 + this.body.length * 2 + this.keys.length * 16; }
}
// Index entries often share one tiny value. Keep it once instead of one growing offset and value per key.
class UniformPage {
  constructor(body, keys, text, parseJson = JSON.parse) { this.body = body; this.keys = keys; this.valueText = text; this.parseJson = parseJson; }
  get length() { return this.keys.length; }
  big() { return null; }
  tomb() { return false; }
  text() { return this.valueText; }
  chars() { return this.valueText.length; }
  entry(index) { return [this.keys[index], this.parseJson(this.valueText, { kind: 'value', key: this.keys[index] })]; }
  get bytes() { return 64 + this.body.length * 2 + this.keys.length * 16; }
}
class ListPage {
  constructor(entries, chars) { this.entries = entries; this.keys = entries.map(entryKey); this.storedChars = chars; }
  get length() { return this.entries.length; }
  big(index) { const entry = this.entries[index]; return entry.length === 3 ? [entry[1], entry[2]] : null; }
  tomb(index) { return this.entries[index].length === 1; }
  text(index) { return JSON.stringify(this.entries[index][1]); }
  chars(index) { return this.tomb(index) ? 0 : this.text(index).length; }
  entry(index) { return this.entries[index]; }
  get bytes() { return 64 + this.storedChars * 3; }
}
function decodePage(body, parseJson = JSON.parse) {
  if (body[0] === '[') return new ListPage(parseJson(body, { kind: 'page' }), body.length);
  const end = body.indexOf('\n');
  const head = JSON.parse(body.slice(0, end));
  const keys = new Array(head.s.length);
  const prefixes = head.p ?? head.q.flatMap(([shared, count]) => Array(count).fill(shared));
  let previous = '';
  for (let index = 0; index < keys.length; index += 1) previous = keys[index] = previous.slice(0, prefixes[index]) + head.s[index];
  return head.v !== undefined ? new UniformPage(body, keys, head.v, parseJson) : new PackedPage(body, keys, head.o, head.b ?? {}, end + 1, parseJson, head.c ?? '');
}
// Collects entries in key order into one page body; `add` takes the value's JSON text (null for a tombstone) or, for a
// value kept on its own rows, its [ref, parts].
function pageBuilder() {
  let keys = [];
  let prefixes = [];
  let suffixes = [];
  let texts = [];
  let offsets = [0];
  let bigs = {};
  let at = 0;
  let chars = 16;
  const shape = (key, text, big) => {
    const previous = keys.length ? keys[keys.length - 1] : '';
    let shared = 0;
    const most = Math.min(previous.length, key.length);
    while (shared < most && previous.charCodeAt(shared) === key.charCodeAt(shared)) shared += 1;
    // Never split a surrogate pair between the shared part and the suffix.
    if (shared > 0 && shared < key.length && (key.charCodeAt(shared) & 0xfc00) === 0xdc00) shared -= 1;
    const suffix = key.slice(shared);
    const end = at + (text ? text.length : 0);
    const bigChars = big ? String(keys.length).length + JSON.stringify(big).length + 2 : 0;
    return { shared, suffix, end, added: JSON.stringify(suffix).length + String(shared).length + String(end).length + 3 + (text ? text.length : 0) + bigChars };
  };
  return {
    get length() { return keys.length; },
    get chars() { return chars; },
    get first() { return keys[0]; },
    wouldOverflow(key, text, big, limit) { return chars + shape(key, text, big).added > limit; },
    add(key, text, big = null) {
      const { shared, suffix, end, added } = shape(key, text, big);
      if (big) bigs[keys.length] = big;
      prefixes.push(shared);
      suffixes.push(suffix);
      keys.push(key);
      if (text) texts.push(text);
      at = end;
      offsets.push(at);
      chars += added;
    },
    // The body, and the page as a reader would decode it (so a page just written is kept as read without parsing it).
    finish() {
      const repeats = [];
      for (const shared of prefixes) {
        const last = repeats.at(-1);
        if (last?.[0] === shared) last[1] += 1; else repeats.push([shared, 1]);
      }
      const prefixHead = JSON.stringify(repeats).length < JSON.stringify(prefixes).length ? { q: repeats } : { p: prefixes };
      const uniform = texts.length === keys.length && texts.every(text => text === texts[0]) && !Object.keys(bigs).length;
      // Record values on an ordered page often start with the same type and time prefix. Store that prefix once;
      // each selected value reconstructs its own text, without parsing or retaining its neighbors. Leave one character
      // in every nonempty suffix, so equal offsets still mean only a tombstone or a separately held large value.
      let common = '';
      if (!uniform && texts.length > 1) {
        let length = Math.min(...texts.map(text => text.length - 1));
        const first = texts[0];
        for (const text of texts.slice(1)) {
          let shared = 0;
          while (shared < length && first.charCodeAt(shared) === text.charCodeAt(shared)) shared += 1;
          length = shared;
        }
        if (length && (first.charCodeAt(length) & 0xfc00) === 0xdc00) length -= 1;
        if (length && (texts.length - 1) * length > JSON.stringify(first.slice(0, length)).length + 6) common = first.slice(0, length);
      }
      const packedTexts = common ? texts.map(text => text.slice(common.length)) : texts;
      const packedOffsets = common ? [0] : offsets;
      if (common) for (let index = 0; index < keys.length; index += 1) packedOffsets.push(packedOffsets.at(-1) + (offsets[index + 1] > offsets[index] ? offsets[index + 1] - offsets[index] - common.length : 0));
      const head = JSON.stringify({ ...prefixHead, s: suffixes, ...(uniform ? { v: texts[0] } : { o: packedOffsets, b: bigs, ...(common ? { c: common } : {}) }) });
      const body = `${head}\n${uniform ? '' : packedTexts.join('')}`;
      const page = uniform ? new UniformPage(body, keys, texts[0]) : new PackedPage(body, keys, packedOffsets, bigs, head.length + 1, JSON.parse, common);
      keys = []; prefixes = []; suffixes = []; texts = []; offsets = [0]; bigs = {}; at = 0; chars = 16;
      return { body, page };
    },
  };
}

/**
 * The key space over one SQLite database.
 *   sql          { exec(query, ...params) -> { toArray() } }
 *   transaction  (fn) -> result, running fn atomically (optional; defaults to calling fn)
 *   prefix       table-name prefix (letters, digits, underscore)
 *   options      KEPT_RUNS_DEFAULTS overrides
 */
export function keptRuns(sql, { transaction = fn => fn(), prefix, parseJson = JSON.parse, ...options } = {}) {
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(prefix ?? '')) throw new Error('keptRuns needs a table prefix of letters, digits and underscores');
  const settings = { ...KEPT_RUNS_DEFAULTS, ...options };
  // A value must leave room for the page's keys and header. Otherwise one inline value can turn a 64 KB page into a
  // half-megabyte read for an unrelated neighboring key.
  const inlineLimit = Math.min(settings.big_bytes, Math.floor(settings.page_bytes / 2));
  const pageLimit = Math.max(64, settings.page_bytes - Math.min(256, Math.floor(settings.page_bytes / 4)));
  // A caller may give narrow key ranges smaller physical pages, so reading one index entry does not open a large
  // neighboring value. Rules name prefixes, never record kinds; larger values retain their existing page packing.
  const pageLimitOf = key => {
    const bytes = settings.prefix_page_bytes?.find(rule => key.startsWith(rule.prefix))?.bytes ?? settings.page_bytes;
    return Math.max(64, Math.min(pageLimit, bytes - Math.min(256, Math.floor(bytes / 4))));
  };
  const all = (query, ...params) => sql.exec(query, ...params).toArray();
  const RUNS = `${prefix}_runs`;
  const META = `${prefix}_meta`;
  const BIG = `${prefix}_big`;
  const BIG_DROPS = `${prefix}_big_drops`;
  const runTable = run => `${prefix}_run_${run}`;
  sql.exec(`CREATE TABLE IF NOT EXISTS ${RUNS} (run INTEGER PRIMARY KEY, age INTEGER NOT NULL, pages INTEGER NOT NULL, keys INTEGER NOT NULL, bytes INTEGER NOT NULL, last TEXT NOT NULL, filter_bits INTEGER NOT NULL)`);
  sql.exec(`CREATE TABLE IF NOT EXISTS ${META} (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID`);
  sql.exec(`CREATE TABLE IF NOT EXISTS ${BIG} (ref TEXT NOT NULL, part INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY (ref, part)) WITHOUT ROWID`);
  sql.exec(`CREATE TABLE IF NOT EXISTS ${BIG_DROPS} (ref TEXT PRIMARY KEY) WITHOUT ROWID`);

  const meta = {
    get(key) {
      for (const row of sql.exec(`SELECT value FROM ${META} WHERE key = ?`, key)) return JSON.parse(row.value);
      return undefined;
    },
    set(key, value) { sql.exec(`INSERT INTO ${META} (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`, key, JSON.stringify(value)); },
    remove(key) { sql.exec(`DELETE FROM ${META} WHERE key = ?`, key); },
  };

  // ---- memtable ---------------------------------------------------------------------------------------------------
  // mem: key -> value (or a tombstone); memSizes: key -> the bytes it was counted at, so replacing it never measures the
  // old value again; memSorted: the keys in order, with keys added since it was last needed kept apart (memAdded) and
  // merged in once, when a range or a flush next needs the order, instead of an array splice per new key.
  const mem = new Map();
  const memSizes = new Map();
  let memSorted = [];
  let memAdded = [];
  let memBytes = 0;
  let memCompactionDebt = 0;
  // A caller that already knows about how long the value's JSON is passes it (chars); otherwise it is measured.
  const sizeOf = (key, value, chars) => 32 + key.length * 2 + (value === TOMB ? 0 : (chars ?? JSON.stringify(value).length) * 2);
  function memPut(key, value, chars, compactionDebt = 0) {
    const had = memSizes.get(key);
    if (had === undefined) { memAdded.push(key); memCompactionDebt += Math.max(0, compactionDebt); }
    else memBytes -= had;
    const bytes = sizeOf(key, value, chars);
    mem.set(key, value);
    memSizes.set(key, bytes);
    memBytes += bytes;
  }
  function sortedMemKeys() {
    if (memAdded.length) {
      memAdded.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      const merged = new Array(memSorted.length + memAdded.length);
      let left = 0;
      let right = 0;
      let at = 0;
      while (left < memSorted.length && right < memAdded.length) merged[at++] = memSorted[left] < memAdded[right] ? memSorted[left++] : memAdded[right++];
      while (left < memSorted.length) merged[at++] = memSorted[left++];
      while (right < memAdded.length) merged[at++] = memAdded[right++];
      memSorted = merged;
      memAdded = [];
    }
    return memSorted;
  }
  function memClear() { mem.clear(); memSizes.clear(); memSorted = []; memAdded = []; memBytes = 0; memCompactionDebt = 0; }

  // ---- runs ---------------------------------------------------------------------------------------------------------
  // Newest age first.
  let runs = [];
  let building = null;
  const residentFilterBytes = () => runs.reduce((sum, run) => sum + (run.filter?.byteLength ?? 0), 0);
  const mergeFilterBytes = () => building?.filter?.byteLength ?? 0;
  // New write-outs need the same admission as a cold catalog and an in-progress merge. Keep their newest filter by
  // letting go of older optional resident filters before allocation; those filters remain stored for a later open.
  // A filter larger than the whole available budget is omitted, and exact page lookup remains the source of truth.
  function freshFilter(keys) {
    const bytes = filterSize(keys);
    const available = Math.max(0, settings.filter_bytes - mergeFilterBytes());
    if (bytes > available) return { filter: null, bits: 0 };
    let resident = residentFilterBytes();
    for (let at = runs.length - 1; resident + bytes > available && at >= 0; at -= 1) {
      const run = runs[at];
      resident -= run.filter?.byteLength ?? 0;
      run.filter = null;
    }
    return { filter: new Uint8Array(bytes), bits: bytes * 8 };
  }
  function loadFilter(row) {
    const filter = new Uint8Array(row.filter_bits / 8);
    let at = 0;
    for (const { body } of sql.exec(`SELECT body FROM ${runTable(row.run)} WHERE page < 0 ORDER BY page DESC`)) at += readChunk(body, filter, at);
    return filter;
  }
  // A run's page fences (the first key of each page) are never held: a start reads one row per run, not one per page, and
  // a run of forty thousand pages costs memory no more than a run of ten. Pages of a run are in key order, so the last
  // page whose fence is <= key (< key when strict) is found by halving the page numbers, one keyed row per halving (the
  // rowid is the page, and `first` comes before the body in the row, so no halving reads a page body); -1 when none.
  // from: a page at or before the answer, for a caller walking keys upward.
  function fenceOf(run, page) {
    for (const item of sql.exec(`SELECT first FROM ${runTable(run.run)} WHERE page = ?`, page)) return JSON.parse(item.first);
    throw new Error(`Page ${page} of ${runTable(run.run)} is missing.`);
  }
  // The halving as one statement, however many keys are sought: a lookup is one statement however many pages the run
  // holds, and the windows of a screen are one statement a run. A probe is [key, strict, from]; the statement hands back
  // the page it found and the fences of that page and the next. SQLite compares the unescaped fence by code point and
  // JavaScript by UTF-16 unit, which differ only for a character past U+FFFF beside one in U+E000..U+FFFF; so each answer
  // is checked in JavaScript against those two fences, and a disagreement is halved in JavaScript. Numbers bind as
  // reals, hence the casts.
  const below = 'CASE WHEN halving.s THEN json_extract(fence.first, \'$\') < halving.k ELSE json_extract(fence.first, \'$\') <= halving.k END';
  // With `body`, each row also carries the body of the page found, so a lookup that must read the page is one statement.
  const seekSql = (table, body) => {
    // Carry the two bracketing fences already visited by the search. Reading
    // them again at the end charges two extra physical rows for every probe.
    // A nonzero frontier also keeps its predecessor for the JS order check.
    const seeking = `SELECT probe.key AS at, (
      WITH RECURSIVE halving(lo, hi, found, k, s, here, next) AS (
          SELECT CAST(json_extract(probe.value, '$[2]') AS INTEGER), CAST(? AS INTEGER) - 1, CAST(json_extract(probe.value, '$[2]') AS INTEGER) - 1,
            json_extract(probe.value, '$[0]'), json_extract(probe.value, '$[1]'),
            CASE WHEN json_extract(probe.value, '$[2]') = 1 THEN json_extract(probe.value, '$[3]') ELSE
              (SELECT first FROM ${table} WHERE page = json_extract(probe.value, '$[2]') - 1) END, NULL
        UNION ALL
          SELECT CASE WHEN ${below} THEN (halving.lo + halving.hi) / 2 + 1 ELSE halving.lo END,
            CASE WHEN ${below} THEN halving.hi ELSE (halving.lo + halving.hi) / 2 - 1 END,
            CASE WHEN ${below} THEN (halving.lo + halving.hi) / 2 ELSE halving.found END,
            halving.k, halving.s,
            CASE WHEN ${below} THEN fence.first ELSE halving.here END,
            CASE WHEN ${below} THEN halving.next ELSE fence.first END
          FROM halving JOIN ${table} AS fence ON fence.page = (halving.lo + halving.hi) / 2
          WHERE halving.lo <= halving.hi
      )
      SELECT json_array(found, here, next)
      FROM halving WHERE lo > hi
    ) AS sought FROM json_each(?) AS probe`;
    // SQLite may flatten a derived table and evaluate the correlated halving
    // again for each reference to sought. Keep each probe result once before
    // using its fence result to fetch the page body in this same statement.
    return body ? `WITH sought_pages AS MATERIALIZED (${seeking}) SELECT at, sought,
      (SELECT body FROM ${table} WHERE page = json_extract(sought, '$[0]')) AS body FROM sought_pages` : seeking;
  };
  const fenceBelow = (fence, key, strict) => (strict ? fence < key : fence <= key);
  // The answer without a row read, when the key is before the run, past it, or the run is one page.
  function settledPage(run, { key, strict, from }) {
    if (!run.pages || !fenceBelow(run.first, key, strict)) return from - 1;
    if (run.pages === 1 || fenceBelow(run.last, key, strict)) return run.pages - 1;
    return coveringPage(run, key, strict);
  }
  function halvedPage(run, { key, strict, from }) {
    let lo = from;
    let hi = run.pages - 1;
    let found = from - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      if (fenceBelow(fenceOf(run, mid), key, strict)) { found = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return found;
  }
  // The last page of the run whose fence is <= key (< key when strict) for each probe, -1 (from - 1 when `from` is given)
  // when none. `from` is a page at or before the answer, for a caller walking keys upward.
  // `bodies`, a Map when given, takes the body of each page found (page to body text), for a caller that reads the pages.
  function lastPages(run, probes, bodies = null, nextFences = null) {
    const pages = probes.map(probe => settledPage(run, probe));
    const asked = probes.map((_, at) => at).filter(at => pages[at] === undefined);
    if (asked.length >= 8) {
      // A batch shares physical midpoint fences. Each fence is selected once per
      // search round, even when many nearby probes visit that same row.
      for (let group = 0; group < asked.length; group += 64) {
        const active = asked.slice(group, group + 64).map(at => ({ at, lo: probes[at].from, hi: run.pages - 1, found: probes[at].from - 1 }));
        for (;;) {
          const pending = active.filter(item => item.lo <= item.hi);
          if (!pending.length) break;
          // Read three decision levels per round. Each 64-probe group needs at
          // most 448 fences, keeping the query and scratch bounded while avoiding
          // one SQL round trip for every individual binary-search level.
          const wanted = new Set();
          const include = (lo, hi, depth) => {
            if (lo > hi || depth === 0) return;
            const mid = (lo + hi) >>> 1;
            wanted.add(mid);
            include(lo, mid - 1, depth - 1);
            include(mid + 1, hi, depth - 1);
          };
          for (const item of pending) include(item.lo, item.hi, 3);
          const numbers = [...wanted];
          const fences = new Map();
          for (let offset = 0; offset < numbers.length; offset += 100) {
            const selected = numbers.slice(offset, offset + 100);
            for (const row of sql.exec(`SELECT page, first FROM ${runTable(run.run)} WHERE page IN (${selected.map(() => '?').join(',')})`, ...selected)) fences.set(row.page, JSON.parse(row.first));
          }
          for (const item of pending) {
            for (let level = 0; level < 3 && item.lo <= item.hi; level += 1) {
              const mid = (item.lo + item.hi) >>> 1;
              if (!fences.has(mid)) throw new Error(`Page ${mid} of ${runTable(run.run)} is missing.`);
              if (fenceBelow(fences.get(mid), probes[item.at].key, probes[item.at].strict)) { item.found = mid; item.lo = mid + 1; }
              else {
                item.hi = mid - 1;
                if (nextFences) { item.nextPage = mid; item.nextFence = fences.get(mid); }
              }
            }
          }
        }
        for (const item of active) {
          pages[item.at] = item.found;
          // The nearest rejected fence was already visited and compared in JS
          // order. Keep it only when it is the actual successor of this answer.
          if (nextFences && item.nextPage === item.found + 1) nextFences.set(item.nextPage, item.nextFence);
        }
        if (bodies) {
          const numbers = [...new Set(active.map(item => item.found).filter(page => page >= 0))];
          for (let offset = 0; offset < numbers.length; offset += 100) {
            const selected = numbers.slice(offset, offset + 100);
            for (const row of sql.exec(`SELECT page, body FROM ${runTable(run.run)} WHERE page IN (${selected.map(() => '?').join(',')})`, ...selected)) bodies.set(row.page, row.body);
          }
        }
      }
    } else if (asked.length) {
      // settledPage already proves the first fence is below each unresolved
      // probe in JS order. Reuse the run's kept first fence and start after it.
      for (const item of sql.exec(seekSql(runTable(run.run), bodies !== null), run.pages,
        JSON.stringify(asked.map(at => [probes[at].key, probes[at].strict ? 1 : 0, Math.max(1, probes[at].from), JSON.stringify(run.first)])))) {
        const at = asked[Number(item.at)];
        const { key, strict } = probes[at];
        const [found, here, next] = JSON.parse(item.sought);
        if ((found < 0 || fenceBelow(JSON.parse(here), key, strict)) && (found + 1 >= run.pages || !fenceBelow(JSON.parse(next), key, strict))) {
          pages[at] = found;
          if (bodies && item.body != null) bodies.set(found, item.body);
          // This successor was already visited by the search and checked in
          // JavaScript key order. A bounded cursor can reject it without loading
          // its values when its first key is at or beyond that cursor's end.
          if (nextFences && found + 1 < run.pages) nextFences.set(found + 1, JSON.parse(next));
        }
      }
    }
    return pages.map((page, at) => {
      const found = page ?? halvedPage(run, probes[at]);
      // A resident predecessor owns its charged, validated successor proof.
      // Reuse it after a warm settledPage answer without fetching another fence.
      if (nextFences) {
        const retained = cache.get(`${run.run}:${found}`)?.nextFence;
        if (retained !== undefined) nextFences.set(found + 1, retained);
      }
      return found;
    });
  }
  const lastPage = (run, key, { strict = false, from = 0 } = {}) => lastPages(run, [{ key, strict, from }])[0];
  function loadRun(row, keepFilter) {
    const filter = keepFilter && row.filter_bits > 0 ? loadFilter(row) : null;
    return { run: row.run, age: row.age, pages: row.pages, keys: row.keys, bytes: row.bytes, last: JSON.parse(row.last), first: row.pages ? fenceOf(row, 0) : '', filter, filterBits: row.filter_bits };
  }
  function loadCatalog() {
    const held = new Map(runs.map(run => [run.run, run]));
    const current = [];
    let filterBytes = mergeFilterBytes();
    let omittedFilters = 0;
    for (const row of sql.exec(`SELECT run, age, pages, keys, bytes, last, filter_bits FROM ${RUNS} ORDER BY age DESC, run DESC`)) {
      const keepFilter = row.filter_bits > 0 && filterBytes + row.filter_bits / 8 <= settings.filter_bytes;
      const previous = held.get(row.run);
      // A merge can free filter memory while this store remains open. Rehydrate an older
      // run's omitted filter when it now fits, without reading its first key again.
      const run = previous
        ? keepFilter ? (previous.filter ? previous : { ...previous, filter: loadFilter(row) }) : { ...previous, filter: null, filterBits: row.filter_bits }
        : loadRun(row, keepFilter);
      if (run.filter) filterBytes += run.filter.byteLength;
      else if (row.filter_bits > 0) omittedFilters += 1;
      current.push(run);
    }
    runs = current;
    if (omittedFilters) console.warn('kept runs filters omitted to bound memory', { prefix, runs: runs.length, omitted_filters: omittedFilters, filter_bytes: filterBytes });
  }
  loadCatalog();

  // ---- page cache -----------------------------------------------------------------------------------------------------
  const cache = new Map();
  let cacheBytes = 0;
  // The first and last key of each cached page of a run, in key order ({ first, last, page }), so a key that falls
  // inside a page already cached is placed without a search: the keys of one page lie between its first and last key,
  // and no other page's do. It holds a pair of keys for a cached page, never one for a page that is not cached (an
  // entry whose page was evicted is dropped when met, and the list is trimmed when it outgrows the cache).
  // A resident entry may own one separately charged successor fence; spans
  // never own those proofs, so page eviction releases them immediately.
  const spans = new Map();
  function noteSpan(name, page) {
    if (!page?.keys?.length) return;
    const [run, number] = name.split(':').map(Number);
    if (!Number.isInteger(number)) return;
    const list = spans.get(run) ?? [];
    if (list.length > cache.size + 32) list.splice(0, list.length, ...list.filter(span => cache.has(`${run}:${span.page}`)));
    let lo = 0;
    let hi = list.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (list[mid].first < page.keys[0]) lo = mid + 1; else hi = mid; }
    if (list[lo]?.page === number) return;
    list.splice(lo, 0, { first: page.keys[0], last: page.keys[page.keys.length - 1], page: number });
    spans.set(run, list);
  }
  // The cached page that settles lastPage(run, key, { strict }), or undefined when no cached page does.
  function coveringPage(run, key, strict) {
    const list = spans.get(run.run);
    if (!list) return undefined;
    let lo = 0;
    let hi = list.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (strict ? list[mid].first < key : list[mid].first <= key) lo = mid + 1; else hi = mid; }
    const span = list[lo - 1];
    if (!span) return undefined;
    const resident = cache.get(`${run.run}:${span.page}`);
    if (!resident) { list.splice(lo - 1, 1); return undefined; }
    if (key > span.last) {
      // The predecessor may own the next immutable fence even when its body
      // was rightly not read. The proof is charged to this resident entry.
      if (resident.nextFence !== undefined && (strict ? key <= resident.nextFence : key < resident.nextFence)) return span.page;
      // Adjacent resident pages also prove the fence throughout their gap. A
      // strict seek at the next page's first key still belongs to this page.
      const next = list[lo];
      if (!next || next.page !== span.page + 1
        || !cache.has(`${run.run}:${next.page}`)
        || (strict ? key > next.first : key >= next.first)) return undefined;
    }
    return span.page;
  }
  // Replacement and invalidation release exactly the bytes owned by this entry.
  // A decoder may reenter a grouped read before its preselected page is seeded.
  function forgetCached(key) {
    const previous = cache.get(key);
    if (!previous) return;
    cache.delete(key);
    cacheBytes -= previous.bytes;
  }
  function cached(key, load, bytesOf) {
    const hit = cache.get(key);
    if (hit) { cache.delete(key); cache.set(key, hit); return hit.value; }
    const value = load();
    const bytes = bytesOf(value);
    if (bytes > settings.cache_bytes) return value;
    forgetCached(key);
    cache.set(key, { value, bytes });
    cacheBytes += bytes;
    while (cacheBytes > settings.cache_bytes && cache.size > 1) {
      const [oldest] = cache.entries().next().value;
      forgetCached(oldest);
    }
    noteSpan(key, value);
    return value;
  }
  function seed(key, value, bytes) {
    if (bytes > settings.cache_bytes / 4) return;
    forgetCached(key);
    cache.set(key, { value, bytes });
    cacheBytes += bytes;
    while (cacheBytes > settings.cache_bytes && cache.size > 1) {
      const [oldest] = cache.entries().next().value;
      forgetCached(oldest);
    }
    noteSpan(key, value);
  }
  const dropCached = run => {
    spans.delete(run);
    for (const key of [...cache.keys()]) if (key.startsWith(`${run}:`)) forgetCached(key);
  };
  const pageOf = (run, page, body) => cached(`${run.run}:${page}`, () => {
    if (body !== undefined) return decodePage(body, parseJson);
    // An earlier run can hold a large page. toArray() asks SQLite to materialize the entire result and can exceed
    // the Durable Object's result limit even for this keyed lookup; take its one row from the cursor directly.
    let row;
    for (const found of sql.exec(`SELECT body FROM ${runTable(run.run)} WHERE page = ?`, page)) { row = found; break; }
    if (!row) throw new Error(`Page ${page} of ${runTable(run.run)} is missing.`);
    return decodePage(row.body, parseJson);
  }, value => value.bytes);
  // Keep at most one already-validated successor fence on the existing page
  // cache entry. Replacement, eviction, dropCached and reload release its bytes
  // with that page; no proof outlives its resident immutable predecessor.
  function noteSuccessor(run, page, fence) {
    if (typeof fence !== 'string' || page + 1 >= run.pages) return;
    const resident = cache.get(`${run.run}:${page}`);
    const last = resident?.value?.keys?.at(-1);
    if (last === undefined || fence <= last || resident.nextFence === fence) return;
    const bytes = 64 + fence.length * 2;
    const previous = resident.nextFenceBytes ?? 0;
    if (resident.bytes - previous + bytes > settings.cache_bytes) return;
    resident.nextFence = fence; resident.nextFenceBytes = bytes;
    resident.bytes += bytes - previous; cacheBytes += bytes - previous;
    // Preserve the cache's admission bound and existing LRU order. A metadata
    // addition is not a new page or an independent resident fence registry.
    while (cacheBytes > settings.cache_bytes && cache.size > 1) {
      const [oldest] = cache.entries().next().value;
      forgetCached(oldest);
    }
  }
  // Whether a run may hold `key`, by its membership filter: resident, or one block row of a blocked filter read through
  // the page cache; a run with neither may hold anything.
  function mayHold(run, key) {
    if (run.filter) return filterHas(run.filter, run.filterBits, key);
    if (!(run.filterBits < 0)) return true;
    hash(key);
    const block = hashA % -run.filterBits;
    const row = Math.floor(block / FILTER_ROW_BLOCKS);
    const sought = hashB;
    const bits = cached(`${run.run}:f${row}`, () => {
      for (const found of sql.exec(`SELECT body FROM ${runTable(run.run)} WHERE page = ?`, -1 - row)) return typeof found.body === 'string' ? Uint8Array.from(atob(found.body), c => c.charCodeAt(0)) : new Uint8Array(found.body);
      return null;
    }, value => (value?.byteLength ?? 0) + 64);
    if (!bits) return true;
    hashB = sought;
    return blockBits(bits, (block % FILTER_ROW_BLOCKS) * BLOCK_BYTES, false);
  }
  const bigOf = ref => cached(`big:${ref}`, () => {
    const parts = all(`SELECT body FROM ${BIG} WHERE ref = ? ORDER BY part`, ref);
    if (!parts.length) throw new Error(`A kept value (${ref}) is missing.`);
    const text = parts.map(part => part.body).join('');
    return { value: parseJson(text, { kind: 'big', ref }), length: text.length };
  }, value => 64 + value.length * 3).value;
  // Multipart parts have a fixed maximum, not a fixed size. Charging a 2 KiB
  // value as a full 1 MiB part repeatedly split small grouped reads. UTF-8 byte
  // length safely bounds the UTF-16 character count without materializing it.
  const bigChars = ref => {
    const held = cache.get(`big:${ref}`);
    if (held) return held.value.length;
    for (const row of sql.exec(`SELECT COALESCE(SUM(length(CAST(body AS BLOB))), 0) AS chars FROM ${BIG} WHERE ref = ?`, ref)) return row.chars;
    return 0;
  };
  // An entry's value: undefined for a tombstone.
  const valueOf = entry => (entry.length === 1 ? TOMB : entry.length === 3 ? bigOf(entry[1]) : entry[1]);

  function runGet(run, key, { value_budget = null, page_budget = null } = {}) {
    if (key < run.first || key > run.last || !mayHold(run, key)) return undefined;
    const bodies = new Map();
    const page = lastPages(run, [{ key, strict: false, from: 0 }], bodies)[0];
    if (page < 0) return undefined;
    if (page_budget) { if (page_budget.remaining <= 0) throw new KeptRangeBudgetExceeded(); page_budget.remaining -= 1; }
    const found = pageOf(run, page, bodies.get(page));
    const at = floorIndex(found.keys, key);
    if (at >= 0 && found.keys[at] === key && value_budget && !found.tomb(at)) {
      const big = found.big(at), chars = big ? bigChars(big[0]) : found.chars(at);
      if (chars > value_budget.remaining) throw new KeptRangeBudgetExceeded();
      value_budget.remaining -= chars;
    }
    return at >= 0 && found.keys[at] === key ? valueOf(found.entry(at)) : undefined;
  }

  // A cursor over one source's entries in [lo, hi), forward or reverse: { peek() -> [key, value|TOMB] | null, next() }.
  function memCursor(lo, hi, reverse) {
    const keys = sortedMemKeys();
    let index = reverse ? ceilIndex(keys, hi) - 1 : ceilIndex(keys, lo);
    const inside = key => key >= lo && key < hi;
    return {
      peek() { const key = keys[index]; return key !== undefined && inside(key) ? [key, mem.get(key)] : null; },
      next() { index += reverse ? -1 : 1; },
      seek(nextLo, nextHi) {
        lo = nextLo; hi = nextHi;
        index = reverse ? ceilIndex(keys, hi) - 1 : ceilIndex(keys, lo);
      },
    };
  }
  // Cursor heads never own decoded values. Range reads reuse one winning page;
  // streaming walks may use a fixed byte-bounded workspace for interleaved winners.
  // An oversized accepted legacy page still fits in the single winning-page slot.
  function cursorValues({ workspace_bytes = 0 } = {}) {
    let heldRun, heldPage, entries, bytes = 0;
    const pages = new Map();
    const remember = (run, page, decoded) => {
      heldRun = run; heldPage = page; entries = decoded;
      if (!workspace_bytes || decoded.bytes > workspace_bytes) return;
      const key = `${run.run}:${page}`, old = pages.get(key);
      if (old) { pages.delete(key); bytes -= old.bytes; }
      pages.set(key, decoded); bytes += decoded.bytes;
      while (bytes > workspace_bytes) {
        const [first, value] = pages.entries().next().value;
        pages.delete(first); bytes -= value.bytes;
      }
    };
    const read = (run, page, index) => {
      if (heldRun !== run || heldPage !== page) {
        remember(run, page, pages.get(`${run.run}:${page}`) ?? pageOf(run, page));
      }
      return valueOf(entries.entry(index));
    };
    read.remember = remember;
    return read;
  }
  // Persisted heads keep an immutable location; decoded pages belong to the bounded LRU
  // or the operation's single winning-page workspace.
  function runCursor(run, lo, hi, reverse, readValue = (source, number, at) => valueOf(pageOf(source, number).entry(at))) {
    let page;
    const bodies = new Map();
    const nextFences = new Map();
    let keys = [], tombs = new Uint8Array(0);
    let length = 0, first = null, last = null;
    let index = 0;
    // The entry at the cursor, parsed once however many times it is peeked.
    let head;
    let headAt = -1;
    // This closure never captures the transient decoded entries object.
    const valueAt = (number, at) => () => readValue(run, number, at);
    const headOf = () => {
      headAt = index;
      const key = keys[index];
      head = key !== undefined && key >= lo && key < hi ? [key, valueAt(page, index), Boolean(tombs[index])] : null;
    };
    const load = (atBound = false) => {
      const entries = page >= 0 && page < run.pages ? pageOf(run, page, bodies.get(page)) : null;
      bodies.clear();
      if (entries && !reverse) noteSuccessor(run, page, nextFences.get(page + 1));
      if (entries) readValue.remember?.(run, page, entries);
      keys = entries?.keys ?? [];
      tombs = Uint8Array.from(keys, (_, at) => Number(entries.tomb(at)));
      length = keys.length; first = keys[0] ?? null; last = keys.at(-1) ?? null;
      index = atBound ? (reverse ? ceilIndex(keys, hi) - 1 : ceilIndex(keys, lo)) : reverse ? length - 1 : 0;
      headOf();
    };
    if (reverse) {
      page = lastPages(run, [{ key: hi, strict: true, from: 0 }], bodies)[0];
      load(true);
    } else {
      page = Math.max(0, lastPages(run, [{ key: lo, strict: false, from: 0 }], bodies, nextFences)[0]);
      load(true);
    }
    const settle = () => {
      while (length && (index < 0 || index >= length)) {
        const nextPage = page + (reverse ? -1 : 1);
        if (!reverse && nextFences.has(nextPage) && nextFences.get(nextPage) >= hi) {
          // The immutable next page begins outside this range. Keep this
          // value-free proof for a later seek that changes the group bounds.
          head = null; headAt = index;
          return;
        }
        page = nextPage;
        load();
      }
    };
    return {
      peek() {
        if (headAt === index && index >= 0 && index < length) return head;
        settle();
        if (!length) return null;
        if (headAt !== index) headOf();
        return head;
      },
      next() { index += reverse ? -1 : 1; head = null; },
      // Group bounds advance monotonically. Keep this cursor's value-free metadata
      // when the new bound falls inside it; otherwise seek from its frontier.
      seek(nextLo, nextHi) {
        // Raising a forward lower bound cannot change a head already beyond
        // it. Retain that frontier, including when it is in a later page/run;
        // re-seeking it for every earlier group otherwise rereads future runs.
        if (!reverse && nextHi === hi && nextLo >= lo && headAt === index
          && index >= 0 && index < length && head?.[0] >= nextLo) {
          lo = nextLo;
          return;
        }
        const previous = reverse ? hi : lo;
        lo = nextLo; hi = nextHi;
        if (run.last < lo || run.first >= hi) { keys = []; tombs = new Uint8Array(0); length = 0; page = -1; head = null; headAt = -1; return; }
        const bound = reverse ? hi : lo;
        const inside = length && bound >= first && bound <= last;
        if (inside) {
          index = reverse ? ceilIndex(keys, hi) - 1 : ceilIndex(keys, lo);
          headOf();
        } else {
          const from = bound >= previous ? Math.max(0, Math.min(page, run.pages - 1)) : 0;
          nextFences.clear();
          page = lastPages(run, [{ key: bound, strict: reverse, from }], bodies, reverse ? null : nextFences)[0];
          if (!reverse) page = Math.max(0, page);
          load(true);
        }
      },
    };
  }

  // Ordered walks retain only keys and deletion bits per run. Decoded values
  // share the operation's single winning-page workspace and the bounded LRU.
  // Stream each uncached span with one SQLite cursor rather than a point query
  // for every entry; release that cursor when the generator stops early.
  function runWalkCursor(run, lo, hi, readValue) {
    let page = Math.max(0, lastPage(run, lo));
    const last = lastPage(run, hi, { strict: true, from: page });
    let rows;
    let rowsThrough = -1;
    let keys = [], tombs = new Uint8Array(0);
    let index = 0;
    let firstPage = true;
    let head;
    let headAt = -1;
    const valueAt = (number, at) => () => readValue(run, number, at);
    const closeRows = () => {
      const cursor = rows;
      rows = null;
      // Hosts without IteratorClose must exhaust the physical statement.
      // The query below has bounded read-ahead, so early return cannot drain a run.
      if (typeof cursor?.return === 'function') cursor.return();
      else if (cursor) while (!cursor.next().done) {}
    };
    const close = () => { closeRows(); keys = []; tombs = new Uint8Array(0); head = null; headAt = -1; };
    const load = () => {
      if (page > last) { close(); return; }
      const name = `${run.run}:${page}`;
      let entries;
      if (cache.has(name)) {
        closeRows();
        entries = pageOf(run, page);
      } else {
        if (!rows) {
          rowsThrough = page;
          const windowEnd = Math.min(last, page + 15);
          while (rowsThrough < windowEnd && !cache.has(`${run.run}:${rowsThrough + 1}`)) rowsThrough += 1;
          rows = sql.exec(`SELECT page, body FROM ${runTable(run.run)} WHERE page >= ? AND page <= ? ORDER BY page`, page, rowsThrough)[Symbol.iterator]();
        }
        const row = rows.next();
        if (row.done || row.value.page !== page) throw new Error(`Page ${page} of ${runTable(run.run)} is missing.`);
        entries = decodePage(row.value.body, parseJson);
        seed(name, entries, entries.bytes);
        if (page === rowsThrough) closeRows();
      }
      readValue.remember(run, page, entries);
      keys = entries.keys;
      tombs = Uint8Array.from(keys, (_, at) => Number(entries.tomb(at)));
      index = firstPage ? ceilIndex(keys, lo) : 0;
      firstPage = false;
      head = null; headAt = -1;
    };
    try { load(); } catch (error) { close(); throw error; }
    const settle = () => { while (keys.length && index >= keys.length) { page += 1; load(); } };
    return {
      peek() {
        settle();
        if (!keys.length) return null;
        const key = keys[index];
        if (key >= hi) { close(); return null; }
        if (headAt !== index) {
          head = [key, valueAt(page, index), Boolean(tombs[index])];
          headAt = index;
        }
        return head;
      },
      next() { index += 1; head = null; },
      close,
    };
  }

  // Entries in [lo, hi), merged newest-wins, tombstones left out; reverse walks down from hi. limit bounds the work.
  function range(lo, hi, { reverse = false, limit = Infinity, readValue = null } = {}) {
    const openValue = cursorValues();
    const sources = [memCursor(lo, hi, reverse), ...runs.filter(run => !(run.last < lo || run.first >= hi)).map(run => runCursor(run, lo, hi, reverse, openValue))];
    const out = [];
    while (out.length < limit) {
      let best = null;
      let bestAt = -1;
      for (let at = 0; at < sources.length; at += 1) {
        const head = sources[at].peek();
        if (!head) continue;
        if (best === null || (reverse ? head[0] > best[0] : head[0] < best[0])) { best = head; bestAt = at; }
      }
      if (best === null) break;
      for (let at = 0; at < sources.length; at += 1) {
        if (at === bestAt) continue;
        const head = sources[at].peek();
        if (head && head[0] === best[0]) sources[at].next();
      }
      // Only the newest winning entry is opened. Older large values and their JSON never need reading to skip them.
      // Key-only selections use the newest head's tombstone metadata, as walk()
      // does, without reopening its page or fetching a spilled value.
      const wanted = !readValue || readValue(best[0]);
      const tombstone = bestAt === 0 ? best[1] === TOMB : best[2];
      const value = wanted ? (bestAt === 0 ? best[1] : best[1]()) : undefined;
      sources[bestAt].next();
      if (!tombstone && value !== TOMB) out.push([best[0], value]);
    }
    return out;
  }

  // One last live key per disjoint prefix group. A cursor holds value-free key
  // and tombstone metadata per direction per run, including with cache_bytes=0.
  // Bounds jump over retained history; newest-wins tombstones still determine
  // the last live key, and only that winning value is opened.
  function groupHeads(lo, hi, { groupEnd, include = () => true } = {}) {
    const readValue = cursorValues();
    const liveRuns = runs.filter(run => !(run.last < lo || run.first >= hi));
    const forward = [memCursor(lo, hi, false), ...liveRuns.map(run => runCursor(run, lo, hi, false, readValue))];
    const backward = new Array(forward.length);
    const winner = (sources, reverse) => {
      let best = null, at = -1;
      for (let n = 0; n < sources.length; n += 1) {
        const head = sources[n]?.peek();
        if (head && (best === null || (reverse ? head[0] > best[0] : head[0] < best[0]))) { best = head; at = n; }
      }
      return best === null ? null : { head: best, at };
    };
    const advance = (sources, picked) => {
      for (let n = 0; n < sources.length; n += 1) {
        const head = sources[n]?.peek();
        if (head && head[0] === picked.head[0]) sources[n].next();
      }
    };
    const removed = picked => picked.at === 0 ? picked.head[1] === TOMB : picked.head[2];
    const out = [];
    for (;;) {
      const first = winner(forward, false);
      if (!first) break;
      const end = groupEnd(first.head[0]);
      if (!(end > first.head[0] && end <= hi)) throw new Error('A kept group must advance within its range.');
      if (include(first.head[0])) {
        // Even if the first key is a tombstone, the group can have a live
        // predecessor of its newest key. Reverse selection reconciles all runs.
        const activeBackward = new Array(forward.length);
        for (let n = 0; n < forward.length; n += 1) {
          // This source's forward head is its first key at or after the
          // group's lower bound, including tombstones. A head past the end
          // proves there is no key here. Sparse overlapping runs otherwise
          // reopened a reverse fence search for every group in their gaps.
          const head = forward[n].peek();
          if (!head || head[0] >= end) continue;
          if (backward[n]) backward[n].seek(first.head[0], end);
          else backward[n] = n === 0 ? memCursor(first.head[0], end, true) : runCursor(liveRuns[n - 1], first.head[0], end, true, readValue);
          activeBackward[n] = backward[n];
        }
        for (;;) {
          const last = winner(activeBackward, true);
          if (!last) break;
          if (groupEnd(last.head[0]) !== end) break;
          if (!removed(last)) { out.push([last.head[0], last.at === 0 ? last.head[1] : last.head[1]()]); break; }
          advance(activeBackward, last);
        }
      }
      for (const cursor of forward) cursor.seek(end, hi);
    }
    return out;
  }

  // Existence does not need the first key in order. Inspect newest sources
  // lazily, stopping at any live winner rather than opening every run's head.
  function hasRange(lo, hi) {
    if (lo >= hi) return false;
    const removed = new Set();
    const memory = memCursor(lo, hi, false);
    for (let head; (head = memory.peek()); memory.next()) {
      if (head[1] !== TOMB) return true;
      removed.add(head[0]);
    }
    for (const run of runs) {
      if (run.last < lo || run.first >= hi) continue;
      const cursor = runCursor(run, lo, hi, false);
      for (let head; (head = cursor.peek()); cursor.next()) {
        if (removed.has(head[0])) continue;
        if (!head[2]) return true;
        removed.add(head[0]);
      }
    }
    return false;
  }

  // readValue can pass over a winning key's value while still yielding that live key with undefined. A rejected
  // tombstone is omitted as usual. This lets callers count/page keys without opening large values they do not need.
  function* walk(lo, hi, { readValue = null } = {}) {
    const openValue = cursorValues({ workspace_bytes: 1024 * 1024 });
    const sources = [memCursor(lo, hi, false)];
    try {
      for (const run of runs) if (!(run.last < lo || run.first >= hi)) sources.push(runWalkCursor(run, lo, hi, openValue));
      for (;;) {
        let best = null;
        let bestAt = -1;
        for (let at = 0; at < sources.length; at += 1) {
          const head = sources[at].peek();
          if (!head) continue;
          if (best === null || head[0] < best[0]) { best = head; bestAt = at; }
        }
        if (best === null) return;
        for (let at = 0; at < sources.length; at += 1) {
          if (at === bestAt) continue;
          const head = sources[at].peek();
          if (head && head[0] === best[0]) sources[at].next();
        }
        // The predicate runs after newest-wins selection, before any value read. The tombstone bit is in the page
        // header, so even a rejected deleted key is skipped without opening its value.
        const wanted = !readValue || readValue(best[0]);
        const value = wanted ? (bestAt === 0 ? best[1] : best[1]()) : undefined;
        const tombstone = bestAt === 0 ? best[1] === TOMB : best[2];
        sources[bestAt].next();
        if (!tombstone && value !== TOMB) yield [best[0], value];
      }
    } finally {
      let closeError;
      for (const source of sources) {
        try { source.close?.(); } catch (error) { closeError ??= error; }
      }
      if (closeError) throw closeError;
    }
  }

  // The first live page of each requested range. Seek every range together, but
  // retain only a small group of cursor pages and merge newest-wins before
  // counting results. Reading an entire recipient's index then slicing its first
  // twenty entries makes a greeting grow with all of that recipient's saved work.
  function limitedRanges(bounds, { limit_per_range, value_budget, page_budget, entry_budget }) {
    const windows = bounds.filter(({ lo, hi }) => lo < hi).sort((a, b) => a.lo < b.lo ? -1 : a.lo > b.lo ? 1 : 0);
    if (!windows.length || limit_per_range === 0) return [];
    const debit = budget => {
      if (!budget) return;
      if (budget.remaining <= 0) throw new KeptRangeBudgetExceeded();
      budget.remaining -= 1;
    };
    const sources = runs.map(run => {
      const indexes = windows.map((window, at) => ({ ...window, at })).filter(({ lo, hi }) => !(run.last < lo || run.first >= hi));
      const nextFences = new Map();
      const starts = new Map();
      const firstProbe = indexes.length ? { key: indexes[0].lo, strict: false, from: 0 } : null;
      if (firstProbe && settledPage(run, firstProbe) === undefined) {
        // A cold pilot would add a seek for scattered ranges and move an
        // eight-probe batch below its shared-fence threshold. Keep one batch.
        const pages = lastPages(run, indexes.map(({ lo }) => ({ key: lo, strict: false, from: 0 })), null, nextFences);
        for (let at = 0; at < indexes.length; at += 1) starts.set(indexes[at].at, Math.max(0, pages[at]));
      } else if (indexes.length) {
        // Resolve the first selected bound separately. Its already-validated successor fence proves every later
        // bound below that fence starts on the same page, without another seek through unrelated run history.
        const [first, ...rest] = indexes;
        const [found] = lastPages(run, [{ key: first.lo, strict: false, from: 0 }], null, nextFences);
        const page = Math.max(0, found);
        starts.set(first.at, page);
        const successor = nextFences.get(found + 1);
        const unresolved = [];
        for (const index of rest) {
          if (successor !== undefined && index.lo < successor) starts.set(index.at, page);
          else unresolved.push(index);
        }
        if (unresolved.length) {
          const pages = lastPages(run, unresolved.map(({ lo }) => ({ key: lo, strict: false, from: page })), null, nextFences);
          for (let at = 0; at < unresolved.length; at += 1) starts.set(unresolved[at].at, Math.max(0, pages[at]));
        }
      }
      return { run, nextFences, starts };
    }).filter(source => source.starts.size > 0);
    const found = new Map();
    // Group by the distinct pages these windows actually start on. Unrelated
    // runs need no cursor and must not shrink a group into repeated page reads.
    // Keep at most 16 windows or 32 starting pages, except when one window alone
    // intersects more than 32 runs (the same bound as a single range read).
    for (let from = 0; from < windows.length;) {
      const startingPages = new Set();
      let through = from;
      while (through < windows.length && through - from < 16) {
        const added = new Set();
        for (const { run, starts } of sources) if (starts.has(through)) added.add(`${run.run}:${starts.get(through)}`);
        let extra = 0;
        for (const page of added) if (!startingPages.has(page)) extra += 1;
        if (through > from && startingPages.size + extra > 32) break;
        for (const page of added) startingPages.add(page);
        through += 1;
      }
      const group = windows.slice(from, through).map(window => ({ window, cursors: [memCursor(window.lo, window.hi, false)] }));
      for (const { run, starts, nextFences } of sources) {
        const pages = new Map();
        const missing = [];
        const numbers = [...new Set(group.flatMap((_, at) => starts.has(from + at) ? [starts.get(from + at)] : []))];
        for (const page of numbers) {
          debit(page_budget);
          const held = cache.get(`${run.run}:${page}`);
          if (held) pages.set(page, held.value); else missing.push(page);
        }
        for (let at = 0; at < missing.length; at += 64) {
          const asked = missing.slice(at, at + 64);
          let read = 0;
          for (const row of sql.exec(`SELECT page, body FROM ${runTable(run.run)} WHERE page IN (SELECT value FROM json_each(?)) ORDER BY page`, JSON.stringify(asked))) {
            const page = decodePage(row.body, parseJson);
            pages.set(row.page, page);
            seed(`${run.run}:${row.page}`, page, page.bytes);
            read += 1;
          }
          if (read !== asked.length) throw new Error(`A page of ${runTable(run.run)} is missing.`);
        }
        for (const page of numbers) noteSuccessor(run, page, nextFences.get(page + 1));
        for (let at = 0; at < group.length; at += 1) {
          if (!starts.has(from + at)) continue;
          const { window, cursors } = group[at];
          let page = starts.get(from + at);
          let entries = pages.get(page);
          let index = ceilIndex(entries.keys, window.lo);
          cursors.push({
            peek() {
              while (entries && index >= entries.length) {
                page += 1;
                if (page >= run.pages) { entries = null; break; }
                // A verified immutable fence proves this page and all later
                // pages lie beyond this window, before any body/budget charge.
                if (nextFences.has(page) && nextFences.get(page) >= window.hi) { entries = null; break; }
                debit(page_budget);
                entries = pageOf(run, page);
                index = 0;
              }
              if (!entries || entries.keys[index] >= window.hi) return null;
              // Decode only the newest winning value, never an older large one.
              const here = entries, hereAt = index;
              return [here.keys[hereAt], () => {
                if (value_budget && !here.tomb(hereAt)) {
                  const big = here.big(hereAt);
                  const chars = big ? bigChars(big[0]) : here.chars(hereAt);
                  if (chars > value_budget.remaining) throw new KeptRangeBudgetExceeded();
                  value_budget.remaining -= chars;
                }
                return valueOf(here.entry(hereAt));
              }];
            },
            next() { index += 1; },
          });
        }
      }
      for (const { cursors } of group) {
        let count = 0;
        while (count < limit_per_range) {
          let best = null, bestAt = -1;
          for (let at = 0; at < cursors.length; at += 1) {
            const head = cursors[at].peek();
            if (head && (best === null || head[0] < best[0])) { best = head; bestAt = at; }
          }
          if (best === null) break;
          for (let at = 0; at < cursors.length; at += 1) {
            const head = at === bestAt ? null : cursors[at].peek();
            if (head && head[0] === best[0]) cursors[at].next();
          }
          cursors[bestAt].next();
          debit(entry_budget);
          const value = bestAt === 0 ? best[1] : best[1]();
          if (value === TOMB) continue;
          count += 1;
          found.set(best[0], value);
        }
        // Drop page references as soon as this prefix is complete, before the
        // next group opens another set of pages in a zero-cache store.
        cursors.length = 0;
      }
      from = through;
    }
    return [...found].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  }

  // Several disjoint key ranges in one pass over each run. A screen can ask for hundreds of exact index prefixes;
  // opening a cursor on every run for every prefix repeats the same SQLite page reads thousands of times.
  function ranges(bounds, { value_budget = null, page_budget = null, entry_budget = null, limit_per_range = Infinity, resident_exact_points = false, preserve_exact_progress = false } = {}) {
    if (Number.isFinite(limit_per_range) && limit_per_range >= 0) return limitedRanges(bounds, { value_budget, page_budget, entry_budget, limit_per_range: Math.floor(limit_per_range) });
    const windows = bounds.filter(({ lo, hi }) => lo < hi).sort((a, b) => a.lo < b.lo ? -1 : a.lo > b.lo ? 1 : 0)
      .reduce((out, window) => {
        const last = out.at(-1);
        if (last && window.lo <= last.hi) last.hi = window.hi > last.hi ? window.hi : last.hi;
        else out.push({ ...window });
        return out;
      }, []);
    if (!windows.length) return [];
    const wanted = key => { const at = floorIndex(windows, key, window => window.lo); return at >= 0 && key < windows[at].hi; };
    // Page-budget admission must happen before any body is fetched. The fused point query fetches its body with
    // the fence, so retain grouped admission whenever the caller supplies a page budget.
    const exactPoints = resident_exact_points && page_budget === null && windows.every(({ lo, hi }) => hi === `${lo}\u0000`);
    const found = new Map();
    const keep = (key, value) => {
      if (found.has(key)) return;
      if (entry_budget) {
        if (entry_budget.remaining <= 0) throw new KeptRangeBudgetExceeded();
        entry_budget.remaining -= 1;
      }
      found.set(key, value);
    };
    const progressAllowed = preserve_exact_progress && windows.every(({ lo, hi }) => hi === `${lo}\u0000`);
    try {
      const memoryKeys = sortedMemKeys();
      for (const { lo, hi } of windows) {
        for (let at = ceilIndex(memoryKeys, lo); at < memoryKeys.length && memoryKeys[at] < hi; at += 1) {
          const key = memoryKeys[at];
          keep(key, mem.get(key));
        }
      }
      for (const run of runs) {
        // A resident filter already rejects unrelated roots without SQL. Its exact winners are cheaper through
        // the fused fence/body point query; retain grouped pages for unfiltered or stored-block membership runs.
        if (exactPoints && run.filter) {
          for (const { lo } of windows) if (!found.has(lo)) {
            const value = runGet(run, lo, { value_budget, page_budget });
            if (value !== undefined) keep(lo, value);
          }
          continue;
        }
        const pageNumbers = new Set();
        const asked = windows.filter(({ lo, hi }) => {
          if (run.last < lo || run.first >= hi) return false;
          // [key, key + NUL) selects exactly one key. A membership filter can
          // reject that lookup before a page is read, just as get() does. A
          // newer value or tombstone also makes older runs irrelevant.
          return !(hi === `${lo}\u0000` && (found.has(lo) || !mayHold(run, lo)));
        });
        // An exact key can occupy only its lower fence's page. General ranges
        // still seek both ends, together in one statement.
        const probes = [];
        const probeAt = asked.map(({ lo, hi }) => {
          const first = probes.push({ key: lo, strict: false, from: 0 }) - 1;
          const last = hi === `${lo}\u0000` ? first : probes.push({ key: hi, strict: true, from: 0 }) - 1;
          return { first, last };
        });
        const sought = lastPages(run, probes);
        for (let at = 0; at < asked.length; at += 1) {
          const first = Math.max(0, sought[probeAt[at].first]);
          const last = sought[probeAt[at].last];
          for (let page = first; page <= last; page += 1) {
            if (pageNumbers.has(page)) continue;
            if (page_budget) {
              if (page_budget.remaining <= 0) throw new KeptRangeBudgetExceeded();
              page_budget.remaining -= 1;
            }
            pageNumbers.add(page);
          }
        }
        const readPage = page => {
          for (let at = 0; at < page.length; at += 1) {
            const key = page.keys[at];
            if (wanted(key) && !found.has(key)) {
              if (value_budget && !page.tomb(at)) {
                const big = page.big(at);
                const chars = big ? bigChars(big[0]) : page.chars(at);
                if (chars > value_budget.remaining) throw new KeptRangeBudgetExceeded();
                value_budget.remaining -= chars;
              }
              keep(key, valueOf(page.entry(at)));
            }
          }
        };
        const missing = [];
        for (const page of [...pageNumbers].sort((a, b) => a - b)) {
          const name = `${run.run}:${page}`;
          const held = cache.get(name);
          if (held) { cache.delete(name); cache.set(name, held); readPage(held.value); }
          else missing.push(page);
        }
        // One streaming statement per group of pages, even when the selected prefixes are far apart.
        for (let at = 0; at < missing.length; at += 64) {
          const group = missing.slice(at, at + 64);
          let read = 0;
          for (const row of sql.exec(`SELECT page, body FROM ${runTable(run.run)} WHERE page IN (SELECT value FROM json_each(?)) ORDER BY page`, JSON.stringify(group))) {
            const page = decodePage(row.body, parseJson);
            seed(`${run.run}:${row.page}`, page, page.bytes);
            readPage(page);
            read += 1;
          }
          if (read !== group.length) throw new Error(`A page of ${runTable(run.run)} is missing.`);
        }
      }
      return [...found].filter(([, value]) => value !== TOMB).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    } catch (error) {
      if (progressAllowed && error instanceof KeptRangeBudgetExceeded) {
        // Only winners already admitted to found are complete. Absence requires
        // a completed traversal, so interrupted progress never names missing keys.
        Object.defineProperty(error, KEPT_RANGE_PROGRESS, { value: {
          accepted: new Map([...found].filter(([, value]) => value !== TOMB)),
          completed: new Set(found.keys()),
        }, enumerable: false });
      }
      throw error;
    }
  }

  function get(key) {
    const held = mem.get(key);
    if (held !== undefined) return held === TOMB ? undefined : held;
    for (const run of runs) {
      const found = runGet(run, key);
      if (found !== undefined) return found === TOMB ? undefined : found;
    }
    return undefined;
  }

  // ---- writing runs ---------------------------------------------------------------------------------------------------
  const nextRun = () => Math.max(0, ...runs.map(run => run.run), meta.get('last_run') ?? 0) + 1;
  // Builds pages from entries given in key order and writes them to a new run table; answers what the catalog keeps.
  function pageWriter(table, filterKeys, run) {
    sql.exec(`CREATE TABLE IF NOT EXISTS ${table} (page INTEGER PRIMARY KEY, first TEXT, body TEXT NOT NULL)`);
    const builder = pageBuilder();
    let keys = 0;
    let bytes = 0;
    let last = null;
    let pages = 0;
    let first = null;
    let pageFirst = null;
    const { filter, bits: bitsSize } = freshFilter(filterKeys);
    const flushPage = () => {
      if (!builder.length) return;
      const { body, page } = builder.finish();
      sql.exec(`INSERT INTO ${table} (page, first, body) VALUES (?, ?, ?)`, pages - 1, JSON.stringify(pageFirst), body);
      bytes += body.length;
      // A page just written is the one most likely read next: it is kept as read, already decoded.
      seed(`${run}:${pages - 1}`, page, page.bytes);
    };
    return {
      // text is the value's JSON (null for a tombstone); big is [ref, parts] for a value kept on its own rows.
      add(key, text, big = null) {
        if (builder.length && (pageLimitOf(key) !== pageLimitOf(builder.first) || builder.wouldOverflow(key, text, big, pageLimitOf(key)))) flushPage();
        if (!builder.length) { pageFirst = key; pages += 1; first ??= key; }
        builder.add(key, text, big);
        if (filter) filterAdd(filter, bitsSize, key);
        keys += 1;
        last = key;
        if (builder.chars >= pageLimitOf(key)) flushPage();
      },
      finish() {
        flushPage();
        if (filter) writeFilter(table, filter);
        return { pages, keys, bytes, last, first, filter, filterBits: bitsSize };
      },
    };
  }
  function writeFilter(table, filter) {
    for (let at = 0, chunk = -1; at < filter.length; at += FILTER_CHUNK, chunk -= 1) {
      sql.exec(`INSERT INTO ${table} (page, first, body) VALUES (?, NULL, ?)`, chunk, filter.subarray(at, Math.min(filter.length, at + FILTER_CHUNK)));
    }
  }
  function storeBig(text, refFor) {
    const ref = refFor();
    let parts = 0;
    for (let at = 0; at < text.length; at += BIG_PART, parts += 1) sql.exec(`INSERT INTO ${BIG} (ref, part, body) VALUES (?, ?, ?)`, ref, parts, text.slice(at, at + BIG_PART));
    return [ref, parts];
  }
  // Adds one memtable entry to a page writer, writing a value too big for a page to its own rows.
  function addEntry(writer, key, value, refFor) {
    if (value === TOMB) { writer.add(key, null); return; }
    const text = JSON.stringify(value);
    if (text.length <= inlineLimit) { writer.add(key, text); return; }
    writer.add(key, null, storeBig(text, refFor));
  }
  const bigRef = () => { const next = (meta.get('big_next') ?? 0) + 1; meta.set('big_next', next); return `b${next}`; };
  // Rewrites one key's value in place in every run that still holds a version of it (transform(value) -> the new value,
  // or undefined to leave it): its page is written again with the same keys in the same order, every other entry's text
  // copied unparsed, and a value kept on its own rows is rewritten there under the same ref. This is how words a host
  // must erase leave versions no merge has let go yet; it costs the pages holding the key, never a merge of the store.
  function rewriteKey(key, transform) {
    let rewritten = 0;
    for (const run of runs) {
      if (key < run.first || key > run.last || !mayHold(run, key)) continue;
      const number = lastPage(run, key);
      if (number < 0) continue;
      const found = pageOf(run, number);
      const at = floorIndex(found.keys, key);
      if (at < 0 || found.keys[at] !== key || found.tomb(at)) continue;
      const next = transform(valueOf(found.entry(at)));
      if (next === undefined) continue;
      const big = found.big(at);
      if (big) {
        sql.exec(`DELETE FROM ${BIG} WHERE ref = ?`, big[0]);
        const [, parts] = storeBig(JSON.stringify(next), () => big[0]);
        if (parts === big[1]) { dropCached(run.run); forgetCached(`big:${big[0]}`); rewritten += 1; continue; }
      }
      const builder = pageBuilder();
      for (let index = 0; index < found.length; index += 1) {
        if (index === at) {
          const text = JSON.stringify(next);
          if (big) builder.add(found.keys[index], null, [big[0], Math.ceil(text.length / BIG_PART)]);
          else builder.add(found.keys[index], text);
        } else if (found.big(index)) builder.add(found.keys[index], null, found.big(index));
        else builder.add(found.keys[index], found.tomb(index) ? null : found.text(index));
      }
      const { body } = builder.finish();
      sql.exec(`UPDATE ${runTable(run.run)} SET body = ? WHERE page = ?`, body, number);
      dropCached(run.run);
      if (big) forgetCached(`big:${big[0]}`);
      rewritten += 1;
    }
    return rewritten;
  }

  // Takes one key out of every run that still holds it, the key's own text with it: for a key whose text holds words a
  // host must erase (an index no longer declared, whose keys were built from a field that is erasable now). Its page is
  // written again without it, the page's fence moved to its new first key and the run's last key moved back when it was
  // either. A page it leaves empty keeps one tombstone instead, under a key just past the previous page's last key (the
  // lowest key at all for a run's first page), so every page still holds a key, the fences stay in order and no text of
  // the key taken out is kept. Costs the pages holding the key, never a merge of the store.
  function dropKey(key) {
    let dropped = 0;
    for (const run of runs) {
      if (key < run.first || key > run.last || !mayHold(run, key)) continue;
      const number = lastPage(run, key);
      if (number < 0) continue;
      const found = pageOf(run, number);
      const at = floorIndex(found.keys, key);
      if (at < 0 || found.keys[at] !== key) continue;
      const big = found.big(at);
      if (big) sql.exec(`DELETE FROM ${BIG} WHERE ref = ?`, big[0]);
      const builder = pageBuilder();
      let first = null;
      let last = null;
      for (let index = 0; index < found.length; index += 1) {
        if (index === at) continue;
        first ??= found.keys[index];
        last = found.keys[index];
        if (found.big(index)) builder.add(found.keys[index], null, found.big(index));
        else builder.add(found.keys[index], found.tomb(index) ? null : found.text(index));
      }
      if (first === null) {
        const lower = number > 0 ? pageOf(run, number - 1).keys.at(-1) : null;
        first = lower === null ? '\u0000' : `${lower}\u0000`;
        last = first;
        builder.add(first, null);
      }
      const { body } = builder.finish();
      sql.exec(`UPDATE ${runTable(run.run)} SET first = ?, body = ? WHERE page = ?`, JSON.stringify(first), body, number);
      if (number === 0) run.first = first;
      if (number === run.pages - 1 && run.last === key) {
        run.last = last;
        sql.exec(`UPDATE ${RUNS} SET last = ? WHERE run = ?`, JSON.stringify(last), run.run);
      }
      dropCached(run.run);
      if (big) forgetCached(`big:${big[0]}`);
      dropped += 1;
    }
    return dropped;
  }

  // Every version of one key the store still holds, newest first (the memtable's, then each run's), a tombstone left
  // out. Reads the pages holding the key and nothing else (an erasure's readback, never a hot read).
  function versions(key) {
    const found = [];
    if (mem.has(key) && mem.get(key) !== TOMB) found.push(mem.get(key));
    for (const run of runs) {
      if (key < run.first || key > run.last || !mayHold(run, key)) continue;
      const number = lastPage(run, key);
      if (number < 0) continue;
      const page = pageOf(run, number);
      const at = floorIndex(page.keys, key);
      if (at < 0 || page.keys[at] !== key || page.tomb(at)) continue;
      found.push(valueOf(page.entry(at)));
    }
    return found;
  }

  function addRun(run, age, written) {
    sql.exec(`INSERT INTO ${RUNS} (run, age, pages, keys, bytes, last, filter_bits) VALUES (?, ?, ?, ?, ?, ?, ?)`, run, age, written.pages, written.keys, written.bytes, JSON.stringify(written.last), written.filterBits);
  }

  /** Writes the memtable as one run and empties it. `covered` (any JSON) is kept in the same transaction as how far the
   *  caller's log the runs now hold (read back with covered()). Answers the run written, or null when empty. */
  function flush({ covered } = {}) {
    if (!mem.size) {
      if (covered !== undefined) meta.set('covered', covered);
      return null;
    }
    const run = nextRun();
    const age = Math.max(0, ...runs.map(item => item.age)) + 1;
    let written;
    transaction(() => {
      const writer = pageWriter(runTable(run), mem.size, run);
      for (const key of sortedMemKeys()) addEntry(writer, key, mem.get(key), bigRef);
      written = writer.finish();
      addRun(run, age, written);
      if (memCompactionDebt) meta.set('compaction_debt', (meta.get('compaction_debt') ?? 0) + memCompactionDebt);
      if (covered !== undefined) meta.set('covered', covered);
    });
    runs.unshift({ run, age, pages: written.pages, keys: written.keys, bytes: written.bytes, last: written.last, first: written.first, filter: written.filter, filterBits: written.filterBits });
    memClear();
    return run;
  }

  // ---- merging --------------------------------------------------------------------------------------------------------
  // The runs to merge next: from the youngest run that starts such a group, that run and, oldest-ward, each next run
  // while it holds no more than size_ratio times the pages of the runs before it in the group, or no more than
  // tier_spread times their average (runs of about one size), when that is fan_in runs or more (merging two at a time copied about 4 pages for each page written out in a model of the owner's store's runs on
  // 2026-10-07; fan_in at a time, about 1.4); else null (a small write-out younger than a large run never stops the runs older than it merging). A run
  // is copied again only beside comparable page work written since it was made, so each copy grows the run
  // a value is in, a value is copied about log2(what the store holds / what its write-out held) times in its life, and
  // what merging writes grows with what changed, never with what the store holds. A large run never rides along with small write-outs: merging
  // the cheapest few adjacent runs whatever their sizes copied the youngest large run every few write-outs (the owner's
  // store, 2026-10-07: 1.42M rows written in a day, the whole store about seventy times over).
  // With `cheapest` (a backlog over max_runs, runs that came in smaller than the one before them each time), the
  // fan_in runs adjacent in age holding the fewest pages, whatever their sizes. Compressed bytes are not a page-copy
  // cost: equally sized pages can compress differently, making byte-based groups repeatedly copy expensive runs.
  // More runs than max_runs: the backlog merges first, the cheapest fan_in at a time (planMerge cheapest).
  const backlog = () => runs.length > Math.max(settings.max_runs, settings.fan_in);
  // Updates can settle into incomparable size tiers; a resumable complete fold drains their obsolete versions.
  // Charge each persisted predecessor once. A flush during the fold retains its own debt at completion.
  const compactionDebt = () => meta.get('compaction_debt') ?? 0;
  const compactionDue = () => runs.length > 1 && compactionDebt() > 0
    && compactionDebt() >= Math.max(settings.compaction_debt_min_bytes, runs.reduce((sum, run) => sum + run.bytes, 0) * settings.compaction_debt_ratio);
  function planMerge({ cheapest = false, tiersOnly = false, excluded = new Set() } = {}) {
    if (cheapest) {
      const byAge = [...runs].sort((a, b) => a.age - b.age);
      let least = null;
      for (let start = 0; start + settings.fan_in <= byAge.length; start += 1) {
        const group = byAge.slice(start, start + settings.fan_in);
        if (group.some(run => excluded.has(run.run))) continue;
        const pages = group.reduce((sum, run) => sum + run.pages, 0);
        if (!least || pages < least.pages) least = { group, pages };
      }
      return least?.group ?? null;
    }
    if (!tiersOnly && compactionDue()) return [...runs].sort((a, b) => a.age - b.age);
    const youngest = [...runs].sort((a, b) => b.age - a.age);
    for (let start = 0; start + 1 < youngest.length; start += 1) {
      let pages = youngest[start].pages;
      let end = start + 1;
      while (end < youngest.length && youngest[end].pages <= Math.max(settings.size_ratio * pages, settings.tier_spread * pages / (end - start))) { pages += youngest[end].pages; end += 1; }
      if (end - start >= Math.max(2, settings.fan_in)) return youngest.slice(start, end);
    }
    return null;
  }
  // The membership filter of the run being merged, held in memory between steps. A step whose transaction rolls back
  // leaves keys in it that the run will not hold; a filter that names too many keys only costs a page read, never a
  // wrong answer. A cold restart of an unfinished merge uses no filter: the output is not read until the merge
  // finishes, and a finished run without a filter still answers correctly. Rebuilding one from all completed output
  // pages can monopolize an account; persisting it after every step would rewrite the whole filter repeatedly.
  function filterFor(state) {
    if (building?.output === state.output) return building;
    const bits = filterSize(state.filter_keys) * 8;
    const residentBytes = residentFilterBytes();
    // The filter is optional. Keep the in-progress one under the same resident
    // filter budget as the published runs, including when a full fold begins.
    const keepFilter = state.pages === 0 && state.after === null && bits / 8 <= Math.max(0, settings.filter_bytes - residentBytes);
    building = { output: state.output, bits, filter: keepFilter ? new Uint8Array(bits / 8) : null };
    return building;
  }
  // The bytes a merge may still add (Infinity where the host reports no size): space_share of the limit, less what the
  // database holds, where pages freed by deletes (the free list) count as room, since SQLite writes into them first.
  function room() {
    const size = Number(sql.databaseSize);
    if (!Number.isFinite(size) || size <= 0) return Infinity;
    let free = 0;
    try {
      const pages = Number(Object.values(all('PRAGMA freelist_count')[0] ?? {})[0]);
      const pageSize = Number(Object.values(all('PRAGMA page_size')[0] ?? {})[0]);
      if (Number.isFinite(pages * pageSize)) free = pages * pageSize;
    } catch { /* a host that refuses the pragma counts no free pages: the room is then smaller, never larger */ }
    return settings.database_limit_bytes * settings.space_share - (size - free);
  }
  // The merge to start next: a backlog's cheapest group first, then a complete fold, then a size-tier merge, the first
  // whose inputs, times space_factor, fit the room left. A merge that does not fit waits, and the cheaper ones still run.
  function nextMerge({ backlogOnly = false, alongside = null } = {}) {
    const excluded = new Set(alongside?.inputs ?? []);
    // Space admitted for the original fold remains reserved while another
    // merge runs beside it. Its partial output is already in databaseSize.
    const reserve = alongside ? Math.max(0, runs.filter(run => excluded.has(run.run)).reduce((sum, run) => sum + run.bytes, 0) * settings.space_factor - alongside.bytes) : 0;
    const candidates = backlogOnly ? [backlog() ? planMerge({ cheapest: true, excluded }) : null]
      : [backlog() ? planMerge({ cheapest: true }) : null, planMerge(), planMerge({ tiersOnly: true })];
    let left = null;
    return candidates.find(group => {
      if (!group) return false;
      left ??= room() - reserve;
      return group.reduce((sum, run) => sum + run.bytes, 0) * settings.space_factor <= left;
    }) ?? null;
  }
  function startMerge(group) {
    const oldest = Math.min(...runs.map(run => run.age));
    const state = { inputs: group.map(run => run.run), output: nextRun(), age: Math.max(...group.map(run => run.age)), drop_tombstones: group.some(run => run.age === oldest), filter_keys: group.reduce((sum, run) => sum + run.keys, 0), after: null, pages: 0, keys: 0, bytes: 0, last: null };
    if (group.length === runs.length) state.compaction_debt_snapshot = compactionDebt();
    transaction(() => { meta.set('merge', state); meta.set('last_run', state.output); });
    return state;
  }
  /** One bounded step of merging (at most max_pages output pages and an input budget based on the source count). */
  function step({ max_pages = 64, max_input_pages = null, hasTime = () => true } = {}) {
    let state = meta.get('merge');
    // Older serving code may finish the secondary while ignoring the paused
    // marker. Its conservative forget mode protects original input references;
    // a later current open can resume the durable original cursor.
    if (!state && meta.get('merge_paused')) {
      transaction(() => { state = { ...meta.get('merge_paused'), backlog_yielded: true }; meta.set('merge', state); meta.remove('merge_paused'); });
    }
    // A long fold pins only its own inputs, not every later write-out. Save it
    // while a disjoint adjacent backlog group drains, then give the original
    // one slice before it may yield again. Both markers survive cold restarts.
    if (state && !meta.get('merge_paused')) {
      const yielded = state.backlog_yielded;
      const group = !yielded ? nextMerge({ backlogOnly: true, alongside: state }) : null;
      if (group) {
        transaction(() => {
          meta.set('merge_paused', { ...state, big_drop_mode_before_pause: meta.get('big_drop_mode') ?? null });
          // Previous implementations understand forget, but not merge_paused.
          // A deployment rollback must never retire original input references.
          meta.set('big_drop_mode', 'forget');
          state = startMerge(group);
        });
        building = null;
      } else if (yielded) delete state.backlog_yielded;
    }
    if (!state) {
      // A backlog of runs merges before obsolete large values are retired: every read probes every run, while a value
      // waiting to be retired only holds storage. Retiring first let 183 runs pile up behind a queue retired 16 parts a
      // wake (the owner's store, 2026-10-10: every take and hand-off read about 20,000 rows). Retiring still waits for
      // no merge to be under way, so a reference is never retired while an input run that holds it is still read.
      const backlogGroup = nextMerge({ backlogOnly: true });
      if (!backlogGroup && cleanupPending()) {
        cleanupBigDrops();
        return { merged: false, more: cleanupPending() || nextMerge() !== null, pages: 0 };
      }
      const group = backlogGroup ?? nextMerge();
      if (!group) return { merged: false, more: false, pages: 0 };
      state = startMerge(group);
    }
    // An earlier version kept these references in the merge marker. Move a small slice into the durable queue
    // before advancing its cursor, so an in-progress merge survives a code update without one giant cleanup wake.
    if (Array.isArray(state.dropped) && state.dropped.length) {
      transaction(() => {
        for (const ref of state.dropped.slice(0, BIG_CLEANUP_REFS)) queueBigDrop(ref);
        state.dropped = state.dropped.slice(BIG_CLEANUP_REFS);
        meta.set('merge', state);
      });
      return { merged: false, more: true, pages: 0 };
    }
    delete state.dropped;
    const inputs = state.inputs.map(number => runs.find(run => run.run === number));
    if (inputs.some(run => !run)) {
      // An input is gone (another store over this database merged it): this merge can never finish, so it starts again.
      // Its queued references may still be used by the surviving input runs, so only forget those queue entries.
      transaction(() => {
        sql.exec(`DROP TABLE IF EXISTS ${runTable(state.output)}`);
        const paused = meta.get('merge_paused');
        if (paused) { meta.set('merge', { ...paused, backlog_yielded: true }); meta.remove('merge_paused'); }
        else meta.remove('merge');
        if (cleanupPending()) meta.set('big_drop_mode', 'forget');
        else meta.remove('big_drop_mode');
      });
      return { merged: false, more: true, pages: 0 };
    }
    // Newest input first, so among equal keys the first source wins.
    inputs.sort((a, b) => b.age - a.age);
    const table = runTable(state.output);
    let done = false;
    let written = 0;
    transaction(() => {
      sql.exec(`CREATE TABLE IF NOT EXISTS ${table} (page INTEGER PRIMARY KEY, first TEXT, body TEXT NOT NULL)`);
      const { filter, bits } = filterFor(state);
      const lo = state.after === null ? '' : `${state.after}\u0000`;
      const defaultInputPages = Math.min(128, max_pages * 2 + inputs.length * 2 + 1);
      // Opening each source may need its fence page and the next page. Permit
      // that minimum even when a full fold has more than 63 source runs.
      const inputPageBudget = Math.max(inputs.length * 2 + 1,
        Math.min(128, Number.isSafeInteger(max_input_pages) && max_input_pages > 0 ? max_input_pages : defaultInputPages));
      const inputPageLimit = Symbol('merge input page limit');
      let inputPages = 0;
      const beforeInputPage = () => {
        if (inputPages >= inputPageBudget) throw inputPageLimit;
        inputPages += 1;
      };
      const cursors = inputs.map(run => rawCursor(run, lo, beforeInputPage));
      let pagesThisStep = 0;
      const builder = pageBuilder();
      let lastKey = null;
      const writePage = () => {
        const keysHere = builder.length;
        const first = builder.first;
        const { body } = builder.finish();
        sql.exec(`INSERT INTO ${table} (page, first, body) VALUES (?, ?, ?)`, state.pages, JSON.stringify(first), body);
        state.pages += 1;
        state.keys += keysHere;
        state.bytes += body.length;
        state.after = lastKey;
        state.last = lastKey;
        pagesThisStep += 1;
      };
      let stopped = false;
      let visited = 0;
      for (;;) {
        if (visited > 0 && (visited % 64) === 0 && !hasTime()) { stopped = true; break; }
        let best = null;
        let bestAt = -1;
        try {
          for (let at = 0; at < cursors.length; at += 1) {
            const head = cursors[at].key();
            if (head !== null && (best === null || head < best)) { best = head; bestAt = at; }
          }
        } catch (error) {
          if (error !== inputPageLimit) throw error;
          stopped = true;
          break;
        }
        if (best === null) break;
        const winner = cursors[bestAt];
        const tomb = winner.tomb();
        const big = winner.big();
        const text = tomb || big ? null : winner.text();
        const spill = text !== null && text.length > inlineLimit;
        const inlineText = spill ? null : text;
        const pageBig = spill ? ['b999999999999999', Math.ceil(text.length / BIG_PART)] : big;
        if (!(tomb && state.drop_tombstones) && builder.length && (pageLimitOf(best) !== pageLimitOf(builder.first) || builder.wouldOverflow(best, inlineText, pageBig, pageLimitOf(best)))) {
          writePage();
          if (pagesThisStep >= max_pages) { stopped = true; break; }
        }
        // Older versions of the same key are let go; a big value they kept goes with them when the merge finishes.
        for (let at = 0; at < cursors.length; at += 1) {
          if (at === bestAt) continue;
          if (cursors[at].key() === best) { const big = cursors[at].big(); if (big) queueBigDrop(big[0]); cursors[at].next(); }
        }
        winner.next();
        visited += 1;
        if (tomb && state.drop_tombstones) { lastKey = best; continue; }
        builder.add(best, inlineText, spill ? storeBig(text, bigRef) : big);
        lastKey = best;
        if (filter) filterAdd(filter, bits, best);
        if (builder.chars >= pageLimit) {
          writePage();
          if (pagesThisStep >= max_pages) { stopped = true; break; }
        }
      }
      if (!stopped && !hasTime()) stopped = true;
      if (!stopped) {
        if (builder.length) writePage();
        finishMerge(state, filter, bits);
        done = true;
      } else {
        // A whole turn may consume deleted keys without writing one output page.
        // Save that input cursor in the same transaction as any partial output.
        if (builder.length) writePage();
        if (lastKey !== null) state.after = lastKey;
        meta.set('merge', state);
      }
      written = pagesThisStep;
    });
    if (done) {
      building = null;
      for (const run of state.inputs) dropCached(run);
      runs = runs.filter(run => !state.inputs.includes(run.run));
      loadCatalog();
    }
    return { merged: done, more: !done || meta.get('merge') !== undefined || cleanupPending() || nextMerge() !== null, pages: written };
  }
  const spaceReport = () => { const left = room(); return { database_bytes: Number(sql.databaseSize) || null, merge_room_bytes: Number.isFinite(left) ? left : null, soft_limit_bytes: settings.database_limit_bytes * settings.space_share }; };
  const mergeReport = state => state ? { output: state.output, inputs: state.inputs, pages: state.pages, bytes: state.bytes, compaction_debt_snapshot: state.compaction_debt_snapshot ?? null } : null;
  const cleanupPending = () => all(`SELECT ref FROM ${BIG_DROPS} LIMIT 1`).length > 0;
  const queueBigDrop = ref => sql.exec(`INSERT OR IGNORE INTO ${BIG_DROPS} (ref) VALUES (?)`, ref);
  // A reference is retired only after the merge publishes and its input runs are gone. A failed merge instead forgets
  // its queue entries without touching the referenced values. The queue and deletions commit together; each wake
  // deletes at most a small number of stored parts and clears at most that many empty references.
  function cleanupBigDrops() {
    transaction(() => {
      const mode = meta.get('big_drop_mode');
      let partsLeft = BIG_CLEANUP_PARTS;
      for (const { ref } of all(`SELECT ref FROM ${BIG_DROPS} ORDER BY ref LIMIT ?`, BIG_CLEANUP_REFS)) {
        if (partsLeft <= 0) break;
        if (mode !== 'retire') { sql.exec(`DELETE FROM ${BIG_DROPS} WHERE ref = ?`, ref); continue; }
        const parts = all(`SELECT part FROM ${BIG} WHERE ref = ? ORDER BY part LIMIT ?`, ref, partsLeft);
        for (const { part } of parts) sql.exec(`DELETE FROM ${BIG} WHERE ref = ? AND part = ?`, ref, part);
        partsLeft -= parts.length;
        if (!all(`SELECT part FROM ${BIG} WHERE ref = ? LIMIT 1`, ref).length) sql.exec(`DELETE FROM ${BIG_DROPS} WHERE ref = ?`, ref);
      }
      if (!cleanupPending()) meta.remove('big_drop_mode');
    });
  }
  // Entries of one run from lo upward, for merging, never parsed: key() (null at the end), tomb(), big() ([ref, parts]
  // or null) and text() (the value's JSON text).
  function rawCursor(run, lo, beforePage = () => {}) {
    let page = Math.max(0, lastPage(run, lo));
    const openPage = () => { beforePage(); return pageOf(run, page); };
    let entries = page < run.pages ? openPage() : null;
    let index = entries ? ceilIndex(entries.keys, lo) : 0;
    const settle = () => { while (entries && index >= entries.length) { page += 1; entries = page < run.pages ? openPage() : null; index = 0; } };
    return {
      key() { settle(); return entries ? entries.keys[index] : null; },
      tomb: () => entries.tomb(index),
      big: () => entries.big(index),
      text: () => entries.text(index),
      next() { index += 1; },
    };
  }
  function finishMerge(state, filter, bits) {
    const table = runTable(state.output);
    for (const run of state.inputs) {
      sql.exec(`DELETE FROM ${RUNS} WHERE run = ?`, run);
      sql.exec(`DROP TABLE IF EXISTS ${runTable(run)}`);
    }
    if (state.pages) {
      if (filter) writeFilter(table, filter);
      addRun(state.output, state.age, { pages: state.pages, keys: state.keys, bytes: state.bytes, last: state.last, filterBits: filter ? bits : 0 });
    } else sql.exec(`DROP TABLE IF EXISTS ${table}`);
    // A queue still being forgotten after a merge that could not finish keeps that mode: its references may still be
    // held by runs that survived it, so they are let go of without deleting a value (what this merge dropped stays kept).
    if (cleanupPending() && meta.get('big_drop_mode') !== 'forget') meta.set('big_drop_mode', 'retire');
    if (state.compaction_debt_snapshot) meta.set('compaction_debt', Math.max(0, compactionDebt() - state.compaction_debt_snapshot));
    const paused = meta.get('merge_paused');
    if (paused) {
      const { big_drop_mode_before_pause: previousMode, ...original } = paused;
      if (previousMode === null) meta.remove('big_drop_mode');
      else if (previousMode !== undefined) meta.set('big_drop_mode', previousMode);
      meta.set('merge', { ...original, backlog_yielded: true });
      meta.remove('merge_paused');
    } else meta.remove('merge');
  }

  // ---- filling filters -------------------------------------------------------------------------------------------------
  // A run left with no membership filter is given a blocked one, the largest such run first: its pages are read in key
  // order, `fill_pages` a call, every key (tombstones too, since one hides an older value) added to the blocks in memory,
  // and the blocks are saved every `fill_save_pages` pages with how far they reach, so a restart continues from the last
  // save. The run is marked filtered (filter_bits = -blocks) only once every page is read, so a probe never trusts a
  // filter missing keys. A merge that takes the run as input drops the table and the fill with it. Reads are never
  // cached, so the pages the store is reading stay cached.
  const unfiltered = () => runs.filter(run => run.filterBits === 0 && run.pages > 1).sort((a, b) => b.pages - a.pages)[0] ?? null;
  let filling = null;
  function saveFill(run, fill, done) {
    transaction(() => {
      for (let row = 0, at = 0; at < fill.bits.length; row += 1, at += FILTER_ROW_BLOCKS * BLOCK_BYTES) {
        sql.exec(`INSERT INTO ${runTable(run.run)} (page, first, body) VALUES (?, NULL, ?) ON CONFLICT (page) DO UPDATE SET body = excluded.body`, -1 - row, fill.bits.subarray(at, Math.min(fill.bits.length, at + FILTER_ROW_BLOCKS * BLOCK_BYTES)));
      }
      if (done) {
        sql.exec(`UPDATE ${RUNS} SET filter_bits = ? WHERE run = ?`, -fill.blocks, run.run);
        meta.remove('filter_fill');
      } else meta.set('filter_fill', { run: run.run, blocks: fill.blocks, page: fill.page });
    });
    fill.saved = fill.page;
  }
  function fillFilters({ max_pages = settings.fill_pages, hasTime = () => true } = {}) {
    if (meta.get('merge')) return { filled: false, more: false, pages: 0 };
    let run = filling && runs.find(item => item.run === filling.run && item.filterBits === 0);
    if (!run) {
      filling = null;
      const kept = meta.get('filter_fill');
      const resumed = kept && runs.find(item => item.run === kept.run && item.filterBits === 0);
      run = resumed ?? unfiltered();
      if (!run) { if (kept) meta.remove('filter_fill'); return { filled: false, more: false, pages: 0 }; }
      const blocks = resumed ? kept.blocks : blockCount(run.keys);
      filling = { run: run.run, blocks, bits: new Uint8Array(blocks * BLOCK_BYTES), page: 0, saved: 0 };
      if (resumed) {
        let at = 0;
        for (const { body } of sql.exec(`SELECT body FROM ${runTable(run.run)} WHERE page < 0 ORDER BY page DESC`)) at += readChunk(body, filling.bits, at);
        filling.page = filling.saved = kept.page;
      }
    }
    const fill = filling;
    let read = 0;
    const end = Math.min(run.pages, fill.page + max_pages);
    for (const row of sql.exec(`SELECT page, body FROM ${runTable(run.run)} WHERE page >= ? AND page < ? ORDER BY page`, fill.page, end)) {
      for (const key of decodePage(row.body, parseJson).keys) blockAdd(fill.bits, fill.blocks, key);
      fill.page = row.page + 1;
      read += 1;
      if (read % 64 === 0 && !hasTime()) break;
    }
    const done = fill.page >= run.pages;
    if (done || fill.page - fill.saved >= settings.fill_save_pages) saveFill(run, fill, done);
    if (done) {
      run.filterBits = -fill.blocks;
      filling = null;
    }
    return { filled: done, more: !done || unfiltered() !== null, pages: read };
  }

  // Keys alone and a selected value's stored chunks never decode the value. Storage migrations can consume
  // one bounded member at a time, including values written by older code beyond today's whole-read guard.
  function* walkKeys(lo, hi) {
    for (const [key] of walk(lo, hi, { readValue: () => false })) yield key;
  }

  function* jsonParts(key) {
    if (mem.has(key)) { const value = mem.get(key); if (value !== TOMB) yield JSON.stringify(value); return; }
    for (const run of runs) {
      if (key < run.first || key > run.last || !mayHold(run, key)) continue;
      const cursor = rawCursor(run, key);
      if (cursor.key() !== key) continue;
      if (cursor.tomb()) return;
      const big = cursor.big();
      if (!big) { yield cursor.text(); return; }
      // A keyed request per part bounds both hosts even when their SQL cursor materializes its result.
      for (let part = 0; part < big[1]; part += 1) {
        const rows = all(`SELECT body FROM ${BIG} WHERE ref = ? AND part = ?`, big[0], part);
        if (rows.length !== 1) throw new Error('A stored value chunk is missing.');
        yield rows[0].body;
      }
      return;
    }
  }

  return {
    rewriteKey,
    dropKey,
    versions,
    get,
    walkKeys,
    jsonParts,
    range,
    groupHeads,
    hasRange,
    walk,
    ranges,
    /** Puts one key; chars, when the caller knows it, is about how long the value's JSON is (only memory is counted
     *  with it, so the memtable is written out at about memtable_bytes without measuring every value). */
    put(key, value, chars, debt = 0) { if (value === undefined) throw new Error('A kept value cannot be undefined.'); memPut(key, value, chars, debt); },
    remove(key, debt = 0) { memPut(key, TOMB, undefined, debt); },
    flush,
    step,
    fillFilters,
    /** Whether a run has no membership filter yet (fillFilters gives it one as idle work). */
    fillDue: () => meta.get('merge') === undefined && unfiltered() !== null,
    /** Whether the memtable has reached memtable_bytes (the host writes it out when idle). */
    full: () => memBytes >= settings.memtable_bytes,
    /** The settings in force (KEPT_RUNS_DEFAULTS with the host's own). */
    settings,
    /** Whether every current run can reject absent exact keys using a resident membership filter; no SQL read. */
    exactMembershipResident: () => runs.every(run => run.filter !== null),
    /** Whether the memtable holds anything not yet written out. */
    pending: () => memBytes > 0,
    /** Whether the memtable has reached memtable_hold times memtable_bytes (a write writes it out before going on). */
    overfull: () => memBytes >= settings.memtable_bytes * settings.memtable_hold,
    /** Whether a merge is under way or due. */
    mergeDue: () => meta.get('merge') !== undefined || cleanupPending() || nextMerge() !== null,
    /** How far the caller's log the runs hold, as given to flush({ covered }). */
    covered: () => meta.get('covered'),
    /** Forgets the memtable (the caller replays its log into it again). */
    clearMemtable: memClear,
    /** Reads the catalog again: runs a rolled-back transaction made are let go, runs another made are read. */
    reloadCatalog() {
      const kept = new Set();
      for (const row of sql.exec(`SELECT run FROM ${RUNS}`)) kept.add(row.run);
      // A rolled-back write-out or merge cached its pages (and its big values) as it wrote them, under run numbers and
      // refs the next one hands out again, so every cached page and the merge filter in memory are let go, not only
      // those of runs the catalog no longer holds. Found by seeded faults (test/store-crash-recovery.test.mjs): a merge
      // read a reused run number's stale cached pages and wrote a run without the records flushed into it.
      cache.clear();
      spans.clear();
      cacheBytes = 0;
      building = null;
      runs = runs.filter(run => kept.has(run.run));
      loadCatalog();
    },
    /** Memory held now and what is kept; resident plus in-progress filter bytes share filter_bytes's one cap. */
    held: () => ({ memtable_keys: mem.size, memtable_bytes: memBytes, cache_bytes: cacheBytes, filter_bytes: residentFilterBytes(), merge_filter_bytes: mergeFilterBytes(), compaction_debt: compactionDebt() + memCompactionDebt, space: spaceReport(), merge: mergeReport(meta.get('merge')), merge_paused: mergeReport(meta.get('merge_paused')), runs: runs.map(({ run, age, pages, keys, bytes, filter, filterBits }) => ({ run, age, pages, keys, bytes, filter: filter ? 'resident' : filterBits < 0 ? 'blocks' : filterBits > 0 ? 'stored' : 'none' })), filter_fill: filling ? { run: filling.run, page: filling.page } : meta.get('filter_fill') ?? null }),
    meta,
    /** Every table this key space owns (for a host's table sweeps to leave alone). */
    tables: () => [...new Set([RUNS, META, BIG, BIG_DROPS, ...runs.map(run => runTable(run.run)), ...[meta.get('merge'), meta.get('merge_paused')].filter(Boolean).map(state => runTable(state.output))])],
  };
}

export const KEPT_TOMBSTONE = TOMB;
