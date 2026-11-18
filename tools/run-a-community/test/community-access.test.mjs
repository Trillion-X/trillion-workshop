import test from 'node:test';
import assert from 'node:assert/strict';
import { communityOf, joinedByRules, memberDecision, checkedMemberDecision, joinRows, rulesOf, ownMemberTypesOf } from '../read-data/community-access.mjs';
import { communityAccessOver } from '../do-work/community-event-route.mjs';

const labels = {
  membership_labels: {
    community: { joined_by: 'rules', configuration: { title: 'Starting', join: [{ free: true }], spaces: { events: 'members' } } },
    project: { joined_by: 'invitation', configuration: { title: 'Project start' } },
  },
};
const space = (extra = {}) => ({ id: 'space-1', label: 'community', title: 'A community', created_by: 'relay-owner', created_at: '2026-01-01T00:00:00.000Z', ...extra });
const member = (relay, extra = {}) => ({ membership_id: 'space-1', relay, role: 'member', state: 'member', changed_at: '2026-01-01T00:00:00.000Z', ...extra });

test('a community without saved configuration takes its label configuration; a saved one wins and keeps its update time', () => {
  const fromLabel = communityOf({ membership: space(), configRow: null, joinedByRules: true, labels });
  assert.deepEqual(fromLabel.config, { title: 'A community', join: [{ free: true }], spaces: { events: 'members' } });
  assert.equal(fromLabel.updated_at, '2026-01-01T00:00:00.000Z');
  const saved = communityOf({ membership: space(), configRow: { id: 'space-1', config: { join: [{ invited: true }] }, created_at: '2026-01-02T00:00:00.000Z', updated_at: '2026-01-03T00:00:00.000Z' }, joinedByRules: true, labels });
  assert.deepEqual(saved.config, { join: [{ invited: true }], title: 'A community' });
  assert.equal(saved.updated_at, '2026-01-03T00:00:00.000Z');
  assert.throws(() => communityOf({ membership: space(), configRow: { config: 'text' }, joinedByRules: true, labels }), /invalid/);
});

test('an event follows its root space for joining, and a cycle or an incomplete chain is refused', () => {
  const root = space({ id: 'space-1' });
  const event = { id: 'event-1', label: 'event', parent_id: 'space-1', title: 'Event', created_by: 'relay-owner' };
  assert.equal(joinedByRules([event, root], labels), true);
  assert.equal(joinedByRules([event, null], labels), false, 'a missing root is not a yes');
  assert.throws(() => joinedByRules([{ id: 'a', parent_id: 'b' }, { id: 'b', parent_id: 'a' }, { id: 'a', parent_id: 'b' }], labels), /cycle/);
  assert.throws(() => joinedByRules([{ id: 'a', parent_id: 'b' }], labels), /not complete/);
});

test('invitation evidence grants only on a boolean true; a non-boolean answer is unavailable, never a no', async () => {
  const community = communityOf({ membership: space(), configRow: { config: { join: [{ invited: true }] }, created_at: '2026-01-01T00:00:00.000Z' }, joinedByRules: true, labels });
  assert.deepEqual(await memberDecision({ community, relay: 'relay-marked', member: member('relay-marked', { admitted_by_invitation: true }) }), { allowed: true, reason: 'came_by_invitation' });
  assert.equal((await memberDecision({ community, relay: 'relay-invitee', member: member('relay-invitee'), acceptedInvitation: async () => true })).allowed, true);
  assert.equal((await memberDecision({ community, relay: 'relay-invitee', member: member('relay-invitee'), acceptedInvitation: async () => false })).allowed, false);
  for (const answer of [{ allowed: false }, 'false', 1, undefined, null]) {
    await assert.rejects(memberDecision({ community, relay: 'relay-invitee', member: member('relay-invitee'), acceptedInvitation: async () => answer }), error =>
      error.status === 503 && error.code === 'accepted_invitation_evidence_unavailable');
  }
  await assert.rejects(checkedMemberDecision({ community, relay: 'relay-absent', member: null, acceptedInvitation: async () => false }), error => error.status === 403 && error.code === 'community_membership_required');
});

test('paid access is met only by a grant from the space owner; unknown holdings are unavailable when paid evidence is required', async () => {
  const community = communityOf({ membership: space(), configRow: { config: { join: [{ access: 'offer-1' }] }, created_at: '2026-01-01T00:00:00.000Z' }, joinedByRules: true, labels });
  const row = member('relay-member');
  assert.equal((await memberDecision({ community, relay: 'relay-member', member: row, holds: [{ access: 'offer-1', by: 'relay-someone-else' }] })).allowed, false);
  assert.equal((await memberDecision({ community, relay: 'relay-member', member: row, holds: [{ access: 'offer-1', by: 'relay-owner' }] })).allowed, true);
  await assert.rejects(memberDecision({ community, relay: 'relay-member', member: row, holds: null }), error => error.status === 503 && error.code === 'access_holdings_evidence_unavailable');
  assert.deepEqual(joinRows(community), [{ access: 'offer-1' }]);
});

test('a member no longer in state member is refused with its reason, and an open or owner space needs no join rule', async () => {
  const open = communityOf({ membership: space(), configRow: { config: { join: [{ free: true }] }, created_at: '2026-01-01T00:00:00.000Z' }, joinedByRules: true, labels });
  assert.deepEqual(await memberDecision({ community: open, relay: 'relay-member', member: member('relay-member', { state: 'left' }) }), { allowed: false, reason: 'not_a_member_now' });
  assert.equal((await memberDecision({ community: open, relay: 'relay-owner', member: member('relay-owner') })).reason, 'open_or_owner');
});

test('the rules row and the member types are checked and merged as values', () => {
  assert.deepEqual(rulesOf({ rules: 'Be kind', changed_at: '2026-01-01T00:00:00.000Z' }), { rules: 'Be kind', changed_at: '2026-01-01T00:00:00.000Z' });
  assert.throws(() => rulesOf({ rules: 1, changed_at: 'x' }), /invalid/);
  assert.deepEqual(ownMemberTypesOf([{ type_id: 'coach', label: 'Coach', inherits: [] }], { types: [{ id: 'member', label: 'Member' }] }), [
    { id: 'coach', label: 'Coach', inherits: [] }, { id: 'member', label: 'Member', inherits: [] }]);
});

test('a read of a community that does not exist is 404, and the route reads communities from the caller records', async () => {
  const rows = new Map([['space-1', space()]]);
  const records = {
    read: async id => rows.get(id) ?? null,
    community: async () => null,
    member: async (spaceId, relay) => (relay === 'relay-member' ? member(relay) : null),
  };
  const access = communityAccessOver(records, { labels });
  assert.equal((await access.readCommunity('space-1')).config.title, 'A community');
  await assert.rejects(access.readCommunity('missing'), error => error.status === 404 && error.code === 'community_not_found');
  assert.equal(await access.activeMember(await access.readCommunity('space-1'), 'relay-member'), true);
  await assert.rejects(access.checkedMember('space-1', 'relay-absent'), error => error.status === 403);
});
