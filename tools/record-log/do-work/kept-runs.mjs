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
//   page       body = a header line `~{"p":[shared...],"d":[length...],"b":{index:[ref, parts]}}\u0002suffix\u0003suffix...` (layout 2:
//              the keys' suffixes unquoted after \u0002, escapes in SUFFIX_ESCAPE's comment) then the entries' value texts end to
//              end. Key i is the first p[i] characters of key i-1 followed by suffix i (keys in a page share long prefixes, so the
//              header is small and the page holds more). Value lengths reconstruct
//              UTF16 offsets; earlier `o` offsets remain readable and are kept when they use fewer header characters.
//              Entry i's value is the
//              text between offsets i and i+1 after the header; an empty one is a tombstone; one named in "b" is a value
//              too big for a page, kept in `${prefix}_big` under ref. A read parses the header and only the one value
//              it wants, never the whole page, and a merge copies value texts from page to page without parsing them. Pages written before this layout
//              (body = JSON [[key, value] | [key] | [key, ref, parts]]) are still read; merges rewrite them. Layout 1 pages (the
//              header is JSON with the suffixes as an array `s`, no `~`) written before layout 2 are still read; a run's
//              page_layout is 2 once this code wrote it, and held() counts the pages of runs that lack it.
//   age        the order runs were made in; a merged run takes the age of the newest run it combined.
//   big value  a value whose JSON passes big_bytes is written once to `${prefix}_big` as parts and moves with its key
//              from run to run; it is deleted when a merge lets its key's version go.
//
// Security
//   No credential, no network. Table names are built from the prefix the host gives (code, never a person) and integer
//   run numbers; every key and value is bound as a parameter.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

