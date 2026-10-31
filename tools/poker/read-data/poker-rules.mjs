// tools/poker/read-data/poker-rules.mjs
//
// Texas Hold'em as pure functions over a table's saved state. Nothing here deals with a screen, a network, a clock or
// a stored file: a function takes a table state (and a random source when it deals) and returns the next state.
// Every name of the game (ranks, suits, phases, streets, actions, events, table defaults) is read from hold-em.json.
import rules from './hold-em.json' with { type: 'json' };

const PHASE = rules.phases;
const ACTION = rules.player_actions;
const EVENT = rules.events;
const BLIND = rules.blind_modes;

export const RULES = rules;
export const RANKS = rules.ranks;
export const SUITS = rules.suits;
export const STREETS = rules.street_flow.map(flow => flow.street);
export const PLAYER_ACTIONS = Object.values(ACTION);

const RANK_VALUE = new Map(RANKS.map((rank, index) => [rank, index + 2]));
export const CARDS_ON_THE_BOARD = Math.max(...rules.street_flow.map(flow => flow.visible_community_cards));
export const HOLE_CARDS = 2;
const HAND_SIZE = 5;

const numberOr = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
const roundAtLeast = (value, minimum, fallback) => Math.max(minimum, Math.round(numberOr(value, fallback)));
const fill = (template, values) => template.replace(/\{(\w+)\}/g, (_, key) => String(values[key]));

// A random source from a whole number: the same seed gives the same sequence on every machine.
export function seededRandom(seed) {
  if (!Number.isSafeInteger(seed)) throw new Error('seed must be a whole number: the same seed deals the same cards.');
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), state | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

const openingStreet = () => rules.street_flow[0].street;
const streetFlow = street => rules.street_flow.find(flow => flow.street === street) ?? rules.street_flow[0];

export function normalizeTableConfig(input = {}) {
  const defaults = rules.table_defaults;
  const smallBlind = roundAtLeast(input.smallBlind, defaults.small_blind.least, defaults.small_blind.default);
  return {
    startingChips: roundAtLeast(input.startingChips, defaults.starting_chips.least, defaults.starting_chips.default),
    smallBlind,
    bigBlind: Math.max(smallBlind, roundAtLeast(input.bigBlind, smallBlind, smallBlind * defaults.big_blind_is_small_blind_times)),
    blindMode: input.blindMode === BLIND.multiplier ? BLIND.multiplier : BLIND.fixed,
    blindIncrease: Math.max(0, numberOr(input.blindIncrease, 0)),
    maxPlayers: Math.min(defaults.max_players.most, roundAtLeast(input.maxPlayers, defaults.max_players.least, defaults.max_players.default)),
  };
}

export function makeDeck() {
  return SUITS.flatMap(suit => RANKS.map(rank => ({ rank, suit, value: RANK_VALUE.get(rank), code: `${rank}${suit}` })));
}

// A card from its two-letter code (rank then suit), or an error that says which codes are allowed.
export function parseCard(code) {
  const rank = typeof code === 'string' ? code[0] : undefined;
  const suit = typeof code === 'string' ? code[1] : undefined;
  if (typeof code !== 'string' || code.length !== 2 || !RANK_VALUE.has(rank) || !SUITS.includes(suit)) {
    throw new Error(`${JSON.stringify(code)} is not a card: write its rank (${RANKS.join('')}) then its suit (${SUITS.join('')}), for example ${RANKS.at(-1)}${SUITS[0]}.`);
  }
  return { rank, suit, value: RANK_VALUE.get(rank), code };
}

export function createPlayers(names, startingChips) {
  return names.map((name, index) => ({
    id: `player-${index + 1}`,
    name: name.trim() || `Player ${index + 1}`,
    chips: Math.max(0, Math.round(startingChips)),
    currentBet: 0,
    totalCommitted: 0,
    hasActed: false,
    folded: false,
    allIn: false,
    eliminated: false,
    connected: true,
  }));
}

