import test from 'node:test';
import assert from 'node:assert/strict';
import { renderAView } from '../../compare-two-movements-side-by-side/tests/render-a-view.ts';

const entry = new URL('../show/marketing-page/Library.tsx', import.meta.url).pathname;
const tabs = [{ id: 'fh', label: 'Forehand Master Class' }, { id: 'diag', label: 'Diagnostic Library' }];
const entries = [
  { id: 'e1', tab: 'fh', title: 'Master the Forehand in 9 Steps', meta: 'Master Class - 38 minutes', duration: '38 minutes', still: '/e1.jpg', video: '/e1.mp4' },
  { id: 'e2', tab: 'fh', title: 'Forehand breakdown', meta: 'Master Class - 38 minutes', still: '/e2.jpg' },
  { id: 'e3', tab: 'diag', title: 'Diagnose your swing', still: '/e3.jpg' },
];

test('the first shelf and its first entry are drawn when none is chosen: tabs, large entry, side list of its own shelf only', async () => {
  const html = await renderAView(entry, { tabs, entries, intro: 'Everything you learn', browserTitle: 'Video library', countLabel: '{count} entries' });
  assert.match(html, /Forehand Master Class/);
  assert.match(html, /Diagnostic Library/);
  assert.match(html, /data-library-preview="e1"/);
  assert.match(html, /src="\/e1\.mp4"/);
  assert.match(html, /data-library-entry="e1"/);
  assert.match(html, /data-library-entry="e2"/);
  assert.doesNotMatch(html, /data-library-entry="e3"/);
  assert.match(html, /2 entries/);
  assert.match(html, /38 minutes/);
});

test('the chosen shelf and entry come from the host, and the chosen tab and entry are marked', async () => {
  const html = await renderAView(entry, { tabs, entries, selectedTab: 'diag', selectedId: 'e3' });
  assert.match(html, /data-library-preview="e3"/);
  assert.doesNotMatch(html, /data-library-entry="e1"/);
  assert.match(html, /data-active="true"[^>]*data-library-selector="diag"|data-library-selector="diag"[^>]*data-active="true"/);
  const second = await renderAView(entry, { tabs, entries, selectedId: 'e2' });
  assert.match(second, /data-library-preview="e2"/);
});

test('an entry with a picture and no video shows the picture; a shelf with none draws an empty frame, not an error', async () => {
  assert.match(await renderAView(entry, { tabs, entries, selectedId: 'e2' }), /src="\/e2\.jpg"/);
  const html = await renderAView(entry, { tabs, entries: [], selectedTab: 'fh' });
  assert.match(html, /data-library-browser/);
  assert.doesNotMatch(html, /data-library-preview="/);
});

test('the library is pure: no script', async () => {
  assert.doesNotMatch(await renderAView(entry, { tabs, entries }), /<script/);
});

// The chosen entry's title sits on its picture under a dark shade, and the part's words are white by their own rules (a Text's
// default ink would be lost on the picture).
test('the chosen entry draws a shade under its title', async () => {
  const html = await renderAView(entry, { tabs, entries });
  assert.match(html, /previewShade/);
});
