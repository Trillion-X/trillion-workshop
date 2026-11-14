
import {
  createRoomProjectionAuthority,
  createRoomPrivateProjection,
  normalizeRoomDescriptor,
  readRoomPrivateProjectionForAuthority,
  roomPrivateProjectionAddressLabel,
  type RoomDescriptor,
  type RoomPrivacyLaneDescriptor,
  type RoomPrivateProjection,
  type RoomTransportRef,
} from '@bitfield/runtime-kit/protocol';
import {
  projectPokerRoomForPlayer,
  POKER_RULES_STATE_MACHINE,
  type PlayerAction,
  type PokerCard,
  type PokerHandState,
  type PokerPlayer,
  type PokerRoomState,
} from '@/packages/poker-rules/read-data/poker-rules';

export type PokerRoomSyncHealth = string;

export interface PokerRoomSyncInput {
  roomId?: string | null;
  localParticipantId?: string | null;
  providerPackage?: string | null;
  transportProviderRef?: string | null;
  transportLabel?: string | null;
  connectedPeerCount?: number | null;
  expectedPeerCount?: number | null;
  syncCursor?: number | null;
  lastSyncedAt?: string | null;
  canInvite?: boolean | null;
  blockers?: readonly string[] | null;
}

export interface PokerRoomSyncView {
  roomId: string | null;
  localParticipantId: string | null;
  providerPackage: string;
  transportProviderRef: string | null;
  transportLabel: string;
  connectedPeerCount: number;
  expectedPeerCount: number;
  syncCursor: number | null;
  lastSyncedAt: string | null;
  canInvite: boolean;
  health: PokerRoomSyncHealth;
  statusLabel: string;
  enginePrimitive: 'SyncMesh causal-log delta exchange';
  frameContract: 'CarrierFrame::DeltaBatch exact addressed bytes';
  blockers: string[];
}

export interface PokerPrivateHandView {
  ownerId: string | null;
  cards: PokerCard[];
  hidden: boolean;
  canToggle: boolean;
}

export interface PokerTableProjectionInput {
  sync?: PokerRoomSyncInput;
  privateHand?: Partial<PokerPrivateHandView> | null;
  publicHoleCards?: Record<string, readonly PokerCard[]>;
  revealedPlayerIds?: readonly string[];
}

export interface PokerTableSurfaceState {
  kind: 'poker-table-surface-state';
  version: 1;
  roomId: string;
  hostPlayerId: string;
  currentPlayerId: string | null;
  state: PokerHandState;
  projection: Pick<PokerTableProjectionInput, 'publicHoleCards' | 'revealedPlayerIds' | 'sync'>;
}

export interface PokerTablePrivateHandState {
  kind: 'poker-table-private-hand';
  version: 1;
  roomId: string;
  ownerId: string;
  cards: PokerCard[];
}

export interface PokerTableRoomListEntry {
  roomId: string;
  hostPlayerId: string;
  hostName: string;
  playerCount: number;
  maxPlayers: number;
  phase: PokerHandState['phase'];
  handNumber: number;
  smallBlind: number;
  bigBlind: number;
}

export interface PokerTableRoomListState {
  kind: 'poker-table-room-list';
  version: 1;
  rooms: PokerTableRoomListEntry[];
}

export const POKER_TABLE_ROOM_LIST_ADDRESS = 'poker-table.room-list';
export const POKER_TABLE_PRIVATE_HAND_READ_CAPABILITY = 'poker-table.private-hand.read';
export const POKER_TABLE_PRIVATE_HAND_LANE = Object.freeze({
  lane: 'private-hand',
  ownerPath: Object.freeze(['ownerId']),
  requiredCapabilities: Object.freeze([POKER_TABLE_PRIVATE_HAND_READ_CAPABILITY]),
}) satisfies RoomPrivacyLaneDescriptor;

export type PokerTablePrivateHandProjection = RoomPrivateProjection<PokerTablePrivateHandState>;

/**
 * The partition is STATED by the caller, never inferred here. Each surface reads it
 * from its own generated `bitfieldGeneratedLiveReadScopeDescriptor.partitionLabel`,
 * which the generator stamps with the set the surface was built into. A constant in
 * this module named one app for every set that installs the package.
 */
