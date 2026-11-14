import React, { Suspense, useEffect, useMemo, useState } from 'react';
import { create as createQrCode } from 'qrcode';
import { sendRequestToBitfieldTarget } from '@/packages/poker-table/.bitfield-entry-scope/poker-table/runtime-kit';
import {
  bitfieldGeneratedLiveReadScopeDescriptor,
  useBitfieldData,
} from '@/packages/poker-table/.bitfield-entry-scope/poker-table/runtime-kit-react';

// The partition this surface was built into, stamped by the generator with the set
// that installed it. Package source must never name an app: a module constant here
// addressed one app from every set, which is how this surface pointed at a retired one.
const partitionLabel = bitfieldGeneratedLiveReadScopeDescriptor.partitionLabel;
import { ErrorBoundary, FloatingMaterialFrame, Badge, Button, Card, Container, Input, ScrollableSurface, Text, mountReactSurface } from '@/packages/ui';
import { EmbeddedScreenArrangement } from '@/packages/screen-arrangement/show/EmbeddedScreenArrangement';
import {
  applyPokerRoomPlayerAction,
  configurePokerRoom,
  createPokerLobbyRoomState,
  createPokerPlayers,
  kickPokerRoomPlayer,
  nextPokerRoomHand,
  nextPokerStreetLabel,
  normalizePokerTableConfig,
  startPokerRoomGame,
  upsertPokerRoomPlayer,
  type PlayerAction,
  type PokerRoomState,
  type PokerTableConfig,
} from '@/packages/poker-rules/read-data/poker-rules';
import {
  buildPokerTableRoomStateCommitRequest,
  buildPokerTableRoomStateResetRequest,
} from '@/packages/poker-table/do-work/poker-table-requests';
import {
  createPokerTableSurfaceState,
  createPokerTableRoomListState,
  pokerTableAuthorityAddress,
  pokerTablePrivateHandAddress,
  pokerTableSurfaceAddress,
  readPokerRoomAuthorityState,
  readPokerTableRoomListState,
  readPokerTablePrivateHandState,
  readPokerTableSurfaceState,
  type PokerTableProjectionInput,
  type PokerTableRoomListEntry,
  type PokerTableRoomListState,
} from '@/packages/poker-table/read-data/poker-table';
import {
  acceptsPokerWorkspaceLayoutState,
  POKER_WORKSPACE_LAYOUT_STATE,
  POKER_WORKSPACE_LAYOUT_STATE_ADDRESS_LABEL,
  POKER_WORKSPACE_LAYOUT_STATE_INPUT,
  POKER_WORKSPACE_PLACEABLE_SURFACE_LIST_ADDRESS_LABEL,
} from '@/packages/poker-table/read-data/read-poker-workspace-layout-state';
import { PokerTablePanel, PokerTableStyles } from '@/packages/poker-table/show/PokerTablePanel';

type MountArgs = {
  el: HTMLElement;
  props?: Record<string, unknown>;
};

interface SetupState {
  hostName: string;
  playerCount: number;
  playerNames: string[];
  startingChips: number;
  smallBlind: number;
  bigBlind: number;
  blindIncrease: number;
}

const EMPTY_PLAYER_NAMES = ['', '', '', '', '', ''];
const POKER_TABLE_ROUTE_PATH = '/poker/table';
const LAST_PLAYER_NAME_STORAGE_KEY = 'bitfield-studio:poker-table:last-player-name';

type PokerJoinLinks = {
  inviteUrl: string;
  inviteUrlUsesLocalHost: boolean;
};

type PokerSurfacePart = 'workspace' | 'table';

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readSurfaceInput(props: Record<string, unknown>): Record<string, unknown> | undefined {
  const value = props.surfaceInput;
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function readPokerSurfacePart(props: Record<string, unknown>): PokerSurfacePart {
  const surfaceInput = readSurfaceInput(props);
  const raw = surfaceInput?.poker_surface ?? surfaceInput?.pokerSurface ?? surfaceInput?.part;
  return raw === 'table' ? 'table' : 'workspace';
}

function numberFrom(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(numberFrom(value, fallback))));
}

function setupFromProps(props: Record<string, unknown>): SetupState {
  const config = object(props.config) as Partial<PokerTableConfig>;
  return {
    hostName: typeof props.host_name === 'string' ? props.host_name : '',
    playerCount: clampInteger(props.player_count, 6, 2, 10),
    playerNames: EMPTY_PLAYER_NAMES,
    startingChips: clampInteger(config.startingChips, 1000, 100, 1_000_000),
    smallBlind: clampInteger(config.smallBlind, 10, 1, 1_000_000),
    bigBlind: clampInteger(config.bigBlind, 20, 1, 1_000_000),
    blindIncrease: clampInteger(config.blindIncrease, 10, 0, 1_000_000),
  };
}

function configuredPlayerNames(setup: SetupState): string[] {
  const hostName = setup.hostName.trim();
  const seatNames = setup.playerNames
    .slice(0, setup.playerCount)
    .map((name) => name.trim())
    .filter(Boolean);
  const names = hostName.length > 0 ? [hostName, ...seatNames.filter((name) => name !== hostName)] : seatNames;
  return Array.from(new Set(names)).slice(0, setup.playerCount);
}

