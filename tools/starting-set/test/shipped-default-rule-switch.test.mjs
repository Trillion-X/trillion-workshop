// tools/starting-set/test/shipped-default-rule-switch.test.mjs
//
// A person switches a shared switch of a shipped type's rules off (starting.<type>.switches.<switch>.on false). Rules
// that share a switch switch together; a rule with no switch switches by its own id. With no record the shipped outcome
// is unchanged; with one-pane-at-a-time off the pane limit and both pane controls go, and no other rule moves.
// Run with node --test once the lead's go is given.
import assert from 'node:assert/strict';
import test from 'node:test';
import { shippedUnder, shippedOff } from '../read-data/shipped-default.mjs';
import { changedRecord } from '../../set-up-my-account/read-data/show-rules.mjs';
import showRulesData from '../../set-up-my-account/read-data/show-rules.json' with { type: 'json' };

const LABEL = 'show-rules';
const SIMPLE = 'simple-workspace';
const typeOf = laid => laid.types.find(type => type.id === SIMPLE);
const ruleIds = laid => typeOf(laid).rules.map(rule => rule.id);
const switchedOff = name => ({ starting: { [SIMPLE]: { switches: { [name]: { on: false } } } } });

test('with no record, the Simple outcome is the shipped one: the pane limit, both pane controls and the tab limit', () => {
  const laid = shippedUnder(LABEL, null);
  assert.deepEqual(laid.in_use, [SIMPLE]);
  for (const id of ['one-pane-at-a-time', 'one-pane-at-a-time-controls', 'one-tab-at-a-time']) assert.ok(ruleIds(laid).includes(id), id);
  assert.ok(!ruleIds(laid).includes('one-container-one-tab'));
});

test('one switch off takes out every rule that shares it, and no other rule moves', () => {
  const before = shippedUnder(LABEL, null);
  const laid = shippedUnder(LABEL, { ...switchedOff('one-pane-at-a-time') });
  assert.deepEqual(ruleIds(laid), ruleIds(before).filter(id => !['one-pane-at-a-time', 'one-pane-at-a-time-controls'].includes(id)));
  for (const id of ['one-tab-at-a-time', 'sidebar-on-the-left', 'only-the-everyday-controls']) {
    assert.deepEqual(typeOf(laid).rules.find(rule => rule.id === id), typeOf(before).rules.find(rule => rule.id === id), id);
  }
  assert.deepEqual(laid.in_use, before.in_use);
});

test('a rule with no switch of its own switches by its id', () => {
  const before = shippedUnder(LABEL, null);
  const laid = shippedUnder(LABEL, { ...switchedOff('one-tab-at-a-time') });
  assert.ok(!ruleIds(laid).includes('one-tab-at-a-time'));
  assert.ok(ruleIds(laid).includes('one-pane-at-a-time'));
});

test('the switch is written as the record names it, the shipped type is not written, and turning it on again removes it', () => {
  const before = shippedUnder(LABEL, null);
  const laid = shippedUnder(LABEL, { ...switchedOff('one-pane-at-a-time') });
  const kept = shippedOff(LABEL, laid, switchedOff('one-pane-at-a-time'));
  assert.deepEqual(kept.starting, switchedOff('one-pane-at-a-time').starting);
  assert.equal(kept.types, undefined, 'the shipped type is not written into the record');
  // Turned on again: the switch is removed from the record, so the laid type has every rule and the record holds no switch.
  const restored = shippedOff(LABEL, shippedUnder(LABEL, null), { ...switchedOff('one-pane-at-a-time') });
  assert.equal(restored.starting, undefined, 'turned on again, nothing is left switched off');
});

test('a switch the store writes through use { type, switch, on } is kept by the record writer', () => {
  const laid = shippedUnder(LABEL, null);
  const next = changedRecord(showRulesData, laid, { use: { type: SIMPLE, switch: 'one-pane-at-a-time', on: false } }, Date.parse('2026-11-21T21:00:00Z'), 'personal');
  const kept = shippedOff(LABEL, next, null);
  assert.deepEqual(kept.starting, switchedOff('one-pane-at-a-time').starting);
  assert.deepEqual(kept.in_use, undefined, 'the shipped in_use is not written: it is on by default');
  const back = changedRecord(showRulesData, shippedUnder(LABEL, kept), { use: { type: SIMPLE, switch: 'one-pane-at-a-time', on: true } }, Date.parse('2026-11-21T21:00:00Z'), 'personal');
  assert.equal(shippedOff(LABEL, back, kept).starting, undefined, 'turned on again, the record holds no switch');
});