export function createPokerTableRoomDescriptor(
  roomId: string,
  partitionLabel: string,
  sync?: PokerRoomSyncInput,
): RoomDescriptor {
  const baseDescriptor = normalizeRoomDescriptor({ roomId, partitionLabel });
  const transport = textOrNull(sync?.transportProviderRef)
    ? {
      ref: textOrNull(sync?.transportProviderRef) ?? '',
      ...(textOrNull(sync?.transportLabel) ? { label: textOrNull(sync?.transportLabel) ?? '' } : {}),
    } satisfies RoomTransportRef
    : null;

  return normalizeRoomDescriptor({
    roomId,
    partitionLabel,
    transport,
    privacyLanes: [POKER_TABLE_PRIVATE_HAND_LANE],
    projections: [
      { name: 'public-table', addressLabel: baseDescriptor.publicProjectionAddressLabel },
      {
        name: 'private-hand',
        addressLabel: roomPrivateProjectionAddressLabel(
          baseDescriptor,
          POKER_TABLE_PRIVATE_HAND_LANE.lane,
          '{participant}',
        ),
        private: true,
        lane: POKER_TABLE_PRIVATE_HAND_LANE.lane,
        requiredCapabilities: [POKER_TABLE_PRIVATE_HAND_READ_CAPABILITY],
      },
    ],
  });
}

export function pokerTableSurfaceAddress(roomId: string, partitionLabel: string): string {
  return createPokerTableRoomDescriptor(roomId, partitionLabel).publicProjectionAddressLabel;
}

export function pokerTableAuthorityAddress(roomId: string, partitionLabel: string): string {
  return `${createPokerTableRoomDescriptor(roomId, partitionLabel).journalAddressLabel}.authority`;
}

export function pokerTablePrivateHandAddress(roomId: string, playerId: string, partitionLabel: string): string {
  return roomPrivateProjectionAddressLabel(
    createPokerTableRoomDescriptor(roomId, partitionLabel),
    POKER_TABLE_PRIVATE_HAND_LANE.lane,
    playerId,
  );
}

export function createPokerTableRoomListEntry(room: PokerRoomState): PokerTableRoomListEntry {
  const host = room.state.players.find((player) => player.id === room.hostPlayerId) ?? room.state.players[0];
  return {
    roomId: room.roomId,
    hostPlayerId: room.hostPlayerId,
    hostName: host?.name ?? 'Host',
    playerCount: room.state.players.filter((player) => player.connected && !player.isEliminated).length,
    maxPlayers: room.config.maxPlayers,
    phase: room.state.phase,
    handNumber: room.handNumber,
    smallBlind: room.config.smallBlind,
    bigBlind: room.config.bigBlind,
  };
}

export function createPokerTableRoomListState(
  rooms: readonly PokerTableRoomListEntry[] = [],
): PokerTableRoomListState {
  const seen = new Set<string>();
  return {
    kind: 'poker-table-room-list',
    version: 1,
    rooms: rooms.filter((room) => {
      if (!room.roomId || seen.has(room.roomId)) return false;
      seen.add(room.roomId);
      return true;
    }),
  };
}

export function upsertPokerTableRoomListEntry(
  value: PokerTableRoomListState | null | undefined,
  room: PokerRoomState,
): PokerTableRoomListState {
  const next = createPokerTableRoomListEntry(room);
  const current = value?.rooms ?? [];
  const replaced = current.map((entry) => entry.roomId === next.roomId ? next : entry);
  if (!current.some((entry) => entry.roomId === next.roomId)) replaced.push(next);
  return createPokerTableRoomListState(replaced);
}

export function removePokerTableRoomListEntry(
  value: PokerTableRoomListState | null | undefined,
  roomId: string,
): PokerTableRoomListState {
  return createPokerTableRoomListState((value?.rooms ?? []).filter((entry) => entry.roomId !== roomId));
}

