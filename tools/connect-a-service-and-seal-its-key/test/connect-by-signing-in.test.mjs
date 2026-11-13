// tool:connect-an-account-by-signing-in-to-the-service, run as the engine's container runner runs it (test-helpers/run-a-row.mjs)
// over the stand-in records door: the start keeps a pending sign-in and answers the service's own sign-in address; the
// callback uses a state once, refuses an unknown, expired, refused or mismatched sign-in with nothing saved, trades the
// code through this folder's http rows (stood in here, as the engine would answer them: every token already replaced by
// the held word) and writes the connection row once, with the starting values the start was given. Every name, account
// and value here is made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { runRow, rowOf } from '../../../test-helpers/run-a-row.mjs';
import rows from '../tool-rows.json' with { type: 'json' };
import settings from '../sign-in-settings.json' with { type: 'json' };
import descriptorFile from '../records.json' with { type: 'json' };
import socialRows from '../../social-posts/tool-rows.json' with { type: 'json' };

const ROUTE = 'tool:connect-an-account-by-signing-in-to-the-service';
const row = rowOf(rows, ROUTE);
const descriptors = Object.values(descriptorFile.things).map(thing => thing.payload).filter(payload => payload?.kind === 'service-connection-descriptor');
const descriptorOf = vendor => descriptors.find(payload => payload.vendor === vendor);
const HELD = '[held]';
const CLIENT_ID = 'made-up-client-id.apps.example.com';
const CODE = 'made-up-code-4f9a2c';
const ACCESS = 'made-up-access-token-77aa';
const REFRESH = 'made-up-refresh-token-88bb';

const list = {
  id: settings.list, type: 'list',
  value: {
    label: 'Service connections', row_type: 'service-connection', title_field: 'name',
    fields: [
      { id: 'name', kind: 'text', label: 'Service' },
      { id: 'status', kind: 'choice', label: 'Status', choices: ['Active', 'Retired'], starts: 'Active', settles: ['Retired'] },
      { id: 'can_send_as', kind: 'boolean', label: 'Can send as' },
      { id: 'can_be_primary', kind: 'boolean', label: 'Can be primary' },
      { id: 'read_only', kind: 'boolean', label: 'Read only' },
    ],
  },
};
const signInApp = (idName, clientId) => ({ id: `record:service-connection:${idName}`, type: 'record:service-connection', value: { name: 'Made-up sign-in app', kind: settings.sign_in_app_kind, client_id_name: idName, client_id: clientId, status: 'Active', can_send_as: false, can_be_primary: false, read_only: true } });
const seeded = [list, signInApp('google-sign-in-client-id', CLIENT_ID), signInApp('instagram-login-client-id', '1234567890')];
// The seeded rows of the list (the two sign-in apps): a sign-in that saves nothing leaves exactly these.
const APP_ROWS = 2;
const startQuery = { service: 'google-account', status: 'Active', read_only: 'true', can_send_as: 'false', can_be_primary: 'false', account: 'someone@example.com' };