export const isPlayerInHand = player => !player.eliminated && player.chips > 0;
export const canPlayerAct = player => isPlayerInHand(player) && !player.folded && !player.allIn;
export const activePlayerCount = players => players.filter(isPlayerInHand).length;
const showdownContenders = players => players.filter(player => !player.folded && !player.eliminated);

export function nextPlayerIndex(players, fromIndex, predicate = isPlayerInHand) {
  if (!players.some(predicate)) return -1;
  for (let step = 1; step <= players.length; step += 1) {
    const candidate = (((fromIndex + step) % players.length) + players.length) % players.length;
    if (predicate(players[candidate])) return candidate;
  }
  return -1;
}

export function postBlind(player, blind) {
  const paid = Math.min(player.chips, Math.max(0, Math.round(blind)));
  const chips = player.chips - paid;
  return {
    paid,
    player: { ...player, chips, currentBet: player.currentBet + paid, totalCommitted: player.totalCommitted + paid, hasActed: false, allIn: chips === 0, eliminated: false },
  };
}

function emptyHandState(phase, players, config, handNumber) {
  return {
    phase,
    config,
    players,
    communityCards: [],
    dealerIndex: -1,
    smallBlindIndex: -1,
    bigBlindIndex: -1,
    activeIndex: -1,
    pot: 0,
    pots: [],
    currentBet: 0,
    minRaise: config.bigBlind,
    street: openingStreet(),
    handNumber,
    smallBlind: config.smallBlind,
    bigBlind: config.bigBlind,
    result: null,
  };
}

export function createLobbyHandState(players, configInput = {}, handNumber = 0) {
  const config = normalizeTableConfig(configInput);
  const seated = players.slice(0, config.maxPlayers).map(player => ({
    ...player,
    chips: Math.max(0, Math.round(player.chips || config.startingChips)),
    currentBet: 0,
    totalCommitted: 0,
    hasActed: false,
    folded: false,
    allIn: false,
    eliminated: false,
    connected: true,
  }));
  return emptyHandState(PHASE.lobby, seated, config, handNumber);
}

export function nextBlinds(config, smallBlind, bigBlind) {
  if (config.blindMode === BLIND.multiplier) {
    const multiplier = Math.max(1, numberOr(config.blindIncrease, 1));
    return { smallBlind: Math.max(1, Math.round(smallBlind * multiplier)), bigBlind: Math.max(1, Math.round(bigBlind * multiplier)) };
  }
  const increase = Math.max(0, Math.round(numberOr(config.blindIncrease, 0)));
  return { smallBlind: smallBlind + increase, bigBlind: bigBlind + increase * 2 };
}

export function createHandState(players, configInput = {}, previousDealerIndex = -1, handNumber = 1) {
  const config = normalizeTableConfig(configInput);
  const handPlayers = players.map(player => ({
    ...player,
    currentBet: 0,
    totalCommitted: 0,
    hasActed: false,
    folded: false,
    allIn: false,
    eliminated: player.eliminated || player.chips <= 0,
  }));
  if (activePlayerCount(handPlayers) < 2) return emptyHandState(PHASE.finished, handPlayers, config, handNumber);

  const dealerIndex = nextPlayerIndex(handPlayers, previousDealerIndex);
  const headsUp = activePlayerCount(handPlayers) === 2;
  const smallBlindIndex = headsUp ? dealerIndex : nextPlayerIndex(handPlayers, dealerIndex);
  const bigBlindIndex = nextPlayerIndex(handPlayers, smallBlindIndex);
  const activeIndex = headsUp ? smallBlindIndex : nextPlayerIndex(handPlayers, bigBlindIndex);

  const small = postBlind(handPlayers[smallBlindIndex], config.smallBlind);
  handPlayers[smallBlindIndex] = small.player;
  const big = postBlind(handPlayers[bigBlindIndex], config.bigBlind);
  handPlayers[bigBlindIndex] = big.player;
  const pot = small.paid + big.paid;

  return {
    ...emptyHandState(PHASE.active, handPlayers, config, handNumber),
    dealerIndex,
    smallBlindIndex,
    bigBlindIndex,
    activeIndex,
    pot,
    pots: [{ amount: pot, eligibleIds: handPlayers.filter(isPlayerInHand).map(player => player.id) }],
    currentBet: config.bigBlind,
  };
}

