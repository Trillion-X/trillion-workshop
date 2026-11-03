// tools/decide-agent-actions: the decision order, grants, declined memory, the dry run and the policy check, on made-up actions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { actionIdentity, checkPolicy, decideAction } from '../do-work/decide-action.mjs';

const fields = [{ id: 'tool', kind: 'choice' }, { id: 'target', kind: 'text' }];
const when = (field, operator, params) => ({ kind: 'rule', field, operator, params });
const tool = (...values) => when('tool', 'is_any_of', { values });
const now = '2030-05-06T07:08:09Z';
const policy = {
  rules: [
    { id: 'no-deletes', says: 'Deleting is not allowed.', when: tool('delete-a-file'), then: 'refuse' },
    { id: 'ask-emails', says: 'Emails need a yes.', when: tool('send-an-email'), then: 'ask' },
    { id: 'reads-ok', says: 'Reading is fine.', when: tool('read-a-file'), then: 'allow' },
    { id: 'post-if-asked', says: 'Posting only when requested.', when: tool('post-a-note'), then: 'allow-when-asked-for' },
  ],
};
const decide = (action, extra = {}) => decideAction({ action, fields, policy, now, ...extra });
const email = { tool: 'send-an-email', target: 'contact:ada', arguments: { subject: 'Hello' } };
const identityOf = action => actionIdentity(action, ['tool', 'target', 'arguments']);

test('a rule that holds decides, with its words and no retry guidance for ask or allow', () => {
  const asked = decide(email);
  assert.deepEqual([asked.verdict, asked.enforced, asked.decided_by, asked.says, asked.retry], ['ask', true, { kind: 'rule', id: 'ask-emails' }, 'Emails need a yes.', null]);
  assert.equal(asked.checked_rules, 4);
  assert.equal(decide({ tool: 'read-a-file', target: 'notes.txt' }).verdict, 'allow');
});

test('a refusal says not to retry, and wins over a grant and over earlier allowances', () => {
  const action = { tool: 'delete-a-file', target: 'old.txt' };
  const grants = [{ id: 'g', identity: identityOf(action), scope: 'always' }];
  const refused = decide(action, { grants });
  assert.deepEqual([refused.verdict, refused.decided_by], ['refuse', { kind: 'rule', id: 'no-deletes' }]);
  assert.match(refused.retry, /do not retry/);
  const refusalLast = { rules: [policy.rules[2], { id: 'refuse-reads', when: tool('read-a-file'), then: 'refuse' }] };
  assert.equal(decideAction({ action: { tool: 'read-a-file' }, fields, policy: refusalLast, now }).verdict, 'refuse');
});

test('a refusing rule that cannot be evaluated refuses, a rule that allows and cannot be evaluated is skipped, both are listed', () => {
  const unfinished = when('nowhere', 'is_any_of', { values: ['x'] });
  const closed = decideAction({ action: { tool: 'read-a-file' }, fields, now, policy: { rules: [{ id: 'broken-refusal', when: unfinished, then: 'refuse' }, policy.rules[2]] } });
  assert.deepEqual([closed.verdict, closed.decided_by, closed.unevaluated], ['refuse', { kind: 'rule', id: 'broken-refusal' }, ['broken-refusal']]);
  const skipped = decideAction({ action: { tool: 'read-a-file' }, fields, now, policy: { rules: [{ id: 'broken-allow', when: unfinished, then: 'allow' }] } });
  assert.deepEqual([skipped.verdict, skipped.decided_by, skipped.unevaluated], ['ask', { kind: 'default' }, ['broken-allow']]);
});

test('a paused policy refuses everything and says to wait', () => {
  const paused = decideAction({ action: { tool: 'read-a-file' }, fields, now, policy: { ...policy, paused: true } });
  assert.deepEqual([paused.verdict, paused.decided_by], ['refuse', { kind: 'paused' }]);
  assert.match(paused.retry, /wait until the person resumes/);
});

test('a decline holds until the person speaks again', () => {
  const declined = [{ identity: identityOf(email), at: '2030-05-06T06:00:00Z' }];
  const held = decide(email, { declined, last_person_message_at: '2030-05-06T05:00:00Z' });
  assert.deepEqual([held.verdict, held.decided_by], ['refuse', { kind: 'declined' }]);
  assert.match(held.retry, /after the person has spoken since/);
  assert.equal(decide(email, { declined }).verdict, 'refuse');
  assert.equal(decide(email, { declined, last_person_message_at: '2030-05-06T06:30:00Z' }).verdict, 'ask');
  assert.equal(decide({ ...email, target: 'contact:bo' }, { declined }).verdict, 'ask');
});

test('grants: once is used up, thread needs the same thread, always runs until it expires', () => {
  const identity = identityOf(email);
  const once = { id: 'g-once', identity, scope: 'once' };
  const used = decide(email, { grants: [once] });
  assert.deepEqual([used.verdict, used.decided_by, used.grant_used], ['allow', { kind: 'grant', id: 'g-once' }, 'g-once']);
  assert.equal(decide(email, { grants: [{ ...once, used: true }] }).verdict, 'ask');
  const thread = { id: 'g-thread', identity, scope: 'thread', thread: 't1' };
  assert.deepEqual([decide(email, { grants: [thread], thread: 't1' }).verdict, decide(email, { grants: [thread], thread: 't1' }).grant_used], ['allow', null]);
  assert.equal(decide(email, { grants: [thread], thread: 't2' }).verdict, 'ask');
  assert.equal(decide(email, { grants: [thread] }).verdict, 'ask');
  const always = { id: 'g-always', identity, scope: 'always', expires_at: '2030-05-06T07:00:00Z' };
  assert.equal(decide(email, { grants: [always] }).verdict, 'ask');
  assert.equal(decide(email, { grants: [{ ...always, expires_at: '2030-05-07T00:00:00Z' }] }).verdict, 'allow');
  assert.equal(decide(email, { grants: [{ ...always, identity: identityOf({ ...email, target: 'x' }) }] }).verdict, 'ask');
});

