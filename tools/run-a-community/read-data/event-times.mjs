// Recurring event times from the immutable community-activity source named in
// source-baselines/events.provenance.json; copied before this fresh active core.
import { addCivilDays, addCivilMonths, instantAt, timeZoneName, wallTimeOf } from '../../run-work-later-or-on-a-repeat/do-work/timed-action.mjs';

const REPEATS = { day: 1, week: 7 };

export const activityMethods = {
  // An event that repeats is one event per time, sharing a series id; each is answered on its own. Every time keeps the
  // first one's wall time in the zone it is put on in (repeats.time_zone), so a weekly 18:00 stays 18:00 across a clock
  // change: a time the clocks skip moves to the first minute that exists, one that happens twice is the first.
  eventTimes(startsAt, endsAt, repeats) {
    const start = Date.parse(startsAt);
    const length = endsAt ? Date.parse(endsAt) - start : 0;
    const one = [{ starts_at: new Date(start).toISOString(), ends_at: endsAt ? new Date(start + length).toISOString() : null }];
    if (!repeats) return one;
    if (repeats.every !== 'month' && !Object.hasOwn(REPEATS, repeats.every)) throw new Error('repeats.every is day, week or month.');
    const zone = timeZoneName({ value: repeats.time_zone });
    if (!zone) throw new Error('repeats.time_zone names the zone the event is put on in, like America/New_York, so each time keeps its clock time.');
    const count = Math.min(Math.max(Number(repeats.count) || 1, 1), 52);
    const first = wallTimeOf({ instantMs: start, zone });
    return [...Array(count)].map((_, index) => {
      const date = repeats.every === 'month' ? addCivilMonths({ date: first.date, months: index }) : addCivilDays({ date: first.date, days: index * REPEATS[repeats.every] });
      const at = instantAt({ date, time: first.time, zone, options: { gap: 'next-valid', fold: 'earlier' } }) + (start % 60_000);
      return { starts_at: new Date(at).toISOString(), ends_at: endsAt ? new Date(at + length).toISOString() : null };
    });
  },
};

export const eventTimes = (...args) => activityMethods.eventTimes(...args);