const eventOf = (kind, actorId, key, values = {}) => ({ kind, actorId, text: fill(rules.event_text[key], values) });

export function applyPlayerAction(state, playerId, action, amount = 0) {
  const playerIndex = state.players.findIndex(player => player.id === playerId);
  const actor = state.players[playerIndex];
  if (playerIndex !== state.activeIndex || !actor || !canPlayerAct(actor) || !PLAYER_ACTIONS.includes(action)) {
    return { state, event: { kind: EVENT.warning, actorId: playerId, text: rules.event_text.rejected } };
  }

  const players = state.players.slice();
  let potDelta = 0;
  let currentBet = state.currentBet;
  let minRaise = state.minRaise;
  let event;

  if (action === ACTION.fold) {
    players[playerIndex] = { ...actor, folded: true, hasActed: true };
    event = eventOf(EVENT.fold, actor.id, 'fold', { name: actor.name });
  } else if (action === ACTION.check_call) {
    const needed = Math.max(0, state.currentBet - actor.currentBet);
    const paid = Math.min(actor.chips, needed);
    players[playerIndex] = {
      ...actor,
      chips: actor.chips - paid,
      currentBet: actor.currentBet + paid,
      totalCommitted: actor.totalCommitted + paid,
      hasActed: true,
      allIn: actor.chips - paid === 0 && paid > 0,
    };
    potDelta = paid;
    event = needed === 0
      ? eventOf(EVENT.check, actor.id, 'check', { name: actor.name })
      : eventOf(EVENT.call, actor.id, 'call', { name: actor.name, paid });
  } else {
    const targetBet = action === ACTION.raise
      ? state.currentBet + Math.max(state.minRaise, Math.round(numberOr(amount, state.minRaise)))
      : actor.currentBet + actor.chips;
    const paid = Math.min(actor.chips, Math.max(0, targetBet - actor.currentBet));
    const nextBet = actor.currentBet + paid;
    players[playerIndex] = {
      ...actor,
      chips: actor.chips - paid,
      currentBet: nextBet,
      totalCommitted: actor.totalCommitted + paid,
      hasActed: true,
      allIn: actor.chips - paid === 0,
    };
    potDelta = paid;
    if (nextBet > state.currentBet) {
      minRaise = nextBet - state.currentBet;
      currentBet = nextBet;
      for (let index = 0; index < players.length; index += 1) {
        if (index !== playerIndex && canPlayerAct(players[index])) players[index] = { ...players[index], hasActed: false };
      }
    }
    event = action === ACTION.all_in
      ? eventOf(EVENT.all_in, actor.id, 'all_in', { name: actor.name, paid })
      : eventOf(EVENT.raise, actor.id, 'raise', { name: actor.name, paid });
  }

  const pot = state.pot + potDelta;
  return {
    event,
    state: {
      ...state,
      players,
      activeIndex: nextPlayerIndex(players, state.activeIndex, canPlayerAct),
      pot,
      currentBet,
      minRaise,
      pots: [{ amount: pot, eligibleIds: showdownContenders(players).map(player => player.id) }],
    },
  };
}

export function shuffleDeck(random = Math.random) {
  const deck = makeDeck();
  for (let index = deck.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [deck[index], deck[swapIndex]] = [deck[swapIndex], deck[index]];
  }
  return deck;
}

export function visibleCommunityCards(state, board) {
  if (state.phase === PHASE.showdown || state.phase === PHASE.finished) return board.slice(0, CARDS_ON_THE_BOARD);
  return board.slice(0, streetFlow(state.street).visible_community_cards);
}

