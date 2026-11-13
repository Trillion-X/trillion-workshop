// Ported from old trillion test/public-app-visitor-form.test.mjs (tag old-trillion-before-worker-retire, b6ae0ebf81),
// deleted by Trillion-X/trillion #243. The four tests of the page script and the form (web/parts/ui/show/public-app-editor)
// run here as they were, the action given as plain DATA. Left out for their Workshop owners: the placement and form-word
// checks (checkedPlacedCapabilities, checkedVisitorFormPresentation, checkedVisitorAction in trillion-workshop
// tools/edit-a-site-visually src/public-app-capabilities.mjs and public-app-definition.mjs), and publishing, serving and
// recording an answer once per run key (old src/public-app-host.mjs and public-app-records.mjs; the records are
// tools/shared-code src/public-app-records.mjs now).
// A public page that collects visitors' answers (a sign-up, a waitlist) is one visitor action plus one placement: the
// host works out the action's version, serves the form's words, records each answer once per run key, and serves a
// printable code for the page's address with the place it was printed for.
import test from 'node:test';
import assert from 'node:assert/strict';
import { placedCapabilityRuntime, placedCapabilityScript } from '../parts/ui/show/public-app-editor/placed-capability-runtime.mjs';
import { publicAppActionForm } from '../parts/ui/show/public-app-editor/public-app-run-form.mjs';

// The sign-up action as trillion-workshop tools/edit-a-site-visually checkedPublicAppDefinition keeps it: its fields.
const signUp = { id: 'store-list', version: 'edition-a', actions: [{ id: 'join', record_kind: 'list-signup',
  fields: [{ id: 'email', type: 'email', required: true }, { id: 'name', type: 'text' }, { id: 'source', type: 'text' }] }] };
const words = { title: 'Join the list', description: 'Hear first when it opens.', submit_label: 'Join', done_message: "Thanks, you're on the list.",
  fields: [{ id: 'email', label: 'Your email' }, { id: 'source', from_page_address: 'from' }] };

class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.textContent = ''; this.attributes = {}; this.dataset = {}; this.listeners = {}; this.value = ''; this.disabled = false; this.checked = false; }
  append(...nodes) { for (const node of nodes) node.parent = this; this.children.push(...nodes); }
  focus() { globalThis.document.activeElement = this; }
  remove() { this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  replaceWith(node) { const siblings = this.parent.children; siblings[siblings.indexOf(this)] = node; node.parent = this.parent; }
  setAttribute(name, value) { this.attributes[name] = value; }
  getAttribute(name) { return this.attributes[name] ?? null; }
  addEventListener(type, listener) { this.listeners[type] = listener; }
  all() { return this.children.flatMap(child => [child, ...child.all()]); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  querySelectorAll(selector) {
    const all = this.all();
    if (selector === '[data-run-submit]') return all.filter(node => 'runSubmit' in node.dataset);
    if (selector === '[data-run-result]') return all.filter(node => 'runResult' in node.dataset);
    if (selector === 'input, textarea, button') return all.filter(node => ['input', 'textarea', 'button'].includes(node.tagName));
    if (selector === 'input[name], textarea[name]') return all.filter(node => ['input', 'textarea'].includes(node.tagName) && node.name);
    if (selector === 'input[name]') return all.filter(node => node.tagName === 'input' && node.name);
    if (selector === 'input:not([type=hidden])') return all.filter(node => node.tagName === 'input' && node.type !== 'hidden');
    throw new Error(`unexpected selector ${selector}`);
  }
}

test('the served page script draws the sign-up form and sends one answer with its run key', async t => {
  const prior = { document: globalThis.document, fetch: globalThis.fetch, location: globalThis.location };
  t.after(() => Object.assign(globalThis, prior));
  const slot = new Element('div');
  slot.setAttribute('data-trillion-placement', 'join-form');
  globalThis.document = { querySelectorAll: () => [slot], createElement: tag => new Element(tag) };
  globalThis.location = { search: '?from=front-door', href: 'https://store.example/?from=front-door' };
  const posts = [];
  globalThis.fetch = async (url, options) => {
    if (options?.method !== 'POST') return { ok: true, text: async () => JSON.stringify({ fields: signUp.actions[0].fields, action_url: '/capabilities/join-form/actions', form: words }) };
    posts.push({ url, options });
    return { ok: true, status: 201, json: async () => ({ received: true }) };
  };
  placedCapabilityRuntime();
  await new Promise(resolve => setTimeout(resolve, 0));
  const card = slot.children[0];
  assert.deepEqual(card.children.slice(0, 2).map(node => node.textContent), ['Join the list', 'Hear first when it opens.']);
  const form = card.children[2];
  const inputs = form.querySelectorAll('input[name]');
  assert.deepEqual(inputs.map(input => [input.name, input.type]), [['email', 'email'], ['name', 'text'], ['source', 'hidden']]);
  assert.equal(form.children[0].children[0].textContent, 'Your email');
  assert.equal(inputs[2].value, 'front-door');
  assert.equal(form.querySelector('[data-run-submit]').textContent, 'Join');
  inputs[0].value = 'ana@example.test';
  await form.listeners.submit({ preventDefault() {} });
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, '/capabilities/join-form/actions');
  assert.match(posts[0].options.headers['idempotency-key'], /^[a-f0-9]{32}$/);
  assert.deepEqual(JSON.parse(posts[0].options.body), { email: 'ana@example.test', source: 'front-door' });
  assert.equal(card.children[2].textContent, "Thanks, you're on the list.");
  assert.equal(publicAppActionForm({ fields: [{ id: 'source', type: 'text' }], form: { fields: [{ id: 'source', from_page_address: 'from' }] } }), null);
  assert.match(placedCapabilityScript, /from_page_address/);
});


