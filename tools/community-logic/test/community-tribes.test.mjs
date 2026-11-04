// Tribes (src/community-logic/tribe-chains.ts): ranked members split into groups that nest (a 4 is made of 2s), each
// a chain top first where every person helps the one below; the top of each group at the status size holds the
// status, and those tops together are the top group. Counts that are not a power of two leave nobody alone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tribeChains, tribeProblems } from '../src/community-logic/tribe-chains.ts';

const trillion = JSON.parse(readFileSync(new URL('../communities/trillion.json', import.meta.url), 'utf8'));
const settings = trillion.tribe;
const ranked = n => Array.from({ length: n }, (_, i) => ({ id: `m${i + 1}` }));
const rank = id => Number(id.slice(1));

function checkShape(n, tribes) {
  const ids = ranked(n).map(m => m.id);
  for (const level of tribes.levels) {
    const everyone = level.groups.flat();
    assert.equal(everyone.length, n, `size ${level.size}: everyone is in exactly one group`);
    assert.deepEqual([...everyone].sort(), [...ids].sort());
    if (n >= 2) assert.ok(level.groups.every(group => group.length >= 2), `size ${level.size}: nobody alone (${level.groups.map(g => g.length)})`);
    for (const group of level.groups) assert.deepEqual(group, [...group].sort((a, b) => rank(a) - rank(b)), 'each chain is top first');
  }
  // Nesting: every group at a smaller size sits wholly inside one group at the size above.
  for (let i = 1; i < tribes.levels.length; i += 1) {
    const parents = tribes.levels[i - 1].groups;
    for (const group of tribes.levels[i].groups) assert.equal(parents.filter(parent => group.every(id => parent.includes(id))).length, 1, 'groups nest');
  }
}

test('the Trillion tribe settings are valid DATA and bad settings are refused in words', () => {
  assert.deepEqual(tribeProblems(settings), []);
  assert.deepEqual(settings.groups.map(row => row.size), [2, 4, 8, 16, 32]);
  assert.deepEqual(tribeProblems(undefined), []);
  assert.ok(tribeProblems({ groups: [{ size: 2, label: 'Pair' }, { size: 5, label: 'Five' }], status_name: 'W', top_group_label: 'T' }).some(p => /divides the next/.test(p)));
  assert.ok(tribeProblems({ groups: [{ size: 1, label: 'One' }], status_name: '', top_group_label: 'T' }).length >= 2);
  assert.ok(tribeProblems({ groups: [{ size: 2, label: 'Pair' }], status_name: 'W', top_group_label: 'T', status_at: 4 }).some(p => /status_at/.test(p)));
});

test('one member is their own group, holds the status, and has nobody to help or be helped by', () => {
  const tribes = tribeChains(ranked(1), settings);
  checkShape(1, tribes);
  assert.deepEqual(tribes.seats.m1, { status: settings.status_name, helps: null, helped_by: null, groups: [{ size: 2, label: settings.groups[0].label, members: ['m1'] }] });
  assert.equal(tribes.top_group, null, 'a top group of one is no group');
});

test('two members are one pair: the top helps the other', () => {
  const tribes = tribeChains(ranked(2), settings);
  checkShape(2, tribes);
  assert.equal(tribes.seats.m1.helps, 'm2');
  assert.equal(tribes.seats.m2.helped_by, 'm1');
  assert.deepEqual(tribes.seats.m1.groups.map(g => g.size), [2], 'the same two people at every size are listed once, under the nearest size');
});

test('three members are one group of three, never a pair and someone alone', () => {
  const tribes = tribeChains(ranked(3), settings);
  checkShape(3, tribes);
  assert.deepEqual(tribes.levels.find(l => l.size === 2).groups, [['m1', 'm2', 'm3']]);
  assert.deepEqual([tribes.seats.m2.helped_by, tribes.seats.m2.helps], ['m1', 'm3'], 'the middle of the chain is helped and helps');
});

