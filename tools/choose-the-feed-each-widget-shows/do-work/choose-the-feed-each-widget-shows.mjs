// tools/choose-the-feed-each-widget-shows/do-work/choose-the-feed-each-widget-shows.mjs
//
// tool:choose-the-feed-each-widget-shows, run as a function in the tool container:
//
//   node do-work/choose-the-feed-each-widget-shows.mjs < <the input as JSON>
//
// and prints { result } on its last line (or { error } with exit 1). For each widget on a surface, it says which feed the
// widget shows: the feed the person picked for it, or, when none was picked, the feed its size takes from the surface's
// feeds in order. The caller hands in the widgets and the feeds that have rows; nothing is read, kept or drawn here.
//
// Port of old trillion ios/Activity/GlanceFeeds.swift `GlanceFeed.unpicked(at:)` (commit 38a3d8ec5e): the surface's feeds
// in order, those with rows kept (all of them before any row is kept), the one at the widget's place, wrapping round.
// The place is the widget's size: small 0, medium 1, large 2, extra large 3. The surfaces and feed ids are DATA in
// read-glance-feeds (records/glance-feeds.json in old trillion).
import { readFileSync } from 'node:fs';
import glance from '../../read-glance-feeds/read-data/glance-feeds.json' with { type: 'json' };

const PLACE = { small: 0, medium: 1, large: 2, extra_large: 3 };
const feedIds = new Set(glance.feeds.map(feed => feed.id));
const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export function chooseTheFeedEachWidgetShows(input) {
  if (!object(input)) throw new Error('Send one JSON object: { surface, widgets, rows? }.');
  const order = glance.surfaces[input.surface];
  if (!Array.isArray(order)) throw new Error(`surface names a surface with feeds: ${Object.keys(glance.surfaces).join(', ')}.`);
  if (!Array.isArray(input.widgets) || !input.widgets.every(widget => object(widget) && typeof widget.widget_id === 'string' && widget.widget_id)) {
    throw new Error('widgets is a list of { widget_id, size, picked_feed? }.');
  }
  // Rows counts per feed: a feed with rows is one the widget may show first; with no counts given, every feed counts.
  const rows = input.rows ?? null;
  if (rows !== null && !object(rows)) throw new Error('rows, when supplied, is { feed_id: number of rows kept }.');
  const withRows = order.filter(id => rows === null || (Number.isFinite(rows[id]) && rows[id] > 0));
  const shown = withRows.length ? withRows : order;
  const widgets = input.widgets.map(widget => {
    if (!Object.hasOwn(PLACE, widget.size)) throw new Error(`size is one of ${Object.keys(PLACE).join(', ')}.`);
    if (widget.picked_feed !== undefined && widget.picked_feed !== null) {
      if (!feedIds.has(widget.picked_feed)) throw new Error(`picked_feed names no feed: ${widget.picked_feed}.`);
      return { widget_id: widget.widget_id, size: widget.size, feed: widget.picked_feed, source: 'picked' };
    }
    const feed = shown.length ? shown[PLACE[widget.size] % shown.length] : null;
    return { widget_id: widget.widget_id, size: widget.size, feed, source: feed ? 'unpicked' : 'none' };
  });
  return { surface: input.surface, feeds_in_order: shown, widgets };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  try {
    process.stdout.write(JSON.stringify({ result: chooseTheFeedEachWidgetShows(JSON.parse(readFileSync(0, 'utf8') || '{}')) }) + '\n');
  } catch (error) {
    process.stdout.write(JSON.stringify({ error: error.message }) + '\n');
    process.exitCode = 1;
  }
}
