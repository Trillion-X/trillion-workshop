// src/workspace/first-use-tour.mjs
//
// Whether tours that start by themselves (the welcome tour, what's new, a screen's first-visit tour) may show on the
// page an address opened. The address is what the person came for, so a tour never covers it: an address that names a
// screen (its path, or a query field a screen's `route_query` names, such as a meeting link) holds them for that page,
// and they wait for an ordinary open of Trillion. A screen's row tunes this as DATA: `auto_start_walkthroughs: false`
// holds them even on the home address (the Share sheet's /sharing), `true` lets them show over an arrival at it.
// A tour someone asks for by name (?tour=, Show me) or a step something needs is never held. A take-me-there address
// (its `layout` and `tour` fields, src/take-me-there.json) is one the person came for too: the layout and tour it names
// open there, so the welcome tour never draws over the tour the link asked for.
import surfaces from './screens.mjs';
import takeMeThere from '../take-me-there.json' with { type: 'json' };
import { screenAt, screensOfQuery } from './addresses.mjs';

export function selfStartingToursMayShow(pathname, search = '') {
  const query = new URLSearchParams(search);
  if (Object.values(takeMeThere.link).some(field => ['layout', 'tour'].includes(field) && query.get(field))) return false;
  const opened = screenAt(surfaces.surfaces, pathname);
  const arrived = [...(opened ? [opened.row] : []), ...screensOfQuery(surfaces.surfaces, search).map(asked => asked.row)];
  if (arrived.some(row => row.auto_start_walkthroughs === false)) return false;
  // The home address alone names nothing; every other arrival holds them unless each screen it opens lets them show.
  return arrived.every(row => row.auto_start_walkthroughs === true);
}