test('seven members: one group near 8 made of a 4 and a 3, the 4 made of two pairs, each spread across skill', () => {
  const tribes = tribeChains(ranked(7), settings);
  checkShape(7, tribes);
  // Dealt in turn over two: m1 m3 m5 m7 and m2 m4 m6; each spans top to bottom.
  assert.deepEqual(tribes.levels.find(l => l.size === 4).groups, [['m1', 'm3', 'm5', 'm7'], ['m2', 'm4', 'm6']]);
  assert.deepEqual(tribes.levels.find(l => l.size === 2).groups, [['m1', 'm5'], ['m3', 'm7'], ['m2', 'm4', 'm6']]);
  // The 32, 16 and 8 are the same seven people, listed once as the 8; the trio once, as the 4 it is nearest.
  assert.deepEqual(tribes.seats.m2.groups.map(g => [g.size, g.members.length]), [[8, 7], [4, 3]]);
  assert.deepEqual(tribes.seats.m7.groups.map(g => [g.size, g.members.length]), [[8, 7], [4, 4], [2, 2]]);
  assert.equal(tribes.seats.m7.groups[0].label, settings.groups.find(g => g.size === 8).label);
  assert.deepEqual([tribes.seats.m7.groups[2].members, tribes.seats.m3.helps], [['m3', 'm7'], 'm4'], 'the pair is m3 over m7; the chain m3 helps along is the whole seven');
});

test('thirty-two members make exactly the doubling tree: one 32, two 16s, four 8s, eight 4s, sixteen pairs', () => {
  const tribes = tribeChains(ranked(32), settings);
  checkShape(32, tribes);
  assert.deepEqual(tribes.levels.map(l => [l.size, l.groups.length, new Set(l.groups.map(g => g.length)).size]), [[32, 1, 1], [16, 2, 1], [8, 4, 1], [4, 8, 1], [2, 16, 1]]);
  // Every pair spans the whole range at the same distance: 1 and 17, 9 and 25, ... never two neighbours in the middle.
  const pairs = tribes.levels.find(l => l.size === 2).groups;
  assert.ok(pairs.every(([top, bottom]) => rank(bottom) - rank(top) === 16), pairs.map(p => p.join('-')).join(' '));
  assert.ok(tribes.levels.find(l => l.size === 4).groups.every(group => group.every((id, i) => i === 0 || rank(id) - rank(group[i - 1]) === 8)), 'a 4 is four evenly spaced people');
  // The chain of the whole 32 is the ranking: each person helps the next one down.
  assert.equal(tribes.seats.m1.helps, 'm2');
  assert.equal(tribes.seats.m32.helped_by, 'm31');
  assert.equal(tribes.seats.m32.helps, null);
});

test('thirty-three members stay one group, not a 32 and someone alone', () => {
  const tribes = tribeChains(ranked(33), settings);
  checkShape(33, tribes);
  assert.equal(tribes.levels.find(l => l.size === 32).groups.length, 1);
  assert.equal(tribes.levels.find(l => l.size === 16).groups.length, 2);
});

test('a hundred members: three groups near 32, the status goes to the top of every 8, and the tops form the top group', () => {
  const tribes = tribeChains(ranked(100), settings);
  checkShape(100, tribes);
  assert.deepEqual(tribes.levels.find(l => l.size === 32).groups.map(g => g.length), [34, 33, 33]);
  const eights = tribes.levels.find(l => l.size === settings.status_at).groups;
  assert.equal(tribes.holders.length, eights.length);
  assert.deepEqual(tribes.top_group.members, eights.map(g => g[0]).sort((a, b) => rank(a) - rank(b)));
  assert.equal(tribes.top_group.label, settings.top_group_label);
  // The status holders are the strongest people: the top of the community, in order.
  assert.deepEqual(tribes.top_group.members, ranked(eights.length).map(m => m.id));
  for (const id of tribes.top_group.members) assert.equal(tribes.seats[id].status, settings.status_name);
  assert.equal(tribes.seats.m100.status, null);
  // Chain links agree both ways.
  for (const [id, seat] of Object.entries(tribes.seats)) if (seat.helps) assert.equal(tribes.seats[seat.helps].helped_by, id);
});

test('people sharing a place keep the leaderboard order; the same input gives the same tribes', () => {
  // The leaderboard puts tied people in its own order; that order is the ranking, never re-sorted by name or id.
  const tied = [{ id: 'zed' }, { id: 'amy' }, { id: 'kai' }, { id: 'bo' }];
  const once = tribeChains(tied, settings);
  assert.deepEqual(once, tribeChains(tied, settings));
  assert.equal(once.seats.zed.helps, 'amy');
  assert.deepEqual(once.levels.find(l => l.size === 2).groups, [['zed', 'kai'], ['amy', 'bo']]);
});