export function createPokerTableSurfaceState(
  room: PokerRoomState,
  currentPlayerId: string | null = null,
  sync?: PokerRoomSyncInput,
): PokerTableSurfaceState {
  const publicProjection = projectPokerRoomForPlayer(room, currentPlayerId);
  return {
    kind: 'poker-table-surface-state',
    version: 1,
    roomId: room.roomId,
    hostPlayerId: room.hostPlayerId,
    currentPlayerId,
    state: room.state,
    projection: {
      publicHoleCards: publicProjection.publicHoleCards,
      revealedPlayerIds: publicProjection.revealedPlayerIds,
      sync,
    },
  };
}

export function createPokerTablePrivateHandStates(room: PokerRoomState, partitionLabel: string): Record<string, PokerTablePrivateHandProjection> {
  const descriptor = createPokerTableRoomDescriptor(room.roomId, partitionLabel);
  return Object.fromEntries(room.state.players.map((player) => [
    pokerTablePrivateHandAddress(room.roomId, player.id, partitionLabel),
    createRoomPrivateProjection(descriptor, POKER_TABLE_PRIVATE_HAND_LANE.lane, { id: player.id }, {
      kind: 'poker-table-private-hand',
      version: 1,
      roomId: room.roomId,
      ownerId: player.id,
      cards: room.holeCards[player.id] ?? [],
    }),
  ]));
}

function isPokerHandState(value: unknown): value is PokerHandState {
  return Boolean(value && typeof value === 'object' && Array.isArray((value as PokerHandState).players));
}

export function readPokerTableSurfaceState(value: unknown): PokerTableSurfaceState | null {
  const record = value && typeof value === 'object' ? value as Partial<PokerTableSurfaceState> : null;
  if (record?.kind !== 'poker-table-surface-state' || record.version !== 1 || !isPokerHandState(record.state)) {
    return null;
  }
  return record as PokerTableSurfaceState;
}

export function readPokerRoomAuthorityState(value: unknown): PokerRoomState | null {
  const record = value && typeof value === 'object' ? value as Partial<PokerRoomState> : null;
  if (record?.kind !== 'poker-room-state' || record.version !== 1 || !isPokerHandState(record.state)) {
    return null;
  }
  return record as PokerRoomState;
}

export function readPokerTableRoomListState(value: unknown): PokerTableRoomListState {
  const record = value && typeof value === 'object' ? value as Partial<PokerTableRoomListState> : null;
  if (record?.kind !== 'poker-table-room-list' || record.version !== 1 || !Array.isArray(record.rooms)) {
    return createPokerTableRoomListState();
  }
  return createPokerTableRoomListState(record.rooms.filter((entry): entry is PokerTableRoomListEntry => (
    Boolean(entry)
    && typeof entry === 'object'
    && typeof entry.roomId === 'string'
    && typeof entry.hostPlayerId === 'string'
    && typeof entry.hostName === 'string'
    && typeof entry.playerCount === 'number'
    && typeof entry.maxPlayers === 'number'
    && typeof entry.phase === 'string'
    && typeof entry.handNumber === 'number'
    && typeof entry.smallBlind === 'number'
    && typeof entry.bigBlind === 'number'
  )));
}

export function readPokerTablePrivateHandState(
  value: unknown,
  expectedOwnerId: string | null = null,
  expectedRoomId: string | null = null,
): PokerTablePrivateHandState | null {
  const unwrapped = readRoomPrivateProjectionForAuthority<PokerTablePrivateHandState>(
    value,
    POKER_TABLE_PRIVATE_HAND_LANE,
    createRoomProjectionAuthority({
      participant: expectedOwnerId,
      roomId: expectedRoomId,
      capabilities: [POKER_TABLE_PRIVATE_HAND_READ_CAPABILITY],
    }),
    expectedRoomId ?? undefined,
  );
  const record = unwrapped && typeof unwrapped === 'object' ? unwrapped as Partial<PokerTablePrivateHandState> : null;
  if (
    record?.kind !== 'poker-table-private-hand'
    || record.version !== 1
    || typeof record.roomId !== 'string'
    || typeof record.ownerId !== 'string'
    || !Array.isArray(record.cards)
  ) {
    return null;
  }
  if (expectedOwnerId && record.ownerId !== expectedOwnerId) {
    return null;
  }
  if (expectedRoomId && record.roomId !== expectedRoomId) {
    return null;
  }
  return {
    kind: 'poker-table-private-hand',
    version: 1,
    roomId: record.roomId,
    ownerId: record.ownerId,
    cards: record.cards.slice(0, 2),
  };
}

