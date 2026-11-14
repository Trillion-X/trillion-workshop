// ASKING A TARGET WITHOUT SAYING WHICH TARGETS YOU THINK ARE RUNNING IS REFUSED.
//
// The instance requires that header on every target request. One call in the
// server did not send it, so it was refused every time, and the refusal is
// raised rather than swallowed, correctly, which meant each visitor to the
// application host was told their session could not be verified. That reads as
// a directory that is down, and the directory was answering perfectly.
//
// It went unnoticed because the path carried no traffic until the public server
// was put in front of the application. This reads the built program rather than
// mocking a request, because what failed was an omission at one call site and a
// mock of that call site would have contained the same omission.
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, '..', 'processes', 'public-entry-server-source.mjs'), 'utf8');

// Every place this server builds headers for a target request. The name is what
// ties them together; a new one that forgets the header fails here by name.
const REQUEST_BUILDERS = ['invokeLabelAddressed', 'invokeTarget', 'askTargetForJson'];

function bodyOf(name) {
  const start = source.indexOf(`async function ${name}(`);
  assert.notEqual(start, -1, `${name} is gone or renamed; this rule has to follow it`);
  const next = source.indexOf('\nasync function ', start + 1);
  const plain = source.indexOf('\nfunction ', start + 1);
  const ends = [next, plain].filter((index) => index !== -1);
  return source.slice(start, ends.length ? Math.min(...ends) : source.length);
}

for (const name of REQUEST_BUILDERS) {
  test(`${name} says which targets it believes are running`, () => {
    const body = bodyOf(name);
    assert.ok(
      body.includes('TARGET_BASIS_HEADER'),
      `${name} asks a target without the header the instance requires, so it will be refused every time`,
    );
  });

  test(`${name} forgets a stale answer when a request is refused`, () => {
    const body = bodyOf(name);
    assert.ok(
      body.includes('basisPromise = null'),
      `${name} keeps a stale copy after a refusal, so every later request repeats it`,
    );
  });
}
