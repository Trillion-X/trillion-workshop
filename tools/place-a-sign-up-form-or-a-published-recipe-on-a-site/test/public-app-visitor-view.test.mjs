import test from 'node:test';
import assert from 'node:assert/strict';
import { checkedPublicAppVisitorView, publicAppVisitorView } from '../src/public-app-visitor-view.mjs';

test('source owners project rich visitor views into a bounded, data-only contract', () => {
  const view = publicAppVisitorView({ source_label: 'From Trillion Marketplace', title: 'Paper kit', description: 'Prepare a paper.',
    url: 'https://app.gettrillion.ai/marketplace/paper-kit%401234',
    sections: [{ heading: 'Included', items: [{ label: 'Tool', text: 'A safe summary.' }] }],
    actions: [{ label: 'See what it adds', href: 'https://app.gettrillion.ai/marketplace/paper-kit%401234' }] });
  assert.deepEqual(view.sections[0].items[0], { label: 'Tool', text: 'A safe summary.' });
  assert.equal(view.schema, 'trillion.public-visitor-view/1');
  assert.throws(() => checkedPublicAppVisitorView({ ...view, href: 'https://app.gettrillion.ai/work/api/private' }), /public Marketplace or Runs/);
  assert.throws(() => checkedPublicAppVisitorView({ ...view, href: 'https://attacker.example/marketplace/paper-kit' }), /public Marketplace or Runs/);
  assert.throws(() => checkedPublicAppVisitorView({ ...view, sections: [{ items: Array.from({ length: 21 }, () => ({ text: 'x' })) }] }), /up to 20 items/);
  assert.throws(() => checkedPublicAppVisitorView({ ...view, script: '<img src=x onerror=alert(1)>' }), /not supported/);
});
