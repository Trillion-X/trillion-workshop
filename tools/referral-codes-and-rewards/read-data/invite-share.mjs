// tools/referral-codes-and-rewards/read-data/invite-share.mjs
//
// PURPOSE
//   The "Refer a friend" section as the shared guide draws it (tools/ui/show/coss/guide.tsx): the heading and reward words the
//   host gives, the person's counts as stat tiles, the person's own link in the shared link sheet (tools/ui/show/share-card/
//   LinkShareSheet.tsx) with the places the link can go, and one row per person who joined with the link and what it earned.
//   Pure: the screen module reads the answer and passes it here. Dates and money are formatted here; every sentence is the host's.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Every word is the host's (`words`); this file adds none. A word with a slot ({day}, {amount}) is filled here.
//   2. The link and the counts are the host's answer, passed in; nothing is built or counted here.
//   3. The places are the DATA rows in share-places.json; adding one is a row, never a change here.
//   4. A person is drawn by the host's unnamed title and the day and credit of their row; no name or address is shown.

import places from './share-places.json' with { type: 'json' };

const money = (cents, currency = 'usd') => new Intl.NumberFormat('en-US', { style: 'currency', currency: currency.toUpperCase(), minimumFractionDigits: cents % 100 ? 2 : 0 }).format(cents / 100);
const day = iso => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

/** One person's row: the title, the day they joined, the day they paid and the credit given (when each happened). */
function personRow(person, index, words) {
  const joined = words.joined_on.replace('{day}', day(person.joined_at));
  const paid = person.paid_at ? words.paid_on.replace('{day}', day(person.paid_at)) : null;
  const credit = person.reward === 'given' ? words.credit_added.replace('{amount}', money(person.amount_cents, person.currency)) : null;
  const label = person.reward === 'given' ? words.status.credited : person.paid_at ? words.status.paying : words.status.joined;
  return { id: `joined-${index}`, title: words.person, detail: [joined, paid, credit].filter(Boolean).join(' · '), status: { label, tone: person.reward === 'given' ? 'good' : 'quiet' } };
}

/**
 * The section for one person's link and counts. stats: { joined, paying, credit_given_cents, people: [{ paid_at, reward, amount_cents,
 * currency }] } from the host's answer; words: the host's words (see the mount's InviteWords type and the surface row).
 */
export function inviteSection({ link, stats, words }) {
  const people = stats.people.map((person, index) => personRow(person, index, words));
  return {
    heading: words.heading,
    body: words.body,
    stats: [
      { id: 'joined', label: words.stats.joined, value: String(stats.joined) },
      { id: 'paying', label: words.stats.paying, value: String(stats.paying) },
      { id: 'earned', label: words.stats.earned, value: money(stats.credit_given_cents) },
    ],
    link_share: {
      url: link,
      title: words.share_title,
      text: words.share_text,
      places,
      words: { link: words.link, share: words.share, copy: words.copy, copied: words.copied, failed: words.failed },
    },
    rows: people,
    ...(people.length ? {} : { note: words.empty }),
  };
}