// The engine's answer of each nested run, made up: the trade's tokens are already the held word (reply_holds_values).
const onePage = [{ id: '1000000000000001', name: 'Made Up Page' }];
const twoPages = [...onePage, { id: '1000000000000002', name: 'Another Made Up Page' }];
const toolRuns = ({ pages = onePage, email = 'someone@example.com', traded = { access_token: HELD, refresh_token: HELD, id_token: HELD, expires_in: 3599, scope: 'openid email https://www.googleapis.com/auth/gmail.readonly', token_type: 'Bearer' }, tradeError = null } = {}) => ({
  'tool:trade-a-gmail-sign-in-code-for-its-tokens': () => (tradeError ? { tool: 'tool:trade-a-gmail-sign-in-code-for-its-tokens', status: 400, error: tradeError } : { tool: 'tool:trade-a-gmail-sign-in-code-for-its-tokens', status: 200, result: traded }),
  'tool:google-account-find_my_mailbox': () => ({ tool: 'tool:google-account-find_my_mailbox', status: 200, result: { emailAddress: email, messagesTotal: 3, threadsTotal: 2, historyId: '1' } }),
  'tool:trade-an-instagram-sign-in-code-for-its-short-token': () => ({ status: 200, result: { access_token: HELD, user_id: 17800000000000001 } }),
  'tool:trade-a-short-instagram-token-for-a-long-one': () => ({ status: 200, result: { access_token: HELD, token_type: 'bearer', expires_in: 5183944 } }),
  'tool:check-the-instagram-connection': () => ({ status: 200, result: { user_id: '17800000000000001', username: 'made_up_account', id: '1' } }),
  'tool:trade-a-facebook-sign-in-code-for-its-short-token': () => ({ status: 200, result: { access_token: HELD, token_type: 'bearer', expires_in: 5183944 } }),
  'tool:trade-a-short-facebook-token-for-a-long-one': () => ({ status: 200, result: { access_token: HELD, token_type: 'bearer', expires_in: 5183944 } }),
  'tool:list-the-facebook-pages-a-sign-in-reaches': () => ({ status: 200, result: { data: pages } }),
  'tool:keep-a-facebook-pages-token': () => ({ status: 200, result: { id: 'kept', access_token: HELD } }),
  'tool:trade-a-threads-sign-in-code-for-its-short-token': () => ({ status: 200, result: { access_token: HELD, user_id: 17800000000000002 } }),
  'tool:trade-a-short-threads-token-for-a-long-one': () => ({ status: 200, result: { access_token: HELD, token_type: 'bearer', expires_in: 5183944 } }),
  'tool:check-the-threads-connection': () => ({ status: 200, result: { id: '17800000000000002', username: 'made_up_threads_account' } }),
});

const route = (path, query, sample) => runRow(row, { path, method: 'GET', query, body: {}, browser: { user_agent: 'test', origin: '', visitor: '' }, account_id: 'made-up-account' }, sample);
const start = (query = startQuery, records = seeded) => route(settings.routes.start, query, { records, tool_runs: toolRuns() });
const callback = (query, records, runs = toolRuns()) => route(settings.routes.callback, query, { records, tool_runs: runs });
const writesOf = run => run.calls.filter(call => call.method === 'records:write');
const typed = (run, type) => run.kept.filter(record => record.type === type);
const stateOf = answer => new URL(answer.last.result.body.authorize_url).searchParams.get('state');

test('the start keeps one pending sign-in and answers the service\'s own sign-in address, with S256 PKCE and the client id held in the open', async () => {
  const run = await start();
  assert.equal(run.code, 0, run.stderr);
  const { status, body } = run.last.result;
  assert.equal(status, 200);
  const acquire = descriptorOf('google-account').acquire;
  const address = new URL(body.authorize_url);
  assert.equal(`${address.origin}${address.pathname}`, acquire.authorize_url);
  assert.equal(address.searchParams.get('client_id'), CLIENT_ID);
  assert.equal(address.searchParams.get('redirect_uri'), `${settings.public_origin}${settings.route_prefix}${acquire.redirect.path}`);
  assert.equal(address.searchParams.get('scope'), acquire.scopes.join(' '));
  assert.equal(address.searchParams.get('response_type'), 'code');
  assert.equal(address.searchParams.get('access_type'), 'offline');
  assert.equal(address.searchParams.get('login_hint'), 'someone@example.com');
  assert.equal(address.searchParams.get('code_challenge_method'), 'S256');
  const [pending] = typed(run, settings.pending.type);
  assert.ok(pending, 'one pending sign-in is kept');
  assert.equal(pending.value.service, 'google-account');
  assert.deepEqual(pending.value.initial, { status: 'Active', read_only: true, can_send_as: false, can_be_primary: false });
  assert.equal(pending.value.connection_id, body.connection_id);
  assert.match(body.connection_id, /^service_connection:google-account:[0-9a-f]+$/);
  // The challenge is the verifier's SHA-256 (RFC 7636 S256); the verifier waits only in the pending record.
  const challenge = createHash('sha256').update(pending.value.code_verifier).digest('base64url');
  assert.equal(address.searchParams.get('code_challenge'), challenge);
  assert.ok(!JSON.stringify(run.last).includes(pending.value.code_verifier), 'the verifier is in no answer');
  assert.ok(!pending.id.includes(stateOf(run)), 'the state is kept only as its digest');
  assert.equal(typed(run, 'record:service-connection').length, APP_ROWS, 'the start writes no connection row');
});

