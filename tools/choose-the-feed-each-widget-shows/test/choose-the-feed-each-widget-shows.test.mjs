// Tests for tool:choose-the-feed-each-widget-shows. The widgets and row counts are made up.

import assert from 'node:assert/strict';
import test from 'node:test';

import { chooseTheFeedEachWidgetShows } from '../do-work/choose-the-feed-each-widget-shows.mjs';

const widgets = [
  { widget_id: 'small-1', size: 'small' },
  { widget_id: 'medium-1', size: 'medium' },
  { widget_id: 'large-1', size: 'large' },
  { widget_id: 'xl-1', size: 'extra_large' },
];

test('an unpicked widget takes the surface feed at its size place, the surface order', () => {
  const result = chooseTheFeedEachWidgetShows({ surface: 'widgets', widgets });
  assert.deepEqual(result.feeds_in_order.slice(0, 4), ['habits', 'waiting', 'running', 'today']);
  assert.deepEqual(result.widgets.map(row => row.feed), ['habits', 'waiting', 'running', 'today']);
  assert.ok(result.widgets.every(row => row.source === 'unpicked'));
});

test('only feeds with rows are taken first, wrapping round the places', () => {
  const result = chooseTheFeedEachWidgetShows({ surface: 'widgets', widgets, rows: { waiting: 2, today: 1 } });
  assert.deepEqual(result.feeds_in_order, ['waiting', 'today']);
  assert.deepEqual(result.widgets.map(row => row.feed), ['waiting', 'today', 'waiting', 'today']);
});

test('a picked feed is shown whatever the size, and a feed the surface does not list is still allowed', () => {
  const result = chooseTheFeedEachWidgetShows({ surface: 'widgets', widgets: [{ widget_id: 'w', size: 'small', picked_feed: 'habits' }] });
  assert.deepEqual(result.widgets[0], { widget_id: 'w', size: 'small', feed: 'habits', source: 'picked' });
  const off = chooseTheFeedEachWidgetShows({ surface: 'watch', widgets: [{ widget_id: 'w', size: 'small', picked_feed: 'waiting' }] });
  assert.equal(off.widgets[0].feed, 'waiting');
});

test('a surface with no feeds gives no feed, and an unknown surface is refused', () => {
  assert.throws(() => chooseTheFeedEachWidgetShows({ surface: 'nowhere', widgets }), /surface/);
  assert.throws(() => chooseTheFeedEachWidgetShows({ surface: 'widgets', widgets: [{ widget_id: 'w', size: 'huge' }] }), /size/);
  assert.throws(() => chooseTheFeedEachWidgetShows({ surface: 'widgets', widgets: [{ widget_id: 'w', size: 'small', picked_feed: 'no-such' }] }), /no feed/);
  assert.throws(() => chooseTheFeedEachWidgetShows(['x']), /one JSON/);
});
