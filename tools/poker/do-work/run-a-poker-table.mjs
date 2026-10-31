// tools/poker/do-work/run-a-poker-table.mjs
//
// The command of tool:run-a-poker-table. The person's AI keeps the table's saved state (the `room`); each request names
// one thing to do to it and the command answers with the next state, so a table can be run turn by turn from any place.
//   { operation: "open-table", room_id, players: [names], config? }       -> the table with its first seats, in the lobby
//   { operation: "seat-player", room, name, player_id? }                  -> a new or returning player seated (lobby only for a new one)
//   { operation: "configure-table", room, config }                        -> the table's settings changed
//   { operation: "start-game", room, seed }                               -> blinds posted and cards dealt
//   { operation: "player-action", room, action, amount?, player_id? }     -> the seat to act folds, checks or calls, raises or goes all in
//   { operation: "next-hand", room, seed }                                -> the dealer moves, blinds may rise, a new hand is dealt
//   { operation: "kick-player", room, player_id, seed? }                  -> the player removed; a hand in play is dealt again (seed then required)
// The seed is a whole number: the same table and seed always deal the same cards.
import { runAsMain } from '../read-data/run-as-main.mjs';
import {
  PLAYER_ACTIONS, RULES, activePlayerCount, applyRoomPlayerAction, configureRoom, createLobbyRoom, createPlayers, kickRoomPlayer,
  nextRoomHand, normalizeTableConfig, readRoom, seededRandom, startRoomGame, upsertRoomPlayer,
} from '../read-data/poker-rules.mjs';

const PHASE = RULES.phases;

function randomFrom(seed) {
  if (seed === undefined) return () => { throw new Error('This deals cards: give a seed (any whole number); the same seed deals the same cards.'); };
  return seededRandom(seed);
}

function requirePhase(room, phase, doing) {
  if (room.state.phase !== phase) throw new Error(`The table is in phase "${room.state.phase}"; ${doing} needs phase "${phase}".`);
}

function openTable(input) {
  if (typeof input.room_id !== 'string' || !input.room_id) throw new Error('room_id must be the table\'s name, as text.');
  if (!Array.isArray(input.players) || input.players.some(name => typeof name !== 'string')) throw new Error('players must be a list of names, as text.');
  const config = normalizeTableConfig(input.config);
  const players = createPlayers(input.players, config.startingChips);
  return { room: createLobbyRoom({ roomId: input.room_id, players, config, hostPlayerId: players[0]?.id ?? '' }) };
}

const operations = {
  'open-table': openTable,
  'seat-player': input => {
    if (typeof input.name !== 'string' || !input.name.trim()) throw new Error('name must be the player\'s name, as text.');
    const seated = upsertRoomPlayer(readRoom(input.room), { playerId: input.player_id, name: input.name });
    if (!seated.playerId) throw new Error('Nobody was seated: a new player can only join while the table is in the lobby, and only while it has a free seat.');
    return { room: seated.room, playerId: seated.playerId };
  },
  'configure-table': input => ({ room: configureRoom(readRoom(input.room), input.config ?? {}) }),
  'start-game': input => {
    const room = readRoom(input.room);
    requirePhase(room, PHASE.lobby, 'starting the game');
    if (activePlayerCount(room.state.players.filter(player => player.connected)) < 2) throw new Error('Seat at least two connected players before starting the game.');
    return { room: startRoomGame(room, randomFrom(input.seed)) };
  },
  'player-action': input => {
    const room = readRoom(input.room);
    requirePhase(room, PHASE.active, 'a player action');
    if (!PLAYER_ACTIONS.includes(input.action)) throw new Error(`action must be one of ${PLAYER_ACTIONS.join(', ')}.`);
    const toAct = room.state.players[room.state.activeIndex];
    if (input.player_id !== undefined && input.player_id !== toAct?.id) {
      throw new Error(`It is not ${input.player_id}'s turn: the seat to act is ${toAct?.id ?? 'nobody'}.`);
    }
    return applyRoomPlayerAction(room, input.action, input.amount);
  },
  'next-hand': input => {
    const room = readRoom(input.room);
    requirePhase(room, PHASE.finished, 'dealing the next hand');
    return { room: nextRoomHand(room, randomFrom(input.seed)) };
  },
  'kick-player': input => {
    const room = readRoom(input.room);
    if (!room.state.players.some(player => player.id === input.player_id)) throw new Error(`${input.player_id} is not at this table.`);
    return { room: kickRoomPlayer(room, input.player_id, randomFrom(input.seed)) };
  },
};

export function runTable(input) {
  const run = operations[input?.operation];
  if (!run) throw new Error(`operation must be one of ${Object.keys(operations).join(', ')}.`);
  return { operation: input.operation, ...run(input) };
}

await runAsMain(import.meta.url, runTable);
