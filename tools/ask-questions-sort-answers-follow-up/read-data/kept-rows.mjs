// tools/ask-questions-sort-answers-follow-up/read-data/kept-rows.mjs
//
// How the form tools reach their rows in the person's own Postgres: one table per kind (data/record-tables.json, made by sql/),
// each row `id`, `value` jsonb and the filter columns its table generates from the value (form_id, respondent_id). The tools are
// handed `sql(text, values) -> rows` by tools/workflows/do-work/run-with-sql.mjs.
//
//   readRows(sql, kind, { id?, formId?, respondentId? })   the rows of one kind as { id, type, value }, by id order
//   keepRows(sql, rows)                                     rows as { id, type, value }, kept (replaced when the id is there), all or none
import { readFileSync } from 'node:fs';
import { identifier } from '../../workflows/read-data/sql.mjs';

const TABLES = JSON.parse(readFileSync(new URL('../data/record-tables.json', import.meta.url), 'utf8')).tables;

const tableOf = kind => {
  if (!Object.hasOwn(TABLES, kind)) throw new Error(`No table keeps rows of kind ${kind}.`);
  return identifier(TABLES[kind]);
};

export async function readRows(sql, kind, { id, formId, respondentId } = {}) {
  const wheres = [];
  const values = [];
  for (const [column, value] of [['id', id], ['form_id', formId], ['respondent_id', respondentId]]) {
    if (value === undefined) continue;
    values.push(value);
    wheres.push(`${column} = $${values.length}`);
  }
  const rows = await sql(`select id, value from ${tableOf(kind)}${wheres.length ? ` where ${wheres.join(' and ')}` : ''} order by id`, values);
  return rows.map(row => ({ id: row.id, type: kind, value: row.value }));
}

export async function keepRows(sql, rows) {
  const byKind = new Map();
  for (const row of rows) byKind.set(row.type, [...(byKind.get(row.type) ?? []), row]);
  await sql('begin');
  try {
    for (const [kind, kept] of byKind) {
      await sql(`insert into ${tableOf(kind)} (id, value) select * from unnest($1::text[], $2::jsonb[]) on conflict (id) do update set value = excluded.value, updated_at = now()`, [kept.map(row => row.id), kept.map(row => JSON.stringify(row.value))]);
    }
    await sql('commit');
  } catch (error) {
    await sql('rollback').catch(() => {});
    throw error;
  }
}