export interface PokerSeatView {
  id: string;
  name: string;
  chips: number;
  currentBet: number;
  roles: string[];
  isActive: boolean;
  isFolded: boolean;
  isAllIn: boolean;
  isEliminated: boolean;
  isConnected: boolean;
  isWinner: boolean;
  cardCount: number;
  cardsVisible: boolean;
  publicCards: PokerCard[];
}

export interface PokerControl {
  action: PlayerAction;
  label: string;
  enabled: boolean;
  amountRequired?: number;
  minAmount?: number;
}

export interface PokerHandResultView {
  winnerIds: string[];
  winnerNames: string[];
  pot: number;
  label: string;
}

export interface PokerTableViewModel {
  phase: PokerHandState['phase'];
  street: PokerHandState['street'];
  handNumber: number;
  pot: number;
  sidePotCount: number;
  currentBet: number;
  smallBlind: number;
  bigBlind: number;
  communityCards: PokerCard[];
  seats: PokerSeatView[];
  controls: PokerControl[];
  sync: PokerRoomSyncView;
  privateHand: PokerPrivateHandView;
  handResult: PokerHandResultView | null;
}

function wholeNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.round(value)) : fallback;
}

function textOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function derivePokerRoomSync(input: PokerRoomSyncInput | undefined, playerCount: number): PokerRoomSyncView {
  const roomId = textOrNull(input?.roomId);
  const transportProviderRef = textOrNull(input?.transportProviderRef);
  const providerPackage = textOrNull(input?.providerPackage) ?? 'connectable-services';
  const transportLabel = textOrNull(input?.transportLabel) ?? 'external transport provider';
  const connectedPeerCount = wholeNumber(input?.connectedPeerCount, 0);
  const expectedPeerCount = wholeNumber(input?.expectedPeerCount, Math.max(0, playerCount - 1));
  const blockers = Array.isArray(input?.blockers) ? input.blockers.filter((entry) => entry.trim().length > 0) : [];
  const hasProvider = Boolean(transportProviderRef);
  const health: PokerRoomSyncHealth = blockers.length > 0
    ? 'blocked'
    : !roomId || !hasProvider
      ? 'local-only'
      : connectedPeerCount >= expectedPeerCount
        ? 'ready'
        : 'syncing';

  return {
    roomId,
    localParticipantId: textOrNull(input?.localParticipantId),
    providerPackage,
    transportProviderRef,
    transportLabel,
    connectedPeerCount,
    expectedPeerCount,
    syncCursor: typeof input?.syncCursor === 'number' && Number.isFinite(input.syncCursor) ? Math.max(0, Math.round(input.syncCursor)) : null,
    lastSyncedAt: textOrNull(input?.lastSyncedAt),
    canInvite: input?.canInvite ?? Boolean(roomId && hasProvider),
    health,
    statusLabel: health === 'blocked'
      ? 'Sync blocked'
      : health === 'local-only'
        ? 'Local table projection'
        : health === 'ready'
          ? 'Room linked'
          : 'Waiting for peers',
    enginePrimitive: 'SyncMesh causal-log delta exchange',
    frameContract: 'CarrierFrame::DeltaBatch exact addressed bytes',
    blockers,
  };
}

function derivePrivateHand(currentPlayerId: string | null, input: PokerTableProjectionInput | undefined): PokerPrivateHandView {
  const privateHand = input?.privateHand;
  return {
    ownerId: textOrNull(privateHand?.ownerId) ?? currentPlayerId,
    cards: Array.isArray(privateHand?.cards) ? privateHand.cards.slice(0, 2) : [],
    hidden: privateHand?.hidden ?? true,
    canToggle: privateHand?.canToggle ?? Boolean(currentPlayerId),
  };
}

