// tools/better-auth-official/test/plain-words.test.mjs
//
// A person is never shown a host name, a link, an IP address, a port, or a word they do not know (L083). Every page's visible text, and every
// word the page script may show, is checked against pages/plain-words.json. The list is DATA: a word is added there, not allowed here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pageOf, table } from '../pages.mjs';

const list = JSON.parse(readFileSync(new URL('../pages/plain-words.json', import.meta.url), 'utf8'));
const words = JSON.parse(readFileSync(new URL('../pages/words.json', import.meta.url), 'utf8'));
const escapeRegExp = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const rules = [
  ...list.words.map(word => ({ name: word, test: new RegExp(`(?<![\\w-])${escapeRegExp(word)}(?![\\w-])`, 'i') })),
  ...list.patterns.map(pattern => ({ name: `pattern ${pattern}`, test: new RegExp(pattern, 'i') })),
];

// What a person can read in a page's html: its text and the attributes that carry words. Script and style are not read.
const attributes = ['placeholder', 'aria-label', 'alt', 'title'];
function visible(html) {
  const found = [];
  for (const tag of html.matchAll(/<[^>]+>/g)) for (const name of attributes) { const value = tag[0].match(new RegExp(`\\s${name}="([^"]*)"`)); if (value) found.push(value[1]); }
  const text = html.replace(/<(script|style)[\s\S]*?<\/\1>/g, ' ').replace(/<[^>]+>/g, ' ');
  found.push(...text.split(/\s{2,}|\n/));
  return found.map(piece => piece.replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/\s+/g, ' ').trim()).filter(Boolean);
}
const strings = value => typeof value === 'string' ? [value] : Array.isArray(value) ? value.flatMap(strings) : value && typeof value === 'object' ? Object.entries(value).filter(([key]) => !key.startsWith('_')).flatMap(([, item]) => strings(item)) : [];

// A {name} is where the page puts a value; it is not read as a word.
function breaches(pieces) {
  const hits = [];
  for (const piece of pieces.map(text => String(text ?? '').replace(/\{[a-z_-]+\}/g, ' '))) for (const rule of rules) if (rule.test.test(piece)) hits.push(`${rule.name}: "${piece}"`);
  return hits;
}

test('no page a person can open shows an address, a port, a link or a word on the list', () => {
  const hits = [];
  for (const route of table.routes.filter(route => !route.redirect)) {
    const url = `${route.path}${route.query ? `?${Object.keys(route.query).map(key => `${key}=x`).join('&')}` : ''}`;
    const html = String(pageOf(url));
    for (const hit of breaches([...visible(html), route.title, route.description])) hits.push(`${route.path}: ${hit}`);
  }
  assert.deepEqual(hits, []);
});

test('no word the page script may show, and no scope sentence, shows one either', () => {
  assert.deepEqual(breaches(strings(words)), []);
});

test('the list itself catches what it is for', () => {
  assert.ok(breaches(['From host.example.com.']).length, 'a host name');
  assert.ok(breaches(['go back to 127.0.0.1:54718']).length, 'an IP address and port');
  assert.ok(breaches(['https://example.test/callback']).length, 'a link');
  assert.ok(breaches(['Example command line wants to use your Example']).length, 'command line');
  assert.ok(breaches(['This client asked for a scope']).length, 'client and scope');
  assert.deepEqual(breaches(['Claude wants to work in your Example.', 'you@example.com', "We don't know this app."]), []);
});
