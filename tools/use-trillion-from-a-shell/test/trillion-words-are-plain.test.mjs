// Every sentence the trillion command says to a person is a row of trillion.json `words` (its `details` block is the technical line
// --verbose adds). Each one is checked against the one list of words a person must never read, which the sign-in pages' words are
// checked against too: tools/better-auth-official/pages/plain-words.json.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import settings from '../do-work/trillion.json' with { type: 'json' };

const plain = JSON.parse(readFileSync(new URL('../../better-auth-official/pages/plain-words.json', import.meta.url), 'utf8'));

/** Every [path, sentence] of `words` a person can read: `_what` notes and the technical `details` block are not. */
function sentences(value, path = 'words') {
  if (typeof value === 'string') return [[path, value]];
  return Object.entries(value).filter(([name]) => name !== '_what' && name !== 'details').flatMap(([name, child]) => sentences(child, `${path}.${name}`));
}

const jargonIn = text => [
  ...plain.words.filter(word => new RegExp(`\\b${word}\\b`, 'i').test(text)).map(word => `the word "${word}"`),
  ...plain.patterns.filter(pattern => new RegExp(pattern, 'i').test(text)).map(pattern => `the shape ${pattern}`),
  ...[...text.matchAll(/\{(\w+)\}/g)].map(found => found[1]).filter(name => plain.placeholders.includes(name)).map(name => `the placeholder {${name}}`),
];

test('no sentence the command says to a person holds jargon, an address, a port or an id', () => {
  const found = sentences(settings.words).flatMap(([path, text]) => jargonIn(text).map(what => `${path} holds ${what}: ${text}`));
  assert.deepEqual(found, []);
});

test('the check sees jargon: it fails on a sentence that names a door, an address, a port or a long id', () => {
  for (const text of ['The local door refused it.', 'Open http://127.0.0.1:8788/mcp', 'Trillion at 10.0.0.1 said no', `Account ${'a'.repeat(64)}`, 'The credential was refused', 'Kept in the Keychain', 'MCP said {mcp}'])
    assert.notDeepEqual(jargonIn(text), [], text);
  assert.deepEqual(jargonIn("You're signed in to Trillion as person@example.com."), []);
});

test('the sentences of a sign-in are the declared ones: success is one line with the email, and a failure is one line with the one thing to do', () => {
  assert.equal(settings.words.signed_in, "You're signed in to Trillion as {email}.");
  // No sentence a person reads names an app or a Mac: a person may have neither.
  const said = Object.entries(settings.words).filter(([name, words]) => name !== 'details' && typeof words === 'string');
  for (const [name, words] of said) assert.ok(!/\bMac\b|\bapp\b/.test(words), `${name} names an app or a Mac: ${words}`);
  for (const name of ['refused', 'sign_in_ended', 'no_credential', 'not_running', 'not_taken_in', 'unreachable']) assert.ok(!settings.words[name].includes('\n'), `${name} is one line`);
});
