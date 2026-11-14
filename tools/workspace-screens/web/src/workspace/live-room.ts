// src/workspace/live-room.ts
//
// PURPOSE
//   The page's one connection to a live room: a shared store the Worker opens as a records socket (src/board-room.mjs),
//   holding records by address that every member reading it sees change the moment anyone changes them. A space's
//   board is one room; every record placed in that space (src/workspace/record-places.json, through records.ts) lives
//   in the same room, so a board card and a Write page can be one record that both screens show live.
//
// NON-NEGOTIABLE INVARIANTS
//   1. One carrier connection per room and carrier binding per page; callers sharing a binding share it.
//   2. The whole room arrives when the carrier opens (`board`), then every change another member makes (`records`);
//      `known` always holds what the room last said, and every listener hears it in that order.
//   3. A change names the value it started from (`base`, what this page last knew), so two members changing one record
//      at once both keep their change (the room merges); the answer is what the room now holds, and `change` resolves
//      true when that differs from what was sent (someone else's change was merged in).
//   4. A dropped carrier reconnects with bounded exponential backoff; pending changes fail closed and are never blindly
//      replayed. `opened` waits for the next whole room.
//   5. This module does not choose a physical transport for installed bindings. Its default binding preserves the
//      current same-origin WebSocket/WSS route.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import settings from './live-room.json';

export type RoomRecord = { address: string; value: unknown };
type Answer = { records?: RoomRecord[]; error?: string };
type Listener = (records: readonly RoomRecord[], whole: boolean) => void;
export type LiveRoomCarrierConnection = { send(data: string): void; close(): void };
export type LiveRoomCarrierHandlers = { message(data: unknown): void; close(ended?: boolean): void; error?(): void };
/** Opaque host-installed carrier binding. `identity` is its cache identity, not a transport/provider choice. */
export type LiveRoomCarrier = { identity: object; connect(path: string, handlers: LiveRoomCarrierHandlers): LiveRoomCarrierConnection };
export type LiveRoomOptions = { carrier?: LiveRoomCarrier };

export type LiveRoom = {
  readonly known: Map<string, unknown>;
  opened(): Promise<void>;
  change(changes: readonly RoomRecord[]): Promise<boolean>;
  listen(listener: Listener): () => void;
};

