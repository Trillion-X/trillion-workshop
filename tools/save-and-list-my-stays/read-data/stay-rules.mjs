// tools/save-and-list-my-stays/read-data/stay-rules.mjs
//
// The stays block of the Network's rules, copied as DATA from the old code's src/network-settings.json at b6ae0ebf815f (its
// `stays` block). Limits a stay is checked against; the old code read the same numbers from its settings file.
export const STAY_RULES = {
  per_host: 6,
  lengths: { title: 120, where: 80, about: 1500, when: 300 },
  max_amount_cents: 10000000,
  default_currency: 'USD',
  price_kinds: { free: true, 'per-night': true, ask: true },
};
