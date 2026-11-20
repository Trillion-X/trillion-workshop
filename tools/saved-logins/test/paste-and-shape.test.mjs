// Reading a pasted export (CSV, a page copied whole, HTML toggles) and shaping a login, over made-up values only.
// The assertions are the older Workshop copy's (test/saved-logins.test.mjs at commit b6ae0ebf81) for these functions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { outlineTree, readPastedLogins, shapedLogin, SavedLoginRefused } from '../src/paste-and-shape.mjs';

test('a CSV export from any password manager imports by its column names', () => {
  const csv = 'folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp\n,,login,Example,"line one\nline two",,0,https://example.com,ann,"pa,ss""word",otpauth://x\n,,login,Empty,,,0,https://empty.example,bob,,\n';
  const { logins, skipped } = readPastedLogins(csv);
  assert.deepEqual(logins, [{ title: 'Example', site: 'https://example.com', user_name: 'ann', fields: [{ label: 'Notes', value: 'line one\nline two' }, { label: 'Password', value: 'pa,ss"word' }, { label: 'Login_totp', value: 'otpauth://x' }] }]);
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].line, 3);
});

test('a page of logins copied whole: letter groups, services, user-name toggles holding passwords, and value toggles', () => {
  const page = [
    'Account Logins',
    '- A',
    '    - alpha-host.com (domain host)',
    '        - user-one',
    '            - first-secret',
    '        - user-two',
    '            - second-secret',
    '- C',
    '    - Cloudy',
    '        - person@example.com',
    '        - password',
    '            - third-secret',
    '        - API Token',
    '            - token-value',
  ].join('\n');
  const { logins } = readPastedLogins(page);
  assert.deepEqual(logins, [
    { title: 'alpha-host.com (domain host)', site: 'alpha-host.com', user_name: 'user-one', fields: [{ label: 'Password', value: 'first-secret' }] },
    { title: 'alpha-host.com (domain host)', site: 'alpha-host.com', user_name: 'user-two', fields: [{ label: 'Password', value: 'second-secret' }] },
    { title: 'Cloudy', site: null, user_name: 'person@example.com', fields: [{ label: 'password', value: 'third-secret' }, { label: 'API Token', value: 'token-value' }] },
  ]);
});

test('HTML toggles from a page export nest the same way as indentation', () => {
  const tree = outlineTree('\x3cdetails>\x3csummary>B\x3c/summary>\n\x3cdetails>\x3csummary>Bank\x3c/summary>\n\x3cdetails>\x3csummary>me\x3c/summary>\nsecret &amp; more\n\x3c/details>\n\x3c/details>\n\x3c/details>');
  assert.deepEqual(JSON.parse(JSON.stringify(tree.children)), [{ text: 'B', children: [{ text: 'Bank', children: [{ text: 'me', children: [{ text: 'secret & more', children: [] }] }] }] }]);
  assert.deepEqual(readPastedLogins('\x3cdetails>\x3csummary>Bank\x3c/summary>\n\x3cdetails>\x3csummary>me\x3c/summary>\nsecret\n\x3c/details>\n\x3c/details>').logins[0].user_name, 'me');
});

test('a login is shaped from a form: its title falls back to the site host, and a box with no value is refused', () => {
  assert.deepEqual(shapedLogin({ site: 'https://www.example.com/login', user_name: ' ann ', fields: [{ label: 'Password', value: 'pw-value' }] }), { title: 'www.example.com', site: 'https://www.example.com/login', user_name: 'ann', fields: [{ label: 'Password', value: 'pw-value' }] });
  assert.throws(() => shapedLogin({ title: 'Empty', fields: [{ label: 'Password', value: '  ' }] }), error => error instanceof SavedLoginRefused && error.message.length > 0);
  assert.throws(() => shapedLogin({ fields: [{ value: 'x' }] }), error => error instanceof SavedLoginRefused);
});
