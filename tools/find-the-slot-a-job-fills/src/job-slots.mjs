// src/job-slots.mjs
//
// PURPOSE
//   Code that needs "the tool that does this job" asks for the job's slot instead of naming a tool id, so an account
//   that installed a different provider (or none of Trillion's) still works, and the tool Trillion ships can be removed.
//   A tool row says which jobs it serves (`serves: ["<job>"]`). slotTool picks, among the tools the account has, the one
//   to use: the account's own choice first, then the best ranked, else a refusal that says what to install.
//   This is the skeleton: the callers that name tools today are changed one by one by the job-slot package. A job every
//   serving tool does at once (encode: one meaning space per tool) reads toolsServing.
//
// NON-NEGOTIABLE INVARIANTS
//   1. CORE_TOOL_IDS are the tools the engine itself stands on; they are always in, never a slot, never removed.
//   2. The account's choice (the fact `job_slot:<job>`, handed in) wins when that tool is one the account has and serves
//      the job; a choice that no longer is one is ignored, not an error.
//   3. With no choice the best `rank` wins, and a tie goes to the lower id, so the pick is the same every time.
//   4. No tool for the job is a JobSlotError with a `next_call` naming what to install, never a guess at another tool.
//

/** The tools the engine stands on; code may name them. */
export const CORE_TOOL_IDS = Object.freeze([
  'tool:filter-rows-by-rules',
  'tool:when-to-run-next',
  'tool:evaluate-binding',
  'tool:run-workflow-definition',
]);
const TOOL_CATALOG_PAGE_SIZE = 32;

/** The fact an account keeps its choice of tool for a job under. */
export const jobSlotFact = job => `job_slot:${job}`;

export class JobSlotError extends Error {
  constructor(message, next_call = null) { super(message); this.name = 'JobSlotError'; this.next_call = next_call; }
}

/**
 * Every tool the account has that serves `job`, best ranked first (ties by id), for a job every serving tool does at
 * once (each encoder is its own meaning space, src/meaning-spaces.mjs) rather than one chosen tool. Same arguments as
 * slotTool; none serving is an empty list, not an error.
 */
