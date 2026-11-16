// tools/read-glance-feeds/do-work/read-glance-feeds.mjs
//
// The tool's command. The rows the feeds read (the person's habit, waiting-on-you, pursuit, told-the-person and ai-job
// rows) come in the request as `records`, read by the person's AI from their store; the reader lists them the way it
// would list a door, so no records door is opened and nothing is kept.
import { readGlanceFeeds as readFeeds } from '../read-data/glance-feeds.mjs';
import { rowsAsList } from '../../record-graph/read-data/rows-as-list.mjs';

export const readGlanceFeeds = (input = {}) => readFeeds(input, { door: rowsAsList(input.records) });
