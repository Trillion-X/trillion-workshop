#!/usr/bin/env node
// tools/read-a-list-view/do-work/read-list-view.mjs
//
// One page of what a person's list or saved view shows, a refresh of a list's row sources, a joined copy, or whether a
// list's file copy may be read, run on the person's computer from the Workshop checkout. The records are handed in: the
// caller reads them from the person's store and passes them as `stored` on standard input, and a refresh answers the
// records to write as `keep` rows for the caller to write back, each with the value it expected.
//
//   node tools/read-a-list-view/do-work/read-list-view.mjs [--deadline-ms MS] < input.json
//
// input.op is one of:
//   "read"          { names, stored, list | view, after?, limit? }             → a page { list, fields, rows, next, complete, of? }
//   "refresh"       { names, stored, list, source_ids?, paths?, changes?, dry_run?, source_answer_bytes?, restore?, history? }
//                                                                                  → { list, sources, keep: [{ id, type, value, expected }] }
//   "write-joined"  { root, name, type, prefixes, text_at, order_at, header?, most_bytes?, dry_run?, stored } → the copy's answer
//   "copy-readable" { names, list, reading }                                    → { readable, list, code?, because }
//
// --deadline-ms is the caller's absolute Unix-millisecond deadline: a run that has not started when it passes is refused as
// not_started; one still running at it is ended and reported as outcome=unknown. Exit 0 done, 2 with the reason on standard
// error. Every bound is the reader's own (read-data/list-view.json `limits`), never a caller's.
import { text } from 'node:stream/consumers';
import { readListView, refreshRowSources } from '../read-data/list-view.mjs';
import { writeJoinedCopy } from '../read-data/joined-copy.mjs';
import { copyReadable } from '../read-data/copy-readable.mjs';

const flags = {};
const rest = process.argv.slice(2);
for (let index = 0; index < rest.length; index += 2) flags[rest[index].replace(/^--/, '')] = rest[index + 1];
let deadlineTimer;
let operationStarted = false;

async function answerOf(input, signal) {
  switch (input.op) {
    case 'read': return readListView(input);
    case 'refresh': return refreshRowSources({ ...input, signal });
    case 'write-joined': return writeJoinedCopy(input);
    case 'copy-readable': return copyReadable(input);
    default: throw Object.assign(new Error('op is "read", "refresh", "write-joined" or "copy-readable".'), { outcome: 'not_started' });
  }
}

try {
  let signal;
  if (Object.hasOwn(flags, 'deadline-ms')) {
    const deadline = Number(flags['deadline-ms']);
    if (typeof flags['deadline-ms'] !== 'string' || !/^[0-9]+$/.test(flags['deadline-ms']) || !Number.isSafeInteger(deadline)) {
      throw Object.assign(new Error('--deadline-ms is an absolute Unix-millisecond integer.'), { outcome: 'not_started' });
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw Object.assign(new Error('The list-reader deadline elapsed before its request started.'), { outcome: 'not_started' });
    }
    // The deadline bounds the whole process: the run is told to stop (the signal a refresh takes), the process ends there.
    const controller = new AbortController();
    signal = controller.signal;
    deadlineTimer = setTimeout(() => {
      controller.abort();
      console.error('The list-reader deadline elapsed while the run was running.');
      console.error('read-list-view: outcome=unknown');
      process.exit(2);
    }, Math.min(remaining, 2147483647));
    deadlineTimer.unref();
  }
  const input = JSON.parse((await text(process.stdin)) || 'null');
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('usage: read-list-view.mjs < input.json, where input.op names the run.');
  operationStarted = true;
  console.log(JSON.stringify(await answerOf(input, signal)));
} catch (error) {
  console.error(error.message);
  // A later no-send call cannot prove this multi-step run had no earlier effects.
  const outcome = operationStarted ? 'unknown' : error.outcome;
  if (outcome === 'unknown' || outcome === 'not_started') console.error(`read-list-view: outcome=${outcome}`);
  process.exitCode = 2;
} finally {
  clearTimeout(deadlineTimer);
}
