// tools/poker/do-work/view-a-poker-table.mjs
//
// The command of tool:view-a-poker-table-for-a-player. One JSON request on standard input:
//   { room: <the saved table>, player_id?: "player-2" }
// and the table as that one player may see it: the board, the pot, every seat's chips and standing, what the player may
// do now, the player's own cards, and everyone's cards only once the hand is over. A request with no player_id is a
// spectator's view: no private cards.
import { runAsMain } from '../read-data/run-as-main.mjs';
import { deriveControls, deriveHandResult, nextStreetLabel, projectRoomForPlayer, readRoom, seatRoles } from '../read-data/poker-rules.mjs';

export function viewTable(input) {
  const room = readRoom(input?.room);
  const playerId = typeof input.player_id === 'string' ? input.player_id : null;
  if (playerId && !room.state.players.some(player => player.id === playerId)) throw new Error(`${playerId} is not at this table.`);
  const { state } = room;
  const projection = projectRoomForPlayer(room, playerId);
  const roles = seatRoles(state);
  return {
    roomId: room.roomId,
    phase: state.phase,
    street: state.street,
    handNumber: state.handNumber,
    pot: state.pot,
    currentBet: state.currentBet,
    minRaise: state.minRaise,
    smallBlind: state.smallBlind,
    bigBlind: state.bigBlind,
    communityCards: state.communityCards,
    nextStreetLabel: nextStreetLabel(state),
    seats: state.players.map((player, index) => ({
      id: player.id,
      name: player.name,
      chips: player.chips,
      currentBet: player.currentBet,
      roles: roles[player.id],
      isActive: index === state.activeIndex,
      folded: player.folded,
      allIn: player.allIn,
      eliminated: player.eliminated,
      connected: player.connected,
    })),
    controls: deriveControls(state, playerId),
    privateHand: playerId ? projection.privateHand : { ownerId: null, cards: [] },
    publicHoleCards: projection.publicHoleCards,
    revealedPlayerIds: projection.revealedPlayerIds,
    handResult: deriveHandResult(state),
  };
}

await runAsMain(import.meta.url, viewTable);