function rolesFor(index: number, state: PokerHandState): string[] {
  const roles: string[] = [];
  if (index === state.dealerIndex) roles.push(POKER_RULES_STATE_MACHINE.seatRoles.dealer);
  if (index === state.smallBlindIndex) roles.push(POKER_RULES_STATE_MACHINE.seatRoles.smallBlind);
  if (index === state.bigBlindIndex) roles.push(POKER_RULES_STATE_MACHINE.seatRoles.bigBlind);
  return roles;
}

function derivePokerHandResult(state: PokerHandState): PokerHandResultView | null {
  const result = state.result;
  if (!result || result.winnerIds.length === 0) return null;
  const winnerNames = result.winnerIds
    .map((winnerId) => state.players.find((player) => player.id === winnerId)?.name)
    .filter((name): name is string => Boolean(name));
  if (winnerNames.length === 0) return null;
  return {
    winnerIds: result.winnerIds,
    winnerNames,
    pot: result.pot,
    label: winnerNames.length === 1 ? `${winnerNames[0]} wins` : `${winnerNames.join(', ')} win`,
  };
}

function seatView(
  player: PokerPlayer,
  index: number,
  state: PokerHandState,
  input: PokerTableProjectionInput | undefined,
  handResult: PokerHandResultView | null,
): PokerSeatView {
  const publicCards = input?.publicHoleCards?.[player.id]?.slice(0, 2) ?? [];
  const cardsVisible = publicCards.length > 0 || Boolean(input?.revealedPlayerIds?.includes(player.id));
  const cardCount = state.phase === POKER_RULES_STATE_MACHINE.phaseRoles.active
    || state.phase === POKER_RULES_STATE_MACHINE.phaseRoles.showdown
    ? 2
    : publicCards.length;

  return {
    id: player.id,
    name: player.name,
    chips: player.chips,
    currentBet: player.currentBet,
    roles: rolesFor(index, state),
    isActive: index === state.activeIndex,
    isFolded: player.folded,
    isAllIn: player.allIn,
    isEliminated: player.eliminated,
    isConnected: player.connected,
    isWinner: Boolean(handResult?.winnerIds.includes(player.id)),
    cardCount,
    cardsVisible,
    publicCards,
  };
}

export function derivePokerControls(state: PokerHandState, currentPlayerId: string | null): PokerControl[] {
  const active = state.players[state.activeIndex];
  const isCurrentTurn = Boolean(active && currentPlayerId === active.id && !active.folded && !active.allIn && !active.eliminated);
  const toCall = active ? Math.max(0, state.currentBet - active.currentBet) : 0;

  return [
    { action: POKER_RULES_STATE_MACHINE.playerActionRoles.fold, label: 'Fold', enabled: isCurrentTurn },
    { action: POKER_RULES_STATE_MACHINE.playerActionRoles.checkCall, label: toCall === 0 ? 'Check' : `Call ${toCall}`, enabled: isCurrentTurn, amountRequired: toCall },
    { action: POKER_RULES_STATE_MACHINE.playerActionRoles.raise, label: 'Raise', enabled: isCurrentTurn, minAmount: state.minRaise },
    { action: POKER_RULES_STATE_MACHINE.playerActionRoles.allIn, label: 'All In', enabled: isCurrentTurn },
  ];
}

export function derivePokerTableViewModel(
  state: PokerHandState,
  currentPlayerId: string | null,
  input?: PokerTableProjectionInput,
): PokerTableViewModel {
  const handResult = derivePokerHandResult(state);
  return {
    phase: state.phase,
    street: state.street,
    handNumber: state.handNumber,
    pot: state.pot,
    sidePotCount: state.pots.length,
    currentBet: state.currentBet,
    smallBlind: state.smallBlind,
    bigBlind: state.bigBlind,
    communityCards: state.communityCards,
    seats: state.players.map((player, index) => seatView(player, index, state, input, handResult)),
    controls: derivePokerControls(state, currentPlayerId),
    sync: derivePokerRoomSync(input?.sync, state.players.length),
    privateHand: derivePrivateHand(currentPlayerId, input),
    handResult,
  };
}
