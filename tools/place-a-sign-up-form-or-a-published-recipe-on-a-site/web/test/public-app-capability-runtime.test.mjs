import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { placedCapabilityRuntime, placedCapabilityScript, publicAppRunResult } from '../parts/ui/show/public-app-editor/placed-capability-runtime.mjs';
import { checkedPublicAppVisitorView } from '../../src/public-app-visitor-view.mjs';

class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.textContent = ''; this.attributes = {}; this.dataset = {}; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  setAttribute(name, value) { this.attributes[name] = value; }
  getAttribute(name) { return this.attributes[name] ?? null; }
}

test('served visitor script initializes once without calling the runtime result', () => {
  assert.doesNotThrow(() => runInNewContext(placedCapabilityScript, {
    document: { querySelectorAll: () => [] },
  }));
});

test('visitor result shows safe labeled fields instead of raw JSON', t => {
  const priorDocument = globalThis.document;
  t.after(() => { globalThis.document = priorDocument; });
  globalThis.document = { createElement: tag => new Element(tag) };
  const result = new Element('output');
  publicAppRunResult(result, { reflection: '<script>literal</script>', next_step: 'Begin now.' });
  assert.equal(result.dataset.state, 'completed');
  const rows = result.children[1].children[0].children;
  assert.deepEqual(rows.map(row => row.children[0].textContent), ['Reflection', 'Next Step']);
  assert.equal(rows[0].children[1].textContent, '<script>literal</script>');
  assert.equal(rows[1].children[1].textContent, 'Begin now.');
});

test('one owner view fetch renders separate safe accessible DOM for every placement', async t => {
  const priorDocument = globalThis.document;
  const priorFetch = globalThis.fetch;
  t.after(() => { globalThis.document = priorDocument; globalThis.fetch = priorFetch; });
  const slots = [new Element('div'), new Element('div')];
  for (const slot of slots) slot.setAttribute('data-trillion-placement', 'paper-card');
  let fetches = 0;
  globalThis.document = { querySelectorAll: () => slots, createElement: tag => new Element(tag) };
  globalThis.fetch = async () => {
    fetches++;
    return { ok: true, text: async () => JSON.stringify({ view: {
      schema: 'trillion.public-visitor-view/1', source_label: 'Marketplace', title: '<img onerror=bad>',
      description: 'Safe data', href: 'https://app.gettrillion.ai/workshop',
      sections: [{ heading: 'Included', items: [{ label: 'Tool', text: '<script>literal</script>' }] }],
      actions: [{ label: 'Open in Trillion', href: 'https://app.gettrillion.ai/workshop' }],
    } }) };
  };
  placedCapabilityRuntime();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(fetches, 1);
  assert.notEqual(slots[0].children[0], slots[1].children[0]);
  assert.equal(slots[0].children[0].children[1].textContent, '<img onerror=bad>');
  const row = slots[0].children[0].children[3].children[1].children[0];
  assert.equal(row.textContent, 'Tool');
  assert.equal(row.children[0].textContent, '<script>literal</script>');
  assert.equal(slots[0].children[0].children.filter(child => child.tagName === 'a').length, 1);
});

test('visitor runtime renders validated Runs actions, section links, and fallback links', async t => {
  const priorDocument = globalThis.document;
  const priorFetch = globalThis.fetch;
  t.after(() => { globalThis.document = priorDocument; globalThis.fetch = priorFetch; });
  const views = {
    'runs-action': checkedPublicAppVisitorView({
      schema: 'trillion.public-visitor-view/1', source_label: 'Published source', title: 'Runs action',
      description: 'An action points to Runs.', href: 'https://app.gettrillion.ai/workshop',
      actions: [{ label: 'Open Runs', href: 'https://app.gettrillion.ai/runs' }],
    }),
    'runs-section': checkedPublicAppVisitorView({
      schema: 'trillion.public-visitor-view/1', source_label: 'Published source', title: 'Runs section',
      description: 'A section item points to Runs.', href: 'https://app.gettrillion.ai/workshop',
      sections: [{ heading: 'More', items: [{ label: 'Read runs', href: 'https://app.gettrillion.ai/runs/' }] }],
    }),
    'runs-fallback': checkedPublicAppVisitorView({
      schema: 'trillion.public-visitor-view/1', source_label: 'Published source', title: 'Runs fallback',
      description: 'The default link points to Runs.', href: 'https://app.gettrillion.ai/runs',
    }),
  };
  const slots = Object.keys(views).map(id => {
    const slot = new Element('div');
    slot.setAttribute('data-trillion-placement', id);
    return slot;
  });
  globalThis.document = { querySelectorAll: () => slots, createElement: tag => new Element(tag) };
  globalThis.fetch = async path => {
    const id = new URL(path, 'https://app.gettrillion.ai').pathname.split('/').at(-1);
    return { ok: Boolean(views[id]), text: async () => JSON.stringify({ view: views[id] }) };
  };

  placedCapabilityRuntime();
  await new Promise(resolve => setTimeout(resolve, 0));

  const linksIn = node => [
    ...(node.tagName === 'a' ? [node] : []),
    ...node.children.flatMap(linksIn),
  ];
  const linksBySlot = Object.fromEntries(slots.map(slot => [
    slot.getAttribute('data-trillion-placement'), linksIn(slot.children[0]).map(link => ({ label: link.textContent, href: link.href })),
  ]));
  assert.deepEqual(linksBySlot['runs-action'], [{
    label: 'Open Runs', href: 'https://app.gettrillion.ai/runs',
  }]);
  assert.deepEqual(linksBySlot['runs-section'], [{
    label: 'Read runs', href: 'https://app.gettrillion.ai/runs/',
  }, {
    label: 'Open in Trillion', href: 'https://app.gettrillion.ai/workshop',
  }]);
  assert.deepEqual(linksBySlot['runs-fallback'], [{
    label: 'Open in Trillion', href: 'https://app.gettrillion.ai/runs',
  }]);
});
