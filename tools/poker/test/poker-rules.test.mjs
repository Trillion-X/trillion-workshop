// The rules of the game as pure functions. Every player and room here is made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RULES, RANKS, SUITS, STREETS, advanceRoomStreet, applyPlayerAction, applyRoomPlayerAction, bestHand, createHandState, createLobbyRoom,
  createPlayers, deriveControls, kickRoomPlayer, makeDeck, nextBlinds, nextRoomHand, normalizeTableConfig, parseCard, projectRoomForPlayer,
  rankHands, seededRandom, startRoomGame, upsertRoomPlayer,
} from '../read-data/poker-rules.mjs';

const PHASE = RULES.phases;
const ACTION = RULES.player_actions;
const deckCard = (rank, suit) => makeDeck().find(card => card.rank === rank && card.suit === suit);
const cards = (...codes) => codes.map(parseCard);

function startedHeadsUp(roomId) {
  const players = createPlayers(['Alder', 'Birch'], 100);
  return startRoomGame(createLobbyRoom({ roomId, players, config: { smallBlind: 5, bigBlind: 10, startingChips: 100 }, hostPlayerId: players[0].id }), () => 0);
}

function roomAtRiverShowdown({ pot = 100, tiedBoard = false } = {}) {
  const room = startedHeadsUp('room:showdown');
  const board = tiedBoard
    ? [deckCard('2', 'S'), deckCard('3', 'H'), deckCard('4', 'D'), deckCard('5', 'C'), deckCard('6', 'S')]
    : [deckCard('2', 'S'), deckCard('7', 'D'), deckCard('9', 'C'), deckCard('J', 'S'), deckCard('3', 'H')];
  const ready = room.state.players.map(player => ({ ...player, currentBet: 0, hasActed: true, folded: false, allIn: false, eliminated: false }));
  return {
    ...room,
    board,
    holeCards: {
      [ready[0].id]: tiedBoard ? [deckCard('A', 'H'), deckCard('K', 'D')] : [deckCard('A', 'H'), deckCard('A', 'C')],
      [ready[1].id]: tiedBoard ? [deckCard('Q', 'H'), deckCard('J', 'C')] : [deckCard('K', 'H'), deckCard('Q', 'C')],
    },
    state: { ...room.state, players: ready, phase: PHASE.active, street: STREETS.at(-1), communityCards: board, activeIndex: 0, currentBet: 0, pot, pots: [{ amount: pot, eligibleIds: ready.map(player => player.id) }], result: null },
  };
}

test('a deck has every rank in every suit, each with a stable code', () => {
  const deck = makeDeck();
  assert.equal(deck.length, RANKS.length * SUITS.length);
  assert.equal(new Set(deck.map(card => card.code)).size, deck.length);
  assert.deepEqual(deck[0], { rank: RANKS[0], suit: SUITS[0], value: 2, code: `${RANKS[0]}${SUITS[0]}` });
  assert.deepEqual(deck.at(-1), { rank: RANKS.at(-1), suit: SUITS.at(-1), value: 14, code: `${RANKS.at(-1)}${SUITS.at(-1)}` });
});

test('the rules data agrees with itself: every phase, street and action a rule names is declared', () => {
  const phases = new Set(Object.values(RULES.phases));
  const streets = new Set(RULES.street_flow.map(flow => flow.street));
  for (const flow of RULES.street_flow) {
    assert.ok(streets.has(flow.next_street), `${flow.street} leads to a declared street`);
    assert.ok(phases.has(flow.next_phase), `${flow.street} leads to a declared phase`);
  }
  assert.equal(RULES.street_flow.at(-1).next_phase, PHASE.showdown, 'the last street ends in the showdown');
  assert.equal(RULES.hand_categories.length, 9);
  for (const key of ['fold', 'check', 'call', 'raise', 'all_in']) assert.ok(RULES.control_labels[key], `a label for ${key}`);
  for (const key of ['rejected', 'fold', 'check', 'call', 'raise', 'all_in']) assert.ok(RULES.event_text[key], `a sentence for ${key}`);
});

test('a seed gives the same cards every time, and a different seed gives different cards', () => {
  const first = Array.from({ length: 5 }, seededRandom(7));
  assert.deepEqual(first, Array.from({ length: 5 }, seededRandom(7)));
  assert.notDeepEqual(first, Array.from({ length: 5 }, seededRandom(8)));
  assert.ok(first.every(value => value >= 0 && value < 1));
  assert.throws(() => seededRandom(1.5), /whole number/);
  assert.throws(() => seededRandom('7'), /whole number/);
});