function newRoomIdFromProps(props: Record<string, unknown>): string {
  if (typeof props.room_id === 'string' && props.room_id.trim().length > 0) return props.room_id.trim();
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const bytes = new Uint8Array(8);
    crypto.getRandomValues(bytes);
    return `poker-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
  }
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    const compact = crypto.randomUUID().replace(/[^a-z0-9]/giu, '').slice(0, 16);
    if (compact) return `poker-${compact}`;
  }
  return `poker-${Date.now().toString(36)}`;
}

function routePathForRoom(roomId: string): string {
  return `${POKER_TABLE_ROUTE_PATH}/${encodeURIComponent(roomId)}`;
}

function samePlayerName(left: string | null | undefined, right: string | null | undefined): boolean {
  return Boolean(left && right && left.trim().toLowerCase() === right.trim().toLowerCase());
}

function setBrowserRoute(routePath: string) {
  if (typeof window === 'undefined') return;
  if (window.location.pathname === routePath && window.location.search.length === 0) return;
  window.history.pushState(null, '', routePath);
}

function canonicalizeRoomRoute(roomId: string) {
  setBrowserRoute(routePathForRoom(roomId));
}

function roomIdFromRoutePath(pathname: string): string | null {
  const normalized = pathname.length > 1 ? pathname.replace(/\/+$/u, '') : pathname;
  if (normalized === POKER_TABLE_ROUTE_PATH) return null;
  const prefix = `${POKER_TABLE_ROUTE_PATH}/`;
  if (!normalized.startsWith(prefix)) return null;
  const encodedRoomId = normalized.slice(prefix.length).split('/')[0] ?? '';
  if (!encodedRoomId) return null;
  try {
    return decodeURIComponent(encodedRoomId);
  } catch {
    return encodedRoomId;
  }
}

function roomIdFromCurrentRoute(props: Record<string, unknown>): string | null {
  if (typeof props.room_id === 'string' && props.room_id.trim().length > 0) return props.room_id.trim();
  if (typeof window === 'undefined') return null;
  return roomIdFromRoutePath(window.location.pathname);
}

function playerIdStorageKey(roomId: string): string {
  return `bitfield-studio:poker-table:room:${roomId}:player-id`;
}

function storedText(key: string): string {
  try {
    return typeof localStorage === 'undefined' ? '' : localStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
}

function storeText(key: string, value: string) {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(key, value);
  } catch {
    // Local identity is a device convenience. Failed storage must not block table state.
  }
}

function clearText(key: string) {
  try {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(key);
  } catch {
    // Local identity is a device convenience. Failed storage must not block table state.
  }
}

function canUseNativeShare(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.share === 'function';
}

function routeUrlFromBase(routePath: string, baseUrl: string): string {
  return new URL(routePath, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`).toString();
}

function currentBrowserUrl(routePath: string): string {
  if (typeof window === 'undefined') return routePath;
  return routeUrlFromBase(routePath, window.location.href);
}

function loopbackUrl(url: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::|\/|$)/u.test(url);
}

/** The invite link is built from the address THIS PAGE was reached at, and nothing else.
 *
 *  It used to ask the shell for a better one over `/open-locations`, which offered a
 *  same-network address so a phone could join. That route is deleted, and the deletion is the
 *  honest answer rather than a loss: an app running on one machine has NO address another device
 *  can dial, so the same-network entry was only ever meaningful for a deployment reachable by
 *  name, and for exactly those the page's own origin already IS that name. `inviteUrlUsesLocalHost`
 *  below is what tells the player the difference, and it needs no side channel to compute. */
function pokerRoomInviteUrl(routePath: string, room: PokerRoomState): string {
  const url = new URL(currentBrowserUrl(routePath));
  const host = room.state.players.find((player) => player.id === room.hostPlayerId) ?? room.state.players[0];
  if (host) url.searchParams.set('host', host.name);
  url.searchParams.set('chips', String(room.config.startingChips));
  url.searchParams.set('small', String(room.config.smallBlind));
  url.searchParams.set('big', String(room.config.bigBlind));
  url.searchParams.set('step', String(room.config.blindIncrease));
  url.searchParams.set('seats', String(room.config.maxPlayers));
  return url.toString();
}

function roomFromInviteUrl(roomId: string): PokerRoomState | null {
  if (typeof window === 'undefined') return null;
  const params = new URLSearchParams(window.location.search);
  const hostName = params.get('host')?.trim();
  if (!hostName) return null;
  const config = normalizePokerTableConfig({
    startingChips: clampInteger(params.get('chips'), 1000, 100, 1_000_000),
    smallBlind: clampInteger(params.get('small'), 10, 1, 1_000_000),
    bigBlind: clampInteger(params.get('big'), 20, 1, 1_000_000),
    blindIncrease: clampInteger(params.get('step'), 10, 0, 1_000_000),
    blindMode: 'fixed',
    maxPlayers: clampInteger(params.get('seats'), 6, 2, 10),
  });
  const players = createPokerPlayers([hostName], config.startingChips);
  return createPokerLobbyRoomState({
    roomId,
    players,
    config,
    hostPlayerId: players[0].id,
  });
}

function buildPokerJoinLinks(routePath: string, room: PokerRoomState): PokerJoinLinks {
  const inviteUrl = pokerRoomInviteUrl(routePath, room);
  return {
    inviteUrl,
    inviteUrlUsesLocalHost: loopbackUrl(inviteUrl),
  };
}

