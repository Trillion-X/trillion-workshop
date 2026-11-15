import assert from 'node:assert/strict';
import test from 'node:test';
import { openNotice } from '../src/open-notice.mjs';

test('opens a clicked notice before clearing it and marking it read', async () => {
  const order = [];
  const notice = { id: 'n1', open: '/file/1f:abc' };
  const opened = await openNotice('n1', {
    get: async id => { order.push(`get:${id}`); return notice; },
    open: async path => { order.push(`open:${path}`); },
    clear: async id => { order.push(`clear:${id}`); },
    forget: async id => { order.push(`forget:${id}`); },
    markRead: async row => { order.push(`read:${row.id}`); },
  });
  assert.equal(opened, true);
  assert.deepEqual(order, ['get:n1', 'open:/file/1f:abc', 'read:n1', 'clear:n1', 'forget:n1']);
});

test('keeps a notice available when its read receipt fails', async () => {
  const order = [];
  await assert.rejects(openNotice('n1', {
    get: async () => ({ id: 'n1', open: '/file/1f:abc' }),
    open: async () => order.push('open'),
    markRead: async () => { order.push('read'); throw new Error('read receipt failed'); },
    clear: async () => order.push('clear'),
    forget: async () => order.push('forget'),
  }), /read receipt failed/);
  assert.deepEqual(order, ['open', 'read']);
});

test('keeps a notice available when opening its destination fails', async () => {
  const order = [];
  await assert.rejects(openNotice('n1', {
    get: async () => ({ id: 'n1', open: '/file/1f:abc' }),
    open: async () => { order.push('open'); throw new Error('tab could not be opened'); },
    clear: async () => order.push('clear'),
    forget: async () => order.push('forget'),
    markRead: async () => order.push('read'),
  }), /tab could not be opened/);
  assert.deepEqual(order, ['open']);
});

test('does nothing after the browser has already dropped the notice', async () => {
  let opens = 0;
  const opened = await openNotice('gone', {
    get: async () => null,
    open: async () => { opens += 1; },
    clear: async () => {}, forget: async () => {}, markRead: async () => {},
  });
  assert.equal(opened, false);
  assert.equal(opens, 0);
});
