// The shipped strip script, executed with a synthetic DOM: choosing what is shown never warms media by itself.
// The shared player's intent owner chooses preload. No browser, account, network or media bytes are reached here.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

const script = readFileSync(new URL('../on-a-computer/share-page/assets/share-page.js', import.meta.url), 'utf8');

function element() {
  const events = new Map(), classes = new Set(), attributes = new Map();
  return {
    dataset: {}, children: [], preload: 'none', paused: 0,
    classList: { add: value => classes.add(value), contains: value => classes.has(value),
      toggle: (value, shown) => shown ? classes.add(value) : classes.delete(value) },
    setAttribute: (name, value) => attributes.set(name, value),
    getAttribute: name => attributes.get(name),
    append(...children) { this.children.push(...children); },
    after(child) { this.following = child; },
    addEventListener: (name, action) => events.set(name, action),
    dispatch: (name, event) => events.get(name)?.(event),
    pause() { this.paused += 1; },
    scrollIntoView() {},
  };
}

function page(count, hash = '') {
  const main = element(), document = element(), window = element();
  const items = Array.from({ length: count }, (_, n) => {
    const item = element();
    item.dataset = { name: `Clip ${n}`, poster: `/poster/${n}` };
    item.media = element();
    item.querySelectorAll = () => [item.media];
    return item;
  });
  const location = { hash };
  Object.assign(document, { documentElement: element(), querySelector: () => main, querySelectorAll: () => items,
    createElement: () => element() });
  const history = { replaceState: (_state, _title, address) => { location.hash = address; } };
  runInNewContext(script, { document, window, location, history });
  return { items, document, window, location, buttons: main.following?.children ?? [] };
}

test('showing the first of several items reads no media metadata before viewer intent', () => {
  const { items, buttons } = page(3);
  assert.deepEqual(items.map(item => item.media.preload), ['none', 'none', 'none']);
  assert.deepEqual(items.map(item => item.classList.contains('is-shown')), [true, false, false]);
  assert.deepEqual(buttons.map(button => button.getAttribute('aria-current')), ['true', 'false', 'false']);
});

test('one item is left to the shared player without changing its preload', () => {
  const { items, buttons } = page(1);
  assert.equal(items[0].media.preload, 'none');
  assert.deepEqual(buttons, []);
});

test('picking another item pauses the old one, keeps the address, and does not take over preload', () => {
  const { items, buttons, location } = page(2);
  items[0].media.preload = 'auto';
  buttons[1].dispatch('click');
  assert.equal(items[0].media.paused, 1);
  assert.deepEqual(items.map(item => item.media.preload), ['auto', 'none']);
  assert.equal(location.hash, '#item-1');
  assert.deepEqual(items.map(item => item.classList.contains('is-shown')), [false, true]);
});

test('an address and arrow navigation choose an item without speculative reads or stealing form keys', () => {
  const { items, document, window, location } = page(3, '#item-1');
  const target = { closest: () => null };
  document.dispatch('keydown', { target, key: 'ArrowRight' });
  assert.equal(location.hash, '#item-2');
  document.dispatch('keydown', { target: { closest: () => ({}) }, key: 'ArrowLeft' });
  assert.equal(location.hash, '#item-2');
  location.hash = '#item-0';
  window.dispatch('hashchange');
  assert.deepEqual(items.map(item => item.classList.contains('is-shown')), [true, false, false]);
  assert.deepEqual(items.map(item => item.media.preload), ['none', 'none', 'none']);
});
