// packages/group/do-work/board-csv-import.ts
//
// Board CSV IMPORT — the inverse of the CSV export (do-work/board-csv): paste a spreadsheet of goals and
// drop them onto the board as cards. Closes the CSV round-trip (export cards → edit in a spreadsheet →
// paste back). A pure leaf (zero I/O, zero DOM): parse RFC-4180 text → `BoardItemDraft[]`, mapping the
// export's columns back to the card's real DATA fields via the SAME raw shapes the readers expect
// (`extra.dueDate` epoch-ms, `extra.metric` {current,target}, `extra.tags` string[]).
//
// Columns are matched BY HEADER NAME (not position), so a reordered/extra-column spreadsheet still imports.
// Only the faithfully-invertible columns are mapped: Title, Due, Progress %, Tags. The exported "Checklist
// Done/Total" counts are DELIBERATELY not reconstructed — bare counts can't recover a real checklist's step
// TEXT, and inventing placeholder steps would be fabricated content (L117); the card's completion still
// round-trips because Progress % already captures it as a metric.

import type { BoardItemDraft } from '../show/item-add-strategies';

/** Max cards one CSV paste can mint — a runaway paste is capped, never freezes the board. */
export const MAX_CSV_ROWS = 500;
/** Per-title clamp + per-card tag cap (mirrors the tag write-path bound). */
const MAX_TITLE_LEN = 2000;
const MAX_TAGS = 24;

/**
 * Parse RFC-4180 CSV text into rows of string cells. Handles quoted fields (embedded commas, quotes via
 * `""`, and newlines), CRLF or LF line endings, and a missing trailing newline. Pure state machine.
 */
export function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let sawField = false; // did this row have any cell content/commas? (distinguishes a real row from a blank line)

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; continue; } // escaped quote
        inQuotes = false;
        continue;
      }
      field += ch;
      continue;
    }
    if (ch === '"') { inQuotes = true; sawField = true; continue; }
    if (ch === ',') { row.push(field); field = ''; sawField = true; continue; }
    if (ch === '\r') continue; // CRLF: ignore CR, LF ends the row
    if (ch === '\n') {
      if (sawField || field.length > 0) { row.push(field); rows.push(row); }
      row = []; field = ''; sawField = false;
      continue;
    }
    field += ch;
    sawField = true;
  }
  if (sawField || field.length > 0) { row.push(field); rows.push(row); } // flush the last (newline-less) row
  return rows;
}

/** A YYYY-MM-DD date → UTC epoch-ms (locale-free, the exact inverse of `dueMsToDateLabel`), else null. */
function parseDateMs(cell: string | undefined): number | null {
  const m = (cell ?? '').trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isInteger(ms) && ms > 0 ? ms : null;
}

/** A bare progress number (the export writes `80`, not `80%`) → a finite non-negative number, else null. */
function parsePct(cell: string | undefined): number | null {
  const raw = (cell ?? '').trim().replace(/%$/, ''); // tolerate a stray "%" a hand-editor may add
  if (raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** True iff the text is our CSV shape: a header row that names a `Title` column (conservative — a plain
 *  brain-dump or a Title-less spreadsheet is NOT hijacked). */
export function looksLikeCsv(text: string): boolean {
  const firstLine = text.split(/\r?\n/).find((l) => l.trim().length > 0) ?? '';
  if (!firstLine.includes(',')) return false;
  const header = parseCsvRows(firstLine)[0] ?? [];
  return header.length >= 2 && header.some((c) => c.trim().toLowerCase() === 'title');
}

/**
 * Parse a CSV export back into board card drafts. Maps Title → text, Due → `extra.dueDate` (epoch-ms),
 * Progress % → `extra.metric` {current, target:100}, Tags (`;`-separated) → `extra.tags`. Columns are
 * located by header name; a row with a blank Title is skipped; total rows are capped. Pure + deterministic.
 * Returns `[]` when the text is not a titled CSV (the caller falls through to plain paste).
 */
export function csvToDrafts(text: string): BoardItemDraft[] {
  const rows = parseCsvRows(text);
  if (rows.length < 2) return []; // need a header + at least one data row
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const col = (name: string): number => header.indexOf(name);
  const iTitle = col('title');
  if (iTitle < 0) return []; // not our CSV shape
  const iDue = col('due');
  const iProg = col('progress %');
  const iTags = col('tags');

  const drafts: BoardItemDraft[] = [];
  for (let r = 1; r < rows.length && drafts.length < MAX_CSV_ROWS; r += 1) {
    const cells = rows[r];
    const title = (cells[iTitle] ?? '').trim();
    if (title === '') continue; // no title → not a goal row

    const extra: Record<string, unknown> = {};
    if (iDue >= 0) {
      const ms = parseDateMs(cells[iDue]);
      if (ms !== null) extra.dueDate = ms;
    }
    if (iProg >= 0) {
      const pct = parsePct(cells[iProg]);
      if (pct !== null) extra.metric = { current: pct, target: 100 };
    }
    if (iTags >= 0) {
      const tags = (cells[iTags] ?? '').split(';').map((t) => t.trim()).filter((t) => t.length > 0).slice(0, MAX_TAGS);
      if (tags.length > 0) extra.tags = tags;
    }

    drafts.push({ kind: 'note', text: title.slice(0, MAX_TITLE_LEN), ...(Object.keys(extra).length > 0 ? { extra } : {}) });
  }
  return drafts;
}
