// tools/better-auth-official/test/pages.test.mjs
//
// The sign-in pages are this tool's own files, answered with the content security policy pages/routes.json gives: every
// script a page runs is allowed by it (an inline script by its sha256, the tool's own script by 'self'), nothing else is,
// and no page names anything outside this tool.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { pageAnswer, table } from '../pages.mjs';

const dir = new URL('../pages/', import.meta.url);
const html = readdirSync(dir).filter(name => name.endsWith('.html'));
const csp = table.headers['content-security-policy'];
const scriptSrc = csp.split(';').map(part => part.trim()).find(part => part.startsWith('script-src ')).split(' ').slice(1);

test('every address in routes.json answers its page with the policy, the referrer rule and the frame rule', () => {
  for (const { path, query = {} } of table.routes) {
    const url = `${path}?${new URLSearchParams(Object.fromEntries(Object.entries(query).map(([key, value]) => [key, value === '*' ? 'someone@example.test' : value])))}`;
    const answer = pageAnswer(url);
    assert.ok(answer, `${url} answers a page`);
    assert.equal(answer.headers['content-type'], 'text/html; charset=utf-8');
    assert.equal(answer.headers['content-security-policy'], csp);
    assert.equal(answer.headers['referrer-policy'], 'same-origin');
    assert.equal(answer.headers['x-frame-options'], 'DENY');
  }
  assert.equal(pageAnswer('/sign-in/assets/sign-in.js').headers['content-type'], 'text/javascript; charset=utf-8');
  assert.equal(pageAnswer('/sign-in/assets/../routes.json'), null);
  assert.equal(pageAnswer('/elsewhere'), null);
});

test('the policy allows exactly the scripts the pages run: each inline script by its sha256 and the tool\'s own script by \'self\'', () => {
  const inline = new Set();
  for (const name of html) {
    const text = readFileSync(new URL(name, dir), 'utf8');
    for (const [, body] of text.matchAll(/<script>([\s\S]*?)<\/script>/g)) inline.add(`'sha256-${createHash('sha256').update(body).digest('base64')}'`);
    for (const [, src] of text.matchAll(/<script src="([^"]+)"/g)) assert.ok(src.startsWith(table.assets_path), `${name} loads its script from this tool (${src})`);
    assert.doesNotMatch(text, / on[a-z]+=/, `${name} has no inline event handler, which the policy would block`);
  }
  assert.deepEqual(new Set(scriptSrc), new Set(["'self'", ...inline]));
});

test('no page or the client names the old sign-in tool', () => {
  for (const name of [...html, 'sign-in-client.mjs', 'routes.json', 'words.json']) {
    assert.doesNotMatch(readFileSync(new URL(name, dir), 'utf8'), /from-trillion-rust|tools\/sign-in\//, name);
  }
});
