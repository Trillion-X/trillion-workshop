// src/workspace/mentions.ts
//
// PURPOSE
//   What `@` offers in the message box on every screen: the person's own AIs, spaces, files, workflows, automations,
//   schedules, actions and every kind of record they keep, and the members of the space being written in, read from
//   /work/api/mentions (src/work-mentions.mjs, whose rows in src/mention-sources.json say where each kind is read and
//   how it looks). Files, actions and records are searched as the person types after `@`. Also where a mention opens
//   (the screen whose `opens_kinds` names its kind), for every record chip on a screen (useMentionChips). With the
//   person's records kept on this device (device-copy.ts), the record rows are answered from there or the store's own
//   find, whichever answers first, and offline.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Nothing here names a kind; the kinds and their looks come back with the candidates.
//   2. A read that fails leaves the box working with whatever was read; the box never waits for mentions.
//   3. Where a kind opens is the screens' own DATA (surfaces.json `opens_kinds`); a kind no screen opens draws still.

import React from 'react';
import type { MentionCandidate, MentionKind } from '../../parts/ui/show/mention-field';
import type { RecordChipSetting } from '../../parts/ui/show/record-chip';
import { thingAddress } from './addresses.mjs';
import { readJson } from './api';
import { openAddress } from './open-screen';
import surfaces from './screens.mjs';

/** A kind's look, and `hands_off`: in a space, a message mentioning one is handed to it as a job. */
export type AppMentionKind = MentionKind & { hands_off?: boolean };
type Mentions = { kinds: Record<string, AppMentionKind>; candidates: MentionCandidate[] };
const EMPTY: Mentions = { kinds: {}, candidates: [] };
const read = (space: string | undefined, query = '') => readJson<Mentions>(`/work/api/mentions?${new URLSearchParams({ ...(space ? { space } : {}), ...(query ? { q: query } : { initial: 'true' }) })}`);
const key = (one: MentionCandidate) => `${one.kind}\u0000${one.value}`;

// The record rows, from whichever of this device's copy (microseconds, and offline) and the store's own find answers
// first (device-copy.ts findRecordsFirst). device-copy.ts is loaded once the page is idle (main.tsx), so the first
// paint never carries it and offline it is already here.
const recordsFirst = async (space: string | undefined, query: string): Promise<Mentions> =>
  (await import('./device-copy')).recordMentionsFirst(space ?? '', query) as Promise<Mentions>;

/** The Composer's mention props for a box written in `space` (none: the person's own things only). */
export function useMentions(space?: string) {
  const [base, setBase] = React.useState<Mentions>(EMPTY);
  const [found, setFound] = React.useState<MentionCandidate[]>([]);
  React.useEffect(() => {
    let live = true;
    // An answer missing either part (an older Worker) leaves the box with what it has.
    read(space).then(answer => { if (live) setBase({ kinds: answer?.kinds ?? {}, candidates: answer?.candidates ?? [] }); }, () => undefined);
    return () => { live = false; };
  }, [space]);
  const asked = React.useRef('');
  const onMentionQuery = React.useCallback((query: string | null) => {
    const sought = (query ?? '').trim();
    asked.current = sought;
    if (sought.length < 2) { setFound([]); return; }
    // The person's records answer first (this device's copy or the store's find, whichever is quicker); the store's
    // answer for every source then takes its place.
    let stored = false;
    const take = (answer: Mentions, final: boolean) => {
      if (asked.current !== sought || (stored && !final)) return;
      stored ||= final;
      setBase(current => ({ ...current, kinds: { ...current.kinds, ...answer?.kinds } }));
      setFound(current => (final ? [...(answer?.candidates ?? []), ...current.filter(one => !(answer?.candidates ?? []).some(other => key(other) === key(one)))] : answer?.candidates ?? []));
    };
    recordsFirst(space, sought).then(answer => { if (answer.candidates.length) take(answer, false); }, () => undefined);
    read(space, sought).then(answer => take(answer, true), () => undefined);
  }, [space]);
  const mentions = React.useMemo(() => {
    const seen = new Set(base.candidates.map(key));
    return [...base.candidates, ...found.filter(one => !seen.has(key(one)))];
  }, [base, found]);
  return { mentions, mentionKinds: base.kinds, onMentionQuery };
}

/** Where a mentioned thing opens: the one address of a thing (addresses.mjs thingAddress), from the screens' own
 *  `opens_kinds`; null when no screen opens its kind. */
export const mentionAddress = (kind: string, value: string): string | null => thingAddress(surfaces, kind, value);

/** What every record chip beneath a screen needs: how each kind looks, where each thing opens, and opening it in place. */
export const useMentionChips = (kinds: Record<string, MentionKind>): RecordChipSetting =>
  React.useMemo(() => ({ kinds, hrefOf: mentionAddress, open: openAddress }), [kinds]);
