// test/bundled-site-modules-read-no-file-beside-them.test.mjs
// A Workshop module a site bundles has no folder of its own beside the bundle. A run-time read of a file from that folder
// (readFile or readFileSync given a path built from import.meta.url, import.meta.resolve, __dirname, dirname or here) fails
// in the site. This test reads the modules in site-imported-modules.json and fails on any of them that reads so, unless it
// is listed under allowed with why. A read from a descriptor or from stdin is not a file read and passes.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { it } from 'node:test';

const root = resolve(import.meta.dirname, '..');
const list = JSON.parse(readFileSync(resolve(import.meta.dirname, 'site-imported-modules.json'), 'utf8'));
const READ = /\breadFile(Sync)?\s*\(/;
const OWN_FOLDER = /import\.meta\.(url|resolve)|__dirname|\bdirname\s*\(|\bhere\b|\bdataFile\s*\(/;

it('every module the sites import is a file in this checkout', () => {
  const missing = list.modules.filter(path => !existsSync(resolve(root, path)));
  assert.deepEqual(missing, []);
});

it('no site-imported module reads a file from its own folder at run time', () => {
  const allowed = new Set(list.allowed.map(item => item.path));
  const offenders = [];
  for (const path of list.modules) {
    if (allowed.has(path)) continue;
    readFileSync(resolve(root, path), 'utf8').split('\n').forEach((line, index) => {
      if (line.trim().startsWith('//')) return;
      if (READ.test(line) && OWN_FOLDER.test(line)) offenders.push(`${path}:${index + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, []);
});