// The platform's limit on one object's store is read once, from the data every store-size reader shares (src/store-size.json).
import storeSize from './store-size.json' with { type: 'json' };
const TOMB = Symbol('removed');
const FILTER_BITS_PER_KEY = 10;
const FILTER_HASHES = 7;
const FILTER_CHUNK = 512 * 1024; // bytes of filter per row
const FILTER_BLOCK_BITS = 512; // a blocked filter's block: every bit of one key lies in it
const FILTER_ROW_BLOCKS = 64; // blocks of a blocked filter per row (4 KB), the most one probe reads
const FILTER_ROWS_PER_READ = 64; // blocked filter rows (or sparse filter probes) one membership statement reads for many keys
const ABSENT_KEYS_KEPT = 4096; // keys known to be in no run and not in the memtable (get, getMany)
const FENCES_PER_READ = 1000; // page fences one statement reads for keys that lie close together in a run
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
  // Positive filters beyond cold page admission retain their persisted geometry
  // and read selected bytes, so cold replay rejects absent keys without run pages.
  // This is a cap, not reserved memory; small stores keep only their actual filters.
  filter_bytes: 8 * 1024 * 1024,
  // What a start loads whole: the newest runs' filters while together they hold no more than this. A filter past it
  // answers a start's probes by its selected bytes and is loaded whole by idle work (fillFilters) once this store has
  // asked it filter_promote_reads times, so what a start reads is bounded however large the account
  // (test/home-reads-bounded) and a store that stays open keeps its filters resident. A run a merge or write-out makes
  // while the store is open is loaded under filter_bytes alone.
  filter_boot_bytes: 1024 * 1024,
  filter_promote_reads: 16,
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
  database_limit_bytes: storeSize.limit_bytes,
  space_share: 0.9,
  // What a backlog's cheapest merge leaves free under database_limit_bytes when it runs past space_share (nextMerge).
  backlog_reserve_bytes: 128 * 1024 * 1024,
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
const SPARSE_FIRST_EMPTY = '!kept-sparse-first-v1\n';
function sparseFirst(raw) {
  if (typeof raw !== 'string' || raw[0] !== '!') throw new Error('A sparse kept run lacks its capability marker.');
  const marker = JSON.parse(raw.slice(1));
  if (!marker || marker.sparse !== 1 || typeof marker.first !== 'string'
    || Object.keys(marker).length !== 2) throw new Error('A sparse kept run has an unsupported marker.');
  return marker.first;
}

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
// A key-only read owns no value body and cannot be used as a decoded value page.
// Its keys and deletion bits share the ordinary byte-charged page LRU.
class PageHead {
  constructor(body, keys, tombs) { this.body = body; this.keys = keys; this.tombs = tombs; }
  get length() { return this.keys.length; }
  tomb(index) { return Boolean(this.tombs[index]); }
  get bytes() { return 64 + this.body.length * 2 + this.keys.length * 16 + this.tombs.byteLength; }
}
class SparseFirstEmptyPage {
  constructor() { this.body = SPARSE_FIRST_EMPTY; this.keys = []; }
  get length() { return 0; }
  get bytes() { return 64 + SPARSE_FIRST_EMPTY.length * 2; }
  tomb() { throw new Error('The sparse first marker has no entry.'); }
  entry() { throw new Error('The sparse first marker has no entry.'); }
}
// A page's header line says which layout wrote it. Layout 2 (the line starts with PAGE_V2) keeps the keys' suffixes in the
// line itself, after HEAD_SEP and joined by ENTRY_SEP, each unquoted: only NUL, the two separators, SUFFIX_ESCAPE, newlines
// and lone surrogates take an escape (SUFFIX_ESCAPE then one character, or u and four hex digits), so a key that holds
// quotes or backslashes costs what it holds. Layout 1 is the JSON object of the earlier pages, its suffixes an array under s.
const PAGE_V2 = '~';
const PAGE_LAYOUT_V2 = 2;
const HEAD_SEP = '\u0002';
const ENTRY_SEP = '\u0003';
const SUFFIX_ESCAPE = '\u0001';
const SUFFIX_TO_ESCAPE = /[\u0000-\u0003\n]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
const SUFFIX_ESCAPE_CODES = { '\u0000': '0', '\u0001': '1', '\u0002': '2', '\u0003': '3', '\n': 'n' };
const SUFFIX_FROM_ESCAPE = /\u0001(?:([0-3n])|u([0-9a-f]{4}))/g;
const SUFFIX_UNESCAPE_CODES = { 0: '\u0000', 1: '\u0001', 2: '\u0002', 3: '\u0003', n: '\n' };
const escapeSuffix = suffix => suffix.replace(SUFFIX_TO_ESCAPE, char => SUFFIX_ESCAPE + (SUFFIX_ESCAPE_CODES[char] ?? `u${char.charCodeAt(0).toString(16).padStart(4, '0')}`));
// A key holds NUL (its separators) in most suffixes, and a suffix whose only escape is NUL decodes by split and join.
const SUFFIX_NUL_ESCAPE = SUFFIX_ESCAPE + '0';
const SUFFIX_OTHER_ESCAPE = /\u0001[1-3nu]/;
const unescapeSuffix = text => {
  if (!text.includes(SUFFIX_ESCAPE)) return text;
  if (!SUFFIX_OTHER_ESCAPE.test(text)) return text.split(SUFFIX_NUL_ESCAPE).join('\u0000');
  return text.replace(SUFFIX_FROM_ESCAPE, (_, code, hex) => code === undefined ? String.fromCharCode(Number.parseInt(hex, 16)) : SUFFIX_UNESCAPE_CODES[code]);
};
// The header's JSON and its keys' suffixes, from the header line (body up to its newline at end).
function headerOf(body, end) {
  if (body[0] !== PAGE_V2) {
    const head = JSON.parse(body.slice(0, end));
    return { head, suffixes: head.s };
  }
  const split = body.indexOf(HEAD_SEP);
  if (split < 0 || split > end) throw new Error('A kept page header lacks its keys.');
  const head = JSON.parse(body.slice(1, split));
  return { head, suffixes: split + 1 === end ? [] : body.slice(split + 1, end).split(ENTRY_SEP).map(unescapeSuffix) };
}
// Prefix lengths below PREFIX_LIMIT are one character each (PREFIX_BASE plus the length); the characters stay clear of
// JSON's escapes, so the header keeps them raw. Other pages keep the array p, or q for runs of one length.
const PREFIX_BASE = 0x23;
const PREFIX_LIMIT = 0x5c - PREFIX_BASE;
function prefixHeadOf(prefixes, repeats) {
  const forms = [{ q: repeats }, { p: prefixes }];
  if (prefixes.every(shared => shared < PREFIX_LIMIT)) forms.push({ ps: prefixes.map(shared => String.fromCharCode(PREFIX_BASE + shared)).join('') });
  return forms.reduce((best, form) => JSON.stringify(form).length < JSON.stringify(best).length ? form : best);
}
function prefixesOf(head) {
  if (head.ps !== undefined) return Array.from(head.ps, char => char.charCodeAt(0) - PREFIX_BASE);
  return head.p ?? head.q.flatMap(([shared, count]) => Array(count).fill(shared));
}
function pageKeys(head, suffixes) {
  const keys = new Array(suffixes.length);
  const prefixes = prefixesOf(head);
  let previous = '';
  for (let index = 0; index < keys.length; index += 1) previous = keys[index] = previous.slice(0, prefixes[index]) + suffixes[index];
  return keys;
}
function decodePage(body, parseJson = JSON.parse, sparseFirstPage = false) {
  if (body === SPARSE_FIRST_EMPTY) {
    if (!sparseFirstPage) throw new SyntaxError('A sparse empty page requires marked format1 page zero.');
    return new SparseFirstEmptyPage();
  }
  if (body[0] === '[') return new ListPage(parseJson(body, { kind: 'page' }), body.length);
  const end = body.indexOf('\n');
  const { head, suffixes } = headerOf(body, end);
  const keys = pageKeys(head, suffixes);
  if (head.v !== undefined) return new UniformPage(body, keys, head.v, parseJson);
  let offsets = head.o;
  if (offsets === undefined) {
    if (!Array.isArray(head.d) || head.d.length !== keys.length) throw new Error('A kept page has invalid value lengths.');
    offsets = [0];
    for (const length of head.d) {
      if (!Number.isSafeInteger(length) || length < 0) throw new Error('A kept page has invalid value lengths.');
      offsets.push(offsets.at(-1) + length);
    }
    if (offsets.at(-1) !== body.length - end - 1) throw new Error('A kept page has invalid value lengths.');
  }
  return new PackedPage(body, keys, offsets, head.b ?? {}, end + 1, parseJson, head.c ?? '');
}
function decodePageHead({ body, tailChars }, parseJson = JSON.parse, sparseFirstPage = false) {
  if (body === SPARSE_FIRST_EMPTY) return decodePage(body, parseJson, sparseFirstPage);
  const end = body.indexOf('\n');
  // Legacy lists have no separate metadata. An invalid layout follows the
  // existing full decoder and its refusal rather than becoming an empty page.
  if (tailChars === null || body[0] === '[' || end < 0) return decodePage(body, parseJson, sparseFirstPage);
  const { head, suffixes } = headerOf(body, end);
  const keys = pageKeys(head, suffixes);
  const tombs = new Uint8Array(keys.length);
  if (head.v === undefined) {
    let offsets = head.o;
    if (offsets === undefined) {
      if (!Array.isArray(head.d) || head.d.length !== keys.length) throw new Error('A kept page has invalid value lengths.');
      offsets = [0];
      for (const length of head.d) {
        if (!Number.isSafeInteger(length) || length < 0 || !Number.isSafeInteger(offsets.at(-1) + length)) throw new Error('A kept page has invalid value lengths.');
        offsets.push(offsets.at(-1) + length);
      }
      if (offsets.at(-1) !== tailChars) throw new Error('A kept page has invalid value lengths.');
    }
    if (!Array.isArray(offsets) || offsets.length !== keys.length + 1 || offsets[0] !== 0
      || offsets.some((at, index) => !Number.isSafeInteger(at) || at < 0 || index > 0 && at < offsets[index - 1])) {
      throw new Error('A kept page has invalid value lengths.');
    }
    for (let index = 0; index < keys.length; index += 1) tombs[index] = Number(offsets[index] === offsets[index + 1] && !head.b?.[index]);
  }
  // SQL proves the omitted tail is ASCII, so its byte, code-point and UTF-16
  // lengths agree. Non-ASCII tails keep the existing full decoder's validation.
  return new PageHead(body.slice(0, end + 1), keys, tombs);
}
const pageHeadSql = body => {
  const tail = `substr(${body}, instr(${body}, char(10)) + 1)`;
  const full = `substr(${body}, 1, 1) = '[' OR instr(${body}, char(10)) = 0
    OR length(CAST(${tail} AS BLOB)) != length(${tail})`;
  return { body: `CASE WHEN ${full} THEN ${body} ELSE substr(${body}, 1, instr(${body}, char(10))) END`,
    tailChars: `CASE WHEN ${full} THEN NULL ELSE length(${tail}) END` };
};
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
    const suffix = escapeSuffix(key.slice(shared));
    const end = at + (text ? text.length : 0);
    const bigChars = big ? String(keys.length).length + JSON.stringify(big).length + 2 : 0;
    // The page budget keeps the earlier layout's estimate, so a run's pages hold the same keys as before and every read
    // of them costs what it did (test/directory-refill-copy-cost). The bytes saved by layout 2 are kept in the body.
    return { shared, suffix, end, added: JSON.stringify(key.slice(shared)).length + String(shared).length + String(end).length + 3 + (text ? text.length : 0) + bigChars };
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
      const prefixHead = prefixHeadOf(prefixes, repeats);
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
      // A page's cumulative positions grow with all preceding values. Keep each value's length instead when
      // its digits cost less; this changes no key/value, page bound, filter or merge decision.
      const lengths = uniform ? null : packedOffsets.slice(1).map((end, index) => end - packedOffsets[index]);
      const positions = !uniform && JSON.stringify(lengths).length < JSON.stringify(packedOffsets).length ? { d: lengths } : { o: packedOffsets };
      const head = `${PAGE_V2}${JSON.stringify({ ...prefixHead, ...(uniform ? { v: texts[0] } : { ...positions, b: bigs, ...(common ? { c: common } : {}) }) })}${HEAD_SEP}${suffixes.join(ENTRY_SEP)}`;
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
export function keptRuns(sql, { transaction = fn => fn(), prefix, parseJson = JSON.parse, readOnly = false, ...options } = {}) {
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
  const writable = () => {
    if (readOnly) throw Object.assign(new Error('A read-only kept key space cannot be changed.'), { code: 'kept_runs_read_only' });
  };
  const runColumns = () => new Set([...sql.exec(`PRAGMA table_info(${RUNS})`)].map(row => row.name));
  const existingRuns = [...sql.exec("SELECT 1 FROM sqlite_master WHERE type='table' AND name=? LIMIT 1", RUNS)].length > 0;
  if (readOnly) {
    for (const table of [RUNS, META, BIG, BIG_DROPS])
      if (![...sql.exec("SELECT 1 FROM sqlite_master WHERE type='table' AND name=? LIMIT 1", table)].length)
        throw Object.assign(new Error(`A read-only kept key space is missing ${table}.`), { code: 'kept_runs_schema_missing' });
  }
  // Refuse an unknown persisted format before the constructor's CREATE TABLE
  // statements or any catalogue/cache effects. This reader never publishes one.
  if (existingRuns && runColumns().has('page_format')) {
    for (const _ of sql.exec(`SELECT page_format FROM ${RUNS} WHERE page_format IS NOT NULL AND page_format NOT IN (0,1) LIMIT 1`))
      throw new Error('Unsupported kept page format.');
  }
  if (!readOnly) {
    sql.exec(`CREATE TABLE IF NOT EXISTS ${RUNS} (run INTEGER PRIMARY KEY, age INTEGER NOT NULL, pages INTEGER NOT NULL, keys INTEGER NOT NULL, bytes INTEGER NOT NULL, last TEXT NOT NULL, filter_bits INTEGER NOT NULL)`);
    // NULL: a run the earlier layout wrote. A run this code writes records PAGE_V2 here (addRun).
    if (!runColumns().has('page_layout')) sql.exec(`ALTER TABLE ${RUNS} ADD COLUMN page_layout INTEGER`);
    sql.exec(`CREATE TABLE IF NOT EXISTS ${META} (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID`);
    sql.exec(`CREATE TABLE IF NOT EXISTS ${BIG} (ref TEXT NOT NULL, part INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY (ref, part)) WITHOUT ROWID`);
    sql.exec(`CREATE TABLE IF NOT EXISTS ${BIG_DROPS} (ref TEXT PRIMARY KEY) WITHOUT ROWID`);
  }

  const meta = {
    get(key) {
      for (const row of sql.exec(`SELECT value FROM ${META} WHERE key = ?`, key)) return JSON.parse(row.value);
      return undefined;
    },
    // One selected metadata page per100 bound keys, never a read of all the store's metadata. No cache: another
    // owner, an uncommitted update or a rollback is visible on the next call through the same SQLite handle.
    getMany(names) {
      const selected = [...new Set(names)];
      if (selected.some(key => typeof key !== 'string')) throw new TypeError('Metadata names must be strings.');
      const found = new Map();
      for (let from = 0; from < selected.length; from += 100) {
        const page = selected.slice(from, from + 100);
        for (const row of sql.exec(`SELECT key, value FROM ${META} WHERE key IN (${page.map(() => '?').join(', ')})`, ...page))
          found.set(row.key, JSON.parse(row.value));
      }
      return found;
    },
    // A value already stored as it is is not written again: most merge and checkpoint steps set the state they found,
    // and each write is billed per row it changes.
    set(key, value) {
      writable();
      const json = JSON.stringify(value);
      for (const row of sql.exec(`SELECT value FROM ${META} WHERE key = ?`, key)) if (row.value === json) return;
      sql.exec(`INSERT INTO ${META} (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`, key, json);
    },
    remove(key) { writable(); sql.exec(`DELETE FROM ${META} WHERE key = ?`, key); },
  };

  // ---- memtable ---------------------------------------------------------------------------------------------------
  // Keys in no run and not in the memtable, so asking again reads nothing: on 2026-10-21 one ten-row list write asked the
  // record log 42 times for the same execution record it had not kept yet, each a membership read of all 25 runs of the
  // owner's own records. A run never gains a key but through the memtable (memPut forgets it here) and a catalog read
  // (loadCatalog) forgets them all; bounded by count, the oldest let go first.
  const absent = new Set();
  const noteAbsent = key => {
    if (absent.size >= ABSENT_KEYS_KEPT) absent.delete(absent.values().next().value);
    absent.add(key);
  };
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
    absent.delete(key);
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
  let rangeRevision = 0;
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
    for (const item of sql.exec(`SELECT first FROM ${runTable(run.run)} WHERE page = ?`, page))
      return page === 0 && run.pageFormat === 1 ? sparseFirst(item.first) : JSON.parse(item.first);
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
  const seekSql = (table, body, authenticatedLower = false, keysOnly = false) => {
    // Carry the two bracketing fences already visited by the search. Reading
    // them again at the end charges two extra physical rows for every probe.
    // A nonzero frontier also keeps its predecessor for the JS order check. A private
    // reader may provide its already-authenticated lower key instead of fetching that fence.
    let seeking = `SELECT probe.key AS at, (
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
    // Ordinary probes retain the historical query bytes. Only an owner-certified
    // predecessor selects the optional bracket, including mixed probe batches.
    if (authenticatedLower) seeking = seeking.replace(
      "CASE WHEN json_extract(probe.value, '$[2]') = 1",
      "CASE WHEN json_array_length(probe.value) > 4 THEN json_extract(probe.value, '$[4]')\n              WHEN json_extract(probe.value, '$[2]') = 1");
    // SQLite may flatten a derived table and evaluate the correlated halving
    // again for each reference to sought. Keep each probe result once before
    // using its fence result to fetch the page body in this same statement.
    if (body && keysOnly) {
      const projection = pageHeadSql('kept.body');
      return `WITH sought_pages AS MATERIALIZED (${seeking}) SELECT at, sought,
        ${projection.body} AS body, ${projection.tailChars} AS tail_chars FROM sought_pages
        LEFT JOIN ${table} AS kept ON kept.page = json_extract(sought, '$[0]')`;
    }
    return body ? `WITH sought_pages AS MATERIALIZED (${seeking}) SELECT at, sought,
      (SELECT body FROM ${table} WHERE page = json_extract(sought, '$[0]')) AS body FROM sought_pages` : seeking;
  };
  const fenceBelow = (fence, key, strict) => (strict ? fence < key : fence <= key);
  const nextSparse = (run, from, through = run.pages - 1) => {
    for (const row of sql.exec(`SELECT page, first FROM ${runTable(run.run)} WHERE page >= ? AND page <= ? ORDER BY page LIMIT 1`, from, through))
      return { page: row.page, first: row.page === 0 ? sparseFirst(row.first) : JSON.parse(row.first) };
    return null;
  };
  const previousSparse = (run, through) => {
    for (const row of sql.exec(`SELECT page, first FROM ${runTable(run.run)} WHERE page <= ? AND page >= 0 ORDER BY page DESC LIMIT 1`, through))
      return { page: row.page, first: row.page === 0 ? sparseFirst(row.first) : JSON.parse(row.first) };
    return null;
  };
  function sparsePage(run, { key, strict, from }) {
    if (!run.pages || !fenceBelow(run.first, key, strict)) return -1;
    let lo = Math.max(1, from), hi = run.pages - 1;
    let found = previousSparse(run, Math.max(0, from - 1))?.page ?? 0;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1, row = nextSparse(run, mid, hi);
      if (!row) { hi = mid - 1; continue; }
      if (fenceBelow(row.first, key, strict)) { found = row.page; lo = row.page + 1; }
      else hi = row.page - 1;
    }
    return found;
  }
  // The answer without a row read, when the key is before the run, past it, or the run is one page.
  function settledPage(run, { key, strict, from }) {
    if (run.pageFormat === 1) return undefined;
    if (!run.pages || !fenceBelow(run.first, key, strict)) return from - 1;
    if (run.pages === 1 || fenceBelow(run.last, key, strict)) return run.pages - 1;
    return coveringPage(run, key, strict);
  }
  function halvedPage(run, { key, strict, from }) {
    if (run.pageFormat === 1) return sparsePage(run, { key, strict, from });
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
  // Private reader probes may start just after a certified predecessor, carrying lowerProof
  // (a previously validated key, never an externally supplied fence or absence proof).
  // `bodies`, a Map when given, takes the body of each page found (page to body text), for a caller that reads the pages.
  function fenceRoundPages(active) {
    const wanted = new Set();
    const include = (lo, hi, depth) => {
      if (lo > hi || depth === 0) return;
      const mid = (lo + hi) >>> 1;
      wanted.add(mid);
      include(lo, mid - 1, depth - 1);
      include(mid + 1, hi, depth - 1);
    };
    for (const item of active) include(item.lo, item.hi, 3);
    return wanted;
  }
  function lastPages(run, probes, bodies = null, nextFences = null, preparedFences = null, keysOnly = false) {
    if (run.pageFormat === 1) return probes.map(probe => {
      const found = sparsePage(run, probe);
      if (found >= 0) {
        if (bodies) {
          for (const row of sql.exec(`SELECT body FROM ${runTable(run.run)} WHERE page=?`, found))
            bodies.set(found, keysOnly ? { body: row.body, tailChars: null } : row.body);
        }
        const next = nextSparse(run, found + 1);
        if (nextFences && next) nextFences.set(next.page, next.first);
      }
      return found;
    });
    const pages = probes.map(probe => settledPage(run, probe));
    const asked = probes.map((_, at) => at).filter(at => pages[at] === undefined);
    // A batch shares physical midpoint fences. Each fence is selected once per search round, even when many nearby
    // probes visit that same row, and once for the whole batch: every search of a run halves it the same way first.
    // -> the searched items: { probe, found, nextPage?, nextFence? }
    const seen = new Map(preparedFences ?? []);
    const searchFences = group => {
      const active = group.map(probe => ({ probe, lo: probe.from, hi: run.pages - 1, found: probe.from - 1 }));
      for (;;) {
        const pending = active.filter(item => item.lo <= item.hi);
        if (!pending.length) break;
        // Read three decision levels per round. Each 64-probe group needs at
        // most 448 fences, keeping the query and scratch bounded while avoiding
        // one SQL round trip for every individual binary-search level.
        const numbers = [...fenceRoundPages(pending)].filter(page => !seen.has(page));
        for (let offset = 0; offset < numbers.length; offset += 100) {
          const selected = numbers.slice(offset, offset + 100);
          for (const row of sql.exec(`SELECT page, first FROM ${runTable(run.run)} WHERE page IN (${selected.map(() => '?').join(',')})`, ...selected)) seen.set(row.page, JSON.parse(row.first));
        }
        for (const item of pending) {
          for (let level = 0; level < 3 && item.lo <= item.hi; level += 1) {
            const mid = (item.lo + item.hi) >>> 1;
            if (!seen.has(mid)) throw new Error(`Page ${mid} of ${runTable(run.run)} is missing.`);
            if (fenceBelow(seen.get(mid), item.probe.key, item.probe.strict)) { item.found = mid; item.lo = mid + 1; }
            else {
              item.hi = mid - 1;
              if (nextFences) { item.nextPage = mid; item.nextFence = seen.get(mid); }
            }
          }
        }
      }
      return active;
    };
    const readBodies = found => {
      if (!bodies) return;
      const numbers = [...new Set(found.filter(page => page >= 0))];
      for (let offset = 0; offset < numbers.length; offset += 100) {
        const selected = numbers.slice(offset, offset + 100);
        for (const row of sql.exec(`SELECT page, body FROM ${runTable(run.run)} WHERE page IN (${selected.map(() => '?').join(',')})`, ...selected)) bodies.set(row.page, row.body);
      }
    };
    // Each 64 unresolved probes searched together, their found pages' bodies read together.
    const searchGroups = () => {
      for (let group = 0; group < asked.length; group += 64) {
        const ats = asked.slice(group, group + 64);
        const active = searchFences(ats.map(at => probes[at]));
        active.forEach((item, index) => {
          pages[ats[index]] = item.found;
          // The nearest rejected fence was already visited and compared in JS
          // order. Keep it only when it is the actual successor of this answer.
          if (nextFences && item.nextPage === item.found + 1) nextFences.set(item.nextPage, item.nextFence);
        });
        readBodies(active.map(item => item.found));
      }
    };
    // Keys that lie close together in this run (a list's rows, named in id order) are placed among the fences between
    // their least and greatest key, read in one statement, when those are no more than the keys: on a large account's own
    // records (2026-10-20) a read of 2,000 list rows searched 64 keys at a time, the same seven fences a round, 468
    // statements in each of three runs. Each answer is the last page whose fence is below its key, as a search finds.
    // One group of keys or fewer is searched as one group: placing them would cost the same search and a read more.
    const placeNear = () => {
      let least = probes[asked[0]].key, most = least;
      for (const at of asked) { const { key } = probes[at]; if (key < least) least = key; if (key > most) most = key; }
      const [low, high] = searchFences([{ key: least, strict: true, from: 0 }, { key: most, strict: false, from: 0 }]);
      if (high.found - low.found > asked.length) return false;
      const between = [];
      for (let page = low.found + 1; page <= high.found; page += FENCES_PER_READ) {
        for (const row of sql.exec(`SELECT page, first FROM ${runTable(run.run)} WHERE page >= ? AND page <= ? ORDER BY page`, page, Math.min(high.found, page + FENCES_PER_READ - 1))) {
          if (row.page !== low.found + 1 + between.length) break;
          between.push(JSON.parse(row.first));
        }
      }
      if (between.length !== high.found - low.found) throw new Error(`Page ${low.found + 1 + between.length} of ${runTable(run.run)} is missing.`);
      for (const at of asked) {
        const { key, strict, from } = probes[at];
        let lo = 0, hi = between.length;
        while (lo < hi) { const mid = (lo + hi) >>> 1; if (fenceBelow(between[mid], key, strict)) lo = mid + 1; else hi = mid; }
        const found = Math.max(from - 1, low.found + lo);
        pages[at] = found;
        if (nextFences && found >= low.found && found < high.found) nextFences.set(found + 1, between[found - low.found]);
      }
      readBodies(asked.map(at => pages[at]));
      return true;
    };
    if (asked.length >= 8) {
      if (asked.length <= 64 || !placeNear()) searchGroups();
    } else if (asked.length) {
      // settledPage already proves the first fence is below each unresolved
      // probe in JS order. Reuse the run's kept first fence and start after it.
      const encoded = asked.map(at => {
        const probe = probes[at];
        const row = [probe.key, probe.strict ? 1 : 0, Math.max(1, probe.from), JSON.stringify(run.first)];
        if (probe.lowerProof !== undefined) row.push(JSON.stringify(probe.lowerProof));
        return row;
      });
      const authenticatedLower = encoded.some(row => row.length > 4);
      for (const item of sql.exec(seekSql(runTable(run.run), bodies !== null, authenticatedLower, keysOnly), run.pages, JSON.stringify(encoded))) {
        const at = asked[Number(item.at)];
        const { key, strict } = probes[at];
        const [found, here, next] = JSON.parse(item.sought);
        if ((found < 0 || fenceBelow(JSON.parse(here), key, strict)) && (found + 1 >= run.pages || !fenceBelow(JSON.parse(next), key, strict))) {
          pages[at] = found;
          if (bodies && item.body != null) bodies.set(found, keysOnly ? { body: item.body, tailChars: item.tail_chars } : item.body);
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
    const pageFormat = row.page_format ?? 0;
    if (pageFormat !== 0 && pageFormat !== 1) throw new Error('Unsupported kept page format.');
    const first = pageFormat === 1 ? JSON.parse(row.first_key) : row.pages ? fenceOf({ ...row, pageFormat }, 0) : '';
    if (pageFormat === 1 && (typeof first !== 'string' || fenceOf({ ...row, pageFormat }, 0) !== first))
      throw new Error('A sparse kept run has conflicting first keys.');
    return { run: row.run, age: row.age, pages: row.pages, keys: row.keys, bytes: row.bytes, last: JSON.parse(row.last), first,
      pageFormat, filter, filterBits: row.filter_bits, layout: row.page_layout ?? null };
  }
  function loadCatalog(start = false) {
    // A run read from the catalog may hold keys this memtable never had (another owner's write-out): absences are asked again.
    absent.clear();
    const held = new Map(runs.map(run => [run.run, run]));
    const current = [];
    let filterBytes = mergeFilterBytes();
    let omittedFilters = 0;
    const backlogLimit = Math.max(settings.max_runs, settings.fan_in);
    let backlogAtStart = false;
    // Only a start needs this decision. Peek at most the merge threshold plus
    // one metadata row, retaining no rows; reloads keep their admission rules.
    // An infinite threshold never selects backlog boot admission.
    if (start && backlogLimit < Number.MAX_SAFE_INTEGER) {
      let seen = 0;
      for (const _ of sql.exec(`SELECT run FROM ${RUNS} LIMIT ?`, Math.max(1, Math.floor(backlogLimit) + 1))) {
        if (++seen > backlogLimit) { backlogAtStart = true; break; }
      }
    }
    // A store with a merge backlog (more runs than max_runs) loads its filters up to filter_bytes at start, as before
    // filter_boot_bytes: each filter left out costs one SQL probe per read, so a read probed every run of the backlog.
    // On a large account's store one setting read probed about 1,700 runs (1,666 statements, 2.4 million rows) and the store could not start
    // (2026-10-16); its merges, idle work, never ran. A store within max_runs keeps the bounded start.
    const bootBytes = backlogAtStart ? settings.filter_bytes : settings.filter_boot_bytes;
    const columns = runColumns();
    const format = columns.has('page_format') ? 'page_format' : '0 AS page_format';
    const firstKey = columns.has('first_key') ? 'first_key' : 'NULL AS first_key';
    const layout = columns.has('page_layout') ? 'page_layout' : 'NULL AS page_layout';
    for (const row of sql.exec(`SELECT run, age, pages, keys, bytes, last, filter_bits, ${format}, ${firstKey}, ${layout} FROM ${RUNS} ORDER BY age DESC, run DESC`)) {
      if (row.page_format !== null && row.page_format !== 0 && row.page_format !== 1)
        throw new Error('Unsupported kept page format.');
      const previous = held.get(row.run);
      // Every filter that fits the aggregate memory cap stays resident, whatever the data-page size: a filter
      // left out answers each later probe with a selected-bytes SQL read (test/handoff-reads-flat). Positive filters
      // beyond the cap keep their exact geometry and use selected bytes below.
      // A start loads the newest filters only up to filter_boot_bytes, so what it reads is bounded however large the
      // account (test/home-reads-bounded). A filter a start left out is loaded by idle work once it is asked often
      // (fillFilters), never by a reload, which a rolled-back write or a start's own upkeep can run; one left out for
      // the memory cap is loaded again by a reload once it fits.
      const fits = row.filter_bits > 0 && filterBytes + row.filter_bits / 8 <= settings.filter_bytes;
      const keepFilter = fits && (previous ? Boolean(previous.filter) || !previous.startOmitted
        : !start || filterBytes + row.filter_bits / 8 <= bootBytes);
      const run = previous && (row.page_format === 1 || previous.pageFormat === 1)
        ? { ...loadRun(row, keepFilter), ...(previous.startOmitted ? { startOmitted: true } : {}) }
        : previous
        ? keepFilter ? (previous.filter ? previous : { ...previous, filter: loadFilter(row) }) : { ...previous, filter: null, filterBits: row.filter_bits }
        : { ...loadRun(row, keepFilter), ...(start && fits && !keepFilter ? { startOmitted: true } : {}) };
      if (run.filter) filterBytes += run.filter.byteLength;
      else if (row.filter_bits > 0 && row.filter_bits / 8 > settings.filter_bytes) omittedFilters += 1;
      current.push(run);
    }
    runs = current;
    if (omittedFilters) console.warn('kept runs filters omitted to bound memory', { prefix, runs: runs.length, omitted_filters: omittedFilters, filter_bytes: filterBytes });
  }
  loadCatalog(true);

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
    if (run.pageFormat === 1) return undefined; // Numeric adjacency is no proof across sparse holes.
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
  function cached(key, load, bytesOf, accepts = () => true) {
    const hit = cache.get(key);
    if (hit && accepts(hit.value)) { cache.delete(key); cache.set(key, hit); return hit.value; }
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
    const previous = cache.get(key);
    const successor = previous?.value instanceof PageHead ? previous.nextFence : undefined;
    forgetCached(key);
    cache.set(key, { value, bytes });
    cacheBytes += bytes;
    while (cacheBytes > settings.cache_bytes && cache.size > 1) {
      const [oldest] = cache.entries().next().value;
      forgetCached(oldest);
    }
    noteSpan(key, value);
    if (successor !== undefined) {
      const [runNumber, page] = key.split(':').map(Number);
      const run = runs.find(item => item.run === runNumber);
      if (run) noteSuccessor(run, page, successor);
    }
  }
  const dropCached = run => {
    rangeRevision += 1;
    spans.delete(run);
    for (const key of [...cache.keys()]) if (key.startsWith(`${run}:`)) forgetCached(key);
  };
  const pageOf = (run, page, body) => {
    const successor = cache.get(`${run.run}:${page}`)?.nextFence;
    const decoded = cached(`${run.run}:${page}`, () => {
      if (body !== undefined) return decodePage(body, parseJson, run.pageFormat === 1 && page === 0);
      // An earlier run can hold a large page. toArray() asks SQLite to materialize the entire result and can exceed
      // the Durable Object's result limit even for this keyed lookup; take its one row from the cursor directly.
      let row;
      for (const found of sql.exec(`SELECT body FROM ${runTable(run.run)} WHERE page = ?`, page)) { row = found; break; }
      if (!row) throw new Error(`Page ${page} of ${runTable(run.run)} is missing.`);
      return decodePage(row.body, parseJson, run.pageFormat === 1 && page === 0);
    }, value => value.bytes, value => !(value instanceof PageHead));
    if (successor !== undefined) noteSuccessor(run, page, successor);
    return decoded;
  };
  const pageHeadOf = (run, page, body) => cached(`${run.run}:${page}`, () => {
    if (body !== undefined) return decodePageHead(body, parseJson, run.pageFormat === 1 && page === 0);
    const projection = pageHeadSql('body');
    let row;
    for (const found of sql.exec(`SELECT ${projection.body} AS body, ${projection.tailChars} AS tail_chars FROM ${runTable(run.run)} WHERE page = ?`, page)) { row = found; break; }
    if (!row) throw new Error(`Page ${page} of ${runTable(run.run)} is missing.`);
    return decodePageHead({ body: row.body, tailChars: row.tail_chars }, parseJson, run.pageFormat === 1 && page === 0);
  }, value => value.bytes);
  // Keep at most one already-validated successor fence on the existing page
  // cache entry. Replacement, eviction, dropCached and reload release its bytes
  // with that page; no proof outlives its resident immutable predecessor.
  function noteSuccessor(run, page, fence) {
    if (run.pageFormat === 1) return;
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
  const positiveProbe = (run, key) => {
    hash(key);
    return Array.from({ length: FILTER_HASHES }, (_, at) => {
      const bit = ((hashA + Math.imul(at, hashB)) >>> 0) % run.filterBits;
      const byte = bit >>> 3;
      return [byte, 1 << (bit & 7), cache.get(`${run.run}:fb${byte}`)?.value ?? null];
    });
  };
  // SQLite reads each requested negative row once and returns only its selected bytes. Legacy base64 chunks use
  // the same byte positions: decode one quartet in SQL, never materialize the whole text or change its geometry.
  const sparseFilterSql = table => {
    const hexDigit = at => `(instr('0123456789ABCDEF', substr(hex(substr(filter.body, json_extract(sample.value, '$[1]') + 1, 1)), ${at}, 1)) - 1)`;
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const digit = at => `(CASE WHEN length(substr(filter.body, (CAST(json_extract(sample.value, '$[1]') / 3 AS INTEGER) * 4) + ${at}, 1)) = 1
      THEN instr('${alphabet}', substr(filter.body, (CAST(json_extract(sample.value, '$[1]') / 3 AS INTEGER) * 4) + ${at}, 1)) - 1 ELSE -1 END)`;
    const binaryByte = `CASE WHEN length(substr(filter.body, json_extract(sample.value, '$[1]') + 1, 1)) = 1
      THEN ${hexDigit(1)} * 16 + ${hexDigit(2)} ELSE NULL END`;
    const textByte = `CASE json_extract(sample.value, '$[1]') % 3
      WHEN 0 THEN CASE WHEN ${digit(1)} < 0 OR ${digit(2)} < 0 THEN NULL ELSE ${digit(1)} * 4 + CAST(${digit(2)} / 16 AS INTEGER) END
      WHEN 1 THEN CASE WHEN ${digit(2)} < 0 OR ${digit(3)} < 0 THEN NULL ELSE (${digit(2)} % 16) * 16 + CAST(${digit(3)} / 4 AS INTEGER) END
      ELSE CASE WHEN ${digit(3)} < 0 OR ${digit(4)} < 0 THEN NULL ELSE (${digit(3)} % 4) * 64 + ${digit(4)} END END`;
    return `WITH filter_chunks AS MATERIALIZED (
      SELECT wanted.value AS wanted, filter.body AS body FROM json_each(?) AS wanted
      LEFT JOIN ${table} AS filter ON filter.page = json_extract(wanted.value, '$[0]')
    ), filter_samples AS MATERIALIZED (
      SELECT json_extract(sample.value, '$[0]') AS at,
        CASE WHEN typeof(filter.body) = 'text' THEN ${textByte} WHEN typeof(filter.body) = 'blob' THEN ${binaryByte} ELSE NULL END AS byte
      FROM filter_chunks AS filter, json_each(json_extract(filter.wanted, '$[1]')) AS sample
    )`;
  };
  function sparseFilterRead(run, keys, point = null, fenceBatch = null) {
    const probes = keys.map(key => positiveProbe(run, key));
    const missing = new Map();
    for (const probe of probes) for (const [byte, , held] of probe) if (held === null) missing.set(byte, byte);
    if (!missing.size) return { holds: probes.map(probe => probe.every(([, mask, held]) => (held & mask) !== 0)) };
    const chunks = new Map();
    for (const byte of missing.values()) {
      const page = -1 - Math.floor(byte / FILTER_CHUNK);
      if (!chunks.has(page)) chunks.set(page, []);
      chunks.get(page).push([byte, byte % FILTER_CHUNK]);
    }
    const selected = [...chunks];
    const prefixSql = sparseFilterSql(runTable(run.run));
    // The selected samples are request-local lookup data, not a table to scan
    // again for each of up to 448 probes. JSON paths address the numeric byte
    // keys directly while preserving unknown/corrupt sample values as null.
    const membershipSql = `${prefixSql}, sample_values AS MATERIALIZED (
      SELECT json_group_object(at, byte) AS bytes FROM filter_samples
    )`;
    const sampledByte = `COALESCE(json_extract(probe.value, '$[2]'),
      json_extract(sample_values.bytes, '$."' || json_extract(probe.value, '$[0]') || '"'))`;
    let query = `${prefixSql} SELECT json_group_array(json_array(at, byte)) AS samples FROM filter_samples`;
    const bindings = [JSON.stringify(selected)];
    if (fenceBatch) {
      // The first grouped fence round and membership share a statement. Only positive/unknown keys that actually
      // need a batched search can admit fences; absent-only batches read no run pages. The seven initial midpoint
      // fences remain request-local and are consumed by the existing shared search, never a second resident cache.
      query = `${membershipSql}, filter_keys AS MATERIALIZED (
        SELECT CAST(key AS INTEGER) AS at, json_extract(value, '$[0]') AS probes,
          json_extract(value, '$[1]') AS unsettled FROM json_each(?)
      ), memberships AS MATERIALIZED (
        SELECT filter_keys.at, filter_keys.unsettled,
          MIN(CASE WHEN ${sampledByte} IS NULL
            OR ${sampledByte} NOT BETWEEN 0 AND 255 THEN 1
            WHEN (${sampledByte} & json_extract(probe.value, '$[1]')) != 0 THEN 1 ELSE 0 END) AS holds
        FROM filter_keys, json_each(filter_keys.probes) AS probe, sample_values
        GROUP BY filter_keys.at
      ) SELECT (SELECT json_group_array(json_array(at, byte)) FROM filter_samples) AS samples,
        CASE WHEN (SELECT COUNT(*) FROM memberships WHERE holds AND unsettled) >= 8
          THEN (SELECT json_group_array(json_array(page, first)) FROM ${runTable(run.run)}
            WHERE page IN (SELECT value FROM json_each(?))) ELSE '[]' END AS fences`;
      bindings.push(JSON.stringify(probes.map((probe, at) => [probe, fenceBatch.unsettled[at]])), JSON.stringify(fenceBatch.pages));
    } else if (point) {
      // Fuse the cold membership check with the existing point lookup. An absent key reads no run page and a
      // present key still needs one statement, including its body, rather than a separate filter round trip.
      query = `${membershipSql}, membership AS MATERIALIZED (
        SELECT MIN(CASE WHEN ${sampledByte} IS NULL
          OR ${sampledByte} NOT BETWEEN 0 AND 255 THEN 1
          WHEN (${sampledByte} & json_extract(probe.value, '$[1]')) != 0 THEN 1 ELSE 0 END) AS holds
        FROM json_each(?) AS probe, sample_values
      ), selected_point AS MATERIALIZED (
        SELECT (SELECT json_group_array(json_array(at, byte)) FROM filter_samples) AS samples, holds,
          CASE WHEN holds THEN (${point.query}) ELSE NULL END AS point FROM membership
      ) SELECT samples, holds, point IS NOT NULL AS has_point,
        json_extract(point, '$[0]') AS sought, json_extract(point, '$[1]') AS body,
        json_extract(point, '$[2]') AS fixed FROM selected_point`;
      bindings.push(JSON.stringify(probes[0]), ...point.bindings);
    }
    const answer = all(query, ...bindings)[0];
    const values = new Map(JSON.parse(answer?.samples ?? '[]'));
    for (const [byte, value] of values) if (Number.isInteger(value) && value >= 0 && value <= 255)
      cached(`${run.run}:fb${byte}`, () => value, () => 64);
    const holds = probes.map(probe => probe.every(([byte, mask, held]) => {
      const value = held ?? values.get(byte);
      // Missing/corrupt optional filter data cannot certify absence; the exact run page remains authoritative.
      return value == null || value < 0 || value > 255 || (value & mask) !== 0;
    }));
    // Return the page body as its own SQL field. Nesting its already-encoded JSON in another text field escapes it
    // again across the storage boundary; the internal scalar still preserves the single conditional seek.
    countSelectedRead(run);
    return { holds, point: answer?.has_point ? [answer.sought, answer.body, answer.fixed] : null,
      fences: new Map(JSON.parse(answer?.fences ?? '[]').map(([page, first]) => [page, JSON.parse(first)])) };
  }
  // A run this store keeps asking by selected bytes is counted here; idle work (fillFilters) loads its filter whole while
  // the resident budget allows. A read never does: loading the whole filter costs as much as the account holds.
  function countSelectedRead(run) {
    run.sparseReads = (run.sparseReads ?? 0) + 1;
  }
  const promotable = () => runs.find(run => !run.filter && run.filterBits > 0 && (run.sparseReads ?? 0) >= settings.filter_promote_reads
    && residentFilterBytes() + mergeFilterBytes() + run.filterBits / 8 <= settings.filter_bytes) ?? null;
  // Whether a run may hold each of `keys`, in their order. A blocked filter's rows the keys need and the page cache lacks
  // are read together, FILTER_ROWS_PER_READ to a statement, so N keys cost ceil(N / FILTER_ROWS_PER_READ) statements a run,
  // not N: a command looking up 400 keys over nine blocked runs read about 4,000 rows one statement each and stopped at
  // its statement bound (the owner's own records, 2026-10-20). A row the run lacks (a fill not finished) may hold anything.
  function mayHoldMany(run, keys) {
    if (run.filter) return keys.map(key => filterHas(run.filter, run.filterBits, key));
    if (run.filterBits > 0) {
      const holds = [];
      for (let at = 0; at < keys.length; at += FILTER_ROWS_PER_READ) holds.push(...sparseFilterRead(run, keys.slice(at, at + FILTER_ROWS_PER_READ)).holds);
      return holds;
    }
    if (!(run.filterBits < 0)) return keys.map(() => true);
    const sought = keys.map(key => { hash(key); const block = hashA % -run.filterBits; return { block, row: Math.floor(block / FILTER_ROW_BLOCKS), bits: hashB }; });
    // This call's rows, kept here so a row the cache lets go while the rest are read is still answered.
    const rows = new Map();
    const missing = [];
    for (const { row } of sought) {
      if (rows.has(row)) continue;
      const held = cache.get(`${run.run}:f${row}`);
      if (held) { cache.delete(`${run.run}:f${row}`); cache.set(`${run.run}:f${row}`, held); rows.set(row, held.value); }
      else { rows.set(row, null); missing.push(row); }
    }
    const bitsOf = body => (typeof body === 'string' ? Uint8Array.from(atob(body), c => c.charCodeAt(0)) : new Uint8Array(body));
    for (let at = 0; at < missing.length; at += FILTER_ROWS_PER_READ) {
      const asked = missing.slice(at, at + FILTER_ROWS_PER_READ);
      // One row is the keyed point read; more are one statement over the rows asked.
      if (asked.length === 1) for (const found of sql.exec(`SELECT body FROM ${runTable(run.run)} WHERE page = ?`, -1 - asked[0])) rows.set(asked[0], bitsOf(found.body));
      else for (const found of sql.exec(`SELECT page, body FROM ${runTable(run.run)} WHERE page IN (SELECT value FROM json_each(?))`, JSON.stringify(asked.map(row => -1 - row)))) rows.set(-1 - found.page, bitsOf(found.body));
      for (const row of asked) cached(`${run.run}:f${row}`, () => rows.get(row), value => (value?.byteLength ?? 0) + 64);
    }
    return sought.map(({ block, row, bits }) => {
      const held = rows.get(row);
      if (!held) return true;
      hashB = bits;
      return blockBits(held, (block % FILTER_ROW_BLOCKS) * BLOCK_BYTES, false);
    });
  }
  const mayHold = (run, key) => mayHoldMany(run, [key])[0];
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
    if (key < run.first || key > run.last) return undefined;
    const bodies = new Map();
    // A resident immutable page settles the key exactly, including absence
    // between its keys. Optional membership must not reread its body or evict
    // that page while admitting unrelated sparse filter samples.
    let page = coveringPage(run, key, false);
    let nextFence;
    if (page === undefined && run.pageFormat !== 1 && page_budget === null && !run.filter && run.filterBits > 0 && positiveProbe(run, key).some(([, , held]) => held === null)) {
      const settled = settledPage(run, { key, strict: false, from: 0 });
      const point = settled === undefined
        ? { query: `SELECT json_array(sought, body, NULL) FROM (${seekSql(runTable(run.run), true)})`,
          bindings: [run.pages, JSON.stringify([[key, 0, 1, JSON.stringify(run.first)]])] }
        : { query: `SELECT json_array(NULL, body, page) FROM ${runTable(run.run)} WHERE page = ?`, bindings: [settled] };
      const answer = sparseFilterRead(run, [key], point);
      if (!answer.holds[0]) return undefined;
      if (answer.point) {
        const [sought, body, fixed] = answer.point;
        if (fixed !== null) page = fixed;
        else {
          const [found, here, next] = JSON.parse(sought);
          if ((found < 0 || fenceBelow(JSON.parse(here), key, false)) && (found + 1 >= run.pages || !fenceBelow(JSON.parse(next), key, false))) {
            page = found;
            if (found + 1 < run.pages) nextFence = JSON.parse(next);
          }
        }
        if (page !== undefined && body != null) bodies.set(page, body);
      }
      page ??= halvedPage(run, { key, strict: false, from: 0 });
    } else if (page === undefined) {
      if (!mayHold(run, key)) return undefined;
      page = lastPages(run, [{ key, strict: false, from: 0 }], page_budget === null ? bodies : null)[0];
    }
    if (page < 0) return undefined;
    if (page_budget) { if (page_budget.remaining <= 0) throw new KeptRangeBudgetExceeded(); page_budget.remaining -= 1; }
    const found = pageOf(run, page, bodies.get(page));
    if (nextFence !== undefined) noteSuccessor(run, page, nextFence);
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
  function runCursor(run, lo, hi, reverse, readValue = (source, number, at) => valueOf(pageOf(source, number).entry(at)), keysOnly = false) {
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
      const entries = page >= 0 && page < run.pages ? (keysOnly ? pageHeadOf : pageOf)(run, page, bodies.get(page)) : null;
      bodies.clear();
      if (entries && !reverse) noteSuccessor(run, page, nextFences.get(page + 1));
      if (entries && !(entries instanceof PageHead)) readValue.remember?.(run, page, entries);
      keys = entries?.keys ?? [];
      tombs = Uint8Array.from(keys, (_, at) => Number(entries.tomb(at)));
      length = keys.length; first = keys[0] ?? null; last = keys.at(-1) ?? null;
      index = atBound ? (reverse ? ceilIndex(keys, hi) - 1 : ceilIndex(keys, lo)) : reverse ? length - 1 : 0;
      headOf();
    };
    if (reverse) {
      page = lastPages(run, [{ key: hi, strict: true, from: 0 }], bodies, null, null, keysOnly)[0];
      load(true);
    } else {
      page = Math.max(0, lastPages(run, [{ key: lo, strict: false, from: 0 }], bodies, nextFences, null, keysOnly)[0]);
      load(true);
    }
    const settle = () => {
      while (page >= 0 && page < run.pages && (!length && run.pageFormat === 1 || length && (index < 0 || index >= length))) {
        const neighbor = run.pageFormat === 1
          ? reverse ? previousSparse(run, page - 1) : nextSparse(run, page + 1)
          : null;
        const nextPage = run.pageFormat === 1 ? neighbor?.page ?? (reverse ? -1 : run.pages) : page + (reverse ? -1 : 1);
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
          page = lastPages(run, [{ key: bound, strict: reverse, from }], bodies, reverse ? null : nextFences, null, keysOnly)[0];
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
    if (run.pageFormat === 1) page = nextSparse(run, page)?.page ?? run.pages;
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
      let name = `${run.run}:${page}`;
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
        let row = rows.next();
        if (run.pageFormat === 1 && row.done) {
          closeRows();
          rows = sql.exec(`SELECT page, body FROM ${runTable(run.run)} WHERE page >= ? AND page <= ? ORDER BY page LIMIT 16`, page, last)[Symbol.iterator]();
          row = rows.next();
        }
        if (run.pageFormat === 1 && row.done) { page = last + 1; close(); return; }
        if (run.pageFormat === 1) { page = row.value.page; name = `${run.run}:${page}`; }
        if (row.done || row.value.page !== page) throw new Error(`Page ${page} of ${runTable(run.run)} is missing.`);
        entries = decodePage(row.value.body, parseJson, run.pageFormat === 1 && page === 0);
        seed(name, entries, entries.bytes);
        if (page === rowsThrough && run.pageFormat !== 1) closeRows();
      }
      readValue.remember(run, page, entries);
      keys = entries.keys;
      tombs = Uint8Array.from(keys, (_, at) => Number(entries.tomb(at)));
      index = firstPage ? ceilIndex(keys, lo) : 0;
      firstPage = false;
      head = null; headAt = -1;
    };
    try { load(); } catch (error) { close(); throw error; }
    const settle = () => { while (page <= last && (!keys.length && run.pageFormat === 1 || keys.length && index >= keys.length)) {
      page = run.pageFormat === 1 ? nextSparse(run, page + 1)?.page ?? run.pages : page + 1;
      load();
    } };
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
  function range(lo, hi, { reverse = false, limit = Infinity, readValue = null, keys_only = false } = {}) {
    const openValue = cursorValues({ workspace_bytes: 1024 * 1024 });
    const sources = [memCursor(lo, hi, reverse), ...runs.filter(run => !(run.last < lo || run.first >= hi)).map(run => runCursor(run, lo, hi, reverse, openValue, keys_only))];
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
      const wanted = !keys_only && (!readValue || readValue(best[0]));
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
    // The same call workspace range() keeps: a group's reverse search reopens pages its forward walk decoded.
    const readValue = cursorValues({ workspace_bytes: 1024 * 1024 });
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
      const cursor = runCursor(run, lo, hi, false, undefined, true);
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
  function limitedRanges(bounds, { limit_per_range, value_budget, page_budget, entry_budget, keys_only = false, reverse = false }, frontiers = null) {
    const windows = bounds.filter(({ lo, hi }) => lo < hi).sort((a, b) => (a.lo < b.lo ? -1 : a.lo > b.lo ? 1 : 0) * (reverse ? -1 : 1));
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
      const saved = reverse ? null : indexes.length ? frontiers?.get(run) : null;
      const previous = saved && indexes[0].lo >= saved.key ? saved : null;
      // The prior answer certifies fence[page] <= previous.key <= every new lower bound.
      // Search after that page and carry the certified key as its lower bracket;
      // this skips both re-seeking earlier pages and re-reading a predecessor fence.
      const from = previous ? previous.page + 1 : 0;
      const probe = key => ({ key, strict: false, from, ...(previous ? { lowerProof: previous.key } : {}) });
      const firstProbe = indexes.length ? (reverse ? { key: indexes[0].hi, strict: true, from: 0 } : probe(indexes[0].lo)) : null;
      if (reverse || (firstProbe && settledPage(run, firstProbe) === undefined)) {
        // A cold pilot would add a seek for scattered ranges and move an
        // eight-probe batch below its shared-fence threshold. Keep one batch.
        const pages = lastPages(run, indexes.map(window => reverse ? { key: window.hi, strict: true, from: 0 } : probe(window.lo)), null, nextFences);
        for (let at = 0; at < indexes.length; at += 1) if (reverse ? pages[at] >= 0 : true) starts.set(indexes[at].at, Math.max(0, pages[at]));
      } else if (indexes.length) {
        // Resolve the first selected bound separately. Its already-validated successor fence proves every later
        // bound below that fence starts on the same page, without another seek through unrelated run history.
        const [first, ...rest] = indexes;
        const [found] = lastPages(run, [reverse ? { key: first.hi, strict: true, from: 0 } : probe(first.lo)], null, nextFences);
        const page = Math.max(0, found);
        starts.set(first.at, page);
        const successor = nextFences.get(found + 1);
        const unresolved = [];
        for (const index of reverse ? [] : rest) {
          if (successor !== undefined && index.lo < successor) starts.set(index.at, page);
          else unresolved.push(index);
        }
        if (!reverse && unresolved.length) {
          const pages = lastPages(run, unresolved.map(({ lo }) => ({ key: lo, strict: false, from: page })), null, nextFences);
          for (let at = 0; at < unresolved.length; at += 1) starts.set(unresolved[at].at, Math.max(0, pages[at]));
        }
      }
      // A clamped page0 for a key before the run is a scan start, not a certified lower bracket.
      if (!reverse && indexes.length && indexes[0].lo >= run.first) frontiers?.remember(run, indexes[0].lo, starts.get(indexes[0].at));
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
      const group = windows.slice(from, through).map(window => ({ window, cursors: [memCursor(window.lo, window.hi, reverse)] }));
      for (const { run, starts, nextFences } of sources) {
        const pages = new Map();
        const missing = [];
        const numbers = [...new Set(group.flatMap((_, at) => starts.has(from + at) ? [starts.get(from + at)] : []))];
        for (const page of numbers) {
          debit(page_budget);
          const held = cache.get(`${run.run}:${page}`);
          if (held && (keys_only || !(held.value instanceof PageHead))) pages.set(page, held.value); else missing.push(page);
        }
        for (let at = 0; at < missing.length; at += 64) {
          const asked = missing.slice(at, at + 64);
          let read = 0;
          const projection = keys_only ? pageHeadSql('body') : null;
          const fields = projection ? `${projection.body} AS body, ${projection.tailChars} AS tail_chars` : 'body';
          for (const row of sql.exec(`SELECT page, ${fields} FROM ${runTable(run.run)} WHERE page IN (SELECT value FROM json_each(?)) ORDER BY page`, JSON.stringify(asked))) {
            const page = keys_only
              ? decodePageHead({ body: row.body, tailChars: row.tail_chars }, parseJson, run.pageFormat === 1 && row.page === 0)
              : decodePage(row.body, parseJson, run.pageFormat === 1 && row.page === 0);
            pages.set(row.page, page);
            seed(`${run.run}:${row.page}`, page, page.bytes);
            read += 1;
          }
          if (read !== asked.length) throw new Error(`A page of ${runTable(run.run)} is missing.`);
        }
        if (!reverse) for (const page of numbers) noteSuccessor(run, page, nextFences.get(page + 1));
        for (let at = 0; at < group.length; at += 1) {
          if (!starts.has(from + at)) continue;
          const { window, cursors } = group[at];
          let page = starts.get(from + at);
          let entries = pages.get(page);
          let index = reverse ? ceilIndex(entries.keys, window.hi) - 1 : ceilIndex(entries.keys, window.lo);
          cursors.push({
            peek() {
              while (entries && (reverse ? index < 0 : index >= entries.length)) {
                page = run.pageFormat === 1
                  ? (reverse ? previousSparse(run, page - 1)?.page ?? -1 : nextSparse(run, page + 1)?.page ?? run.pages)
                  : page + (reverse ? -1 : 1);
                if (reverse ? page < 0 : page >= run.pages) { entries = null; break; }
                // A verified immutable fence proves this page and all later
                // pages lie beyond this window, before any body/budget charge.
                if (!reverse && nextFences.has(page) && nextFences.get(page) >= window.hi) { entries = null; break; }
                debit(page_budget);
                entries = (keys_only ? pageHeadOf : pageOf)(run, page);
                index = reverse ? entries.length - 1 : 0;
              }
              if (!entries || (reverse ? entries.keys[index] < window.lo : entries.keys[index] >= window.hi)) return null;
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
              }, here.tomb(hereAt)];
            },
            next() { index += reverse ? -1 : 1; },
          });
        }
      }
      for (const { cursors } of group) {
        let count = 0;
        while (count < limit_per_range) {
          let best = null, bestAt = -1;
          for (let at = 0; at < cursors.length; at += 1) {
            const head = cursors[at].peek();
            if (head && (best === null || (reverse ? head[0] > best[0] : head[0] < best[0]))) { best = head; bestAt = at; }
          }
          if (best === null) break;
          for (let at = 0; at < cursors.length; at += 1) {
            const head = at === bestAt ? null : cursors[at].peek();
            if (head && head[0] === best[0]) cursors[at].next();
          }
          cursors[bestAt].next();
          debit(entry_budget);
          const removed = bestAt === 0 ? best[1] === TOMB : best[2];
          const value = removed ? TOMB : keys_only ? undefined : bestAt === 0 ? best[1] : best[1]();
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

  // A caller paging forward through ranges can retain a prior validated lower page bound,
  // without retaining page bodies, fences, membership filters, or run objects. Private
  // frontier state is accepted only from this owner; ordinary ranges never accepts a token.
  function rangeReader() {
    let held = new WeakMap(), recent = new Map(), bytes = 0, revision = rangeRevision, closed = false;
    const budget = Math.max(0, Math.min(settings.page_bytes, settings.memtable_bytes));
    const reset = () => { held = new WeakMap(); recent = new Map(); bytes = 0; revision = rangeRevision; };
    const frontiers = {
      get(run) {
        const entry = held.get(run);
        return entry?.active ? entry : null;
      },
      remember(run, key, page) {
        const size = 64 + key.length * 2;
        if (size > budget || !Number.isInteger(page) || page < 0 || page >= run.pages) return;
        const old = held.get(run);
        if (old?.active) { recent.delete(old); bytes -= old.bytes; old.active = false; old.key = null; }
        const entry = { key, page, bytes: size, active: true };
        held.set(run, entry); recent.set(entry, true); bytes += size;
        // No retained object has a reference to its run. Eviction also removes
        // its key text, so even a live WeakMap key cannot retain evicted strings.
        while (recent.size > 64 || bytes > budget) {
          const entry = recent.keys().next().value;
          recent.delete(entry); bytes -= entry.bytes;
          entry.active = false; entry.key = null; entry.page = 0; entry.bytes = 0;
        }
      },
    };
    return {
      ranges(bounds, { value_budget = null, page_budget = null, entry_budget = null, limit_per_range = Infinity, keys_only = false, reverse = false, ...rest } = {}) {
        if (closed) throw Object.assign(new Error('This range reader is closed.'), { code: 'range_reader_closed' });
        if (revision !== rangeRevision) reset();
        try {
          if (!Number.isFinite(limit_per_range) || limit_per_range < 0) return ranges(bounds, { value_budget, page_budget, entry_budget, limit_per_range, keys_only, reverse, ...rest });
          return limitedRanges(bounds, { value_budget, page_budget, entry_budget, limit_per_range: Math.floor(limit_per_range), keys_only, reverse }, frontiers);
        }
        catch (error) { reset(); throw error; }
      },
      reset() { if (!closed) reset(); },
      close() { reset(); closed = true; },
      held: () => ({ entries: recent.size, bytes, limit_bytes: budget }),
    };
  }

  // Several disjoint key ranges in one pass over each run. A screen can ask for hundreds of exact index prefixes;
  // opening a cursor on every run for every prefix repeats the same SQLite page reads thousands of times.
  function ranges(bounds, { value_budget = null, page_budget = null, entry_budget = null, limit_per_range = Infinity, resident_exact_points = false, preserve_exact_progress = false, keys_only = false, reverse = false } = {}) {
    if (Number.isFinite(limit_per_range) && limit_per_range >= 0) return limitedRanges(bounds, { value_budget, page_budget, entry_budget, limit_per_range: Math.floor(limit_per_range), keys_only, reverse });
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
    const exactPoints = !keys_only && resident_exact_points && page_budget === null && windows.every(({ lo, hi }) => hi === `${lo}\u0000`);
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
          keep(key, mem.get(key) === TOMB ? TOMB : keys_only ? undefined : mem.get(key));
        }
      }
      for (const run of runs) {
        const memberships = new Map();
        const preparedFences = new Map();
        // Capture only already-resident immutable pages before sparse samples
        // can evict them. This request-local reference is bounded by the cache
        // it came from; admission and value decoding still happen below once
        // per selected page, including mixed exact/general windows.
        const residentPoints = new Map();
        const residentPages = new Map();
        for (const { lo, hi } of windows) if (hi === `${lo}\u0000` && !found.has(lo)) {
          const number = coveringPage(run, lo, false);
          const held = number === undefined ? null : cache.get(`${run.run}:${number}`);
          if (held && (keys_only || !(held.value instanceof PageHead))) { residentPoints.set(lo, number); residentPages.set(number, held.value); }
        }
        if (!run.filter && run.filterBits > 0) {
          const selected = windows.filter(({ lo, hi }) => hi === `${lo}\u0000` && !found.has(lo) && !residentPoints.has(lo) && lo >= run.first && lo <= run.last).map(({ lo }) => lo);
          for (let at = 0; at < selected.length; at += 64) {
            const group = selected.slice(at, at + 64);
            const { holds, fences } = sparseFilterRead(run, group, null, run.pageFormat === 1 ? null : {
              unsettled: group.map(key => settledPage(run, { key, strict: false, from: 0 }) === undefined),
              pages: preparedFences.size ? [] : [...fenceRoundPages([{ lo: 0, hi: run.pages - 1 }])],
            });
            group.forEach((key, index) => memberships.set(key, holds[index]));
            if (fences) for (const [page, first] of fences) preparedFences.set(page, first);
          }
        } else if (run.filterBits < 0) {
          // A blocked filter's rows for every exact key of this run, read together rather than a row a key.
          const selected = windows.filter(({ lo, hi }) => hi === `${lo}\u0000` && !found.has(lo) && !residentPoints.has(lo) && lo >= run.first && lo <= run.last).map(({ lo }) => lo);
          mayHoldMany(run, selected).forEach((holds, at) => memberships.set(selected[at], holds));
        }
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
          return !(hi === `${lo}\u0000` && (found.has(lo) || !residentPoints.has(lo) && !(memberships.has(lo) ? memberships.get(lo) : mayHold(run, lo))));
        });
        // An exact key can occupy only its lower fence's page. General ranges
        // still seek both ends, together in one statement.
        const probes = [];
        const probeAt = asked.map(({ lo, hi }) => {
          const first = probes.push({ key: lo, strict: false, from: 0 }) - 1;
          const last = hi === `${lo}\u0000` ? first : probes.push({ key: hi, strict: true, from: 0 }) - 1;
          return { first, last };
        });
        const sought = probes.map(probe => !probe.strict && probe.from === 0 ? residentPoints.get(probe.key) : undefined);
        const unsettled = probes.map((_, at) => at).filter(at => sought[at] === undefined);
        const searched = lastPages(run, unsettled.map(at => probes[at]), null, null, preparedFences);
        unsettled.forEach((at, index) => { sought[at] = searched[index]; });
        for (let at = 0; at < asked.length; at += 1) {
          const first = Math.max(0, sought[probeAt[at].first]);
          const last = sought[probeAt[at].last];
          for (let page = run.pageFormat === 1 ? nextSparse(run, first)?.page ?? run.pages : first;
            page <= last; page = run.pageFormat === 1 ? nextSparse(run, page + 1)?.page ?? run.pages : page + 1) {
            if (pageNumbers.has(page)) continue;
            if (page_budget) {
              if (page_budget.remaining <= 0) throw new KeptRangeBudgetExceeded();
              page_budget.remaining -= 1;
            }
            pageNumbers.add(page);
          }
        }
        const readPage = page => {
          const selected = [];
          for (let at = 0; at < page.length; at += 1) {
            const key = page.keys[at];
            if (wanted(key) && !found.has(key)) selected.push(at);
          }
          if (keys_only) {
            for (const at of selected) keep(page.keys[at], page.tomb(at) ? TOMB : undefined);
            return;
          }
          for (const at of selected) {
            deferred.push({ page, at });
            if (deferred.length === 64) admitDeferred();
          }
        };
        // Selected multipart winners share one bounded read too, across the pages they fall on: up to 64 winners in page
        // order are one statement however many pages they straddle (so at most 64 pages are held for it). Charge the
        // actual UTF-8 length before returning any body: a winner beyond the remaining allowance contributes metadata
        // only. Include inline winners in the running charge so grouped reads preserve the ordinary admission order.
        const deferred = [];
        const admitDeferred = () => {
          while (deferred.length) {
            const pending = deferred.splice(0, 64).map(({ page, at }) => {
              const big = page.big(at), held = big ? cache.get(`big:${big[0]}`) : null;
              return { page, at, big, held, chars: held ? held.value.length : page.chars(at) };
            });
            const spilled = pending.filter(item => item.big && !item.held);
            if (value_budget && spilled.length > 1) {
              const rows = new Map();
              const asked = pending.map(item => [item.big && !item.held ? item.big[0] : null, item.chars]);
              // Each group has at most 64 identities; the SQL window admits a prefix whose complete bodies
              // fit the caller's existing byte budget. No absent, superseded or later winner is decoded.
              for (const row of sql.exec(`WITH wanted AS (
                SELECT CAST(key AS INTEGER) AS ordinal, json_extract(value, '$[0]') AS ref,
                  CAST(json_extract(value, '$[1]') AS INTEGER) AS inline_chars FROM json_each(?)
              ), sizes AS (
                SELECT ordinal, ref, inline_chars + COALESCE((SELECT SUM(length(CAST(body AS BLOB)))
                  FROM ${BIG} WHERE ref = wanted.ref), 0) AS chars FROM wanted
              ), charged AS (
                SELECT ordinal, ref, chars, SUM(chars) OVER (ORDER BY ordinal) AS total FROM sizes
              ) SELECT charged.ordinal, charged.ref, charged.chars, stored.part, stored.body
                FROM charged LEFT JOIN ${BIG} AS stored ON stored.ref = charged.ref AND charged.total <= ?
                ORDER BY charged.ordinal, stored.part`, JSON.stringify(asked), value_budget.remaining)) {
                let item = rows.get(row.ordinal);
                if (!item) { item = { chars: row.chars, parts: [] }; rows.set(row.ordinal, item); }
                if (typeof row.body === 'string') item.parts.push(row.body);
              }
              for (let ordinal = 0; ordinal < pending.length; ordinal += 1) {
                const item = pending[ordinal], row = rows.get(ordinal), key = item.page.keys[item.at];
                if (!row) throw new Error('A selected kept value length is missing.');
                if (row.chars > value_budget.remaining) throw new KeptRangeBudgetExceeded();
                value_budget.remaining -= row.chars;
                let value;
                if (item.big && !item.held) {
                  if (!row.parts.length) throw new Error(`A kept value (${item.big[0]}) is missing.`);
                  const text = row.parts.join('');
                  const opened = { value: parseJson(text, { kind: 'big', ref: item.big[0] }), length: text.length };
                  value = opened.value;
                  seed(`big:${item.big[0]}`, opened, 64 + opened.length * 3);
                } else value = valueOf(item.page.entry(item.at));
                keep(key, value);
              }
              continue;
            }
            for (const { page, at } of pending) {
              const key = page.keys[at];
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
          if (held && (keys_only || !(held.value instanceof PageHead))) { cache.delete(name); cache.set(name, held); readPage(held.value); }
          else if (residentPages.has(page)) readPage(residentPages.get(page));
          else missing.push(page);
        }
        // One streaming statement per group of pages, even when the selected prefixes are far apart.
        for (let at = 0; at < missing.length; at += 64) {
          const group = missing.slice(at, at + 64);
          let read = 0;
          const projection = keys_only ? pageHeadSql('body') : null;
          const fields = projection ? `${projection.body} AS body, ${projection.tailChars} AS tail_chars` : 'body';
          for (const row of sql.exec(`SELECT page, ${fields} FROM ${runTable(run.run)} WHERE page IN (SELECT value FROM json_each(?)) ORDER BY page`, JSON.stringify(group))) {
            const page = keys_only
              ? decodePageHead({ body: row.body, tailChars: row.tail_chars }, parseJson, run.pageFormat === 1 && row.page === 0)
              : decodePage(row.body, parseJson, run.pageFormat === 1 && row.page === 0);
            seed(`${run.run}:${row.page}`, page, page.bytes);
            readPage(page);
            read += 1;
          }
          if (read !== group.length) throw new Error(`A page of ${runTable(run.run)} is missing.`);
        }
        admitDeferred();
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
    if (absent.has(key)) return undefined;
    for (const run of runs) {
      const found = runGet(run, key);
      if (found === TOMB) break;
      if (found !== undefined) return found;
    }
    noteAbsent(key);
    return undefined;
  }
  // get() for many keys at once: each key's value, undefined when absent or removed, the newest version winning. Every
  // run is asked once for all of them (ranges over exact windows: membership, fences and pages read together), so N keys
  // over R runs cost statements per run, never per key.
  function getMany(keys) {
    const asked = [...new Set(keys)].filter(key => mem.has(key) || !absent.has(key));
    const found = new Map(asked.length ? ranges(asked.map(key => ({ lo: key, hi: `${key}\u0000` }))) : []);
    for (const key of asked) if (!found.has(key) && !mem.has(key)) noteAbsent(key);
    return new Map(keys.map(key => [key, found.get(key)]));
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
    writable();
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
    writable();
    // This baseline can read format1, but cannot publish sparse structural
    // edits. Refuse before touching an earlier dense version or BIG row.
    if (meta.get('merge')?.pageFormat === 1 || meta.get('merge_paused')?.pageFormat === 1)
      throw Object.assign(new Error('Sparse structural writing has not been admitted by this host.'), { code: 'kept_sparse_write_not_admitted', status: 503, retryable: true });
    for (const run of runs) {
      if (key < run.first || key > run.last || !mayHold(run, key)) continue;
      const number = lastPage(run, key);
      if (number < 0) continue;
      const selected = pageOf(run, number), at = floorIndex(selected.keys, key);
      if (at >= 0 && selected.keys[at] === key && run.pageFormat === 1)
        throw Object.assign(new Error('Sparse structural writing has not been admitted by this host.'), { code: 'kept_sparse_write_not_admitted', status: 503, retryable: true });
    }
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
    sql.exec(`INSERT INTO ${RUNS} (run, age, pages, keys, bytes, last, filter_bits, page_layout) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, run, age, written.pages, written.keys, written.bytes, JSON.stringify(written.last), written.filterBits, PAGE_LAYOUT_V2);
  }

  /** Writes the memtable as one run and empties it. `covered` (any JSON) is kept in the same transaction as how far the
   *  caller's log the runs now hold (read back with covered()). Answers the run written, or null when empty. */
  function flush({ covered } = {}) {
    writable();
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
    runs.unshift({ run, age, pages: written.pages, keys: written.keys, bytes: written.bytes, last: written.last, first: written.first, filter: written.filter, filterBits: written.filterBits, layout: PAGE_LAYOUT_V2 });
    memClear();
    return run;
  }

  // ---- merging --------------------------------------------------------------------------------------------------------
  // The runs to merge next: from the youngest run that starts such a group, that run and, oldest-ward, each next run
  // while it holds no more than size_ratio times the pages of the runs before it in the group, or no more than
  // tier_spread times their average (runs of about one size), when that is fan_in runs or more (merging two at a time copied about 4 pages for each page written out in a model of the owner's store's runs on
  // 2026-10-07; fan_in at a time, about 1.4); else null (a small write-out younger than a large run never stops the runs older than it merging). A run
  // is copied again only beside comparable page work written since it was made, so each copy grows the run
  // a value is in, a value is copied about log4(what the store holds / what its write-out held) times in its life at fan_in 4 (log_fan_in in general), and
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
  // The age-adjacent runs, at least two, holding the most bytes whose merge `admit` accepts. They must be adjacent: a run
  // between two merged ones would otherwise hold keys older than the output and newer than one of its inputs. Admission
  // is monotonic in the bytes of a window, so each start is binary searched for its widest end.
  function partialFold(byAge, admit) {
    const prefix = [0];
    for (const run of byAge) prefix.push(prefix[prefix.length - 1] + run.bytes);
    let best = null;
    for (let start = 0; start + 1 < byAge.length; start += 1) {
      let low = start + 2, high = byAge.length, end = 0;
      while (low <= high) {
        const middle = (low + high) >> 1;
        if (admit(byAge.slice(start, middle))) { end = middle; low = middle + 1; } else high = middle - 1;
      }
      if (end && (!best || prefix[end] - prefix[start] > best.bytes)) best = { start, end, bytes: prefix[end] - prefix[start] };
    }
    return best ? byAge.slice(best.start, best.end) : null;
  }
  function planMerge({ cheapest = false, tiersOnly = false, excluded = new Set(), admit = () => true } = {}) {
    if (cheapest) {
      const byAge = [...runs].sort((a, b) => a.age - b.age);
      let least = null;
      for (let start = 0; start + settings.fan_in <= byAge.length; start += 1) {
        const group = byAge.slice(start, start + settings.fan_in);
        if (group.some(run => excluded.has(run.run)) || !admit(group)) continue;
        const pages = group.reduce((sum, run) => sum + run.pages, 0);
        if (!least || pages < least.pages) least = { group, pages };
      }
      return least?.group ?? null;
    }
    if (!tiersOnly && compactionDue()) {
      const all = [...runs].sort((a, b) => a.age - b.age);
      // When the complete fold does not fit the room left, fold the widest run of neighbours that does (partialFold):
      // its output replaces them and frees their bytes, so the next wake has more room, until the complete fold fits.
      return admit(all) ? all : partialFold(all, admit);
    }
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
  // `hard`: the room under the database's own limit less backlog_reserve_bytes, for a backlog's cheapest merge only.
  function room({ hard = false } = {}) {
    const size = Number(sql.databaseSize);
    if (!Number.isFinite(size) || size <= 0) return Infinity;
    let free = 0;
    // Optional host metadata, never speculative SQL: a caught unsupported PRAGMA can already have invalidated
    // the owning record projection. Hosts without a supported count conservatively admit no reusable pages.
    try {
      const bytes = sql.databaseFreeBytes;
      if (Number.isSafeInteger(bytes) && bytes >= 0 && bytes <= size) free = bytes;
    } catch { /* unavailable metadata cannot create capacity */ }
    return (hard ? settings.database_limit_bytes - settings.backlog_reserve_bytes : settings.database_limit_bytes * settings.space_share) - (size - free);
  }
  // The merge to start next: a backlog's cheapest group first, then a complete fold, then a size-tier merge, the first
  // whose inputs, times space_factor, fit the room left. A merge that does not fit waits, and the cheaper ones still run.
  function nextMerge({ backlogOnly = false, alongside = null } = {}) {
    const excluded = new Set(alongside?.inputs ?? []);
    // Space admitted for the original fold remains reserved while another
    // merge runs beside it. Its partial output is already in databaseSize.
    const reserve = alongside ? Math.max(0, runs.filter(run => excluded.has(run.run)).reduce((sum, run) => sum + run.bytes, 0) * settings.space_factor - alongside.bytes) : 0;
    let left = null, hardLeft = null;
    const admit = group => {
      if (!group) return false;
      left ??= room() - reserve;
      return group.reduce((sum, run) => sum + run.bytes, 0) * settings.space_factor <= left;
    };
    // A backlog's cheapest group may also use the room under the hard limit: its output is no larger than its inputs,
    // it drops their overwritten versions and tombstones, and every read probes each run it leaves. A store past
    // space_share otherwise never merged again while its runs grew (a large account's store, 10.4 GB and about 1,700 runs,
    // 2026-10-16). Complete folds and size-tier merges keep the space_share room, and beside an unfinished fold a
    // backlog group keeps it too, so the fold's reserved output room is never spent.
    const admitBacklog = group => {
      if (admit(group)) return true;
      if (!group || alongside) return false;
      hardLeft ??= room({ hard: true }) - reserve;
      return group.reduce((sum, run) => sum + run.bytes, 0) * settings.space_factor <= hardLeft;
    };
    // Page counts rank copy work only among groups that fit. Uniform values and
    // shared prefixes can make a higher-page group occupy fewer bytes: rejecting
    // only the global page minimum stranded an otherwise mergeable backlog.
    const cheapest = backlog() ? planMerge({ cheapest: true, ...(backlogOnly ? { excluded } : {}), admit: admitBacklog }) : null;
    if (admitBacklog(cheapest)) return cheapest;
    if (backlogOnly) return null;
    return [planMerge({ admit }), planMerge({ tiersOnly: true })].find(admit) ?? null;
  }
  function startMerge(group) {
    const oldest = Math.min(...runs.map(run => run.age));
    const state = { inputs: group.map(run => run.run), output: nextRun(), age: Math.max(...group.map(run => run.age)), drop_tombstones: group.some(run => run.age === oldest), filter_keys: group.reduce((sum, run) => sum + run.keys, 0), after: null, pages: 0, keys: 0, bytes: 0, last: null };
    if (group.length === runs.length) state.compaction_debt_snapshot = compactionDebt();
    else if (compactionDue()) state.input_bytes = group.reduce((sum, run) => sum + run.bytes, 0);
    transaction(() => { meta.set('merge', state); meta.set('last_run', state.output); });
    return state;
  }
  /** One bounded step of merging (at most max_pages output pages and an input budget based on the source count). */
  function step({ max_pages = 64, max_input_pages = null, hasTime = () => true } = {}) {
    writable();
    let state = meta.get('merge');
    if (state?.pageFormat === 1 || meta.get('merge_paused')?.pageFormat === 1)
      throw Object.assign(new Error('Sparse merge-output writing has not been admitted by this host.'), { code: 'kept_sparse_write_not_admitted', status: 503, retryable: true });
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
    if (run.pageFormat === 1) page = nextSparse(run, page)?.page ?? run.pages;
    const openPage = () => { beforePage(); return pageOf(run, page); };
    let entries = page < run.pages ? openPage() : null;
    let index = entries ? ceilIndex(entries.keys, lo) : 0;
    const settle = () => { while (entries && index >= entries.length) {
      page = run.pageFormat === 1 ? nextSparse(run, page + 1)?.page ?? run.pages : page + 1;
      entries = page < run.pages ? openPage() : null; index = 0;
    } };
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
    // A partial fold dropped the overwritten versions inside its window: the bytes its output is smaller than its inputs.
    else if (state.input_bytes) meta.set('compaction_debt', Math.max(0, compactionDebt() - Math.max(0, state.input_bytes - state.bytes)));
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
    writable();
    const promoted = promotable();
    if (promoted) {
      promoted.filter = loadFilter({ run: promoted.run, filter_bits: promoted.filterBits });
      return { filled: true, more: promotable() !== null || (!meta.get('merge') && unfiltered() !== null), pages: 0 };
    }
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
    const rows = run.pageFormat === 1
      ? sql.exec(`SELECT page, body FROM ${runTable(run.run)} WHERE page >= ? ORDER BY page LIMIT ?`, fill.page, max_pages)
      : sql.exec(`SELECT page, body FROM ${runTable(run.run)} WHERE page >= ? AND page < ? ORDER BY page`, fill.page, end);
    for (const row of rows) {
      for (const key of decodePage(row.body, parseJson, run.pageFormat === 1 && row.page === 0).keys) blockAdd(fill.bits, fill.blocks, key);
      fill.page = row.page + 1;
      read += 1;
      if (read % 64 === 0 && !hasTime()) break;
    }
    if (run.pageFormat === 1 && read < max_pages && !nextSparse(run, fill.page)) fill.page = run.pages;
    const done = fill.page >= run.pages;
    // Saved at least every fill_pages pages: a restart (every deployment resets the store, about every 25 minutes) loses a
    // fill kept in memory, and a threshold above the run's own page count saved nothing before the run was done, so five
    // runs of the owner's own-records book stayed unfiltered for hours (880c74dd, 2026-10-21).
    if (done || fill.page - fill.saved >= Math.min(settings.fill_save_pages, settings.fill_pages)) saveFill(run, fill, done);
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
    getMany,
    walkKeys,
    jsonParts,
    range,
    groupHeads,
    hasRange,
    walk,
    ranges,
    rangeReader,
    /** Puts one key; chars, when the caller knows it, is about how long the value's JSON is (only memory is counted
     *  with it, so the memtable is written out at about memtable_bytes without measuring every value). */
    put(key, value, chars, debt = 0) { writable(); if (value === undefined) throw new Error('A kept value cannot be undefined.'); memPut(key, value, chars, debt); },
    remove(key, debt = 0) { writable(); memPut(key, TOMB, undefined, debt); },
    flush,
    step,
    fillFilters,
    /** Whether a run has no membership filter yet (fillFilters gives it one as idle work). */
    fillDue: () => promotable() !== null || (meta.get('merge') === undefined && unfiltered() !== null),
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
    /** Frees derived space for a full store (src/full-store-recovery.mjs): drops the partial output of a merge under
     *  way, which its inputs still hold whole (they go only when it publishes, in finishMerge's transaction), so it
     *  starts again once room() admits it; then drains one slice of its dropped-reference queue, retiring only values
     *  a published merge replaced and otherwise forgetting queue entries without touching surviving values.
     *  Never touches a run the catalog holds. Answers { freed, more }. */
    releaseDerivedSpace() {
      let freed = false;
      const state = meta.get('merge');
      if (state) {
        transaction(() => {
          // The drop comes first: its pages go to the free list, where the marker writes after it find room.
          sql.exec(`DROP TABLE IF EXISTS ${runTable(state.output)}`);
          const paused = meta.get('merge_paused');
          if (paused) { meta.set('merge', { ...paused, backlog_yielded: true }); meta.remove('merge_paused'); }
          else meta.remove('merge');
          if (cleanupPending()) meta.set('big_drop_mode', 'forget');
          else meta.remove('big_drop_mode');
        });
        dropCached(state.output);
        building = null;
        freed = true;
      } else if (cleanupPending()) {
        // An abandoned output leaves forget-mode entries whose values the input runs still hold. The same bounded
        // owner clears those entries without retiring their values; leaving them queued reports more forever.
        cleanupBigDrops();
        freed = true;
      }
      return { freed, more: meta.get('merge') !== undefined || cleanupPending() };
    },
    /** Whether a merge is under way or due. */
    mergeDue: () => meta.get('merge') !== undefined || cleanupPending() || nextMerge() !== null,
    /** How far the caller's log the runs hold, as given to flush({ covered }). */
    covered: () => meta.get('covered'),
    /** Forgets the memtable (the caller replays its log into it again). */
    clearMemtable: memClear,
    /** Reads the catalog again: runs a rolled-back transaction made are let go, runs another made are read. */
    reloadCatalog() {
      rangeRevision += 1;
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
    /** What decides whether a merge is due, in a few numbers for a log line: runs, their bytes, the recorded debt, the room. */
    summary: () => {
      const space = spaceReport();
      return { runs: runs.length, run_bytes: runs.reduce((sum, run) => sum + run.bytes, 0), largest_run_bytes: runs.reduce((most, run) => Math.max(most, run.bytes), 0),
        compaction_debt: compactionDebt(), compaction_due: compactionDue(), merging: meta.get('merge') !== undefined, paused: meta.get('merge_paused') !== undefined,
        database_bytes: space.database_bytes, merge_room_bytes: space.merge_room_bytes };
    },
    held: () => ({ memtable_keys: mem.size, memtable_bytes: memBytes, cache_bytes: cacheBytes, filter_bytes: residentFilterBytes(), merge_filter_bytes: mergeFilterBytes(), compaction_debt: compactionDebt() + memCompactionDebt, space: spaceReport(), merge: mergeReport(meta.get('merge')), merge_paused: mergeReport(meta.get('merge_paused')), runs: runs.map(({ run, age, pages, keys, bytes, filter, filterBits }) => ({ run, age, pages, keys, bytes, filter: filter ? 'resident' : filterBits < 0 ? 'blocks' : filterBits > 0 ? 'stored' : 'none' })), filter_fill: filling ? { run: filling.run, page: filling.page } : meta.get('filter_fill') ?? null,
      old_layout_pages: runs.reduce((sum, run) => sum + (run.layout === PAGE_LAYOUT_V2 ? 0 : run.pages), 0) }),
    meta,
    /** Every table this key space owns (for a host's table sweeps to leave alone). */
    tables: () => [...new Set([RUNS, META, BIG, BIG_DROPS, ...runs.map(run => runTable(run.run)), ...[meta.get('merge'), meta.get('merge_paused')].filter(Boolean).map(state => runTable(state.output))])],
  };
}

/**
 * Brings a key space whose pages were removed from outside back to one that opens: answers which runs the catalogue lists that no
 * longer hold their pages, and, when there are any, lets the whole key space go in one transaction (every run table, the catalogue,
 * its metadata, its large values and their drop queue). It works on the raw database and never constructs the key space, because
 * a catalogue naming a run without its pages makes opening it throw ("Page 0 of record_keys_run_107535 is missing").
 *
 * Why the whole key space and not only the damaged runs: the runs left would hold large values and positions the metadata
 * (`covered`, the large-value counter) no longer vouches for, so a key space with some runs gone and the rest kept answers from a mix
 * nothing can check. With nothing kept it opens as a new one, and an owner that keeps a log replays it into the key space again
 * (record-log-store.mjs opens from `covered`, from zero when there is none).
 * Only for a store whose records are kept elsewhere or whose log is still whole: the keys of every run are gone with it.
 * A key space with no damage changes nothing. Answers { repaired, damaged: [run], dropped: runs let go }.
 */
export function repairKeptRunsCatalog(sql, { transaction = fn => fn(), prefix }) {
  const RUNS = `${prefix}_runs`, META = `${prefix}_meta`, BIG = `${prefix}_big`, BIG_DROPS = `${prefix}_big_drops`;
  const table = name => sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", name).toArray().length > 0;
  if (!table(RUNS)) return { repaired: false, damaged: [], dropped: 0 };
  const listed = sql.exec(`SELECT run, pages FROM ${RUNS} ORDER BY run`).toArray();
  const damaged = listed.filter(({ run, pages }) => {
    const name = `${prefix}_run_${run}`;
    return !table(name) || sql.exec(`SELECT COUNT(*) AS n FROM ${name} WHERE page >= 0`).toArray()[0].n !== pages;
  }).map(({ run }) => run);
  // A catalogue of runs whose metadata is gone is as unvouched for: the position they cover is the metadata's.
  if (!damaged.length && !(listed.length && table(META) && sql.exec(`SELECT 1 FROM ${META} LIMIT 1`).toArray().length === 0)) return { repaired: false, damaged: [], dropped: 0 };
  const runTables = sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name GLOB ?", `${prefix}_run_*`).toArray().map(row => row.name);
  transaction(() => {
    for (const name of runTables) sql.exec(`DROP TABLE IF EXISTS ${name}`);
    sql.exec(`DELETE FROM ${RUNS}`);
    for (const name of [META, BIG, BIG_DROPS]) if (table(name)) sql.exec(`DELETE FROM ${name}`);
  });
  return { repaired: true, damaged: damaged.length ? damaged : listed.map(({ run }) => run), dropped: runTables.length };
}

export const KEPT_TOMBSTONE = TOMB;
