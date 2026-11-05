import { test } from 'node:test';
import assert from 'node:assert/strict';
import { profileFill, handleFor } from '../from-old-trillion/src/network-profile-fill.mjs';
import networkRules from '../../introduce-two-people/src/network-settings.json' with { type: 'json' };

const rules = networkRules.profile_fill;
const empty = { name: '', handle: '', about: '', offering: '', seeking: '', contact: '' };
const picture = {
  trajectory: 'Building a pottery school and the software that runs it.',
  traits: { skills: [{ name: 'Coaching beginners' }, { name: 'Video editing' }], goals: [{ name: 'A hitting partner on weekday mornings' }] },
};

test('a new profile is filled from everything Trillion knows, with a unique handle', () => {
  const { changes, filled } = profileFill({ rules, current: empty, relay: 'relay_0123456789abcdef', known: { account: { name: 'ana.lopez+x@example.com' }, picture, pursuits: [] } });
  assert.deepEqual(changes, {
    name: 'ana lopez',
    contact: 'ana.lopez+x@example.com',
    about: picture.trajectory,
    offering: 'Coaching beginners, Video editing',
    seeking: 'A hitting partner on weekday mornings',
    handle: 'ana_lopez_abcdef',
  });
  assert.deepEqual(filled, changes);
});

test('a field the person wrote is never filled over, even when they emptied it', () => {
  const current = { ...empty, name: 'Ana', about: '', offering: 'Private lessons', handle: 'ana' };
  const { changes } = profileFill({ rules, current, filled: { name: 'ana lopez', offering: 'Coaching beginners' }, written: ['name', 'about', 'offering', 'handle'], relay: 'relay_1', known: { account: { name: 'ana@example.com' }, picture, pursuits: [] } });
  assert.equal('name' in changes, false);
  assert.equal('about' in changes, false);
  assert.equal('offering' in changes, false);
  assert.equal('handle' in changes, false);
  assert.equal(changes.seeking, 'A hitting partner on weekday mornings');
});

test('a filled field follows what Trillion learns; nothing known fills nothing', () => {
  const current = { ...empty, about: 'Old reading.', handle: handleFor('', 'relay_aaaaaa', rules) };
  const { changes } = profileFill({ rules, current, filled: { about: 'Old reading.', handle: current.handle }, relay: 'relay_aaaaaa', known: { account: {}, picture: null, pursuits: [{ title: 'Grow the school' }] } });
  assert.deepEqual(changes, { seeking: 'Grow the school' });
  const learned = profileFill({ rules, current, filled: { about: 'Old reading.', handle: current.handle }, relay: 'relay_aaaaaa', known: { account: { name: 'Ana Lopez' }, picture, pursuits: [] } }).changes;
  assert.equal(learned.about, picture.trajectory);
  assert.equal(learned.handle, 'ana_lopez_aaaaaa');
});
