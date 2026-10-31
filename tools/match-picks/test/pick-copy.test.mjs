// The person's banned wording, given with the request, kept out of a pick prompt or a result summary. Made-up terms.
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkPickCopy } from '../do-work/check-pick-copy.mjs';

const TERMS = ['zorp', 'big prize'];

test('a text with a banned term in any letter case fails, naming the field and the term', () => {
  const answer = checkPickCopy({ texts: [{ field: 'label', text: 'Win the ZORP today' }, { field: 'summary', text: 'Alder won in two.' }], banned_terms: TERMS });
  assert.equal(answer.passed, false);
  assert.deepEqual(answer.findings.map(item => [item.field, item.term]), [['label', 'zorp']]);
});

test('a phrase matches across any white space, and clean texts pass', () => {
  assert.equal(checkPickCopy({ texts: [{ field: 'label', text: 'The  big\nprize' }], banned_terms: TERMS }).passed, false);
  assert.deepEqual(checkPickCopy({ texts: [{ field: 'label', text: 'Alder vs Birch' }], banned_terms: TERMS }), { passed: true, findings: [] });
  assert.equal(checkPickCopy({ texts: [{ field: 'label', text: 'anything' }], banned_terms: [] }).passed, true);
});

test('a term with punctuation is matched as written, and bad input is refused', () => {
  assert.equal(checkPickCopy({ texts: [{ text: 'a (b+c) d' }], banned_terms: ['(b+c)'] }).passed, false);
  assert.throws(() => checkPickCopy({ texts: [{ text: 'x' }] }), /banned_terms must be/);
  assert.throws(() => checkPickCopy({ texts: [{ text: 'x' }], banned_terms: [' '] }), /banned_terms must be/);
  assert.throws(() => checkPickCopy({ banned_terms: TERMS }), /texts must be/);
});