test('the start refuses a service it cannot sign in to, one with no sign-in app id, and a missing starting value', async () => {
  const unknown = await start({ ...startQuery, service: 'no-such-service' });
  assert.equal(unknown.last.result.status, 404);
  const noApp = await start(startQuery, [list]);
  assert.equal(noApp.last.result.status, 503);
  const { read_only: _missing, ...partial } = startQuery;
  const missing = await start(partial);
  assert.equal(missing.last.result.status, 400);
  assert.match(missing.last.result.body.error, /read_only/);
  for (const refused of [unknown, noApp, missing]) assert.equal(typed(refused, settings.pending.type).length, 0, 'nothing is kept');
});

test('a state that matches no pending sign-in is refused, and nothing is traded or saved', async () => {
  const started = await start();
  const run = await callback({ state: 'not-the-state', code: CODE }, started.kept);
  assert.equal(run.last.result.status, 410);
  assert.equal(run.runs.length, 0, 'no token request was made');
  assert.equal(writesOf(run).length, 0);
  assert.equal(typed(run, settings.pending.type).length, 1, 'the real pending sign-in is untouched');
});

test('an expired state is refused and used up, and nothing is traded or saved', async () => {
  const started = await start();
  const expired = started.kept.map(record => (record.type === settings.pending.type ? { ...record, value: { ...record.value, expires_at: '2020-01-01T00:00:00.000Z' } } : record));
  const run = await callback({ state: stateOf(started), code: CODE }, expired);
  assert.equal(run.last.result.status, 410);
  assert.equal(run.runs.length, 0);
  assert.equal(typed(run, settings.pending.type).length, 0, 'the expired sign-in is removed');
  assert.equal(typed(run, 'record:service-connection').length, APP_ROWS, 'no connection row');
});

test('a service error or a missing code is refused after the state is used up', async () => {
  const started = await start();
  for (const query of [{ state: stateOf(started), error: 'access_denied' }, { state: stateOf(started) }]) {
    const run = await callback(query, started.kept);
    assert.equal(run.last.result.status, 400);
    assert.equal(run.runs.length, 0);
    assert.equal(typed(run, settings.pending.type).length, 0);
    assert.equal(typed(run, 'record:service-connection').length, APP_ROWS);
  }
});

test('the connection row is created by one write that already holds the starting values, never created and then changed', async () => {
  const started = await start();
  const run = await callback({ state: stateOf(started), code: CODE }, started.kept);
  assert.equal(run.code, 0, run.stderr);
  assert.equal(run.last.result.status, 200, JSON.stringify(run.last));
  assert.equal(run.last.result.http.format, 'text');
  assert.match(run.last.result.body, /Gmail is connected as someone@example\.com/);
  const connectionWrites = writesOf(run).filter(call => call.input.records.some(record => record.type === 'record:service-connection'));
  assert.equal(connectionWrites.length, 1, 'one write touches the connection row');
  const [written] = connectionWrites[0].input.records;
  assert.equal(written.expected, null, 'the row did not exist before');
  assert.equal(written.value.status, 'Active');
  assert.equal(written.value.read_only, true);
  assert.equal(written.value.can_send_as, false);
  assert.equal(written.value.can_be_primary, false);
  assert.equal(written.value.connection_id, started.last.result.body.connection_id);
  assert.equal(written.value.account_label, 'someone@example.com');
  assert.equal(written.value.kind, settings.account_kind);
  assert.deepEqual(written.value.granted_scopes, ['openid', 'email', 'https://www.googleapis.com/auth/gmail.readonly']);
  // The trade got the code, the callback address and the verifier, for the new connection only.
  const [trade, verify] = run.runs;
  assert.equal(trade.tool, 'tool:trade-a-gmail-sign-in-code-for-its-tokens');
  assert.deepEqual(trade.input.connection, { connection_id: written.value.connection_id });
  assert.equal(trade.input.code, CODE);
  assert.equal(trade.input.code_verifier, typed(started, settings.pending.type)[0].value.code_verifier);
  assert.equal(verify.tool, 'tool:google-account-find_my_mailbox');
  assert.equal(typed(run, settings.pending.type).length, 0, 'the pending sign-in is used up');
});

