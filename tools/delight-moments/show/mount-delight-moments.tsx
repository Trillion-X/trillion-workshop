// parts/delight-moments/show/mount-delight-moments.tsx
//
// NO PRIOR: searched bitfield-packages/packages/*/show for "confetti", "celebrat" and "delight", and the
// 21st.dev MCP for a celebration moment; this is the one player for the moment rows.
//
// PURPOSE
//   The part's entry: mounts once at the app shell and plays the moment a row in records/delight-moments.json picks for
//   each good thing that happens (parts/ui/show/happened: a tour finished, work done) and for a phrase typed anywhere.
//   It draws nothing until a moment plays, one at a time; a moment that arrives while another plays waits its turn.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Which moment answers which event is the rows' DATA (read-data/choose-moment.mjs); nothing here names an event,
//      a phrase or a moment.
//   2. What is remembered (how often each kind happened, which once-only moments played) stays on this device, under
//      one key, and holds no words the person typed: only counts.
//   3. Typed characters are kept in memory only, at most as many as the longest phrase a row waits for, and never from
//      a password field.
//
// The extensive documentation in this codebase is a critical design feature. You are forbidden from simplifying
// or removing it.

import React, { useEffect, useRef, useState } from 'react';
import { ErrorBoundary, mountReactSurface } from '../../ui';
import { onHappened } from '../../ui/show/happened/happened';
import { DelightMomentLayer, type DelightMotion } from '../../ui/show/delight-moment/DelightMoment';
import {currentPresentationRows} from '../../ui/show/request/current-presentation-rows.mjs';
import { chooseMoment, longestTypedPhrase, typedMoment } from 'trillion-workshop/tools/make-things-feel-good/read-data/choose-moment.mjs';

type Rows = { motions: Record<string, DelightMotion>; moments: Array<Record<string, unknown>> };
type Picked = { id: string; motion: string; mark: string; words: string };
type Memory = { counts: Record<string, number>; played: Record<string, number> };

const MEMORY_KEY = 'trillion:delight-moments';

function readMemory(): Memory {
  try {
    const saved = JSON.parse(window.localStorage.getItem(MEMORY_KEY) ?? 'null');
    if (saved && typeof saved === 'object') return { counts: saved.counts ?? {}, played: saved.played ?? {} };
  } catch {
    // An unreadable memory starts again from nothing.
  }
  return { counts: {}, played: {} };
}

function keepMemory(memory: Memory): void {
  try {
    window.localStorage.setItem(MEMORY_KEY, JSON.stringify(memory));
  } catch {
    // A device that keeps nothing still plays every moment; once-only moments may then play again.
  }
}

function DelightMoments({ rows, source, subscribe }: { rows: Rows; source?:()=>Promise<Rows>; subscribe?:(changed:()=>Promise<void>)=>(()=>void) }) {
  const [queue, setQueue] = useState<Array<Picked & { key: string; selectedMotion:DelightMotion }>>([]);
  const typed = useRef('');

  useEffect(() => {
    let next = 0;
    const current=currentPresentationRows({rows,source,subscribe,onRows:selected=>{typed.current='';setQueue(waiting=>selected?waiting.filter(item=>selected.moments.some(row=>row.id===item.id)&&selected.motions[item.motion]):[]);},failed:error=>{console.warn('Delight rows could not be read.',error);}});
    const play = (picked: { moment: Picked | null; remember: Memory },selected:Rows) => {
      keepMemory(picked.remember);
      const moment = picked.moment;
      if (moment && selected.motions[moment.motion]) setQueue(waiting => [...waiting, { ...moment, selectedMotion:selected.motions[moment.motion],key: `${moment.id}-${(next += 1)}` }]);
    };
    const consume=(pick:(selected:Rows)=>{moment:Picked|null;remember:Memory})=>{const selected=current.read();if(selected)play(pick(selected),selected);};
    const stopHappened = onHappened(detail => consume(selected=>chooseMoment(selected.moments, detail, readMemory())));
    const onKey = (event: KeyboardEvent) => {
      const latest=current.read();if(!latest)return;
      const longest=longestTypedPhrase(latest.moments);
      if (!longest || event.key.length !== 1 || event.metaKey || event.ctrlKey) return;
      if ((event.target as HTMLInputElement | null)?.type === 'password') return;
      typed.current = (typed.current + event.key).slice(-longest);
      const picked = typedMoment(latest.moments, typed.current, readMemory());
      if (picked.moment) {
        const selectedText=typed.current;typed.current = '';
        consume(selected=>typedMoment(selected.moments,selectedText,readMemory()));
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      current.stop();stopHappened();
      window.removeEventListener('keydown', onKey, true);
    };
  }, [rows, source, subscribe]);

  const current = queue[0] ?? null;
  return (
    <DelightMomentLayer
      moment={current ? { key: current.key, mark: current.mark, words: current.words, motion: current.selectedMotion } : null}
      onDone={() => setQueue(waiting => waiting.slice(1))}
    />
  );
}

export default function mountDelightMoments({ el, props }: { el: HTMLElement; props: { rows: Rows; source?:()=>Promise<Rows>; subscribe?:(changed:()=>Promise<void>)=>(()=>void) } }) {
  return mountReactSurface(
    el,
    <ErrorBoundary zoneName="delight moments">
      <DelightMoments rows={props.rows} source={props.source} subscribe={props.subscribe} />
    </ErrorBoundary>,
  );
}
