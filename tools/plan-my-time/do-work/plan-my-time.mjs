// tools/plan-my-time/do-work/plan-my-time.mjs
//
// The Workshop tool "Plan my time": places the person's tasks into their free time and judges their meetings against
// their pursuits, the way an auto-scheduling calendar does, but ordered by what serves the person's pursuits. Pure: it
// takes one request and returns the plan (run as a function by tools/records-door/do-work/run-an-export.mjs). It changes
// no calendar; callers apply the result through their own calendar actions.
//
// Invariants:
// - Every policy is DATA in rules.json (chunk sizes, stale days, breaks, deadline weights, pursuit weights); the request
//   may override any of them under `rules`.
// - Free time = the weekly schedule in the person's time zone, minus busy events, blocks and placed work.
// - Order: ASAP, then hard deadlines, then value (pursuit weight x priority), then due date; a task waits for its blockers.
// - A task is split only into pieces of at least its minimum block; a hard deadline may use time outside the schedule.
// - Every eligible task comes back with a fit: on_track, past_due, unfit_later or unfit_past_due, and why.
// - A meeting that serves no pursuit and keeps higher-value work from fitting is proposed for decline, never declined here.
// - A task may name a schedule (rules.schedules or request.schedules); rigid preferred starts are placed first, exactly.
// - Each day's planned load is reported against rules.daily_cap_minutes, with a bump list ordered lowest value first.
// - Busy events that are declined, all-day or shown as free do not take time.
import { readFileSync } from 'node:fs';

const RULES = JSON.parse(readFileSync(new URL('../read-data/rules.json', import.meta.url), 'utf8'));
const MIN = 60_000;
const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

// The wall-clock offset of `zone` at instant `ms`, in minutes, from Intl (no time zone table of our own).
function offsetMinutes(zone, ms) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(new Date(ms)).filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]));
  return Math.round((Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - ms) / MIN);
}
// The instant of wall-clock `minutes` past midnight of local day (y, m, d) in `zone`.
function localInstant(zone, y, m, d, minutes) {
  const guess = Date.UTC(y, m, d) + minutes * MIN;
  const first = guess - offsetMinutes(zone, guess) * MIN;
  return guess - offsetMinutes(zone, first) * MIN;
}
// The person's local calendar date (YYYY-MM-DD) and weekday at instant `ms`.
function localDay(zone, ms) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'long' })
    .formatToParts(new Date(ms)).map(part => [part.type, part.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, weekday: p.weekday.toLowerCase() };
}
const clock = text => { const [h, mm] = String(text).split(':').map(Number); return h * 60 + (mm || 0); };

// The schedule's working intervals from `from` for `days` days, as [start, end] instants.
function scheduleIntervals(schedule, zone, from, days, endOfDay = {}) {
  const out = [];
  const start = new Date(from + offsetMinutes(zone, from) * MIN);
  for (let i = 0; i <= days; i++) {
    const day = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate() + i));
    for (const range of schedule[DAYS[day.getUTCDay()]] ?? []) {
      const s = localInstant(zone, day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), clock(range.from));
      const date = day.toISOString().slice(0, 10);
      const to = endOfDay[date] != null ? Math.min(clock(range.to), clock(endOfDay[date])) : clock(range.to);
      const e = localInstant(zone, day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), to);
      if (e > s) out.push([s, e]);
    }
  }
  return out;
}
// Intervals minus busy intervals.
function subtract(intervals, busy) {
  let free = intervals.map(([s, e]) => [s, e]);
  for (const [bs, be] of busy) {
    free = free.flatMap(([s, e]) => (be <= s || bs >= e ? [[s, e]] : [[s, bs], [be, e]].filter(([a, b]) => b > a)));
  }
  return free.sort((a, b) => a[0] - b[0]);
}
const ms = text => (text == null ? null : Date.parse(text));
const iso = value => new Date(value).toISOString();

