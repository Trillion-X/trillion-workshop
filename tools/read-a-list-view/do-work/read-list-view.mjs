#!/usr/bin/env node
// tools/read-a-list-view/do-work/read-list-view.mjs
//
// One page of what a person's list or saved view shows, or a refresh of a list's row sources, through their own door
// from their computer:
//
//   node do-work/read-list-view.mjs --config FILE (--list ID | --view ID) [--after CURSOR] [--limit N]
//   node do-work/read-list-view.mjs --config FILE --refresh ID [--sources '["source-id"]']
//
// The config is JSON: the door (read-data/door.mjs: transport, records, tools, filter), `names` as
// read-data/list-view.mjs takes them, and optionally `source_answer_bytes` (the room a source tool's answer has in the
// door's reply, for a refresh). The bounds are the reader's own (read-data/list-view.json `limits`), never a caller's.
//
// Prints the page, or what the refresh wrote, as one JSON answer. Exit 0 done, 2 with the reason on standard error.
import { readFile } from 'node:fs/promises';
import { openDoor } from '../read-data/door.mjs';
import { readListView, refreshRowSources } from '../read-data/list-view.mjs';

const flags = {};
const rest = process.argv.slice(2);
for (let index = 0; index < rest.length; index += 2) flags[rest[index].replace(/^--/, '')] = rest[index + 1];

try {
  if (!flags.config) throw new Error('usage: read-list-view.mjs --config FILE ((--list ID | --view ID) [--after CURSOR] [--limit N] | --refresh ID)');
  const config = JSON.parse(await readFile(flags.config, 'utf8'));
  const door = await openDoor(config);
  const answer = flags.refresh
    ? await refreshRowSources({ list: flags.refresh, names: config.names, source_answer_bytes: config.source_answer_bytes,
      ...(flags.sources !== undefined ? { source_ids: JSON.parse(flags.sources) } : {}) }, door)
    : await readListView({ list: flags.list, view: flags.view, after: flags.after ?? null, limit: flags.limit ? Number(flags.limit) : undefined, names: config.names }, door);
  console.log(JSON.stringify(answer));
} catch (error) {
  console.error(error.message);
  process.exitCode = 2;
}
