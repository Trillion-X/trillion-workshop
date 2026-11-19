// The task page: Now (where the work stands) and History (how it got there), switched with the Workshop's
// SegmentedControl. It draws the data it is given, the shape readTaskPage answers (read-data/read-task-page.mjs); the mount
// (mount-task-page.tsx) keeps that data current. The chosen view is kept in the address (#history) so a reload keeps it.
// The newest change the reader has seen is kept on this computer under `seenKey`, so Now can say what changed since then.
// `choice` (from the mount, when the host offers several sets of work, such as pursuits) is drawn above the views with
// the same control and in the same column, so a host never places or styles it.
import React, { useEffect, useMemo, useState } from 'react';
import { SegmentedControl } from 'trillion-workshop/tools/ui/show/segmented-control/SegmentedControl';
import { momentsOf, standing, treeOf, type Data } from '../read-data/task-rows';
import { MARK_CSS } from './task-marks';
import { NowView } from './now-view';
import { HistoryView } from './history-view';

const VIEWS = [{ id: 'now', label: 'Now' }, { id: 'history', label: 'History' }];

export type Choice = { items: { id: string; label: string }[]; value: string; ariaLabel: string; onValueChange: (id: string) => void };

export function TaskPage({ data, seenKey, seenBefore, choice }: { data: Data; seenKey: string; seenBefore: string | null; choice?: Choice }) {
  const [view, setView] = useState(location.hash === '#history' ? 'history' : 'now');
  const choose = (next: string) => { setView(next); history.replaceState(null, '', next === 'now' ? location.pathname + location.search : `${location.search}#${next}`); };
  const looks = useMemo(() => new Map(data.statuses.map(s => [s.name, s])), [data]);
  const tree = useMemo(() => treeOf(data, looks), [data, looks]);
  const moments = useMemo(() => momentsOf(data), [data]);
  const now = useMemo(() => standing(moments, moments.length - 1), [moments]);
  useEffect(() => { localStorage.setItem(seenKey, data.changes.reduce((a, c) => (c.at > a ? c.at : a), '')); }, [data, seenKey]);
  return (
    <>
      <style>{MARK_CSS}</style>
      <div className="flex flex-col items-center gap-3 px-6 pt-5">
        {choice && choice.items.length > 1 && <SegmentedControl {...choice} />}
        <SegmentedControl items={VIEWS} value={view} ariaLabel="View" onValueChange={choose} />
      </div>
      {view === 'now' ? <NowView data={data} tree={tree} now={now} seenBefore={seenBefore} /> : <HistoryView data={data} />}
    </>
  );
}
