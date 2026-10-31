// tools/decide-with-a-method/read-data/verdicts.mjs
//
// The calling AI's own verdicts on the checks of an answer, taken only where they can be checked against the case.
// Ported unchanged from the old app's src/check-judge.mjs (takeCallerVerdicts and what it needs). Trillion asks no
// model: the AI that answers hands each check to a judge on its own subscription and sends the verdicts beside the
// answer, each { check, meets, rests_on, missing?, graded_by }.
//
// NON-NEGOTIABLE INVARIANTS
//   1. A verdict is taken only for a check of this step, with meets true or false, resting on an evidence ref of the
//      case or on at least eight characters of this answer, and naming who judged it.
//   2. A refusal holds only when the words it says are missing are words of its check (or of what the check refuses).
//   3. A check with no verdict taken is not refused for it: the caller is never refused because no judge spoke.

// The words of a refusal and of the check are compared as plain lowercase words, so quotes, dashes and spacing the
// judge changes while copying do not matter.
const words = text => String(text ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
// A refusal holds only when the words it says are missing are words its check (or what the check refuses) says.
const grounded = (item, row) => { const said = words(item.missing); return said.split(' ').length >= 2 && [row.check, row.refuses].some(text => ` ${words(text)} `.includes(` ${said} `)); };
const plain = text => String(text ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
const textOf = value => typeof value === 'string' ? value : value && typeof value === 'object' ? Object.values(value).map(textOf).join('\n') : '';

/** rows: the checks of this step ({ id, check, refuses? }); given: the caller's verdicts. -> { verdicts, rest } */
export function takeCallerVerdicts(rows, given, { answer = null, refs = [] } = {}) {
  const verdicts = [];
  const taken = new Set();
  const said = plain(textOf(answer));
  for (const item of Array.isArray(given) ? given : []) {
    const row = rows.find(each => each.id === item?.check);
    if (!row || taken.has(row.id) || typeof item.meets !== 'boolean') continue;
    const rests = plain(item.rests_on);
    if (!rests || !(refs.includes(String(item.rests_on).trim()) || (rests.length >= 8 && said.includes(rests)))) continue;
    if (!item.meets && !grounded({ missing: item.missing }, row)) continue;
    // Who judged it is kept with the verdict for audit, whichever grader the calling AI was given.
    const graded_by = String(item.graded_by ?? '').trim();
    if (!graded_by) continue;
    taken.add(row.id);
    verdicts.push({ id: row.id, meets: item.meets, why: item.meets ? '' : 'The answer does not meet this check.', missing: item.meets ? '' : String(item.missing).trim(), by: 'calling-ai', graded_by });
  }
  return { verdicts, rest: rows.filter(row => !taken.has(row.id)) };
}
