// tools/plan-trips/do-work/rank-open-trip-things.mjs
//
// The command of tool:rank-open-trip-things. One JSON request on standard input:
//   { policy: { priority_order, lanes }, lanes: [{ id, label?, rows: [...] }], trip_name? }
// and { result: { trip_name, items, focus, later, lanes, skipped } } out. See read-data/trip-things.mjs.
import { runAsMain } from '../read-data/run-as-main.mjs';
import { rankOpenTripThings } from '../read-data/trip-things.mjs';

await runAsMain(import.meta.url, rankOpenTripThings);
