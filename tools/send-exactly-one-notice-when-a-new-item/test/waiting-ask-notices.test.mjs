import assert from 'node:assert/strict';
import test from 'node:test';
import { noticesForNewWaitingRows } from '../src/waiting-ask-notices.mjs';

const row = { id: 'connect-account', values: { what: 'Connect the account', why: 'The work needs its sign-in.',
  where: 'https://app.gettrillion.ai/connections', status: 'Waiting' } };

test('a new Waiting row opens its own destination and retrying or finishing it sends nothing', () => {
  const notices = noticesForNewWaitingRows({ kept: [row] });
  assert.deepEqual(notices, [{ key: 'waiting-ask:connect-account', kind: 'needs-you-request',
    title: 'Connect the account', body: 'The work needs its sign-in.',
    open: 'https://app.gettrillion.ai/connections',
    refs: { card: 'asks:connect-account', open: 'https://app.gettrillion.ai/connections' } }]);
  assert.deepEqual(noticesForNewWaitingRows({ before: new Map([[row.id, row.values]]), kept: [row] }), []);
  assert.deepEqual(noticesForNewWaitingRows({ kept: [{ ...row, values: { ...row.values, status: 'Done' } }] }), []);
});

test('an ask without a usable address opens its own Waiting row', () => {
  assert.equal(noticesForNewWaitingRows({ kept: [{ id: 'open-app', values: { what: 'Open the app', where: 'on your Mac' } }] })[0].open,
    '/lists/waiting-on-you/open-app');
});