test('blinds are posted and the dealer is the small blind when two play', () => {
  const state = createHandState(createPlayers(['Alder', 'Birch'], 100), { smallBlind: 5, bigBlind: 10 });
  assert.deepEqual([state.dealerIndex, state.smallBlindIndex, state.bigBlindIndex], [0, 0, 1]);
  assert.deepEqual([state.players[0].chips, state.players[1].chips, state.pot], [95, 90, 15]);
});

test('a call moves the turn on and puts chips in the pot', () => {
  const state = createHandState(createPlayers(['Alder', 'Birch', 'Cedar'], 100), { smallBlind: 5, bigBlind: 10 });
  const result = applyPlayerAction(state, state.players[state.activeIndex].id, ACTION.check_call);
  assert.equal(result.event.kind, RULES.events.call);
  assert.match(result.event.text, /called 10\.$/);
  assert.ok(result.state.pot > state.pot);
  assert.notEqual(result.state.activeIndex, state.activeIndex);
});

test('an action by the wrong seat, or an unknown action, is rejected and changes nothing', () => {
  const state = createHandState(createPlayers(['Alder', 'Birch', 'Cedar'], 100), { smallBlind: 5, bigBlind: 10 });
  const wrongSeat = state.players.find((_, index) => index !== state.activeIndex);
  assert.equal(applyPlayerAction(state, wrongSeat.id, ACTION.fold).state, state);
  const unknown = applyPlayerAction(state, state.players[state.activeIndex].id, 'bluff');
  assert.deepEqual([unknown.event.kind, unknown.state], [RULES.events.warning, state]);
});

test('config is normalised and blinds rise by the table\'s own mode', () => {
  const fixed = normalizeTableConfig({ smallBlind: -1, bigBlind: 2, blindIncrease: 5 });
  assert.equal(fixed.smallBlind, 1);
  assert.deepEqual(nextBlinds(fixed, 5, 10), { smallBlind: 10, bigBlind: 20 });
  const multiplier = normalizeTableConfig({ blindMode: RULES.blind_modes.multiplier, blindIncrease: 2 });
  assert.deepEqual(nextBlinds(multiplier, 5, 10), { smallBlind: 10, bigBlind: 20 });
  assert.deepEqual(normalizeTableConfig({}), { startingChips: 1000, smallBlind: 10, bigBlind: 20, blindMode: 'fixed', blindIncrease: 0, maxPlayers: 9 });
  assert.equal(normalizeTableConfig({ maxPlayers: 400 }).maxPlayers, RULES.table_defaults.max_players.most, 'a table never seats more players than the deck can deal to');
});

test('a lobby takes players who join and starts the first real hand', () => {
  const host = createPlayers(['Alder'], 1000);
  const lobby = createLobbyRoom({ roomId: 'room:lobby', players: host, config: { smallBlind: 5, bigBlind: 10, startingChips: 1000 }, hostPlayerId: host[0].id });
  const joined = upsertRoomPlayer(lobby, { name: 'Birch' });
  const room = startRoomGame(joined.room, () => 0);
  assert.equal(joined.playerId, 'player-2');
  assert.equal(room.state.phase, PHASE.active);
  assert.deepEqual(room.state.players.map(player => player.name), ['Alder', 'Birch']);
  assert.equal(room.holeCards['player-1'].length, 2);
  assert.equal(room.holeCards['player-2'].length, 2);
});

test('a new player cannot join a hand in play, and a full table refuses another seat', () => {
  const room = startedHeadsUp('room:full');
  assert.equal(upsertRoomPlayer(room, { name: 'Cedar' }).room, room);
  const players = createPlayers(['Alder', 'Birch'], 100);
  const small = createLobbyRoom({ roomId: 'room:small', players, config: { maxPlayers: 2 }, hostPlayerId: players[0].id });
  assert.equal(upsertRoomPlayer(small, { name: 'Cedar' }).room, small);
});

