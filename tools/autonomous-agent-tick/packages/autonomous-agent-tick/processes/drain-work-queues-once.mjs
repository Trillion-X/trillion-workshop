/**
 * drain-work-queues-once.mjs — GENERIC autonomous work-queue drain (one-shot per clock::tick).
 *
 * The BLIND primitive The owner's convergence demanded: this script names NO work type. It reads
 * `queue-drain-descriptor` DATA records and drains each configured queue by dispatching that
 * descriptor's action via Envelope (slot::workflow execute_definition). SEO articles are ONE
 * descriptor row; newsletters/products/ebooks/podcasts are additional rows — ZERO source change
 * per type. This is the opposite of the reverted pump-articles-once.mjs (which hardcoded article
 * vocabulary in source). Here the vocabulary lives ONLY in DATA (Society); the engine is Physics.
 *
 * Per descriptor (all fields DATA):
 *   queue_kind        the record kind of the pending work items
 *   pending_status    status value that means "not yet done"  (default 'pending')
 *   done_status       status value to stamp on success        (default 'published')
 *   item_key_field    which item field addresses it for the write-back (default 'id')
 *   item_address_kind kind prefix for the item address `<kind>::<id>` (default = queue_kind)
 *   derive            {<name>: {strip_prefix_from_id: '<prefix>'}} computes synthetic fields (generic).
 *
 *   A DETERMINISTIC PER-ITEM ID NEEDS NO DESCRIPTOR RULE. `correlation_id` is already
 *   sha256(descriptor.id + '::' + itemId), computed below and merged into the derived item before
 *   the template is filled, so an action needing an idempotency key writes `"$correlation_id"`.
 *   It is namespaced by descriptor id STRUCTURALLY, so two queues cannot collide even if their
 *   authors pick the same names.
 *   dispatch_action   the Envelope definition_id to execute (the owner package's action)
 *   input_template    payload template ($field pulled from the (derived) item; nested ok — lib/template)
 *   dedup             {against_kind, item_key} — skip items whose derived key is covered by an existing record id
 *   completion        {satisfied_when:[{in_kind, where:[{field,op,value}], correlate_field?}]} — DATA-driven completion predicate (L090)
 *   escalation        {deadline_seconds, escalation_ladder?:[...], max_escalations} — DATA-driven escalation (L090)
 *   cap_per_tick      max items drained this tick (bounded; default 1)
 *   audit_kind        kind for the per-item audit record (default 'queue-drain-audit')
 *   selector          {mode, ...} — how to obtain items (drain-queue|select-where|generate), all DATA-driven
 *   writeback         {done_status, emit_to?: {queue_kind, item_template}} — optional pipeline edge
 *
 * Env: BITFIELD_TARGET_CARRIER_URL (or BITFIELD_TARGET_CARRIER_URL_FILE, the path the runtime publishes its address into), BITFIELD_DISPATCH_PARTITION.
 *
 * NOTE: the template substitution used to be inlined here, under a comment claiming a mounted
 * process cannot import a sibling. That was false twice over. The engine creates every mount-path
 * component (materialize_input_create_only, native_process.rs:557), AND this action's own manifest
 * entry has mounted `lib/template.mjs` the whole time (things-to-store-and-run.json, the read step
 * `read_template_lib` and its mount) while this file ignored the mounted owner and ran a copy.
 */
import { createHash } from 'node:crypto';
import { fillTemplate } from './lib/template.mjs';
import { resolveCarrier, resolvePartition, CARRIER_AND_PARTITION_REQUIRED } from './lib/carrier.mjs';

// ── GENERIC RAG grounding (L090/L093): a descriptor MAY declare a `grounding` block; the drain then
// retrieves the owner corpus, keyword-scores each slice against the item, and injects the top-K excerpts
// as a synthetic `grounding_json` field on the item BEFORE fillTemplate — so ANY queue grounds itself
// with ZERO drain change (the seo-articles row grounds in the tennis corpus; a newsletter row could
// ground in a different corpus_ref). The scoring is byte-reused from produce-grounded.mjs's proven,
// unit-tested IDF+bigram relevance leaf; knowledge-records OWNS the corpus, this only READS content-slice.
//   grounding: { corpus_kind, corpus_ref, text_field, query_from:[<item fields>], topk, excerpt_chars, into }
const G_STOP = new Set(['the','and','that','this','with','your','you','for','are','was','will','have','has','not','but','they','their','them','from','our','ready','draft','action','because','what','how','who','one','into','then','than','each','over','more','most','some','all','any','can','get','out']);
export function gTerms(t) { return Array.from(new Set(String(t || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3 && !G_STOP.has(w)))); }
function gOrdered(t) { return String(t || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3 && !G_STOP.has(w)); }
export function gBigrams(tokens) { const t = Array.isArray(tokens) ? tokens : []; const s = new Set(); for (let i = 0; i + 1 < t.length; i += 1) s.add(t[i] + ' ' + t[i + 1]); return s; }
export function gIdf(terms, sliceTexts) { const list = Array.isArray(sliceTexts) ? sliceTexts : []; const N = list.length || 1; const sets = list.map((t) => new Set(gTerms(t))); const idf = new Map(); for (const t of (terms || [])) { let df = 0; for (const ws of sets) if (ws.has(t)) df += 1; idf.set(t, Math.log((N + 1) / (df + 1)) + 1); } return idf; }
export function gScore(sliceText, terms, queryBigrams, idf) { const ts = Array.isArray(terms) ? terms : []; if (!ts.length) return 0; const words = new Set(gTerms(sliceText)); if (!words.size) return 0; let hits = 0; for (const t of ts) if (words.has(t)) hits += idf instanceof Map ? (idf.get(t) || 1) : 1; let ph = 0; const qb = queryBigrams instanceof Set ? queryBigrams : null; if (qb && qb.size) { const sb = gBigrams(gOrdered(sliceText)); for (const g of qb) if (sb.has(g)) ph += 1; } const c = hits + 2 * ph; return c ? c / Math.sqrt(words.size) : 0; }
// PURE top-K selection (unit-testable): rank slices by relevance to queryText, return the excerpt array
// [{source_ref, text}] the article's `source_refs`/`sources` cite. Zero I/O — the caller supplies slices.
export function selectGroundingExcerpts(g, queryText, slices) {
  const d = g || {};
  const textField = d.text_field || 'text';
  const topk = Number.isFinite(d.topk) && d.topk > 0 ? d.topk : 5;
  const chars = Number.isFinite(d.excerpt_chars) && d.excerpt_chars > 0 ? d.excerpt_chars : 800;
  const terms = gTerms(queryText);
  const bg = gBigrams(gOrdered(queryText));
  const texts = (slices || []).map((s) => s && s[textField]).filter((t) => typeof t === 'string');
  const idf = gIdf(terms, texts);
  return (slices || [])
    .filter((s) => s && typeof s[textField] === 'string' && s[textField].trim())
    .map((s) => ({ source_ref: s.id || s.source_ref || null, text: String(s[textField]), _score: gScore(s[textField], terms, bg, idf) }))
    .filter((x) => x._score > 0)
    .sort((a, b) => b._score - a._score)
    .slice(0, topk)
    .map((x) => ({ source_ref: x.source_ref, text: x.text.slice(0, chars) }));
}

