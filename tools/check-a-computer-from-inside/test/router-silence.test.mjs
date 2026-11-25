// tools/check-a-computer-from-inside/do-work/due-times-told.mjs routerSilence: a router (workflow:route-each-row-change) that
// fired, so heard changes, while no workflow was chosen. Every computer here is made up.
import assert from 'node:assert/strict';
import test from 'node:test';
import { checkHere, wakeBookFindings } from '../do-work/check-from-inside.mjs';
import { routerSilence, routerSilenceFinding } from '../do-work/due-times-told.mjs';

const NOW = Date.parse('2026-11-25T15:30:00Z');
const minutesAgo = minutes => NOW - minutes * 60000;
const router = (id, firedMs, more = {}) => ({ tool: 'workflow:route-each-row-change', id, on: { fact: { kind: 'something-changed' } }, switched_on: true, switch_stands: true, mark: firedMs === null ? {} : { fired_ms: firedMs }, ...more });
const chosen = (id, firedMs, more = {}) => ({ tool: 'workflow:some-workflow', id, on: { fact: { kind: 'workflow-chosen' } }, switched_on: true, switch_stands: true, mark: firedMs === null ? {} : { fired_ms: firedMs }, ...more });
const silent = book => routerSilence(book, NOW).silent.map(item => item.wake);

test('a router that never fired is no finding', () => {
  assert.deepEqual(silent([router('a-row-changed', null), chosen('chosen--x', null)]), []);
});

test('a router that fired and a chosen wake that fired after it, or within the window before it, is no finding', () => {
  assert.deepEqual(silent([router('a-row-changed', minutesAgo(3)), chosen('chosen--x', minutesAgo(2))]), []);
  assert.deepEqual(silent([router('a-row-changed', minutesAgo(3)), chosen('chosen--x', minutesAgo(10))]), [], '7 minutes before the router, inside the 15-minute window');
});

test('a router that fired with the last chosen tell long before it is silent, and the finding names both times', () => {
  const book = [router('a-row-changed', minutesAgo(3)), router('a-service-told-a-change/elestio', minutesAgo(9)), chosen('chosen--x', minutesAgo(40))];
  assert.deepEqual(silent(book), ['a-row-changed', 'a-service-told-a-change/elestio']);
  const said = routerSilenceFinding('this-computer', routerSilence(book, NOW));
  assert.deepEqual([said.kind, said.level], ['router-hears-but-tells-nothing', 'alert']);
  assert.match(said.said, /a-row-changed, a-service-told-a-change\/elestio on this-computer last fired at 2026-11-25T15:27:00\.000Z/);
  assert.match(said.said, /fired at 2026-11-25T14:50:00\.000Z/);
});

test('chosen wakes all switched off, or none that stands, is the silence too', () => {
  assert.deepEqual(silent([router('a-row-changed', minutesAgo(3)), chosen('chosen--x', minutesAgo(1), { switched_on: false }), chosen('chosen--y', minutesAgo(1), { switch_stands: false })]), ['a-row-changed']);
  assert.match(routerSilenceFinding('x', routerSilence([router('a-row-changed', minutesAgo(3))], NOW)).said, /no wake of a chosen kind has fired \(or none is on\)/);
});

test('a router not running (last fire older than an hour), a router off, another tool and a router id not named are not judged', () => {
  assert.deepEqual(silent([router('a-row-changed', minutesAgo(90))]), []);
  assert.deepEqual(silent([router('a-row-changed', minutesAgo(3), { switched_on: false }), router('another-one', minutesAgo(3)), router('a-row-changed', minutesAgo(3), { tool: 'workflow:other' })]), []);
});

test('the last fact of the chosen kind told by anyone is not a chosen wake firing', () => {
  const stale = chosen('chosen--x', minutesAgo(600), { kind_last_told: { at_ms: minutesAgo(1) } });
  assert.deepEqual(silent([router('a-row-changed', minutesAgo(3)), stale]), ['a-row-changed']);
});

test('an engine read over SSH tells the router silence beside its other findings; an unreadable book is its own finding', () => {
  const quiet = wakeBookFindings([{ unit: 'u', wakes: [router('a-row-changed', minutesAgo(3)), chosen('chosen--x', minutesAgo(40))], switch_history: [] }], NOW);
  assert.deepEqual(quiet.map(finding => [finding.kind, finding.level, finding.about]), [['router-hears-but-tells-nothing', 'alert', 'u']]);
  assert.deepEqual(wakeBookFindings([{ unit: 'u', wakes: [router('a-row-changed', minutesAgo(3)), chosen('chosen--x', minutesAgo(2))], switch_history: [] }], NOW), []);
  assert.deepEqual(wakeBookFindings([{ unit: 'u', why: 'the door refused: "x"' }], NOW).map(finding => finding.kind), ['wake-book-not-read']);
});

test('this computer is read through its own door, asking each kind, and tells the silence', async () => {
  const door = { url: 'http://127.0.0.1:1/mcp', resource: '@own-records', capability: 'c' };
  const kindsAsked = [];
  const books = { 'something-changed': [router('a-row-changed', minutesAgo(3))], 'workflow-chosen': [chosen('chosen--x', minutesAgo(40))], 'due-time': [], 'workflow-chosen-from-rows': [] };
  const fetchImpl = async (url, init) => {
    const kind = JSON.parse(init.body).params.arguments.input.kind;
    kindsAsked.push(kind);
    return { ok: true, text: async () => JSON.stringify({ result: { structuredContent: { computer: 'the-mac', wakes: books[kind], switch_history: [], next: null } } }) };
  };
  const seen = await checkHere({}, { door, nowMs: NOW, fetchImpl });
  assert.deepEqual(kindsAsked, ['due-time', 'something-changed', 'workflow-chosen', 'workflow-chosen-from-rows']);
  assert.deepEqual(seen.findings.map(finding => [finding.computer, finding.kind]), [['the-mac', 'router-hears-but-tells-nothing']]);
  books['workflow-chosen'] = [chosen('chosen--x', minutesAgo(2))];
  assert.deepEqual((await checkHere({}, { door, nowMs: NOW, fetchImpl })).findings, []);
});
