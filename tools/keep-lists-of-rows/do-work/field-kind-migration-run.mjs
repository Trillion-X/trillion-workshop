// tools/keep-lists-of-rows/do-work/field-kind-migration-run.mjs
//
// PURPOSE
//   Runs the field-kind migration against one account through its records door, in three steps: `copy` writes a set of
//   list definitions and their rows into the account; `dry-run` plans the migration over what the account holds and
//   writes nothing; `apply` writes each planned row through the door and reads it back. Each step prints one JSON
//   report on stdout. The data comes from files named on the command line; nothing in this file names a person's data.
//
// USAGE
//   node do-work/field-kind-migration-run.mjs copy     --door URL --key-file FILE --source FILE
//   node do-work/field-kind-migration-run.mjs dry-run  --door URL --key-file FILE --primitives FILE
//   node do-work/field-kind-migration-run.mjs apply    --door URL --key-file FILE --primitives FILE --report FILE
//   URL is the account's MCP address (`http://127.0.0.1:PORT/a/ADDRESS/mcp`); FILE holds one bearer key on its first line.
//   SOURCE is the JSON `{ lists: [...], rows: [...] }` the copy step writes (lists as the door returns them, rows
//   with their record id, type and value).
//
// NON-NEGOTIABLE INVARIANTS
//   1. The key is read from its file and sent only as a bearer header. It is never printed or logged.
//   2. Every write is one `records:write` with a request key that is unique to that call; a retry of the same call
//      reuses the key.
//   3. `apply` writes a row's whole value: the row's other fields come back unchanged, and only migrated fields change.
//   4. The readback is compared field by field with the projection; a field that differs is reported, not counted.

import { appendFileSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { planMigration } from './field-kind-migration.mjs';

const args = parseArgs(process.argv.slice(2));

async function main() {
  const [step] = args._;
  if (step === 'copy') return copy();
  if (step === 'dry-run') return dryRun();
  if (step === 'apply') return apply();
  throw new Error('usage: copy | dry-run | apply (see the file header)');
}

function parseArgs(list) {
  const out = { _: [] };
  for (let i = 0; i < list.length; i += 1) {
    if (list[i].startsWith('--')) {
      out[list[i].slice(2)] = list[i + 1];
      i += 1;
    } else {
      out._.push(list[i]);
    }
  }
  return out;
}

function keyOf(path) {
  return readFileSync(path, 'utf8').split('\n')[0].trim();
}

/** One records door call through the account's MCP route. Throws naming the door's refusal code. */
async function door(method, input, requestKey = randomUUID()) {
  // The door answers selected_owner_unavailable while the account's owner is busy or restarting; the same call is retried
  // with the same request key, so a write that did land is not repeated as a new one.
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await doorOnce(method, input, requestKey);
    } catch (error) {
      if (!error.message.includes('selected_owner_unavailable') || attempt >= 6) throw error;
      await new Promise(done => setTimeout(done, 5000 * attempt));
    }
  }
}

async function doorOnce(method, input, requestKey) {
  const response = await fetch(args.door, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${keyOf(args['key-file'])}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'do_one_thing_in_my_account', arguments: { address: '@own-records', method, request_key: requestKey, input } },
    }),
  });
  const body = await response.json();
  if (body.result?.isError) {
    throw new Error(`records door refused ${method}: ${body.result.structuredContent?.code ?? 'unknown'}`);
  }
  return body.result.structuredContent;
}

async function copy() {
  const source = JSON.parse(readFileSync(args.source, 'utf8'));
  const listRecords = source.lists.map(list => ({ id: list.id, type: 'list', value: list.value }));
  const rowRecords = source.rows.map(row => ({ id: row.id, type: row.type, value: row.value }));
  const all = [...listRecords, ...rowRecords];
  const refused = [];
  for (let start = 0; start < all.length; start += 100) {
    const batch = all.slice(start, start + 100);
    try {
      await door('records:write', { records: batch });
    } catch {
      // A refused batch is written one record at a time, so one refused value does not hold back the rest.
      for (const record of batch) {
        try {
          await door('records:write', { records: [record] });
        } catch (error) {
          refused.push({ id: record.id, reason: error.message });
        }
      }
    }
  }
  console.log(JSON.stringify({ step: 'copy', lists: listRecords.length, rows: rowRecords.length, refused }));
}