const contactFields = [{ id: 'email', type: 'email', required: true }, { id: 'message', type: 'text', required: true },
  { id: 'links', type: 'text' }, { id: 'source', type: 'text' }];
const contactWords = { title: 'Get in touch', fields: [{ id: 'message', label: 'Your message', multiline: true },
  { id: 'links', label: 'Your links', repeatable: true, add_label: 'Add another link', remove_label: 'Remove link' },
  { id: 'source', from_page_address: 'from' }] };
function controls(form, name) { return form.querySelectorAll('input[name], textarea[name]').filter(node => node.name === name); }
function button(form, text) { return form.all().find(node => node.tagName === 'button' && node.textContent === text); }
function withDocument(t) {
  const prior = { document: globalThis.document, fetch: globalThis.fetch, location: globalThis.location };
  t.after(() => Object.assign(globalThis, prior));
  globalThis.document = { activeElement: null, createElement: tag => new Element(tag) };
  globalThis.location = { search: '?from=book', href: 'https://example.test/?from=book' };
}
function contactForm() {
  const form = publicAppActionForm({ fields: contactFields, form: contactWords });
  controls(form, 'email')[0].value = 'ana@example.test';
  controls(form, 'message')[0].value = 'I want to build this.';
  return form;
}

test('roomy text and unlimited-count link entries retain pasted text and use accessible add/remove focus', t => {
  withDocument(t);
  const form = contactForm();
  const message = controls(form, 'message')[0];
  assert.equal(message.tagName, 'textarea'); assert.equal(message.rows, 6);
  assert.equal(message.maxLength, undefined);
  assert.equal(form.all().filter(node => node.className === 'trillion-placed-capability__hint').some(node => node.textContent), false);
  message.value = 'm'.repeat(3600); message.listeners.input();
  assert.ok(form.all().some(node => node.textContent === '400 characters left.'));
  message.value = 'I want to build this.'; message.listeners.input();
  assert.equal(form.all().filter(node => node.className === 'trillion-placed-capability__hint').some(node => node.textContent), false);
  const first = controls(form, 'links')[0];
  first.value = 'https://example.test/work\nAn explanation of this work';
  button(form, 'Add another link').listeners.click();
  let links = controls(form, 'links');
  assert.equal(document.activeElement, links[1]);
  links[1].value = 'https://social.example.test/ana';
  for (let index = 0; index < 50; index++) button(form, 'Add another link').listeners.click();
  assert.equal(controls(form, 'links').length, 52);
  assert.equal(form.readActionAnswer().links, `${first.value}\n${links[1].value}`);
  const firstRemove = first.parent.children.find(node => node.tagName === 'button');
  assert.match(firstRemove.getAttribute('aria-label'), /Remove link 1/);
  firstRemove.listeners.click();
  assert.equal(document.activeElement, links[1]);
  assert.equal(form.readActionAnswer().links, links[1].value);
  while (controls(form, 'links').some(input => input.value)) button(form, 'Remove link').listeners.click();
  // Removing the last empty entry focuses Add another and leaves no replacement row.
  while (controls(form, 'links').length > 1) button(form, 'Remove link').listeners.click();
  button(form, 'Remove link').listeners.click();
  assert.equal(controls(form, 'links').length, 0);
  assert.equal(document.activeElement, button(form, 'Add another link'));
  button(form, 'Add another link').listeners.click();
  assert.equal(controls(form, 'links').length, 1);
  assert.equal(document.activeElement, controls(form, 'links')[0]);
  assert.equal(form.readActionAnswer().source, 'book');
  const required = publicAppActionForm({ fields: [{ id: 'links', type: 'text', required: true }], form: { fields: [{ id: 'links', repeatable: true }] } });
  assert.equal(required.readActionAnswer(), null);
  button(required, 'Remove').listeners.click();
  assert.equal(required.readActionAnswer(), null);
  assert.equal(document.activeElement, button(required, 'Add another'));
  button(required, 'Add another').listeners.click();
  controls(required, 'links')[0].value = 'A link and its context';
  assert.equal(required.readActionAnswer().links, 'A link and its context');
});

