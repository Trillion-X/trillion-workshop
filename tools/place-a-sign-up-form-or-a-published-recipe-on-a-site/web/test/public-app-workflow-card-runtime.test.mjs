import test from 'node:test';
import assert from 'node:assert/strict';
import { placedCapabilityRuntime } from '../parts/ui/show/public-app-editor/placed-capability-runtime.mjs';

class Element {
  constructor(tagName) { this.tagName = tagName; this.children = []; this.textContent = ''; this.attributes = {}; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  getAttribute(name) { return this.attributes[name] ?? null; }
}

test('a read-only workflow summary paints a card with a safe Marketplace link', async t => {
  const before = { document: globalThis.document, fetch: globalThis.fetch };
  t.after(() => { globalThis.document = before.document; globalThis.fetch = before.fetch; });
  const slot = new Element('div');
  slot.attributes['data-trillion-placement'] = 'workflow-card';
  globalThis.document = { querySelectorAll: () => [slot], createElement: tag => new Element(tag) };
  globalThis.fetch = async () => ({ ok: true, text: async () => JSON.stringify({ view: {
    schema: 'trillion.public-visitor-view/1', source_label: 'Published Trillion workflow',
    title: '<img src=x onerror=alert(1)>', description: 'Explain a simple process.', display_style: 'plain',
    href: 'https://app.gettrillion.ai/marketplace',
  } }) });
  placedCapabilityRuntime();
  await new Promise(resolve => setTimeout(resolve, 0));
  const card = slot.children[0];
  assert.equal(card.tagName, 'article');
  assert.equal(card.className, 'trillion-placed-capability trillion-placed-capability--plain');
  assert.equal(card.children[1].textContent, '<img src=x onerror=alert(1)>');
  assert.equal(card.children.at(-1).href, 'https://app.gettrillion.ai/marketplace');
});
