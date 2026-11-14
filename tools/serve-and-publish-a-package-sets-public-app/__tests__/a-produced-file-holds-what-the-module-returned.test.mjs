#!/usr/bin/env node
// A produced file holds what the module returned, or the producer refuses and says why.
//
// The failure this guards is quiet: a producer that writes SOMETHING for every input turns a typo
// in an export name into an empty page, and an empty page reads as a content problem for as long as
// anyone is willing to look at the content. So every way of asking for a value that does not exist
// has to end in a refusal that names it.
//
// Runs the real functions with injected io, so no test writes to a real path.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  readOptions,
  refusalFor,
  bytesFor,
  writeModuleExportResult,
} from '../processes/write-a-module-export-result-to-a-file.mjs';
import { bodyOf } from '../processes/document-parts.mjs';

const io = (module, written) => ({
  load: async () => module,
  read: async () => JSON.stringify({ who: 'an argument' }),
  write: async (path, bytes) => { written.path = path; written.bytes = bytes; },
});

test('a function export is called and its return is the file', async () => {
  const written = {};
  const result = await writeModuleExportResult(
    { module: '/m.mjs', export: 'render', output: '/out.html' },
    io({ render: () => '<p>rendered</p>' }, written),
  );
  assert.equal(written.bytes, '<p>rendered</p>');
  assert.equal(written.path, '/out.html');
  assert.equal(result.bytes, 15);
});

test('the argument file reaches the function, so a caller can pass markup a shell could not', async () => {
  const written = {};
  await writeModuleExportResult(
    { module: '/m.mjs', export: 'render', output: '/out.html', 'argument-file': '/arg.json' },
    io({ render: (argument) => `<p>${argument.who}</p>` }, written),
  );
  assert.equal(written.bytes, '<p>an argument</p>');
});

test('a value export needs no call, because a constant is a result too', async () => {
  const written = {};
  await writeModuleExportResult(
    { module: '/m.mjs', export: 'CHROME', output: '/out.css' },
    io({ CHROME: 'body{}' }, written),
  );
  assert.equal(written.bytes, 'body{}');
});

test('a non-string is written as JSON rather than as whatever String() would have made of it', () => {
  assert.equal(bytesFor('already text'), 'already text');
  assert.equal(bytesFor({ a: 1 }), '{\n  "a": 1\n}\n');
  // The one that matters: String({a:1}) is "[object Object]", a file that looks written and holds
  // nothing.
  assert.equal(bytesFor([1, 2]), '[\n  1,\n  2\n]\n');
});

test('an export that does not exist is refused, and the refusal lists what does', async () => {
  const written = {};
  const result = await writeModuleExportResult(
    { module: '/m.mjs', export: 'renderr', output: '/out.html' },
    io({ render: () => 'x', CHROME: 'y' }, written),
  );
  assert.match(result.refused, /has no export "renderr"/);
  assert.match(result.refused, /render, CHROME/);
  assert.equal(written.path, undefined, 'a refusal writes nothing');
});

test('a relative path is refused, because the same command would mean two things on two runs', () => {
  assert.match(refusalFor({ module: 'm.mjs', export: 'x', output: '/out' }), /--module must be an absolute path/);
  assert.match(refusalFor({ module: '/m', export: 'x', output: 'out' }), /--output must be an absolute path/);
  assert.match(
    refusalFor({ module: '/m', export: 'x', output: '/out', 'argument-file': 'a.json' }),
    /--argument-file must be an absolute path/,
  );
  assert.equal(refusalFor({ module: '/m', export: 'x', output: '/out' }), null);
});

test('a missing required option is refused by name', () => {
  assert.match(refusalFor({ export: 'x', output: '/o' }), /--module is required/);
  assert.match(refusalFor({ module: '/m', output: '/o' }), /--export is required/);
  assert.match(refusalFor({ module: '/m', export: 'x' }), /--output is required/);
});

test('a text argument file is passed as text, so the producer is also a transform', async () => {
  const written = {};
  await writeModuleExportResult(
    { module: '/m.mjs', export: 'shout', output: '/out.html', 'argument-text-file': '/in.html' },
    {
      load: async () => ({ shout: (text) => text.toUpperCase() }),
      read: async () => '<p>quiet</p>',
      write: async (path, bytes) => { written.path = path; written.bytes = bytes; },
    },
  );
  assert.equal(written.bytes, '<P>QUIET</P>');
});

test('both argument forms at once is refused rather than one silently winning', async () => {
  const written = {};
  const result = await writeModuleExportResult(
    {
      module: '/m.mjs',
      export: 'x',
      output: '/o',
      'argument-file': '/a.json',
      'argument-text-file': '/a.html',
    },
    io({ x: () => 'y' }, written),
  );
  assert.match(result.refused, /not both/);
  assert.equal(written.path, undefined);
});

test('the body of a document is what is inside it, and a fragment is already that', () => {
  assert.equal(bodyOf('<html><head><title>t</title></head><body><p>x</p></body></html>'), '<p>x</p>');
  assert.equal(bodyOf('<body class="dark" data-x="1"><p>x</p></body>'), '<p>x</p>',
    'the opening tag carries attributes and still closes at its own bracket');
  // A fragment comes back unchanged rather than empty, which is what makes this safe to run twice.
  // Every hand-written "strip the wrapper" helper gets this wrong and empties a page on the second
  // pass, and an empty page reads as a content problem.
  assert.equal(bodyOf('<p>already a fragment</p>'), '<p>already a fragment</p>');
  assert.equal(bodyOf(bodyOf('<html><body><p>x</p></body></html>')), '<p>x</p>');
  // The LAST closing tag wins, so a document that merely mentions the string does not truncate.
  assert.equal(
    bodyOf('<html><body><script>var s="</body>";</script><p>x</p></body></html>'),
    '<script>var s="</body>";</script><p>x</p>',
  );
  assert.equal(bodyOf(undefined), '');
});

test('options are read as pairs', () => {
  assert.deepEqual(
    readOptions(['--module', '/m.mjs', '--export', 'render', '--output', '/o.html']),
    { module: '/m.mjs', export: 'render', output: '/o.html' },
  );
});
