import test from 'node:test';
import assert from 'node:assert/strict';
import { renderAView } from '../../compare-two-movements-side-by-side/tests/render-a-view.ts';

const card = new URL('../show/pricing/PricingCard.tsx', import.meta.url).pathname;
const contact = new URL('../show/pricing/ContactCard.tsx', import.meta.url).pathname;
const features = [
  { id: 'lessons', label: 'All lessons in one library', showcase: [{ id: 'a', src: '/a.jpg', label: 'Forehand' }, { id: 'b', src: '/b.jpg', label: 'Stance' }] },
  { id: 'courses', label: 'Complete courses', showcase: [{ id: 'c', src: '/c.jpg', label: 'Masterclass' }] },
  { id: 'community', label: 'A member community' },
];
const offer = { id: 'membership', name: 'Membership', price: '$99', cadence: '/month', note: 'Pay what you want.', features, cta: { label: 'Checkout - $99/month' } };

test('the card draws its name, price, note, every feature with its pictures, and the checkout button twice on a long card', async () => {
  const html = await renderAView(card, offer);
  for (const word of ['Membership', '$99', '/month', 'Pay what you want.', 'All lessons in one library', 'Complete courses', 'A member community', 'Forehand', 'Masterclass']) assert.ok(html.includes(word), word);
  assert.equal((html.match(/data-pricing-cta/g) ?? []).length, 2);
  assert.match(html, /data-offer-card="membership"/);
});

test('a short card draws the button once; a card with no price draws none; a link button has its address', async () => {
  assert.equal((await renderAView(card, { ...offer, features: features.slice(0, 1) })).match(/data-pricing-cta/g)?.length, 1);
  const call = await renderAView(card, { id: 'call', name: 'Book a call', cta: { label: 'Book', href: '/book' } });
  assert.doesNotMatch(call, /\$/);
  assert.match(call, /href="\/book"/);
});

test('a pending checkout disables the button and an error shows as an alert', async () => {
  const html = await renderAView(card, { ...offer, pending: true, error: 'Checkout is not open.' });
  assert.match(html, /disabled=""[^>]*data-pricing-cta|data-pricing-cta[^>]*disabled=""|disabled=""/);
  assert.match(html, /role="alert"[^>]*>Checkout is not open\./);
});

const fields = [{ name: 'email', label: 'Email', type: 'email', required: true, value: 'a@example.com' }, { name: 'name', label: 'Name (optional)' }];

test('the contact card draws its words, its fields with their values and one button', async () => {
  const html = await renderAView(contact, { title: 'Not seeing what fits?', lead: 'Book a call.', fields, button: 'Send', note: 'A short call.' });
  for (const word of ['Not seeing what fits?', 'Book a call.', 'Email', 'Name (optional)', 'Send', 'A short call.']) assert.ok(html.includes(word), word);
  assert.match(html, /value="a@example\.com"/);
  assert.match(html, /name="email"/);
  assert.match(html, /<button[^>]*type="submit"/);
});

test('sending disables the button and an error shows as an alert', async () => {
  const html = await renderAView(contact, { title: 'T', fields, button: 'Send', sending: true, error: 'Try again.' });
  assert.match(html, /<button[^>]*disabled=""[^>]*>Send</);
  assert.match(html, /role="alert"[^>]*>Try again\./);
});

test('a card given an action is one plain post form: hidden fields, a submit button, no callback needed', async () => {
  const html = await renderAView(card, { ...offer, action: '/target/start-checkout', hiddenFields: { plan: 'membership', cadence: 'month' } });
  assert.match(html, /<form[^>]*method="post"[^>]*>|<form[^>]*action="\/target\/start-checkout"[^>]*>/);
  assert.match(html, /action="\/target\/start-checkout"/);
  assert.match(html, /<input[^>]*type="hidden"[^>]*name="plan"[^>]*value="membership"|<input[^>]*name="plan"[^>]*type="hidden"/);
  assert.match(html, /name="cadence"/);
  assert.equal((html.match(/<button[^>]*type="submit"[^>]*data-pricing-cta|<button[^>]*data-pricing-cta[^>]*type="submit"/g) ?? []).length, 2);
  assert.equal((html.match(/<form/g) ?? []).length, 1);
});

test('a card with no action draws no form; a link button with an action stays a link', async () => {
  assert.doesNotMatch(await renderAView(card, offer), /<form/);
  const link = await renderAView(card, { id: 'call', name: 'Book a call', cta: { label: 'Book', href: '/book' }, action: '/target/x' });
  assert.match(link, /href="\/book"/);
  assert.doesNotMatch(link, /type="submit"/);
});

test('the contact card given an action posts its named fields as a plain form, with typed values as defaults', async () => {
  const html = await renderAView(contact, { title: 'T', fields, button: 'Send', action: '/target/contact', hiddenFields: { form: 'contact' } });
  assert.match(html, /<form[^>]*action="\/target\/contact"/);
  assert.match(html, /method="post"/);
  assert.match(html, /name="form"[^>]*value="contact"|value="contact"[^>]*name="form"/);
  assert.match(html, /name="email"/);
  assert.match(html, /value="a@example\.com"/);
  assert.match(html, /<button[^>]*type="submit"/);
});
