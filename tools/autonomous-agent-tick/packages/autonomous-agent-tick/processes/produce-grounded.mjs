/**
 * produce-grounded.mjs — Layer 5 READ side: memory-grounded produce (one-shot, tick-driven).
 *
 * The static produce trigger dispatches run-ai-records-production with a FIXED instruction, so
 * the operator has no awareness of what it already decided and repeats itself. Trigger dispatch
 * cannot read the log, so grounding must happen in a compute.process one-shot (the proven sweep
 * pattern): read the agent's own recent ai-memory-record decisions, compose them INTO the
 * instruction ("do not repeat these"), then dispatch the SAME generic producer
 * (run-ai-records-production) cross-slot. No god package — the producer still owns the AI turn;
 * this only composes a richer DATA instruction from records ai-memory already stores (L090/L098).
 *
 * Env: BITFIELD_TARGET_CARRIER_URL (or BITFIELD_TARGET_CARRIER_URL_FILE, the path the runtime publishes its address into), BITFIELD_DISPATCH_PARTITION,
 *      BITFIELD_DISPATCH_AGENT_REF (the operator profile ref),
 *      BITFIELD_MEMORY_LIMIT (recent decisions to inject, default 8),
 *      BITFIELD_BASE_INSTRUCTION (override the base prompt; a sensible default is baked in).
 */
// A supervisor entry is written once and frozen; a runtime that picks its port at startup has an
// address that changes every time it starts. So the supervisor is given the PATH of the file the
// runtime publishes its address into, which does not change, rather than the address, which does.
// Nothing is searched for: the path arrives as DATA exactly as the URL does. The chain lives in
// ./lib/carrier.mjs, mounted beside this file by this action's manifest entry.
import { resolveCarrier, resolvePartition, CARRIER_AND_PARTITION_REQUIRED } from './lib/carrier.mjs';