// The command that runs this function hands it a second argument (the person's records door); the plan uses only its request.
export function planMyTime(request) {
  if (request === null || typeof request !== 'object' || Array.isArray(request)) throw new Error('The request must be an object with tasks, and optionally busy events and meetings.');
  const rules = { ...RULES, ...(request.rules ?? {}) };
  const now = ms(request.now) ?? Date.now();
  const zone = request.time_zone ?? 'UTC';
  const windowEnd = now + (request.window_days ?? rules.window_days) * 1440 * MIN;
  const weight = Object.fromEntries((request.pursuits ?? []).map(p => [p.id, p.weight ?? (p.needle_mover ? rules.pursuit_weight.needle_mover : rules.pursuit_weight.default)]));
  const valueOf = item => Math.max(rules.pursuit_weight.none, ...(item.pursuit_ids ?? []).map(id => weight[id] ?? rules.pursuit_weight.default)) * (rules.priority_weight[item.priority ?? 'medium'] ?? 1);
  const takesTime = e => !e.all_day && e.response !== 'declined' && e.show_as !== 'free';
  const busyEvents = [...(request.busy ?? []).filter(takesTime), ...(request.blocks ?? [])].map(e => [ms(e.start), ms(e.end)]);
  const gap = (request.gap_minutes ?? rules.gap_minutes ?? 0) * MIN;
  const slot = rules.slot_choice ?? {};
  const meetings = (request.meetings ?? []).map(m => ({ ...m, s: ms(m.start), e: ms(m.end), value: valueOf(m) }));
  const schedules = { ...(rules.schedules ?? {}), ...(request.schedules ?? {}) };
  const workingFor = new Map();
  const working = name => {
    const key = name ?? '';
    if (!workingFor.has(key)) {
      const schedule = name != null && schedules[name] ? schedules[name] : request.schedule ?? rules.schedule;
      workingFor.set(key, scheduleIntervals(schedule, zone, now, Math.ceil((windowEnd - now) / (1440 * MIN)), request.end_of_day ?? {})
        .map(([s, e]) => [Math.max(s, now), Math.min(e, windowEnd)]).filter(([s, e]) => e > s));
    }
    return workingFor.get(key);
  };
  const allTime = [[now, windowEnd]];

  const tasks = (request.tasks ?? []).map(t => ({ ...t, need: Math.max(0, (t.duration_minutes ?? 0) - (t.done_minutes ?? 0)), due: ms(t.due), value: valueOf(t) }));
  const results = [];
  const eligible = [];
  for (const t of tasks) {
    const why = t.duration_minutes == null ? 'It has no length yet.' : t.need <= 0 ? 'It is already done.'
      : t.due != null && t.due < now - rules.stale_days * 1440 * MIN ? `Its deadline passed more than ${rules.stale_days} days ago.` : null;
    if (why) results.push({ id: t.id, fit: 'not_planned', said: why }); else eligible.push(t);
  }
  const rank = t => [t.rigid && t.preferred_start ? 0 : 1, t.priority === 'asap' || t.deadline === 'asap' ? 0 : 1, t.deadline === 'hard' ? 0 : 1, -t.value, t.due ?? Infinity];
  const compare = (a, b) => { const x = rank(a), y = rank(b); for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };

  const solve = declined => {
    const placed = [];
    const taken = [...busyEvents, ...meetings.filter(m => !declined.has(m.id)).map(m => [m.s, m.e])];
    const ends = {};
    const out = [];
    const pending = [...eligible].sort(compare);
    const ids = new Set(eligible.map(t => t.id));
    while (pending.length) {
      const index = pending.findIndex(t => (t.blocked_by ?? []).every(id => !ids.has(id) || id in ends));
      const t = pending.splice(index === -1 ? 0 : index, 1)[0];
      if (index === -1) { out.push({ id: t.id, fit: 'blocked', said: 'It waits on tasks that cannot be planned.' }); continue; }
      const notBefore = Math.max(now, ms(t.not_before) ?? 0, ms(t.snooze_until) ?? 0, ...(t.blocked_by ?? []).map(id => ends[id] ?? 0));
      const minBlock = t.min_block_minutes ?? rules.chunks.find(c => t.need < c.below_minutes)?.min_block_minutes ?? t.need;
      const busyNow = [...taken, ...placed.map(p => [p.s, p.e])].map(([s, e]) => [s - gap, e + gap]);
      const exactly = start => {
        const end = start + t.need * MIN;
        return start >= now && !busyNow.some(([s, e]) => s < end && e > start) ? [{ s: start, e: end }] : null;
      };
      const place = intervals => {
        let free = subtract(intervals, busyNow).map(([s, e]) => [Math.max(s, notBefore), e]).filter(([s, e]) => e > s);
        if (slot.skip_gaps_below_minutes && t.need > (slot.for_tasks_over_minutes ?? 0)) free = free.filter(([s, e]) => (e - s) / MIN >= slot.skip_gaps_below_minutes);
        if (slot.fewest_pieces_up_to_minutes && t.need <= slot.fewest_pieces_up_to_minutes) {
          const whole = free.filter(([s, e]) => (e - s) / MIN >= t.need).map(([s]) => ({ s, e: s + t.need * MIN }));
          const pick = whole.find(p => t.due == null || p.e <= t.due) ?? whole[0];
          if (pick) return [pick];
        }
        const pieces = [];
        let need = t.need;
        for (const [s, e] of free) {
          if (need <= 0) break;
          const room = (e - s) / MIN;
          if (room < Math.min(minBlock ?? need, need)) continue;
          const take = Math.min(room, need);
          if (minBlock == null && take < need) continue;
          pieces.push({ s, e: s + take * MIN }); need -= take;
        }
        return need <= 0 ? pieces : null;
      };
      const preferred = ms(t.preferred_start);
      if (t.rigid && preferred != null) {
        const pinned = exactly(preferred);
        if (!pinned) { out.push({ id: t.id, value: t.value, fit: 'conflict', said: 'Something else already takes its fixed time.' }); continue; }
        placed.push({ ...pinned[0], id: t.id }); ends[t.id] = pinned[0].e;
        out.push({ id: t.id, value: t.value, fit: 'on_track', finish: iso(pinned[0].e), pieces: [{ start: iso(pinned[0].s), end: iso(pinned[0].e) }], rigid: true });
        continue;
      }
      let pieces = (preferred != null && exactly(preferred)) || place(working(t.schedule)), outside = false;
      if ((!pieces || (t.due && pieces.at(-1).e > t.due)) && t.deadline === 'hard') {
        const wider = place(allTime);
        if (wider && (!pieces || wider.at(-1).e < pieces.at(-1).e)) { pieces = wider; outside = true; }
      }
      if (!pieces) {
        out.push({ id: t.id, value: t.value, fit: t.due != null && t.due <= windowEnd ? 'unfit_past_due' : 'unfit_later',
          said: t.due != null && t.due <= windowEnd ? 'It does not fit before its deadline.' : 'It does not fit in the planning window yet.' });
        continue;
      }
      for (const piece of pieces) placed.push({ ...piece, id: t.id });
      const end = pieces.at(-1).e;
      ends[t.id] = end;
      const alertAt = rules.rollover_alert_at;
      const stuck = alertAt != null && (t.rolled_over ?? 0) >= alertAt;
      out.push({ id: t.id, value: t.value, fit: stuck ? 'needs_decision' : t.due != null && end > t.due ? 'past_due' : 'on_track', finish: iso(end),
        ...(stuck ? { said: `It has moved ${t.rolled_over} days in a row. Keep it, change it or drop it.` } : {}),
        pieces: pieces.map(p => ({ start: iso(p.s), end: iso(p.e) })), ...(outside && !stuck ? { said: 'Some of it is outside your working hours so it meets its hard deadline.' } : {}) });
    }
    return out;
  };

  // Decline only what serves no pursuit, starting with the lowest value, and only while it lets higher-value work fit.
  const declined = new Set();
  let planned = solve(declined);
  const missing = () => planned.filter(r => r.fit === 'unfit_past_due' || r.fit === 'past_due');
  for (const m of meetings.filter(m => !m.required && m.value <= rules.pursuit_weight.none * (rules.priority_weight[m.priority ?? 'medium'] ?? 1)).sort((a, b) => a.value - b.value)) {
    const before = missing();
    if (!before.length || Math.max(...before.map(r => r.value)) <= m.value) break;
    const trial = solve(new Set([...declined, m.id]));
    const after = trial.filter(r => r.fit === 'unfit_past_due' || r.fit === 'past_due');
    if (after.length < before.length) { declined.add(m.id); planned = trial; }
  }
  // Each local day's planned work against its cap, with what to move to the next day first (lowest value, never fixed or ASAP).
  const load = new Map();
  const dayOf = date => { if (!load.has(date)) load.set(date, { date, minutes: 0, items: [] }); return load.get(date); };
  const taskById = Object.fromEntries(eligible.map(t => [t.id, t]));
  for (const r of planned) {
    const t = taskById[r.id];
    if (r.pieces) for (const p of r.pieces) { const d = dayOf(localDay(zone, ms(p.start)).date); const m = (ms(p.end) - ms(p.start)) / MIN; d.minutes += m; d.items.push({ id: r.id, minutes: m, value: r.value, movable: !t.rigid && t.priority !== 'asap' && t.deadline !== 'asap' }); }
    else if (t?.planned_for && t.need > 0) { const d = dayOf(t.planned_for); d.minutes += t.need; d.items.push({ id: r.id, minutes: t.need, value: r.value ?? t.value, movable: true }); }
  }
  for (const t of tasks) if (t.planned_for && t.duration_minutes == null) dayOf(t.planned_for);
  const caps = rules.daily_cap_minutes ?? {};
  const days = [...load.values()].sort((a, b) => a.date.localeCompare(b.date)).map(d => {
    const weekday = DAYS[new Date(`${d.date}T12:00:00Z`).getUTCDay()];
    const cap = caps[d.date] ?? caps[weekday] ?? null;
    const over = cap == null ? 0 : Math.max(0, d.minutes - cap);
    const bump = [];
    let left = over;
    for (const item of d.items.filter(i => i.movable).sort((a, b) => a.value - b.value)) { if (left <= 0) break; if (!bump.includes(item.id)) bump.push(item.id); left -= item.minutes; }
    return { date: d.date, planned_minutes: d.minutes, cap_minutes: cap, over_by_minutes: over, ...(over ? { bump, said: `This day is ${over} minutes over. Moving ${bump.length} task${bump.length === 1 ? '' : 's'} to the next day brings it back under.` } : {}) };
  });
  return {
    planned_at: iso(now), time_zone: zone, days,
    tasks: [...results, ...planned],
    meetings: meetings.map(m => declined.has(m.id)
      ? { id: m.id, verdict: 'propose_decline', said: 'It serves none of your pursuits, and declining it lets more valuable work meet its deadline.' }
      : { id: m.id, verdict: 'keep', said: m.value > rules.pursuit_weight.none ? 'It serves one of your pursuits.' : 'Nothing more valuable needs its time.' }),
  };
}
