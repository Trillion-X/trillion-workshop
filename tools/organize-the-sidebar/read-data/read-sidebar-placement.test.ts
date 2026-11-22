import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SIDEBAR_DEFAULT_W, SIDEBAR_MAX_W, SIDEBAR_MIN_W, decodeSidebarPlacementValue } from './read-sidebar-placement.ts';

test('a stored width inside the bounds is kept as stored', () => {
  assert.equal(decodeSidebarPlacementValue({ width: 300 }).width, 300);
});

test('a stored width past the widest bound is clamped to it on read', () => {
  assert.equal(decodeSidebarPlacementValue({ width: 9999 }).width, SIDEBAR_MAX_W);
});

test('a stored width narrower than the narrowest bound is clamped to it on read', () => {
  assert.equal(decodeSidebarPlacementValue({ width: 10 }).width, SIDEBAR_MIN_W);
});

test('a placement with no stored width starts at the default width', () => {
  assert.equal(decodeSidebarPlacementValue({ position: 'left' }).width, SIDEBAR_DEFAULT_W);
});

test('the starting width sits inside the bounds', () => {
  assert.ok(SIDEBAR_MIN_W <= SIDEBAR_DEFAULT_W && SIDEBAR_DEFAULT_W <= SIDEBAR_MAX_W);
});
