// tools/research-a-creator-or-topic/do-work/keep-a-creators-rows.mjs
//
// Keeps the rows pull-in-a-creator.mjs wrote ({table, row} per line) in the person's own database, in the schema that
// holds the library tables. A row whose id is there is updated (a value it leaves empty keeps the old one); a new id is
// inserted. 500 rows per statement, one transaction per file. The connection address is read from standard input, so
// it is never on the command line.
//
//   <connection address> | node keep-a-creators-rows.mjs --schema old_store FILE.jsonl...
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const argv = process.argv.slice(2);
const schema = argv[0] === '--schema' ? argv[1] : 'old_store';
const files = argv[0] === '--schema' ? argv.slice(2) : argv;
if (!/^[a-z_][a-z0-9_]*$/.test(schema) || !files.length) { console.error('usage: --schema NAME FILE.jsonl...'); process.exit(2); }
const require = createRequire(new URL('../../run-sql-in-my-database/index.js', import.meta.url));
const pg = require('pg');
const client = new pg.Client({ connectionString: readFileSync(0, 'utf8').trim(), statement_timeout: 120_000 });
await client.connect();
const columns = {};
try {
  for (const file of files) {
    const byTable = {};
    for (const line of readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
      const { table, row } = JSON.parse(line);
      if (!/^[a-z_][a-z0-9_]*$/.test(table)) throw new Error(`not a table name: ${table}`);
      (byTable[table] ??= new Map()).set(row.id, row);
    }
    await client.query('begin');
    for (const [table, rows] of Object.entries(byTable)) {
      columns[table] ??= (await client.query("select column_name from information_schema.columns where table_schema = $1 and table_name = $2 and column_name <> 'id'", [schema, table])).rows.map(r => r.column_name);
      const set = columns[table].map(name => `"${name}" = coalesce(n."${name}", t."${name}")`).join(', ');
      const list = [...rows.values()];
      for (let i = 0; i < list.length; i += 500) {
        const part = JSON.stringify(list.slice(i, i + 500));
        const updated = await client.query(`update ${schema}.${table} t set ${set} from jsonb_populate_recordset(null::${schema}.${table}, $1::jsonb) n where t.id = n.id`, [part]);
        const inserted = await client.query(`insert into ${schema}.${table} select n.* from jsonb_populate_recordset(null::${schema}.${table}, $1::jsonb) n where not exists (select 1 from ${schema}.${table} t where t.id = n.id)`, [part]);
        console.log(JSON.stringify({ file, table, updated: updated.rowCount, inserted: inserted.rowCount }));
      }
    }
    await client.query('commit');
  }
} catch (error) { await client.query('rollback').catch(() => {}); console.error(error.message); process.exitCode = 1; }
finally { await client.end(); }