test('a pending sign-in is used once: the same callback again is refused and trades nothing', async () => {
  const started = await start();
  const query = { state: stateOf(started), code: CODE };
  const first = await callback(query, started.kept);
  assert.equal(first.last.result.status, 200);
  const again = await callback(query, first.kept);
  assert.equal(again.last.result.status, 410);
  assert.equal(again.runs.length, 0, 'the replay made no token request');
  assert.equal(typed(again, 'record:service-connection').length, APP_ROWS + 1, 'still the one connection row');
});

test('no secret, token, code or verifier is in any answer or log line', async () => {
  const started = await start();
  const verifier = typed(started, settings.pending.type)[0].value.code_verifier;
  const done = await callback({ state: stateOf(started), code: CODE }, started.kept);
  const refused = await callback({ state: stateOf(started), code: CODE }, started.kept, toolRuns({ tradeError: `refused ${HELD}` }));
  for (const run of [started, done, refused]) {
    const shown = `${run.stdout}\n${run.stderr}`;
    for (const secret of [CODE, verifier, ACCESS, REFRESH]) assert.ok(!shown.includes(secret), `${secret.slice(0, 12)} is not shown`);
    assert.ok(!shown.includes(stateOf(started)) || run === started, 'the state is shown only in the sign-in address');
  }
  assert.equal(refused.last.result.status, 400);
  assert.equal(typed(refused, 'record:service-connection').length, APP_ROWS, 'a refused trade saves no connection');
});

test('a sign-in as another account than the link was made for is refused, and no connection row is written', async () => {
  const started = await start();
  const run = await callback({ state: stateOf(started), code: CODE }, started.kept, toolRuns({ email: 'someone-else@example.com' }));
  assert.equal(run.last.result.status, 400);
  assert.match(run.last.result.body, /someone-else@example\.com/);
  assert.equal(typed(run, 'record:service-connection').length, APP_ROWS);
});

test('a sign-in with following trades runs them in order and names the account the service reports', async () => {
  const query = { service: 'instagram', status: 'Active', read_only: 'false', can_send_as: 'true', can_be_primary: 'true' };
  const started = await start(query);
  assert.equal(started.last.result.status, 200, JSON.stringify(started.last));
  const address = new URL(started.last.result.body.authorize_url);
  assert.equal(address.searchParams.get('scope'), descriptorOf('instagram').acquire.scopes.join(','));
  assert.equal(address.searchParams.get('code_challenge'), null, 'no PKCE where the descriptor asks for none');
  const run = await callback({ state: stateOf(started), code: CODE }, started.kept);
  assert.equal(run.last.result.status, 200, JSON.stringify(run.last));
  assert.deepEqual(run.runs.map(item => item.tool), [...settings.services.instagram.trade, settings.services.instagram.verify.tool]);
  const [written] = typed(run, 'record:service-connection').filter(record => record.value.kind === settings.account_kind);
  assert.equal(written.value.account_label, 'made_up_account');
  assert.deepEqual(written.value.plain, { ig_user_id: '17800000000000001' });
  assert.equal(written.value.can_send_as, true);
});

