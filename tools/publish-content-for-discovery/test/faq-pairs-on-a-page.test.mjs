// tools/publish-content-for-discovery: the questions a page answers, written in its source and shown as expandable items.
// Made-up pages on invalid hosts; the old public document site's FAQ pairs (question and answer) are the outcome checked.
import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareContentForDiscovery } from '../do-work/prepare-content-for-discovery.mjs';

function inputWith(faqPairs, extra = {}) {
  return {
    site: { name: 'Cedar Field Lab', origin: 'https://cedar.invalid', language: 'en' },
    source: {
      ref: 'source:cedar:public-list',
      version: 'snapshot:2026-11-20T04:00:00Z',
      observedAt: '2026-11-20T04:00:00Z',
      requestedCursor: null,
      complete: true,
      nextCursor: null,
      documents: [{
        ref: 'record:cedar:guide', version: 'edition:1', title: 'A public guide', schemaType: 'Thing', openGraphType: 'website',
        schemaProperties: {}, description: 'About Cedar', updatedAt: '2026-11-20T04:00:00Z',
        sections: [{ kind: 'paragraph', text: 'Useful information' }],
        citations: [],
        ...(faqPairs === undefined ? {} : { faqPairs }),
        ...extra,
      }],
    },
    routes: [{ documentRef: 'record:cedar:guide', path: '/guides/public-guide' }],
  };
}

test('each question and answer is shown folded behind its question, as text', () => {
  const result = prepareContentForDiscovery(inputWith([
    { question: 'How long does it take?', answer: 'Two weeks.' },
    { question: 'Is <script>alert(1)</script> allowed?', answer: 'No & never.' },
  ]));
  const [doc] = result.outputs.documents;
  assert.match(doc.html, /<section class="faq"><h2>Questions<\/h2><details><summary>How long does it take\?<\/summary><p>Two weeks\.<\/p><\/details>/);
  assert.match(doc.html, /<summary>Is &lt;script&gt;alert\(1\)&lt;\/script&gt; allowed\?<\/summary><p>No &amp; never\.<\/p>/);
  assert.doesNotMatch(doc.html, /<script>alert/);
  assert.ok(doc.html.indexOf('<section class="faq">') < doc.html.indexOf('</article>'));
  assert.deepEqual(doc.faqPairs, [
    { question: 'How long does it take?', answer: 'Two weeks.' },
    { question: 'Is <script>alert(1)</script> allowed?', answer: 'No & never.' },
  ]);
});

test('a page without questions shows no questions block', () => {
  const [doc] = prepareContentForDiscovery(inputWith(undefined)).outputs.documents;
  assert.deepEqual(doc.faqPairs, []);
  assert.doesNotMatch(doc.html, /class="faq"/);
});

test('a pair needs a question and an answer, and the list is at most 30 long', () => {
  assert.throws(() => prepareContentForDiscovery(inputWith([{ question: 'Only a question?' }])), /answer/);
  assert.throws(() => prepareContentForDiscovery(inputWith([{ answer: 'Only an answer.' }])), /question/);
  assert.throws(() => prepareContentForDiscovery(inputWith('not a list')), /list of at most 30/);
  const thirtyOne = Array.from({ length: 31 }, (_, index) => ({ question: `Question ${index}?`, answer: 'Yes.' }));
  assert.throws(() => prepareContentForDiscovery(inputWith(thirtyOne)), /list of at most 30/);
});

test('a private local path in a question or answer is refused', () => {
  assert.throws(() => prepareContentForDiscovery(inputWith([{ question: 'Where is it?', answer: 'In /Users/example/notes.' }])), /private local path/);
});
