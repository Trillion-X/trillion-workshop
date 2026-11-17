// A made-up tool module for test/run-with-sql-own-tables.test.mjs: it writes one row to a table its own sql/ makes and counts them.
export async function countWidgets({ input }, { sql }) {
  await sql('insert into widget (id, value) values ($1, $2::jsonb) on conflict (id) do nothing', [input.id, JSON.stringify({ id: input.id })]);
  const [{ n }] = await sql('select count(*)::int as n from widget');
  return { n };
}
