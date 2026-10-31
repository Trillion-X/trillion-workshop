// The three commands as the container runs them: one JSON request on standard input, one JSON line out. Every player,
// table and seed here is made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const command = name => fileURLToPath(new URL(`../do-work/${name}.mjs`, import.meta.url));

// Run a command with one JSON request on its standard input; its answer is the one JSON line it prints: { result } or { error }.
async function ask(name, request) {
  const child = run('node', [command(name)]);
  child.child.stdin.end(JSON.stringify(request));
  try { return JSON.parse((await child).stdout.trim()); } catch (error) { return JSON.parse(error.stdout.trim()); }
}
const table = request => ask('run-a-poker-table', request);
const rank = request => ask('rank-poker-hands', request);
const view = request => ask('view-a-poker-table', request);

const open = async () => (await table({ operation: 'open-table', room_id: 'room:bakery', players: ['Alder', 'Birch'], config: { smallBlind: 5, bigBlind: 10, startingChips: 100 } })).result.room;

test('open, start, play to the end, and deal the next hand, the room carried between calls as JSON', async () => {
  const lobby = await open();
  assert.deepEqual([lobby.state.phase, lobby.hostPlayerId, lobby.state.players.length], ['lobby', 'player-1', 2]);

  const started = (await table({ operation: 'start-game', room: lobby, seed: 11 })).result.room;
  assert.equal(started.state.phase, 'playing');
  assert.equal(started.state.pot, 15);

  let room = started;
  const events = [];
  for (let turn = 0; turn < 30 && room.state.phase === 'playing'; turn += 1) {
    const answer = (await table({ operation: 'player-action', room, action: 'checkCall', player_id: room.state.players[room.state.activeIndex].id })).result;
    events.push(answer.event.text);
    room = answer.room;
  }
  assert.equal(room.state.phase, 'finished');
  assert.equal(room.state.result.source, 'showdown');
  assert.match(events[0], /^Alder called 5\.$/);
  assert.equal(room.state.players.reduce((total, player) => total + player.chips, 0), 200, 'chips are conserved');

  const next = (await table({ operation: 'next-hand', room, seed: 12 })).result.room;
  assert.equal(next.state.phase, 'playing');
  assert.equal(next.handNumber, 2);
});

test('the same table and seed deal the same cards; another seed deals others', async () => {
  const lobby = await open();
  const [one, again, other] = await Promise.all([11, 11, 12].map(async seed => (await table({ operation: 'start-game', room: lobby, seed })).result.room));
  assert.deepEqual(one, again);
  assert.notDeepEqual(one.holeCards, other.holeCards);
});

test('dealing without a seed is refused and says to give one', async () => {
  const answer = await table({ operation: 'start-game', room: await open() });
  assert.match(answer.error, /give a seed/);
});

