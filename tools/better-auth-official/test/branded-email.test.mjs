// tools/better-auth-official/test/branded-email.test.mjs
//
// Every email the sign-in sends carries its plain text and an html drawn in the brand's email look (settings.brand.email): the
// wordmark served from this tool's assets, the look's paper colour, a button for a link, and the words each kind says.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { messageOf } from '../send-email.mjs';
import { pageAnswer, table } from '../pages.mjs';
import words from '../email-words.json' with { type: 'json' };

const { brand } = JSON.parse(readFileSync(new URL('../settings.json', import.meta.url), 'utf8'));
const lookWithWordmark = { ...brand, wordmark_png: Buffer.from('a picture').toString('base64') };
const extra = { minutes: '10', brand: lookWithWordmark, site_url: 'https://sign-in.example.com/', assets_url: `https://sign-in.example.com${table.assets_path}` };

test('a code email is drawn in the brand look with the wordmark and keeps its plain text', () => {
  const sent = messageOf({ kind: 'otp-sign-in', to: 'a@example.com', otp: '724632' }, extra);
  assert.match(sent.text, new RegExp(`^Your code to sign in to ${brand.name} is 724632`));
  assert.ok(sent.html.includes(`background:${brand.email.palette.paper}`));
  assert.ok(sent.html.includes(`src="https://sign-in.example.com${table.assets_path}wordmark.png"`));
  assert.ok(sent.html.includes('724632'));
});

test('every kind is drawn, a link kind gets a button and its address once', () => {
  for (const kind of Object.keys(words.kinds)) {
    const sent = messageOf({ kind, to: 'a@example.com', otp: '111111', url: 'https://sign-in.example.com/go?t=1', newEmail: 'b@example.com' }, extra);
    assert.ok(sent.html.startsWith('<!doctype html>') && sent.text.length > 0, kind);
    assert.ok(!sent.subject.includes('{') && !sent.text.includes('{name}'), `${kind} has no gap left`);
    if (words.kinds[kind].action) assert.equal(sent.html.split('https://sign-in.example.com/go?t=1').length, 2, `${kind}: one link`);
  }
});

test('with no wordmark in the brand block, no picture is drawn and nothing is served', () => {
  const sent = messageOf({ kind: 'otp-sign-in', to: 'a@example.com', otp: '1' }, { ...extra, brand });
  assert.ok(!sent.html.includes('<img'));
  assert.equal(pageAnswer(`${table.assets_path}wordmark.png`), null);
});