test('a connection asks for only the scopes its start names, and a scope the descriptor does not list is refused', async () => {
  const readOnly = ['openid', 'email', 'https://www.googleapis.com/auth/gmail.readonly'];
  const run = await start({ ...startQuery, scopes: readOnly.join(' ') });
  assert.equal(run.last.result.status, 200, JSON.stringify(run.last));
  assert.equal(new URL(run.last.result.body.authorize_url).searchParams.get('scope'), readOnly.join(' '));
  assert.deepEqual(typed(run, settings.pending.type)[0].value.scopes, readOnly);
  const refused = await start({ ...startQuery, scopes: 'https://mail.google.com/' });
  assert.equal(refused.last.result.status, 400);
  assert.equal(typed(refused, settings.pending.type).length, 0);
});

test('any other route or method is not found', async () => {
  const run = await route('/connect/elsewhere', {}, { records: seeded });
  assert.deepEqual(run.last.result, { status: 404, body: { error: settings.words.not_found } });
});

test('every switched-on service has a hosted sign-in descriptor whose callback is this route, and its rows agree with it', () => {
  const byId = new Map(rows.records.map(record => [record.payload.id, record.payload]));
  for (const [vendor, service] of Object.entries(settings.services)) {
    const descriptor = descriptorOf(vendor);
    assert.ok(descriptor, `${vendor} has a descriptor`);
    const { acquire } = descriptor;
    assert.ok(settings.flows.includes(acquire.flow), `${vendor} signs in by a flow these routes run`);
    assert.equal(acquire.redirect.transport, 'hosted');
    assert.equal(acquire.redirect.path, settings.routes.callback, `${vendor} comes back to the callback route`);
    const [first, ...following] = service.trade.map(id => byId.get(id));
    assert.ok(first, `${vendor}'s first trade row is in this folder`);
    assert.equal(first.invoke.url, acquire.token_url);
    assert.equal(first.invoke.connection.vendor, vendor);
    // client_auth form sends the app's id and secret as form fields; basic sends its id and the held Basic credentials.
    const secretName = acquire.client_auth === 'basic' ? acquire.hosted_client.basic_name : acquire.hosted_client.secret_name;
    assert.deepEqual(first.invoke.credential_injections.map(item => item.secret_name), [acquire.hosted_client.id_name, secretName]);
    if (acquire.client_auth === 'basic') assert.deepEqual(first.invoke.credential_injections[1].placement, { kind: 'header', name: 'Authorization', prefix: 'Basic ' });
    for (const item of first.invoke.credential_injections) assert.deepEqual(item.hosts, [new URL(acquire.token_url).hostname]);
    assert.equal(Boolean(first.input_schema.properties.code_verifier), Boolean(acquire.pkce), `${vendor}: the verifier goes where PKCE is asked`);
    assert.equal(following.length, (acquire.then ?? []).length, `${vendor}: one row per following trade`);
    following.forEach((step, index) => {
      assert.equal(step.invoke.connection.vendor, vendor);
      assert.equal(step.invoke.url.split('?')[0], acquire.then[index].url);
    });
    const last = following.at(-1) ?? first;
    assert.ok(last.invoke.reply_holds_values.some(item => item.from === 'access_token' && item.keep_as_field === (acquire.fills_field ?? 'access_token')), `${vendor}: the last trade keeps the access token`);
    if (acquire.refresh) assert.ok(first.invoke.reply_holds_values.some(item => item.keep_as_field === (acquire.refresh.field ?? 'refresh_token')));
  }
  assert.deepEqual([...new Set(row.invoke.records.runs)].sort(), [...new Set(Object.values(settings.services).flatMap(service => [...service.trade, service.verify.tool, ...(service.choice ? [service.choice.tool] : [])]))].sort());
});

