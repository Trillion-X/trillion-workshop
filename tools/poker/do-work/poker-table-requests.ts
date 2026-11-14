
import { buildPokerRuleWorkflowRequest, type PokerRuleRequest } from '@/packages/poker-rules/do-work/poker-rule-requests';
import {
  buildRoomDescriptorWrites,
  buildRoomStateCommitWrites,
  buildEngineWriteBatchRequestFromLabels,
  ENGINE_OPERATION_TARGET,
  type EngineOperationTargetRequest,
  type EngineWriteLabelEntry,
} from '@bitfield/runtime-kit/protocol';
import type { PokerRoomState } from '@/packages/poker-rules/read-data/poker-rules';
import {
  createPokerTablePrivateHandStates,
  createPokerTableRoomDescriptor,
  createPokerTableSurfaceState,
  POKER_TABLE_ROOM_LIST_ADDRESS,
  removePokerTableRoomListEntry,
  pokerTableAuthorityAddress,
  type PokerTableRoomListState,
  upsertPokerTableRoomListEntry,
} from '../read-data/poker-table.ts';

export type PokerRoomSyncRequest =
  | { operation: 'join-room'; roomId: string; participantId: string; displayName: string; transportProviderRef?: string }
  | { operation: 'leave-room'; roomId: string; participantId: string }
  | { operation: 'publish-local-delta'; roomId: string; participantId: string; syncCursor: number; deltaRef: string }
  | { operation: 'ingest-remote-delta'; roomId: string; participantId: string; syncCursor: number; deltaRef: string }
  | { operation: 'invite-participant'; roomId: string; participantId: string }
  | { operation: 'kick-participant'; roomId: string; hostParticipantId: string; participantId: string };

export type PokerTableRoomSyncWorkflowRequest = EngineOperationTargetRequest;

export interface PokerTableStateWriteRecord {
  addressLabel: string;
  pathLabels?: string[];
  payload?: unknown;
}

export function buildPokerTableControlRequest(input: PokerRuleRequest) {
  return buildPokerRuleWorkflowRequest(input);
}

export function buildPokerTableEngineWriteRequest(
  writes: PokerTableStateWriteRecord[],
  partitionLabel: string,
): PokerTableRoomSyncWorkflowRequest {
  return buildEngineWriteBatchRequestFromLabels(writes.map((write): EngineWriteLabelEntry => ({
    partitionLabel,
    addressLabel: write.addressLabel,
    pathLabels: write.pathLabels,
    payload: write.payload,
  })));
}

export function buildPokerTableRoomStateCommitLabelWrites(
  room: PokerRoomState,
  partitionLabel: string,
  currentPlayerId: string | null = null,
  roomList: PokerTableRoomListState | null = null,
): EngineWriteLabelEntry[] {
  const descriptor = createPokerTableRoomDescriptor(room.roomId, partitionLabel, {
    roomId: room.roomId,
    localParticipantId: currentPlayerId,
  });
  return [
    ...buildRoomDescriptorWrites(descriptor),
    ...buildRoomStateCommitWrites({
      descriptor,
      publicProjection: createPokerTableSurfaceState(room, currentPlayerId, {
        roomId: room.roomId,
        localParticipantId: currentPlayerId,
      }),
      membership: room.state.players.map((player) => ({
        participant: { id: player.id },
        displayName: player.name,
        host: player.id === room.hostPlayerId,
        connected: player.connected,
      })),
      privateProjections: Object.values(createPokerTablePrivateHandStates(room, partitionLabel)),
    }),
    {
      partitionLabel: descriptor.partitionLabel,
      addressLabel: pokerTableAuthorityAddress(room.roomId, partitionLabel),
      pathLabels: ['poker-table', 'authority-state'],
      payload: room,
    },
    {
      partitionLabel: descriptor.partitionLabel,
      addressLabel: POKER_TABLE_ROOM_LIST_ADDRESS,
      pathLabels: ['poker-table', 'room-list'],
      payload: upsertPokerTableRoomListEntry(roomList, room),
    },
  ];
}

export function buildPokerTableRoomStateCommitRequest(
  room: PokerRoomState,
  partitionLabel: string,
  currentPlayerId: string | null = null,
  roomList: PokerTableRoomListState | null = null,
): PokerTableRoomSyncWorkflowRequest {
  return buildEngineWriteBatchRequestFromLabels(
    buildPokerTableRoomStateCommitLabelWrites(room, partitionLabel, currentPlayerId, roomList),
  );
}

export function buildPokerTableRoomStateResetLabelWrites(
  room: PokerRoomState,
  partitionLabel: string,
  roomList: PokerTableRoomListState | null = null,
): EngineWriteLabelEntry[] {
  const descriptor = createPokerTableRoomDescriptor(room.roomId, partitionLabel);
  const privateHandRetractions = Object.keys(createPokerTablePrivateHandStates(room, partitionLabel)).map((addressLabel): EngineWriteLabelEntry => ({
    partitionLabel: descriptor.partitionLabel,
    addressLabel,
  }));
  return [
    {
      partitionLabel: descriptor.partitionLabel,
      addressLabel: descriptor.publicProjectionAddressLabel,
    },
    {
      partitionLabel: descriptor.partitionLabel,
      addressLabel: pokerTableAuthorityAddress(room.roomId, partitionLabel),
    },
    ...privateHandRetractions,
    ...(roomList ? [{
      partitionLabel: descriptor.partitionLabel,
      addressLabel: POKER_TABLE_ROOM_LIST_ADDRESS,
      pathLabels: ['poker-table', 'room-list'],
      payload: removePokerTableRoomListEntry(roomList, room.roomId),
    }] : []),
  ];
}

export function buildPokerTableRoomStateResetRequest(
  room: PokerRoomState,
  partitionLabel: string,
  roomList: PokerTableRoomListState | null = null,
): PokerTableRoomSyncWorkflowRequest {
  return buildEngineWriteBatchRequestFromLabels(buildPokerTableRoomStateResetLabelWrites(room, partitionLabel, roomList));
}

export function buildPokerTableRoomSyncRequest(
  input: PokerRoomSyncRequest,
  partitionLabel: string,
): PokerTableRoomSyncWorkflowRequest {
  return buildPokerTableEngineWriteRequest([
    {
      addressLabel: `poker-table.room-sync.${input.roomId}.${input.operation}`,
      pathLabels: ['poker-table', 'room-sync', input.operation],
      payload: input,
    },
  ], partitionLabel);
}
