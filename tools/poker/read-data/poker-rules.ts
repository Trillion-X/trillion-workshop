// package-set://bitfield-studio/packages/poker-rules/read-data/poker-rules.ts
//
// Pure Texas Hold'em rule helpers. This file owns rule-state transforms only;
// transports, rooms, renderers, bots, and sound stay outside this package.

import pokerRulesPackage from '@/packages/poker-rules/things-to-store-and-run.json';

export interface PokerRankDescriptor {
  label: string;
  value: number;
}

export interface PokerRulesVocabulary {
  ranks: readonly PokerRankDescriptor[];
  suits: readonly string[];
  streets: readonly string[];
  phases: readonly string[];
  blindModes: readonly string[];
  playerActions: readonly string[];
  events: readonly string[];
}

export interface PokerPhaseRoles {
  lobby: string;
  active: string;
  showdown: string;
  finished: string;
}

export interface PokerBlindModeRoles {
  fixed: string;
  multiplier: string;
}

export interface PokerPlayerActionRoles {
  fold: string;
  checkCall: string;
  raise: string;
  allIn: string;
}

export interface PokerSeatRoles {
  dealer: string;
  smallBlind: string;
  bigBlind: string;
}

export interface PokerEventRoles {
  warning: string;
  fold: string;
  check: string;
  call: string;
  raise: string;
  allIn: string;
}

export interface PokerSuitAppearance {
  suit: string;
  label: string;
  symbol: string;
  color: string;
}

export interface PokerStreetFlow {
  street: string;
  visibleCommunityCards: number;
  nextStreet: string;
  nextPhase: string;
  advanceLabel: string;
}

export interface PokerRulesStateMachine {
  phaseRoles: PokerPhaseRoles;
  blindModes: PokerBlindModeRoles;
  playerActionRoles: PokerPlayerActionRoles;
  seatRoles: PokerSeatRoles;
  eventRoles: PokerEventRoles;
  suitAppearance: readonly PokerSuitAppearance[];
  streetFlow: readonly PokerStreetFlow[];
}

export type PokerRank = string;
export type PokerSuit = string;
export type PokerStreet = string;
export type BlindMode = string;
export type PokerPhase = string;
export type PlayerAction = string;

export interface PokerCard {
  rank: PokerRank;
  suit: PokerSuit;
  value: number;
  code: string;
}

export interface PokerTableConfig {
  startingChips: number;
  smallBlind: number;
  bigBlind: number;
  blindMode: BlindMode;
  blindIncrease: number;
  maxPlayers: number;
}

export interface PokerPlayer {
  id: string;
  name: string;
  chips: number;
  currentBet: number;
  totalCommitted: number;
  hasActed: boolean;
  folded: boolean;
  allIn: boolean;
  eliminated: boolean;
  connected: boolean;
}

export interface SidePot {
  amount: number;
  eligibleIds: string[];
}

export interface PokerHandResult {
  source: string;
  winnerIds: string[];
  pot: number;
  handNumber: number;
}

export interface PokerHandState {
  phase: PokerPhase;
  config: PokerTableConfig;
  players: PokerPlayer[];
  communityCards: PokerCard[];
  dealerIndex: number;
  smallBlindIndex: number;
  bigBlindIndex: number;
  activeIndex: number;
  pot: number;
  pots: SidePot[];
  currentBet: number;
  minRaise: number;
  street: PokerStreet;
  handNumber: number;
  smallBlind: number;
  bigBlind: number;
  result: PokerHandResult | null;
}

export interface PokerActionResult {
  state: PokerHandState;
  event: {
    kind: string;
    actorId: string | null;
    text: string;
  };
}

export interface PokerRoomState {
  kind: 'poker-room-state';
  version: 1;
  roomId: string;
  board: PokerCard[];
  config: PokerTableConfig;
  handNumber: number;
  holeCards: Record<string, PokerCard[]>;
  hostPlayerId: string;
  state: PokerHandState;
}

export interface PokerRoomProjection {
  privateHand: {
    ownerId: string | null;
    cards: PokerCard[];
    hidden: true;
    canToggle: boolean;
  };
  publicHoleCards: Record<string, PokerCard[]>;
  revealedPlayerIds: string[];
}

export const POKER_RULES_VOCABULARY = readPokerRulesVocabulary();
export const POKER_RANKS = Object.freeze(POKER_RULES_VOCABULARY.ranks.map((rank) => rank.label));
export const POKER_SUITS = Object.freeze(POKER_RULES_VOCABULARY.suits.slice());
export const POKER_STREETS = Object.freeze(POKER_RULES_VOCABULARY.streets.slice());
export const POKER_PHASES = Object.freeze(POKER_RULES_VOCABULARY.phases.slice());
export const POKER_PLAYER_ACTIONS = Object.freeze(POKER_RULES_VOCABULARY.playerActions.slice());
export const POKER_RULES_STATE_MACHINE = readPokerRulesStateMachine();

