#!/usr/bin/env node
// Call one export of one module and write what it returns to a file.
//
// WHY THIS PACKAGE OWNS IT. A page description points at files: `fallback_body_file`,
// `chrome_css_file`, `shell_css_file`. Some of those files are AUTHORED and some are the output of
// a program, and until now the second kind had no producer, so the only way to get one was to
// transcribe generated markup by hand. A transcription error in generated markup is indistinguishable
// from content, which is the worst failure mode available: it looks like a page.
//
// The case that produced it: collapsing a forked entry server, whose landing page was rendered by a
// module from two constants, onto the canonical, whose landing page is a file named by DATA. Every
// fork collapse after it has the same shape, because a fork exists precisely where someone wrote a
// program instead of a description.
//
// It knows nothing about pages, markup, tenants or migrations. Module, export, optional argument,
// path. A string is written as-is and anything else as JSON, because those are the only two things
// a file can honestly be, and guessing an encoding is how a producer starts lying about its output.
//
// Absolute paths only: a relative path resolves against whatever directory the caller happened to be
// in, so the same command would mean two things on two runs.
//
//   node write-a-module-export-result-to-a-file.mjs \
//     --module /abs/module.mjs --export renderSomething \
//     [--argument-file /abs/argument.json | --argument-text-file /abs/input.html] \
//     --output /abs/result.html
//
// The argument is a FILE rather than an inline string because the arguments that matter here are
// long, and a shell is the worst place to keep markup. Two explicit options rather than one that
// sniffs the contents: `--argument-file` parses JSON, `--argument-text-file` passes the text. That
// second form is what makes this a TRANSFORM as well as a producer, since the output of one run is
// the input of the next.

import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export function readOptions(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (!name.startsWith('--')) continue;
    options[name.slice(2)] = argv[index + 1];
    index += 1;
  }
  return options;
}

export function refusalFor(options) {
  for (const required of ['module', 'export', 'output']) {
    if (!options[required]) return `--${required} is required`;
  }
  for (const [name, value] of Object.entries(options)) {
    // Every path-shaped option is checked, including ones added later, rather than the three that
    // exist today.
    const isPath = name === 'module' || name === 'output' || name.endsWith('file');
    if (!isPath) continue;
    if (typeof value !== 'string' || !value.startsWith('/')) {
      return `--${name} must be an absolute path, got ${JSON.stringify(value)}`;
    }
  }
  return null;
}

/** What to write for a value: a string as itself, anything else as JSON. */
export function bytesFor(value) {
  return typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`;
}

export async function writeModuleExportResult(options, io = {}) {
  const load = io.load ?? ((path) => import(pathToFileURL(path).href));
  const read = io.read ?? ((path) => readFile(path, 'utf8'));
  const write = io.write ?? ((path, bytes) => writeFile(path, bytes, 'utf8'));

  const refusal = refusalFor(options);
  if (refusal) return { refused: refusal };

  const module = await load(options.module);
  if (!(options.export in module)) {
    // Naming what IS exported, because the overwhelmingly common cause is a typo or a renamed
    // export, and a reader holding the list fixes it without opening the module.
    return {
      refused: `${options.module} has no export ${JSON.stringify(options.export)}.`
        + ` It exports: ${Object.keys(module).join(', ') || 'nothing'}`,
    };
  }
  const exported = module[options.export];
  // Two explicit ways to say what the export is called with, and never a guess between them. A
  // single option that sniffed whether a file "looked like JSON" would decide a caller's argument
  // type from its contents, which is the same class of magic as an encoded string.
  if (options['argument-file'] && options['argument-text-file']) {
    return { refused: 'pass --argument-file or --argument-text-file, not both' };
  }
  const argument = options['argument-file']
    ? JSON.parse(await read(options['argument-file']))
    : options['argument-text-file']
      ? await read(options['argument-text-file'])
      : undefined;
  const value = typeof exported === 'function' ? await exported(argument) : exported;
  const bytes = bytesFor(value);
  await write(options.output, bytes);
  return { wrote: options.output, bytes: Buffer.byteLength(bytes), from: options.export };
}

// argv[1] rather than `import.meta.main`, which is not available on every node this repo runs.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await writeModuleExportResult(readOptions(process.argv.slice(2)));
  if (result.refused) {
    console.error(`refused: ${result.refused}`);
    process.exitCode = 2;
  } else {
    console.log(`wrote ${result.bytes} bytes to ${result.wrote} from ${result.from}`);
  }
}