const CARRIER_URL = resolveCarrier();
const PARTITION_LABEL = resolvePartition();
const AGENT_REF = process.env.BITFIELD_DISPATCH_AGENT_REF || 'ai-agent-profile:autonomous-business-operator';
const MEMORY_LIMIT = Number(process.env.BITFIELD_MEMORY_LIMIT || '8');
const RESULT_PREFIX = 'package::ai-records-producer::result::';
// THE DEFAULT STATES THE OUTPUT CONTRACT, NEVER THE BUSINESS. It used to open "the Autonomous
// Business OPERATOR of a premium tennis-coaching business, grounded in the Alex Hormozi playbooks",
// and went on to name that tenant's corpus, its target keywords and its article engine. This is a
// generic package installed into every app, so every OTHER tenant wore that identity, and the path
// that reaches this literal is precisely the one where configuration is MISSING: `selectWakeAgent`
// fails closed to the operator ref, so an app with no readable profile does not error, it starts
// operating somebody else's company. An unconfigured process becoming a tenant is the quiet half of
// this defect class.
//
// It is NOT dead code and could not simply be deleted. A profile's `produce_instruction` is a LIVE
// RUNTIME RECORD rather than package DATA, so no source read can prove the live operator carries
// one, and removing the fallback outright risks silencing a running loop on state this file cannot
// see. The split is the fix instead: WHAT SHAPE an answer must take is this process's Physics and
// belongs here, because the sweep downstream parses these exact field names. WHICH BUSINESS, whose
// playbooks, which keywords and which owner packages exist are Society, and they belong in the
// profile that `resolveEffectiveInstruction` already reads and already prefers over this.
//
// The capability list and the owner_target examples are gone with them, for a second reason beyond
// the tenant words: both were closed sets written into a prompt, and the owner map is DATA that a
// row can extend at any time. Naming five packages here taught the model a menu that goes stale the
// day somebody adds a sixth.
const OPERATOR_DEFAULT_INSTRUCTION = 'You are an autonomous OPERATOR with a job, not a chat window. You OPERATE and you never advise. A recommendation, a plan, or a "you should" is a FAILED heartbeat. This wake is a HEARTBEAT: read what you already decided below, pick the single highest-leverage grounded UNDONE action for the current state, then PRODUCE THE FULLY-FORMED EXECUTABLE ARTIFACT for it, meaning the actual thing ready to run rather than a description of it. GOAL ANCESTRY (mandatory): every action must trace to the goal through an explicit because-chain, and if you cannot say why it serves the goal, do not produce it. Your capability space is OPEN: you are not limited to a fixed menu, you are expected to build durable compounding assets rather than only sending messages, and if the highest-leverage action needs a capability nothing lists yet, PROPOSE it by putting a new dotted id in capability and the package address that should execute it in owner_target. Output ONE JSON object with exactly these fields: {"capability":"the dotted id of the single highest-leverage grounded UNDONE action","owner_target":"the envelope address of the existing generic package that executes it","audience":"exactly who or what it is for, as an explicit list or a records query","artifact":"the COMPLETE content written out in full and ready to execute, never a summary, outline, or description","goal_ancestry":"the because-chain from this action up to the goal","grounding_citation":"the slice of your grounding corpus you acted on","expected_metric":"the metric it moves","success_threshold":"the number that counts as success","confidence":0.0,"status":"ready or draft"}. PHASE: status="ready" ONLY if the artifact is fully formed AND its channel or credential is available; otherwise status="draft" and STILL write the ENTIRE artifact, queued for release. A half-filled intent is never acceptable, and stopping at advice or an unfilled artifact is failure.';
// Validate config only when invoked as the process entry (CARRIER set in prod); a test importing this
// module for the pure exports skips both this exit and main(). PARTITION still required alongside CARRIER.
if (CARRIER_URL && !PARTITION_LABEL) { console.error(CARRIER_AND_PARTITION_REQUIRED); process.exit(1); }
async function fetchBasis() { const r = await fetch(new URL('/boot', CARRIER_URL), { headers: { 'Cache-Control': 'no-cache' } }); const j = await r.json(); return j[0].running_command_list_basis; }
async function postTarget(target, body, basis) { const r = await fetch(new URL('/target/' + encodeURIComponent(target), CARRIER_URL), { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Bitfield-Running-Command-List-Basis': basis }, body: JSON.stringify(body) }); const x = await r.text(); try { return JSON.parse(x); } catch { return null; } }
// L126 exhaust-off: same KIND_LIST_PATH choke point as sweep-decisions-once.mjs. ai-memory-record's
// index path is pre-declared here so this grounding reader is BOTH-PATHS correct the moment the
// producer flips (no deploy-ordering dependency); kinds not in the map stay on published-record.
const KIND_LIST_PATH = { 'ai-execution-run': 'ai-execution-run-index', 'agent-decision': 'agent-decision-index', 'ai-memory-record': 'ai-memory-index', 'agent-produce-state': 'agent-produce-state-index' };
async function findKind(kind, basis) {
  const idx = KIND_LIST_PATH[kind];
  const paths = idx ? [idx, 'published-record'] : ['published-record'];
  const seen = new Set();
  const out = [];
  for (const listPath of paths) {
    const j = await postTarget('slot::find-current-items', { operation: 'find-current-items', in: listPath, where: { all: [{ field: 'kind', in: [kind] }] }, include: ['payload'] }, basis);
    const a = Array.isArray(j) ? j : (j?.items || j?.results || []);
    for (const x of a) {
      const p = x.payload || x;
      if (!p) continue;
      const id = p.id;
      if (typeof id === 'string') { if (seen.has(id)) continue; seen.add(id); }
      out.push(p);
    }
  }
  return out;
}
async function readResult(iso, basis) { const j = await postTarget('engine.operation.label-addressed', { operation_label: 'engine.operation.read-current', partition_label: PARTITION_LABEL, address_label: RESULT_PREFIX + iso, address_mode: 'label-hash' }, basis); if (!j || j.found === false) { return null; } const p = j.payload ?? j.value ?? j.ok?.payload ?? j.ok?.value ?? j.ok ?? null; return p && typeof p === 'object' ? p : null; }
// Resolve this agent's COMPLETE produce instruction from its ai-agent-profile DATA (persona +
// output contract), so the SAME generic tick serves any agent (operator, coach, …) with ZERO
// script edits. The profile's `produce_instruction` is authoritative when present; otherwise the
// operator default is used (backward-compat). Persona/schema is DATA, not hardcoded per-agent —
// the script never enumerates who it serves (L090/L083/enum-dissolution). The producer parses by
// output_kind but does NOT inject a schema, so the schema MUST live in this instruction DATA.
async function readProfile(agentRef, basis) {
  if (!agentRef) { return null; }
  const profiles = await findKind('ai-agent-profile', basis);
  return profiles.find((p) => p && p.id === agentRef) || null;
}
// Generic grounding SENSE (L090): the agent's profile declares WHICH records to sense and inject
// as grounding blocks — the script never enumerates a specific kind. Each descriptor:
//   { kind, where?:{field,equals}, text_fields:[…], first_only?, sort_field?, order?:'desc'|'asc',
//     limit, heading }. Defaults to the operator's own recent ai-memory `decision` records
//   ("do not repeat") so Config B is byte-unchanged when the profile declares nothing.
function renderRecordText(rec, textFields, firstOnly) {
  const vals = (textFields || []).map((f) => rec && rec[f]).filter((v) => typeof v === 'string' && v.trim()).map((v) => v.trim());
  if (!vals.length) { return ''; }
  return firstOnly ? vals[0] : vals.join(' — ');
}
export async function senseGroundingBlocks(descriptors, basis, readKind = findKind) {
  let block = '';
  let count = 0;
  const inputRefs = new Map();
  for (const d of (descriptors || [])) {
    if (!d || !d.kind) { continue; }
    let recs = await readKind(d.kind, basis);
    if (d.where && d.where.field) { recs = recs.filter((r) => r && String(r[d.where.field]) === String(d.where.equals)); }
    recs = d.input_ref_field ? recs : recs.filter((r) => renderRecordText(r, d.text_fields, d.first_only));
    if (d.sort_field) { recs.sort((a, b) => { const av = String(a[d.sort_field] || ''); const bv = String(b[d.sort_field] || ''); return d.order === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av); }); }
    recs = recs.slice(0, Number(d.limit) || 8);
    // Addressed evidence is hydrated and revision-checked by the existing producer.
    // Never turn a record id into an address or substitute copied text for that read.
    if (d.input_ref_field) {
      for (const rec of recs) {
        const ref = rec[d.input_ref_field];
        if (!ref || typeof ref !== 'object' || Array.isArray(ref)
          || typeof ref.address !== 'string' || !ref.address.trim()
          || ![ref.expected_revision, ref.expected_content_hash].some(value => typeof value === 'string' && value.trim())
          || [ref.expected_revision, ref.expected_content_hash].some(value => value !== undefined && (typeof value !== 'string' || !value.trim()))) {
          throw new Error('Selected evidence needs its saved address and revision.');
        }
        const selected = { address: ref.address,
          ...(ref.expected_revision !== undefined ? { expected_revision: ref.expected_revision } : {}),
          ...(ref.expected_content_hash !== undefined ? { expected_content_hash: ref.expected_content_hash } : {}) };
        const prior = inputRefs.get(selected.address);
        if (prior && JSON.stringify(prior) !== JSON.stringify(selected)) {
          throw new Error('Selected evidence contains conflicting revisions.');
        }
        inputRefs.set(selected.address, selected);
      }
      count += recs.length;
      continue;
    }
    count += recs.length;
    if (recs.length && d.heading) { block += '\n\n' + d.heading + '\n' + recs.map((r, i) => `${i + 1}. ${renderRecordText(r, d.text_fields, d.first_only)}`).join('\n'); }
  }
  return { block, count, input_refs: [...inputRefs.values()] };
}
const OPERATOR_DEFAULT_GROUNDING = [{ kind: 'ai-memory-record', where: { field: 'memory_type', equals: 'decision' }, text_fields: ['content', 'body'], first_only: true, sort_field: 'source_run', order: 'desc', limit: MEMORY_LIMIT, heading: 'DECISIONS YOU HAVE ALREADY MADE RECENTLY (do NOT repeat any of these — propose a genuinely DIFFERENT, complementary next action):' }];
// Generic RAG grounding (L090/L093/L069): the profile's `retrieval_scope_refs` declares WHICH corpora
// to retrieve from — the script never names a corpus. For each ref we pull the content-slice records
// (fetched by KIND ONLY then filtered by corpus_ref CLIENT-SIDE — see findScopedSlices; the old
// two-clause {all:[kind,corpus_ref]} query TRAPPED the engine, cont.277), keyword-
// score each slice against the current decision context (mission + recent decisions + capability
// vocabulary, already composed as queryText), and inject the top-K excerpts as a CITABLE grounding
// block. knowledge-records OWNS the corpus; this only READS its content-slice via the generic find
// query (no god package, no chunk ownership). When a semantic retrieval owner (meaning-search, task
// #8) is admitted, the same retrieval_scope_refs points at its index and this reader dispatches a
// retrieval-request instead — zero produce-grounded change. Config A's coach sets
// retrieval_scope_refs:["corpus:tennis-athlete-brain"] → the SAME code grounds it in tennis.
const CORPUS_TOPK = Number(process.env.BITFIELD_CORPUS_TOPK || '5');
const CORPUS_EXCERPT_CHARS = Number(process.env.BITFIELD_CORPUS_EXCERPT_CHARS || '800');
// Novelty window: the query is dominated by the fixed base instruction, so pure top-K score returns
// the SAME slices every heartbeat (the operator never explores the corpus). We read the excerpt ids
// this agent was fed in its last N turns (from produce-grounded-audit.corpus_excerpt_ids) and prefer
// UNSEEN high-scored slices — so the agent rotates through the whole playbook, falling back to seen
// slices only when too few novel ones remain. DATA-tunable; 0 disables (pure relevance).
const CORPUS_NOVELTY_WINDOW = Number(process.env.BITFIELD_CORPUS_NOVELTY_WINDOW || '4');
// Rolling cap for the per-agent seen-excerpt FIFO in the agent-produce-state projection (≈ the last
// NOVELTY_WINDOW turns × TOPK excerpts): keeps novelty bounded WITHOUT scanning the audit history.
const SEEN_CAP = Math.max(1, (Number.isFinite(CORPUS_NOVELTY_WINDOW) ? CORPUS_NOVELTY_WINDOW : 4) * (Number.isFinite(CORPUS_TOPK) ? CORPUS_TOPK : 5));
const CORPUS_STOPWORDS = new Set(['the', 'and', 'that', 'this', 'with', 'your', 'you', 'for', 'are', 'was', 'will', 'have', 'has', 'not', 'but', 'they', 'their', 'them', 'from', 'our', 'ready', 'draft', 'action', 'because', 'what', 'how', 'who', 'one', 'into', 'then', 'than', 'each', 'over', 'more', 'most', 'some', 'all', 'any', 'can', 'get', 'out']);
function queryTerms(text) { return Array.from(new Set(String(text || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3 && !CORPUS_STOPWORDS.has(w)))); }
// ORDER-PRESERVING meaningful tokens (same stopword+length filter as queryTerms, but NOT deduped and NOT
// set-collapsed) — adjacency is required for the phrase signal, which the bag-of-words set destroys.
function orderedTokens(text) { return String(text || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3 && !CORPUS_STOPWORDS.has(w)); }
// Adjacent-pair keys from an ordered token list (stopword removal bridges "cross the court" -> cross|court).
export function bigramSet(tokens) { const t = Array.isArray(tokens) ? tokens : []; const s = new Set(); for (let i = 0; i + 1 < t.length; i += 1) { s.add(t[i] + ' ' + t[i + 1]); } return s; }
const BIGRAM_WEIGHT = 2; // a matched adjacent pair counts as 2 unigram hits (a phrase is a stronger signal).
// PURE corpus-wide IDF for the query terms, computed over the slice texts the reader ALREADY loaded (zero new
// infra — NOT the semantic executor of task #8). idf(t) = log((N+1)/(df(t)+1)) + 1 (smoothed so every weight
// is positive): a term in FEW slices (rare/discriminating, e.g. "topspin") outweighs a term in MANY slices
// (common filler, e.g. "player"). This is the standard TF-IDF relevance signal — the exact weakness of
// uniform term weighting on conversational transcripts where the signal is rare technical vocabulary.
export function computeIdf(terms, sliceTexts) {
  const list = Array.isArray(sliceTexts) ? sliceTexts : [];
  const N = list.length || 1;
  const wordSets = list.map((t) => new Set(queryTerms(t)));
  const idf = new Map();
  for (const t of (Array.isArray(terms) ? terms : [])) {
    let df = 0;
    for (const ws of wordSets) { if (ws.has(t)) { df += 1; } }
    idf.set(t, Math.log((N + 1) / (df + 1)) + 1);
  }
  return idf;
}
// PURE relevance scorer (unit-tested): IDF-WEIGHTED word-boundary unigram overlap PLUS a phrase (bigram) bonus,
// all length-normalized. Tokenizes the slice with the SAME rule as the query so "serve" matches the WORD serve —
// NOT the substring inside "observed"/"reserved". Dividing by sqrt(distinct meaningful words) stops a long slice
// from outscoring a focused one just by containing more words. The bigram bonus rewards slices that share an
// actual PHRASE with the query. The 4th arg (idfWeights: Map term->weight, from computeIdf) scales each unigram
// hit by term rarity; absent -> every term weighs 1 (uniform). Args 3 AND 4 absent -> byte-identical to the
// prior 2-arg scorer (backward compatible). Until the semantic retrieval owner (task #8) is admitted, this is
// the honest interim scorer for both configs' RAG grounding; the reader swaps to that owner with ZERO change.
export function scoreSliceRelevance(sliceText, queryTermList, queryBigrams, idfWeights) {
  const terms = Array.isArray(queryTermList) ? queryTermList : [];
  if (!terms.length) { return 0; }
  const words = new Set(queryTerms(sliceText));
  if (!words.size) { return 0; }
  const idf = idfWeights instanceof Map ? idfWeights : null;
  let hits = 0;
  for (const t of terms) { if (words.has(t)) { hits += idf ? (idf.get(t) || 1) : 1; } }
  let phraseHits = 0;
  const qb = queryBigrams instanceof Set ? queryBigrams : null;
  if (qb && qb.size) { const sb = bigramSet(orderedTokens(sliceText)); for (const g of qb) { if (sb.has(g)) { phraseHits += 1; } } }
  const combined = hits + (BIGRAM_WEIGHT * phraseHits);
  return combined ? combined / Math.sqrt(words.size) : 0;
}
// Fetch content-slice by KIND ONLY (the single-clause path the engine materializes safely — proven OK
// at 1768 slices / 3.08MB) and filter corpus_ref CLIENT-SIDE. The old two-clause query
// {all:[{kind},{corpus_ref}]} TRAPS the engine (FE_INTERNAL_ERROR 'handle_query trap find-current-items')
// once a corpus_ref subset's matched-set is large: hormozi's 649 large-text slices trapped even
// address-only, and `limit` does NOT bound it (the filtered path builds the full matched set BEFORE
// limit applies — limit:50 passed, limit:700 trapped). Root cause (cont.277, 2026-07-08): the tennis
// corpus (1119 slices) was ingested into the SAME kind at 23:39, tipping the filtered path over its
// alloc ceiling and silently zeroing Config B's hormozi retrieval (exc 5->0). The consumer already
// scores slices client-side, so filtering corpus_ref here is consistent, not a new coupling.
// NOTE ON SCALE: kind-only+payload must materialize ALL corpora under the kind, so this has a byte
// ceiling as the shared kind grows. The scale-safe terminal is an index owner (meaning-search /
// search-index, task #8) — retrieval_scope_refs then points at its index and this reader dispatches a
// retrieval-request with ZERO change here. Until that owner is admitted, this is the correct reader.
// DEGRADING-LIMIT ladder (2026-07-11): the UNBOUNDED kind-only query now traps too — the shared kind
// crossed the alloc ceiling again (unbounded + limit:2000 trap; limit:1500 passes), which silently
// zeroed retrieval for EVERY agent (last exc>0 audit 2026-07-10T17:56Z). Grounding must never be
// all-or-nothing: query the SCOPED two-clause form first (bounded result = only this corpus), and on
// an engine trap fall down a limit ladder — fewer slices ground a thinner turn, but the turn still
// grounds. Verified live: tennis scoped limit:800 passes / 1200 traps; hormozi 400 passes / 800 traps.
const SLICE_LIMIT_LADDER = [800, 400, 200, 50];
async function findScopedSlices(corpusRef, basis) {
  // L126 exhaust-off: knowledge-records.content-slice MAY live on the dedicated 'knowledge-records-exhaust'
  // list-path (after migration) OR still on 'published-record' (pre-migration / un-migrated existing slices).
  // Read BOTH and dedup by id so grounding is correct regardless of migration state — reading only the exhaust
  // path returned EMPTY (slices were still on published-record) → zero corpus excerpts → silently ungrounded
  // production. Converges to exhaust-only cost once the writer + backfill land (kind-filtered published-record
  // yields nothing then). This is the both-paths self-healing pattern used for every other exhaust-off reader.
  for (const limit of SLICE_LIMIT_LADDER) {
    const seen = new Set();
    const rows = [];
    for (const listPath of ['knowledge-records-exhaust', 'published-record']) {
      const j = await postTarget('slot::find-current-items', { operation: 'find-current-items', in: listPath, where: { all: [{ field: 'kind', in: ['knowledge-records.content-slice'] }, { field: 'corpus_ref', in: [corpusRef] }] }, include: ['payload'], limit }, basis);
      const a = Array.isArray(j) ? j : (j?.items || j?.results || []);
      for (const x of a) { const p = x.payload || x; if (!p || p.corpus_ref !== corpusRef) continue; const id = p.id; if (typeof id === 'string') { if (seen.has(id)) continue; seen.add(id); } rows.push(p); }
    }
    if (rows.length) { return rows; }
  }
  return [];
}
// P2 INCREMENTAL-DERIVED-STATE (scale gate): the per-agent rolling projection agent-produce-state::<agent>
// holds last_produced_at + the recently-fed excerpt ids, so the hot path reads O(agents) small records
// instead of full-scanning the ever-growing produce-grounded-audit kind (which would eventually TRAP
// find-current-items — reference_find_current_items_wasm_alloc_trap_on_bulk_kind — killing wake selection
// AND novelty, since neither read is safe against that trap). One record per agent, overwritten each turn.
async function readAgentState(agentRef, basis) {
  const rows = await findKind('agent-produce-state', basis);
  return (rows || []).find((r) => r && r.agent_ref === agentRef) || null;
}
// PURE (unit-tested): the projection agent_refs that no longer map to a live ai-agent-profile — a RETIRED
// agent's orphaned rolling state. Generic (L090): compares self-describing agent_ref to the live id set,
// never names an agent.
export function findOrphanProjections(profiles, states) {
  const ids = new Set((profiles || []).map((p) => String((p && p.id) || '')).filter(Boolean));
  return (states || []).filter((s) => s && s.agent_ref && !ids.has(String(s.agent_ref))).map((s) => String(s.agent_ref));
}
// Best-effort orphan sweep: retract agent-produce-state projections whose agent was RETIRED, so the
// projection kind stays bounded to LIVE agents (completes the cont.501 scale gate + cont.504 retire — a
// retired agent must leave no lingering state). Null-retract is safe (agent-produce-state is DATA read via
// find-current-items, not slot-hydrated). Fail-safe: any error is swallowed, never blocks the produce.
async function sweepOrphanProjections(basis) {
  try {
    const profiles = await findKind('ai-agent-profile', basis);
    const states = await findKind('agent-produce-state', basis);
    const orphans = findOrphanProjections(profiles, states);
    for (const ref of orphans) {
      try { await postTarget('engine.operation.label-addressed', { operation_label: 'engine.operation.write-batch', writes: [{ partition_label: PARTITION_LABEL, address_label: `agent-produce-state::${ref}`, address_mode: 'identity_text', path_labels: ['current-item', 'agent-produce-state-index'] }] }, basis); } catch (e) { /* skip one orphan */ }
    }
    return orphans.length;
  } catch (e) { return 0; }
}
// PURE novelty-FIFO merge (unit-tested): append this turn's excerpt ids to the prior rolling list, dedup
// keeping the MOST-RECENT occurrence (preserve order oldest→newest), and keep only the last `cap` ids.
export function mergeRecentExcerptIds(priorIds, newIds, cap) {
  const merged = [...(Array.isArray(priorIds) ? priorIds.map(String) : []), ...(Array.isArray(newIds) ? newIds.map(String) : [])];
  const seen = new Set(); const out = [];
  for (let i = merged.length - 1; i >= 0; i--) { const id = merged[i]; if (!seen.has(id)) { seen.add(id); out.push(id); } }
  out.reverse();
  const c = Number.isFinite(cap) && cap > 0 ? cap : out.length;
  return out.slice(Math.max(0, out.length - c));
}
// PURE parse of the meaning-search executor's query contract (unit-tested). Returns an ORDERED list of
// {id, score} for results at/above minConfidence, plus ok. FAIL-CLOSED: {ok:false} / malformed / all
// below confidence -> {ok:false} so the caller falls back to the built-in keyword scorer. This is the
// tick-side half of the DATA-selected retrieval swap; the semantic source is a data-selected capability,
// the keyword scorer is the always-present default + fallback (L090/enum-dissolution — no hardcoded engine).
export function parseSemanticResults(raw, minConfidence) {
  const min = Number.isFinite(minConfidence) ? minConfidence : 0;
  const r = raw && typeof raw === 'object' ? raw : null;
  if (!r || r.ok !== true || !Array.isArray(r.results)) { return { ok: false, ranked: [] }; }
  const ranked = r.results
    .filter((x) => x && typeof x.slice_id === 'string' && x.slice_id && (Number(x.confidence) || 0) >= min)
    .map((x) => ({ id: String(x.slice_id), score: Number(x.similarity) || 0 }));
  return ranked.length ? { ok: true, ranked } : { ok: false, ranked: [] };
}
// PURE: project a semantic ranking (ordered ids) onto the ALREADY-LOADED slices for a ref, preserving the
// semantic order and dropping ids not present in this ref's slice set. Shape matches the keyword `ranked`
// list ({s, text, score}) so the shared novelty/top-K/block logic is identical for both sources.
export function rankSlicesBySemantic(slices, semanticRanked) {
  const byId = new Map();
  for (const s of (Array.isArray(slices) ? slices : [])) { if (s && s.id != null) { byId.set(String(s.id), s); } }
  const out = [];
  for (const r of (Array.isArray(semanticRanked) ? semanticRanked : [])) {
    const s = byId.get(String(r && r.id));
    const text = s && typeof s.text === 'string' ? s.text : '';
    if (s && text) { out.push({ s, text, score: Number(r.score) || 0 }); }
  }
  return out;
}
async function retrieveScopedCorpus(refs, queryText, seenIds, basis) {
  const list = Array.isArray(refs) ? refs.filter((r) => typeof r === 'string' && r.trim()) : [];
  if (!list.length) { return { block: '', count: 0, refs: [], ids: [], seen_excluded: 0 }; }
  const terms = queryTerms(queryText);
  const qBigrams = bigramSet(orderedTokens(queryText));
  // Retrieval SOURCE is DATA-selected: if a semantic query address is configured (SEMANTIC_QUERY_ADDRESS,
  // set only once meaning-search's executor is admitted), dispatch the query there and use its ranking;
  // otherwise (default) use the built-in keyword scorer. Semantic failures fall back to keyword per-ref.
  const SEMANTIC_ADDR = process.env.SEMANTIC_QUERY_ADDRESS || '';
  const SEMANTIC_MIN_CONF = Number(process.env.SEMANTIC_MIN_CONFIDENCE || '0.55');
  const seen = seenIds instanceof Set ? seenIds : new Set();
  // DATA-selected retrieval SOURCE (L090/enum-dissolution): when SEMANTIC_QUERY_ADDRESS is configured
  // (i.e. the meaning-search executor is admitted), dispatch the query ONCE to that address for a global
  // similarity ranking over slice ids, then project it onto each ref's already-loaded slices. Otherwise —
  // and on ANY dispatch/parse failure — use the always-present keyword scorer. The tick never hardcodes an
  // engine; a semantic outage can never lose grounding (fail-closed to keyword). Backward-compatible: an
  // empty SEMANTIC_ADDR (the default) leaves semanticRanked null → keyword path exactly as before.
  let semanticRanked = null;
  if (SEMANTIC_ADDR) {
    try {
      const raw = await postTarget(SEMANTIC_ADDR, { operation: 'semantic-query', query_text: queryText, top_k: CORPUS_TOPK * Math.max(1, list.length) }, basis);
      const parsed = parseSemanticResults(raw, SEMANTIC_MIN_CONF);
      semanticRanked = parsed.ok ? parsed.ranked : null;
    } catch { semanticRanked = null; }
  }
  let block = '';
  let count = 0;
  let seenExcluded = 0;
  const ids = [];
  for (const ref of list) {
    const slices = await findScopedSlices(ref, basis);
    // Corpus-wide IDF over THIS ref's loaded slices (rare/discriminating terms weigh more) — zero new infra.
    const idf = computeIdf(terms, slices.map((s) => (typeof s.text === 'string' ? s.text : '')));
    const kwRanked = slices.map((s) => { const text = typeof s.text === 'string' ? s.text : ''; return { s, text, score: text ? scoreSliceRelevance(text, terms, qBigrams, idf) : 0 }; })
      .filter((x) => x.text && x.score > 0).sort((a, b) => b.score - a.score);
    // Semantic ranking projected onto THIS ref's slices when available + non-empty; else keyword fallback
    // (a ref with no semantic hits still grounds off its keyword matches — no ref goes silently empty).
    const semForRef = semanticRanked ? rankSlicesBySemantic(slices, semanticRanked) : [];
    const ranked = semForRef.length ? semForRef : kwRanked;
    // Prefer unseen high-scored slices; fall back to seen only when too few novel ones remain.
    const novel = ranked.filter((x) => !seen.has(String(x.s.id)));
    const chosen = (novel.length >= CORPUS_TOPK ? novel : novel.concat(ranked.filter((x) => seen.has(String(x.s.id))))).slice(0, CORPUS_TOPK);
    seenExcluded += ranked.length - novel.length;
    const scored = chosen;
    if (scored.length) {
      count += scored.length;
      for (const x of scored) { ids.push(String(x.s.id || x.s.ordinal || '?')); }
      block += `\n\nRELEVANT PLAYBOOK EXCERPTS from ${ref} (ground your action in these; put the id [in brackets] of the one you act on into grounding_citation):`;
      block += '\n' + scored.map((x, i) => `${i + 1}. [${x.s.id || x.s.ordinal || '?'}] ${x.text.slice(0, CORPUS_EXCERPT_CHARS).replace(/\s+/g, ' ').trim()}`).join('\n');
    }
  }
  return { block, count, refs: list, ids, seen_excluded: seenExcluded };
}
function isoNow() { return new Date().toISOString(); }
// WAKE FAN-OUT (2nd-gen, L069): the SAME armed clock tick rotates production over EVERY wake-eligible
// ai-agent-profile PRESENT in this app — a profile is wake-eligible iff it is NOT retired AND carries a
// non-empty produce_instruction (the operator, the coach, any SPAWNED specialist). Membership is pure
// DATA: a newly spawned producer auto-enters the rotation with ZERO code change; a retired one drops out.
// This dodges the accreted-studio trigger-hydration wall (no new trigger — the leaf the armed tick already
// fires does the selection), the concurrent-codex crash (exactly ONE agent per tick → one serial AI turn,
// same cost as the single-agent baseline), and the fan-out starvation (no blocking loop). Selection is
// STALENESS-PRIORITY: the agent whose most-recent produce-grounded-audit is oldest (or who never produced)
// goes next — fair, never-starving. FAIL-CLOSED (adversarial): any query failure or empty eligible set
// falls back to the env AGENT_REF (the proven operator baseline is never lost); a selected agent always
// has a produce_instruction (it came from the eligible filter) so the downstream turn is never malformed.
// PURE wake-decision core (no I/O — unit-tested in produce-grounded.test.mjs). Eligibility: not retired
// AND (own produce_instruction OR autospawned with a contracted parent). Staleness-priority: never-produced
// first (''), then oldest last-produce, deterministic id tie-break. Fail-closed to envAgentRef on empty set.
export function pickWakeAgent(profiles, audits, envAgentRef) {
  const hasInstr = (p) => p && typeof p.produce_instruction === 'string' && p.produce_instruction.trim();
  // An AUTOSPAWNED specialist is wake-eligible even without its own produce_instruction, PROVIDED its
  // parent carries a contract to inherit (resolveEffectiveInstruction composes the child's turn on the
  // read side). This makes 2nd-gen wake work on the LIVE studio without a def-structure reopen for the
  // write-side spawn fix. Fail-closed: no contracted parent → not eligible.
  const parentHasContract = (p) => { const pr = p.parent_ref || p.spawned_by || ''; return pr && (profiles || []).some((q) => q && q.id === pr && hasInstr(q)); };
  const eligible = (profiles || []).filter((p) => p && p.id
    && String(p.status || '') !== 'retired'
    && (hasInstr(p) || (p.autospawned && parentHasContract(p))));
  if (!eligible.length) { return { agent_ref: envAgentRef, eligible: 0, source: 'fallback-empty' }; }
  // Most-recent produce time per agent (produced_at is an ISO string → lexicographic max = latest turn).
  const lastByAgent = new Map();
  for (const a of (audits || [])) {
    if (!a || !a.agent_ref) { continue; }
    const t = String(a.produced_at || a.request_id || '');
    const prev = lastByAgent.get(a.agent_ref);
    if (prev === undefined || t > prev) { lastByAgent.set(a.agent_ref, t); }
  }
  // Never-produced agents sort first (''), then oldest-last-produced; deterministic id tie-break.
  eligible.sort((x, y) => {
    const xt = lastByAgent.get(x.id) || '';
    const yt = lastByAgent.get(y.id) || '';
    if (xt !== yt) { return xt < yt ? -1 : 1; }
    return String(x.id).localeCompare(String(y.id));
  });
  return { agent_ref: eligible[0].id, eligible: eligible.length, source: 'staleness' };
}
async function selectWakeAgent(envAgentRef, basis) {
  try {
    const profiles = await findKind('ai-agent-profile', basis);
    // Staleness reads the bounded per-agent projection (agent-produce-state.produced_at), NOT the growing
    // audit kind. pickWakeAgent treats a missing state as never-produced ('') → it sorts first, so a fresh
    // deploy (no projections yet) simply re-seeds the rotation over the next N ticks. Same shape as before.
    const states = await findKind('agent-produce-state', basis);
    return pickWakeAgent(profiles, states, envAgentRef);
  } catch (e) {
    return { agent_ref: envAgentRef, eligible: 0, source: 'fallback-error' };
  }
}
// Resolve the effective produce instruction + output_kind for the selected agent. Explicit
// produce_instruction wins (self-describing, the norm — operator/coach). For an AUTOSPAWNED specialist
// that lacks one, COMPOSE it on the read side: the child's own mandate (its directive block body, else
// role/function/grounding fields) + the PARENT's produce_instruction inherited as the output contract +
// the parent's output_kind. Generic (L090): reads self-describing profile fields, never enumerates an
// agent. This is what lets an operator-spawned business specialist wake and produce a PARSEABLE turn on
// the live studio even before the write-side spawn fix hydrates.
// PURE instruction-composition core (no I/O — unit-tested). Explicit produce_instruction wins ('profile');
// else an AUTOSPAWNED specialist composes its mandate + the parent's inherited contract ('inferred-spawned');
// else empty ('none', fail-closed). mandate falls back to name/id when blank; output_kind = explicit else parent.
export function composeEffectiveInstruction(o) {
  const explicit = (o && typeof o.explicit === 'string' && o.explicit.trim()) ? o.explicit.trim() : '';
  const explicitKind = (o && typeof o.explicitKind === 'string' && o.explicitKind.trim()) ? o.explicitKind.trim() : '';
  if (explicit) { return { instruction: explicit, output_kind: explicitKind, source: 'profile' }; }
  if (!(o && o.autospawned)) { return { instruction: '', output_kind: explicitKind, source: 'none' }; }
  const parentInstr = (typeof o.parentInstr === 'string' && o.parentInstr.trim()) ? o.parentInstr.trim() : '';
  const parentKind = (typeof o.parentKind === 'string' && o.parentKind.trim()) ? o.parentKind.trim() : 'action-intent';
  const mandate = (typeof o.mandate === 'string' && o.mandate.trim()) ? o.mandate.trim() : String(o.name || o.id || '');
  const instruction = `You are "${o.name || o.id}", a focused SPECIALIST sub-agent spawned by ${o.parentRef}. YOUR MANDATE (act ONLY on this, AS YOURSELF — you are NOT the parent): ${mandate}\n\nProduce your output in EXACTLY your parent's contract/output format below, specialized to your mandate:\n\n${parentInstr}`;
  return { instruction, output_kind: explicitKind || parentKind, source: 'inferred-spawned' };
}
async function resolveEffectiveInstruction(profile, basis) {
  const explicit = (profile && typeof profile.produce_instruction === 'string' && profile.produce_instruction.trim()) ? profile.produce_instruction.trim() : '';
  const explicitKind = (profile && typeof profile.produce_output_kind === 'string' && profile.produce_output_kind.trim()) ? profile.produce_output_kind.trim() : '';
  if (explicit) { return composeEffectiveInstruction({ explicit, explicitKind }); }
  if (!(profile && profile.autospawned)) { return composeEffectiveInstruction({ explicitKind, autospawned: false }); }
  const parentRef = profile.parent_ref || profile.spawned_by || '';
  const profs = await findKind('ai-agent-profile', basis);
  const parent = (profs || []).find((p) => p && p.id === parentRef) || null;
  const parentInstr = (parent && typeof parent.produce_instruction === 'string' && parent.produce_instruction.trim()) ? parent.produce_instruction.trim() : '';
  const parentKind = (parent && typeof parent.produce_output_kind === 'string' && parent.produce_output_kind.trim()) ? parent.produce_output_kind.trim() : 'action-intent';
  let mandate = '';
  const refs = Array.isArray(profile.instruction_block_refs) ? profile.instruction_block_refs : [];
  if (refs.length) { const blocks = await findKind('ai-instruction-block', basis); const b = (blocks || []).find((x) => x && (x.id === refs[0] || x.id === `${profile.id}-directive`)); if (b) { mandate = String(b.body || b.text || '').trim(); } }
  if (!mandate) { mandate = [profile.role, profile.function, profile.grounding].filter((v) => typeof v === 'string' && v.trim()).join('. '); }
  return composeEffectiveInstruction({ explicitKind, autospawned: true, parentRef, parentInstr, parentKind, mandate, name: profile.name, id: profile.id });
}
// Resolve the effective RAG retrieval scope for the selected agent — parallel to resolveEffectiveInstruction.
// The profile's own non-empty retrieval_scope_refs wins (self-describing, the norm — operator declares
// ["corpus:hormozi-playbooks"], coach declares ["corpus:tennis-athlete-brain"]). An AUTOSPAWNED specialist
// that lacks its own scope INHERITS its parent's, so a spawned business closer is grounded in the SAME
// corpus its parent produces from (without corpus grounding it inherits the parent's instruction — which
// cites the corpus — but retrieves 0 excerpts, a real quality gap: proven cont.498, specialists got
// corpus_excerpts:0 while the operator got 5). Generic (L090): reads self-describing profile fields
// (retrieval_scope_refs + parent_ref/spawned_by), never enumerates an agent or a corpus. Fail-closed:
// no parent / no parent scope → empty refs → retrieveScopedCorpus is a no-op (never throws).
// PURE retrieval-scope core (no I/O — unit-tested). Own non-empty scope wins ('profile'); else an
// autospawned specialist inherits the parent's ('inherited-parent'); else empty ('none', fail-closed).
export function effectiveRetrievalScope(ownScope, autospawned, parentScope) {
  const own = Array.isArray(ownScope) ? ownScope.filter(Boolean) : [];
  if (own.length) { return { refs: own, source: 'profile' }; }
  if (!autospawned) { return { refs: [], source: 'none' }; }
  const prefs = Array.isArray(parentScope) ? parentScope.filter(Boolean) : [];
  return { refs: prefs, source: prefs.length ? 'inherited-parent' : 'none' };
}
async function resolveRetrievalScope(profile, basis) {
  const ownScope = profile && profile.retrieval_scope_refs;
  const autospawned = !!(profile && profile.autospawned);
  const own = Array.isArray(ownScope) ? ownScope.filter(Boolean) : [];
  const parentRef = (profile && (profile.parent_ref || profile.spawned_by)) || '';
  // Only the autospawned-with-parent-and-no-own-scope path needs the parent I/O; all other cases the pure
  // core decides with parentScope=null (own-wins / non-autospawned / no-parent → the same [] result).
  if (own.length || !autospawned || !parentRef) { return effectiveRetrievalScope(ownScope, autospawned, null); }
  try {
    const profs = await findKind('ai-agent-profile', basis);
    const parent = (profs || []).find((p) => p && p.id === parentRef) || null;
    return effectiveRetrievalScope(ownScope, true, parent && parent.retrieval_scope_refs);
  } catch (e) { return effectiveRetrievalScope(ownScope, true, null); }
}
async function main() {
  const basis = await fetchBasis();
  // Pick which wake-eligible agent produces THIS tick (staleness-priority; fail-closed to the operator).
  const selection = await selectWakeAgent(AGENT_REF, basis);
  const activeAgentRef = selection.agent_ref;
  // Read the agent's profile ONCE — it drives instruction, grounding SENSE, and output_kind (all DATA).
  const profile = await readProfile(activeAgentRef, basis);
  // SENSE (Layer 5 READ): inject the grounding records the profile declares, else the operator's
  // own recent ai-memory decisions ("do not repeat"). Generic loop; no hardcoded kind.
  const groundingDescriptors = (profile && Array.isArray(profile.grounding_sense) && profile.grounding_sense.length) ? profile.grounding_sense : OPERATOR_DEFAULT_GROUNDING;
  const grounding = await senseGroundingBlocks(groundingDescriptors, basis);
  const recentBlock = grounding.block;
  // Resolve the base instruction per-agent from DATA (profile.produce_instruction), else the
  // explicit env override, else the operator default. base_source is recorded for readback proof.
  const effective = await resolveEffectiveInstruction(profile, basis);
  const profileInstruction = effective.instruction;
  const envInstruction = process.env.BITFIELD_BASE_INSTRUCTION || '';
  const baseSource = envInstruction ? 'env' : (profileInstruction ? effective.source : 'default');
  const baseInstruction = envInstruction || profileInstruction || OPERATOR_DEFAULT_INSTRUCTION;
  // RAG SENSE: retrieve the corpus the profile declares (retrieval_scope_refs), scored against the
  // current decision context (mission + recent decisions + the capability/mission vocabulary in the
  // base instruction), and inject citable excerpts. DATA-configured per-agent; empty refs → no-op.
  const priorState = await readAgentState(activeAgentRef, basis);
  const seenExcerpts = (CORPUS_NOVELTY_WINDOW > 0 && priorState && Array.isArray(priorState.recent_excerpt_ids)) ? new Set(priorState.recent_excerpt_ids.map(String)) : new Set();
  const scope = await resolveRetrievalScope(profile, basis);
  const retrieval = await retrieveScopedCorpus(scope.refs, (grounding.block ? grounding.block + ' ' : '') + baseInstruction, seenExcerpts, basis);
  // OUTPUT INTEGRITY (generic, L117 — appended to EVERY agent's turn, no domain vocabulary): forbid
  // fabricating a specific individual/subject the agent has no real record for. This is the anti-fiction
  // guard for the whole autonomous fleet — an operator with NO real lead corpus was inventing named cold-
  // outreach targets ("Warm lead — Daniel M., liked 3 posts, saved the reel") with zero backing record
  // (lead/contact/observed-content all 0). Real inbound (a cited message) and records QUERIES are fine;
  // an invented person is not. Generic anti-hallucination, not Society — applies to any producing agent.
  const INTEGRITY_CLAUSE = '\n\nOUTPUT INTEGRITY (mandatory, fail-closed): NEVER fabricate a specific named individual/account/subject or their past behavior. Anyone/anything you target MUST be either (a) a records QUERY that resolves against real stored records, or (b) an exact citation of a real record present in the grounding above (quote its id/handle verbatim). If you have no real record to cite, express the audience/subject as a records QUERY — never as an invented person. Inventing a plausible-sounding individual or fake engagement history is a FAILED turn.';
  const instruction = baseInstruction + recentBlock + retrieval.block + INTEGRITY_CLAUSE;
  // output_kind is DATA per-agent (operator→action-intent, coach→drill-prescription); the producer
  // parses stdout keyed by it. Defaults preserve Config B.
  const outputKind = (effective.output_kind && effective.output_kind.trim()) ? effective.output_kind.trim() : 'action-intent';
  const requestId = isoNow();
  // Queryable audit marker so tick-driven grounding is provable by readback (result records
  // don't reveal the instruction). Idempotent by request_id.
  await postTarget('engine.operation.label-addressed', { operation_label: 'engine.operation.write-batch', writes: [{ partition_label: PARTITION_LABEL, address_label: `produce-grounded-audit::${requestId}`, address_mode: 'identity_text', path_labels: ['current-item', 'produce-grounded-audit-index'], payload: { kind: 'produce-grounded-audit', id: `produce-grounded-audit::${requestId}`, request_id: requestId, agent_ref: activeAgentRef, wake_selection: selection.source, wake_eligible: selection.eligible, memories_read: grounding.count, corpus_excerpts: retrieval.count, corpus_refs: retrieval.refs, corpus_scope_source: scope.source, corpus_excerpt_ids: retrieval.ids, corpus_novelty_window: CORPUS_NOVELTY_WINDOW, corpus_seen_excluded: retrieval.seen_excluded, instruction_chars: instruction.length, base_source: baseSource, output_kind: outputKind, produced_at: requestId } }] }, basis);
  // P2 projection write (scale gate): update this agent's bounded rolling state so the NEXT tick's
  // wake-staleness + corpus-novelty read O(agents) small records, never the growing audit kind. One record
  // per agent (overwritten). Fail-safe: a projection error never blocks the produce — the audit already
  // committed and dispatch still runs.
  try {
    const recentIds = mergeRecentExcerptIds(priorState && priorState.recent_excerpt_ids, retrieval.ids, SEEN_CAP);
    await postTarget('engine.operation.label-addressed', { operation_label: 'engine.operation.write-batch', writes: [{ partition_label: PARTITION_LABEL, address_label: `agent-produce-state::${activeAgentRef}`, address_mode: 'identity_text', path_labels: ['current-item', 'agent-produce-state-index'], payload: { kind: 'agent-produce-state', id: `agent-produce-state::${activeAgentRef}`, agent_ref: activeAgentRef, produced_at: requestId, recent_excerpt_ids: recentIds } }] }, basis);
  } catch (e) { /* best-effort projection; audit trail + produce already committed */ }
  const dispatch = await postTarget('slot::workflow', { operation: 'execute_definition', definition_id: 'action:run-ai-records-production', include_output: false, include_steps: false, input: { request_id: requestId, instruction_text: instruction, input_refs: grounding.input_refs, output_kind: outputKind, wrap_instruction_ref: '', model: '', agent_ref: activeAgentRef, target_group_ref: '', requested_at: requestId } }, basis);
  const dispatched = !!(dispatch !== null);
  // Best-effort orphan-projection cleanup (off the produce critical path): keep agent-produce-state bounded
  // to LIVE agents as retires happen. Runs AFTER dispatch so it never delays the AI turn.
  const orphansSwept = await sweepOrphanProjections(basis);
  // No long poll: the producer writes the result async and the tick sweep guards+surfaces it.
  // The audit record above is the queryable proof this grounded produce ran (memories injected).
  console.log(JSON.stringify({ tag: 'produce-grounded', agent_ref: activeAgentRef, wake_selection: selection.source, wake_eligible: selection.eligible, base_source: baseSource, output_kind: outputKind, memories_read: grounding.count, corpus_excerpts: retrieval.count, corpus_refs: retrieval.refs, corpus_scope_source: scope.source, corpus_excerpt_ids: retrieval.ids, instruction_chars: instruction.length, orphans_swept: orphansSwept, request_id: requestId, audit_written: true, dispatched }));
}
// Run only as the process entry (env set in prod); a test importing this module skips main().
if (CARRIER_URL) { main().catch((e) => { console.error('Fatal:', e && (e.stack || e.message || e)); process.exit(1); }); }
