// The task page's mount (the screen module contract: mount(element, props) returns the cleanup). It asks `dataUrl` for the
// page's data every `intervalMs`, but only while the tab is visible: a hidden tab asks nothing, and coming back to a visible
// tab asks at once. It redraws only when the answer changed. A failed ask keeps what was drawn last; nothing is copied.
import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Data } from '../read-data/task-rows';
import { TaskPage } from './task-page';

export type TaskPageProps = { dataUrl: string; intervalMs?: number; seenKey?: string };

const DEFAULT_INTERVAL_MS = 5000;
const DEFAULT_SEEN_KEY = 'task-page-last-seen-change';

function Live({ dataUrl, intervalMs, seenKey }: Required<TaskPageProps>) {
  const [data, setData] = useState<Data | null>(null);
  const [seenBefore] = useState(() => localStorage.getItem(seenKey));
  useEffect(() => {
    let last = '';
    let timer: number | undefined;
    const read = () => {
      fetch(dataUrl, { cache: 'no-store', credentials: 'same-origin' })
        .then(reply => (reply.ok ? reply.text() : Promise.reject(new Error(String(reply.status)))))
        .then(text => { if (text === last) return; last = text; setData(JSON.parse(text)); })
        .catch(() => {});
    };
    const stop = () => { if (timer !== undefined) { window.clearInterval(timer); timer = undefined; } };
    const start = () => { if (timer === undefined) { read(); timer = window.setInterval(read, intervalMs); } };
    const onVisibility = () => (document.visibilityState === 'visible' ? start() : stop());
    onVisibility();
    document.addEventListener('visibilitychange', onVisibility);
    return () => { stop(); document.removeEventListener('visibilitychange', onVisibility); };
  }, [dataUrl, intervalMs]);
  if (!data) return null;
  return data.changes.length
    ? <TaskPage data={data} seenKey={seenKey} seenBefore={seenBefore} />
    : <p className="m-0 px-6 pt-7 text-center text-[15px]">No changes yet.</p>;
}

export function mount(element: HTMLElement, props: TaskPageProps) {
  element.classList.add('page-view');
  const root = createRoot(element);
  root.render(<Live dataUrl={props.dataUrl} intervalMs={props.intervalMs ?? DEFAULT_INTERVAL_MS} seenKey={props.seenKey ?? DEFAULT_SEEN_KEY} />);
  return () => root.unmount();
}
