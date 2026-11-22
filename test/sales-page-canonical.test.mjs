import assert from 'node:assert/strict';
import test from 'node:test';
import { pageProblems, salesPageHtml } from '../tools/write-a-sales-page/read-data/sales-page.mjs';

const row = { title: 'A school', sections: [{ heading: 'Learn one job at a time.' }] };

test('a sales page row with canonical_origin and canonical_path carries the canonical link', () => {
  const html = salesPageHtml({ ...row, canonical_origin: 'https://www.example.com', canonical_path: '/lessons/one' }, '');
  assert.match(html, /<link rel="canonical" href="https:\/\/www\.example\.com\/lessons\/one"/);
});

test('canonical_path defaults to the root', () => {
  assert.match(salesPageHtml({ ...row, canonical_origin: 'https://www.example.com' }, ''), /<link rel="canonical" href="https:\/\/www\.example\.com\/"/);
});

test('a row without canonical_origin has no canonical link', () => {
  assert.doesNotMatch(salesPageHtml(row, ''), /rel="canonical"/);
});

test('a canonical origin that is not https, or a path that is not one leading slash, is a problem before writing', () => {
  for (const bad of [{ canonical_origin: 'http://www.example.com' }, { canonical_origin: 'https://www.example.com/x' },
    { canonical_origin: 'https://www.example.com', canonical_path: 'lessons' }, { canonical_origin: 'https://www.example.com', canonical_path: '//evil.test' }]) {
    assert.equal(pageProblems({ ...row, ...bad }).length, 1, JSON.stringify(bad));
    assert.throws(() => salesPageHtml({ ...row, ...bad }, ''), /canonical_origin must be an https origin/);
  }
});
