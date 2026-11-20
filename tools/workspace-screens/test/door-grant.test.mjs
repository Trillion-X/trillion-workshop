// tools/workspace-screens/test/door-grant.test.mjs
//
// The door grant screen's pure decisions (web/src/workspace/door-grant.mjs): the grant an address asks for is decoded and
// shape-checked before anything is sent, keep/list/stop are the door calls pinned to the one computer the address names,
// and last use, who, and refusals read as their own words.
import test from 'node:test';
import assert from 'node:assert/strict';
import { APPROVAL_SCOPE, APPROVAL_SQL, approvalParams, autoOf, KEEP, LIST, WITHDRAW, doorPath, doorRequest, endsWords, isKept, lastUsedWords, problemOf, refusalWords, requestOf, whoWords, withdrawInput } from '../web/src/workspace/door-grant.mjs';

const digest = 'a'.repeat(64);
const grant = (overrides = {}) => ({
  label: "Sam's read-only tools",
  on: true,
  sharing: {
    grant: { tools: ['show-my-screens', 'read-my-trading-board'], identity: 'none', journal: 'input' },
    people: [{ principal: 'sam_1', key_blake3: digest }],
    ...overrides.sharing,
  },
  ...Object.fromEntries(Object.entries(overrides).filter(([name]) => name !== 'sharing')),
});
const encode = value => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value), 'utf8').toString('base64url');

test('an address asks for the exact keep input, decoded and checked before anything is sent', () => {
  const input = grant();
  const asked = requestOf(encode(input));
  assert.deepEqual(asked, { ok: true, input });
});

test('a team member is accepted with team and issuer, as the engine names them', () => {
  const input = grant({ sharing: { people: [{ principal: 'ana', team: 'design', issuer: 'team-issuer' }] } });
  assert.equal(requestOf(encode(input)).ok, true);
});

test('a missing request, undecodable text and a non-JSON request say so before anything is sent', () => {
  assert.deepEqual(requestOf(null), { ok: false, reason: 'no_request' });
  assert.deepEqual(requestOf(''), { ok: false, reason: 'no_request' });
  assert.deepEqual(requestOf('%%%not-base64'), { ok: false, reason: 'invalid' });
  assert.deepEqual(requestOf(encode('not json')), { ok: false, reason: 'invalid' });
});

test('each shape the engine would refuse is named by its reason before anything is sent', () => {
  assert.equal(problemOf(grant({ on: false })), 'invalid', 'on must be true');
  assert.equal(problemOf({ ...grant(), extra: 1 }), 'invalid', 'no field beyond label, on and sharing');
  assert.equal(problemOf(grant({ label: '' })), 'label');
  assert.equal(problemOf(grant({ label: 'x'.repeat(401) })), 'label');
  assert.equal(problemOf(grant({ label: 'é'.repeat(201) })), 'label', 'the cap is bytes, not characters');
  assert.equal(problemOf(grant({ sharing: { grant: { tools: [], identity: 'none', journal: 'input' }, people: [{ principal: 'a', key_blake3: digest }] } })), 'tools');
  assert.equal(problemOf(grant({ sharing: { grant: { tools: ['t'], identity: 'everyone', journal: 'input' }, people: [{ principal: 'a', key_blake3: digest }] } })), 'identity');
  assert.equal(problemOf(grant({ sharing: { grant: { tools: ['t'], identity: 'none', journal: 'all' }, people: [{ principal: 'a', key_blake3: digest }] } })), 'journal');
  assert.equal(problemOf(grant({ sharing: { grant: { tools: ['t'], identity: 'none', journal: 'input' }, people: [] } })), 'people');
  assert.equal(problemOf(grant({ sharing: { grant: { tools: ['t'], identity: 'none', journal: 'input' }, people: Array.from({ length: 65 }, (_, i) => ({ principal: `p${i}`, key_blake3: digest })) } })), 'people');
  assert.equal(problemOf(grant({ sharing: { grant: { tools: ['t'], identity: 'none', journal: 'input' }, people: [{ principal: 'has space', key_blake3: digest }] } })), 'people');
  assert.equal(problemOf(grant({ sharing: { grant: { tools: ['t'], identity: 'none', journal: 'input' }, people: [{ principal: 'a', key_blake3: 'not-a-digest' }] } })), 'people');
  assert.equal(problemOf(grant({ sharing: { grant: { tools: ['t'], identity: 'none', journal: 'input' }, people: [{ principal: 'a', team: 'x' }] } })), 'people', 'a team member needs its issuer');
  assert.equal(problemOf(grant({ sharing: { grant: { tools: ['t'], identity: 'none', journal: 'input' }, people: [{ principal: 'a', key_blake3: digest }], ends: 'soon' } })), 'invalid');
});

