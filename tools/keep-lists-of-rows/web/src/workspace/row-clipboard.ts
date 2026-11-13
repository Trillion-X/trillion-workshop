// src/workspace/row-clipboard.ts
//
// PURPOSE
//   List rows on the clipboard. Copying rows writes them whole under Trillion's own type (their list, ids, values and the
//   fields' kinds) beside the forms every other app reads (tab-separated text, a table, a markdown table); pasting into a
//   list reads Trillion's own rows first, then a table from another editor or a spreadsheet, and says what the paste can
//   become: rows linked where they are, or rows copied in (row-clipboard.json).
//
// NON-NEGOTIABLE INVARIANTS
//   1. Nothing here names a list, a field or a kind: fields are matched by id, then by label; links by `links_to`.
//   2. A paste never writes by itself: `pastePlan` answers what it would do; the screen runs it through the lists routes
//      (the same ones the person's AI uses), so every paste is a list write with its refusals.
//   3. The clipboard's table is built as elements holding inert text (textContent), never from markup strings; nothing
//      pasted is ever run.

import settings from './row-clipboard.json' with { type: 'json' };
import { tableRows } from '../../parts/documents/read-data/paste-sources';

export type ClipField = { id: string; label: string; kind: string; links_to?: string };
export type ClipRow = { id: string; title: string | null; values: Record<string, unknown> };
export type CopiedRows = { version: number; list_id: string; list_label: string; fields: ClipField[]; rows: ClipRow[] };
export type PastedRows = { from: 'trillion'; copied: CopiedRows } | { from: 'table'; header: string[]; rows: string[][] };
/** What a paste into a list can become: copied rows (duplicate route), linked rows (rows route), or rows from a table. */
export type PastePlan =
  | { kind: 'same-list'; duplicate: { row_ids: string[] } }
  | { kind: 'other-list'; copy: { from_list: string; row_ids: string[]; to_list: string; map: Record<string, string> }; link: { rows: { values: Record<string, unknown> }[] } | null }
  | { kind: 'table'; rows: { values: Record<string, unknown> }[] };

const words = (value: unknown): string => (Array.isArray(value) ? value.join(', ') : value === null || value === undefined ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value));
const cell = (text: string) => text.replace(/[\t\n\r]+/g, ' ');

// The table other apps read, as elements holding text: its outer form is what text/html carries (invariant 3).
function tableOf(header: string[], lines: string[][]): string {
  const table = document.createElement('table');
  const row = (texts: string[], tag: 'th' | 'td') => {
    const line = document.createElement('tr');
    for (const text of texts) { const one = document.createElement(tag); one.textContent = text; line.append(one); }
    return line;
  };
  const head = document.createElement('thead');
  head.append(row(header, 'th'));
  const body = document.createElement('tbody');
  body.append(...lines.map(texts => row(texts, 'td')));
  table.append(head, body);
  return table.outerHTML;
}

/** Writes rows to a copy event's clipboard in every form (invariant 3). */
export function copyRows(clipboard: DataTransfer, copied: Omit<CopiedRows, 'version'>): void {
  const header = copied.fields.map(field => field.label);
  const lines = copied.rows.map(row => copied.fields.map(field => cell(words(row.values[field.id]))));
  clipboard.setData(settings.type, JSON.stringify({ version: settings.version, ...copied }));
  clipboard.setData('text/plain', [header, ...lines].map(line => line.join('\t')).join('\n'));
  clipboard.setData('text/markdown', [`| ${header.join(' | ')} |`, `| ${header.map(() => '---').join(' | ')} |`, ...lines.map(line => `| ${line.map(text => text.replace(/\|/g, '\\|')).join(' | ')} |`)].join('\n'));
  clipboard.setData('text/html', tableOf(header, lines));
}

/** What a paste event carries as rows: Trillion's own rows, else a table, else null. */
export function readPastedRows(clipboard: DataTransfer): PastedRows | null {
  const own = clipboard.getData(settings.type);
  if (own) {
    try {
      const copied = JSON.parse(own) as CopiedRows;
      if (copied?.version === settings.version && typeof copied.list_id === 'string' && Array.isArray(copied.rows) && Array.isArray(copied.fields)) return { from: 'trillion', copied };
    } catch { /* a damaged copy is read as whatever else the clipboard holds */ }
  }
  const html = clipboard.getData('text/html');
  const plain = clipboard.getData('text/plain');
  const table = (html ? tableRows(html) : null) ?? (plain.includes('\t') ? plain.split(/\r?\n/).filter(line => line.trim()).map(line => line.split('\t').map(text => text.trim())) : null);
  return table && table.length > 1 ? { from: 'table', header: table[0], rows: table.slice(1) } : null;
}

/** What pasting `pasted` into `list` would do (invariants 1 and 2). `typed(field, words)` is what typed words become for
 *  a field's kind, as the screen types an edited cell. */
export function pastePlan(pasted: PastedRows, list: { id: string; title_field: string | null; fields: ClipField[] }, typed: (field: ClipField, text: string) => unknown): PastePlan | null {
  const fieldFor = (source: { id?: string; label: string }) => list.fields.find(field => field.id === source.id) ?? list.fields.find(field => field.label.toLocaleLowerCase() === source.label.toLocaleLowerCase()) ?? null;
  if (pasted.from === 'table') {
    const fields = pasted.header.map(label => fieldFor({ label }));
    if (!fields.some(Boolean)) return null;
    const rows = pasted.rows.map(line => ({ values: Object.fromEntries(fields.flatMap((field, index) => (field && line[index] ? [[field.id, typed(field, line[index])]] : []))) })).filter(row => Object.keys(row.values).length);
    return rows.length ? { kind: 'table', rows } : null;
  }
  const { copied } = pasted;
  const row_ids = copied.rows.map(row => row.id);
  if (copied.list_id === list.id) return { kind: 'same-list', duplicate: { row_ids } };
  const map = Object.fromEntries(copied.fields.flatMap(source => { const field = fieldFor(source); return field ? [[field.id, source.id]] : []; }));
  const linkField = list.fields.find(field => field.links_to === copied.list_id);
  const link = linkField ? { rows: copied.rows.map(row => ({ values: { [linkField.id]: [row.id], ...(list.title_field && list.title_field !== linkField.id ? { [list.title_field]: row.title ?? row.id } : {}) } })) } : null;
  return { kind: 'other-list', copy: { from_list: copied.list_id, row_ids, to_list: list.id, map }, link };
}

/** A word of row-clipboard.json filled with its values. */
export const clipboardWords = (key: keyof typeof settings.words, values: Record<string, string | number> = {}): string =>
  settings.words[key].replace(/\{([a-z_]+)\}/g, (_, name: string) => String(values[name] ?? ''));