/** Lists and rows as the planner reads them: each row names its list by its record type. */
async function loadAccount() {
  const lists = await listAll('list');
  const listByType = new Map(lists.map(list => [list.value.row_type, list]));
  const rowRecords = [];
  for (const list of lists) {
    rowRecords.push(...(await listAll(`record:${list.value.row_type}`)).map(row => ({ ...row, list_id: list.id })));
  }
  const rows = rowRecords.map(record => ({ id: record.id, list_id: record.list_id, values: record.value }));
  return { lists: lists.map(list => ({ id: list.id, label: list.value.label, fields: list.value.fields })), rows, listByType };
}

async function listAll(type) {
  const records = [];
  let after = null;
  let pageRecords = [];
  do {
    const page = await door('records:list', { type, limit: 500, ...(after ? { after } : {}) });
    pageRecords = page.records ?? [];
    records.push(...pageRecords);
    after = page.next ?? null;
  } while (after && pageRecords.length > 0);
  return records;
}

async function dryRun() {
  const primitives = JSON.parse(readFileSync(args.primitives, 'utf8'));
  const account = await loadAccount();
  const refusals = [];
  const fieldPlan = planMigration({ lists: account.lists, rows: [], primitives }).fields;
  let rowsPlanned = 0;
  for (const row of account.rows) {
    try {
      planMigration({ lists: account.lists, rows: [row], primitives });
      rowsPlanned += 1;
    } catch (error) {
      refusals.push({ row_id: row.id, reason: error.message });
    }
  }
  console.log(JSON.stringify({ step: 'dry-run', fields: fieldPlan, rows: account.rows.length, rows_planned: rowsPlanned, refusals, writes_made: 0 }, null, 2));
}

async function apply() {
  const primitives = JSON.parse(readFileSync(args.primitives, 'utf8'));
  const skipped = new Set(args.skip ? JSON.parse(readFileSync(args.skip, 'utf8')) : []);
  const lists = await listAll('list');
  // Each list is planned, written and read back on its own, and its line is appended to the report as it finishes,
  // so a run that stops early still leaves each finished list's matched-over-total.
  for (const list of lists) {
    const label = { id: list.id, label: list.value.label, fields: list.value.fields };
    const type = `record:${list.value.row_type}`;
    const current = await listAll(type);
    const rows = [];
    const unplanned = [];
    for (const record of current) {
      if (skipped.has(record.id)) continue;
      try {
        planMigration({ lists: [label], rows: [{ id: record.id, list_id: list.id, values: record.value }], primitives });
        rows.push({ id: record.id, list_id: list.id, values: record.value });
      } catch (error) {
        unplanned.push({ row_id: record.id, reason: error.message.slice(0, 160) });
      }
    }
    const plan = planMigration({ lists: [label], rows, primitives });
    const records = plan.rows.map(row => ({ id: row.row_id, type, value: { ...current.find(r => r.id === row.row_id).value, ...row.projected } }));
    const refused = [];
    for (let start = 0; start < records.length; start += 100) {
      const batch = records.slice(start, start + 100);
      try {
        await door('records:write', { records: batch });
      } catch {
        for (const record of batch) {
          try {
            await door('records:write', { records: [record] });
          } catch (error) {
            refused.push({ row_id: record.id, reason: error.message });
          }
        }
      }
    }
    const back = new Map((await listAll(type)).map(record => [record.id, record.value]));
    let matched = 0;
    const mismatches = [];
    for (const row of plan.rows) {
      if (refused.some(r => r.row_id === row.row_id)) continue;
      const expected = { ...current.find(r => r.id === row.row_id).value, ...row.projected };
      if (JSON.stringify(back.get(row.row_id)) === JSON.stringify(expected)) matched += 1;
      else mismatches.push(row.row_id);
    }
    const line = {
      list_id: list.id,
      rows_in_account: current.length,
      rows_total: plan.rows.length,
      rows_matched: matched,
      rows_left_as_they_are: unplanned.length,
      rows_refused_by_door: refused.length,
      mismatches: mismatches.length,
      first_left_reason: unplanned[0]?.reason ?? null,
    };
    appendFileSync(args.report, JSON.stringify(line) + '\n');
    console.log(JSON.stringify(line));
  }
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});

