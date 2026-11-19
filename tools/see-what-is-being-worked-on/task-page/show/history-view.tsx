// History: a timeline rail holds still at the top of the page; drag it, click a dot, scroll over it, use the arrow keys
// or Play to move through the moments (every time a task was made or changed: the change rows of the task tables).
// Below it, the one checklist shows the task tree as it stood at that moment, and the page scrolls normally to read it.
// A row with rows under it is a goal: never ticked itself, its ring shows how many of the work items under it, at any
// depth, were done, and its own status shows beside it when that is not done. A row with nothing under it is a work
// item, the only thing that gets a tick. A row not made yet is faint.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { faint, goalComplete, momentsOf, muted, plain, standing, statusWord, tally, treeOf, when, type Data, type Moment, type Task, type Tree } from '../read-data/task-rows';
import { Chevron, Detail, Mark, Ring, Word } from './task-marks';

const STOP = 36; // the room between two moments' dots on the rail, in pixels
const SWIPE_PER_MOMENT = 30; // trackpad scroll over the timeline, in pixels, that moves one moment
const PLAY_STEP_MS = 600;
const INDENT = 24;

function Checklist({ data, tree, moments, index }: { data: Data; tree: Tree; moments: Moment[]; index: number }) {
  const looks = useMemo(() => new Map(data.statuses.map(s => [s.name, s])), [data]);
  const { made, status } = useMemo(() => standing(moments, index), [moments, index]);
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<Set<string>>(new Set());
  const flip = (set: (f: (s: Set<string>) => Set<string>) => void, id: string) => set(now => { const next = new Set(now); if (!next.delete(id)) next.add(id); return next; });
  const lookOf = (id: string) => (made.has(id) ? looks.get(status.get(id) ?? '') : undefined);

  const item = (task: Task, depth: number) => {
    const look = lookOf(task.id), isMade = made.has(task.id), isOpen = open.has(task.id);
    return (
      <li key={task.id} style={{ paddingLeft: depth * INDENT, color: isMade ? 'var(--color-foreground)' : faint }}>
        <button type="button" className="tl-row min-h-9 py-1.5" aria-expanded={isOpen} aria-controls={`tl-${task.id}`} onClick={() => flip(setOpen, task.id)}>
          <Mark look={look} made={isMade} />
          <span className="min-w-0 flex-1 text-[15px] leading-6">{plain(task)}</span>
          <Word look={statusWord(look)} />
          <Chevron open={isOpen} />
        </button>
        {isOpen && <Detail id={`tl-${task.id}`} detail={task.plain_detail} title={task.title} />}
      </li>
    );
  };

  const goal = (task: Task, depth: number, first: boolean) => {
    const leaves = tree.items.get(task.id) ?? [], count = tally(leaves, lookOf), own = lookOf(task.id), isOpen = !closed.has(task.id);
    const seen = made.has(task.id) || leaves.some(id => made.has(id));
    const size = depth === 0 ? 'text-[20px] leading-7' : 'text-[16px] leading-6';
    return (
      <li key={task.id} className={first ? '' : depth === 0 ? 'mt-7' : 'mt-4'} style={{ paddingLeft: depth * INDENT }}>
        <button type="button" className="tl-row min-h-9 py-1" aria-expanded={isOpen} aria-controls={`tl-${task.id}`} onClick={() => flip(setClosed, task.id)}
          style={{ color: seen ? 'var(--color-foreground)' : faint }}>
          <span style={{ opacity: seen ? 1 : 0.45, display: 'inline-flex' }}><Ring done={count.done} total={count.total} complete={goalComplete(own, count)} /></span>
          <span className={`min-w-0 flex-1 font-semibold ${size}`}>{plain(task)}</span>
          <span className="flex-none text-[13px] tabular-nums" style={{ color: muted }}>{count.done} of {count.total} steps</span>
          <Word look={statusWord(own, true)} />
          <Chevron open={isOpen} />
        </button>
        {isOpen && <ul id={`tl-${task.id}`} className="m-0 list-none p-0 pb-1">{rows(task.id, 1)}</ul>}
      </li>
    );
  };

  const rows = (parent: string | null, depth: number) =>
    (tree.kids.get(parent) ?? []).map((task, i) => ((tree.kids.get(task.id) ?? []).length ? goal(task, depth, i === 0) : item(task, depth)));

  return (
    <article className="box-border w-full rounded-2xl border px-6 py-4" style={{ borderColor: 'var(--color-border)', background: 'var(--color-card)', boxShadow: 'var(--page-shadow)' }}>
      <ul className="m-0 list-none p-0">{rows(null, 0)}</ul>
    </article>
  );
}

