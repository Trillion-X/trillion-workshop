// Run: node --test tools/workflows/use-case-catalog/test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderPublicCatalog } from '../do-work/render-public-catalog.mjs';

const origin = 'https://shop.example';

test('only public rows leave, with allow-listed fields', () => {
  const { catalog } = renderPublicCatalog({
    origin,
    workflows: [
      { recipe: 'workflow:progress-digest', title: 'Progress digest', job: 'Reads progress.', produces: 'A digest.', kind: 'workflow', public: true, secret_column: 'x' },
      { recipe: 'workflow:private-one', title: 'Private', job: 'No.', kind: 'workflow', public: false },
    ],
  });
  const out = JSON.parse(catalog);
  assert.equal(out.items.length, 1);
  assert.deepEqual(Object.keys(out.items[0]).sort(), ['id', 'inputs', 'job', 'kind', 'produces', 'recipe', 'steps', 'title']);
});

test('sitemap lists each public workflow and use-case address', () => {
  const { sitemap } = renderPublicCatalog({
    origin,
    workflows: [{ recipe: 'workflow:progress-digest', title: 'T', job: 'J', kind: 'workflow', public: true }],
    uses: [{ id: 'u1', title: 'U', job: 'J', marketplace: `${origin}/marketplace/tool/read-a-link`, uses: [], public: true }],
  });
  assert.match(sitemap, /<loc>https:\/\/shop\.example\/marketplace\/workflow\/progress-digest<\/loc>/);
  assert.match(sitemap, /<loc>https:\/\/shop\.example\/marketplace\/tool\/read-a-link<\/loc>/);
});

test('refuses output that carries an email, a phone number or a connection name', () => {
  assert.throws(() => renderPublicCatalog({ origin, workflows: [{ recipe: 'workflow:a', title: 'Mail me reader@example.test', job: 'J', kind: 'workflow', public: true }] }), /refused/);
  assert.throws(() => renderPublicCatalog({ origin, workflows: [{ recipe: 'workflow:a', title: 'Call +1 415 555 0100', job: 'J', kind: 'workflow', public: true }] }), /refused/);
  assert.doesNotThrow(() => renderPublicCatalog({ origin, workflows: [{ recipe: 'workflow:a', title: 'fix a network-connection', job: 'J', kind: 'workflow', public: true }] }));
  assert.throws(() => renderPublicCatalog({ origin, workflows: [{ recipe: 'workflow:a', title: 'vault_example-connection', job: 'J', kind: 'workflow', public: true }] }), /refused/);
});

test('refuses a non-https origin', () => {
  assert.throws(() => renderPublicCatalog({ origin: 'http://x.example' }), /https/);
});

test('inputs leave as names and descriptions only, and each listing gets its own file', () => {
  const out = renderPublicCatalog({
    origin,
    workflows: [{ recipe: 'workflow:trace-to-first-principles', title: 'Trace', job: 'Traces it.', kind: 'workflow', public: true,
      input_schema: { properties: { subject: { type: 'string', default: 'SECRET-DEFAULT', description: 'The feature to trace' } } },
      steps: [{ title: 'Read the chain' }, { id: 'no-title' }] }],
  });
  const listing = JSON.parse(out.listings['workflow:trace-to-first-principles']);
  assert.equal(JSON.parse(out.catalog).items[0].id, 'workflow:trace-to-first-principles');
  assert.deepEqual(listing.inputs, [{ name: 'subject', says: 'The feature to trace' }]);
  assert.deepEqual(listing.steps, ['Read the chain']);
  assert.equal(listing.id, 'workflow:trace-to-first-principles');
  assert.ok(!out.catalog.includes('SECRET-DEFAULT'));
});