test('allow-when-asked-for allows only an action the person asked for, otherwise asks', () => {
  const note = { tool: 'post-a-note', target: 'board' };
  assert.equal(decide(note).verdict, 'ask');
  assert.equal(decide(note, { asked_for: [identityOf(note)] }).verdict, 'allow');
});

test('when no rule holds the policy otherwise decides, else the default; an unknown otherwise falls to the default', () => {
  const other = { tool: 'open-a-door' };
  assert.deepEqual([decide(other).verdict, decide(other).decided_by], ['ask', { kind: 'default' }]);
  assert.equal(decideAction({ action: other, fields, now, policy: { ...policy, otherwise: 'allow' } }).verdict, 'allow');
  assert.equal(decideAction({ action: other, fields, now, policy: { ...policy, otherwise: 'maybe' } }).verdict, 'ask');
});

test('an ask no one can answer becomes a refusal that says to continue without it', () => {
  const stuck = decide(email, { can_ask: false });
  assert.equal(stuck.verdict, 'refuse');
  assert.match(stuck.retry, /continue without/);
  assert.equal(decide({ tool: 'read-a-file' }, { can_ask: false }).verdict, 'allow');
});

test('a dry run decides the same and says it is not enforced', () => {
  const dry = decide({ tool: 'delete-a-file' }, { dry_run: true });
  assert.deepEqual([dry.verdict, dry.enforced], ['refuse', false]);
});

test('the identity ignores key order, follows the named identity fields and starts with the content prefix', () => {
  const a = identityOf({ tool: 'send-an-email', target: 'x', arguments: { b: 1, a: 2 } });
  assert.equal(a, identityOf({ arguments: { a: 2, b: 1 }, target: 'x', tool: 'send-an-email' }));
  assert.match(a, /^1f:[0-9a-f]{64}$/);
  assert.equal(decide(email, { identity_fields: ['tool'] }).identity, actionIdentity(email, ['tool']));
  assert.notEqual(decide(email, { identity_fields: ['tool'] }).identity, decide(email).identity);
});

test('the rules can use a text comparison over the target', () => {
  const guarded = { rules: [{ id: 'internal-only', when: when('target', 'contains', { text: 'internal' }), then: 'allow' }] };
  assert.equal(decideAction({ action: { target: 'host.internal.test' }, fields, policy: guarded, now }).verdict, 'allow');
  assert.equal(decideAction({ action: { target: 'host.example.test' }, fields, policy: guarded, now }).verdict, 'ask');
});

test('the policy check names rules it cannot evaluate, unknown behaviours, repeated ids and rules that can never decide', () => {
  assert.deepEqual(checkPolicy({ fields, policy }), { ok: true, problems: [] });
  const problems = checkPolicy({
    fields,
    policy: {
      rules: [
        { id: 'a', when: tool('x'), then: 'allow' },
        { id: 'b', when: tool('x'), then: 'ask' },
        { id: 'c', then: 'maybe' },
        { id: 'a', when: when('nowhere', 'is_any_of', { values: [] }), then: 'ask' },
        { id: 'late-refusal', when: tool('x'), then: 'refuse' },
        { id: 'open-1', then: 'allow' },
        { id: 'open-2', then: 'allow' },
      ],
    },
  });
  assert.equal(problems.ok, false);
  assert.deepEqual(problems.problems.map(({ rule, problem }) => [rule, problem]), [
    ['a', 'never-decides'],
    ['b', 'never-decides'],
    ['c', 'unknown-behaviour'],
    ['a', 'repeated-id'],
    ['a', 'incomplete-when'],
    ['open-2', 'never-decides'],
  ]);
  assert.equal(problems.problems[0].says, 'Rule a can never decide: rule late-refusal holds whenever it does and is looked at first.');
  assert.match(problems.problems[2].says, /Rule c names maybe in `then`, which is not one of: refuse, ask, allow, allow-when-asked-for\./);
});

test('a request the gate cannot run is refused with a sentence that says what to send', () => {
  const base = { action: email, fields, policy, now };
  const refuses = (change, pattern) => assert.throws(() => decideAction({ ...base, ...change }), pattern);
  refuses({ action: null }, /action must be an object/);
  refuses({ fields: 'tool' }, /fields must be a list/);
  refuses({ policy: { rules: 'none' } }, /policy must be/);
  refuses({ policy: { rules: [{ says: 'x', then: 'allow' }] } }, /needs an id/);
  refuses({ policy: { rules: [{ id: 'r', then: 'maybe' }] } }, /rule r needs a `then` that is one of: refuse, ask, allow, allow-when-asked-for/);
  refuses({ policy: { rules: [{ id: 'r', then: 'ask' }, { id: 'r', then: 'ask' }] } }, /share an id/);
  refuses({ now: 'tomorrow' }, /now must be an ISO time/);
  refuses({ now: undefined }, /now must be an ISO time/);
  refuses({ grants: [{ id: 'g', identity: 'x', scope: 'forever' }] }, /grant g needs a scope that is one of: once, thread, always/);
  refuses({ declined: [{ identity: 'x', at: 'later' }] }, /declined must be a list/);
  refuses({ identity_fields: [] }, /identity_fields must be a list/);
  assert.throws(() => checkPolicy({ fields: [], policy: { rules: 3 } }), /policy must be/);
});
