// tools/publish-content-for-discovery: the read model of a public document site, over made-up documents. The two cases are
// the old read-data test (selectors and rules instead of a fixed status field; every valid row visible with no rule), and
// the FAQ pairs and sources are read as the document's own lists.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readArtifactRecord, readPublishedModel } from '../do-work/read-published-documents.mjs';

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

test('the route key comes from the view selector, with the address prefixes the view names', () => {
  const view = {
    route_key: { selector: 'links.path', artifact_address_prefix: 'package::site::artifact::', route_address_prefix: 'package::site::route::' },
  };
  const model = readPublishedModel(rows([
    { id: 'a', title: 'A', slug: 'a', links: { path: 'hello' } },
    { id: 'b', title: 'B', slug: 'b', links: { path: '  ' } },
    { id: 'c', title: 'C', slug: 'c' },
  ]), [], view);
  const [withKey, emptyKey, missingKey] = model.documents;
  assert.deepEqual(withKey.route, { key: 'hello', routeAddress: 'package::site::route::hello', artifactAddress: 'package::site::artifact::hello' });
  assert.equal(emptyKey.route, null);
  assert.equal(missingKey.route, null);
  assert.deepEqual(model.documents.map(document => document.id), ['a', 'b', 'c']);
});

test('a view without route_key gives documents no route, and missing prefixes give null addresses', () => {
  const plain = readPublishedModel(rows([{ id: 'a', title: 'A', slug: 'a' }]), []);
  assert.equal(plain.documents[0].route, null);
  const noPrefix = readPublishedModel(rows([{ id: 'a', title: 'A', slug: 'a' }]), [], { route_key: { selector: 'slug' } });
  assert.deepEqual(noPrefix.documents[0].route, { key: 'a', routeAddress: null, artifactAddress: null });
});

test('the artifact record fields are named by the view, and each missing one reads as null', () => {
  const view = {
    artifact_records: {
      content_address_field: 'bytes.address',
      integrity_field: 'integrity_hash',
      media_type_field: 'media_type',
      source_record_field: 'source',
    },
  };
  const artifact = readArtifactRecord({ bytes: { address: 'content:1' }, integrity_hash: 'b3:abc', media_type: 42, source: 'record:9' }, view);
  assert.deepEqual(artifact, { content_address: 'content:1', integrity: 'b3:abc', media_type: null, source_record: 'record:9' });
  assert.deepEqual(readArtifactRecord({}, {}), {});
});

test('a view row with no selectors reads the document fields as the default view row names them', () => {
  const model = readPublishedModel(rows([
    { id: 'b', title: 'Beta', slug: 'beta', publish_state: 'live', blocks: [] },
    { id: 'a', title: 'Alpha', slug: 'alpha', publish_state: 'draft', blocks: [] },
  ]), [], { visibility_rules: [{ selector: 'publish_state', value: 'live' }] });
  assert.deepEqual(model.documents.map(document => document.id), ['b']);
  assert.equal(model.documents[0].state, 'live');
  assert.equal(model.documents[0].slug, 'beta');
});

test('a view row that names one selector keeps the default row for the rest', () => {
  const model = readPublishedModel(rows([
    { id: 'a', headline: 'Alpha', slug: 'alpha', publish_state: 'live', blocks: [] },
  ]), [], { selectors: { title: 'headline' } });
  assert.equal(model.documents[0].title, 'Alpha');
  assert.equal(model.documents[0].state, 'live');
});