export function HistoryView({ data }: { data: Data }) {
  const moments = useMemo(() => momentsOf(data), [data]);
  const looks = useMemo(() => new Map(data.statuses.map(s => [s.name, s])), [data]);
  const tree = useMemo(() => treeOf(data, looks), [data, looks]);
  const count = moments.length, last = count - 1;
  // `pinned` is the moment the reader chose; null follows the newest moment as new ones arrive.
  const [pinned, setPinned] = useState<number | null>(null);
  const index = pinned === null ? last : Math.min(pinned, last);
  const goTo = (i: number) => setPinned(i >= last ? null : Math.max(0, i));
  const [playing, setPlaying] = useState(false);
  const [dragAt, setDragAt] = useState<number | null>(null);
  const shown = dragAt ?? index;
  const { status } = useMemo(() => standing(moments, index), [moments, index]);
  const work = tally(tree.allItems, id => looks.get(status.get(id) ?? ''));

  useEffect(() => {
    if (!playing) return;
    if (index >= last) { setPlaying(false); return; }
    const timer = setTimeout(() => goTo(index + 1), PLAY_STEP_MS);
    return () => clearTimeout(timer);
  }, [playing, index, last]);
  const play = () => { if (!playing && index >= last) setPinned(0); setPlaying(!playing); };

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest?.('input, textarea')) return;
      const to = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: last }[e.key];
      if (to === undefined) return;
      e.preventDefault(); setPlaying(false); goTo(to);
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  });

  // Scrolling over the timeline band (its date, rail and what-happened line) moves through time; anywhere else the page
  // scrolls as usual. A mouse wheel's notch is one moment; a trackpad's small steps add up, SWIPE_PER_MOMENT a moment.
  const rail = useRef<HTMLDivElement>(null), band = useRef<HTMLDivElement>(null), swipe = useRef(0);
  const [hinted, setHinted] = useState(false);
  useEffect(() => {
    const box = band.current; if (!box) return;
    const wheel = (e: WheelEvent) => {
      if (!(e.target as HTMLElement).closest('[data-time-scroll]')) return;
      const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      if (!d) return;
      e.preventDefault();
      let steps: number;
      if (e.deltaMode !== 0 || Math.abs(d) >= 50) { steps = Math.sign(d); swipe.current = 0; }
      else { swipe.current += d; steps = Math.trunc(swipe.current / SWIPE_PER_MOMENT); swipe.current -= steps * SWIPE_PER_MOMENT; }
      if (steps) { setHinted(true); setPlaying(false); setPinned(p => { const at = (p ?? last) + steps; return at >= last ? null : Math.max(0, at); }); }
    };
    box.addEventListener('wheel', wheel, { passive: false });
    return () => box.removeEventListener('wheel', wheel);
  }, [last]);

  const drag = useRef<{ x: number; from: number; moved: boolean } | null>(null);
  const onDown = (e: React.PointerEvent) => { drag.current = { x: e.clientX, from: index, moved: false }; };
  const onMove = (e: React.PointerEvent) => {
    if (!drag.current) return;
    const dx = e.clientX - drag.current.x;
    if (!drag.current.moved && Math.abs(dx) > 4) { drag.current.moved = true; rail.current?.setPointerCapture(e.pointerId); setPlaying(false); }
    if (drag.current.moved) setDragAt(Math.min(last, Math.max(0, drag.current.from - dx / STOP)));
  };
  const onUp = () => {
    if (drag.current?.moved && dragAt !== null) goTo(Math.round(dragAt));
    setDragAt(null);
    setTimeout(() => { drag.current = null; }, 0);
  };
  const near = Math.round(shown), moment = moments[near];

  return (
    <div className="pb-16">
      <div ref={band} className="sticky top-0 z-10 flex flex-col gap-1.5 pb-4 pt-5" style={{ background: 'var(--page-bg)' }}>
        <div data-time-scroll className="flex flex-col gap-1.5">
        <div className="relative mx-auto box-border w-full max-w-[784px] px-6">
          <p className="m-0 text-center text-[13px] leading-5 tabular-nums" style={{ color: muted }}>{when(moment.at)}</p>
          <p aria-hidden={hinted} className="pointer-events-none absolute right-6 top-0 m-0 text-[12px] leading-5" style={{ color: muted, opacity: hinted ? 0 : 1, transition: 'opacity .25s' }}>Scroll here to move through time</p>
        </div>
        <div ref={rail} className="relative h-6 cursor-grab select-none overflow-hidden active:cursor-grabbing" role="slider" tabIndex={0} aria-label="Moment"
          aria-valuemin={1} aria-valuemax={count} aria-valuenow={index + 1} aria-valuetext={`${when(moments[index].at)}: ${moments[index].label}`}
          style={{ touchAction: 'pan-y', maskImage: 'linear-gradient(90deg, transparent, #000 22%, #000 78%, transparent)' }}
          onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
          <div className="absolute inset-x-0 top-1/2 h-px" style={{ background: 'var(--color-border)' }} />
          <ol className="absolute inset-y-0 left-1/2 m-0 flex list-none p-0" style={{ transform: `translateX(${-(shown + 0.5) * STOP}px)` }}>
            {moments.map((m, i) => (
              <li key={m.at} className="flex-none" style={{ width: STOP }}>
                <button type="button" tabIndex={-1} className="flex h-full w-full cursor-pointer items-center justify-center border-0 bg-transparent p-0" title={`${when(m.at)}: ${m.label}`}
                  aria-label={`${when(m.at)}: ${m.label}`} onClick={() => { if (!drag.current?.moved) { setPlaying(false); goTo(i); } }}>
                  <span className="block rounded-full" style={{ width: 8, height: 8, boxSizing: 'border-box', border: `1.5px solid ${i <= near ? 'var(--color-foreground)' : 'color-mix(in srgb, var(--color-foreground) 35%, transparent)'}`, background: i < near ? 'color-mix(in srgb, var(--color-foreground) 45%, transparent)' : i === near ? 'var(--color-foreground)' : 'var(--page-bg)', transition: 'background-color .25s, border-color .25s' }} />
                </button>
              </li>
            ))}
          </ol>
          <span aria-hidden="true" className="pointer-events-none absolute left-1/2 top-0 h-full w-px -translate-x-1/2" style={{ background: 'var(--color-foreground)' }} />
        </div>
        <p className="m-0 mx-auto box-border w-full max-w-[784px] truncate px-6 text-center text-[16px] leading-6">
          <span className="font-semibold">{moment.label}:</span> {moment.title}
        </p>
        </div>
        <div className="mx-auto mt-3 box-border flex w-full max-w-[784px] flex-col gap-2 px-6">
          <div className="flex items-center gap-2">
            <span className="text-[22px] font-semibold leading-7 tabular-nums">{work.done}</span>
            <span className="text-[15px]" style={{ color: muted }}>of {work.total} work items done</span>
            <button type="button" className="tl-control ml-auto flex cursor-pointer items-center gap-1.5 rounded-full border bg-transparent px-3 py-1 text-[13px]"
              style={{ borderColor: 'var(--color-border)', color: 'var(--color-foreground)' }} onClick={play} aria-pressed={playing}>
              <svg aria-hidden="true" viewBox="0 0 12 12" width="10" height="10" fill="currentColor">{playing ? <path d="M2.5 1.5h2.5v9H2.5zM7 1.5h2.5v9H7z" /> : <path d="M3 1.5v9l7.5-4.5z" />}</svg>
              {playing ? 'Pause' : 'Play'}
            </button>
          </div>
          <div className="h-1 w-full overflow-hidden rounded-full" style={{ background: 'color-mix(in srgb, var(--color-foreground) 8%, transparent)' }}>
            <div className="h-full rounded-full" style={{ width: `${(work.done / Math.max(1, work.total)) * 100}%`, background: 'var(--color-success)', transition: 'width .25s' }} />
          </div>
        </div>
        <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-full h-4" style={{ background: 'linear-gradient(var(--page-bg), transparent)' }} />
      </div>
      <div className="mx-auto mt-2 box-border w-full max-w-[784px] px-6"><Checklist data={data} tree={tree} moments={moments} index={index} /></div>
    </div>
  );
}
