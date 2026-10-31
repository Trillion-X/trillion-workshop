// A made-up brand's rows: the selected family's variant for each tone, nothing from another family, no unsafe address.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { assetForBrand, presentationFromBrand } from '../read-data/brand-assets.mjs';

const command = resolve(import.meta.dirname, '../do-work/resolve-a-brand.mjs');
const host = 'https://assets.example.test/brand';
const variant = (family, role, format, background, name) =>
  ({ id: `${family}-${name}`, values: { name, brand: 'Harbour', family, role, format, background, url: `${host}/${family}-${name}.${format}` } });
const rows = [
  { id: 'harbour', values: { name: 'Harbour', family: 'original', role: 'selection' } },
  variant('original', 'wordmark', 'svg', 'black on transparent', 'wordmark-black'),
  variant('original', 'wordmark', 'svg', 'white on transparent', 'wordmark-white'),
  variant('original', 'mark', 'svg', 'black on white', 'mark-black-white'),
  variant('original', 'mark', 'svg', 'white on black', 'mark-white-black'),
  variant('autumn', 'wordmark', 'png', 'black on transparent', 'wordmark-black'),
];

test('a light page draws the black wordmark and a dark page the white one, of the selected family only', () => {
  assert.equal(assetForBrand(rows, { role: 'wordmark', format: 'svg', tone: 'light' }).url, `${host}/original-wordmark-black.svg`);
  assert.equal(assetForBrand(rows, { role: 'wordmark', format: 'svg', tone: 'dark' }).url, `${host}/original-wordmark-white.svg`);
  assert.equal(assetForBrand(rows, { role: 'mark', format: 'svg', tone: 'dark' }).url, `${host}/original-mark-white-black.svg`);
  assert.equal(assetForBrand(rows, { role: 'wordmark', format: 'png', tone: 'light' }), null);
});

test('rows as the record store answers them ({ id, value }) read the same', () => {
  const stored = rows.map(row => ({ id: `record:brand-asset:${row.id}`, value: row.values }));
  assert.equal(presentationFromBrand(stored, 'light').chosen.mark_svg.url, `${host}/original-mark-black-white.svg`);
});

test('an address with credentials or without HTTPS is never used', () => {
  const unsafe = [rows[0], { id: 'x', values: { ...rows[1].values, url: 'https://user:pass@assets.example.test/a.svg' } },
    { id: 'y', values: { ...rows[3].values, url: 'http://assets.example.test/b.svg' } }];
  assert.equal(assetForBrand(unsafe, { role: 'wordmark', format: 'svg' }), null);
  assert.equal(assetForBrand(unsafe, { role: 'mark', format: 'svg' }), null);
});

test('the command names a local copy when one is there, and refuses rows without a selection', () => {
  const dir = mkdtempSync(join(tmpdir(), 'brand-kit-'));
  mkdirSync(join(dir, 'copies'));
  writeFileSync(join(dir, 'copies', 'original-wordmark-black.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  writeFileSync(join(dir, 'request.json'), JSON.stringify({ rows, tone: 'light', files_at: 'copies' }));
  const out = JSON.parse(execFileSync(process.execPath, [command, join(dir, 'request.json')], { encoding: 'utf8' }));
  assert.equal(out.family, 'original');
  assert.equal(out.chosen.wordmark_svg.file, join(dir, 'copies', 'original-wordmark-black.svg'));
  assert.equal(out.chosen.mark_svg.file, undefined);
  writeFileSync(join(dir, 'none.json'), JSON.stringify({ rows: rows.slice(1) }));
  assert.throws(() => execFileSync(process.execPath, [command, join(dir, 'none.json')], { stdio: 'pipe' }), /selection/);
});
