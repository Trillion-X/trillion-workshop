// Snapshot trigger policy, declarative parsers and on-device redaction (tools/read-what-is-on-screen/read-data/snapshot-triggers.mjs, moved from Trillion test/snapshot-triggers.test.mjs; F-0046).
import assert from 'node:assert/strict';
import test from 'node:test';
import { createGovernor, parseSnapshot, parserFor, redact, triggerSettings } from '../read-data/snapshot-triggers.mjs';

const settings = triggerSettings();

test('every ask ends in exactly one counted outcome, so a quiet reader shows why it was quiet', () => {
  const governor = createGovernor(settings);
  const outcomes = [
    governor.ask({ trigger: 'app-activated', app: 'A', at: 0 }),
    governor.ask({ trigger: 'app-activated', app: 'A', at: 100 }),          // inside the 300 ms debounce
    governor.ask({ trigger: 'title-changed', app: 'B', at: 400 }),          // inside the 1 s global gap
    governor.ask({ trigger: 'title-changed', app: 'A', at: 2000 }),         // app gap (5 s) not over
    governor.ask({ trigger: 'input', app: 'A', at: 6000 }),
    governor.ask({ trigger: 'periodic', app: 'C', at: 9000 }),
    governor.ask({ trigger: 'app-activated', app: 'A', at: 20_000 }, { locked: true }),
    governor.ask({ trigger: 'app-activated', app: 'A', at: 30_000 }, { memory_pressure: true }),
    governor.ask({ trigger: 'mystery', app: 'A', at: 40_000 }),
  ].map(entry => entry.outcome);
  assert.deepEqual(outcomes, ['taken', 'debounced', 'throttled-global', 'throttled-app', 'taken', 'taken', 'skipped-locked', 'skipped-memory_pressure', 'unknown-trigger']);
  const counts = governor.counts();
  assert.equal(Object.values(counts).reduce((a, b) => a + b, 0), 9);
  assert.equal(counts.taken, 3);
});

test('an app whose snapshots are unchanged is read less often, and returns to normal as soon as one changes', () => {
  const governor = createGovernor(settings);
  governor.report('A', false); governor.report('A', false); governor.report('A', false); governor.report('A', false);
  assert.equal(governor.factor('A'), 8, 'capped at backoff_most');
  assert.equal(governor.ask({ trigger: 'input', app: 'A', at: 0 }).outcome, 'taken');
  assert.equal(governor.ask({ trigger: 'title-changed', app: 'A', at: 20_000 }).outcome, 'throttled-app', '8 x 5 s = 40 s');
  assert.equal(governor.ask({ trigger: 'backgrounded', app: 'A', at: 41_000 }).outcome, 'taken');
  governor.report('A', true); assert.equal(governor.factor('A'), 1);
});

test('a parser row cuts fields out of the elements declaratively, per app, and everything is redacted before it is returned', () => {
  const custom = { ...settings, parsers: [
    { id: 'mail', app_contains: ['mail'], select: { roles: ['statictext'], label_matches: '^(From|Subject): ' }, fields: { sender: { from: 'label', regex: '^From: (.*)$' }, subject: { from: 'label', regex: '^Subject: (.*)$' } } },
    ...settings.parsers,
  ] };
  assert.equal(parserFor(custom, 'Apple Mail').id, 'mail');
  assert.equal(parserFor(custom, 'Notes').id, 'generic-text');
  const elements = [{ role: 'AXStaticText', label: 'From: ana@example.com' }, { role: 'AXStaticText', label: 'Subject: Card 4111 1111 1111 1111 for you' }, { role: 'AXButton', label: 'From: nobody' }, { role: 'AXStaticText', label: 'Other' }];
  assert.deepEqual(parseSnapshot(custom, 'Mail', elements), [{ sender: '[removed]' }, { subject: 'Card [removed] for you' }]);
  assert.deepEqual(parseSnapshot(settings, 'Notes', [{ role: 'AXTextField', label: 'token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk' }]), [{ text: 'token [removed]' }]);
  assert.equal(redact('user-80305c9b@example.com and plain text'), '[removed] and plain text');
  assert.deepEqual(parseSnapshot({ ...settings, parsers: [] }, 'X', elements), []);
  console.log('REAL readback of a parsed and redacted snapshot:', JSON.stringify(parseSnapshot(custom, 'Mail', elements)));
});
