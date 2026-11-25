// tools/keep-an-elestio-firewall/test/keep-every-elestio-firewall.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keepEveryElestioFirewall, ROWS } from '../do-work/keep-every-elestio-firewall.mjs';

const ALL = ['0.0.0.0/0', '::/0'];
const rule = (port, protocol = 'tcp') => ({ type: 'INPUT', port, protocol, targets: ALL });
const RULES = [rule('22'), rule('4242', 'udp'), rule('80'), rule('443')];
const firewall = vm => ({ provider: 'elestio', tool: 'tool:keep-an-elestio-firewall', account_email: 'owner@example.test', project_id: '90000', vm_id: vm, rules: RULES });
const READ_AT = '2026-11-25T12:00:00.000Z';

// A stand-in Elestio holding one firewall per vmID; an update takes effect at once.
function standIn(services) {
  const asked = [];
  const post = async (step, path, body) => {
    asked.push({ step, body });
    if (path === 'auth/checkAPIToken') return { status: 'OK', jwt: 'made-up-session' };
    const service = services[body.vmID];
    if (!service) throw new Error(`${step} answered 500: An error occured`);
    if (path === 'servers/getServerDetails') return { status: 'OK', serviceInfos: [{ vmID: body.vmID, isFirewallActivated: service.on ? 1 : 0 }] };
    if (body.action === 'getFirewallRules') return { status: 'OK', rules: service.rules };
    if (body.action === 'enableFirewall' || body.action === 'updateFirewall') { Object.assign(service, { on: true, rules: body.rules }); return { status: 'OK' }; }
    throw new Error(`unexpected ${path}`);
  };
  return { asked, post };
}
const clock = () => { let at = Date.parse(READ_AT); return { now: () => at, wait: async ms => { at += ms; } }; };

test('every row kept at Elestio is made equal to its rules: a reopened dashboard port is closed, an equal one is left alone, with one sign-in', async () => {
  const services = { 170000001: { on: true, rules: [...RULES, rule('18445')] }, 170000002: { on: true, rules: [...RULES] } };
  const { asked, post } = standIn(services);
  const statements = [];
  const sql = async (statement, params) => { statements.push({ statement, params }); return [{ name: 'box-a', firewall: firewall('170000001'), read_at: READ_AT }, { name: 'box-b', firewall: firewall('170000002'), read_at: READ_AT }]; };
  const answer = await keepEveryElestioFirewall({ credential_name: 'example-connection', poll_seconds: 1 }, { sql, read: () => 'made-up-token', post, ...clock() });
  assert.equal(answer.ok, true);
  assert.equal(answer.read_at, READ_AT);
  assert.deepEqual(answer.kept.map(item => [item.computer, item.ok, item.action, item.closed.map(r => r.port)]), [['box-a', true, 'updateFirewall', ['18445']], ['box-b', true, null, []]]);
  assert.equal(asked.filter(call => call.step === 'auth/checkAPIToken').length, 1, 'one sign-in for the account');
  assert.deepEqual(services[170000001].rules.map(r => r.port).sort(), ['22', '4242', '443', '80']);
  assert.deepEqual(statements, [{ statement: ROWS, params: [null] }]);
  assert.ok(!JSON.stringify(answer).includes('made-up'), 'no token or session in the answer');
});

test('a computer that fails is told and the others are still kept', async () => {
  const services = { 170000002: { on: false, rules: [] } };
  const { post } = standIn(services);
  const sql = async () => [{ name: 'box-gone', firewall: firewall('170000009'), read_at: READ_AT }, { name: 'box-b', firewall: firewall('170000002'), read_at: READ_AT }];
  const answer = await keepEveryElestioFirewall({ credential_name: 'example-connection', poll_seconds: 1 }, { sql, read: () => 't', post, ...clock() });
  assert.equal(answer.ok, false);
  assert.match(answer.kept[0].error, /getServerDetails answered 500/);
  assert.deepEqual([answer.kept[1].ok, answer.kept[1].action], [true, 'enableFirewall']);
});

test('apply false only reads; only names one row; no rows is not ok; no connection name is refused', async () => {
  const services = { 170000001: { on: true, rules: [...RULES, rule('18445')] } };
  const { asked, post } = standIn(services);
  let given;
  const sql = async (statement, params) => { given = params; return [{ name: 'box-a', firewall: firewall('170000001'), read_at: READ_AT }]; };
  const answer = await keepEveryElestioFirewall({ credential_name: 'c', apply: false, only: 'box-a' }, { sql, read: () => 't', post, ...clock() });
  assert.deepEqual(given, ['box-a']);
  assert.equal(answer.kept[0].reason, 'apply was false: nothing was sent');
  assert.equal(asked.some(call => call.body?.action === 'updateFirewall'), false);
  assert.equal((await keepEveryElestioFirewall({ credential_name: 'c' }, { sql: async () => [], read: () => 't', post })).ok, false);
  await assert.rejects(keepEveryElestioFirewall({}, { sql: async () => [] }), /credential_name must name/);
});
