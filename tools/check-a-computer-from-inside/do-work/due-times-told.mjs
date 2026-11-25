// tools/check-a-computer-from-inside/do-work/due-times-told.mjs
//
// Was each due occurrence told? The symptom of a missing teller, and of one that is on but broken or stuck. Given the
// due-time wakes of one computer's wake book (wake:list) and its switch history, this names each wake whose last expected
// occurrence was not told: that occurrence's window began, and its window plus a grace passed, and the wake has not fired
// since the occurrence began.
//
// How it judges (each rule and why):
// - The cadence is the wake's own: the schedules it asks to be watched (`on.fact.watch.schedules`: cadence, local_window,
//   timezone, DST rule). When an occurrence is expected is timed-action's alone (`whenToWake`), so a daily wake, a zone with
//   a clock change and a fold or gap day are as that owner says; none is computed here.
// - Told is the wake's own `mark.fired_ms`, the time it last heard a fact and started. It is per wake. `kind_last_told` is
//   the last fact of the whole kind told on the computer, so any other wake's fact would hide this wake's missed one
//   (read live Nov 25 2026, 7:50 AM CST: thirteen due-time wakes on the Mac, one `kind_last_told` for all).
// - The wake is asked from `max(fired_ms, switched on)`: an occurrence that began before it was switched on is not late
//   (its switch time is the newest `on: true` of this wake in the switch history). With neither known the wake is not
//   judged and is named in `not_judged`, never called on time.
// - Late is the occurrence's start plus its own window plus `told.grace_seconds` (settings.json), so a tick told a few
//   seconds into its window, or a run that took the window to start, is not late. The newest occurrence is judged only once
//   that has passed, but an older one missed is judged at once (a stuck teller is named at the next look, not two minutes
//   after the next tick began).
// - A wake whose fact is not a due-time one, one with no schedule to watch (a one-off asks for a record, not a cadence) and
//   one that is not switched on with its switch standing are not judged: nothing is expected of them.
import { readFileSync } from 'node:fs';
import { whenToWake } from '../../run-work-later-or-on-a-repeat/do-work/timed-action.mjs';

const SETTINGS = JSON.parse(readFileSync(new URL('../settings.json', import.meta.url), 'utf8'));

/** The time a wake was last switched on, from the switch history ({id, tool, on, at_ms}), or null. */
export function switchedOnAt(wake, history) {
  const times = (Array.isArray(history) ? history : [])
    .filter(item => item?.id === wake.id && item?.tool === wake.tool && item?.on === true && Number.isFinite(item.at_ms))
    .map(item => item.at_ms);
  return times.length ? Math.max(...times) : null;
}

/** Each due-time wake of `wakes` whose last expected occurrence was not told by `nowMs`: { late: [...], not_judged: [wake id] }.
 *  A late entry: { wake, schedule, start, end, fired_ms, switched_on_ms, said }. */
export function dueTimesNotTold(wakes, history, nowMs) {
  const grace = Number(SETTINGS.told.grace_seconds) * 1000;
  const late = [];
  const notJudged = [];
  for (const wake of Array.isArray(wakes) ? wakes : []) {
    if (wake?.switched_on !== true || wake?.switch_stands !== true || wake?.on?.fact?.kind !== SETTINGS.wakes.kind) continue;
    const schedules = Array.isArray(wake.on.fact.watch?.schedules) ? wake.on.fact.watch.schedules : [];
    if (schedules.length === 0) continue;
    const fired = Number.isFinite(wake.mark?.fired_ms) ? wake.mark.fired_ms : null;
    const switched = switchedOnAt(wake, history);
    const from = Math.max(fired ?? 0, switched ?? 0);
    if (from === 0) { notJudged.push(wake.id); continue; }
    for (const schedule of schedules) {
      // Asked as of the moment an occurrence's window and the grace have just passed (now less both), so the latest occurrence
      // timed-action names is the latest one that is late if untold, and a missed older tick is not hidden by a newer one
      // whose window is still open.
      const windowMs = Number(schedule?.local_window?.duration_minutes) * 60000;
      const answer = whenToWake({ now: nowMs - grace - (Number.isFinite(windowMs) ? windowMs : 0), schedules: [schedule], occurrence_states: [], resume_from_ms: from });
      if (answer.rejected_schedules.length) { notJudged.push(wake.id); continue; }
      for (const due of answer.recurring_due) {
        const end = Date.parse(due.end);
        late.push({ wake: wake.id, schedule: schedule.schedule_id, start: due.start, end: due.end, fired_ms: fired, switched_on_ms: switched,
          said: `${wake.id} was due at ${due.start} and not told by ${new Date(end + grace).toISOString()}; it ${fired === null ? 'has not fired since it was switched on' : `last fired at ${new Date(fired).toISOString()}`}.` });
      }
    }
  }
  return { late, not_judged: [...new Set(notJudged)] };
}

