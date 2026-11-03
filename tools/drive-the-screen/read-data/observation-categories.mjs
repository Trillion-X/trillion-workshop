// tools/drive-the-screen/read-data/observation-categories.mjs (moved from Trillion-X/trillion computer/observation-categories.mjs)
//
// Purpose: lets the Mac reader's observation rules (tools/drive-the-screen/read-data/observation-rules.mjs) name a whole kind of website (a
// category) instead of listing every domain. A table of domain -> category is kept current by cursor-paged diffs with
// tombstones, and the rules' category rows become website rows at the moment of the verdict.
//
// Non-negotiable invariants
//   1. The seed table, the category modes, the source and the bounds are DATA (tools/drive-the-screen/read-data/observation-categories.json).
//      Out of the box the table is empty and no mode is set, so nothing is limited.
//   2. A diff page is applied whole or not at all: upserts replace by domain, tombstones remove, and the cursor moves to
//      the page's next_cursor only after the page is applied. A page that is not an object with arrays is refused.
//   3. Sync stops at most_pages pages or most_rows rows and keeps what it applied, so the next sync continues from the
//      cursor; a failed page leaves the table and cursor as the last applied page left them.
//   4. A block mode on a category wins over an allow mode on the same category, as block rows do in the rules.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const categorySettings = () => JSON.parse(readFileSync(join(HERE, 'observation-categories.json'), 'utf8'));
const lower = value => String(value ?? '').toLowerCase().trim();

/** The table after one diff page: { cursor, rows }. Throws a plain message for a page that cannot be applied. */
export function applyCategoryDiff(table, page) {
  if (!page || typeof page !== 'object' || (page.rows !== undefined && !Array.isArray(page.rows)) || (page.tombstones !== undefined && !Array.isArray(page.tombstones))) {
    throw new Error('A category diff page is { rows: [{ domain, category }], tombstones: [domain], next_cursor }.');
  }
  const byDomain = new Map((table?.rows ?? []).map(row => [lower(row.domain), row.category]));
  for (const row of page.rows ?? []) {
    if (typeof row?.domain !== 'string' || !row.domain.trim() || typeof row?.category !== 'string' || !row.category.trim()) throw new Error('Each category row needs a domain and a category.');
    byDomain.set(lower(row.domain), row.category.trim());
  }
  for (const domain of page.tombstones ?? []) byDomain.delete(lower(domain));
  return { cursor: page.next_cursor ?? table?.cursor ?? null, rows: [...byDomain].map(([domain, category]) => ({ domain, category })) };
}

/** The rules with a website row for every domain in a category whose mode is set. The table is read, never changed. */
export function withCategories(rules, table, modes) {
  const mode = new Map();
  for (const row of modes ?? []) if (!(mode.get(row.category) === 'block')) mode.set(row.category, row.mode);
  const derived = (table?.rows ?? []).filter(row => mode.has(row.category)).map(row => ({ domain: row.domain, mode: mode.get(row.category) }));
  return derived.length ? { ...rules, websites: [...(rules.websites ?? []), ...derived] } : rules;
}

const stateFile = (settings, home) => join(home, '.trillion', 'computer-sources', settings.sync.state_file);
/** The table in force: the synced one when it was kept, else the seed. */
export function loadCategoryTable(settings = categorySettings(), home = homedir()) {
  try { const kept = JSON.parse(readFileSync(stateFile(settings, home), 'utf8')); if (Array.isArray(kept?.rows)) return kept; } catch { /* no synced table yet */ }
  return settings.table;
}

/** Fetches diff pages from the source and keeps the table. → { table, pages, applied, more } ; a null source fetches nothing. */
export async function syncCategories({ settings = categorySettings(), home = homedir(), fetchPage }) {
  let table = loadCategoryTable(settings, home);
  if (!settings.sync.source) return { table, pages: 0, applied: 0, more: false };
  let pages = 0, applied = 0, more = true;
  while (more && pages < settings.sync.most_pages && table.rows.length < settings.sync.most_rows) {
    const page = await fetchPage(settings.sync.source, table.cursor);
    table = applyCategoryDiff(table, page);
    pages += 1; applied += (page.rows?.length ?? 0) + (page.tombstones?.length ?? 0);
    more = page.has_more === true;
    const file = stateFile(settings, home);
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(`${file}.tmp`, JSON.stringify(table), { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
  }
  return { table, pages, applied, more };
}