export function readPokerRulesVocabulary(contract: unknown = pokerRulesPackage): PokerRulesVocabulary {
  const schema = recordPayload(contract, 'package::poker-rules::schema');
  const actions = recordPayload(contract, 'package::poker-rules::action-contracts');
  const entities = record(schema.entities, 'schema.entities');
  const card = record(entities.card, 'schema.entities.card');
  const tableConfig = record(entities.table_config, 'schema.entities.table_config');
  const handState = record(entities.hand_state, 'schema.entities.hand_state');
  const event = record(entities.event, 'schema.entities.event');
  const playerAction = arrayOfRecords(actions.actions, 'action-contracts.actions')
    .find((action) => action.name === 'player-action');

  return Object.freeze({
    ranks: Object.freeze(arrayOfText(card.rank, 'card.rank').map((label, index) => Object.freeze({
      label,
      value: index + 2,
    }))),
    suits: Object.freeze(arrayOfText(card.suit, 'card.suit')),
    streets: Object.freeze(arrayOfText(handState.street, 'hand_state.street')),
    phases: Object.freeze(arrayOfText(handState.phase, 'hand_state.phase')),
    blindModes: Object.freeze(arrayOfText(tableConfig.blind_mode, 'table_config.blind_mode')),
    playerActions: Object.freeze(arrayOfText(record(playerAction?.input, 'player-action.input').action, 'player-action.input.action')),
    events: Object.freeze(arrayOfText(event.kind, 'event.kind')),
  });
}

export function readPokerRulesStateMachine(contract: unknown = pokerRulesPackage): PokerRulesStateMachine {
  const payload = recordPayload(contract, 'package::poker-rules::state-machine');
  const vocabulary = readPokerRulesVocabulary(contract);
  const phaseRolesPayload = record(payload.phase_roles, 'state-machine.phase_roles');
  const blindModesPayload = record(payload.blind_modes, 'state-machine.blind_modes');
  const playerActionRolesPayload = record(payload.player_action_roles, 'state-machine.player_action_roles');
  const seatRolesPayload = record(payload.seat_roles, 'state-machine.seat_roles');
  const eventRolesPayload = record(payload.event_roles, 'state-machine.event_roles');
  const suitAppearance = Object.freeze(arrayOfRecords(payload.suit_appearance, 'state-machine.suit_appearance').map((entry, index) => Object.freeze({
    suit: knownText(entry.suit, vocabulary.suits, `state-machine.suit_appearance.${index}.suit`),
    label: textField(entry.label, `state-machine.suit_appearance.${index}.label`),
    symbol: textField(entry.symbol, `state-machine.suit_appearance.${index}.symbol`),
    color: textField(entry.color, `state-machine.suit_appearance.${index}.color`),
  })));
  const appearanceSuits = new Set(suitAppearance.map((entry) => entry.suit));
  for (const suit of vocabulary.suits) {
    if (!appearanceSuits.has(suit)) {
      throw new TypeError(`state-machine.suit_appearance must include suit ${suit}`);
    }
  }
  const streetFlow = Object.freeze(arrayOfRecords(payload.street_flow, 'state-machine.street_flow').map((entry, index) => {
    const flow = Object.freeze({
      street: knownText(entry.street, vocabulary.streets, `state-machine.street_flow.${index}.street`),
      visibleCommunityCards: roundAtLeast(entry.visible_community_cards, 0, 0),
      nextStreet: knownText(entry.next_street, vocabulary.streets, `state-machine.street_flow.${index}.next_street`),
      nextPhase: knownText(entry.next_phase, vocabulary.phases, `state-machine.street_flow.${index}.next_phase`),
      advanceLabel: textField(entry.advance_label, `state-machine.street_flow.${index}.advance_label`),
    });
    return flow;
  }));
  if (streetFlow.length === 0) throw new TypeError('state-machine.street_flow must not be empty');

  return Object.freeze({
    phaseRoles: Object.freeze({
      lobby: knownText(phaseRolesPayload.lobby, vocabulary.phases, 'state-machine.phase_roles.lobby'),
      active: knownText(phaseRolesPayload.active, vocabulary.phases, 'state-machine.phase_roles.active'),
      showdown: knownText(phaseRolesPayload.showdown, vocabulary.phases, 'state-machine.phase_roles.showdown'),
      finished: knownText(phaseRolesPayload.finished, vocabulary.phases, 'state-machine.phase_roles.finished'),
    }),
    blindModes: Object.freeze({
      fixed: knownText(blindModesPayload.fixed, vocabulary.blindModes, 'state-machine.blind_modes.fixed'),
      multiplier: knownText(blindModesPayload.multiplier, vocabulary.blindModes, 'state-machine.blind_modes.multiplier'),
    }),
    playerActionRoles: Object.freeze({
      fold: knownText(playerActionRolesPayload.fold, vocabulary.playerActions, 'state-machine.player_action_roles.fold'),
      checkCall: knownText(playerActionRolesPayload.check_call, vocabulary.playerActions, 'state-machine.player_action_roles.check_call'),
      raise: knownText(playerActionRolesPayload.raise, vocabulary.playerActions, 'state-machine.player_action_roles.raise'),
      allIn: knownText(playerActionRolesPayload.all_in, vocabulary.playerActions, 'state-machine.player_action_roles.all_in'),
    }),
    seatRoles: Object.freeze({
      dealer: textField(seatRolesPayload.dealer, 'state-machine.seat_roles.dealer'),
      smallBlind: textField(seatRolesPayload.small_blind, 'state-machine.seat_roles.small_blind'),
      bigBlind: textField(seatRolesPayload.big_blind, 'state-machine.seat_roles.big_blind'),
    }),
    eventRoles: Object.freeze({
      warning: knownText(eventRolesPayload.warning, vocabulary.events, 'state-machine.event_roles.warning'),
      fold: knownText(eventRolesPayload.fold, vocabulary.events, 'state-machine.event_roles.fold'),
      check: knownText(eventRolesPayload.check, vocabulary.events, 'state-machine.event_roles.check'),
      call: knownText(eventRolesPayload.call, vocabulary.events, 'state-machine.event_roles.call'),
      raise: knownText(eventRolesPayload.raise, vocabulary.events, 'state-machine.event_roles.raise'),
      allIn: knownText(eventRolesPayload.all_in, vocabulary.events, 'state-machine.event_roles.all_in'),
    }),
    suitAppearance,
    streetFlow,
  });
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be a record`);
  }
  return value as Record<string, unknown>;
}

function recordPayload(contract: unknown, address: string): Record<string, unknown> {
  const packageRecord = arrayOfRecords(record(contract, 'poker-rules package').things, 'poker-rules package.things')
    .find((entry) => entry.address === address);
  return record(packageRecord?.payload, `${address}.payload`);
}

function arrayOfText(value: unknown, label: string): string[] {
  if (
    !Array.isArray(value)
    || value.length === 0
    || value.some((entry) => typeof entry !== 'string' || entry.trim().length === 0)
  ) {
    throw new TypeError(`${label} must be a non-empty text array`);
  }
  return value.map((entry) => entry.trim());
}

function arrayOfRecords(value: unknown, label: string): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  return value.map((entry, index) => record(entry, `${label}.${index}`));
}

function textField(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${label} must be non-empty text`);
  }
  return value.trim();
}