// The chain and its diagnostic live in ./lib/carrier.mjs, mounted beside this file. This used to
// be an inlined copy carrying a comment that a sibling import could not resolve; that was stale and
// the engine proves it (materialize_input_create_only, native_process.rs:557, creates the lib/
// directory in the job root). See processes/carrier-resolution.test.mjs.
const CARRIER_URL = resolveCarrier();
const PARTITION_LABEL = resolvePartition();
// Hand-off timeout, NOT wait-for-completion. The dispatched owner (e.g. generate-one-ethos-article) runs
// its generation in the ENGINE and finishes ASYNC — the artifact (public-document) appears server-side after
// the client connection drops (proven: articles written minutes after the client timed out). So the drain
// only needs to hand the work to the engine, then move on — it must NOT block the shared slot::workflow for
// the full generation (that starves the operator). Kept modest so the tick frees the slot fast.
const DISPATCH_TIMEOUT_MS = Number(process.env.BITFIELD_DRAIN_DISPATCH_TIMEOUT_MS || '25000');

if (CARRIER_URL && !PARTITION_LABEL) { console.error(CARRIER_AND_PARTITION_REQUIRED); process.exit(1); }

async function fetchBasis() { const r = await fetch(new URL('/boot', CARRIER_URL), { headers: { 'Cache-Control': 'no-cache' }, signal: AbortSignal.timeout(15000) }); const j = await r.json(); return j[0].running_command_list_basis; }
async function postTarget(target, body, basis, timeoutMs = 25000) { const ac = new AbortController(); const to = setTimeout(() => ac.abort(), timeoutMs); try { const r = await fetch(new URL('/target/' + encodeURIComponent(target), CARRIER_URL), { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Bitfield-Running-Command-List-Basis': basis }, body: JSON.stringify(body), signal: ac.signal }); const x = await r.text(); try { return JSON.parse(x); } catch { return null; } } catch { return null; } finally { clearTimeout(to); } }
// L126 exhaust-off: content-slice lives on the dedicated 'knowledge-records-exhaust' list-path, not
// published-record. corpus_kind is DATA-driven (grounding descriptor), so route via KIND_LIST_PATH — reading
// content-slice from published-record returns EMPTY → ungrounded drain. Add ONE row per future exhaust-off.
const KIND_LIST_PATH = { 'knowledge-records.content-slice': 'knowledge-records-exhaust' };
// Both-paths self-healing: read the kind's exhaust index path AND published-record, dedup by id, so the drain
// finds content-slice whether it has been migrated onto knowledge-records-exhaust yet or is still on
// published-record (reading exhaust-only returned EMPTY → ungrounded drain). Converges to index-only once backfill lands.
async function findKind(kind, basis) {
  const idx = KIND_LIST_PATH[kind];
  const paths = idx ? [idx, 'published-record'] : ['published-record'];
  const seen = new Set(); const out = [];
  for (const listPath of paths) {
    const j = await postTarget('slot::find-current-items', { operation: 'find-current-items', in: listPath, where: { all: [{ field: 'kind', in: [kind] }] }, include: ['payload'] }, basis);
    const a = Array.isArray(j) ? j : (j?.items || j?.results || []);
    for (const x of a) { const p = x.payload || x; if (!p) continue; const id = p.id; if (typeof id === 'string') { if (seen.has(id)) continue; seen.add(id); } out.push(p); }
  }
  return out;
}
// Selector predicate → live-state query. Accepts BOTH predicate schemas (L090, self-describing DATA):
//   shorthand {field, eq|in|lt|gt|contains}  AND  canonical {field, op, value} (op: eq|ne|in|nin|lt|gt|contains).
// Query-expressible ops are pushed to the find-current-items where clause; ops the live-state index cannot
// express (ne/nin — which must also treat an ABSENT field as "not equal") are applied as post-filters, so a
// predicate like {field:'distributed', op:'ne', value:true} correctly selects rows where distributed is
// false OR undefined. Both schemas coexist because completion/selector DATA is authored by many descriptors.
async function findWhere(inKind, predicates, basis) {
  const whereClause = { all: [{ field: 'kind', in: [inKind] }] };
  const postFilters = [];
  if (Array.isArray(predicates)) {
    for (const pred of predicates) {
      const p = pred || {}; if (!p.field) continue;
      let op = p.op, val = p.value;
      if (op === undefined) { // infer op from shorthand keys
        if (p.eq !== undefined) { op = 'eq'; val = p.eq; }
        else if (p.in) { op = 'in'; val = p.in; }
        else if (p.lt !== undefined) { op = 'lt'; val = p.lt; }
        else if (p.gt !== undefined) { op = 'gt'; val = p.gt; }
        else if (p.contains) { op = 'contains'; val = p.contains; }
      }
      switch (op) {
        case 'eq': whereClause.all.push({ field: p.field, eq: val }); break;
        case 'in': whereClause.all.push({ field: p.field, in: Array.isArray(val) ? val : [val] }); break;
        case 'lt': whereClause.all.push({ field: p.field, lt: val }); break;
        case 'gt': whereClause.all.push({ field: p.field, gt: val }); break;
        case 'contains': whereClause.all.push({ field: p.field, contains: val }); break;
        case 'ne': postFilters.push((r) => r[p.field] !== val); break;
        case 'nin': { const set = Array.isArray(val) ? val : [val]; postFilters.push((r) => !set.includes(r[p.field])); break; }
        default: break;
      }
    }
  }
  const j = await postTarget('slot::find-current-items', { operation: 'find-current-items', in: 'published-record', where: whereClause, include: ['payload'] }, basis);
  const a = Array.isArray(j) ? j : (j?.items || j?.results || []);
  let rows = a.map((x) => x.payload || x).filter(Boolean);
  for (const f of postFilters) rows = rows.filter(f);
  return rows;
}
async function writeBatch(writes, basis) { const j = await postTarget('engine.operation.label-addressed', { operation_label: 'engine.operation.write-batch', writes }, basis); return !!(j && (j.write_count || j.ok || j.status === 200 || j.writes_committed)); }
async function readCurrentAtMode(addressLabel, pathLabels, mode, basis) { const j = await postTarget('engine.operation.label-addressed', { operation_label: 'engine.operation.read-current', address_label: addressLabel, path_labels: pathLabels, address_mode: mode }, basis); return !!(j && j.found === true); }
// Resolve the canonical writeback address_mode for a kind on THIS carrier by probing where a sample item
// ACTUALLY lives. find-current-items folds all address modes, so reads always succeed regardless of mode —
// but a write MUST target the mode where the record physically lives, else it creates a DUPLICATE at the
// other mode and the canonical item never advances (the writeback-mode-mismatch bug, twice-seen). Local
// seeds queue items at identity_text, Fly at label_hash, so no single DATA constant is correct for both.
// One probe/tick resolves it per-carrier automatically. Falls back to the descriptor's declared/default mode
// for a brand-new queue with no seeded item yet (new records — no existing address to match).
async function resolveWritebackMode(addressLabel, pathLabels, preferred, basis) {
  // ALWAYS probe identity_text first — it is the primary canonical mode. Local seeds queue items there (a live
  // record is found → identity_text wins). Fly never seeds identity_text for these items (found=false → we
  // fall through to label_hash, where Fly's items actually live). Checking identity_text first also makes
  // stray label_hash tombstones on local irrelevant (a retracted record still reports found=true via
  // read-current, so probing label_hash first would wrongly pick it). New/empty queue → preferred fallback.
  for (const m of ['identity_text', 'label_hash']) { if (await readCurrentAtMode(addressLabel, pathLabels, m, basis)) return m; }
  return preferred || 'identity_text';
}
async function dispatch(action, input, basis) { const r = await postTarget('slot::workflow', { operation: 'execute_definition', definition_id: action, include_output: true, include_steps: false, input }, basis, DISPATCH_TIMEOUT_MS); const out = r && r.output; const ref = (out && (out.document_id || out.id || out.chunk_manifest_hash || out.integrity_hash)) || null; const ok = !!(r && (r.status === 'completed' || out)); return { ok, ref }; }

// Retrieve grounding for ONE item and return the excerpt array (I/O wrapper around selectGroundingExcerpts).
// Reads the owner corpus (kind-only find, corpus_ref filtered client-side — the safe single-clause path),
// builds the query from the item's declared fields, scores + top-K selects. Fail-open: any error → [].
async function retrieveGrounding(g, item, basis) {
  try {
    if (!g || !g.corpus_kind) return [];
    const queryText = (g.query_from || []).map((f) => item && item[f]).filter((v) => typeof v === 'string' && v.trim()).join(' ');
    if (!queryText) return [];
    let slices = await findKind(g.corpus_kind, basis);
    if (g.corpus_ref) slices = slices.filter((s) => s && s.corpus_ref === g.corpus_ref);
    return selectGroundingExcerpts(g, queryText, slices);
  } catch { return []; }
}

// PURE derive: apply the descriptor's `derive` rules to an item, merging derived fields (e.g. $slug).
//
// A `prefix_id_with` rule was added here on 2026-09-04 and DELETED the same hour. It composed a
// namespaced per-item id so a row could supply the idempotency key that makes an egress dispatch
// safe (the front door claims `routed-egress-claim::<intent_id>` create-only). It was real work
// against a real need, and it was already solved: `correlation_id` below is
// sha256(descriptor.id + '::' + itemId), merged into the derived item BEFORE the template is
// filled, so `"$correlation_id"` supplies that key today with no rule at all.
//
// The deleted version was also WEAKER. It leaned on the descriptor author picking a unique prefix
// by hand, so two queues that chose the same one would collide on a claim address and silently
// swallow the second message. That is why it needed a fail-closed guard for the empty-id case.
// `correlation_id` is namespaced by descriptor id STRUCTURALLY, so the collision cannot occur and
// there is nothing to guard. A guard defending a hazard that a better structure never creates is
// the tell that the structure was the answer.
export function deriveItem(d, item) {
  const out = { ...item };
  for (const [name, rule] of Object.entries((d && d.derive) || {})) {
    if (rule && typeof rule.strip_prefix_from_id === 'string') {
      out[name] = String(item.id || '').startsWith(rule.strip_prefix_from_id) ? String(item.id).slice(rule.strip_prefix_from_id.length) : String(item.id || '');
    }
  }
  return out;
}

/**
 * PURE: does ONE where-term hold? The single operator table, shared by completion and eligibility
 * so a descriptor author learns one vocabulary and both halves cannot drift apart.
 *
 * ORDERING COMPARES STRINGS TOO, and that fixed a silent defect rather than adding a feature. `lt`
 * and `gt` required BOTH sides to be `typeof 'number'`, so an ISO timestamp bound evaluated to false
 * instead of comparing. It never threw and never warned: a descriptor with a date bound simply
 * selected nothing, forever, and looked like a quiet queue. Found by mapping a real loop onto the
 * vocabulary field by field, which is the only way this class of gap shows up, since the field list
 * looks complete. Number-vs-number still compares numerically; string-vs-string compares
 * lexicographically, which is exactly right for ISO-8601 and is why that format was chosen.
 *
 * `present`/`absent` exist because "this item has no completion stamp yet" is the most common
 * eligibility rule in the corpus and had no expression at all.
 *
 * THIS TABLE IS NOT THE CANONICAL ONE. `formula-engine` owns DATA-driven predicate evaluation in
 * `source/src/slot_work/classify_by_rules.rs`, whose `ClassifyClauseOp` is
 * `Present | Absent | Gte | Lte | Eq` and whose fact definitions additionally project through a
 * nested `path` and an `AgeSeconds` mode. This function exists only because selection filters items
 * already held in memory, where calling a slot would cost one engine dispatch PER ITEM.
 *
 * So it is bound by contract rather than by import: **the names here must stay a strict SUPERSET of
 * ClassifyClauseOp, spelled identically.** All five overlap today (`eq`, `present`, `absent`, `gte`,
 * `lte`); the rest are additions. If you rename one, a predicate written as DATA starts meaning two
 * different things depending on which evaluator reads it, and nothing will report that. If you need
 * a NEW operator, add it to the Rust owner first and mirror the name here.
 */
export function termHolds(recVal, op, val) {
  switch (op) {
    case 'eq': return recVal === val;
    case 'ne': return recVal !== val;
    case 'in': return Array.isArray(val) ? val.includes(recVal) : false;
    case 'not_in': return Array.isArray(val) ? !val.includes(recVal) : false;
    case 'present': return recVal !== undefined && recVal !== null && recVal !== '';
    case 'absent': return recVal === undefined || recVal === null || recVal === '';
    case 'contains': return typeof recVal === 'string' && typeof val === 'string' && recVal.includes(val);
    case 'lt': return comparable(recVal, val) && recVal < val;
    case 'lte': return comparable(recVal, val) && recVal <= val;
    case 'gt': return comparable(recVal, val) && recVal > val;
    case 'gte': return comparable(recVal, val) && recVal >= val;
    default: return false; // an unknown op never silently passes
  }
}
// Both numbers, or both strings. Mixed types are refused rather than coerced, because '10' < '9' is
// true and would make a numeric bound wrong in a way nothing reports.
function comparable(a, b) {
  return (typeof a === 'number' && typeof b === 'number') || (typeof a === 'string' && typeof b === 'string');
}

// PURE: evaluate a DATA-driven completion predicate. Returns true iff ANY clause in
// descriptor.completion.satisfied_when matches ≥1 record in recordsByKind[clause.in_kind].
// A record matches a clause iff every where term holds (field op value) AND if correlate_field
// is set, the record[correlate_field] === item.correlation_id. Operators: see termHolds.
// Values may be $field literals (resolved vs item) or raw.
export function evaluateCompletion(descriptor, item, recordsByKind) {
  const d = descriptor || {};
  const comp = d.completion;
  if (!comp || !Array.isArray(comp.satisfied_when)) return false;
  const rbk = recordsByKind || {};
  for (const clause of comp.satisfied_when) {
    const clKind = clause && clause.in_kind;
    if (!clKind) continue;
    const recs = rbk[clKind] || [];
    for (const rec of recs) {
      if (!rec || typeof rec !== 'object') continue;
      let match = true;
      // Check all where predicates
      for (const whereTerm of (clause.where || [])) {
        const field = whereTerm && whereTerm.field;
        const op = whereTerm && whereTerm.op;
        if (!field || !op) continue;
        let val = whereTerm.value;
        // Resolve $field literals from item
        if (typeof val === 'string' && val.startsWith('$')) {
          val = item[val.slice(1)];
        }
        const holds = termHolds(rec[field], op, val);
        if (!holds) { match = false; break; }
      }
      if (!match) continue;
      // If correlate_field is set, check it matches item.correlation_id
      const corrField = clause.correlate_field;
      if (corrField && rec[corrField] !== item.correlation_id) continue;
      // All conditions matched → clause satisfied
      return true;
    }
  }
  return false;
}

// PURE covered-matcher: given the descriptor's `dedup.item_key` + the ids of existing artifacts, returns a
// predicate (derivedItem) => bool that is true iff an artifact's id contains this item's dedup key (its slug).
export function coveredMatcher(d, coveredIds) {
  const covered = new Set((coveredIds || []).map(String));
  const dedupKey = d && d.dedup && d.dedup.item_key;
  return (di) => { if (!dedupKey) return false; const k = String(di[dedupKey] ?? ''); if (!k) return false; for (const id of covered) { if (id.includes(k)) return true; } return false; };
}

// PURE: unified completion check — prefers DATA-driven completion if present, falls back to dedup.
// Backward-compat critical: a descriptor with NO completion field behaves EXACTLY as before (dedup).
export function isComplete(descriptor, item, recordsByKind, coveredIds) {
  const d = descriptor || {};
  if (d.completion) {
    return evaluateCompletion(d, item, recordsByKind);
  }
  // Fallback: dedup via coveredMatcher (backward-compat)
  const isCovered = coveredMatcher(d, coveredIds);
  return isCovered(item);
}

/**
 * PURE: does this item pass the descriptor's own eligibility clause?
 *
 * `drain-queue` mode had exactly ONE eligibility rule, `status === pending_status`, with nowhere to
 * put anything else. That is why the highest-consequence loop in this package could not be expressed
 * as a descriptor row: its fail-closed time floor and its "no completion stamp yet" guard had no home,
 * so it stayed hand-rolled beside a generic engine that was otherwise ready for it.
 *
 * Same `where` shape and the same operator table as `completion`, deliberately. A second predicate
 * language here would be a second thing to learn and a second thing to drift.
 *
 * Absent clause means eligible, so every existing descriptor keeps its exact behaviour.
 * An EMPTY array also means eligible: a clause that lists no conditions states no restriction.
 */
export function isEligibleByData(descriptor, item) {
  const terms = descriptor && descriptor.eligible_when;
  if (!Array.isArray(terms) || terms.length === 0) return true;
  const it = item || {};
  for (const term of terms) {
    const field = term && term.field;
    const op = term && term.op;
    if (!field || !op) continue; // a malformed term restricts nothing, matching how `where` reads
    let val = term.value;
    if (typeof val === 'string' && val.startsWith('$')) { val = it[val.slice(1)]; }
    if (!termHolds(it[field], op, val)) return false; // ALL terms must hold
  }
  return true;
}

// PURE selection (unit-testable): apply `derive`, filter pending, check complete, cap. Returns
// items with their derived fields merged in (so input_template can reference $slug etc.).
export function selectQueueItems(descriptor, items, coveredIds, recordsByKind) {
  const d = descriptor || {};
  const mode = (d.selector && d.selector.mode) || 'drain-queue';
  const pending = d.pending_status || 'pending';
  const keyField = d.item_key_field || 'id';
  const rbk = recordsByKind || {};
  // Raw-item eligibility differs by selector.mode (L090 — mode is DATA, not a code branch on kind):
  //   drain-queue : eligible iff the item's OWN status === pending_status (queue items carry status).
  //   select-where: findWhere already returned only the eligible set (the where predicate IS the
  //                 eligibility filter). These are FOREIGN kinds (e.g. public-document) that do not carry
  //                 a `status` field — requiring status===pending here would reject every one of them, which
  //                 is exactly why activated select-where distributors drained nothing. Idempotency is still
  //                 guaranteed downstream by `completion` (isComplete), so no item is dispatched twice.
  //   generate    : freshly generated items carry pending_status; pre-existing ones are re-gated by status.
  const statusEligible = (it) => mode === 'select-where' ? true : String(it.status ?? '') === pending;
  return (items || [])
    .filter((it) => it && statusEligible(it) && isEligibleByData(d, it) && it[keyField] != null)
    .map((it) => deriveItem(d, it))
    .filter((di) => !isComplete(d, di, rbk, coveredIds))
    .sort((a, b) => (String(a[keyField]) < String(b[keyField]) ? -1 : 1))
    .slice(0, Number.isFinite(d.cap_per_tick) && d.cap_per_tick >= 0 ? d.cap_per_tick : 1);
}

// PURE reconcile (unit-testable): the engine finishes generation ASYNC, so an item stamped `in_progress`
// (`generating`) is one of three things — and only artifact truth + elapsed time can tell them apart:
//   (1) DONE: completion is satisfied (DATA predicate or dedup) → advance to done_status. Immediate + safe:
//       the artifact/evidence IS the completion proof, so no grace period needed.
//   (2) FAILED: no completion AND stale (past grace) → dispatch genuinely failed (not just client timeout)
//       → reset to pending so a later tick RE-ATTEMPTS it. Without this, a genuinely-failed topic is a
//       zombie: never re-picked (not pending), never produced — the owner silently never gets the work.
//   (3) IN-FLIGHT: no completion but fresh → engine still producing it → LEAVE untouched (resetting to
//       pending here would re-dispatch a DUPLICATE while the first is mid-flight).
// nowMs + each item's `generating_at` ISO stamp drive the grace check. Returns [{ item, nextStatus, escalation_count }].
export function reconcileInProgress(descriptor, items, coveredIds, nowMs, recordsByKind) {
  const d = descriptor || {};
  const inProg = d.in_progress_status || 'generating';
  const doneStatus = d.done_status || 'published';
  const pending = d.pending_status || 'pending';
  const graceSec = Number.isFinite(d.reconcile_grace_seconds) ? d.reconcile_grace_seconds : 600;
  const rbk = recordsByKind || {};
  const out = [];
  for (const it of (items || [])) {
    if (!it || String(it.status ?? '') !== inProg) continue;
    const di = deriveItem(d, it);
    if (isComplete(d, di, rbk, coveredIds)) {
      out.push({ item: it, nextStatus: doneStatus, escalation_count: 0 });
      continue;
    }
    const startedMs = Date.parse(it.generating_at || '');
    const stale = !Number.isFinite(startedMs) || (Number.isFinite(nowMs) && (nowMs - startedMs) >= graceSec * 1000);
    if (stale) {
      const escalCount = (it.escalation_count || 0) + (stale ? 1 : 0);
      out.push({ item: it, nextStatus: pending, escalation_count: escalCount });
    }
    // fresh + not complete → engine still working → leave untouched
  }
  return out;
}

async function drainDescriptor(d, basis, nowIso) {
  const queueKind = d.queue_kind; if (!queueKind || !d.dispatch_action) return { produced: 0, failed: 0, skipped: 'incomplete-descriptor' };
  const selectorMode = (d.selector && d.selector.mode) || 'drain-queue';
  // Obtain items based on selector.mode (all modes are Physics; functions are DATA)
  let items = [];
  let generateCount = 0;
  if (selectorMode === 'select-where') {
    if (d.selector && d.selector.in_kind) {
      items = await findWhere(d.selector.in_kind, d.selector.where, basis);
    }
  } else if (selectorMode === 'generate') {
    // generate mode: emit new items when pending count is low
    if (d.selector && d.selector.min_pending) {
      const existing = await findKind(queueKind, basis);
      const pending = (existing || []).filter((it) => it && String(it.status ?? '') === (d.pending_status || 'pending')).length;
      if (pending < d.selector.min_pending && d.selector.source) {
        const source = d.selector.source;
        const batchSize = Number.isFinite(d.selector.generate_batch) ? d.selector.generate_batch : (d.selector.min_pending - pending);
        // source can be a list address or an ai-records-producer dispatch
        let sourceItems = [];
        if (typeof source === 'string' && source.includes('::')) {
          // Data list address format: fetch from a descriptor
          sourceItems = await findKind(source.split('::')[0], basis);
        } else if (typeof source === 'object' && source.operation) {
          // ai-records-producer dispatch format: not fetched here (would be handled by the caller)
          sourceItems = [];
        }
        for (let i = 0; i < Math.min(batchSize, sourceItems.length); i++) {
          const src = sourceItems[i];
          const newItem = { kind: queueKind, id: `${queueKind}::${src.id || i}`, status: d.pending_status || 'pending', ...deriveItem(d, src) };
          items.push(newItem);
          generateCount++;
        }
      }
      items = items.concat(existing || []);
    }
  } else {
    // drain-queue mode (default): current behavior — items already exist
    items = await findKind(queueKind, basis);
  }
  const covered = d.dedup && d.dedup.against_kind ? (await findKind(d.dedup.against_kind, basis)).map((x) => x.id).filter(Boolean) : [];
  const doneStatus = d.done_status || 'published';
  const keyField = d.item_key_field || 'id';
  const addrKind = d.item_address_kind || queueKind;
  const auditKind = d.audit_kind || 'queue-drain-audit';
  // Writeback address_mode: the descriptor value is a PREFERRED fallback only — the ACTUAL mode is resolved
  // by probing where this carrier's items physically live (identity_text on local, label_hash on Fly). This
  // makes the status-writeback UPDATE the canonical record instead of DUPLICATING it at the other address
  // form (the twice-seen mismatch bug). One probe/tick against a sample item; new/empty queue → preferred.
  const preferredMode = d.writeback_address_mode || 'identity_text';
  const sampleId = (items.find((it) => it && it[keyField] != null) || {})[keyField];
  const wbMode = sampleId != null ? await resolveWritebackMode(`${addrKind}::${sampleId}`, ['current-item', 'published-record'], preferredMode, basis) : preferredMode;

  // PRE-FETCH records for all completion clauses (if descriptor has completion field)
  const recordsByKind = {};
  if (d.completion && Array.isArray(d.completion.satisfied_when)) {
    for (const clause of d.completion.satisfied_when) {
      if (clause && clause.in_kind && !recordsByKind[clause.in_kind]) {
        recordsByKind[clause.in_kind] = await findKind(clause.in_kind, basis);
      }
    }
  }

  // RECONCILE PASS (self-healing): advance in_progress items whose completion is satisfied to done, and reset
  // genuinely-failed (stale, not complete) ones back to pending so they re-attempt. Runs BEFORE picking new
  // work so a reset item is immediately eligible again this same tick. Structurally eliminates zombie
  // `generating` items left by client-side dispatch timeouts on an async engine (L063 category fix).
  let reconciled = 0, escalated = 0;
  const nowMs = Date.parse(nowIso);
  for (const { item, nextStatus, escalation_count } of reconcileInProgress(d, items, covered, nowMs, recordsByKind)) {
    const rid = String(item[keyField]);
    const escalation = d.escalation || {};
    const maxEscalations = Number.isFinite(escalation.max_escalations) ? escalation.max_escalations : 0;
    // If stale and escalation enabled, re-dispatch with escalation action if within max
    if (nextStatus === (d.pending_status || 'pending') && escalation_count > 0 && escalation_count <= maxEscalations && escalation.escalation_ladder && Array.isArray(escalation.escalation_ladder)) {
      const escalIdx = Math.min(escalation_count - 1, escalation.escalation_ladder.length - 1);
      const escalAction = escalation.escalation_ladder[escalIdx] || d.dispatch_action;
      const di = deriveItem(d, item);
      di.correlation_id = item.correlation_id; // merge back
      const escalInput = fillTemplate(d.input_template || {}, di);
      await dispatch(escalAction, escalInput, basis);
      escalated++;
    }
    const rp = { ...item, status: nextStatus, generating_at: undefined, escalation_count };
    if (await writeBatch([{ partition_label: PARTITION_LABEL, address_label: `${addrKind}::${rid}`, address_mode: wbMode, path_labels: ['current-item', 'published-record'], payload: rp }], basis)) {
      reconciled++;
      item.status = nextStatus; // reflect locally so selectQueueItems can re-pick a reset item this tick
    }
  }
  const picked = selectQueueItems(d, items, covered, recordsByKind);
  let produced = 0, failed = 0, emitted = 0;
  for (const di of picked) {
    try {
      // Compute deterministic correlation_id: sha256(descriptor.id + '::' + itemId)
      const itemId0 = String(di[keyField]);
      const correlationId = createHash('sha256').update(d.id + '::' + itemId0).digest('hex');
      di.correlation_id = correlationId;

      // GROUNDING (generic): if the descriptor declares `grounding`, retrieve top-K corpus excerpts for
      // THIS item and expose them as a synthetic field (default `grounding_json`) the input_template
      // references — so the dispatched generator drafts FROM the owner's material and cites real source_refs.
      let groundedCount = 0;
      if (d.grounding && d.grounding.corpus_kind) {
        const excerpts = await retrieveGrounding(d.grounding, di, basis);
        groundedCount = excerpts.length;
        di[d.grounding.into || 'grounding_json'] = JSON.stringify(excerpts);
        // FAIL-CLOSED grounding (owner correctness): if the owner's corpus does NOT sufficiently cover this
        // topic (fewer than min_excerpts relevant passages), DO NOT generate — a generic, un-grounded article
        // would be published under the owner's name forever, associating them with content that has nothing to
        // do with their philosophy. Skip the item: stamp a terminal `insufficient_status` so it does not re-fire
        // (and is visible for review), write an audit, and move on WITHOUT dispatching the generator.
        const minExcerpts = Number.isFinite(d.grounding.min_excerpts) ? d.grounding.min_excerpts : 1;
        if (groundedCount < minExcerpts) {
          const orig0 = items.find((it) => String(it[keyField]) === itemId0) || di;
          const skipStatus = d.grounding.insufficient_status || 'insufficient-grounding';
          await writeBatch([{ partition_label: PARTITION_LABEL, address_label: `${addrKind}::${itemId0}`, address_mode: wbMode, path_labels: ['current-item', 'published-record'], payload: { ...orig0, status: skipStatus } }], basis);
          await writeBatch([{ partition_label: PARTITION_LABEL, address_label: `${auditKind}::${d.id}::${itemId0}`, address_mode: wbMode, path_labels: ['current-item', 'queue-drain-audit-index'], payload: { kind: auditKind, id: `${d.id}::${itemId0}`, descriptor: d.id, queue_kind: queueKind, item: itemId0, dispatched: false, skipped: 'insufficient-grounding', grounded_excerpts: groundedCount, min_excerpts: minExcerpts, correlation_id: correlationId, at: nowIso } }], basis);
          continue;
        }
      }
      // STYLE injection (generic): a `style` block names one or more owner-voice records (writing style
      // guide, storytelling/hero's-journey chapter, ...) to inject VERBATIM+concatenated as `style_guide`
      // — so the generator writes in the OWNER'S voice and narrative craft, not generic AI prose. Single-
      // record fetch per ref (not a scored corpus). Missing refs are skipped; empty → generator falls back
      // to its own default, never a hard fail. `style_refs` (list) preferred; `style_ref` (single) still ok.
      if (d.style && (Array.isArray(d.style.style_refs) || d.style.style_ref)) {
        const refs = Array.isArray(d.style.style_refs) ? d.style.style_refs : [d.style.style_ref];
        const styleRecs = await findKind(d.style.style_kind || 'style-guide', basis);
        const parts = refs.map((ref) => { const r = styleRecs.find((x) => x && x.id === ref); return r ? String(r[d.style.text_field || 'text'] || '').trim() : ''; }).filter(Boolean);
        di[d.style.into || 'style_guide'] = parts.join('\n\n---\n\n');
      }
      const input = fillTemplate(d.input_template || {}, di);
      const res = await dispatch(d.dispatch_action, input, basis);
      const itemId = String(di[keyField]);
      // The engine finishes generation ASYNC (the artifact appears server-side AFTER this client dispatch
      // returns/times out), so res.ok is an unreliable completion signal. Stamp the item to in_progress
      // IMMEDIATELY so it is not re-fired while the engine works; the TRUE completion signal is satisfaction
      // of the completion predicate (if present) or artifact existence via dedup (if no completion predicate).
      // done_status is applied when a later tick sees the artifact/evidence via reconcile.
      const orig = items.find((it) => String(it[keyField]) === itemId) || di;
      // COMPLETION-PRESENT items: dispatch only STARTS the work (agent OR human). res.ok means "dispatched"
      // (message sent / job kicked off) — NOT "done". The item MUST go to in_progress and advance to done
      // ONLY when descriptor.completion is satisfied (reconcile via evaluateCompletion). Marking a human ask
      // done because the iMessage sent would bypass the whole predicate. COMPLETION-ABSENT descriptors keep
      // legacy behavior: res.ok -> done; else in_progress -> dedup-reconcile (article worker unchanged).
      const dispatchMarksDone = !d.completion && res.ok;
      const nextStatus = dispatchMarksDone ? doneStatus : (d.in_progress_status || 'generating');
      // Stamp `generating_at` whenever the item is left in_progress so the reconcile pass can distinguish a
      // still-in-flight job / awaiting-human item (fresh) from a genuinely-stale one (escalate) — see
      // reconcileInProgress. Cleared only when the item is marked done.
      const stampPayload = dispatchMarksDone ? { ...orig, status: nextStatus, generating_at: undefined, correlation_id: correlationId } : { ...orig, status: nextStatus, generating_at: nowIso, correlation_id: correlationId };
      await writeBatch([{ partition_label: PARTITION_LABEL, address_label: `${addrKind}::${itemId}`, address_mode: wbMode, path_labels: ['current-item', 'published-record'], payload: stampPayload }], basis);
      if (res.ok) produced++; else failed++;
      await writeBatch([{ partition_label: PARTITION_LABEL, address_label: `${auditKind}::${d.id}::${itemId}`, address_mode: wbMode, path_labels: ['current-item', 'queue-drain-audit-index'], payload: { kind: auditKind, id: `${d.id}::${itemId}`, descriptor: d.id, queue_kind: queueKind, item: itemId, dispatched: !!res.ok, ref: res.ref || null, grounded_excerpts: groundedCount, correlation_id: correlationId, at: nowIso } }], basis);
      // EMIT_TO (pipeline edge): if the descriptor declares writeback.emit_to and this dispatch succeeded,
      // write a new item to the downstream queue. The item_template is bound from the dispatch result so
      // downstream can reference the artifact (e.g. document_id or integrity_hash for a generated document).
      // This is DATA-driven composition: two queue-drain-descriptors form a pipeline via this one write.
      if (res.ok && d.writeback && d.writeback.emit_to) {
        const emitTo = d.writeback.emit_to;
        if (emitTo.queue_kind && emitTo.item_template) {
          try {
            const downstreamPayload = fillTemplate(emitTo.item_template, { ...res, item: di, result: res });
            const downstreamId = String(downstreamPayload.id || `${emitTo.queue_kind}::${itemId}`);
            const downstreamAddr = `${emitTo.queue_kind}::${downstreamId}`;
            const downstreamItem = { kind: emitTo.queue_kind, id: downstreamId, status: d.pending_status || 'pending', ...downstreamPayload };
            await writeBatch([{ partition_label: PARTITION_LABEL, address_label: downstreamAddr, address_mode: wbMode, path_labels: ['current-item', 'published-record'], payload: downstreamItem }], basis);
            emitted++;
          } catch (e) { /* emit_to failure does not fail the upstream dispatch */ }
        }
      }
    } catch (e) { failed++; }
  }
  return { produced, failed, emitted, escalated, candidates: picked.length, reconciled, mode: selectorMode };
}

// Dedup descriptors sharing the same id (iterative re-deploys / mixed address modes can leave stale
// copies of the SAME logical descriptor in the fold). Processing all of them drains the queue multiple
// times per tick, and — critically — a stale copy MISSING the grounding/style config would generate
// generic, un-cited content that bypasses the owner-integrity guards. Keep exactly ONE per id, preferring
// the MOST-COMPLETE copy (has grounding, then has style, then most keys) so the guarded version always wins.
export function dedupDescriptors(list) {
  const score = (d) => (d && d.grounding ? 4 : 0) + (d && d.style ? 2 : 0) + (d ? Object.keys(d).length / 1000 : 0);
  const byId = new Map();
  for (const d of (list || [])) {
    if (!d || !d.id) { continue; }
    const prev = byId.get(d.id);
    if (!prev || score(d) > score(prev)) { byId.set(d.id, d); }
  }
  return [...byId.values()];
}

async function main() {
  const basis = await fetchBasis();
  const descriptors = dedupDescriptors((await findKind('queue-drain-descriptor', basis)).filter((d) => d && d.is_active !== false));
  const nowIso = new Date().toISOString();
  let totalProduced = 0, totalFailed = 0, totalEmitted = 0, totalEscalated = 0;
  for (const d of descriptors) {
    const r = await drainDescriptor(d, basis, nowIso);
    totalProduced += r.produced || 0; totalFailed += r.failed || 0; totalEmitted += r.emitted || 0; totalEscalated += r.escalated || 0;
    console.log(`[drain] ${d.id} mode=${r.mode || 'drain-queue'} queue=${d.queue_kind} reconciled=${r.reconciled ?? 0} escalated=${r.escalated ?? 0} candidates=${r.candidates ?? 0} produced=${r.produced ?? 0} failed=${r.failed ?? 0}${r.emitted ? ' emitted=' + r.emitted : ''}${r.skipped ? ' skip=' + r.skipped : ''}`);
  }
  console.log(`[drain] descriptors=${descriptors.length} produced=${totalProduced} failed=${totalFailed}${totalEmitted ? ' emitted=' + totalEmitted : ''}${totalEscalated ? ' escalated=' + totalEscalated : ''}`);
}
// Handled failures report through stdout and exit 0 (process-engine drops outputs on non-zero exit).
if (CARRIER_URL) { main().catch((e) => { console.error('[drain] fatal:', e && e.message); process.exit(0); }); }
