// tools/better-auth-official/test/account-page.test.mjs
//
// /account is the one page where a signed-in person sees their name, email and how they sign in, changes each through the page that
// changes it, and deletes their account. The page is the shared shell around its two sections (pages/sections/account.html and
// account-delete.html); the script fills the rows from Better Auth (passkey list, account list), and the delete step calls Better Auth's
// delete-user with the password when the account has one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pageAnswer, pageOf, table } from '../pages.mjs';

const dir = new URL('../pages/', import.meta.url);
const page = pageOf('/account');
const html = String(page);
const client = readFileSync(new URL('sign-in-client.mjs', dir), 'utf8');
const bundle = readFileSync(new URL('assets/sign-in.js', dir), 'utf8');

test('/account is a route that answers the shared page with its title and description', () => {
  const route = table.routes.find(({ path }) => path === '/account');
  assert.ok(route, '/account is in routes.json');
  assert.deepEqual(route.sections, ['account', 'account-delete']);
  assert.equal(pageAnswer('/account').status, 200);
  assert.match(html, /<title>Your account<\/title>/);
  assert.match(html, /<meta name="description" content="Your name, your email and how you sign in to Example, and deleting your account\."/);
});

test('/account lists name, email and sign-in methods, each with its change page', () => {
  assert.match(html, /data-fill-list="account"/);
  for (const words of ['account_name', 'account_email', 'account_passkeys', 'account_authenticator', 'account_password', 'account_other']) assert.ok(client.includes(`words.${words}`), words);
  for (const href of ['/sign-in/your-name', '/sign-in/change-email', '/sign-in/add-passkey']) assert.ok(client.includes(`href: '${href}'`), href);
});

test('/account names the account\'s delete step: one button opens a confirm step, and the confirm step posts to /account/delete', () => {
  assert.match(html, /data-delete-start[^>]*>Delete my account</);
  assert.match(html, /data-step="confirm" hidden/);
  assert.match(html, /<form class="page-choices" method="post" action="\/account\/delete">/);
  assert.match(html, /name="password"[^>]*type="password"/);
  assert.match(html, /data-delete-cancel[^>]*>Keep my account</);
  assert.match(html, /data-step="deleted" hidden/);
});

test('the delete step is confirmed before anything is deleted, and calls Better Auth\'s delete-user', () => {
  assert.match(client, /function deleteStart\(\)/);
  assert.match(client, /client\.deleteUser\(accountHasPassword \? \{ password: box\.value \} : \{\}\)/);
  assert.match(client, /if \(action === '\/account\/delete'\) return deleteAccount\(form\);/);
  assert.match(client, /SESSION_EXPIRED/, 'a sign-in too old to delete goes to sign-in and back');
  assert.match(client, /INVALID_PASSWORD/);
  assert.match(bundle, /\/delete-user/, 'the built bundle calls delete-user (npm run build-pages)');
});

test('no inline style, no script in the sections, and no stand-in name typed into the sections (the site block supplies it)', () => {
  for (const name of ['account.html', 'account-delete.html']) {
    const text = readFileSync(new URL(`sections/${name}`, dir), 'utf8');
    assert.doesNotMatch(text, /\sstyle=/, name);
    assert.doesNotMatch(text, /<script/, name);
    assert.doesNotMatch(text, /Example/, name);
  }
  assert.doesNotMatch(client.slice(client.indexOf('// /account:'), client.indexOf('// /device:')), /style\.|\.style\b/, 'the account script sets classes, not styles');
});

test('a sign-in too old to list where else it is signed in is asked to sign in again and come back, not told it failed', () => {
  assert.match(client, /if \(listed\.status === 403\) \{/);
  assert.match(client, /again\.href = `\/sign-in\?\$\{new URLSearchParams\(\{ next: location\.pathname \+ location\.search \}\)\}`/);
  const words = JSON.parse(readFileSync(new URL('words.json', dir), 'utf8'));
  assert.ok(words.account_sessions_confirm && words.account_sessions_confirm_action);
  assert.match(bundle, /account_sessions_confirm_action/, 'the built bundle carries it (npm run build-pages)');
});