test('an action out of turn, a wrong phase and a made-up room are each refused with the way to fix it', async () => {
  const lobby = await open();
  assert.match((await table({ operation: 'player-action', room: lobby, action: 'fold' })).error, /phase "lobby".*needs phase "playing"/);
  const started = (await table({ operation: 'start-game', room: lobby, seed: 1 })).result.room;
  const toAct = started.state.players[started.state.activeIndex].id;
  const other = started.state.players.find(player => player.id !== toAct).id;
  assert.match((await table({ operation: 'player-action', room: started, action: 'fold', player_id: other })).error, /not player-\d's turn/);
  assert.match((await table({ operation: 'player-action', room: started, action: 'bluff' })).error, /action must be one of/);
  assert.match((await table({ operation: 'next-hand', room: started, seed: 2 })).error, /needs phase "finished"/);
  assert.match((await table({ operation: 'start-game', room: { kind: 'other' }, seed: 1 })).error, /saved poker table/);
  assert.match((await table({ operation: 'dance' })).error, /operation must be one of/);
});

test('seating: a player joins the lobby, a returning name is the same player, and the table cannot start with one', async () => {
  const solo = (await table({ operation: 'open-table', room_id: 'room:solo', players: ['Alder'] })).result.room;
  assert.match((await table({ operation: 'start-game', room: solo, seed: 1 })).error, /at least two/);
  const joined = (await table({ operation: 'seat-player', room: solo, name: 'Birch' })).result;
  assert.equal(joined.playerId, 'player-2');
  const again = (await table({ operation: 'seat-player', room: joined.room, name: 'birch' })).result;
  assert.equal(again.playerId, 'player-2');
  assert.equal(again.room.state.players.length, 2);
});

test('configuring a lobby table changes its blinds; kicking in the lobby needs no seed', async () => {
  const lobby = await open();
  const configured = (await table({ operation: 'configure-table', room: lobby, config: { smallBlind: 20 } })).result.room;
  assert.deepEqual([configured.config.smallBlind, configured.config.bigBlind], [20, 20]);
  const kicked = (await table({ operation: 'kick-player', room: lobby, player_id: 'player-1' })).result.room;
  assert.deepEqual([kicked.hostPlayerId, kicked.state.players.map(player => player.name)], ['player-2', ['Birch']]);
  assert.match((await table({ operation: 'kick-player', room: lobby, player_id: 'player-9' })).error, /not at this table/);
});

test('the view shows a player their own cards only, everyone\'s when the hand is over, and a spectator none', async () => {
  const started = (await table({ operation: 'start-game', room: await open(), seed: 5 })).result.room;
  const mine = (await view({ room: started, player_id: 'player-2' })).result;
  assert.deepEqual(mine.privateHand.cards, started.holeCards['player-2']);
  assert.deepEqual(mine.publicHoleCards, {});
  for (const card of started.holeCards['player-1']) assert.ok(!JSON.stringify(mine).includes(`"code":"${card.code}"`));
  assert.ok(mine.controls.every(control => !control.enabled) || started.state.players[started.state.activeIndex].id === 'player-2');
  const spectator = (await view({ room: started })).result;
  assert.deepEqual(spectator.privateHand, { ownerId: null, cards: [] });
  assert.ok(spectator.controls.every(control => !control.enabled));
  assert.deepEqual(mine.seats.map(seat => seat.roles), [['D', 'SB'], ['BB']]);
  assert.match((await view({ room: started, player_id: 'player-9' })).error, /not at this table/);
});

test('a finished hand shows both players\' cards and who won', async () => {
  let room = (await table({ operation: 'start-game', room: await open(), seed: 5 })).result.room;
  while (room.state.phase === 'playing') room = (await table({ operation: 'player-action', room, action: 'checkCall' })).result.room;
  const seen = (await view({ room, player_id: 'player-1' })).result;
  assert.deepEqual(Object.keys(seen.publicHoleCards), ['player-1', 'player-2']);
  assert.ok(seen.handResult.winnerNames.length >= 1);
  assert.equal(seen.communityCards.length, 5);
});

test('ranking names each hand\'s category, the winner, and refuses a card given twice', async () => {
  const answer = (await rank({ board: ['2S', '7D', '9C', 'JS', '3H'], hands: [{ id: 'pair-of-aces', cards: ['AH', 'AC'] }, { id: 'king-high', cards: ['KH', 'QC'] }] })).result;
  assert.deepEqual(answer.winners, ['pair-of-aces']);
  assert.deepEqual(answer.ranking.map(entry => [entry.id, entry.category, entry.place]), [['pair-of-aces', 'pair', 1], ['king-high', 'high card', 2]]);
  assert.equal(answer.ranking[0].bestFive.length, 5);
  assert.match((await rank({ board: ['AS'], hands: [{ id: 'x', cards: ['AS', 'KD'] }] })).error, /AS is given twice/);
  assert.match((await rank({ board: [], hands: [{ id: 'x', cards: ['1S'] }] })).error, /is not a card/);
  assert.match((await rank({ board: [], hands: [{ id: 'x', cards: ['AS', 'KS', 'QS'] }] })).error, /at most 2 cards/);
  assert.match((await rank({ board: [], hands: [] })).error, /hands must be/);
});