// Facebook Page and Threads: each is a descriptor already, switched on here by a row of services and its trade rows.
const seededMeta = [...seeded, signInApp('facebook-login-client-id', '2234567890'), signInApp('threads-login-client-id', '3234567890')];
const META_APP_ROWS = 4;
const signedIn = async (query, runs) => {
  const started = await start(query, seededMeta);
  assert.equal(started.last.result.status, 200, JSON.stringify(started.last));
  return { started, run: await callback({ state: stateOf(started), code: CODE }, started.kept, runs) };
};
const metaQuery = service => ({ service, status: 'Active', read_only: 'false', can_send_as: 'true', can_be_primary: 'true' });

test('a Facebook sign-in asks the Page scopes, trades the code twice, reads the Pages it reaches and names the one Page', async () => {
  const { started, run } = await signedIn(metaQuery('facebook-messenger'));
  const address = new URL(started.last.result.body.authorize_url);
  const acquire = descriptorOf('facebook-messenger').acquire;
  assert.equal(`${address.origin}${address.pathname}`, acquire.authorize_url);
  assert.equal(address.searchParams.get('client_id'), '2234567890');
  assert.equal(address.searchParams.get('scope'), acquire.scopes.join(','));
  assert.equal(address.searchParams.get('auth_type'), 'rerequest');
  assert.equal(run.last.result.status, 200, JSON.stringify(run.last));
  assert.deepEqual(run.runs.map(item => item.tool), [...settings.services['facebook-messenger'].trade, settings.services['facebook-messenger'].verify.tool, settings.services['facebook-messenger'].choice.tool]);
  const [written] = typed(run, 'record:service-connection').filter(record => record.value.kind === settings.account_kind);
  assert.equal(written.value.account_label, 'Made Up Page');
  assert.deepEqual(written.value.plain, { page_id: '1000000000000001' });
  assert.equal(written.value.vendor, 'facebook-messenger');
  assert.doesNotMatch(JSON.stringify(run.last), /made-up-(access|short)/);
});

test('a Facebook sign-in that reaches no Page saves nothing', async () => {
  const { run } = await signedIn(metaQuery('facebook-messenger'), toolRuns({ pages: [] }));
  assert.equal(run.last.result.status, 400, JSON.stringify(run.last));
  assert.match(run.last.result.body, /does not reach any account/);
  assert.equal(typed(run, 'record:service-connection').length, META_APP_ROWS);
});

test('a Facebook sign-in that reaches several Pages connects the Page named beforehand, and keeps only that Page\'s token', async () => {
  const { run } = await signedIn({ ...metaQuery('facebook-messenger'), account: 'another made up page' }, toolRuns({ pages: twoPages }));
  assert.equal(run.last.result.status, 200, JSON.stringify(run.last));
  const kept = run.runs.at(-1);
  assert.equal(kept.tool, 'tool:keep-a-facebook-pages-token');
  assert.equal(kept.input.page_id, '1000000000000002');
  assert.match(kept.input.connection.connection_id, /^service_connection:facebook-messenger:/);
  const [written] = typed(run, 'record:service-connection').filter(record => record.value.kind === settings.account_kind);
  assert.equal(written.value.account_label, 'Another Made Up Page');
  assert.deepEqual(written.value.plain, { page_id: '1000000000000002' });
});

test('a Facebook sign-in that reaches several Pages with none named, or none of the one named, saves nothing and keeps no Page token', async () => {
  for (const account of [undefined, 'A Page It Does Not Reach']) {
    const { run } = await signedIn({ ...metaQuery('facebook-messenger'), ...(account ? { account } : {}) }, toolRuns({ pages: twoPages }));
    assert.equal(run.last.result.status, 400, JSON.stringify(run.last));
    assert.match(run.last.result.body, /more than one account/);
    assert.equal(typed(run, 'record:service-connection').length, META_APP_ROWS);
    assert.ok(!run.runs.some(item => item.tool === 'tool:keep-a-facebook-pages-token'));
  }
});

