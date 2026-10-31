#!/usr/bin/env node
// tools/documents-as-list-rows/do-work/documents.mjs
//
// The command line of documents-as-list-rows, for running it by hand or from a person's AI on their computer:
//
//   node do-work/documents.mjs rows  --root DIR [--folder SUB] [--match GLOB] [--after NAME] [--limit N] [--backlinks]
//   node do-work/documents.mjs set   --root DIR --path /NAME --if-identity 1f:... [--set KEY=JSON ...] [--remove KEY ...]
//   node do-work/documents.mjs split --root DIR --mapping FILE (--check | --out SUB --leftover SUB)
//   node do-work/documents.mjs selection --root DIR --stdin < {"source": <documents row source>}
//   node do-work/documents.mjs rows|set|split --root DIR --stdin   < the input as JSON
//
// With --stdin the input is the JSON on standard input, shaped as the function in read-data/rows.mjs takes it, and
// --root is the folder the person granted (a Workshop row fills it from the run's grant), so a row's input can never
// name another root.
//
// Prints one JSON answer. Exit 0 done, 1 refused (a document changed since it was read), 2 unreadable input.
import { text } from 'node:stream/consumers';
import { changeDocumentRows, readDocumentRows, readDocumentSelection, splitIntoDocuments } from '../read-data/rows.mjs';
import data from '../read-data/document-properties.json' with { type: 'json' };

const [command, ...rest] = process.argv.slice(2);
const flags = {};
for (let index = 0; index < rest.length; index += 1) {
  const name = rest[index].replace(/^--/, '');
  const next = rest[index + 1];
  const value = next === undefined || next.startsWith('--') ? true : (index += 1, next);
  flags[name] = name === 'set' || name === 'remove' ? [...(flags[name] ?? []), value] : value;
}
const json = words => { try { return JSON.parse(words); } catch { return words; } };
const run = { rows: readDocumentRows, set: changeDocumentRows, split: splitIntoDocuments, selection: readDocumentSelection };

try {
  let answer;
  if (flags.stdin === true && run[command]) {
    answer = await run[command]({ ...JSON.parse((await text(process.stdin)) || '{}'), root: flags.root });
  } else if (command === 'rows') {
    answer = await readDocumentRows({ root: flags.root, folder: flags.folder, match: flags.match, after: flags.after ?? null,
      ...(flags.exclude ? { exclude: json(flags.exclude) } : {}),
      ...(flags.paths ? { paths: json(flags.paths) } : {}),
      ...(flags['paths-file'] ? { paths_file: flags['paths-file'] } : {}),
      ...(flags['text-extensions'] ? { text_extensions: json(flags['text-extensions']) } : {}),
      limit: flags.limit ? Number(flags.limit) : undefined, backlinks: flags.backlinks === true,
      ...(flags.content ? { content: flags.content === true ? true : json(flags.content) } : {}),
      ...(flags['most-bytes'] ? { most_bytes: Number(flags['most-bytes']) } : {}) });
  } else if (command === 'set') {
    const values = {};
    for (const pair of flags.set ?? []) { const at = pair.indexOf('='); values[`${data.namespaces.properties}.${pair.slice(0, at)}`] = json(pair.slice(at + 1)); }
    for (const key of flags.remove ?? []) values[`${data.namespaces.properties}.${key}`] = null;
    answer = await changeDocumentRows({ root: flags.root, rows: [{ id: flags.path, values, if_identity: flags['if-identity'] }] });
  } else if (command === 'split') {
    answer = await splitIntoDocuments({ root: flags.root, mapping: flags.mapping, out: flags.out, leftover: flags.leftover, check: flags.check === true });
  } else {
    throw Object.assign(new Error('usage: documents.mjs rows|set|split|selection ... (see the top of this file)'), { code: 'bad_input' });
  }
  console.log(JSON.stringify(answer));
} catch (error) {
  console.error(error.message);
  process.exitCode = error.code === 'document_changed' ? 1 : 2;
}
