// tools/decide-with-a-method/read-data/report.mjs
//
// PURPOSE
//   The words a person reads for where a decision stands and what it settled to: resultWords (the settled result),
//   statusWords (the status sentence) and statusLabel (the short label and tone beside a decision in a list).
//   Ported from the old app's src/report.mjs: resultWords (line 85), saidNow (88), short (89), statusWords (90-98),
//   statusLabel (99), with line() (line 6). The status is decided by decision-outcome.mjs and the AI's receipt by
//   carriedOut (work-screen.mjs, same as the old decision-store.mjs carriedOut); this file only turns them into words.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Every word comes from read-data/screen-words.json. No internal status name, evidence ref or record id is shown.
//   2. A status or result with no row shows its own name, so a new one is one row of DATA, never a guess here.
//   3. The decision tools' own precedence (decide-with-a-method.json `precedence`) decides who wins a disagreement.
import { carriedOut } from './work-screen.mjs';
import { currentDecisionOutcome, decisionStatus as outcomeStatus, personReportVerified } from './decision-outcome.mjs';
import settings from './decide-with-a-method.json' with { type: 'json' };
import words from './screen-words.json' with { type: 'json' };

const line = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const short = (text, length = 160) => { const one = line(text); return one.length > length ? one.slice(0, length - 1).trimEnd() + '…' : one; };
const decisionStatus = record => outcomeStatus(record, settings.precedence);
const currentOutcome = record => currentDecisionOutcome(record, settings.precedence);

// What the saved state means to a reader. The latest thing the person reported comes first when there is one.
export const resultWords = result => words.results[result] ?? line(result);

// What the AI that took the decision's next action said, for the decision as it stands now (an earlier decision's
// receipt is not this one's).
const saidNow = record => carriedOut(record) ? record.carried_out.filter(entry => entry.decision_generation === (record.decision_generation ?? 1)) : [];

export function statusWords(record) {
  const outcome = currentOutcome(record);
  const status = decisionStatus(record);
  if (outcome?.by === 'reported' && status === 'needs_outcome') return (personReportVerified(outcome.evidence) ? 'Decided: you said ' : 'Decided: reported for the person that ') + resultWords(outcome.result);
  const said = status === 'needs_outcome' ? saidNow(record).at(-1) : null;
  if (said) return words.carried_out[said.state].replace('{what}', short(said.what_happened));
  return words.statuses[status]?.label ?? line(status);
}

/** The short label and tone shown beside a decision in a list. */
export const statusLabel = status => ({ label: words.statuses[status]?.short ?? line(status), tone: words.statuses[status]?.tone ?? 'quiet' });
