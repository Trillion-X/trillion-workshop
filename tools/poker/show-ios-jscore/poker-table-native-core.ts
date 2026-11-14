// Purpose: bundle canonical poker-table and poker-rules helpers for native JSCore.
// Invariants: this file exposes package-owned pure helpers only; platform code
// stays a generic JSCore source loader and target invoker.

import {
  applyPokerRoomPlayerAction,
  configurePokerRoom,
  createPokerLobbyRoomState,
  createPokerPlayers,
  kickPokerRoomPlayer,
  nextPokerRoomHand,
  normalizePokerTableConfig,
  POKER_RULES_STATE_MACHINE,
  startPokerRoomGame,
  upsertPokerRoomPlayer,
  type PlayerAction,
  type PokerRoomState,
  type PokerTableConfig,
} from '@/packages/poker-rules/read-data/poker-rules';
import {
  buildPokerTableRoomStateCommitLabelWrites,
  buildPokerTableRoomStateResetLabelWrites,
} from '../do-work/poker-table-requests.ts';
// The partition this surface was built into, stamped by the generator. Never a
// literal: a constant in package source names one app for every set that installs it.
import { bitfieldGeneratedLiveReadScopeDescriptor } from '@/packages/poker-table/.bitfield-entry-scope/poker-table-native-core/runtime-kit-react';
import { pokerTableAuthorityAddress } from '../read-data/poker-table.ts';
import type { EngineWriteLabelEntry } from '@bitfield/runtime-kit/protocol';

const ENGINE_OPERATION_LABEL_TARGET = 'engine.operation.label-addressed';
const WRITE_BATCH_OPERATION = 'engine.operation.write-batch';

function cleanName(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback;
}

function cleanRoomId(value: unknown): string {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : `poker-room:native-${Date.now().toString(36)}`;
}

function createLobby(input: {
  roomId?: unknown;
  hostName?: unknown;
  config?: Partial<PokerTableConfig>;
}): PokerRoomState {
  const config = normalizePokerTableConfig(input.config ?? {});
  const players = createPokerPlayers([cleanName(input.hostName, 'Host')], config.startingChips);
  return createPokerLobbyRoomState({
    roomId: cleanRoomId(input.roomId),
    players,
    config,
    hostPlayerId: players[0]?.id ?? 'player-1',
  });
}

function labelWrite(write: EngineWriteLabelEntry) {
  return {
    partition_label: write.partitionLabel,
    address_label: write.addressLabel,
    path_labels: write.pathLabels,
    payload: write.payload,
  };
}

function writeBatchRequest(writes: readonly EngineWriteLabelEntry[]) {
  return {
    target: ENGINE_OPERATION_LABEL_TARGET,
    payload: {
      operation_label: WRITE_BATCH_OPERATION,
      writes: writes.map(labelWrite),
    },
  };
}

const partitionLabel = bitfieldGeneratedLiveReadScopeDescriptor.partitionLabel;

function commitRequest(room: PokerRoomState, currentPlayerId: string | null) {
  return writeBatchRequest(buildPokerTableRoomStateCommitLabelWrites(room, partitionLabel, currentPlayerId));
}

function resetRequest(room?: PokerRoomState | null) {
  return writeBatchRequest(buildPokerTableRoomStateResetLabelWrites(room, partitionLabel));
}

function applyPlayerAction(room: PokerRoomState, action: PlayerAction, amount?: number): PokerRoomState {
  return applyPokerRoomPlayerAction(room, action, amount ?? room.state.minRaise);
}

(globalThis as Record<string, unknown>).BitfieldPokerTableNative = {
  actions: POKER_RULES_STATE_MACHINE.playerActionRoles,
  authorityAddress: (roomId: string) => pokerTableAuthorityAddress(roomId, partitionLabel),
  commitRequest,
  configureRoom,
  createLobby,
  partitionLabel,
  kickPlayer: kickPokerRoomPlayer,
  nextHand: nextPokerRoomHand,
  playerAction: applyPlayerAction,
  resetRequest,
  startGame: startPokerRoomGame,
  upsertPlayer: upsertPokerRoomPlayer,
};
