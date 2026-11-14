import assert from 'node:assert/strict';
import test from 'node:test';

import {
  executeHostedUrlReturnAction,
  selectHostedUrlReturnAction,
} from './hosted-url-return-action.mjs';

const action = {
  clear_query_params: ['account_login', 'token'],
  kind: 'hosted-url-return-action',
  match_query: { account_login: 'complete' },
  payload_fields: { token: { query_param: 'token' } },
  reload_on_success: true,
  target: 'account-session.complete-returning-login',
};

test('a package record completes the hosted callback, applies its cookie, and removes the token', async () => {
  const url = new URL('https://community.example-school.test/account?account_login=complete&token=b3.payload.signature&utm_source=email');
  let invoked;
  const completed = await executeHostedUrlReturnAction([action], url, async (target, payload) => {
    invoked = { payload, target };
    return {
      browserEffects: {
        cookies: [{
          httpOnly: true,
          maxAge: 2_592_000,
          name: '__Host_account_session',
          path: '/',
          sameSite: 'lax',
          secure: true,
          value: 'b3.session.signature',
        }],
      },
    };
  });

  assert.deepEqual(invoked, {
    payload: { token: 'b3.payload.signature' },
    target: 'account-session.complete-returning-login',
  });
  assert.equal(completed.location, '/account?utm_source=email');
  assert.deepEqual(completed.cookies, [
    '__Host_account_session=b3.session.signature; Max-Age=2592000; Path=/; HttpOnly; Secure; SameSite=Lax',
  ]);
});

test('unmatched and ambiguous callback records fail closed', async () => {
  const ordinary = new URL('https://community.example-school.test/account');
  assert.equal(selectHostedUrlReturnAction([action], ordinary), null);
  assert.throws(
    () => selectHostedUrlReturnAction([action, { ...action }], new URL('https://example.com/account?account_login=complete')),
    /More than one/,
  );
});

test('cookie response data cannot inject another header', async () => {
  await assert.rejects(
    executeHostedUrlReturnAction(
      [action],
      new URL('https://example.com/account?account_login=complete&token=b3.payload.signature'),
      async () => ({ browserEffects: { cookies: [{ name: 'session', value: 'ok; injected=yes' }] } }),
    ),
    /cookie value is invalid/,
  );
});
