// tools/keep-an-elestio-firewall/test/keep-an-elestio-firewall.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkedRules, keepAnElestioFirewall, makeElestio, normal } from '../do-work/keep-an-elestio-firewall.mjs';

const ALL = ['0.0.0.0/0', '::/0'];
const rule = (port, protocol = 'tcp', targets = ALL) => ({ type: 'INPUT', port, protocol, targets });
const WANT = [rule('22'), rule('4242', 'udp'), rule('80'), rule('443')];
const request = { email: 'owner@example.test', project_id: '90000', vm_id: '170000000', rules: WANT, poll_seconds: 1 };

// A stand-in Elestio service: `on` and `rules` are its firewall; an enable or update takes effect after `lag` reads.
function standIn({ on = false, rules = [], lag = 0 } = {}) {
  const asked = [];
  let pending = null, reads = 0;
  const post = async (step, path, body) => {
    asked.push({ step, body });
    if (path === 'auth/checkAPIToken') return { status: 'OK', jwt: 'made-up-session' };
    if (path === 'servers/getServerDetails') {
      reads += 1;
      if (pending && reads > pending.at) { ({ on, rules } = pending); pending = null; }
      return { status: 'OK', serviceInfos: [{ vmID: body.vmID, isFirewallActivated: on ? 1 : 0, token: 'made-up-service-token' }] };
    }
    if (body.action === 'getFirewallRules') return { status: 'OK', rules };
    if (body.action === 'enableFirewall' || body.action === 'updateFirewall') { pending = { on: true, rules: body.rules, at: reads + lag }; return { status: 'OK' }; }
    throw new Error(`unexpected ${path} ${body.action}`);
  };
  return { asked, post };
}
function clock(start = Date.parse('2026-11-25T09:10:00Z')) {
  let at = start;
  return { now: () => at, wait: async ms => { at += ms; } };
}
const run = (service, extra = {}) => {
  const { asked, post } = standIn(service);
  return keepAnElestioFirewall({ ...request, ...extra }, { read: () => 'made-up-token\n', post, ...clock() }).then(answer => ({ answer, asked }));
};
const sent = asked => asked.filter(call => ['enableFirewall', 'updateFirewall'].includes(call.body.action));

test('a firewall that is off is switched on with exactly the rules, and read back', async () => {
  const { answer, asked } = await run({ on: false });
  assert.equal(answer.ok, true);
  assert.equal(answer.action, 'enableFirewall');
  assert.equal(answer.before.on, false);
  assert.equal(answer.after.on, true);
  assert.deepEqual(answer.after.rules, checkedRules(WANT));
  assert.equal(answer.opened.length, 4);
  assert.deepEqual(answer.closed, []);
  assert.deepEqual(sent(asked)[0].body, { jwt: 'made-up-session', vmID: '170000000', action: 'enableFirewall', rules: checkedRules(WANT) });
  assert.deepEqual(asked[0].body, { email: 'owner@example.test', token: 'made-up-token' });
  assert.ok(!JSON.stringify(answer).includes('made-up'), 'no token, session or service token in the answer');
});

test('a firewall that is on with other rules is replaced, closing a dashboard tool port the rules leave out', async () => {
  const { answer, asked } = await run({ on: true, rules: [...WANT, rule('18445')] });
  assert.equal(answer.ok, true);
  assert.equal(answer.action, 'updateFirewall');
  assert.deepEqual(answer.closed, [normal(rule('18445'))]);
  assert.deepEqual(answer.opened, []);
  assert.equal(sent(asked).length, 1);
});

test('a firewall that already equals the rules is left alone; the rules match in any order and spelling', async () => {
  const shuffled = [{ type: 'input', port: 443, protocol: 'TCP', targets: '::/0, 0.0.0.0/0' }, rule('80'), rule('4242', 'udp'), rule('22')];
  const { answer, asked } = await run({ on: true, rules: shuffled.map(normal) }, { rules: [...WANT].reverse() });
  assert.equal(answer.ok, true);
  assert.equal(answer.action, null);
  assert.equal(sent(asked).length, 0);
  assert.equal(answer.reads, 0);
});

test('apply false reads and tells the difference, sending nothing', async () => {
  const { answer, asked } = await run({ on: false }, { apply: false });
  assert.equal(answer.ok, false);
  assert.equal(answer.action, null);
  assert.equal(answer.reason, 'apply was false: nothing was sent');
  assert.equal(answer.still_differs.open.length, 4);
  assert.equal(sent(asked).length, 0);
});

test('Elestio taking a few reads to apply is waited for; one that never applies answers why', async () => {
  const slow = await run({ on: false, lag: 3 });
  assert.equal(slow.answer.ok, true);
  assert.equal(slow.answer.reads, 4);
  const { asked, post } = standIn({ on: false, lag: 1000 });
  const never = await keepAnElestioFirewall({ ...request, wait_seconds: 3 }, { read: () => 't', post, ...clock() });
  assert.equal(never.ok, false);
  assert.equal(never.reason, 'the firewall is still off after 3 s');
  assert.equal(sent(asked).length, 1);
});

test('a rule set that would cut off Elestio is refused before any call', async () => {
  const { asked, post } = standIn();
  const refused = rules => keepAnElestioFirewall({ ...request, rules }, { read: () => 't', post });
  await assert.rejects(refused([rule('4242', 'udp'), rule('443')]), /keep 22\/tcp open to 0\.0\.0\.0\/0 and ::\/0/);
  await assert.rejects(refused([rule('22', 'tcp', ['198.51.100.7/32']), rule('4242', 'udp')]), /keep 22\/tcp open/);
  await assert.rejects(refused([rule('22')]), /keep 4242\/udp open/);
  await assert.rejects(refused([]), /at least the ports Elestio needs/);
  assert.equal(asked.length, 0);
});

test('a wrong rule shape is refused with the rule named', () => {
  assert.throws(() => checkedRules([...WANT, rule('99999')]), /port must be/);
  assert.throws(() => checkedRules([...WANT, rule('5432', 'icmp')]), /protocol must be/);
  assert.throws(() => checkedRules([...WANT, rule('5432', 'tcp', [])]), /targets must name/);
  assert.throws(() => checkedRules([...WANT, rule('5432', 'tcp', ['example.com'])]), /IP address or a CIDR/);
  assert.throws(() => checkedRules([...WANT, { ...rule('5432'), type: 'FORWARD' }]), /INPUT or OUTPUT/);
  assert.throws(() => checkedRules([...WANT, rule('80')]), /given twice/);
  assert.deepEqual(checkedRules([...WANT, rule('8000-8010', 'tcp', ['198.51.100.0/24'])]).find(r => r.port === '8000-8010').targets, ['198.51.100.0/24']);
});

test('an empty held token is refused before any call', async () => {
  const { asked, post } = standIn();
  await assert.rejects(keepAnElestioFirewall(request, { read: () => '\n', post }), /held Elestio token is empty/);
  assert.equal(asked.length, 0);
});

test('a refused call names the step and the service words, with key-like text masked', async () => {
  const post = makeElestio({ send: async () => new Response(JSON.stringify({ status: 'KO', details: 'An error occured for abcdefghijklmnopqrstuvwxyz0123' }), { status: 500 }) });
  await assert.rejects(post('getFirewallRules', 'servers/DoActionOnServer', {}), /^Error: getFirewallRules answered 500: An error occured for <masked>$/);
});
