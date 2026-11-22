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
  assert.equal(out.workflows.length, 1);
  assert.deepEqual(Object.keys(out.workflows[0]).sort(), ['job', 'kind', 'produces', 'recipe', 'title']);
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
