// tools/decide-with-a-method/read-data/progress-facts.mjs
//
// Progress's facts, as tool:read-progress answers them: what is waiting for the person's answer, the pursuits they are working
// toward (as the tree they nest into), the pursuits made with others, and the plan's free-allowance line. Pure: the caller reads
// the account's screen (its summaries, pursuits and allowance) and hands in `sections_after`, the sections the owners of
// awareness, decision trends and what helped have already built (src/awareness-sections.mjs, web/src/progress-trends.mjs,
// keep-and-wake-ai-sessions-on-this-computer/src/check-uses.mjs). Ported from the old screen.mjs progressFacts (old file
// lines 49-98 of show-my-screens' from-an-older-version/src/screen.mjs.held); the held words it read are now screen-words.json.
import words from './screen-words.json' with { type: 'json' };
import { keepsWords, leftWords } from './allowance.mjs';
import { decisionHref } from './screen-links.mjs';
import { pursuitHierarchyRows } from '../../keep-goals-and-focus/read-data/pursuit-hierarchy-view.mjs';

/** A pursuit's status as Progress shows it (held screen.mjs:49). */
export const pursuitStatus = status => (status === 'active' ? 'Active' : status === 'paused' ? 'Paused' : 'Recorded');

const spaceRows = screen => (screen.space_pursuits ?? []).map(item => ({
  id: `${item.space_id}:${item.item_id}`, title: item.title || 'Untitled pursuit',
  now: item.body?.now || null, after: item.body?.after || null, open: `/spaces/${encodeURIComponent(item.space_id)}`,
}));

/**
 * progressFacts({ origin, screen, sections_after }): the facts Progress shows. `origin` names where to pay, `screen` is the
 * account's work screen (summaries, pursuits, pursuits_words, allowance, free, price_arm, space_pursuits), `sections_after`
 * the sections built beside it. Returns the kind 'progress' record the screen draws.
 */
export function progressFacts({ origin, screen, sections_after = [] }) {
  const space = spaceRows(screen);
  if (screen.free) {
    return { kind: 'progress', free: true, space_pursuits: space, keeps: keepsWords(origin, screen.price_arm),
      lead: screen.allowance?.count === null ? words.free.screen : `${words.free.screen} ${leftWords(screen.allowance)}` };
  }
  const { summaries, pursuits, pursuits_words: pursuitsWords } = screen;
  const waiting = summaries.filter(item => item.outcome_question);
  return {
    kind: 'progress', free: false, space_pursuits: space, decisions: summaries.length, waiting_count: waiting.length,
    waiting: waiting.map(item => ({ case_id: item.case_id, goal: item.goal, question: item.outcome_question, href: decisionHref(item.case_id) })),
    // With nothing recorded, an invitation; a number appears only when the pool measured one (pursuits_words.measured).
    invite: pursuits.length ? null : pursuitsWords?.measured ? pursuitsWords.text : words.pursuits.screen_invite,
    pursuits: pursuitHierarchyRows(pursuits).map(({ record: pursuit, depth, parents }) => ({
      id: pursuit.id, title: `${'↳ '.repeat(depth)}${pursuit.title}`, open: `/pursuits/${encodeURIComponent(pursuit.id)}`,
      under: parents.length ? parents.map(parent => parent.title).join(', ') : null,
      spaces: Array.isArray(pursuit.spaces) && pursuit.spaces.length ? pursuit.spaces.map(item => item.title).filter(Boolean).join(', ') : null,
      now: String(pursuit.now), after: String(pursuit.after), why: pursuit.why_it_matters || null,
      space_links: Array.isArray(pursuit.spaces) ? pursuit.spaces.filter(item => item?.id && item?.title).map(item => ({ title: item.title, href: `/spaces/${encodeURIComponent(item.id)}` })) : [],
      status: pursuitStatus(pursuit.status),
      facts: { title: pursuit.title, now: pursuit.now ?? '', after: pursuit.after ?? '', why: pursuit.why_it_matters ?? '', under: parents.map(parent => parent.title), status: pursuitStatus(pursuit.status) },
    })),
    sections_after,
  };
}