export function toolsServing(job, set, tools, { rank = () => 0 } = {}) {
  return tools.filter(tool => Array.isArray(tool.serves) && tool.serves.includes(job) && set.has(tool.id))
    .sort((a, b) => rank(b) - rank(a) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * job:  the job's name, as tool rows list it in `serves`
 * set:  the account's installed set (src/installed-set.mjs): `has(id)` says whether a tool is one the account has
 * tools: the tool rows to choose among ({ id, serves: [job], ... })
 * choice: the tool id the account chose for this job (fact job_slot:<job>), or null
 * rank:  (tool) → a number, higher is better (the run ranking the Workshop keeps); the default ranks all alike
 * → the chosen tool row
 */
export function slotTool(job, set, tools, { choice = null, rank = () => 0 } = {}) {
  const serving = toolsServing(job, set, tools, { rank });
  const chosen = choice && serving.find(tool => tool.id === choice);
  if (chosen) return chosen;
  const [best] = serving;
  if (best) return best;
  throw new JobSlotError(`No tool you have does "${job}". Install one that does.`, `find_tool_for_job {"job":${JSON.stringify(job)}} then install the set that holds it with install_replacement_set`);
}

/**
 * Which tools this account has serve which job, kept as each tool is saved and each install is written, so finding the
 * tools for a job is an index seek, never a read of every saved tool (src/person-store.mjs addWorkshopValue). A tool
 * installed from the Marketplace is noted unread; its descriptor is read once to learn its jobs (`read`). `serves` is
 * new with this index, so no row kept before it can serve a job and nothing earlier needs reading again.
 */
export function jobToolsIndex(sql) {
  sql.exec('CREATE TABLE IF NOT EXISTS job_tools (tool_id TEXT NOT NULL, held_by TEXT NOT NULL, job TEXT NOT NULL, PRIMARY KEY (job, tool_id, held_by))');
  sql.exec('CREATE INDEX IF NOT EXISTS job_tools_held_by ON job_tools (held_by)');
  sql.exec('CREATE TABLE IF NOT EXISTS job_tools_unread (tool_id TEXT NOT NULL, held_by TEXT NOT NULL, PRIMARY KEY (held_by, tool_id))');
  sql.exec('CREATE TABLE IF NOT EXISTS job_tools_catalog (id INTEGER PRIMARY KEY CHECK (id=1), revision INTEGER NOT NULL)');
  sql.exec('INSERT OR IGNORE INTO job_tools_catalog (id,revision) VALUES (1,0)');
  // reads-ok: each caller's statement is a literal this lint checks where it is written.
  const all = (query, ...values) => sql.exec(query, ...values).toArray();
  const revision = () => sql.exec('SELECT revision FROM job_tools_catalog WHERE id=1 LIMIT 1').toArray()[0]?.revision ?? 0;
  const changed = () => sql.exec('UPDATE job_tools_catalog SET revision=revision+1 WHERE id=1');
  const forget = heldBy => { sql.exec('DELETE FROM job_tools WHERE held_by = ?', heldBy); sql.exec('DELETE FROM job_tools_unread WHERE held_by = ?', heldBy); };
  const note = (toolId, heldBy, serves) => { for (const job of Array.isArray(serves) ? serves : []) if (typeof job === 'string') sql.exec('INSERT OR IGNORE INTO job_tools (tool_id, held_by, job) VALUES (?, ?, ?)', toolId, heldBy, job); };
  // Page PHYSICAL holder rows, not DISTINCT output rows: a tool can be held by
  // many installs. Each seek uses the full (job,tool_id,held_by) primary key, so
  // duplicates cannot consume a hidden cap or turn one page into an all-holder
  // GROUP BY. Empty nonterminal id pages still advance their physical cursor.
  const servingPage = (job, { after = null, limit = 64 } = {}) => {
    if (typeof job !== 'string' || !Number.isInteger(limit) || limit < 1 || limit > 200)
      throw new TypeError('Read between 1 and 200 job-tool holder rows.');
    if (after !== null && (!after || Array.isArray(after) || typeof after !== 'object'
      || Object.keys(after).some(key => !['job', 'tool_id', 'held_by'].includes(key))
      || after.job !== job || typeof after.tool_id !== 'string' || typeof after.held_by !== 'string'))
      throw new TypeError('Keep the exact job-tool physical page cursor.');
    const rows = after === null
      ? sql.exec('SELECT tool_id, held_by FROM job_tools WHERE job = ? ORDER BY tool_id, held_by LIMIT ?', job, limit + 1).toArray()
      : sql.exec('SELECT tool_id, held_by FROM job_tools WHERE job = ? AND (tool_id, held_by) > (?, ?) ORDER BY tool_id, held_by LIMIT ?', job, after.tool_id, after.held_by, limit + 1).toArray();
    const selected = rows.slice(0, limit), complete = rows.length <= limit, last = selected.at(-1);
    // The prior page already emitted its last tool. Suppress only that same
    // tool on continuation; preserve every later id even after >500 holders.
    const ids = [...new Set(selected.filter(row => after === null || row.tool_id !== after.tool_id).map(row => row.tool_id))];
    return { ids, complete, next_after: complete ? null : { job, tool_id: last.tool_id, held_by: last.held_by } };
  };
  return {
    /** A saved tool row as written: its jobs replace what it served before; a deleted one serves none. */
    saved(row) {
      if (typeof row?.id !== 'string') return;
      changed();
      forget(`saved:${row.id}`);
      if (row.status !== 'deleted') note(row.id, `saved:${row.id}`, row.serves);
    },
    /** An install row as written (src/marketplace-configurations.mjs installedConfiguration): its tools are noted unread. */
    installed(entity, row) {
      changed();
      forget(entity);
      if (!row || row.removed_at || row.context !== 'private' || row.pursuit_id) return;
      const without = new Set(Array.isArray(row.without) ? row.without : []);
      for (const component of Array.isArray(row.components) ? row.components : []) {
        if (component?.kind === 'tool' && typeof component.id === 'string' && !without.has(component.id)) sql.exec('INSERT OR IGNORE INTO job_tools_unread (tool_id, held_by) VALUES (?, ?)', component.id, entity);
      }
    },
    /** Installed tools whose jobs are not known yet: [{ tool_id, held_by }]. */
    unread(limit = 50) {
      if (!Number.isInteger(limit) || limit < 0 || limit > 200) throw new TypeError('Read between 0 and 200 unread job-tool rows.');
      return sql.exec('SELECT tool_id, held_by FROM job_tools_unread LIMIT ?', limit).toArray();
    },
    /** One physical unread page from the original held_by/tool_id key. A null descriptor does not block later rows. */
    unreadBoundary() {
      return sql.exec('SELECT held_by, tool_id FROM job_tools_unread ORDER BY held_by DESC, tool_id DESC LIMIT 1').toArray()[0] ?? null;
    },
    unreadPage({ after = null, through, limit = 50 } = {}) {
      const key = value => value && typeof value.held_by === 'string' && typeof value.tool_id === 'string';
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200 || !key(through) || after !== null && !key(after))
        throw new TypeError('Keep the exact finite unread descriptor range and page size.');
      const rows = after === null
        ? sql.exec('SELECT held_by, tool_id FROM job_tools_unread WHERE (held_by, tool_id) <= (?, ?) ORDER BY held_by, tool_id LIMIT ?', through.held_by, through.tool_id, limit + 1).toArray()
        : sql.exec('SELECT held_by, tool_id FROM job_tools_unread WHERE (held_by, tool_id) > (?, ?) AND (held_by, tool_id) <= (?, ?) ORDER BY held_by, tool_id LIMIT ?', after.held_by, after.tool_id, through.held_by, through.tool_id, limit + 1).toArray();
      const selected = rows.slice(0, limit), complete = rows.length <= limit;
      return { rows: selected, complete, next_after: complete ? null : selected.at(-1) };
    },
    /** An installed tool's jobs, read from its descriptor (null when it could not be read: it stays unread). */
    read(toolId, heldBy, serves) {
      if (serves === null) return;
      sql.exec('DELETE FROM job_tools_unread WHERE held_by = ? AND tool_id = ?', heldBy, toolId);
      note(toolId, heldBy, serves.length ? serves : []);
    },
    revision,
    /** Stable exact pages over unread descriptors and then known serving IDs. `after` is an opaque JSON cursor. */
    catalogPage(job, { after = null, revision: requestedRevision = null, limit = TOOL_CATALOG_PAGE_SIZE } = {}) {
      const size = Math.max(1, Math.min(TOOL_CATALOG_PAGE_SIZE, Number.isInteger(limit) ? limit : TOOL_CATALOG_PAGE_SIZE));
      const current = String(revision());
      let position = { phase: 'unread', held_by: null, tool_id: null };
      if (after !== null) {
        try {
          const parsed = typeof after === 'string' ? JSON.parse(after) : after;
          const unreadCursor = parsed?.phase === 'unread' && (parsed.held_by === null && parsed.tool_id === null
            || typeof parsed.held_by === 'string' && typeof parsed.tool_id === 'string');
          const toolsCursor = parsed?.phase === 'tools' && (parsed.tool_id === null && parsed.held_by === null
            || typeof parsed.tool_id === 'string' && typeof parsed.held_by === 'string');
          if (unreadCursor || toolsCursor) position = parsed;
          else return { restart: true, revision: current, unread: [], tool_ids: [], cursor: { revision: current, after: null }, complete: false };
        } catch {
          return { restart: true, revision: current, unread: [], tool_ids: [], cursor: { revision: current, after: null }, complete: false };
        }
      }
      if (requestedRevision !== null && String(requestedRevision) !== current) {
        return { restart: true, revision: current, unread: [], tool_ids: [], cursor: { revision: current, after: null }, complete: false };
      }
      if (position.phase === 'unread') {
        const unreadRows = position.held_by === null
          ? all('SELECT tool_id,held_by FROM job_tools_unread ORDER BY held_by,tool_id LIMIT ?', size + 1)
          : all('SELECT tool_id,held_by FROM job_tools_unread WHERE (held_by,tool_id)>(?,?) ORDER BY held_by,tool_id LIMIT ?', position.held_by, position.tool_id, size + 1);
        if (unreadRows.length) {
          const hasMore = unreadRows.length > size;
          const unread = unreadRows.slice(0, size);
          const last = unread.at(-1);
          const next = hasMore
            ? { phase: 'unread', held_by: last.held_by, tool_id: last.tool_id }
            : { phase: 'tools', tool_id: null, held_by: null };
          return { restart: false, revision: current, unread, tool_ids: [], cursor: { revision: current, after: JSON.stringify(next) }, complete: false };
        }
        // A final non-empty unread page transitions to the tools phase. Empty discovery can continue directly to IDs.
        position = { phase: 'tools', tool_id: null, held_by: null };
      }
      const toolRows = position.tool_id === null
        ? all('SELECT tool_id,held_by FROM job_tools WHERE job=? ORDER BY tool_id,held_by LIMIT ?', job, size + 1)
        : all('SELECT tool_id,held_by FROM job_tools WHERE job=? AND (tool_id,held_by)>(?,?) ORDER BY tool_id,held_by LIMIT ?', job, position.tool_id, position.held_by, size + 1);
      const hasMore = toolRows.length > size;
      const pageRows = toolRows.slice(0, size);
      const tool_ids = [...new Set(pageRows.map(row => row.tool_id))];
      const last = pageRows.at(-1);
      const next = hasMore ? { phase: 'tools', tool_id: last.tool_id, held_by: last.held_by } : null;
      return { restart: false, revision: current, unread: [], tool_ids, cursor: { revision: current, after: next ? JSON.stringify(next) : null }, complete: !hasMore };
    },
    /** One bounded physical page; ids are distinct across its cursor chain. */
    servingPage,
    /** Full matching-job compatibility ABI, O(all selected holders/output).
     * Every SQL materialization is bounded; this complete output deliberately
     * takes as many pages as the job has. It hydrates no unrelated catalogue.
     */
    serving(job) {
      const ids = []; let after = null;
      for (;;) {
        const page = servingPage(job, { after }); ids.push(...page.ids);
        if (page.complete) return ids;
        after = page.next_after;
      }
    },
  };
}

/**
 * The paged list of the tools an account has that serve `job`: the encoder catalogue (src/meaning-sets.mjs reads one page
 * per wake). A call answers one bounded page of the shipped tools, then of the index's unread descriptors, then of its
 * serving IDs, and hands back the cursor the next call continues from.
 * index: () → the job-tool index (jobToolsIndex); shipped: () → { tools } of the shipped Workshop rows;
 * descriptors: ids → the tool rows (null where one cannot be read yet).
 * An unread descriptor that cannot be read stays unread and retryable. Its page reports `pending` with the cursor moved
 * past it, so no unresolved descriptor holds back the tools after it; the caller finishes a pass before it trusts it.
 */
export function makeToolListing({ index, shipped, descriptors }) {
  // Descriptors read on this catalogue revision, one page's worth; a catalogue write or a new revision drops them all.
  let known = null;
  const knownOf = revision => {
    if (known?.revision !== revision) known = { revision, rows: new Map() };
    return known;
  };
  return {
    /** Drops the cached descriptors, after a saved tool or an install changes which tools serve a job. */
    forget() { known = null; },
    async page(job, { after = null, revision = null, limit = TOOL_CATALOG_PAGE_SIZE } = {}) {
      const size = Math.max(1, Math.min(TOOL_CATALOG_PAGE_SIZE, Number.isInteger(limit) ? limit : TOOL_CATALOG_PAGE_SIZE));
      const currentRevision = String(index().revision());
      let position = { source: 'shipped', offset: 0, after: null };
      if (after !== null) {
        try {
          position = typeof after === 'string' ? JSON.parse(after) : after;
          if (position?.source !== 'shipped' && position?.source !== 'index') throw new Error('bad cursor');
        } catch {
          return { tools: [], cursor: { after: null, revision: currentRevision }, complete: false, restart: true };
        }
      }
      if (revision !== null && String(revision) !== currentRevision) {
        return { tools: [], cursor: { after: null, revision: currentRevision }, complete: false, restart: true };
      }
      const shippedTools = await shipped();
      if (String(index().revision()) !== currentRevision) {
        return { tools: [], cursor: { after: null, revision: String(index().revision()) }, complete: false, restart: true };
      }
      const shippedRows = toolsServing(job, { has: () => true }, shippedTools.tools ?? []);
      const shippedIds = new Set(shippedRows.map(tool => tool.id));
      if (position.source === 'shipped') {
        const offset = Number.isInteger(position.offset) && position.offset >= 0 ? position.offset : 0;
        const tools = shippedRows.slice(offset, offset + size);
        const nextOffset = offset + tools.length;
        const next = nextOffset < shippedRows.length
          ? { source: 'shipped', offset: nextOffset, after: null }
          : { source: 'index', after: null };
        return { tools, cursor: { after: JSON.stringify(next), revision: currentRevision }, complete: false, restart: false };
      }

      const catalog = index().catalogPage(job, { after: position.after ?? null, revision: currentRevision, limit: size });
      const cursor = { after: catalog.cursor.after === null ? null : JSON.stringify({ source: 'index', after: catalog.cursor.after }), revision: String(catalog.revision) };
      if (catalog.restart) return { tools: [], cursor: { after: null, revision: String(catalog.revision) }, complete: false, restart: true };

      // Cache only one page's worth of successful descriptors. A catalogue write invalidates them all, and an awaited read
      // cannot refill a catalogue that changed while it waited.
      const read = async ids => {
        const cache = knownOf(currentRevision);
        const missing = ids.filter(id => !cache.rows.has(id));
        const found = missing.length ? await descriptors(missing) : [];
        if (String(index().revision()) !== currentRevision) return [];
        missing.forEach((id, at) => { if (found[at]?.id === id) cache.rows.set(id, found[at]); });
        const answer = ids.map(id => cache.rows.get(id) ?? null);
        for (const id of ids) {
          const row = cache.rows.get(id);
          if (row) { cache.rows.delete(id); cache.rows.set(id, row); }
        }
        while (cache.rows.size > TOOL_CATALOG_PAGE_SIZE) cache.rows.delete(cache.rows.keys().next().value);
        return answer;
      };
      let rows = [];
      if (catalog.unread.length) {
        const ids = [...new Set(catalog.unread.map(row => row.tool_id))];
        rows = await read(ids);
        if (String(index().revision()) !== currentRevision) {
          return { tools: [], cursor: { after: null, revision: String(index().revision()) }, complete: false, restart: true };
        }
        const byId = new Map(ids.map((id, at) => [id, rows[at] ?? null]));
        let failed = false;
        for (const unread of catalog.unread) {
          const descriptor = byId.get(unread.tool_id);
          index().read(unread.tool_id, unread.held_by, descriptor ? (descriptor.serves ?? []) : null);
          if (!descriptor) failed = true;
        }
        if (failed) return { tools: [], cursor, complete: false, pending: true };
        rows = [...byId.values()].filter(Boolean);
      } else if (catalog.tool_ids.length) {
        rows = await read(catalog.tool_ids);
        if (String(index().revision()) !== currentRevision) {
          return { tools: [], cursor: { after: null, revision: String(index().revision()) }, complete: false, restart: true };
        }
        if (catalog.tool_ids.some((id, at) => !rows[at])) return { tools: [], cursor, complete: false, pending: true };
        rows = rows.filter(Boolean);
      }

      const tools = toolsServing(job, { has: () => true }, rows).filter(tool => !shippedIds.has(tool.id));
      // A pass is complete only when no installed descriptor is still unread: an unreadable one is listed by a later pass.
      return { tools, cursor, complete: catalog.complete && index().unread(1).length === 0, restart: false };
    },
  };
}
