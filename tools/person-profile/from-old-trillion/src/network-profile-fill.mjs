// src/network-profile-fill.mjs
//
// A person's Network profile is filled by Trillion from what it already knows about them, so nobody types a profile
// Trillion could have written (Sam Example 2026-09-29: "the AI could have filled all the information out on me").
//
// Non-negotiable invariants
//   1. Which field comes from where is DATA (src/network-settings.json profile_fill.fields); this file only knows how
//      to read each kind of source (FROM), never which field a source feeds.
//   2. A field the person wrote themselves is theirs forever (`written`): any other field is filled only when it is
//      empty or still holds the exact value Trillion last filled it with (`filled`).
//   3. Nothing is guessed: a source without a value fills nothing, and an account name that is an email gives a name
//      only from the part before the @.
//   4. Pure: the caller hands over what is known and what is kept; the answer is the changes and the new `filled`.

const text = value => (typeof value === 'string' ? value.trim() : '');
const isEmail = value => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value);

/** How each kind of source reads a value out of what is known about the person. */
const FROM = {
  account: (source, known) => {
    const made = text(known.account?.name);
    const email = text(known.account?.email) || (isEmail(made) ? made : '');
    if (source.part === 'email') return email;
    if (made && !isEmail(made)) return made;
    // An email-made account is named by the words before its @ ("ana.lopez" reads "ana lopez"), never the whole address.
    return email ? email.split('@')[0].replace(/\+.*$/, '').replace(/[._-]+/g, ' ').trim() : '';
  },
  picture: (source, known) => text((source.path ?? []).reduce((value, key) => value?.[key], known.picture)),
  'picture-trait': (source, known, rules) => (known.picture?.traits?.[source.trait] ?? [])
    .map(item => text(item?.name)).filter(Boolean).slice(0, source.most ?? Infinity).join(rules.join),
  pursuits: (source, known, rules) => (known.pursuits ?? [])
    .map(item => text(item?.title)).filter(Boolean).slice(0, source.most ?? Infinity).join(rules.join),
};

/** The handle a name makes: its letters and digits joined by underscores, then the end of the person's network id. */
export function handleFor(name, relay, rules) {
  const base = String(name ?? '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
    .slice(0, rules.handle.most_chars) || rules.handle.otherwise;
  return `${base}_${String(relay).slice(-rules.handle.id_chars)}`;
}

/**
 * What Trillion would fill now. `current` is the profile as kept, `filled` the values Trillion last filled
 * (by field), `written` the fields the person wrote themselves (never filled again, even when they emptied one), `known` what Trillion knows ({ account: { name, email }, picture, pursuits }).
 * Answers { changes, filled }: the fields to save and the record of what Trillion filled after saving them.
 */
export function profileFill({ rules, known, current, filled = {}, written = [], relay }) {
  const changes = {};
  const next = { ...filled };
  const ours = field => !written.includes(field) && (!text(current[field]) || current[field] === filled[field]);
  for (const row of rules.fields) {
    if (!ours(row.field)) continue;
    const value = row.from.map(source => FROM[source.kind]?.(source, known, rules) ?? '').find(Boolean) ?? '';
    if (!value || value === current[row.field]) continue;
    changes[row.field] = value;
    next[row.field] = value;
  }
  // The handle is made once from the name, and follows the name only while it is still the one Trillion made.
  const name = changes[rules.handle.from_field] ?? current[rules.handle.from_field];
  if (ours('handle')) {
    const handle = handleFor(name, relay, rules);
    if (handle !== current.handle) { changes.handle = handle; next.handle = handle; }
  }
  return { changes, filled: next };
}
