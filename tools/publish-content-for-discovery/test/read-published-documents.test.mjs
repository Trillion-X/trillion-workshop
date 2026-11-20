// tools/publish-content-for-discovery: the read model of a public document site, over made-up documents. The two cases are
// the old read-data test (selectors and rules instead of a fixed status field; every valid row visible with no rule), and
// the FAQ pairs and sources are read as the document's own lists.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readPublishedModel } from '../do-work/read-published-documents.mjs';

const rows = payloads => payloads.map((payload, index) => ({ address: `record:${index}`, payload }));

test('the selectors and rules of the view decide what shows and in what order', () => {
  const firstView = {
    selectors: { id: 'key', title: 'headline', slug: 'path', blocks: 'body.blocks', state: 'visibility' },
    visibility_rules: [{ selector: 'visibility', value: 'ready' }],
    order_by: { selector: 'headline', direction: 'asc' },
  };
  const secondView = {
    selectors: { id: 'identity.ref', title: 'display.name', slug: 'route.key', blocks: 'content', state: 'gate.result' },
    visibility_rules: [{ selector: 'gate.result', op: 'in', values: ['open', 'reviewed'] }],
    order_by: { selector: 'display.rank', direction: 'desc' },
  };
  const first = readPublishedModel(rows([
    { key: 'a', headline: 'Zeta', path: 'zeta', visibility: 'ready', body: { blocks: [] } },
    { key: 'b', headline: 'Alpha', path: 'alpha', visibility: 'ready', body: { blocks: [] } },
    { key: 'c', headline: 'Hidden', path: 'hidden', visibility: 'closed', body: { blocks: [] } },
  ]), [], firstView);
  const second = readPublishedModel(rows([
    { identity: { ref: 'x' }, display: { name: 'Second', rank: 2 }, route: { key: 'two' }, gate: { result: 'open' }, content: [] },
    { identity: { ref: 'y' }, display: { name: 'First', rank: 1 }, route: { key: 'one' }, gate: { result: 'reviewed' }, content: [] },
    { identity: { ref: 'z' }, display: { name: 'Blocked', rank: 3 }, route: { key: 'blocked' }, gate: { result: 'closed' }, content: [] },
  ]), [], secondView);
  assert.deepEqual(first.documents.map(document => document.id), ['b', 'a']);
  assert.deepEqual(second.documents.map(document => document.id), ['x', 'y']);
});

test('with no publication-view rule every valid row is visible', () => {
  const model = readPublishedModel(rows([
    { id: 'draft', title: 'Draft', slug: 'draft', publish_state: 'draft', blocks: [] },
    { id: 'live', title: 'Live', slug: 'live', publish_state: 'live', blocks: [] },
  ]), []);
  assert.deepEqual(model.documents.map(document => document.id), ['draft', 'live']);
});

test('a row without an id, title or slug is left out', () => {
  const model = readPublishedModel(rows([{ id: 'ok', title: 'Ok', slug: 'ok' }, { id: 'no-slug', title: 'No slug' }]), []);
  assert.deepEqual(model.documents.map(document => document.id), ['ok']);
});

test('the FAQ pairs and sources are read as the document lists, and anything else reads as empty', () => {
  const model = readPublishedModel(rows([
    {
      id: 'faq', title: 'With FAQ', slug: 'faq', blocks: [],
      faq_pairs: [{ question: 'What is it?', answer: 'A document.' }, 'not a pair'],
      sources: [{ url: 'https://example.com/a', label: 'A' }],
    },
    { id: 'plain', title: 'Plain', slug: 'plain', faq_pairs: 'none', sources: null },
  ]), []);
  const [withFaq, plain] = model.documents;
  assert.deepEqual(withFaq.faqPairs, [{ question: 'What is it?', answer: 'A document.' }]);
  assert.deepEqual(withFaq.sources, [{ url: 'https://example.com/a', label: 'A' }]);
  assert.deepEqual(plain.faqPairs, []);
  assert.deepEqual(plain.sources, []);
});

test('the site config row is read when present', () => {
  const model = readPublishedModel([], rows([{ base_path: '/docs', domain: 'example.com', llms_txt: { enabled: true }, same_as: ['https://example.com/x', ' '] }]));
  assert.deepEqual(model.documents, []);
  assert.equal(model.config.basePath, '/docs');
  assert.equal(model.config.llmsTxt, true);
  assert.deepEqual(model.config.sameAs, ['https://example.com/x']);
});