test('a grant with an end rule keeps it beside the grant as given', () => {
  const ends = { until: '2026-11-22T00:00:00.000Z' };
  assert.equal(problemOf(grant({ sharing: { ends } })), null);
});

test('keep is a keyed POST pinned to the computer named in the address, with the input sent exactly as asked', () => {
  const input = grant();
  const { path, init } = doorRequest(KEEP, input, 'computer-7', 'key-1');
  assert.equal(path, '/work/api/door/sharing.keep?computer=computer-7');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers['idempotency-key'], 'key-1');
  assert.deepEqual(JSON.parse(init.body), input);
});

test('stop is a keyed POST of the label alone, pinned to the same computer', () => {
  const { path, init } = doorRequest(WITHDRAW, withdrawInput("Sam's read-only tools"), 'computer-7', 'key-2');
  assert.equal(path, '/work/api/door/sharing.withdraw?computer=computer-7');
  assert.deepEqual(JSON.parse(init.body), { label: "Sam's read-only tools" });
  assert.equal(init.headers['idempotency-key'], 'key-2');
});

test('list is a read pinned to the computer, with no body', () => {
  const { path, init } = doorRequest(LIST, {}, 'computer-7', '');
  assert.equal(path, '/work/api/door/sharing.list?computer=computer-7');
  assert.deepEqual(init, {});
});

test('with no computer named, no pin is sent: the address is the door method alone', () => {
  assert.equal(doorPath(LIST, ''), '/work/api/door/sharing.list');
  assert.equal(doorPath(KEEP, undefined), '/work/api/door/sharing.keep');
  assert.equal(doorPath(LIST, 'a b&c'), '/work/api/door/sharing.list?computer=a%20b%26c', 'the computer id is encoded');
});

test('last use reads as its words: never used when the engine has none, else the day and time', () => {
  assert.equal(lastUsedWords(null), 'Never used');
  assert.equal(lastUsedWords(undefined), 'Never used');
  assert.equal(lastUsedWords('not a date'), 'Never used');
  assert.match(lastUsedWords('2026-11-19T12:00:00Z'), /^Last used .+\d{4}/);
});

test('an end rule reads as its day or as until stopped', () => {
  assert.equal(endsWords(undefined), 'Until you stop it');
  assert.match(endsWords({ until: '2026-11-22T00:00:00.000Z' }), /^On /);
});

test('who a person entry names reads in words: a link, a team member, or a person', () => {
  assert.equal(whoWords({ principal: 'sam_1', key_blake3: digest }), 'Anyone with the link');
  assert.equal(whoWords({ principal: 'ana', team: 'design', issuer: 'acme' }), 'ana, design at acme');
  assert.equal(whoWords({ principal: 'sam_1' }), 'sam_1');
});

test('a refusal is shown by the engine code in words; an unknown code is the plain refusal', () => {
  assert.match(refusalWords('current_workspace_rights_refused'), /sign-in does not carry sharing yet/);
  assert.match(refusalWords('original_input_refused'), /did not accept/);
  assert.match(refusalWords('original_workspace_source_unavailable'), /could not open its keys/);
  assert.equal(refusalWords('something_new'), refusalWords(undefined));
});

test('is kept is read from the engine list by its label', () => {
  const list = { grants: [{ label: 'a' }, { label: 'b', last_used: null }] };
  assert.equal(isKept(list, 'b'), true);
  assert.equal(isKept(list, 'c'), false);
  assert.equal(isKept({}, 'a'), false);
});

test('the approval check reads the scope own setting, else the master scope, and writes a decision only for auto', () => {
  assert.equal(APPROVAL_SCOPE, 'door-grant');
  assert.match(APPROVAL_SQL, /FROM approval_setting[\s\S]*scope IN \(\$1, '\*'\)[\s\S]*ORDER BY scope = \$1 DESC/);
  assert.match(APPROVAL_SQL, /INSERT INTO approval_decision[\s\S]*'auto-setting'[\s\S]*WHERE mode = 'auto'/);
  assert.deepEqual(approvalParams('Sam'), ['door-grant', 'grant:Sam']);
});

test('an auto setting with its decision row is an auto decision; anything else asks the person', () => {
  assert.deepEqual(autoOf([{ person: 'p', scope: 'door-grant', mode: 'auto', decision_id: 'd1', set_by: 'p' }]), { decision_id: 'd1', setting_id: 'approval_setting:p:door-grant', mode: 'auto' });
  assert.equal(autoOf([{ person: 'p', scope: '*', mode: 'ask', decision_id: null }]), null, 'a non-auto mode asks');
  assert.equal(autoOf([{ person: 'p', scope: 'door-grant', mode: 'auto', decision_id: null }]), null, 'auto with no decision row asks');
  assert.equal(autoOf([]), null, 'no setting asks');
  assert.equal(autoOf(undefined), null, 'an unreadable answer asks');
});
