// test/touch-page-zoom.test.mjs
// A finger never zooms the whole page: the page-wide touch look keeps the browser's own pinch and double-tap zoom off
// every surface that does not take pinch itself (the owner, 2026-10-03: sliding a thumb across the tabs, then a second
// finger, zoomed the app and left it cut off at the right).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL(import.meta.resolve('../show/touch.css')), 'utf8');

test('the page body allows only panning, so the browser never zooms the page', () => {
  const rule = css.match(/:where\(body\.screen-look-page\)\s*\{([^}]*)\}/);
  assert.ok(rule, 'touch.css names the page body');
  assert.match(rule[1], /touch-action:\s*pan-x pan-y/);
});

test('a surface that takes pinch itself still says so (the arrangement and drag handles keep their own touch-action)', () => {
  const arranger = readFileSync(new URL(import.meta.resolve('../show/split-arranger.css')), 'utf8');
  assert.match(arranger, /\[data-arranger='split-tree'\]\s*\{[^}]*touch-action:\s*pan-x pan-y/);
  assert.match(css, /\[role="separator"\]\[tabindex\]\s*\{\s*touch-action:\s*none/);
});

test('no controls rule reintroduces pinch-zoom on the body', () => {
  assert.ok(!/body[^{]*\{[^}]*touch-action:\s*(manipulation|auto)/.test(css));
});
