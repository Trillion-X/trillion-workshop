// tools/decide-with-a-method/read-data/screen-links.mjs
//
// The addresses a decision's screen and its sources point at, and the actions a page section keeps. Pure: each function takes
// what the caller read and returns what the screen shows.
//   decisionHref(id)        the address of one decision's own screen: the decisions surface's route prefix (/decisions/, the
//                           decision surface of tools/workspace-screens/part.json) and the id, encoded
//   sourceAction(ref, words)  the "open source" or "open page checked" action (words: { page, source }, the screen's own words) for a
//                           source reference, or [] where it names no web address
//   realActions(actions)    the actions a section keeps: those with a real address (an in-page link is not one)
// A source reference is a web address, or `page:<address>@<time>` for a page the reader looked at (the time is dropped).

const DECISIONS_ROUTE = '/decisions/';

/** The address of one decision's own screen. */
export const decisionHref = id => `${DECISIONS_ROUTE}${encodeURIComponent(id)}`;

// A source reference's web address and whether it is a page the reader looked at, or null where it names no web address.
const sourceOf = ref => {
  const page = typeof ref === 'string' && ref.startsWith('page:') ? ref.slice(5).replace(/@\d{4}-\d{2}-\d{2}T.*$/, '') : null;
  const href = page ?? ref;
  return /^https?:\/\/[^\s]+$/i.test(href ?? '') ? { href, page: page !== null } : null;
};

/** The action a source reference opens: its label is the words the screen shows for a page checked or a source. */
export const sourceAction = (ref, words) => {
  const found = sourceOf(ref);
  return found ? [{ label: found.page ? words.page : words.source, href: found.href }] : [];
};

/** The actions a section keeps: only those whose address is real (not an in-page `#` link). */
export const realActions = actions => (actions ?? []).filter(action => typeof action.href === 'string' && !action.href.startsWith('#')).map(({ label, href }) => ({ label, href }));
