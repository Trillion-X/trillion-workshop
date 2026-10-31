// The plain privacy pass on synthetic words: what it finds without a model (an address, a handle, a long number, a
// phone number, an amount of money, a key, the removed mark, a name inside a sentence, a person's never-publish phrase,
// a place or a legal entity word), what it leaves alone (general words, a capitalised word that starts a sentence or
// is an ordinary word), and the proper names it learns from a person's own texts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { findings, namesIn, privateTerms, redact } from '../read-data/plain-privacy-pass.mjs';

test('general words pass; each kind of identifying detail is found', () => {
  assert.deepEqual(findings({ situation: 'Someone with a steady job weighed starting a small business on the side.', options: ['Keep the job', 'Leave the job'] }), []);
  const cases = {
    'Write to quokka@example.test for the plan.': 'quokka@example.test',
    'The plan is at https://plans.example.test/spring.': 'https://',
    'Ask @zephyrine for the plan.': '@z',
    'The order was 48213 units.': '48213',
    'Call 555 010 2030 before noon.': '555 010 2030',
    'It cost $40 more.': '$4',
    'It would bring in 3 million more.': '3 million',
    'The key was sk_live_abcdefgh12.': 'sk_live_abcdefgh12',
    'They chose the [removed] option.': '[removed]',
  };
  for (const [text, finding] of Object.entries(cases)) {
    assert.ok(findings(text).some(found => found.includes(finding)), `${text} -> ${JSON.stringify(findings(text))}`);
  }
  assert.deepEqual(findings('They moved the camp to Seattle for the summer.'), ['seattle', 'Seattle']);
  assert.ok(findings('The shop became an LLC last year.').includes('llc'));
});

test('a capitalised word counts as a name only inside a sentence, and ordinary words never do', () => {
  assert.deepEqual(namesIn('Keeping the job felt safer. Then Marisol said to wait. I agreed, and the AI did too.'), ['Marisol']);
  assert.deepEqual(namesIn({ why: 'Prices rose. Families still came.' }), []);
});

test('a person\'s own terms: their never-publish phrases, what they gave, and the proper names in their texts', () => {
  const terms = privateTerms({
    neverPublish: ['Zephyrine Feeders', 'x'],
    known: ['Orla Quill'],
    texts: [{ goal: 'Decide whether Orla moves the Quokka Club to Thursdays', note: 'the club meets weekly' }],
  });
  for (const term of ['zephyrine feeders', 'orla quill', 'orla', 'quill', 'quokka']) assert.ok(terms.has(term), term);
  assert.ok(!terms.has('decide') && !terms.has('club') && !terms.has('x'), 'a sentence start, a word also seen in lower case, and a one-letter phrase are not terms');
  assert.deepEqual(findings('Zephyrine Feeders chose to grow slowly.', terms), ['zephyrine feeders', 'Feeders']);
  assert.equal(redact('Orla moved the club; mail orla@example.test', terms), '[removed] moved the club; mail [removed]');
});