type Open = LiveRoom & { users: number; close: () => void; key: string };
const rooms = new Map<string, Open>();
const defaultIdentity = {};
const defaultCarrier: LiveRoomCarrier = {
  identity: defaultIdentity,
  connect(path, handlers) {
    const next = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}${path}`);
    next.onmessage = event => handlers.message(event.data);
    next.onclose = event => handlers.close(event.code === 4401 || event.code === 4403);
    next.onerror = () => handlers.error?.();
    return { send: data => next.send(data), close: () => next.close() };
  },
};
const bindingIds = new WeakMap<object, number>();
let nextBindingId = 1;
function roomKey(path: string, identity: object): string {
  let id = bindingIds.get(identity);
  if (!id) { id = nextBindingId++; bindingIds.set(identity, id); }
  return `${id}\u0000${path}`;
}

function connect(path: string, carrier: LiveRoomCarrier, key: string): Open {
  const known = new Map<string, unknown>();
  const listeners = new Set<Listener>();
  const waiting = new Map<string, { resolve: (answer: Answer) => void; timer: ReturnType<typeof setTimeout> }>();
  let connection: LiveRoomCarrierConnection | null = null;
  let stopped = false;
  let ended = false;
  let failures = 0;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let isOpen = false;
  let openResolve!: () => void;
  let openReject!: (error: Error) => void;
  let opened = new Promise<void>((resolve, reject) => { openResolve = resolve; openReject = reject; });
  // Avoid an unhandled rejection when a consumer releases a room before calling opened().
  void opened.catch(() => {});
  const failWaiting = () => {
    for (const [request, pending] of waiting) {
      clearTimeout(pending.timer);
      pending.resolve({ error: settings.words.not_kept });
      waiting.delete(request);
    }
  };
  const scheduleRetry = () => {
    if (stopped || ended || retry) return;
    retry = setTimeout(() => { retry = null; open(); }, Math.min(settings.reconnect_after_ms * 2 ** failures, settings.most_reconnect_after_ms));
  };
  const open = () => {
    if (stopped || ended) return;
    let current: LiveRoomCarrierConnection;
    let connected = false;
    const queued: (() => void)[] = [];
    const dispatch = (event: () => void) => { if (connected) event(); else queued.push(event); };
    try {
      current = carrier.connect(path, {
        message(data) { dispatch(() => {
          if (connection !== current || stopped) return;
          let message: Answer & { type?: string; request?: string };
          try { message = JSON.parse(String(data)); } catch { return; }
          if (message.type === 'ended' || message.type === 'auth-ended') {
            ended = true; isOpen = false; failWaiting(); openReject(new Error(settings.words.not_kept));
            try { current.close(); } catch {} return;
          }
          if (message.type === 'changed' && message.request) {
            const pending = waiting.get(message.request);
            if (pending) { clearTimeout(pending.timer); waiting.delete(message.request); pending.resolve(message); }
            return;
          }
          const whole = message.type === 'board';
          if (whole) known.clear();
          const records = message.records ?? [];
          for (const record of records) known.set(record.address, record.value);
          if (whole) { failures = 0; isOpen = true; markOpened(); }
          for (const listener of listeners) listener(records, whole);
        }); },
        close(wasEnded = false) { dispatch(() => {
          if (connection !== current || stopped) return;
          connection = null; isOpen = false; failWaiting();
          if (wasEnded) { ended = true; openReject(new Error(settings.words.not_kept)); return; }
          if (!openedSettled) { failures += 1; }
          else { openedSettled = false; opened = new Promise<void>((resolve, reject) => { openResolve = resolve; openReject = reject; }); void opened.catch(() => {}); failures += 1; }
          scheduleRetry();
        }); },
        error() { /* The close callback owns recovery; never replay an uncertain request here. */ },
      });
      connection = current;
      connected = true;
      for (const event of queued) event();
    } catch {
      failures += 1; scheduleRetry();
    }
  };
  let openedSettled = false;
  const markOpened = () => { if (!openedSettled) { openedSettled = true; openResolve(); } };
  open();

  return {
    key, known, users: 0,
    opened: () => ended ? Promise.reject(Object.assign(new Error(settings.words.not_kept), { status: 403 })) : opened,
    listen(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async change(changes) {
      if (!changes.length) return false;
      await opened;
      if (stopped || ended || !isOpen || !connection) throw new Error(settings.words.not_kept);
      const request = `change-${crypto.randomUUID()}`;
      const sent = changes.map(one => ({ address: one.address, base: known.get(one.address) ?? null, value: one.value }));
      let timer: ReturnType<typeof setTimeout>;
      const answered = new Promise<Answer>((resolve, reject) => {
        timer = setTimeout(() => { waiting.delete(request); reject(new Error(settings.words.not_kept)); }, settings.change_wait_ms);
        waiting.set(request, { resolve, timer });
      });
      try { connection.send(JSON.stringify({ request, changes: sent })); }
      catch {
        const pending = waiting.get(request); if (pending) clearTimeout(pending.timer);
        waiting.delete(request); throw new Error(settings.words.not_kept);
      }
      const { records = [], error } = await answered;
      if (error) throw new Error(error);
      let merged = false;
      for (const record of records) {
        if (JSON.stringify(changes.find(one => one.address === record.address)?.value) !== JSON.stringify(record.value)) merged = true;
        known.set(record.address, record.value);
      }
      return merged;
    },
    close() {
      if (stopped) return;
      stopped = true; isOpen = false;
      if (retry) clearTimeout(retry);
      failWaiting(); openReject(new Error(settings.words.not_kept));
      const old = connection; connection = null;
      try { old?.close(); } catch {}
    },
  };
}

/** Open a room at `path`; an installed host may supply its already-resolved opaque carrier binding. */
export function openLiveRoom(path: string, supplied?: LiveRoomCarrier | LiveRoomOptions): { room: LiveRoom; release: () => void } {
  const carrier = supplied && 'carrier' in supplied ? supplied.carrier ?? defaultCarrier : supplied ?? defaultCarrier;
  const key = roomKey(path, carrier.identity);
  let room = rooms.get(key);
  if (!room) { room = connect(path, carrier, key); rooms.set(key, room); }
  room.users += 1;
  let released = false;
  const held = room;
  return {
    room: held,
    release: () => {
      if (released) return;
      released = true;
      held.users -= 1;
      if (held.users > 0) return;
      held.close();
      if (rooms.get(key) === held) rooms.delete(key);
    },
  };
}
