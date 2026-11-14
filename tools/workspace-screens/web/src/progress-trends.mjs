// src/progress-trends.mjs
//
// PURPOSE
//   How a person's decisions change over time, from the view whatHelped already computes (src/check-uses.mjs): the
//   lines Progress draws (time to decide, goals hit), the numbers a share card shows, and the snapshot a share keeps.
//   Every word is DATA in progress-words.json. Nothing here reads what a decision was about: only counts, durations
//   and results cross into a share, so a public page can never carry a decision's words.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Only numbers leave: shareSnapshot copies counts, medians, results and durations, never a goal, option or note.
//   2. A number is shown only when it was measured: fewer than two points draws no line, and "faster" is said only when
//      recent decisions were measured against earlier ones and are quicker.
//   3. One card shape (cardFor) feeds the Progress preview, the saved image and the public page alike.

import words from './progress-words.json' with { type: 'json' };
import { duration } from './check-uses.mjs';
import { logoOf } from 'trillion-workshop/tools/set-up-my-account/read-data/site-icon-url.mjs';

const fill = (template, values) => template.replace(/\{(\w+)\}/g, (whole, name) => (values[name] ?? whole));
const percent = (part, whole) => (whole ? Math.round((100 * part) / whole) : 0);
// A card holds at most this many points; a longer history keeps its newest.
const CARD_POINTS = 60;

/** The dated points of each line, oldest first. `series` is whatHelped's `series`. */
export function linePoints(series = []) {
  const deciding = series.filter(point => typeof point.seconds === 'number').map(point => ({ t: Date.parse(point.at), value: point.seconds }));
  // Goals hit, as the share of decisions with a result that met their goal, after each decision that has one.
  const goals = [];
  let met = 0, known = 0;
  for (const point of series) {
    if (point.result !== 'met' && point.result !== 'failed') continue;
    known += 1;
    if (point.result === 'met') met += 1;
    goals.push({ t: Date.parse(point.at), value: percent(met, known) });
  }
  return { deciding, goals };
}

/** The numbers a share keeps and a card shows: counts, medians and results only (invariant 1). */
export function shareSnapshot(view, { referred = 0 } = {}) {
  const deciding = view.time?.deciding ?? {};
  return {
    decisions: view.decisions ?? 0,
    deciding_now: deciding.recent ?? null,
    deciding_before: deciding.compared ? deciding.earlier ?? null : null,
    met: view.goal?.hit_goal ?? 0,
    known: view.goal?.with_result ?? 0,
    goals_shown: Boolean(view.goal?.share_shown),
    points: linePoints(view.series).deciding.slice(-CARD_POINTS).map(point => point.value),
    referred,
  };
}

/** The one line a share says about itself: faster when measured, else the goal share when there are enough results, else the count. */
export function headlineOf(snapshot) {
  const { deciding_now: now, deciding_before: before } = snapshot;
  if (typeof now === 'number' && typeof before === 'number' && before > 0 && now < before) return fill(words.card.headline_faster, { change: percent(before - now, before) });
  if (snapshot.goals_shown) return fill(words.card.headline_goals, { share: percent(snapshot.met, snapshot.known) });
  return snapshot.decisions === 1 ? words.card.headline_count_one : fill(words.card.headline_count, { count: snapshot.decisions });
}

/** The card as DATA for parts/ui/show/share-card (one shape for preview, saved image and public page). */
export function cardFor(snapshot) {
  const stats = [
    { label: words.card.stat_decisions, value: String(snapshot.decisions) },
    ...(typeof snapshot.deciding_now === 'number' ? [{
      label: words.card.stat_deciding,
      value: duration(snapshot.deciding_now),
      ...(typeof snapshot.deciding_before === 'number' ? { detail: fill(words.card.stat_deciding_before, { before: duration(snapshot.deciding_before) }), tone: snapshot.deciding_now < snapshot.deciding_before ? 'good' : 'quiet' } : {}),
    }] : []),
    ...(snapshot.known ? [{ label: words.card.stat_goals, value: `${snapshot.met} of ${snapshot.known}` }] : []),
  ];
  return {
    headline: headlineOf(snapshot),
    stats,
    ...(snapshot.points.length >= 2 ? { line: { label: words.card.line_label, points: snapshot.points, better: 'lower' } } : {}),
    footer: words.card.footer,
  };
}

/** The words a share is sent with: the headline and the invitation. */
export const shareText = snapshot => fill(words.share_text, { headline: headlineOf(snapshot) });

/**
 * The Progress sections for a person with decisions: their lines over time, and the card to share with the places it
 * can go. `view` is whatHelped(); `referred` how many accounts were made from their link; `share` where the Share
 * button sends the card (a GuideShare's `send`).
 */
export function progressTrendSections(view, { referred = 0, sendPath }) {
  if (!view?.decisions) return [];
  const { deciding, goals } = linePoints(view.series);
  const time = view.time?.deciding ?? {};
  const trends = [];
  if (deciding.length >= 2) trends.push({
    id: 'deciding',
    label: words.trend_deciding.label,
    value: duration(time.recent) ?? '',
    detail: time.compared ? fill(time.recent <= time.earlier ? words.trend_deciding.better : words.trend_deciding.worse, { before: duration(time.earlier) }) : words.trend_deciding.once,
    points: deciding,
    unit: 'seconds',
    better: 'lower',
  });
  trends.push(goals.length >= 2 ? {
    id: 'goals',
    label: words.trend_goals.label,
    value: `${percent(view.goal.hit_goal, view.goal.with_result)}%`,
    detail: fill(words.trend_goals.detail, { met: view.goal.hit_goal, known: view.goal.with_result }),
    points: goals,
    unit: 'percent',
    better: 'higher',
  } : { id: 'goals', label: words.trend_goals.label, value: view.goal?.with_result ? `${view.goal.hit_goal} of ${view.goal.with_result}` : '—', detail: view.goal?.with_result ? fill(words.trend_goals.detail, { met: view.goal.hit_goal, known: view.goal.with_result }) : words.trend_goals.none, points: goals, unit: 'percent', better: 'higher' });
  const snapshot = shareSnapshot(view, { referred });
  return [
    {
      heading: words.trends_heading,
      body: words.trends_body,
      stats: [
        { id: 'decisions', label: words.stat_decisions, value: String(view.decisions) },
        ...(referred ? [{ id: 'referred', label: words.stat_referred, value: String(referred) }] : []),
      ],
      trends,
    },
    {
      heading: words.share_heading,
      body: words.share_body,
      share: {
        card: cardFor(snapshot),
        text: shareText(snapshot),
        send: { path: sendPath },
        // Each place's logo is read from its own web address, the way Connections shows a service's.
        destinations: words.destinations.map(({ domain, ...place }) => ({ ...place, ...(domain ? { logo: logoOf(domain) } : {}) })),
        words: words.actions,
      },
    },
  ];
}