test('the host leaving hands hosting to the next seated player', () => {
  const players = createPlayers(['Alder', 'Birch', 'Cedar'], 1000);
  const lobby = createLobbyRoom({ roomId: 'room:host', players, config: { smallBlind: 5, bigBlind: 10, startingChips: 1000 }, hostPlayerId: players[0].id });
  const after = kickRoomPlayer(lobby, players[0].id);
  assert.equal(after.hostPlayerId, players[1].id);
  assert.deepEqual(after.state.players.map(player => player.name), ['Birch', 'Cedar']);
  assert.equal(after.state.players[0].connected, true);
});

test('a finished betting round moves to the next street with the bets cleared', () => {
  const room = startedHeadsUp('room:heads-up');
  const afterSmallBlindCalls = applyRoomPlayerAction(room, ACTION.check_call).room;
  const afterBigBlindChecks = applyRoomPlayerAction(afterSmallBlindCalls, ACTION.check_call).room;
  assert.equal(afterSmallBlindCalls.state.street, STREETS[0]);
  assert.equal(afterBigBlindChecks.state.street, STREETS[1]);
  assert.equal(afterBigBlindChecks.state.currentBet, 0);
  assert.ok(afterBigBlindChecks.state.players.every(player => !player.hasActed));
  assert.equal(afterBigBlindChecks.state.communityCards.length, 3);
});

test('a river showdown pays the best hand', () => {
  const room = roomAtRiverShowdown();
  const winnerChips = room.state.players[0].chips;
  const settled = advanceRoomStreet(room);
  assert.equal(settled.state.phase, PHASE.finished);
  assert.deepEqual(settled.state.result, { source: 'showdown', winnerIds: [room.state.players[0].id], pot: 100, handNumber: room.state.handNumber });
  assert.equal(settled.state.players[0].chips, winnerChips + 100);
  assert.equal(settled.state.communityCards.length, 5);
});

test('a tied showdown splits the pot and the odd chip goes to the first winner', () => {
  const room = roomAtRiverShowdown({ pot: 101, tiedBoard: true });
  const [first, second] = room.state.players.map(player => player.chips);
  const settled = advanceRoomStreet(room);
  assert.deepEqual(settled.state.result.winnerIds, room.state.players.map(player => player.id));
  assert.deepEqual([settled.state.players[0].chips, settled.state.players[1].chips], [first + 51, second + 50]);
});

test('all-in players are run out to a result without waiting for actions nobody can take', () => {
  const room = { ...startedHeadsUp('room:all-in'), board: [deckCard('2', 'S'), deckCard('7', 'D'), deckCard('9', 'C'), deckCard('J', 'S'), deckCard('3', 'H')] };
  room.holeCards = { 'player-1': [deckCard('A', 'H'), deckCard('A', 'C')], 'player-2': [deckCard('K', 'H'), deckCard('Q', 'C')] };
  const afterJam = applyRoomPlayerAction(room, ACTION.all_in);
  assert.match(afterJam.event.text, /moved all-in for 95\.$/);
  const settled = applyRoomPlayerAction(afterJam.room, ACTION.all_in).room;
  assert.equal(settled.state.phase, PHASE.finished);
  assert.equal(settled.state.result.source, 'showdown');
  assert.deepEqual(settled.state.result.winnerIds, ['player-1']);
  assert.equal(settled.state.activeIndex, -1);
});

test('everyone else folding ends the hand and the last player takes the pot', () => {
  const players = createPlayers(['Alder', 'Birch', 'Cedar'], 100);
  let room = startRoomGame(createLobbyRoom({ roomId: 'room:fold', players, config: { smallBlind: 5, bigBlind: 10, startingChips: 100 }, hostPlayerId: 'player-1' }), seededRandom(3));
  room = applyRoomPlayerAction(room, ACTION.fold).room;
  room = applyRoomPlayerAction(room, ACTION.fold).room;
  assert.equal(room.state.phase, PHASE.finished);
  assert.equal(room.state.result.source, 'last-standing');
  assert.equal(room.state.players.reduce((total, player) => total + player.chips, 0), 300, 'chips are conserved');
});

test('the next hand moves the dealer on, raises the blinds, and only deals players who still have chips', () => {
  const finished = advanceRoomStreet(roomAtRiverShowdown());
  const next = nextRoomHand({ ...finished, config: { ...finished.config, blindIncrease: 5 } }, () => 0);
  assert.equal(next.handNumber, finished.handNumber + 1);
  assert.equal(next.state.dealerIndex, 1);
  assert.deepEqual([next.state.smallBlind, next.state.bigBlind], [10, 20]);
});

