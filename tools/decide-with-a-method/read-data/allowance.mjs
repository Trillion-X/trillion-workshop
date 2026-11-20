// tools/decide-with-a-method/read-data/allowance.mjs
//
// PURPOSE
//   The words for a person's free decisions: how many are left, the used-up line, the line a free reply says nothing
//   is kept by, and the refusal for a feature the free plan withholds. Ported from the old app's src/allowance.mjs:
//   periods and periodOf (lines 16-31), leftWords (49-51), keepsWords (132), withheldWords (74-76), usedUpWords (84-86).
//   NOT re-ported: decisionLimit (old 35-38) and pursuitsWords (old 139-147). read-data/work-screen.mjs exports both with
//   the same result: decisionLimit (work-screen.mjs:282) reads the same `limits` row under the same access name
//   (work-screen.json `decision_access`, equal to the old DECISION_ACCESS), and pursuitsWords (work-screen.mjs:289) fills
//   the same two sentences (work-screen.json `pursuits`, equal to the old screen-words.json `pursuits`).
//
//   The upgrade offer is an offer-catalogue fact, not a word. The caller resolves it and passes it in as
//   `upgrade` = { offer, price, url } (the offer's label, its price option's label, and the account link); `adds` is
//   the plan comparison's sentence of what that plan adds. Nothing here reads a price or a plan.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Every sentence comes from read-data/screen-words.json; a missing `{part}` is filled with nothing, never a guess.
//   2. A period is named by its calendar key (UTC), and the day a new one starts is computed, never typed.
import words from './screen-words.json' with { type: 'json' };

const fill = (template, parts) => template.replace(/\{(\w+)\}/g, (_, name) => String(parts[name] ?? ''));
const long = date => date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const periodWord = per => words.allowance.per_words[per] ?? per;

// A calendar period: its key (the part of the UTC date that names it) and the day the next one starts.
const periods = {
  day: now => ({ key: now.toISOString().slice(0, 10), next: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)) }),
  // A week starts on Monday (UTC); its key is the date of that Monday.
  week: now => {
    const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - ((now.getUTCDay() + 6) % 7)));
    return { key: `week-of-${monday.toISOString().slice(0, 10)}`, next: new Date(monday.getTime() + 7 * 86400000) };
  },
  month: now => ({ key: now.toISOString().slice(0, 7), next: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)) }),
  year: now => ({ key: now.toISOString().slice(0, 4), next: new Date(Date.UTC(now.getUTCFullYear() + 1, 0, 1)) }),
};

export function periodOf(per, now = new Date()) {
  const period = periods[per];
  if (!period) throw new Error(`An allowance is counted per ${Object.keys(periods).join(', ')}; ${per} is not one of them.`);
  return period(now);
}

export function leftWords({ count, per, used }) {
  return fill(words.allowance.left, { left: Math.max(0, count - used), count, per: periodWord(per) });
}

/** The line a free reply ends with: nothing was kept, and what keeps it. */
export const keepsWords = upgrade => fill(words.free.keeps, upgrade);

/** The refusal a free person gets for a feature their plan does not include. */
export function withheldWords({ feature, allowance, upgrade, adds }) {
  return fill(words.free.withheld, { feature: feature.label, count: allowance?.count ?? '', per: words.allowance.per_words[allowance?.per] ?? allowance?.per ?? '', ...upgrade, adds });
}

export function usedUpWords({ count, per, upgrade, now = new Date() }) {
  return fill(words.allowance.used_up, { count, per: periodWord(per), ...upgrade, paid_worth: words.free.paid_worth, resets_on: long(periodOf(per, now).next) });
}
