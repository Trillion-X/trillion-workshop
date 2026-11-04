// The primary account, what a sign-in allowed, and the plain words of each account's card. The module assertions of
// Trillion-X/trillion test/amie-integrations.test.mjs and test/connection-card-words.test.mjs; the Connections screen
// assertions stay with that screen in the old tree.
import test from 'node:test';
import assert from 'node:assert/strict';
import { primaryAccounts, scopeGroupsOf, withPrimary } from '../src/connection-accounts.mjs';
import { connectionCardFacts, connectionCardSteps, connectionCardWords, TOOL_SERVER_WORDS } from '../src/connection-card-words.mjs';

const google = (id, label, at, scopes) => ({ connection_id: id, service: 'Google', vendor: 'google', status: 'connected', account_label: label, connected_at: at,
  grant_scopes_known: scopes !== null, ...(scopes ? { grant_scopes: scopes } : {}) });
const SCOPES = ['https://www.googleapis.com/auth/calendar', 'https://www.googleapis.com/auth/gmail.modify'];

test('with two accounts of one service the earliest is Primary until the person chooses, and a choice moves it', () => {
  const accounts = [google('g-new', 'new@example.com', '2026-10-02T00:00:00Z', SCOPES), google('g-old', 'old@example.com', '2026-09-01T00:00:00Z', SCOPES)];
  assert.deepEqual(primaryAccounts(accounts, {}), { google: 'g-old' });
  assert.deepEqual(primaryAccounts([accounts[0]], {}), {}, 'one account has nothing to choose between');
  assert.deepEqual(primaryAccounts(accounts, { google: 'g-new' }), { google: 'g-new' });
  assert.deepEqual(primaryAccounts(accounts, { google: 'gone' }), { google: 'g-old' }, 'a choice that no longer holds is ignored');
  assert.deepEqual(primaryAccounts(accounts, withPrimary(accounts, {}, 'g-new').chosen), { google: 'g-new' });
  assert.equal(withPrimary(accounts, {}, 'missing'), null);
});

test('an account shows what its sign-in allowed in plain groups, only when the provider reported permissions', () => {
  assert.deepEqual(scopeGroupsOf(google('g', 'a', 'x', SCOPES)).map(group => [group.label, group.allowed]),
    [['Calendar', true], ['Contacts', false], ['Resources', false], ['Email', true], ['Email settings', false]]);
  assert.deepEqual(scopeGroupsOf(google('g', 'a', 'x', null)), [], 'unknown permissions show nothing');
  assert.deepEqual(scopeGroupsOf(google('g', 'a', 'x', ['https://example.com/other'])), [], 'none of the groups allowed shows nothing');
});

test('a disconnected account claims no arriving copy; a read-only one says it cannot send; a turned-off capability is named', () => {
  const quiet = connectionCardWords(connectionCardFacts({ service: 'Notion', vendor: 'notion', status: 'disconnected', can_send: false }, { arriving: [] }));
  assert.equal(quiet.copied, 'Nothing is copied into Trillion ahead of time.');
  assert.equal(quiet.allowed, 'Your AI may only read with it; it cannot send.');
  const mixed = connectionCardWords(connectionCardFacts({ service: 'G', capabilityChoices: { mail: 'disabled' } }, {
    capabilities: [{ id: 'mail', label: 'Read mail' }, { id: 'cal', label: 'Read calendar' }],
  }));
  assert.equal(mixed.allowed, 'In use: Read calendar. Turned off: Read mail.');
});

test('shared details and an account a computer carries say so, and never claim a server copy', () => {
  const shared = connectionCardWords(connectionCardFacts({ service: 'Calendar', visibility: 'shared', can_send: true }, { arriving: ['Events'], localCopy: true }));
  assert.deepEqual(shared, {
    copied: 'Nothing. These are account details its owner shared; no data from the account is copied to you.',
    live: "Nothing: shared details never let you use someone else's account.",
    allowed: 'Nothing with the account itself.',
  });
  const carried = connectionCardWords(connectionCardFacts({ service: 'WhatsApp', account_label: 'Studio Mac', carried_by: 'agent-1', can_send: true }));
  assert.equal(carried.copied, "Nothing reaches Trillion's servers ahead of time. WhatsApp stays on Studio Mac, which keeps its own incoming copies.");
  assert.equal(carried.live, 'Everything is reached live through Studio Mac while it is awake.');
});

test('a tool server says it runs live, and the words become the guide steps under their titles', () => {
  assert.match(TOOL_SERVER_WORDS, /nothing from it is copied into Trillion ahead of time/);
  const steps = connectionCardSteps(connectionCardWords(connectionCardFacts({ service: 'Notion', status: 'connected', can_send: false })));
  assert.ok(steps.length >= 2 && steps.every(step => step.title && step.body));
});
