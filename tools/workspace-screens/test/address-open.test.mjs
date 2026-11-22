// tools/workspace-screens/test/address-open.test.mjs
//
// An address that names a tool's own screen opens it once that screen is offered, even when the tools' answer arrived
// after the page's first read (the first read offers no tool screen, so a fallback to Home was shown before).
import test from 'node:test';
import assert from 'node:assert/strict';
import { addressOpener } from '../web/src/workspace/address-open.mjs';
import { screenAt } from '../web/src/workspace/addresses.mjs';

const home = { id: 'screen.home', route_paths: ['/'] };
const grants = { id: 'screen.grants', route_paths: ['/grants'], surface_input: { screen: 'grants' } };
const address = '/grants';
const search = '?computer=box-1&ask=abc';

test('an address opens nothing while its tool screen is not offered yet (the first read, before the tools answer)', () => {
  const opener = addressOpener();
  assert.equal(screenAt([home], address, search), null);
  assert.deepEqual(opener([home], address, search), []);
});

test('the same address opens its tool screen once that screen is offered, with the address query as its input', () => {
  const opener = addressOpener();
  opener([home], address, search);
  const requests = opener([home, grants], address, search);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].id, 'screen.grants');
  assert.equal(requests[0].surfaceInput.screen, 'grants');
  assert.equal(requests[0].surfaceInput.ask, 'abc');
  assert.equal(requests[0].surfaceInput.computer, 'box-1');
});

test('an address opens its screens only once: a later offer does not open them again', () => {
  const opener = addressOpener();
  assert.equal(opener([home, grants], address, search).length, 1);
  assert.deepEqual(opener([home, grants], address, search), []);
});

test('an address that the first read already answered is not reopened when the tools arrive', () => {
  const opener = addressOpener();
  assert.equal(opener([home, grants], address, search).length, 1);
  assert.deepEqual(opener([home], address, search), []);
});
