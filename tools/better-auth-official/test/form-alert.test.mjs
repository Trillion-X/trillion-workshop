// tools/better-auth-official/test/form-alert.test.mjs
//
// A failure is shown as the shared FormAlert (tools/ui/show/form-alert), never as a quiet grey line: it is an alert (role=alert) drawn next to
// the control that failed, the danger colour comes from Screen Look's error token, the one next action is a button, and no failure goes
// through the quiet status line, which is for news only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pageOf } from '../pages.mjs';

const client = readFileSync(new URL('../pages/sign-in-client.mjs', import.meta.url), 'utf8');
const words = JSON.parse(readFileSync(new URL('../pages/words.json', import.meta.url), 'utf8'));
const shell = readFileSync(new URL('../pages/shell.html', import.meta.url), 'utf8');

test('the script draws the shared alert part, never its own markup for trouble', () => {
  assert.match(client, /from '\.\.\/\.\.\/ui\/show\/form-alert\/FormAlert\.tsx'/);
  assert.match(client, /renderToStaticMarkup\(createElement\(FormAlert/);
});

test('the shared part\'s danger colour is Screen Look\'s error colour on every page', () => {
  assert.match(shell, /--status-error:var\(--color-error\)/);
  assert.ok(String(pageOf('/sign-in')).includes('--status-error:var(--color-error)'));
});

test('the quiet status line is used only for news, and every action a failure names has its words and its doing', () => {
  const quiet = [...client.matchAll(/\bstatus\(([^)]*)\)/g)].map(found => found[1]).filter(argument => /words\./.test(argument));
  const news = ['words.email_change_sent', 'words.link_sent', 'words.key_made', 'words.disconnected', 'words.approve_again'];
  for (const argument of quiet) assert.ok(news.some(word => argument.includes(word)), `status(${argument}) is trouble: use fail()`);
  for (const next of [...client.matchAll(/fail\([^;]*?, '([a-z-]+)'/g)].map(found => found[1])) {
    assert.ok(words.alert_actions[next], `${next} has its words`);
    assert.match(client, new RegExp(`'?${next}'?: \\(\\) =>`), `${next} has its doing`);
  }
});

test('every password sign-in refusal Better Auth gives has plain words', () => {
  for (const code of ['INVALID_EMAIL_OR_PASSWORD', 'EMAIL_NOT_VERIFIED']) assert.ok(words.password_errors[code], code);
});