function knownText(value: unknown, allowed: readonly string[], label: string): string {
  const text = textField(value, label);
  if (!allowed.includes(text)) {
    throw new TypeError(`${label} must reference package-declared vocabulary`);
  }
  return text;
}

function numberOr(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function roundAtLeast(value: unknown, minimum: number, fallback: number): number {
  return Math.max(minimum, Math.round(numberOr(value, fallback)));
}

function openingPokerStreet(): PokerStreet {
  return POKER_RULES_STATE_MACHINE.streetFlow[0].street;
}

function pokerStreetFlow(street: PokerStreet): PokerStreetFlow {
  return POKER_RULES_STATE_MACHINE.streetFlow.find((flow) => flow.street === street)
    ?? POKER_RULES_STATE_MACHINE.streetFlow[0];
}

function maxVisiblePokerCommunityCards(): number {
  return Math.max(...POKER_RULES_STATE_MACHINE.streetFlow.map((flow) => flow.visibleCommunityCards));
}

export function normalizePokerTableConfig(input: Partial<PokerTableConfig> = {}): PokerTableConfig {
  const smallBlind = roundAtLeast(input.smallBlind, 1, 10);
  return {
    startingChips: roundAtLeast(input.startingChips, 100, 1000),
    smallBlind,
    bigBlind: Math.max(smallBlind, roundAtLeast(input.bigBlind, smallBlind, smallBlind * 2)),
    blindMode: input.blindMode === POKER_RULES_STATE_MACHINE.blindModes.multiplier
      ? POKER_RULES_STATE_MACHINE.blindModes.multiplier
      : POKER_RULES_STATE_MACHINE.blindModes.fixed,
    blindIncrease: Math.max(0, numberOr(input.blindIncrease, 0)),
    maxPlayers: roundAtLeast(input.maxPlayers, 2, 9),
  };
}

export function makePokerDeck(): PokerCard[] {
  return POKER_SUITS.flatMap((suit) =>
    POKER_RULES_VOCABULARY.ranks.map((rank) => ({
      rank: rank.label,
      suit,
      value: rank.value,
      code: `${rank.label}${suit}`,
    })),
  );
}

export function createPokerPlayers(names: readonly string[], startingChips: number): PokerPlayer[] {
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

export function isPlayerInHand(player: PokerPlayer): boolean {
  return !player.eliminated && player.chips > 0;
}

export function canPlayerAct(player: PokerPlayer): boolean {
  return isPlayerInHand(player) && !player.folded && !player.allIn;
}

export function activePokerPlayerCount(players: readonly PokerPlayer[]): number {
  return players.filter(isPlayerInHand).length;
}

export function nextPokerPlayerIndex(
  players: readonly PokerPlayer[],
  fromIndex: number,
  predicate: (player: PokerPlayer) => boolean = isPlayerInHand,
): number {
  if (!players.some(predicate)) return -1;

  for (let step = 1; step <= players.length; step += 1) {
    const candidate = (((fromIndex + step) % players.length) + players.length) % players.length;
    if (predicate(players[candidate])) return candidate;
  }

  return -1;
}

export function postBlind(player: PokerPlayer, blind: number): { player: PokerPlayer; paid: number } {
  const paid = Math.min(player.chips, Math.max(0, Math.round(blind)));
  const chips = player.chips - paid;
  return {
    paid,
    player: {
      ...player,
      chips,
      currentBet: player.currentBet + paid,
      totalCommitted: player.totalCommitted + paid,
      hasActed: false,
      allIn: chips === 0,
      eliminated: false,
    },
  };
}

export function createPokerLobbyHandState(
  players: readonly PokerPlayer[],
  configInput: Partial<PokerTableConfig> = {},
  handNumber = 0,
): PokerHandState {
  const config = normalizePokerTableConfig(configInput);
  const lobbyPlayers = players.slice(0, config.maxPlayers).map((player) => ({
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

  return {
    phase: POKER_RULES_STATE_MACHINE.phaseRoles.lobby,
    config,
    players: lobbyPlayers,
    communityCards: [],
    dealerIndex: -1,
    smallBlindIndex: -1,
    bigBlindIndex: -1,
    activeIndex: -1,
    pot: 0,
    pots: [],
    currentBet: 0,
    minRaise: config.bigBlind,
    street: openingPokerStreet(),
    handNumber,
    smallBlind: config.smallBlind,
    bigBlind: config.bigBlind,
    result: null,
  };
}

export function nextPokerBlinds(config: PokerTableConfig, smallBlind: number, bigBlind: number): Pick<PokerTableConfig, 'smallBlind' | 'bigBlind'> {
  if (config.blindMode === POKER_RULES_STATE_MACHINE.blindModes.multiplier) {
    const multiplier = Math.max(1, numberOr(config.blindIncrease, 1));
    return {
      smallBlind: Math.max(1, Math.round(smallBlind * multiplier)),
      bigBlind: Math.max(1, Math.round(bigBlind * multiplier)),
    };
  }

  const increase = Math.max(0, Math.round(numberOr(config.blindIncrease, 0)));
  return {
    smallBlind: smallBlind + increase,
    bigBlind: bigBlind + increase * 2,
  };
}

export function createPokerHandState(
  players: readonly PokerPlayer[],
  configInput: Partial<PokerTableConfig> = {},
  previousDealerIndex = -1,
  handNumber = 1,
): PokerHandState {
  const config = normalizePokerTableConfig(configInput);
  const handPlayers = players.map((player) => ({
    ...player,
    currentBet: 0,
    totalCommitted: 0,
    hasActed: false,
    folded: false,
    allIn: false,
    eliminated: player.eliminated || player.chips <= 0,
  }));

  if (activePokerPlayerCount(handPlayers) < 2) {
    return {
      phase: POKER_RULES_STATE_MACHINE.phaseRoles.finished,
      config,
      players: handPlayers,
      communityCards: [],
      dealerIndex: -1,
      smallBlindIndex: -1,
      bigBlindIndex: -1,
      activeIndex: -1,
      pot: 0,
      pots: [],
      currentBet: 0,
      minRaise: config.bigBlind,
      street: openingPokerStreet(),
      handNumber,
      smallBlind: config.smallBlind,
      bigBlind: config.bigBlind,
      result: null,
    };
  }

  const dealerIndex = nextPokerPlayerIndex(handPlayers, previousDealerIndex);
  const headsUp = activePokerPlayerCount(handPlayers) === 2;
  const smallBlindIndex = headsUp ? dealerIndex : nextPokerPlayerIndex(handPlayers, dealerIndex);
  const bigBlindIndex = nextPokerPlayerIndex(handPlayers, smallBlindIndex);
  const activeIndex = headsUp ? smallBlindIndex : nextPokerPlayerIndex(handPlayers, bigBlindIndex);
  let pot = 0;

  const small = postBlind(handPlayers[smallBlindIndex], config.smallBlind);
  handPlayers[smallBlindIndex] = small.player;
  pot += small.paid;

  const big = postBlind(handPlayers[bigBlindIndex], config.bigBlind);
  handPlayers[bigBlindIndex] = big.player;
  pot += big.paid;

  return {
    phase: POKER_RULES_STATE_MACHINE.phaseRoles.active,
    config,
    players: handPlayers,
    communityCards: [],
    dealerIndex,
    smallBlindIndex,
    bigBlindIndex,
    activeIndex,
    pot,
    pots: [{ amount: pot, eligibleIds: handPlayers.filter(isPlayerInHand).map((player) => player.id) }],
    currentBet: config.bigBlind,
    minRaise: config.bigBlind,
    street: openingPokerStreet(),
    handNumber,
    smallBlind: config.smallBlind,
    bigBlind: config.bigBlind,
    result: null,
  };
}

export function applyPokerPlayerAction(
  state: PokerHandState,
  playerId: string,
  action: PlayerAction,
  amount = 0,
): PokerActionResult {
  const actions = POKER_RULES_STATE_MACHINE.playerActionRoles;
  const events = POKER_RULES_STATE_MACHINE.eventRoles;
  const playerIndex = state.players.findIndex((player) => player.id === playerId);
  const actor = state.players[playerIndex];
  if (playerIndex !== state.activeIndex || !actor || !canPlayerAct(actor) || !POKER_PLAYER_ACTIONS.includes(action)) {
    return { state, event: { kind: events.warning, actorId: playerId, text: 'Action rejected by poker-rules.' } };
  }

  const players = state.players.slice();
  let potDelta = 0;
  let currentBet = state.currentBet;
  let minRaise = state.minRaise;
  let event: PokerActionResult['event'];

  if (action === actions.fold) {
    players[playerIndex] = { ...actor, folded: true, hasActed: true };
    event = { kind: events.fold, actorId: actor.id, text: `${actor.name} folded.` };
  } else if (action === actions.checkCall) {
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
    event = { kind: needed === 0 ? events.check : events.call, actorId: actor.id, text: needed === 0 ? `${actor.name} checked.` : `${actor.name} called ${paid}.` };
  } else {
    const targetBet = action === actions.raise
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
        if (index !== playerIndex && canPlayerAct(players[index])) {
          players[index] = { ...players[index], hasActed: false };
        }
      }
    }
    event = { kind: action === actions.allIn ? events.allIn : events.raise, actorId: actor.id, text: action === actions.allIn ? `${actor.name} moved all-in for ${paid}.` : `${actor.name} raised ${paid}.` };
  }

  const activeIndex = nextPokerPlayerIndex(players, state.activeIndex, canPlayerAct);
  return {
    event,
    state: {
      ...state,
      players,
      activeIndex,
      pot: state.pot + potDelta,
      currentBet,
      minRaise,
      pots: [{ amount: state.pot + potDelta, eligibleIds: showdownContenders(players).map((player) => player.id) }],
    },
  };
}

export function shufflePokerDeck(random: () => number = Math.random): PokerCard[] {
  const deck = makePokerDeck();
  for (let index = deck.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [deck[index], deck[swapIndex]] = [deck[swapIndex], deck[index]];
  }
  return deck;
}

export function visiblePokerCommunityCards(state: PokerHandState, board: readonly PokerCard[]): PokerCard[] {
  const phases = POKER_RULES_STATE_MACHINE.phaseRoles;
  if (state.phase === phases.showdown || state.phase === phases.finished) {
    return board.slice(0, maxVisiblePokerCommunityCards());
  }
  return board.slice(0, pokerStreetFlow(state.street).visibleCommunityCards);
}

type PokerHandScore = readonly number[];

function comparePokerHandScores(left: PokerHandScore, right: PokerHandScore): number {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const delta = (left[index] ?? 0) - (right[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

function straightHighCard(values: readonly number[]): number {
  const distinct = [...new Set(values)].sort((left, right) => right - left);
  const ranks = distinct.includes(14) ? [...distinct, 1] : distinct;
  for (let index = 0; index <= ranks.length - 5; index += 1) {
    const sequence = ranks.slice(index, index + 5);
    if (sequence.every((value, sequenceIndex) => sequenceIndex === 0 || value === sequence[sequenceIndex - 1] - 1)) {
      return sequence[0];
    }
  }
  return 0;
}

function rankFivePokerCards(cards: readonly PokerCard[]): PokerHandScore {
  const values = cards.map((card) => card.value).sort((left, right) => right - left);
  const counts = new Map<number, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);

  const groups = [...counts.entries()].sort((left, right) => right[1] - left[1] || right[0] - left[0]);
  const flush = new Set(cards.map((card) => card.suit)).size === 1;
  const straight = straightHighCard(values);
  const singles = groups.filter((group) => group[1] === 1).map((group) => group[0]).sort((left, right) => right - left);
  const pairs = groups.filter((group) => group[1] === 2).map((group) => group[0]).sort((left, right) => right - left);

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

function bestPokerHandScore(cards: readonly PokerCard[]): PokerHandScore | null {
  if (cards.length < 5) return null;
  let best: PokerHandScore | null = null;

  for (let first = 0; first < cards.length - 4; first += 1) {
    for (let second = first + 1; second < cards.length - 3; second += 1) {
      for (let third = second + 1; third < cards.length - 2; third += 1) {
        for (let fourth = third + 1; fourth < cards.length - 1; fourth += 1) {
          for (let fifth = fourth + 1; fifth < cards.length; fifth += 1) {
            const score = rankFivePokerCards([cards[first], cards[second], cards[third], cards[fourth], cards[fifth]]);
            if (!best || comparePokerHandScores(score, best) > 0) best = score;
          }
        }
      }
    }
  }

  return best;
}

function showdownContenders(players: readonly PokerPlayer[]): PokerPlayer[] {
  return players.filter((player) => !player.folded && !player.eliminated);
}

function settlePokerRoomShowdown(room: PokerRoomState): PokerRoomState {
  if (room.state.result) return room;
  const scored = showdownContenders(room.state.players)
    .map((player) => {
      const score = bestPokerHandScore([...(room.holeCards[player.id] ?? []), ...room.board]);
      return score ? { player, score } : null;
    })
    .filter((entry): entry is { player: PokerPlayer; score: PokerHandScore } => Boolean(entry));

  if (scored.length === 0) return room;

  let winners = [scored[0]];
  for (const entry of scored.slice(1)) {
    const comparison = comparePokerHandScores(entry.score, winners[0].score);
    if (comparison > 0) winners = [entry];
    if (comparison === 0) winners.push(entry);
  }

  const winnerIds = winners.map((entry) => entry.player.id);
  const winnerSet = new Set(winnerIds);
  const wonPot = room.state.pot;
  const share = Math.floor(wonPot / winnerIds.length);
  let remainder = wonPot % winnerIds.length;
  const gains = new Map<string, number>();
  for (const player of room.state.players) {
    if (!winnerSet.has(player.id)) continue;
    gains.set(player.id, share + (remainder > 0 ? 1 : 0));
    remainder = Math.max(0, remainder - 1);
  }

  const players = room.state.players.map((player) => {
    const chips = player.chips + (gains.get(player.id) ?? 0);
    return {
      ...player,
      chips,
      currentBet: 0,
      totalCommitted: 0,
      hasActed: false,
      folded: false,
      allIn: false,
      eliminated: player.eliminated || chips <= 0,
    };
  });
  const finishedState: PokerHandState = {
    ...room.state,
    players,
    phase: POKER_RULES_STATE_MACHINE.phaseRoles.finished,
    activeIndex: -1,
    pot: 0,
    pots: [],
    currentBet: 0,
    minRaise: room.state.bigBlind,
    result: {
      source: 'showdown',
      winnerIds,
      pot: wonPot,
      handNumber: room.state.handNumber,
    },
  };

  return {
    ...room,
    state: { ...finishedState, communityCards: visiblePokerCommunityCards(finishedState, room.board) },
  };
}

function dealPokerCards(players: readonly PokerPlayer[], random: () => number): { board: PokerCard[]; holeCards: Record<string, PokerCard[]> } {
  const deck = shufflePokerDeck(random);
  const holeCards: Record<string, PokerCard[]> = {};
  let cursor = 0;

  players.forEach((player) => {
    holeCards[player.id] = [deck[cursor], deck[cursor + 1]].filter(Boolean);
    cursor += 2;
  });

  return {
    board: deck.slice(cursor, cursor + 5),
    holeCards,
  };
}

export function createPokerLobbyRoomState(input: {
  roomId: string;
  players: readonly PokerPlayer[];
  config: Partial<PokerTableConfig>;
  hostPlayerId: string;
}): PokerRoomState {
  const config = normalizePokerTableConfig(input.config);
  const state = createPokerLobbyHandState(input.players, config);
  return {
    kind: 'poker-room-state',
    version: 1,
    roomId: input.roomId,
    board: [],
    config,
    handNumber: 0,
    holeCards: {},
    hostPlayerId: input.hostPlayerId,
    state,
  };
}

export function createPokerRoomState(input: {
  roomId: string;
  players: readonly PokerPlayer[];
  config: Partial<PokerTableConfig>;
  previousDealerIndex?: number;
  handNumber?: number;
  hostPlayerId: string;
  random?: () => number;
}): PokerRoomState {
  const config = normalizePokerTableConfig(input.config);
  const state = createPokerHandState(
    input.players,
    config,
    input.previousDealerIndex ?? -1,
    input.handNumber ?? 1,
  );
  const deal = dealPokerCards(state.players, input.random ?? Math.random);
  return {
    kind: 'poker-room-state',
    version: 1,
    roomId: input.roomId,
    board: deal.board,
    config,
    handNumber: state.handNumber,
    holeCards: deal.holeCards,
    hostPlayerId: input.hostPlayerId,
    state: { ...state, communityCards: visiblePokerCommunityCards(state, deal.board) },
  };
}

function resetStreetBets(players: readonly PokerPlayer[]): PokerPlayer[] {
  return players.map((player) => ({ ...player, currentBet: 0, hasActed: false }));
}

export function nextPokerStreetLabel(state: PokerHandState): string {
  return pokerStreetFlow(state.street).advanceLabel;
}

export function advancePokerRoomStreet(room: PokerRoomState): PokerRoomState {
  const current = room.state;
  const players = resetStreetBets(current.players);
  const flow = pokerStreetFlow(current.street);
  const activeIndex = flow.nextPhase === POKER_RULES_STATE_MACHINE.phaseRoles.showdown
    ? -1
    : nextPokerPlayerIndex(players, current.dealerIndex, canPlayerAct);
  const state: PokerHandState = {
    ...current,
    players,
    phase: flow.nextPhase,
    street: flow.nextStreet,
    activeIndex,
    currentBet: 0,
    minRaise: current.bigBlind,
    result: null,
  };

  const advancedRoom = {
    ...room,
    state: { ...state, communityCards: visiblePokerCommunityCards(state, room.board) },
  };
  return state.phase === POKER_RULES_STATE_MACHINE.phaseRoles.showdown
    ? settlePokerRoomShowdown(advancedRoom)
    : advancedRoom;
}

export function startPokerRoomGame(room: PokerRoomState, random: () => number = Math.random): PokerRoomState {
  const activePlayers = room.state.players
    .filter((player) => player.connected && !player.eliminated)
    .map((player) => ({
      ...player,
      chips: Math.max(0, Math.round(player.chips || room.config.startingChips)),
    }));

  return createPokerRoomState({
    roomId: room.roomId,
    players: activePlayers,
    config: room.config,
    previousDealerIndex: -1,
    handNumber: Math.max(1, room.handNumber || 1),
    hostPlayerId: activePlayers.some((player) => player.id === room.hostPlayerId)
      ? room.hostPlayerId
      : activePlayers[0]?.id ?? room.hostPlayerId,
    random,
  });
}

export function configurePokerRoom(room: PokerRoomState, configInput: Partial<PokerTableConfig>): PokerRoomState {
  const config = normalizePokerTableConfig({ ...room.config, ...configInput });
  if (room.state.phase !== POKER_RULES_STATE_MACHINE.phaseRoles.lobby) {
    return { ...room, config, state: { ...room.state, config } };
  }
  return {
    ...room,
    config,
    state: createPokerLobbyHandState(room.state.players, config, room.handNumber),
  };
}

function nextPokerPlayerId(players: readonly PokerPlayer[]): string {
  const highest = players.reduce((max, player) => {
    const match = /^player-(\d+)$/.exec(player.id);
    return Math.max(max, match ? Number(match[1]) : 0);
  }, 0);
  return `player-${highest + 1}`;
}

export function upsertPokerRoomPlayer(
  room: PokerRoomState,
  input: { playerId?: string | null; name: string },
): { room: PokerRoomState; playerId: string } {
  const name = input.name.trim();
  if (!name) return { room, playerId: input.playerId ?? '' };

  const players = room.state.players.slice();
  const existingIndex = input.playerId
    ? players.findIndex((player) => player.id === input.playerId)
    : players.findIndex((player) => player.name.trim().toLowerCase() === name.toLowerCase());

  if (existingIndex >= 0) {
    const existing = players[existingIndex];
    players[existingIndex] = { ...existing, name, connected: true };
    const nextRoom = room.state.phase === POKER_RULES_STATE_MACHINE.phaseRoles.lobby
      ? createPokerLobbyRoomState({ roomId: room.roomId, players, config: room.config, hostPlayerId: room.hostPlayerId })
      : { ...room, state: { ...room.state, players } };
    return { room: nextRoom, playerId: existing.id };
  }

  if (room.state.phase !== POKER_RULES_STATE_MACHINE.phaseRoles.lobby || players.length >= room.config.maxPlayers) {
    return { room, playerId: input.playerId ?? '' };
  }

  const playerId = nextPokerPlayerId(players);
  const nextPlayer: PokerPlayer = {
    id: playerId,
    name,
    chips: room.config.startingChips,
    currentBet: 0,
    totalCommitted: 0,
    hasActed: false,
    folded: false,
    allIn: false,
    eliminated: false,
    connected: true,
  };
  const nextPlayers = [...players, nextPlayer];
  return {
    playerId,
    room: createPokerLobbyRoomState({
      roomId: room.roomId,
      players: nextPlayers,
      config: room.config,
      hostPlayerId: room.hostPlayerId || playerId,
    }),
  };
}

export function finishPokerRoomIfSingleContender(room: PokerRoomState): PokerRoomState {
  const contenders = room.state.players.filter((player) => !player.folded && !player.eliminated);
  if (contenders.length !== 1 || room.state.phase !== POKER_RULES_STATE_MACHINE.phaseRoles.active) return room;

  const winnerId = contenders[0].id;
  const wonPot = room.state.pot;
  const players = room.state.players.map((player) => ({
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
      phase: POKER_RULES_STATE_MACHINE.phaseRoles.finished,
      pot: 0,
      pots: [],
      result: {
        source: 'last-standing',
        winnerIds: [winnerId],
        pot: wonPot,
        handNumber: room.state.handNumber,
      },
      communityCards: visiblePokerCommunityCards({ ...room.state, phase: POKER_RULES_STATE_MACHINE.phaseRoles.finished }, room.board),
    },
  };
}

export function isPokerBettingRoundComplete(state: PokerHandState): boolean {
  if (state.phase !== POKER_RULES_STATE_MACHINE.phaseRoles.active) return false;
  const actors = state.players.filter(canPlayerAct);
  if (state.currentBet === 0 && showdownContenders(state.players).length > 1 && actors.length <= 1) return true;
  if (actors.length === 0) return true;
  return actors.every((player) => player.hasActed && player.currentBet === state.currentBet);
}

function completePokerRoomAfterAction(room: PokerRoomState): PokerRoomState {
  let nextRoom = finishPokerRoomIfSingleContender(room);
  while (isPokerBettingRoundComplete(nextRoom.state)) {
    const advancedRoom = advancePokerRoomStreet(nextRoom);
    if (advancedRoom.state.phase !== POKER_RULES_STATE_MACHINE.phaseRoles.active) return advancedRoom;
    nextRoom = advancedRoom;
  }
  return nextRoom;
}

export function applyPokerRoomPlayerAction(room: PokerRoomState, action: PlayerAction, amount?: number): PokerRoomState {
  const actor = room.state.players[room.state.activeIndex];
  if (!actor) return room;
  const result = applyPokerPlayerAction(room.state, actor.id, action, amount ?? room.state.minRaise);
  return completePokerRoomAfterAction({
    ...room,
    state: { ...result.state, communityCards: visiblePokerCommunityCards(result.state, room.board) },
  });
}

export function nextPokerRoomHand(room: PokerRoomState): PokerRoomState {
  const nextBlinds = nextPokerBlinds(room.config, room.state.smallBlind, room.state.bigBlind);
  const players = room.state.players.filter((player) => !player.eliminated && player.chips > 0);
  return createPokerRoomState({
    roomId: room.roomId,
    players,
    config: { ...room.config, ...nextBlinds },
    previousDealerIndex: room.state.dealerIndex,
    handNumber: room.handNumber + 1,
    hostPlayerId: room.hostPlayerId,
  });
}

export function kickPokerRoomPlayer(room: PokerRoomState, playerId: string): PokerRoomState {
  const players = room.state.players.filter((player) => player.id !== playerId);
  const hostPlayerId = room.hostPlayerId === playerId ? players[0]?.id ?? '' : room.hostPlayerId;
  if (room.state.phase === POKER_RULES_STATE_MACHINE.phaseRoles.lobby) {
    return createPokerLobbyRoomState({
      roomId: room.roomId,
      players,
      config: room.config,
      hostPlayerId,
    });
  }
  if (players.length < 2) {
    return {
      ...room,
      hostPlayerId,
      state: { ...room.state, players, phase: POKER_RULES_STATE_MACHINE.phaseRoles.finished, activeIndex: -1 },
    };
  }
  return createPokerRoomState({
    roomId: room.roomId,
    players,
    config: room.config,
    previousDealerIndex: -1,
    handNumber: room.handNumber + 1,
    hostPlayerId,
  });
}

export function projectPokerRoomForPlayer(room: PokerRoomState, currentPlayerId: string | null): PokerRoomProjection {
  const activePlayer = room.state.players[room.state.activeIndex]
    ?? room.state.players.find((player) => player.id === currentPlayerId)
    ?? room.state.players.find((player) => player.id === room.hostPlayerId)
    ?? room.state.players[0];
  const privateOwnerId = currentPlayerId ?? activePlayer?.id ?? null;
  const phases = POKER_RULES_STATE_MACHINE.phaseRoles;
  const revealAll = room.state.phase === phases.showdown || room.state.phase === phases.finished;
  const publicHoleCards = revealAll
    ? Object.fromEntries(room.state.players.map((player) => [player.id, room.holeCards[player.id] ?? []]))
    : {};

  return {
    privateHand: {
      ownerId: privateOwnerId,
      cards: privateOwnerId ? room.holeCards[privateOwnerId] ?? [] : [],
      hidden: true,
      canToggle: Boolean(privateOwnerId),
    },
    publicHoleCards,
    revealedPlayerIds: revealAll ? room.state.players.map((player) => player.id) : [],
  };
}
