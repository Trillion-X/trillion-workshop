// src/first-match-check.mjs
//
// The second half of first-match fit: the server rule proposes (src/network-first-matches.mjs firstMatchFit), then the
// person's own computer checks each proposal with the decision first-match-fit was measured and wired with
// (src/decision-evals.json `wired`, behind the rule: the two miss different cases, and together separate them), and a
// proposal it finds no fit is passed before the person sees it.
//
// Non-negotiable invariants
//   1. Asked with the measured words only: the decision's own state, question and means, filled from both people's own
//      words, and its wired cut; nothing here words a question.
//   2. A computer that does not answer changes nothing: the rule's proposals stand and the check waits (src/model-waits).
//   3. A decision that is not wired asks nothing.
import decisionEvals from './decision-evals.json' with { type: 'json' };
import rules from './network-settings.json' with { type: 'json' };

const fill = (template, values) => template.replace(/\{(\w+)\}/g, (_, name) => values[name] ?? '');

/** Checks the person's unchecked proposals: { checked, waiting } (waiting when the computer did not answer). */
export async function checkFirstMatches({ network, relay, ask, decisions = decisionEvals }) {
  const decision = decisions.evals.find(row => row.id === rules.first_matches.check_with);
  if (!decision?.wired) return { checked: 0, waiting: false };
  let checked = 0;
  for (const row of await network.firstMatchesToCheck(relay)) {
    const reply = await ask({ job: decision.id, state: fill(decision.state, row), questions: { verdict: { type: 'noul', instructions: decision.question, criteria: decision.means } } });
    const p = Number(reply?.answers?.verdict?.noul);
    if (!Number.isFinite(p)) return { checked, waiting: true };
    await network.checkFirstMatch({ relay, proposal_id: row.proposal_id, fits: p >= decision.wired.act_at, p });
    checked += 1;
  }
  return { checked, waiting: false };
}
