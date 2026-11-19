// tools/read-a-list-view/test/support/stored.mjs
//
// Made-up bakery data for the list reader's tests: the records a caller would hand in as `stored`, a folder of recipe
// documents on disk (the documents folder function reads it for real), and the store's own answer to a keep, which
// refuses a row whose expected record has moved, as a real store does.
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const NAMES = { list_type: 'list', list_record: 'list:{list_id}', row_type: 'record:{row_type}', view_type: 'list-view' };

/** A list of chores over the given sources, with its fields. */
export const choresList = (sources, extra = {}) => ({ label: 'Chores', row_type: 'chore', title_field: 'chore',
  fields: [{ id: 'chore', kind: 'text' }, { id: 'minutes', kind: 'number' }], row_sources: sources, ...extra });

/** Records as the caller hands them in: { records: [{ id, type, value }] }. */
export const storedOf = (records, extra = {}) => ({ records: records.map(([id, type, value]) => ({ id, type, value })), ...extra });

/** A folder of recipe documents with frontmatter, written under a new temp folder: { root, write(name, text) }. */
export async function recipesFolder(files = {}) {
  const root = await mkdtemp(join(tmpdir(), 'rlv-recipes-'));
  const write = async (name, text) => {
    const at = join(root, name);
    await mkdir(join(at, '..'), { recursive: true });
    await writeFile(at, text);
  };
  for (const [name, text] of Object.entries(files)) await write(name, text);
  return { root, write };
}

/** A recipe document: frontmatter chore and minutes, then its text. */
export const recipe = (chore, minutes, body = `bake ${chore} text\n`) => `---\nchore: bake ${chore}\nminutes: ${minutes}\n---\n${body}`;

/**
 * The store's answer to a run's keep rows: each row applies only when its expected record is still the one the store
 * holds (null for a record it did not hold). A moved record is refused, and the refusal is an Error with its id.
 */
export function storeAfter(records, keep) {
  const held = new Map(records.map(record => [record.id, record]));
  for (const row of keep) {
    const now = held.get(row.id) ?? null;
    const expectedValue = row.expected === null ? null : row.expected.value;
    const same = JSON.stringify(now?.value ?? null) === JSON.stringify(expectedValue);
    if (!same) throw Object.assign(new Error(`the store moved ${row.id}`), { code: 'expected_mismatch', id: row.id });
    if (row.value === null) held.delete(row.id);
    else held.set(row.id, { id: row.id, type: row.type, value: row.value });
  }
  return [...held.values()];
}