function buildPokerJoinMaterial(routePath: string, room: PokerRoomState): PokerJoinLinks {
  return buildPokerJoinLinks(routePath, room);
}

function makeQrCells(value: string): { size: number; data: Uint8Array } | null {
  try {
    const qr = createQrCode(value, { errorCorrectionLevel: 'M', margin: 1 });
    return { size: qr.modules.size, data: qr.modules.data };
  } catch {
    return null;
  }
}

function JoinQrCode({ value }: { value: string }) {
  const qr = useMemo(() => makeQrCells(value), [value]);
  if (!qr) {
    return (
      <div className="casino-qr-fallback">
        Copy link
      </div>
    );
  }
  return (
    <svg
      aria-label="QR code for joining this poker table"
      className="casino-qr-svg"
      role="img"
      shapeRendering="crispEdges"
      viewBox={`0 0 ${qr.size} ${qr.size}`}
    >
      <rect width={qr.size} height={qr.size} fill="#fffefa" />
      {Array.from(qr.data).map((value, index) => (
        value ? (
          <rect
            key={index}
            x={index % qr.size}
            y={Math.floor(index / qr.size)}
            width="1"
            height="1"
            fill="#00130e"
          />
        ) : null
      ))}
    </svg>
  );
}

function PokerJoinInvite({ room, isHost }: { room: PokerRoomState; isHost: boolean }) {
  const links = buildPokerJoinMaterial(routePathForRoom(room.roomId), room);
  const inviteUrl = links.inviteUrl;
  const [copied, setCopied] = useState(false);
  const [shared, setShared] = useState(false);

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      setCopied(false);
    }
  }

  async function shareLink() {
    if (!canUseNativeShare()) return;
    try {
      await navigator.share({
        title: 'Poker Table',
        text: 'Open this poker table.',
        url: inviteUrl,
      });
      setShared(true);
      window.setTimeout(() => setShared(false), 1400);
    } catch {
      setShared(false);
    }
  }

  return (
    <div className="casino-join-panel">
      <Card variant="nested" padding="md" layout="stack" className="casino-join-card">
        <Container layout="vertical" gap="xs">
          <Badge variant="success" size="sm">Invite players</Badge>
          <Text variant="heading">{isHost ? 'Share this table' : 'Join this table'}</Text>
        </Container>
        <div className="casino-join-url" title={links.inviteUrl}>
          {links.inviteUrl}
        </div>
        {links.inviteUrlUsesLocalHost && (
          <div className="casino-join-warning">
            Share the Wi-Fi link shown here.
          </div>
        )}
        <Container layout="horizontal" gap="sm" wrap className="casino-join-actions">
          <Button type="button" size="lg" variant="primary" onClick={copyLink}>
            {copied ? 'Copied' : 'Copy invite'}
          </Button>
          <Button type="button" size="lg" variant={canUseNativeShare() ? 'secondary' : 'ghost'} disabled={!canUseNativeShare()} onClick={shareLink}>
            {shared ? 'Shared' : 'Share'}
          </Button>
        </Container>
      </Card>
      <Card variant="nested" padding="md" layout="stack" className="casino-qr-card">
        <div className="casino-qr-frame">
          <JoinQrCode value={inviteUrl} />
        </div>
      </Card>
    </div>
  );
}

function PokerActiveTools({
  room,
  isHost,
  onOpenTables,
  onLeaveTable,
  onEndTable,
}: {
  room: PokerRoomState;
  isHost: boolean;
  onOpenTables: () => void;
  onLeaveTable: () => void;
  onEndTable?: () => void;
}) {
  const [shareOpen, setShareOpen] = useState(false);

  return (
    <Card variant="nested" padding="sm" className="casino-dock-card casino-tools-dock">
      <div className="casino-tools-actions">
        <Button type="button" size="sm" variant="primary" onClick={() => setShareOpen((open) => !open)}>
          {shareOpen ? 'Hide invite' : 'Share table'}
        </Button>
        <Button type="button" size="sm" variant="secondary" onClick={onOpenTables}>
          Tables
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onLeaveTable}>
          Leave table
        </Button>
        {isHost && onEndTable && (
          <Button type="button" size="sm" variant="danger" onClick={onEndTable}>
            End table
          </Button>
        )}
      </div>
      <div className={`casino-share-drawer ${shareOpen ? 'is-open' : ''}`} aria-hidden={!shareOpen}>
        <div>
          {shareOpen && <PokerJoinInvite room={room} isHost={isHost} />}
        </div>
      </div>
    </Card>
  );
}

async function sendRoomCommit(room: PokerRoomState, roomList: PokerTableRoomListState | null = null): Promise<void> {
  await sendRequestToBitfieldTarget(buildPokerTableRoomStateCommitRequest(room, partitionLabel, null, roomList));
}

function writeFailureText(action: string): string {
  return `${action} did not save. Reconnect and try again.`;
}

function roomListEntries(value: PokerTableRoomListState): PokerTableRoomListEntry[] {
  return value.rooms.slice().sort((left, right) => left.hostName.localeCompare(right.hostName));
}

