#!/usr/bin/env node
// Turns the facts about tasks (one row per fact: subject_id, property_id, value) into one entry per task, and says
// for each task what it blocks. Run by the Workshop tool `tool:list-tasks-and-what-blocks-them` in the tool container:
//
//   node do-work/list-tasks-and-what-blocks-them.mjs '<the input as JSON>'
//
// argv[2] is { rows }. Prints { tasks } on one line. The decoding is the package's own (read-data/read-tasks.ts).
import { decodeTasksFeed } from '../read-data/read-tasks.ts';

try {
  const { rows } = JSON.parse(process.argv[2] ?? '{}');
  if (!Array.isArray(rows)) throw new Error('rows must be a list of facts: { subject_id, property_id, value }');
  process.stdout.write(`${JSON.stringify({ tasks: decodeTasksFeed(rows) })}\n`);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 2;
}
