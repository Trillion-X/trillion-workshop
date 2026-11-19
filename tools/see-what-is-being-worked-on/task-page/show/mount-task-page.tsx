// The task page's mount (the screen module contract: mount(element, props) returns the cleanup). It asks `dataUrl` for the
// page's data every `intervalMs`, but only while the tab is visible: a hidden tab asks nothing, and coming back to a visible
// tab asks at once. It redraws only when the answer changed. A failed ask keeps what was drawn last; nothing is copied.
// With `choices`, the host offers several sets of work (pursuits, teams): their list is asked of `choices.url`
// ([{ id, label }], in the host's order), the page draws them as one control above Now and History (with `every`, one
// more choice that means all of them), the chosen ids are kept in the address (?<param>=) and every data ask names them
// (dataUrl?<param>=a,b). What a choice means is the host's: this file names no pursuit.
import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Data } from '../read-data/task-rows';
import { TaskPage, type Choice } from './task-page';

export type Choices = { url: string; param: string; ariaLabel: string; every?: string };
export type TaskPageProps = { dataUrl: string; intervalMs?: number; seenKey?: string; choices?: Choices };
const EVERY = '*';

const DEFAULT_INTERVAL_MS = 5000;
const DEFAULT_SEEN_KEY = 'task-page-last-seen-change';

function Live({ dataUrl, intervalMs, seenKey, choices }: Required<Omit<TaskPageProps, 'choices'>> & { choices?: Choices }) {
  const [data, setData] = useState<Data | null>(null);
  const [items, setItems] = useState<{ id: string; label: string }[] | null>(choices ? null : []);
  const [chosen, setChosen] = useState(() => (choices ? new URLSearchParams(location.search).get(choices.param) ?? '' : ''));
  useEffect(() => {
    if (!choices) return;
    fetch(choices.url, { cache: 'no-store', credentials: 'same-origin' }).then(reply => reply.json()).then(setItems).catch(() => setItems([]));
  }, [choices?.url]);
  const ids = items?.map(item => item.id) ?? [];
  const value = chosen === EVERY && choices?.every ? EVERY : ids.includes(chosen) ? chosen : ids[0] ?? '';
  const asked = !choices ? dataUrl : value === EVERY ? `${dataUrl}?${choices.param}=${ids.join(',')}` : value ? `${dataUrl}?${choices.param}=${value}` : '';
  const key = choices ? `${seenKey}-${value}` : seenKey;
  const [seenBefore, setSeenBefore] = useState(() => localStorage.getItem(key));
  const choose = (id: string) => {
    if (!choices) return;
    const url = new URL(location.href); url.searchParams.set(choices.param, id); history.replaceState(null, '', url);
    setSeenBefore(localStorage.getItem(choices ? `${seenKey}-${id}` : seenKey)); setChosen(id);
  };
  const choice: Choice | undefined = choices && items
    ? { items: [...items, ...(choices.every && items.length > 1 ? [{ id: EVERY, label: choices.every }] : [])], value, ariaLabel: choices.ariaLabel, onValueChange: choose }
    : undefined;
  useEffect(() => {
    if (!asked) return undefined;
    let last = '';
    let timer: number | undefined;
    const read = () => {
      fetch(asked, { cache: 'no-store', credentials: 'same-origin' })
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
  }, [asked, intervalMs]);
  if (!data) return null;
  return data.changes.length
    ? <TaskPage key={value} data={data} seenKey={key} seenBefore={seenBefore} choice={choice} />
    : <p className="m-0 px-6 pt-7 text-center text-[15px]">No changes yet.</p>;
}

export function mount(element: HTMLElement, props: TaskPageProps) {
  element.classList.add('page-view');
  const root = createRoot(element);
  root.render(<Live dataUrl={props.dataUrl} intervalMs={props.intervalMs ?? DEFAULT_INTERVAL_MS} seenKey={props.seenKey ?? DEFAULT_SEEN_KEY} choices={props.choices} />);
  return () => root.unmount();
}