function PokerSetup({
  props,
  roomList,
  onClaim,
  onOpenRoom,
}: {
  props: Record<string, unknown>;
  roomList: PokerTableRoomListState;
  onClaim?: (roomId: string, playerId: string) => void;
  onOpenRoom?: (roomId: string, room: PokerRoomState) => void;
}) {
  const [setup, setSetup] = useState(() => setupFromProps(props));
  const [creating, setCreating] = useState(false);
  const [writeError, setWriteError] = useState('');
  const names = useMemo(() => configuredPlayerNames(setup), [setup]);
  const rooms = useMemo(() => roomListEntries(roomList), [roomList]);
  const canCreate = setup.hostName.trim().length > 0 && !creating;

  function setPlayerName(index: number, value: string) {
    setSetup((current) => {
      const playerNames = current.playerNames.slice();
      playerNames[index] = value;
      while (playerNames.length < current.playerCount) playerNames.push('');
      return { ...current, playerNames };
    });
  }

  async function createTable() {
    if (!canCreate) return;
    const config = normalizePokerTableConfig({
      startingChips: setup.startingChips,
      smallBlind: setup.smallBlind,
      bigBlind: Math.max(setup.smallBlind, setup.bigBlind),
      blindIncrease: setup.blindIncrease,
      blindMode: 'fixed',
      maxPlayers: setup.playerCount,
    });
    const playerNames = names.length > 0 ? names : [setup.hostName.trim()];
    const players = createPokerPlayers(playerNames, config.startingChips);
    const room = createPokerLobbyRoomState({
      roomId: newRoomIdFromProps(props),
      players,
      config,
      hostPlayerId: players[0].id,
    });
    setCreating(true);
    setWriteError('');
    try {
      await sendRoomCommit(room, roomList);
      storeText(playerIdStorageKey(room.roomId), players[0].id);
      storeText(LAST_PLAYER_NAME_STORAGE_KEY, players[0].name);
      onClaim?.(room.roomId, players[0].id);
      onOpenRoom?.(room.roomId, room);
    } catch {
      setWriteError(writeFailureText('Table'));
    } finally {
      setCreating(false);
    }
  }

  return (
    <ScrollableSurface>
      <Container layout="vertical" gap="sm" width="full" minHeight="0">
        <Card variant="surface" padding="lg" layout="stack" aria-label="Poker setup" className="casino-setup">
          <PokerTableStyles />
          <Container layout="vertical" gap="sm" className="casino-setup-hero">
            <div className="casino-setup-mark">♣</div>
            <Text weight="bold" className="casino-setup-title">
              Poker tables
            </Text>
          </Container>

          <Card variant="nested" padding="md" layout="stack" className="casino-setup-roster">
            <Text variant="heading">Join table</Text>
            {rooms.length > 0 ? (
              <div className="casino-table-list">
                {rooms.map((room) => (
                  <button
                    key={room.roomId}
                    type="button"
                    className="casino-table-list-button"
                    onClick={() => onOpenRoom?.(room.roomId)}
                  >
                    <span>Join {room.hostName}'s table</span>
                    <span>{room.playerCount}/{room.maxPlayers} seats · {room.smallBlind}/{room.bigBlind}</span>
                  </button>
                ))}
              </div>
            ) : (
              <Text variant="body-xs" color="muted">No tables yet.</Text>
            )}
          </Card>

          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <Input label="Host name" value={setup.hostName} onChange={(event) => setSetup((current) => ({ ...current, hostName: event.target.value }))} placeholder="Who is hosting?" />
            <Input label="Player count" type="number" min={2} max={10} value={setup.playerCount} onChange={(event) => setSetup((current) => ({ ...current, playerCount: clampInteger(event.target.value, current.playerCount, 2, 10) }))} />
            <Input label="Starting chips" type="number" min={100} value={setup.startingChips} onChange={(event) => setSetup((current) => ({ ...current, startingChips: clampInteger(event.target.value, current.startingChips, 100, 1_000_000) }))} />
            <Input label="Blind increase" type="number" min={0} value={setup.blindIncrease} onChange={(event) => setSetup((current) => ({ ...current, blindIncrease: clampInteger(event.target.value, current.blindIncrease, 0, 1_000_000) }))} />
            <Input label="Small blind" type="number" min={1} value={setup.smallBlind} onChange={(event) => setSetup((current) => ({ ...current, smallBlind: clampInteger(event.target.value, current.smallBlind, 1, 1_000_000) }))} />
            <Input label="Big blind" type="number" min={1} value={setup.bigBlind} onChange={(event) => setSetup((current) => ({ ...current, bigBlind: clampInteger(event.target.value, current.bigBlind, 1, 1_000_000) }))} />
          </div>

          <Card variant="nested" padding="md" layout="stack" className="casino-setup-roster">
            <Text variant="heading">Players</Text>
            <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
              {Array.from({ length: setup.playerCount }).map((_, index) => (
                <Input
                  key={index}
                  label={index === 0 ? 'Seat 1' : `Seat ${index + 1}`}
                  value={setup.playerNames[index] ?? ''}
                  onChange={(event) => setPlayerName(index, event.target.value)}
                  placeholder={index === 0 && setup.hostName ? setup.hostName : `Player ${index + 1}`}
                />
              ))}
            </div>
          </Card>

          <div className="casino-create-row">
            <Button type="button" size="lg" variant={canCreate ? 'success' : 'secondary'} disabled={!canCreate} onClick={createTable} className="casino-primary-action">
              {creating ? 'Creating...' : 'Create table'}
            </Button>
            {!canCreate && (
              <Text as="span" className="casino-create-helper">
                {creating ? 'Saving table.' : 'Type a host name.'}
              </Text>
            )}
            {writeError && (
              <Text as="span" className="casino-create-helper text-status-error">
                {writeError}
              </Text>
            )}
          </div>
        </Card>
      </Container>
    </ScrollableSurface>
  );
}

