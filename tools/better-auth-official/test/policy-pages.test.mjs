// tools/better-auth-official/test/policy-pages.test.mjs
//
// /terms and /privacy are drawn from the site's own words (settings.site.policy), never from this tool's files: a site that gives
// them gets both pages with its words, escaped; a site that gives none gets no page at either address.
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const given = JSON.parse(readFileSync(new URL('../settings.json', import.meta.url), 'utf8'));
const policy = {
  terms: { title: 'Example terms', description: 'The terms for Example.', sections: [{ heading: 'Who runs it', body: 'Example Co runs it.\n\nSecond <b>paragraph</b>.' }] },
  privacy: { title: 'What we keep', description: 'What Example keeps.', sections: [{ heading: 'Sign-in', body: 'Your email.' }] },
};
const scratchDir = tempFolder(join(tmpdir(), 'policy-pages-test-'));
writeFileSync(join(scratchDir, 'settings.json'), JSON.stringify({ ...given, site: { ...given.site, policy } }));
process.env.BETTER_AUTH_SETTINGS = join(scratchDir, 'settings.json');
const { pageAnswer } = await import('../pages.mjs');

test('/terms and /privacy are drawn from the site\'s own words, escaped, with a way back to sign in', () => {
  const terms = pageAnswer('/terms');
  assert.equal(terms.status, 200);
  const html = terms.body.toString();
  assert.match(html, /<title>Example terms<\/title>/);
  assert.match(html, /<h2 class="page-item-heading">Who runs it<\/h2>/);
  assert.match(html, /<p class="page-body">Example Co runs it\.<\/p><p class="page-body">Second &lt;b&gt;paragraph&lt;\/b&gt;\.<\/p>/);
  assert.doesNotMatch(html, /<b>paragraph/);
  assert.match(html, /href="\/sign-in"/);
  const privacy = pageAnswer('/privacy');
  assert.equal(privacy.status, 200);
  assert.match(privacy.body.toString(), /<h1 class="page-heading">What we keep<\/h1>/);
});

test('a site that gives no policy words gets no page at either address', () => {
  const pagesPath = fileURLToPath(new URL('../pages.mjs', import.meta.url));
  const run = spawnSync(process.execPath, ['--input-type=module', '-e',
    `const { pageAnswer } = await import(${JSON.stringify(pagesPath)}); console.log(JSON.stringify([pageAnswer('/terms'), pageAnswer('/privacy')].map(answer => answer === null)));`],
  { env: { ...process.env, BETTER_AUTH_SETTINGS: '' }, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout.trim(), '[true,true]');
});