// A hand's score is a list of numbers compared left to right: the category first, then the cards that settle ties.
function compareScores(left, right) {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const delta = (left[index] ?? 0) - (right[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

function straightHighCard(values) {
  const distinct = [...new Set(values)].sort((left, right) => right - left);
  const ranks = distinct.includes(RANK_VALUE.get(RANKS.at(-1))) ? [...distinct, 1] : distinct;
  for (let index = 0; index <= ranks.length - HAND_SIZE; index += 1) {
    const sequence = ranks.slice(index, index + HAND_SIZE);
    if (sequence.every((value, at) => at === 0 || value === sequence[at - 1] - 1)) return sequence[0];
  }
  return 0;
}

function scoreFiveCards(cards) {
  const values = cards.map(card => card.value).sort((left, right) => right - left);
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  const groups = [...counts.entries()].sort((left, right) => right[1] - left[1] || right[0] - left[0]);
  const flush = new Set(cards.map(card => card.suit)).size === 1;
  const straight = straightHighCard(values);
  const singles = groups.filter(group => group[1] === 1).map(group => group[0]).sort((left, right) => right - left);
  const pairs = groups.filter(group => group[1] === 2).map(group => group[0]).sort((left, right) => right - left);

  if (flush && straight) return [8, straight];
  if (groups[0][1] === 4) return [7, groups[0][0], singles[0] ?? 0];
  if (groups[0][1] === 3 && groups[1]?.[1] === 2) return [6, groups[0][0], groups[1][0]];
  if (flush) return [5, ...values];
  if (straight) return [4, straight];
  if (groups[0][1] === 3) return [3, groups[0][0], ...singles];
  if (pairs.length >= 2) return [2, pairs[0], pairs[1], singles[0] ?? 0];
  if (pairs.length === 1) return [1, pairs[0], ...singles];
  return [0, ...values];
}

function fiveCardChoices(cards, start = 0, chosen = [], found = []) {
  if (chosen.length === HAND_SIZE) { found.push(chosen); return found; }
  for (let index = start; index <= cards.length - (HAND_SIZE - chosen.length); index += 1) {
    fiveCardChoices(cards, index + 1, [...chosen, cards[index]], found);
  }
  return found;
}

// The best five of the cards given (five to any number), as { score, category, cards }, or null under five cards.
export function bestHand(cards) {
  if (cards.length < HAND_SIZE) return null;
  let best = null;
  for (const choice of fiveCardChoices(cards)) {
    const score = scoreFiveCards(choice);
    if (!best || compareScores(score, best.score) > 0) best = { score, category: rules.hand_categories[score[0]], cards: choice.map(card => card.code) };
  }
  return best;
}

// Hands ranked best first; a hand that ties the one above it shares its place. Winners are the hands that share first place.
export function rankHands(board, hands) {
  const ranked = hands
    .map(hand => ({ id: hand.id, best: bestHand([...hand.cards, ...board]) }))
    .map(hand => ({ id: hand.id, score: hand.best?.score ?? null, category: hand.best?.category ?? null, bestFive: hand.best?.cards ?? null }));
  const rankable = ranked.filter(hand => hand.score).sort((left, right) => compareScores(right.score, left.score));
  let place = 0;
  rankable.forEach((hand, index) => {
    if (index === 0 || compareScores(rankable[index - 1].score, hand.score) !== 0) place = index + 1;
    hand.place = place;
  });
  return {
    ranking: [...rankable, ...ranked.filter(hand => !hand.score).map(hand => ({ ...hand, place: null }))],
    winners: rankable.filter(hand => hand.place === 1).map(hand => hand.id),
  };
}

function settleShowdown(room) {
  if (room.state.result) return room;
  const scored = showdownContenders(room.state.players)
    .map(player => ({ player, hand: bestHand([...(room.holeCards[player.id] ?? []), ...room.board]) }))
    .filter(entry => entry.hand);
  if (scored.length === 0) return room;

  let winners = [scored[0]];
  for (const entry of scored.slice(1)) {
    const comparison = compareScores(entry.hand.score, winners[0].hand.score);
    if (comparison > 0) winners = [entry];
    if (comparison === 0) winners.push(entry);
  }

  const winnerIds = winners.map(entry => entry.player.id);
  const winnerSet = new Set(winnerIds);
  const wonPot = room.state.pot;
  const share = Math.floor(wonPot / winnerIds.length);
  let remainder = wonPot % winnerIds.length;
  const gains = new Map();
  for (const player of room.state.players) {
    if (!winnerSet.has(player.id)) continue;
    gains.set(player.id, share + (remainder > 0 ? 1 : 0));
    remainder = Math.max(0, remainder - 1);
  }

  const players = room.state.players.map(player => {
    const chips = player.chips + (gains.get(player.id) ?? 0);
    return { ...player, chips, currentBet: 0, totalCommitted: 0, hasActed: false, folded: false, allIn: false, eliminated: player.eliminated || chips <= 0 };
  });
  const finished = {
    ...room.state,
    players,
    phase: PHASE.finished,
    activeIndex: -1,
    pot: 0,
    pots: [],
    currentBet: 0,
    minRaise: room.state.bigBlind,
    result: { source: 'showdown', winnerIds, pot: wonPot, handNumber: room.state.handNumber },
  };
  return { ...room, state: { ...finished, communityCards: visibleCommunityCards(finished, room.board) } };
}

function dealCards(players, random) {
  const deck = shuffleDeck(random);
  const holeCards = {};
  let cursor = 0;
  for (const player of players) {
    holeCards[player.id] = deck.slice(cursor, cursor + HOLE_CARDS);
    cursor += HOLE_CARDS;
  }
  return { board: deck.slice(cursor, cursor + CARDS_ON_THE_BOARD), holeCards };
}

// A saved table as the caller handed it back, or an error that says what a saved table is.
export function readRoom(value) {
  if (value?.kind !== 'poker-room-state' || value.version !== 1 || !Array.isArray(value.state?.players)) {
    throw new Error('room must be a saved poker table: the room that open-table or an earlier operation gave back, unchanged.');
  }
  return value;
}

export function createLobbyRoom({ roomId, players, config, hostPlayerId }) {
  const normalized = normalizeTableConfig(config);
  return {
    kind: 'poker-room-state',
    version: 1,
    roomId,
    board: [],
    config: normalized,
    handNumber: 0,
    holeCards: {},
    hostPlayerId,
    state: createLobbyHandState(players, normalized),
  };
}

export function createRoom({ roomId, players, config, previousDealerIndex = -1, handNumber = 1, hostPlayerId, random = Math.random }) {
  const normalized = normalizeTableConfig(config);
  const state = createHandState(players, normalized, previousDealerIndex, handNumber);
  const deal = dealCards(state.players, random);
  return {
    kind: 'poker-room-state',
    version: 1,
    roomId,
    board: deal.board,
    config: normalized,
    handNumber: state.handNumber,
    holeCards: deal.holeCards,
    hostPlayerId,
    state: { ...state, communityCards: visibleCommunityCards(state, deal.board) },
  };
}

export const nextStreetLabel = state => streetFlow(state.street).advance_label;

export function advanceRoomStreet(room) {
  const current = room.state;
  const players = current.players.map(player => ({ ...player, currentBet: 0, hasActed: false }));
  const flow = streetFlow(current.street);
  const activeIndex = flow.next_phase === PHASE.showdown ? -1 : nextPlayerIndex(players, current.dealerIndex, canPlayerAct);
  const state = { ...current, players, phase: flow.next_phase, street: flow.next_street, activeIndex, currentBet: 0, minRaise: current.bigBlind, result: null };
  const advanced = { ...room, state: { ...state, communityCards: visibleCommunityCards(state, room.board) } };
  return state.phase === PHASE.showdown ? settleShowdown(advanced) : advanced;
}

export function startRoomGame(room, random = Math.random) {
  const seated = room.state.players
    .filter(player => player.connected && !player.eliminated)
    .map(player => ({ ...player, chips: Math.max(0, Math.round(player.chips || room.config.startingChips)) }));
  return createRoom({
    roomId: room.roomId,
    players: seated,
    config: room.config,
    previousDealerIndex: -1,
    handNumber: Math.max(1, room.handNumber || 1),
    hostPlayerId: seated.some(player => player.id === room.hostPlayerId) ? room.hostPlayerId : seated[0]?.id ?? room.hostPlayerId,
    random,
  });
}

export function configureRoom(room, configInput) {
  const config = normalizeTableConfig({ ...room.config, ...configInput });
  if (room.state.phase !== PHASE.lobby) return { ...room, config, state: { ...room.state, config } };
  return { ...room, config, state: createLobbyHandState(room.state.players, config, room.handNumber) };
}

function nextPlayerId(players) {
  const highest = players.reduce((most, player) => {
    const match = /^player-(\d+)$/.exec(player.id);
    return Math.max(most, match ? Number(match[1]) : 0);
  }, 0);
  return `player-${highest + 1}`;
}

export function upsertRoomPlayer(room, { playerId, name }) {
  const trimmed = name.trim();
  if (!trimmed) return { room, playerId: playerId ?? '' };

  const players = room.state.players.slice();
  const existingIndex = playerId
    ? players.findIndex(player => player.id === playerId)
    : players.findIndex(player => player.name.trim().toLowerCase() === trimmed.toLowerCase());

  if (existingIndex >= 0) {
    const existing = players[existingIndex];
    players[existingIndex] = { ...existing, name: trimmed, connected: true };
    const next = room.state.phase === PHASE.lobby
      ? createLobbyRoom({ roomId: room.roomId, players, config: room.config, hostPlayerId: room.hostPlayerId })
      : { ...room, state: { ...room.state, players } };
    return { room: next, playerId: existing.id };
  }

  if (room.state.phase !== PHASE.lobby || players.length >= room.config.maxPlayers) return { room, playerId: playerId ?? '' };

  const id = nextPlayerId(players);
  const seated = { id, name: trimmed, chips: room.config.startingChips, currentBet: 0, totalCommitted: 0, hasActed: false, folded: false, allIn: false, eliminated: false, connected: true };
  return {
    playerId: id,
    room: createLobbyRoom({ roomId: room.roomId, players: [...players, seated], config: room.config, hostPlayerId: room.hostPlayerId || id }),
  };
}

export function finishRoomIfSingleContender(room) {
  const contenders = showdownContenders(room.state.players);
  if (contenders.length !== 1 || room.state.phase !== PHASE.active) return room;

  const winnerId = contenders[0].id;
  const wonPot = room.state.pot;
  const players = room.state.players.map(player => ({
    ...player,
    chips: player.id === winnerId ? player.chips + wonPot : player.chips,
    currentBet: 0,
    totalCommitted: 0,
    hasActed: false,
    folded: false,
    allIn: false,
    eliminated: player.eliminated || (player.id !== winnerId && player.chips <= 0),
  }));
  return {
    ...room,
    state: {
      ...room.state,
      players,
      activeIndex: -1,
      currentBet: 0,
      phase: PHASE.finished,
      pot: 0,
      pots: [],
      result: { source: 'last-standing', winnerIds: [winnerId], pot: wonPot, handNumber: room.state.handNumber },
      communityCards: visibleCommunityCards({ ...room.state, phase: PHASE.finished }, room.board),
    },
  };
}

export function isBettingRoundComplete(state) {
  if (state.phase !== PHASE.active) return false;
  const actors = state.players.filter(canPlayerAct);
  if (state.currentBet === 0 && showdownContenders(state.players).length > 1 && actors.length <= 1) return true;
  if (actors.length === 0) return true;
  return actors.every(player => player.hasActed && player.currentBet === state.currentBet);
}

function completeRoomAfterAction(room) {
  let next = finishRoomIfSingleContender(room);
  while (isBettingRoundComplete(next.state)) {
    const advanced = advanceRoomStreet(next);
    if (advanced.state.phase !== PHASE.active) return advanced;
    next = advanced;
  }
  return next;
}

// The seat to act takes the action; the answer is the new room and what happened, in words.
export function applyRoomPlayerAction(room, action, amount) {
  const actor = room.state.players[room.state.activeIndex];
  if (!actor) return { room, event: { kind: EVENT.warning, actorId: null, text: rules.event_text.rejected } };
  const result = applyPlayerAction(room.state, actor.id, action, amount ?? room.state.minRaise);
  const settled = completeRoomAfterAction({ ...room, state: { ...result.state, communityCards: visibleCommunityCards(result.state, room.board) } });
  return { room: settled, event: result.event };
}

export function nextRoomHand(room, random = Math.random) {
  return createRoom({
    roomId: room.roomId,
    players: room.state.players.filter(player => !player.eliminated && player.chips > 0),
    config: { ...room.config, ...nextBlinds(room.config, room.state.smallBlind, room.state.bigBlind) },
    previousDealerIndex: room.state.dealerIndex,
    handNumber: room.handNumber + 1,
    hostPlayerId: room.hostPlayerId,
    random,
  });
}

export function kickRoomPlayer(room, playerId, random = Math.random) {
  const players = room.state.players.filter(player => player.id !== playerId);
  const hostPlayerId = room.hostPlayerId === playerId ? players[0]?.id ?? '' : room.hostPlayerId;
  if (room.state.phase === PHASE.lobby) return createLobbyRoom({ roomId: room.roomId, players, config: room.config, hostPlayerId });
  if (players.length < 2) return { ...room, hostPlayerId, state: { ...room.state, players, phase: PHASE.finished, activeIndex: -1 } };
  return createRoom({ roomId: room.roomId, players, config: room.config, previousDealerIndex: -1, handNumber: room.handNumber + 1, hostPlayerId, random });
}

// What one player may see: their own cards always, everyone's once the hand is over and never before.
export function projectRoomForPlayer(room, currentPlayerId) {
  const standIn = room.state.players[room.state.activeIndex]
    ?? room.state.players.find(player => player.id === currentPlayerId)
    ?? room.state.players.find(player => player.id === room.hostPlayerId)
    ?? room.state.players[0];
  const ownerId = currentPlayerId ?? standIn?.id ?? null;
  const revealAll = room.state.phase === PHASE.showdown || room.state.phase === PHASE.finished;
  return {
    privateHand: { ownerId, cards: ownerId ? room.holeCards[ownerId] ?? [] : [] },
    publicHoleCards: revealAll ? Object.fromEntries(room.state.players.map(player => [player.id, room.holeCards[player.id] ?? []])) : {},
    revealedPlayerIds: revealAll ? room.state.players.map(player => player.id) : [],
  };
}

// The four betting actions as a player sees them, enabled only on that player's turn.
export function deriveControls(state, currentPlayerId) {
  const active = state.players[state.activeIndex];
  const isCurrentTurn = Boolean(active && currentPlayerId === active.id && !active.folded && !active.allIn && !active.eliminated);
  const toCall = active ? Math.max(0, state.currentBet - active.currentBet) : 0;
  const labels = rules.control_labels;
  return [
    { action: ACTION.fold, label: labels.fold, enabled: isCurrentTurn },
    { action: ACTION.check_call, label: toCall === 0 ? labels.check : fill(labels.call, { to_call: toCall }), enabled: isCurrentTurn, amountRequired: toCall },
    { action: ACTION.raise, label: labels.raise, enabled: isCurrentTurn, minAmount: state.minRaise },
    { action: ACTION.all_in, label: labels.all_in, enabled: isCurrentTurn },
  ];
}

export function deriveHandResult(state) {
  const result = state.result;
  if (!result || result.winnerIds.length === 0) return null;
  const winnerNames = result.winnerIds.map(id => state.players.find(player => player.id === id)?.name).filter(Boolean);
  return winnerNames.length === 0 ? null : { winnerIds: result.winnerIds, winnerNames, pot: result.pot, source: result.source };
}

export function seatRoles(state) {
  return Object.fromEntries(state.players.map((player, index) => {
    const roles = [];
    if (index === state.dealerIndex) roles.push(rules.seat_roles.dealer);
    if (index === state.smallBlindIndex) roles.push(rules.seat_roles.small_blind);
    if (index === state.bigBlindIndex) roles.push(rules.seat_roles.big_blind);
    return [player.id, roles];
  }));
}
