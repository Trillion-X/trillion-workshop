// tools/better-auth-official/test/branded-email.test.mjs
//
// Every email the sign-in sends carries its plain text and an html drawn in the email look (email-look.json): the wordmark
// served from this tool's assets, the look's paper colour, a button for a link, and nothing from the words left unsaid.
import test from 'node:test';
import assert from 'node:assert/strict';
import { messageOf } from '../send-email.mjs';
import look from '../email-look.json' with { type: 'json' };
import { pageAnswer, table } from '../pages.mjs';
import words from '../email-words.json' with { type: 'json' };

const extra = { minutes: '10', site_url: 'https://sign-in.example.com/', assets_url: `https://sign-in.example.com${table.assets_path}` };

test('a code email is drawn in the look with the wordmark and keeps its plain text', () => {
  const sent = messageOf({ kind: 'otp-sign-in', to: 'a@example.com', otp: '724632' }, extra);
  assert.match(sent.text, /^Your code to sign in to Trillion is 724632/);
  assert.ok(sent.html.includes(`background:${look.palette.paper}`));
  assert.ok(sent.html.includes(`src="https://sign-in.example.com${table.assets_path}wordmark.png"`));
  assert.ok(sent.html.includes('724632'));
});

test('every kind is drawn, a link kind gets a button and its address once', () => {
  for (const kind of Object.keys(words.kinds)) {
    const sent = messageOf({ kind, to: 'a@example.com', otp: '111111', url: 'https://sign-in.example.com/go?t=1', newEmail: 'b@example.com' }, extra);
    assert.ok(sent.html.startsWith('<!doctype html>') && sent.text.length > 0, kind);
    if (words.kinds[kind].action) assert.equal(sent.html.split('https://sign-in.example.com/go?t=1').length, 2, `${kind}: one link`);
  }
});

test('the wordmark is answered as a png from the assets path', () => {
  const answer = pageAnswer(`${table.assets_path}wordmark.png`);
  assert.equal(answer.status, 200);
  assert.equal(answer.headers['content-type'], 'image/png');
});