function PokerLobby({
  room,
  roomList,
  currentPlayerId,
  onClaim,
  onCommit,
  onOpenSetup,
}: {
  room: PokerRoomState;
  roomList: PokerTableRoomListState;
  currentPlayerId: string | null;
  onClaim: (roomId: string, playerId: string) => void;
  onCommit: (room: PokerRoomState) => Promise<void>;
  onOpenSetup: () => void;
}) {
  const currentPlayer = room.state.players.find((player) => player.id === currentPlayerId) ?? null;
  const hostPlayer = room.state.players.find((player) => player.id === room.hostPlayerId) ?? room.state.players[0] ?? null;
  const isHost = currentPlayerId === room.hostPlayerId;
  const [name, setName] = useState(() => currentPlayer?.name ?? storedText(LAST_PLAYER_NAME_STORAGE_KEY));
  const [startingChips, setStartingChips] = useState(room.config.startingChips);
  const [smallBlind, setSmallBlind] = useState(room.config.smallBlind);
  const [bigBlind, setBigBlind] = useState(room.config.bigBlind);
  const [blindIncrease, setBlindIncrease] = useState(room.config.blindIncrease);
  const [savingLabel, setSavingLabel] = useState('');
  const [writeError, setWriteError] = useState('');
  const saving = savingLabel.length > 0;
  const canJoin = name.trim().length > 0 && !saving;
  const canStart = isHost && room.state.players.filter((player) => player.connected).length >= 2;

  useEffect(() => {
    if (currentPlayerId || !hostPlayer) return;
    if (!samePlayerName(storedText(LAST_PLAYER_NAME_STORAGE_KEY), hostPlayer.name)) return;
    storeText(playerIdStorageKey(room.roomId), hostPlayer.id);
    onClaim(room.roomId, hostPlayer.id);
  }, [currentPlayerId, hostPlayer?.id, hostPlayer?.name, onClaim, room.roomId]);

  async function commit(nextRoom: PokerRoomState, action: string) {
    setSavingLabel(action);
    setWriteError('');
    try {
      await onCommit(nextRoom);
      return true;
    } catch {
      setWriteError(writeFailureText(action));
      return false;
    } finally {
      setSavingLabel('');
    }
  }

  async function joinTable() {
    if (!canJoin) return;
    const result = upsertPokerRoomPlayer(room, { playerId: currentPlayerId, name });
    if (!result.playerId) return;
    if (!await commit(result.room, currentPlayer ? 'Seat update' : 'Join')) return;
    storeText(playerIdStorageKey(room.roomId), result.playerId);
    storeText(LAST_PLAYER_NAME_STORAGE_KEY, name.trim());
    onClaim(room.roomId, result.playerId);
    canonicalizeRoomRoute(room.roomId);
  }

  async function saveConfig() {
    if (!isHost) return;
    await commit(configurePokerRoom(room, {
      startingChips,
      smallBlind,
      bigBlind: Math.max(smallBlind, bigBlind),
      blindIncrease,
      blindMode: 'fixed',
      maxPlayers: room.config.maxPlayers,
    }), 'Stakes');
  }

  async function startGame() {
    if (!canStart) return;
    await commit(startPokerRoomGame(room), 'Game');
  }

  async function endTable() {
    if (!isHost) {
      onOpenSetup();
      return;
    }
    setSavingLabel('Table');
    setWriteError('');
    try {
      await sendRequestToBitfieldTarget(buildPokerTableRoomStateResetRequest(room, partitionLabel, roomList));
      onOpenSetup();
    } catch {
      setWriteError(writeFailureText('Table'));
    } finally {
      setSavingLabel('');
    }
  }

  async function leaveTable() {
    if (!currentPlayerId) {
      onOpenSetup();
      return;
    }
    const nextRoom = kickPokerRoomPlayer(room, currentPlayerId);
    setSavingLabel('Leave');
    setWriteError('');
    try {
      if (nextRoom.state.players.length === 0) {
        await sendRequestToBitfieldTarget(buildPokerTableRoomStateResetRequest(room, partitionLabel, roomList));
      } else {
        await onCommit(nextRoom);
      }
      clearText(playerIdStorageKey(room.roomId));
      onOpenSetup();
    } catch {
      setWriteError(writeFailureText('Leave'));
    } finally {
      setSavingLabel('');
    }
  }

  return (
    <ScrollableSurface>
      <Container layout="vertical" gap="sm" width="full" minHeight="0">
        <Card variant="surface" padding="lg" layout="stack" aria-label="Poker lobby" className="casino-setup">
          <PokerTableStyles />
          <Container layout="vertical" gap="sm" className="casino-setup-hero">
            <div className="casino-setup-mark">♣</div>
            <Text weight="bold" className="casino-setup-title">
              {isHost ? 'Share the table' : 'Join the table'}
            </Text>
          </Container>

          <PokerJoinInvite room={room} isHost={isHost} />

          <Card variant="nested" padding="md" layout="stack" className="casino-setup-roster">
            <Container layout="horizontal" justifyContent="between" alignItems="center" gap="sm" wrap>
              <Text variant="heading">Seats</Text>
              <Badge variant={room.state.players.length >= 2 ? 'success' : 'warning'} size="sm">
                {room.state.players.length}/{room.config.maxPlayers}
              </Badge>
            </Container>
            <div className="casino-crew-grid">
              {room.state.players.map((player) => (
                <div key={player.id} className="casino-crew-row">
                  <Text variant="body" weight="semibold" truncate className="casino-crew-name">
                    {player.name}{player.id === room.hostPlayerId ? ' · host' : ''}{player.id === currentPlayerId ? ' · you' : ''}
                  </Text>
                  {isHost && player.id !== currentPlayerId && (
                    <Button type="button" size="sm" variant="danger" disabled={saving} onClick={() => { void commit(kickPokerRoomPlayer(room, player.id), 'Seat removal'); }}>
                      Kick
                    </Button>
                  )}
                </div>
              ))}
            </div>
          </Card>

          <div className={isHost ? 'grid gap-3 md:grid-cols-2 xl:grid-cols-4' : 'grid gap-3 md:grid-cols-[minmax(0,1.2fr)_minmax(0,2fr)]'}>
            <Input label="Your name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Type your name" />
            {isHost ? (
              <>
                <Input label="Starting chips" type="number" value={startingChips} onChange={(event) => setStartingChips(clampInteger(event.target.value, startingChips, 100, 1_000_000))} />
                <Input label="Small blind" type="number" value={smallBlind} onChange={(event) => setSmallBlind(clampInteger(event.target.value, smallBlind, 1, 1_000_000))} />
                <Input label="Big blind" type="number" value={bigBlind} onChange={(event) => setBigBlind(clampInteger(event.target.value, bigBlind, 1, 1_000_000))} />
                <Input label="Blind increase" type="number" value={blindIncrease} onChange={(event) => setBlindIncrease(clampInteger(event.target.value, blindIncrease, 0, 1_000_000))} />
              </>
            ) : (
              <div className="casino-stake-summary" aria-label="Table stakes">
                <div><span>Chips</span><strong>{room.config.startingChips.toLocaleString()}</strong></div>
                <div><span>Blinds</span><strong>{room.config.smallBlind}/{room.config.bigBlind}</strong></div>
                <div><span>Increase</span><strong>{room.config.blindIncrease}</strong></div>
              </div>
            )}
          </div>

          <Container layout="horizontal" gap="sm" wrap>
            <Button type="button" size="lg" variant={canJoin ? 'primary' : 'secondary'} disabled={!canJoin} onClick={joinTable}>
              {savingLabel === 'Join' ? 'Joining...' : savingLabel === 'Seat update' ? 'Updating...' : currentPlayer ? 'Update my seat' : 'Join table'}
            </Button>
            {isHost && (
              <>
                <Button type="button" size="lg" variant="secondary" disabled={saving} onClick={saveConfig}>
                  {savingLabel === 'Stakes' ? 'Saving...' : 'Save stakes'}
                </Button>
                <Button type="button" size="lg" variant={canStart ? 'success' : 'secondary'} disabled={!canStart || saving} onClick={startGame}>
                  {savingLabel === 'Game' ? 'Starting...' : 'Start game'}
                </Button>
                <Button type="button" size="lg" variant="ghost" onClick={onOpenSetup}>
                  Tables
                </Button>
              </>
            )}
            {currentPlayer && (
              <Button type="button" size="lg" variant="ghost" disabled={saving} onClick={leaveTable}>
                {savingLabel === 'Leave' ? 'Leaving...' : 'Leave table'}
              </Button>
            )}
            {isHost ? (
              <Button type="button" size="lg" variant="danger" disabled={saving} onClick={endTable}>
                {savingLabel === 'Table' ? 'Saving...' : 'End table'}
              </Button>
            ) : (
              <Button type="button" size="lg" variant="ghost" onClick={onOpenSetup}>
                Tables
              </Button>
            )}
            {writeError && (
              <Text variant="body-xs" color="danger">
                {writeError}
              </Text>
            )}
            {!canStart && (
              <Text variant="body-xs" color="muted">
                {isHost ? 'Invite one more player to start.' : 'Waiting for the game to start.'}
              </Text>
            )}
          </Container>
        </Card>
      </Container>
    </ScrollableSurface>
  );
}

