// src/workspace/conversation-presence.ts
//
// PURPOSE
//   Who else is in a conversation right now, and who is typing. A space's board room (src/board-room.mjs) already
//   relays awareness between the people on one of its views; this is the conversation's use of it: the Messages screen
//   watches the room's messages view, the composer says the person is typing, and a hidden or idle tab says it is
//   connected but not present.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Reference-counted: one room socket per (room, view) however many things on screen watch it; the first watcher
//      opens it, the last one to leave closes it, and nothing is open while nothing watches (the subscription is what is
//      on screen, not what is loaded).
//   2. Typing carries no words: only the word `typing_word` (conversation-presence.json), sent at most every
//      `typing_every_ms`, and it lapses by itself after `typing_for_ms` without another edit.
//   3. Connected is not present: when the tab is hidden or `idle_after_ms` passes without an edit, the person is sent as
//      `passive`, and back to present on the next edit or when the tab is shown. Typing is never claimed while passive.
//   4. What others send is awareness, never content; a person not heard from within `heard_for_ms`, or who the room says
//      is gone, is not shown. Words and times are DATA (conversation-presence.json).

import { openPresenceRoom } from '../../parts/group/show/presence-channel';
import { activeParticipants, removePresence, upsertPresence, type Participant, type PresenceState } from '../../parts/group/read-data/presence';
import settings from './conversation-presence.json';

export type Person = { id: string; name: string; typing: boolean; passive: boolean };
type Channel = { publish: (p: Participant) => void; close: () => void };
type Open = (room: string, onUpdate: (p: Participant) => void, view: string) => Channel;
type Timers = { now: () => number; after: (run: () => void, ms: number) => unknown; cancel: (handle: unknown) => void };

const realTimers: Timers = { now: Date.now, after: (run, ms) => setTimeout(run, ms), cancel: handle => clearTimeout(handle as ReturnType<typeof setTimeout>) };

/** The hub: watch a conversation's room, say typing, and go passive. `open` and `timers` are the transport and clock. */
export function createConversationPresence(open: Open = (room, onUpdate, view) => openPresenceRoom(room, onUpdate, view), timers: Timers = realTimers) {
  type Watch = { channel: Channel; state: PresenceState; listeners: Set<(people: Person[]) => void>; typingUntil: number; lastSent: number; stop: unknown; passive: boolean; idle: unknown };
  const watches = new Map<string, Watch>();
  const keyOf = (room: string) => `${room}|${settings.view}`;

  const people = (watch: Watch): Person[] => activeParticipants(watch.state, timers.now(), settings.heard_for_ms)
    .map(p => ({ id: p.id, name: p.name, typing: p.doing === settings.typing_word && !p.passive, passive: p.passive === true }));
  const tell = (watch: Watch) => { const now = people(watch); watch.listeners.forEach(listener => listener(now)); };
  const send = (watch: Watch, typing: boolean) => {
    watch.lastSent = timers.now();
    watch.channel.publish({ id: 'self', name: '', ts: watch.lastSent, selection: [], ...(typing && !watch.passive ? { doing: settings.typing_word } : {}), ...(watch.passive ? { passive: true } : {}) });
  };
  const setPassive = (watch: Watch, passive: boolean) => {
    if (watch.passive === passive) return;
    watch.passive = passive;
    send(watch, false);
  };
  const armIdle = (watch: Watch) => {
    if (watch.idle) timers.cancel(watch.idle);
    watch.idle = timers.after(() => setPassive(watch, true), settings.idle_after_ms);
  };

  return {
    /** Watches `room`'s conversation view; `listener` hears the people there now. Returns how to stop. */
    watch(room: string, listener: (people: Person[]) => void): () => void {
      const key = keyOf(room);
      let watch = watches.get(key);
      if (!watch) {
        const made: Watch = { channel: null as unknown as Channel, state: {}, listeners: new Set(), typingUntil: 0, lastSent: 0, stop: null, passive: false, idle: null };
        made.channel = open(room, update => {
          made.state = update.gone ? removePresence(made.state, update.id) : upsertPresence(made.state, update);
          tell(made);
        }, settings.view);
        armIdle(made);
        watches.set(key, made);
        watch = made;
      }
      watch.listeners.add(listener);
      listener(people(watch));
      const held = watch;
      return () => {
        held.listeners.delete(listener);
        if (held.listeners.size) return;
        if (held.stop) timers.cancel(held.stop);
        if (held.idle) timers.cancel(held.idle);
        held.channel.close();
        watches.delete(key);
      };
    },
    /** The person edited the composer in `room`'s conversation: say typing (at most every typing_every_ms), lapse after typing_for_ms. */
    typing(room: string): void {
      const watch = watches.get(keyOf(room));
      if (!watch) return;
      const wasPassive = watch.passive;
      watch.passive = false;
      armIdle(watch);
      watch.typingUntil = timers.now() + settings.typing_for_ms;
      if (wasPassive || timers.now() - watch.lastSent >= settings.typing_every_ms) send(watch, true);
      if (watch.stop) timers.cancel(watch.stop);
      watch.stop = timers.after(() => { if (timers.now() >= watch.typingUntil) send(watch, false); }, settings.typing_for_ms);
    },
    /** The tab was hidden (passive) or shown again (present). */
    visible(room: string, shown: boolean): void {
      const watch = watches.get(keyOf(room));
      if (!watch) return;
      if (shown) armIdle(watch);
      setPassive(watch, !shown);
    },
    /** How many rooms are open now (for tests and diagnostics). */
    open: () => watches.size,
  };
}

/** The page's one hub. */
export const conversationPresence = createConversationPresence();

const fill = (template: string, values: Record<string, string | number>) => template.replace(/\{(\w+)\}/g, (whole, key) => String(values[key] ?? whole));

/** What to say under the conversation about the others in it, in the person's words (conversation-presence.json); '' for no one. */
export function presenceWords(others: readonly Person[]): string {
  const typing = others.filter(person => person.typing);
  if (typing.length === 1) return fill(settings.typing_one, { name: typing[0].name });
  if (typing.length === 2) return fill(settings.typing_two, { first: typing[0].name, second: typing[1].name });
  if (typing.length > 2) return settings.typing_many;
  const here = others.filter(person => !person.passive);
  const away = others.filter(person => person.passive);
  const parts = [
    here.length === 1 ? fill(settings.here_one, { name: here[0].name }) : here.length > 1 ? fill(settings.here_many, { count: here.length }) : '',
    away.length === 1 ? fill(settings.away_one, { name: away[0].name }) : away.length > 1 ? fill(settings.away_many, { count: away.length }) : '',
  ];
  return parts.filter(Boolean).join(' · ');
}

/** The line under a conversation with one AI: whether it has said it is present (agent_presence), in the words of conversation-presence.json. */
export const aiPresenceWords = (ai: { name: string; present: boolean } | null): string =>
  ai ? (ai.present ? settings.ai_here : settings.ai_away).replace('{name}', ai.name) : '';