test('form limits preserve oversized answers, count separators and block oversized UTF-8 payloads', t => {
  withDocument(t);
  const form = contactForm(), message = controls(form, 'message')[0];
  message.value = 'm'.repeat(4000);
  assert.equal(form.readActionAnswer().message.length, 4000);
  message.value += 'm'; message.listeners.input();
  assert.equal(form.readActionAnswer(), null);
  assert.equal(message.value.length, 4001);
  assert.equal(document.activeElement, message);
  assert.equal(message.getAttribute('aria-invalid'), 'true');
  const described = message.getAttribute('aria-describedby').split(' ');
  assert.ok(described.every(id => form.all().some(node => node.id === id)));
  message.value = 'valid'; message.listeners.input();
  assert.equal(message.getAttribute('aria-invalid'), 'false');
  controls(form, 'links')[0].value = 'a'.repeat(3999);
  button(form, 'Add another link').listeners.click();
  controls(form, 'links')[1].value = 'b';
  assert.equal(form.readActionAnswer(), null); // 3999 + separator + 1 = 4001
  assert.equal(controls(form, 'links')[0].value.length, 3999);
  controls(form, 'links')[0].value = '界'.repeat(3000);
  controls(form, 'links')[1].value = '';
  message.value = '界'.repeat(3000);
  assert.equal(form.readActionAnswer(), null); // Both fields are under 4000 JS characters; JSON exceeds 16 KB.
  assert.match(form.querySelector('[data-run-result]').textContent, /This response is too long/);
  assert.equal(message.value.length, 3000);
  controls(form, 'links')[0].value = '';
  message.value = 'valid';
  controls(form, 'email')[0].value = 'not an email';
  assert.equal(form.readActionAnswer(), null);
  assert.equal(document.activeElement, controls(form, 'email')[0]);
  const typed = publicAppActionForm({ fields: [{ id: 'count', type: 'number', required: true }, { id: 'agreed', type: 'boolean', required: true }] });
  controls(typed, 'count')[0].value = '0';
  assert.deepEqual(typed.readActionAnswer(), { count: 0, agreed: false });
  controls(typed, 'count')[0].value = 'bad';
  assert.equal(typed.readActionAnswer(), null);
});

test('failed sends retain values and canonical retry keys while pending sends disable all controls', async t => {
  withDocument(t);
  const slot = new Element('div'); slot.setAttribute('data-trillion-placement', 'contact');
  document.querySelectorAll = () => [slot];
  const posts = []; let release, mode = 'pending';
  globalThis.fetch = async (url, options) => {
    if (options?.method !== 'POST') return { ok: true, text: async () => JSON.stringify({ fields: contactFields, form: contactWords, action_url: '/capabilities/contact/actions' }) };
    posts.push(options);
    if (mode === 'pending') return new Promise(resolve => { release = resolve; });
    if (mode === 'network') throw new Error('offline');
    return { ok: true, json: async () => ({ received: true }) };
  };
  placedCapabilityRuntime(); await new Promise(resolve => setTimeout(resolve, 0));
  const card = slot.children[0], form = card.children[1];
  controls(form, 'email')[0].value = 'ana@example.test';
  controls(form, 'message')[0].value = 'm'.repeat(4001);
  await form.listeners.submit({ preventDefault() {} }); assert.equal(posts.length, 0);
  controls(form, 'message')[0].value = 'Original message';
  controls(form, 'links')[0].value = 'https://example.test';
  const submit = () => form.listeners.submit({ preventDefault() {} });
  const pending = submit();
  assert.equal(form.getAttribute('aria-busy'), 'true');
  assert.ok(form.querySelectorAll('input, textarea, button').every(node => node.disabled));
  await submit(); assert.equal(posts.length, 1);
  release({ ok: false, json: async () => ({ error: 'Please try again.' }) }); await pending;
  assert.ok(form.querySelectorAll('input, textarea, button').every(node => !node.disabled));
  assert.equal(controls(form, 'message')[0].value, 'Original message');
  assert.equal(form.querySelector('[data-run-result]').getAttribute('role'), 'alert');
  mode = 'network'; button(form, 'Add another link').listeners.click(); await submit();
  assert.equal(posts[0].headers['idempotency-key'], posts[1].headers['idempotency-key']);
  controls(form, 'message')[0].value = 'Changed message'; await submit();
  assert.notEqual(posts[1].headers['idempotency-key'], posts[2].headers['idempotency-key']);
  controls(form, 'message')[0].value = 'Original message'; mode = 'success'; await submit();
  assert.equal(posts[0].headers['idempotency-key'], posts[3].headers['idempotency-key']);
  assert.equal(JSON.parse(posts[3].body).links, 'https://example.test');
  assert.equal(card.children[1].dataset.state, 'completed');
});
