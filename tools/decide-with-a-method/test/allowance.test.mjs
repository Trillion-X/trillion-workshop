// The free-decision allowance words (read-data/allowance.mjs), ported from the old app's src/allowance.mjs, and the two
// functions it reuses from read-data/work-screen.mjs (decisionLimit, pursuitsWords), checked against the old logic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { keepsWords, leftWords, periodOf, usedUpWords, withheldWords } from '../read-data/allowance.mjs';
import { decisionLimit, pursuitsWords } from '../read-data/work-screen.mjs';

const upgrade = { offer: 'Plus plan', price: '$9 a month', url: 'https://example.com/account' };
const friday = new Date('2026-11-20T12:00:00Z');

test('leftWords counts what is left of the allowance and names the period in words', () => {
  assert.equal(leftWords({ count: 5, per: 'month', used: 2 }), '3 of 5 free decisions left this month.');
  assert.equal(leftWords({ count: 5, per: 'week', used: 5 }), '0 of 5 free decisions left this week.');
});

test('leftWords never shows a negative count when more were used than allowed', () => {
  assert.equal(leftWords({ count: 3, per: 'day', used: 9 }), '0 of 3 free decisions left this day.');
});

test('leftWords falls back to the period name itself when it has no word', () => {
  assert.equal(leftWords({ count: 2, per: 'fortnight', used: 1 }), '1 of 2 free decisions left this fortnight.');
});

test('usedUpWords names the count, the upgrade, the paid worth and the reset date computed from the period', () => {
  assert.equal(usedUpWords({ count: 3, per: 'week', upgrade, now: friday }), 'You have used the 3 free decisions you get each week. To keep deciding now, Plus plan is $9 a month: https://example.com/account. It keeps every decision and what you are working toward, so nothing is lost between chats or when a long conversation is shortened, and every AI you use (Claude, ChatGPT, Grok, Gemini, Muse or any other that connects) reads the same account. It also shows how other people\'s similar decisions turned out, and your AI can run the tools in the Marketplace for you. Your free decisions start again on November 23, 2026.');
});

test('usedUpWords resets a month on the first of the next month', () => {
  assert.match(usedUpWords({ count: 3, per: 'month', upgrade, now: friday }), /start again on December 1, 2026\.$/);
});

test('periodOf names a week by its Monday and ends it the Monday after; a Sunday belongs to the week before', () => {
  assert.deepEqual({ key: periodOf('week', new Date('2026-11-22T09:00:00Z')).key }, { key: 'week-of-2026-11-16' });
  assert.equal(periodOf('week', friday).next.toISOString(), '2026-11-23T00:00:00.000Z');
});

test('periodOf names a day, month and year by their UTC date parts', () => {
  assert.equal(periodOf('day', new Date('2026-11-20T23:30:00Z')).key, '2026-11-20');
  assert.equal(periodOf('month', friday).key, '2026-11');
  assert.equal(periodOf('year', friday).next.toISOString(), '2027-01-01T00:00:00.000Z');
});

test('periodOf refuses a period it does not count', () => {
  assert.throws(() => periodOf('quarter'), /An allowance is counted per day, week, month, year; quarter is not one of them\./);
});

test('keepsWords says nothing is kept on the free plan and names the upgrade link', () => {
  assert.equal(keepsWords(upgrade), 'Nothing from this decision is kept on the free plan. Plus plan, $9 a month, keeps your decisions and what you are working toward, so each one builds on the last: https://example.com/account');
});

test('withheldWords names the feature, the free allowance in words, the upgrade and what it adds', () => {
  assert.equal(
    withheldWords({ feature: { label: 'Marketplace tools' }, allowance: { count: 3, per: 'month' }, upgrade, adds: 'unlimited decisions; kept history' }),
    'This is part of Plus plan ($9 a month), not the free plan: Marketplace tools. The free plan is 3 decisions a month and nothing else. Plus plan adds: unlimited decisions; kept history. Upgrade here: https://example.com/account',
  );
});

test('withheldWords leaves the count and period out when the person has no allowance row', () => {
  assert.match(withheldWords({ feature: { label: 'Kept history' }, allowance: null, upgrade, adds: '' }), /The free plan is  decisions a  and nothing else\./);
});

test('decisionLimit reused from work-screen.mjs gives the most generous decision-method limit, as allowance.mjs did', () => {
  const access = { limits: { 'access:decision-method': [{ count: 3, per: 'week' }, { count: 10, per: 'month' }, { count: 5, per: 'day' }] } };
  assert.deepEqual(decisionLimit(access), { count: 10, per: 'month' });
  assert.equal(decisionLimit({ limits: {} }), null);
  assert.equal(decisionLimit({}), null);
});

test('pursuitsWords reused from work-screen.mjs says the plain sentence without a measurement and the measured one with it', () => {
  const plain = pursuitsWords(null);
  assert.deepEqual(plain, {
    text: 'Every decision is weighed against what you are working toward and what it changes beyond you. Tell your AI, and it adds it for you.',
    measured: false,
  });
  const measured = pursuitsWords({
    with: { enough: true, worked_share: 0.5, people_at_least: 12 },
    without: { enough: true, worked_share: 0.2, people_at_least: 30 },
  });
  assert.equal(measured.measured, true);
  assert.match(measured.text, /worked 50% of the time, against 20% for the rest \(at least 12 people in each group\)\. Tell your AI what you are working toward, and it adds it for you\.$/);
});

test('pursuitsWords falls back to the plain sentence when one group has too few people to measure', () => {
  const measured = pursuitsWords({ with: { enough: true, worked_share: 0.9, people_at_least: 2 }, without: { enough: false, worked_share: 0.1, people_at_least: 1 } });
  assert.equal(measured.measured, false);
});
