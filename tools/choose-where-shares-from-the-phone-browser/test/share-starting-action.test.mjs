import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { actionForAddress, routingAction, siteAction, startingAction } from '../read-data/share-starting-action.mjs';

test('the longest whole host wins without changing supplied defaults', () => {
  const defaults = Object.freeze([
    Object.freeze({ host_suffix: 'example.com', action_id: 'broad' }),
    Object.freeze({ host_suffix: 'video.example.com', action_id: 'specific' }),
  ]);
  assert.equal(actionForAddress(defaults, 'https://www.video.example.com/watch'), 'specific');
  assert.equal(actionForAddress(defaults, 'https://EXAMPLE.COM./'), 'broad');
  for (const address of ['https://evilexample.com/', 'https://example.com.evil.test/',
    'https://example.com@example.test/', 'https://user:pass@example.com/', 'not an address']) {
    assert.equal(actionForAddress(defaults, address), null, address);
  }
  assert.deepEqual(defaults.map(row => row.action_id), ['broad', 'specific']);
});

test('the first matching shared address selects only a supplied current action', () => {
  const actions = [{ id: 'first' }, { id: 'broad' }, { id: 'specific' }];
  const defaults = [{ host_suffix: 'example.com', action_id: 'broad' },
    { host_suffix: 'video.example.com', action_id: 'specific' }];
  assert.equal(siteAction(['https://unrelated.test', 'https://example.com', 'https://video.example.com'], actions, defaults), actions[1]);
  assert.equal(siteAction(['https://video.example.com', 'https://example.com'], actions, defaults), actions[2]);
  assert.equal(siteAction(['https://example.com'], [], defaults), null);
  assert.equal(siteAction(['https://example.com'], actions, [{ host_suffix: 'example.com', action_id: 'another-account' }]), null);
});

test('starting and routing preserve the saved-site, route and first-action fallbacks', () => {
  const actions = [{ id: 'first' }, { id: 'saved' }];
  const defaults = [{ host_suffix: 'example.com', action_id: 'saved' }];
  const route = { id: 'route' };
  assert.equal(startingAction(['https://example.com'], actions, defaults), actions[1]);
  assert.equal(startingAction([], actions, defaults), actions[0]);
  assert.equal(startingAction([], [], defaults), null);
  assert.equal(routingAction(['https://example.com'], actions, defaults, route), actions[1]);
  assert.equal(routingAction([], actions, defaults, route), route);
  assert.equal(routingAction([], actions, defaults, null), actions[0]);
  assert.equal(routingAction([], [], defaults, null), null);
});

test('the public selector and its shared host owner bundle for the browser', async () => {
  const entryPoint = fileURLToPath(new URL('../read-data/share-starting-action.mjs', import.meta.url));
  const result = await build({ entryPoints: [entryPoint], bundle: true, write: false, platform: 'browser', format: 'esm' });
  const bundle = result.outputFiles[0].text;
  for (const name of ['actionForAddress', 'siteAction', 'startingAction', 'routingAction']) assert.match(bundle, new RegExp(name));
  assert.doesNotMatch(bundle, /from ['"]node:|require\(['"](?:node:|fs|path)/);
});