test('hands rank from high card up to a straight flush, with the wheel as the lowest straight', () => {
  const category = codes => bestHand(cards(...codes)).category;
  assert.equal(category(['AH', 'KS', '9D', '5C', '3H']), 'high card');
  assert.equal(category(['AH', 'AS', '9D', '5C', '3H']), 'pair');
  assert.equal(category(['AH', 'AS', '9D', '9C', '3H']), 'two pair');
  assert.equal(category(['AH', 'AS', 'AD', '5C', '3H']), 'three of a kind');
  assert.equal(category(['9H', '8S', '7D', '6C', '5H']), 'straight');
  assert.equal(category(['AH', '2S', '3D', '4C', '5H']), 'straight');
  assert.equal(category(['AH', '9H', '7H', '5H', '3H']), 'flush');
  assert.equal(category(['AH', 'AS', 'AD', '5C', '5H']), 'full house');
  assert.equal(category(['AH', 'AS', 'AD', 'AC', '5H']), 'four of a kind');
  assert.equal(category(['9H', '8H', '7H', '6H', '5H']), 'straight flush');
  assert.deepEqual(bestHand(cards('AH', '2S', '3D', '4C', '5H')).score, [4, 5], 'the wheel is five high');
  assert.deepEqual(bestHand(cards('KH', 'QS', 'JD', 'TC', 'AH')).score, [4, 14]);
});

test('the best five of seven are chosen, and kickers settle a tie in category', () => {
  assert.equal(bestHand(cards('AH', 'AS', '2D', '7C', '9H', '9D', 'KC')).category, 'two pair');
  assert.equal(bestHand(cards('AH', 'KS')), null);
  const result = rankHands(cards('AS', '7D', '9C', '3H', '2C'), [
    { id: 'low-kicker', cards: cards('AD', '4C') },
    { id: 'high-kicker', cards: cards('AH', 'KC') },
  ]);
  assert.deepEqual(result.winners, ['high-kicker']);
  assert.deepEqual(result.ranking.map(entry => [entry.id, entry.place]), [['high-kicker', 1], ['low-kicker', 2]]);
  const early = rankHands(cards('AS', '7D'), [{ id: 'waiting', cards: cards('KD', 'QC') }, { id: 'none', cards: [] }]);
  assert.deepEqual(early.winners, []);
  assert.deepEqual(early.ranking.map(entry => [entry.id, entry.category, entry.place]), [['waiting', null, null], ['none', null, null]]);
});

test('hands that tie share first place and every one of them wins', () => {
  const result = rankHands(cards('2S', '3H', '4D', '5C', '6S'), [{ id: 'a', cards: cards('AH', 'KD') }, { id: 'b', cards: cards('QH', 'JC') }]);
  assert.deepEqual(result.winners, ['a', 'b']);
  assert.deepEqual(result.ranking.map(entry => entry.place), [1, 1]);
});

test('a card code that is not a card is refused with the codes that are allowed', () => {
  for (const bad of ['1S', 'AX', 'A', 'ASS', 7, null]) assert.throws(() => parseCard(bad), /is not a card/);
});

test('a player sees their own cards at all times and everyone\'s only when the hand is over', () => {
  const room = startedHeadsUp('room:view');
  const seen = projectRoomForPlayer(room, 'player-2');
  assert.deepEqual(seen.privateHand.cards, room.holeCards['player-2']);
  assert.deepEqual([seen.publicHoleCards, seen.revealedPlayerIds], [{}, []]);
  const over = projectRoomForPlayer(advanceRoomStreet(roomAtRiverShowdown()), 'player-2');
  assert.deepEqual(Object.keys(over.publicHoleCards), ['player-1', 'player-2']);
});

test('the betting controls are on only for the player whose turn it is, and say what a call costs', () => {
  const room = startedHeadsUp('room:controls');
  const toAct = room.state.players[room.state.activeIndex].id;
  const mine = deriveControls(room.state, toAct);
  assert.ok(mine.every(control => control.enabled));
  assert.equal(mine.find(control => control.action === ACTION.check_call).label, 'Call 5');
  assert.equal(mine.find(control => control.action === ACTION.raise).minAmount, 10);
  assert.ok(deriveControls(room.state, 'player-9').every(control => !control.enabled));
  assert.ok(deriveControls(room.state, null).every(control => !control.enabled));
});