/** The finding that stands for `late` on one engine or computer (null when nothing is late): one finding that names the wakes, so a
 *  teller that stopped is one notice and not one for each wake. */
export function notToldFinding(about, late) {
  if (late.length === 0) return null;
  const ids = [...new Set(late.map(item => item.wake))];
  const shown = ids.slice(0, SETTINGS.wakes.most_named);
  const more = ids.length - shown.length;
  return { kind: 'due-time-not-told', level: 'alert', about,
    said: `${ids.length} due-time wake${ids.length === 1 ? ' was' : 's were'} not told when due on ${about}: ${shown.join(', ')}${more > 0 ? `, and ${more} more` : ''}. The first: ${late[0].said} A missing teller, or one that is on but stuck or broken, tells nothing.` };
}

/** One page of `wake:list` from the run's own door ({url, resource, capability}, the descriptor on fd 3): { computer, wakes,
 *  switch_history } over every page of the kind, or { why }. Only the kind the row's right names is asked. */
export async function readOwnDueTimeWakes(door, { fetchImpl = fetch, timeoutMs = Number(SETTINGS.wakes.ask_seconds) * 1000 } = {}) {
  const wakes = [];
  let history = [];
  let computer = null;
  let after = null;
  const seen = new Set();
  for (let page = 0; page < Number(SETTINGS.wakes.most_pages); page += 1) {
    const body = JSON.stringify({ jsonrpc: '2.0', id: page + 1, method: 'tools/call', params: { name: 'do_one_thing_in_my_account',
      arguments: { address: door.resource ?? '@own-records', method: 'wake:list', request_key: `due-times:${Date.now().toString(36)}:${page}`,
        input: { kind: SETTINGS.wakes.kind, ...(after === null ? {} : { after }) } } } });
    let raw;
    try {
      const response = await fetchImpl(door.url, { method: 'POST', body, signal: AbortSignal.timeout(timeoutMs),
        headers: { authorization: `Bearer ${door.capability}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' } });
      raw = await response.text();
    } catch (error) { return { why: `the door did not answer wake:list: ${error?.message ?? error}` }; }
    const json = raw.trim().startsWith('{') ? raw : raw.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('');
    let answer;
    try { answer = JSON.parse(json || '{}'); } catch { return { why: `the door's answer was not JSON: ${raw.slice(0, 120)}` }; }
    const result = answer.result;
    const content = result?.structuredContent;
    if (answer.error || result?.isError) return { why: `the door refused wake:list: ${(content?.detail ?? content?.code ?? answer.error?.message ?? JSON.stringify(answer).slice(0, Number(SETTINGS.wakes.most_refusal_chars)))}` };
    if (!Array.isArray(content?.wakes)) return { why: 'the door answered no list of wakes' };
    wakes.push(...content.wakes);
    if (page === 0) { history = Array.isArray(content.switch_history) ? content.switch_history : []; computer = typeof content.computer === 'string' ? content.computer : null; }
    const next = typeof content.next === 'string' && content.next !== '' ? content.next : null;
    if (next === null) return { computer, wakes, switch_history: history };
    if (seen.has(next)) return { why: 'the wake list named the same next page twice' };
    seen.add(next);
    after = next;
  }
  return { why: `the wake list has more than ${SETTINGS.wakes.most_pages} pages` };
}