test('a Threads sign-in trades the code for a short token then a long one, checks the profile and keeps its id in the open', async () => {
  const { started, run } = await signedIn(metaQuery('threads'));
  const address = new URL(started.last.result.body.authorize_url);
  const acquire = descriptorOf('threads').acquire;
  assert.equal(`${address.origin}${address.pathname}`, acquire.authorize_url);
  assert.equal(address.searchParams.get('client_id'), '3234567890');
  assert.equal(address.searchParams.get('scope'), acquire.scopes.join(','));
  assert.equal(run.last.result.status, 200, JSON.stringify(run.last));
  assert.deepEqual(run.runs.map(item => item.tool), [...settings.services.threads.trade, settings.services.threads.verify.tool]);
  const [written] = typed(run, 'record:service-connection').filter(record => record.value.kind === settings.account_kind);
  assert.equal(written.value.account_label, 'made_up_threads_account');
  assert.deepEqual(written.value.plain, { threads_user_id: '17800000000000002' });
});

test('the Threads check asks only the Threads host, with the held token placed in the query, and renews it before it lapses', () => {
  const check = rowOf(socialRows, 'tool:check-the-threads-connection');
  assert.equal(check.invoke.url, 'https://graph.threads.net/v1.0/me');
  assert.equal(check.invoke.connection.vendor, 'threads');
  assert.equal(check.read_only, true);
  assert.deepEqual(check.invoke.credential_injections.map(item => [item.field_id, item.hosts, item.placement.kind, item.placement.name]), [['access_token', ['graph.threads.net'], 'query', 'access_token']]);
  assert.equal(check.invoke.refresh.token_url, 'https://graph.threads.net/refresh_access_token');
});

test('the Facebook Page list holds no token, and the keep row keeps one named Page\'s token as the connection\'s page_access_token', () => {
  const byId = new Map(rows.records.map(record => [record.payload.id, record.payload]));
  const service = settings.services['facebook-messenger'];
  const pagesRow = byId.get(service.verify.tool);
  assert.equal(pagesRow.read_only, true);
  assert.equal(new URL(pagesRow.invoke.url).hostname, 'graph.facebook.com');
  assert.deepEqual(pagesRow.invoke.credential_injections.map(item => [item.field_id, item.hosts]), [['user_access_token', ['graph.facebook.com']]]);
  assert.equal(pagesRow.invoke.query.fields.const, 'id,name');
  assert.equal(pagesRow.invoke.reply_holds_values, undefined);
  const keepRow = byId.get(service.choice.tool);
  assert.equal(new URL(keepRow.invoke.url).hostname, 'graph.facebook.com');
  assert.deepEqual(keepRow.invoke.credential_injections.map(item => [item.field_id, item.hosts]), [['user_access_token', ['graph.facebook.com']]]);
  assert.deepEqual(keepRow.invoke.reply_holds_values, [{ from: 'access_token', keep_as_field: 'page_access_token' }]);
  assert.ok(row.invoke.records.runs.includes(service.choice.tool));
});

test('the Facebook Page sign-in asks for posting, comment and message scopes, and no ads, lead or business scope unless a record of this service declares it needs it', () => {
  const { scopes } = descriptorOf('facebook-messenger').acquire;
  const needed = new Set(descriptorFile.things
    .filter(thing => JSON.stringify(thing.payload).includes('facebook-messenger'))
    .flatMap(thing => thing.payload.needs_scopes ?? []));
  const beyond = scopes.filter(scope => /ads|business|leads/.test(scope) && !needed.has(scope));
  assert.deepEqual(beyond, [], 'ads, lead and business scopes are asked only where a record declares needs_scopes for them');
  for (const scope of ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts', 'pages_read_user_content', 'pages_manage_engagement', 'pages_messaging']) assert.ok(scopes.includes(scope), `${scope} is asked`);
});
