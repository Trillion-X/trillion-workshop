// computer/observation-rules.mjs
//
// Purpose: the one test of whether this Mac's reader may observe an app, a website, or a private window. Rules are DATA
// (the `observation` section of computer/drive-the-screen.json): a default per scope (application, website) and rows of
// exceptions. It is pure; callers hand it what they know about the thing being observed.
//
// Non-negotiable invariants
//   1. A default of `observe` means rows block; a default of `do_not_observe` means rows allow. A matching block row
//      always wins, whatever the default.
//   2. A record that carries a usable website must pass both the application policy and the website policy; a record
//      without one passes on the application policy alone.
//   3. A private window is never observed, whatever the rules say.
//   4. Out of the box (no rows, defaults `observe`) everything is observed: nothing here limits the person's work until
//      they add a row.
//   5. Nothing here names an app or a site; names and bundle ids are rows in the DATA.
const lower = value => String(value ?? '').toLowerCase();

const included = (fallback, rows, matches) => {
  if (rows.some(row => matches(row) && row.mode === 'block')) return false;
  return fallback === 'observe' ? true : rows.some(row => matches(row) && row.mode === 'allow');
};

/** { observe, why } for a subject { identities: [bundle ids / names], domain?: string, private?: boolean }. */
export function observationVerdict(rules, subject) {
  if (subject.private === true) return { observe: false, why: 'private' };
  const identities = (subject.identities ?? []).map(lower);
  const app = included(rules.default_application, rules.applications ?? [], row => identities.includes(lower(row.app)));
  if (!app) return { observe: false, why: 'application' };
  const host = lower(subject.domain);
  if (host && !included(rules.default_website, rules.websites ?? [], row => host === lower(row.domain) || host.endsWith(`.${lower(row.domain)}`))) return { observe: false, why: 'website' };
  return { observe: true, why: null };
}

/** The rules replaced whole, after checking each row: only `allow` or `block`, and a name to match. Throws a plain message. */
export function checkedRules(rules) {
  const modes = ['observe', 'do_not_observe'];
  if (!modes.includes(rules?.default_application) || !modes.includes(rules?.default_website)) throw new Error(`Each default is one of ${modes.join(', ')}.`);
  for (const [list, key] of [['applications', 'app'], ['websites', 'domain']]) {
    for (const row of rules[list] ?? []) if (!['allow', 'block'].includes(row?.mode) || typeof row?.[key] !== 'string' || !row[key].trim()) throw new Error(`Each ${list} row needs ${key} and a mode of allow or block.`);
  }
  return rules;
}
