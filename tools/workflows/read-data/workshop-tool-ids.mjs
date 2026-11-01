// tools/workflows/read-data/workshop-tool-ids.mjs
//
// The id of every tool the Workshop offers, read the way test/every-tool-row.test.mjs reads the rows: each
// tools/<folder>/tool-rows.json, plus the rows a tool-row-source there lists from a records file or a folder of them.
// `recipeToolGaps` (recipe-problems.mjs) checks a recipe's tool ids against this list and the host's own tools.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const json = path => JSON.parse(readFileSync(path, 'utf8'));
const disk = { exists: existsSync, directory: path => statSync(path).isDirectory(), entries: path => readdirSync(path, { withFileTypes: true }), json };

function listedRows(tools, source, reader) {
  const { package: folder, kind, file = 'records.json' } = source.list.records;
  const path = join(tools, folder, file);
  const files = reader.directory(path) ? reader.entries(path).map(entry => entry.name).filter(name => name.endsWith('.json')).map(name => join(path, name)) : [path];
  return files.flatMap(one => { const kept = reader.json(one); return kept.things ?? kept.records ?? []; }).map(thing => thing.payload).filter(payload => payload?.kind === kind);
}

// Every row the tool folders hold, as { folder, payload }: each tools/<folder>/tool-rows.json, and the rows a tool-row-source
// there lists (the listed rows belong to the folder that lists them).
export function workshopRows(tools, reader = disk) {
  const rows = [];
  for (const folder of reader.entries(tools).filter(entry => entry.isDirectory()).map(entry => entry.name)) {
    const file = join(tools, folder, 'tool-rows.json');
    if (!reader.exists(file)) continue;
    for (const { payload } of reader.json(file).records) {
      if (payload.kind === 'tool-row-source' && payload.list?.records) for (const listed of listedRows(tools, payload, reader)) rows.push({ folder, payload: listed });
      else rows.push({ folder, payload });
    }
  }
  return rows;
}

// `tools` is the Workshop's tools folder.
export const workshopToolIds = tools => new Set(workshopRows(tools).map(({ payload }) => payload.id));