function PokerTableStateGate({ props }: { props: Record<string, unknown> }) {
  const [routeRoomId, setRouteRoomId] = useState(() => roomIdFromCurrentRoute(props));
  const [pendingRoom, setPendingRoom] = useState<PokerRoomState | null>(null);
  const [seenRoomIds, setSeenRoomIds] = useState<ReadonlySet<string>>(() => new Set());
  const [endedRoomIds, setEndedRoomIds] = useState<ReadonlySet<string>>(() => new Set());
  const rawRoomList = useBitfieldData<unknown>('table-list');
  const roomList = readPokerTableRoomListState(rawRoomList);
  const surfaceAddressLabel = routeRoomId ? pokerTableSurfaceAddress(routeRoomId, partitionLabel) : null;
  const authorityAddressLabel = routeRoomId ? pokerTableAuthorityAddress(routeRoomId, partitionLabel) : null;
  const rawSurface = useBitfieldData<unknown>({
    input: 'surface-state',
    params: {
      valueAddressLabel: surfaceAddressLabel,
    },
  });
  const candidateSurface = readPokerTableSurfaceState(rawSurface);
  const surface = routeRoomId && candidateSurface?.roomId === routeRoomId ? candidateSurface : null;
  const rawAuthority = useBitfieldData<unknown>({
    input: 'authority-state',
    params: {
      valueAddressLabel: authorityAddressLabel,
    },
  });
  const candidateAuthority = readPokerRoomAuthorityState(rawAuthority);
  const authority = routeRoomId && candidateAuthority?.roomId === routeRoomId ? candidateAuthority : null;
  const projectedRoom = surface ? {
    kind: 'poker-room-state' as const,
    version: 1 as const,
    roomId: surface.roomId,
    board: surface.state.communityCards,
    config: surface.state.config,
    handNumber: surface.state.handNumber,
    holeCards: {},
    hostPlayerId: surface.hostPlayerId,
    state: surface.state,
  } : null;
  const pendingRouteRoom = routeRoomId && pendingRoom?.roomId === routeRoomId ? pendingRoom : null;
  const routeRoomEnded = Boolean(routeRoomId && endedRoomIds.has(routeRoomId));
  const inviteRouteRoom = useMemo(() => routeRoomId && !endedRoomIds.has(routeRoomId) ? roomFromInviteUrl(routeRoomId) : null, [endedRoomIds, routeRoomId]);
  const room = authority ?? projectedRoom ?? pendingRouteRoom ?? inviteRouteRoom;
  const [claimedPlayerId, setClaimedPlayerId] = useState(() => routeRoomId ? storedText(playerIdStorageKey(routeRoomId)) : '');
  const currentPlayerId = room?.state.players.some((player) => player.id === claimedPlayerId) ? claimedPlayerId : null;
  const privateHandValueAddressLabel = room && currentPlayerId
    ? pokerTablePrivateHandAddress(room.roomId, currentPlayerId, partitionLabel)
    : null;
  const rawPrivateHand = useBitfieldData<unknown>({
    input: 'private-hand',
    params: {
      valueAddressLabel: privateHandValueAddressLabel,
    },
  });
  const privateHand = readPokerTablePrivateHandState(rawPrivateHand, currentPlayerId, room?.roomId ?? null);
  const publicSurface = room ? createPokerTableSurfaceState(room, null) : surface;
  const projection: PokerTableProjectionInput | undefined = publicSurface
    ? {
      ...publicSurface.projection,
      privateHand: privateHand
        ? {
          ownerId: privateHand.ownerId,
          cards: privateHand.cards,
          hidden: true,
          canToggle: true,
        }
        : null,
    }
    : undefined;

  async function commit(nextRoom: PokerRoomState): Promise<void> {
    await sendRoomCommit(nextRoom, roomList);
    setPendingRoom(nextRoom);
    setSeenRoomIds((current) => new Set(current).add(nextRoom.roomId));
    setEndedRoomIds((current) => {
      const next = new Set(current);
      next.delete(nextRoom.roomId);
      return next;
    });
  }

  useEffect(() => {
    function syncRoute() {
      setRouteRoomId(roomIdFromCurrentRoute(props));
    }
    window.addEventListener('popstate', syncRoute);
    return () => window.removeEventListener('popstate', syncRoute);
  }, [props]);

  useEffect(() => {
    setClaimedPlayerId(routeRoomId ? storedText(playerIdStorageKey(routeRoomId)) : '');
  }, [routeRoomId]);

  useEffect(() => {
    if ((authority || projectedRoom) && pendingRoom?.roomId === routeRoomId) {
      setPendingRoom(null);
    }
  }, [authority, projectedRoom, pendingRoom?.roomId, routeRoomId]);

  useEffect(() => {
    if (routeRoomId && (authority || projectedRoom || pendingRouteRoom)) {
      setSeenRoomIds((current) => new Set(current).add(routeRoomId));
      setEndedRoomIds((current) => {
        const next = new Set(current);
        next.delete(routeRoomId);
        return next;
      });
    }
  }, [authority, pendingRouteRoom, projectedRoom, routeRoomId]);

  useEffect(() => {
    if (!routeRoomId || authority || projectedRoom || pendingRouteRoom || !seenRoomIds.has(routeRoomId)) return;
    const listed = roomList.rooms.some((entry) => entry.roomId === routeRoomId);
    if (listed) return;
    setEndedRoomIds((current) => new Set(current).add(routeRoomId));
  }, [authority, pendingRouteRoom, projectedRoom, roomList.rooms, routeRoomId, seenRoomIds]);

  function openRoom(roomId: string, localRoom?: PokerRoomState) {
    canonicalizeRoomRoute(roomId);
    if (localRoom) setPendingRoom(localRoom);
    setRouteRoomId(roomId);
    setEndedRoomIds((current) => {
      const next = new Set(current);
      next.delete(roomId);
      return next;
    });
  }

  function openSetup() {
    setBrowserRoute(POKER_TABLE_ROUTE_PATH);
    setPendingRoom(null);
    setRouteRoomId(null);
  }

  function claimPlayer(roomId: string, playerId: string) {
    storeText(playerIdStorageKey(roomId), playerId);
    setClaimedPlayerId(playerId);
  }

  function markRoomEnded(roomId: string) {
    setSeenRoomIds((current) => new Set(current).add(roomId));
    setEndedRoomIds((current) => new Set(current).add(roomId));
  }

  function sendAction(action: PlayerAction, amount?: number) {
    const actor = room?.state.players[room.state.activeIndex];
    if (!room || !actor || actor.id !== currentPlayerId) return;
    commit(applyPokerRoomPlayerAction(room, action, amount ?? room.state.minRaise));
  }

  async function leaveTable() {
    if (!room || !currentPlayerId) {
      openSetup();
      return;
    }
    const nextRoom = kickPokerRoomPlayer(room, currentPlayerId);
    clearText(playerIdStorageKey(room.roomId));
    if (nextRoom.state.players.length === 0) {
      await sendRequestToBitfieldTarget(buildPokerTableRoomStateResetRequest(room, partitionLabel, roomList));
      markRoomEnded(room.roomId);
      openSetup();
      return;
    }
    await commit(nextRoom);
    openSetup();
  }

  async function endTable() {
    if (!room || currentPlayerId !== room.hostPlayerId) {
      openSetup();
      return;
    }
    await sendRequestToBitfieldTarget(buildPokerTableRoomStateResetRequest(room, partitionLabel, roomList));
    markRoomEnded(room.roomId);
    openSetup();
  }

  return (
    room ? (
      room.state.phase === 'lobby' ? (
        <PokerLobby key={room.roomId} room={room} roomList={roomList} currentPlayerId={currentPlayerId} onClaim={claimPlayer} onCommit={commit} onOpenSetup={openSetup} />
      ) : (
        <Container layout="vertical" gap="sm" width="full">
          <PokerTablePanel
            state={room.state}
            currentPlayerId={currentPlayerId}
            projection={projection}
            controls={{
              canAdvanceStreet: false,
              nextStreetLabel: nextPokerStreetLabel(room.state),
              onAction: sendAction,
              onKickPlayer: (playerId) => {
                if (currentPlayerId === room.hostPlayerId) commit(kickPokerRoomPlayer(room, playerId));
              },
              onNextHand: () => {
                if (currentPlayerId === room.hostPlayerId) commit(nextPokerRoomHand(room));
              },
              tableTools: (
                <PokerActiveTools
                  room={room}
                  isHost={currentPlayerId === room.hostPlayerId}
                  onOpenTables={openSetup}
                  onLeaveTable={() => { void leaveTable(); }}
                  onEndTable={currentPlayerId === room.hostPlayerId ? () => { void endTable(); } : undefined}
                />
              ),
            }}
          />
        </Container>
      )
    ) : routeRoomEnded ? (
      <PokerEndedState onOpenSetup={openSetup} />
    ) : (
      <PokerSetup props={props} roomList={roomList} onClaim={claimPlayer} onOpenRoom={openRoom} />
    )
  );
}

