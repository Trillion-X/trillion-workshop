// src/referral-screen.mjs
//
// PURPOSE
//   The facts of the "Invite people" section of the Invite friends screen (the Marketplace screen tool:invite, whose layout
//   draws every sentence): the person's link, what the people who join and they themselves get, the places the link can
//   go (the shared LinkShareSheet), how many joined and pay, and one row's facts per person who joined with what it
//   earned. Built from src/shares.mjs referralSummary, the same answer the my_referrals tool gives their AI.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Only real facts: every count and state is read from the person's referral rows; an empty list stays empty.
//   2. Each side's reward and any limit come from src/referrals.json and the friend's checkout-code row, never typed
//      here; this file computes values (days, amounts, counts), never sentences.
//   3. The places a link can go are the same DATA rows the Progress card uses (src/progress-words.json destinations).

import words from './progress-words.json' with { type: 'json' };
import { logoOf } from './site-icon-url.mjs';

export const day = iso => (typeof iso === 'string' && iso.length >= 10 ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : null);
const money = (cents, currency) => new Intl.NumberFormat('en-US', { style: 'currency', currency: (currency ?? 'usd').toUpperCase(), minimumFractionDigits: cents % 100 ? 2 : 0 }).format(cents / 100);

// What a friend's checkout code takes off, in words: `{ kind: 'amount', amount_cents, currency }` or `{ kind: 'percent', percent }`.
const OFF = {
  amount: gets => money(gets.amount_cents, gets.currency),
  percent: gets => (gets.percent === 100 ? 'all' : `${gets.percent}%`),
};
export const offWords = gets => OFF[gets.kind]?.(gets) ?? null;

/**
 * The facts the Invite friends screen draws its link section from (the Marketplace screen tool:invite): the person's
 * link, what each side gets, the places a link can go, the counts, and one row per person who joined with when it
 * happened and what it earned. summary: src/shares.mjs referralSummary. Every sentence is the screen layout's.
 */
export function referralFacts(summary) {
  const perYear = summary.you_get.at_most_per_year;
  const currency = summary.you_get.currency;
  return {
    link: summary.links[0] ?? null,
    theirs: offWords(summary.friend_gets),
    yours: money(summary.you_get.amount_cents, currency),
    per_year: Number.isInteger(perYear) ? perYear : null,
    places: words.destinations.map(({ domain, ...place }) => ({ ...place, ...(domain ? { logo: logoOf(domain) } : {}) })),
    share_words: { share: words.actions.share, copy: words.actions.copy, copied: words.actions.copied },
    joined: summary.joined,
    paying: summary.paying,
    earned: money(summary.credit_given_cents, currency),
    waiting: summary.waiting,
    people: summary.people.map(person => ({
      name: person.name ?? null,
      joined_day: day(person.joined_at),
      paid_day: day(person.paid_at),
      reward: person.reward ?? null,
      credit: person.reward === 'given' && person.amount_cents ? money(person.amount_cents, person.currency) : null,
    })),
  };
}

// What one person who joined has earned, as a row status.
const STATES = {
  none: { label: 'Joined', tone: 'quiet' },
  owed: { label: 'Credit waiting', tone: 'warning' },
  given: { label: 'Credit added', tone: 'good' },
  over_limit: { label: 'Paying', tone: 'quiet' },
};

function personRow(person, index) {
  const detail = [
    person.joined_at ? `Joined ${day(person.joined_at)}` : null,
    person.paid_at ? `first paid ${day(person.paid_at)}` : null,
    person.reward === 'given' && person.amount_cents ? `${money(person.amount_cents, person.currency)} off your bill` : null,
    person.reward === 'owed' ? 'added when you pay for the plan' : null,
    person.reward === 'over_limit' ? 'past this year\'s limit' : null,
  ].filter(Boolean).join(' · ');
  return { id: `joined-${index}`, title: person.name ?? 'Someone who joined', detail, status: STATES[person.reward] ?? STATES.none };
}

const WHO = 'Share Trillion with someone pursuing something worthwhile for the greater good of human society who needs better decisions, so their AI can help them get it done.';

/** The section. summary: src/shares.mjs referralSummary. */
export function referralSection(summary) {
  const link = summary.links[0];
  const perYear = summary.you_get.at_most_per_year;
  const theirs = offWords(summary.friend_gets);
  const yours = money(summary.you_get.amount_cents, summary.you_get.currency);
  return {
    heading: 'Invite people',
    body: [
      WHO,
      `${theirs ? `They get ${theirs} off their first payment, and you` : 'You'} get ${yours} off your next bill for everyone who joins with your link and pays.`,
      Number.isInteger(perYear) ? `Up to ${perYear} a year.` : 'There is no limit.',
    ].join(' '),
    link_share: {
      url: link,
      title: 'Try Trillion',
      text: `If you are pursuing something worthwhile for the greater good of human society, Trillion helps your AI make better decisions and get them done.${theirs ? ` ${theirs} off with my link:` : ' My link:'}`,
      places: words.destinations.map(({ domain, ...place }) => ({ ...place, ...(domain ? { logo: logoOf(domain) } : {}) })),
      words: { link: 'Your link', share: words.actions.share, copy: words.actions.copy, copied: words.actions.copied, failed: 'The link could not be copied here. Select it and copy it instead.' },
    },
    stats: [
      { id: 'joined', label: 'Joined with your link', value: String(summary.joined) },
      { id: 'paying', label: 'Paying', value: String(summary.paying) },
      { id: 'earned', label: 'Credit added', value: money(summary.credit_given_cents, summary.you_get.currency) },
      ...(summary.waiting ? [{ id: 'waiting', label: 'Credits waiting', value: String(summary.waiting), detail: 'Added when you pay for the plan' }] : []),
    ],
    rows: summary.people.map(personRow),
    ...(summary.people.length ? {} : { note: 'Nobody has joined with your link yet.' }),
  };
}