function PokerEndedState({ onOpenSetup }: { onOpenSetup: () => void }) {
  return (
    <ScrollableSurface>
      <Card variant="surface" padding="lg" layout="stack" aria-label="Poker table ended" className="casino-setup">
        <PokerTableStyles />
        <Container layout="vertical" gap="sm" className="casino-setup-hero">
          <div className="casino-setup-mark">♣</div>
          <Text weight="bold" className="casino-setup-title">
            Table ended
          </Text>
        </Container>
        <Card variant="nested" padding="md" layout="stack" className="casino-setup-roster">
          <Text variant="heading">This table is closed.</Text>
          <Text variant="body-xs" color="muted">Open Tables to join or create a table.</Text>
        </Card>
        <Button type="button" size="lg" variant="primary" className="casino-primary-action" onClick={onOpenSetup}>
          Tables
        </Button>
      </Card>
    </ScrollableSurface>
  );
}

function PokerWorkspaceMaterial() {
  return (
    <EmbeddedScreenArrangement
      initialState={POKER_WORKSPACE_LAYOUT_STATE}
      layoutEntryInput={POKER_WORKSPACE_LAYOUT_STATE_INPUT}
      placeableSurfaceListAddressLabel={POKER_WORKSPACE_PLACEABLE_SURFACE_LIST_ADDRESS_LABEL}
      persistence={{ valueAddressLabel: POKER_WORKSPACE_LAYOUT_STATE_ADDRESS_LABEL }}
      acceptPersistedState={acceptsPokerWorkspaceLayoutState}
      chrome={{ 'header.actions': false, 'header.new-tab': false }}
    />
  );
}

export function PokerTableMaterial({ props }: { props: Record<string, unknown> }) {
  const surfacePart = readPokerSurfacePart(props);
  return (
    <FloatingMaterialFrame frame={props.floating_frame}>
      <ErrorBoundary zoneName="poker table material">
        {surfacePart === 'workspace' ? (
          <PokerWorkspaceMaterial />
        ) : (
          <Suspense fallback={<PokerSetup props={props} roomList={createPokerTableRoomListState()} />}>
            <PokerTableStateGate props={props} />
          </Suspense>
        )}
      </ErrorBoundary>
    </FloatingMaterialFrame>
  );
}

export default function mount({ el, props = {} }: MountArgs) {
  return mountReactSurface(el, <PokerTableMaterial props={props} />);
}
