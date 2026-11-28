// The task page's mount (the screen module contract: mount(element, props) returns the cleanup). It asks `dataUrl` for the
// page's data every `intervalMs`, but only while the tab is visible: a hidden tab asks nothing, and coming back to a visible
// tab asks at once. It redraws only when the answer changed. A failed ask keeps what was drawn last; nothing is copied.
// Before anything is drawn, a failed ask says why in words and is asked again on the same interval (the list of choices too).
// With `choices`, the host offers several sets of work (pursuits, teams): their list is asked of `choices.url`
// ([{ id, label }], in the host's order), the page draws them as one control above Now and History (with `every`, one
// more choice that means all of them), the chosen ids are kept in the address (?<param>=) and every data ask names them
// (dataUrl?<param>=a,b). What a choice means is the host's: this file names no pursuit. `ask` is how the host asks one of
// those addresses (its text, or a refusal); by default a same-origin fetch. A host that answers through calls passes its own.
import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Joined } from '../read-data/ask-by-database';
import { TaskPage, type Choice } from './task-page';

export type Choices = { url: string; param: string; ariaLabel: string; every?: string };
export type Ask = (url: string) => Promise<string>;
export type TaskPageProps = { dataUrl: string; intervalMs?: number; seenKey?: string; choices?: Choices; ask?: Ask };
const EVERY = '*';

const DEFAULT_INTERVAL_MS = 5000;
const DEFAULT_SEEN_KEY = 'task-page-last-seen-change';
const fetchText: Ask = url => fetch(url, { cache: 'no-store', credentials: 'same-origin' }).then(reply => (reply.ok ? reply.text() : Promise.reject(new Error(String(reply.status)))));

function Live({ dataUrl, intervalMs, seenKey, choices, ask }: Required<Omit<TaskPageProps, 'choices'>> & { choices?: Choices }) {
  const [data, setData] = useState<Joined | null>(null);
  const [items, setItems] = useState<{ id: string; label: string }[] | null>(choices ? null : []);
  const [chosen, setChosen] = useState(() => (choices ? new URLSearchParams(location.search).get(choices.param) ?? '' : ''));
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    if (!choices) return undefined;
    let timer: number | undefined;
    const list = () => ask(choices.url)
      .then(text => { setItems(JSON.parse(text)); setFailed(null); })
      .catch(error => { setFailed(String(error?.message ?? error)); timer = window.setTimeout(list, intervalMs); });
    list();
    return () => window.clearTimeout(timer);
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
    ? { items: [...items.map(item => { const unread = data?.unread?.find(one => one.ids.includes(item.id)); return unread ? { ...item, label: `${item.label} (could not be read: ${unread.error})` } : item; }), ...(choices.every && items.length > 1 ? [{ id: EVERY, label: choices.every }] : [])], value, ariaLabel: choices.ariaLabel, onValueChange: choose }
    : undefined;
  useEffect(() => {
    if (!asked) return undefined;
    let last = '';
    let timer: number | undefined;
    const read = () => {
      ask(asked)
        .then(text => { setFailed(null); if (text === last) return; last = text; setData(JSON.parse(text)); })
        .catch(error => setFailed(String(error?.message ?? error)));
    };
    const stop = () => { if (timer !== undefined) { window.clearInterval(timer); timer = undefined; } };
    const start = () => { if (timer === undefined) { read(); timer = window.setInterval(read, intervalMs); } };
    const onVisibility = () => (document.visibilityState === 'visible' ? start() : stop());
    onVisibility();
    document.addEventListener('visibilitychange', onVisibility);
    return () => { stop(); document.removeEventListener('visibilitychange', onVisibility); };
  }, [asked, intervalMs, ask]);
  if (!data) return failed ? <p className="m-0 px-6 pt-7 text-center text-[15px]">{`The work could not be read: ${failed}. Asking again.`}</p> : null;
  return data.changes.length
    ? <TaskPage key={value} data={data} seenKey={key} seenBefore={seenBefore} choice={choice} />
    : <p className="m-0 px-6 pt-7 text-center text-[15px]">No changes yet.</p>;
}

export function mount(element: HTMLElement, props: TaskPageProps) {
  element.classList.add('page-view');
  const root = createRoot(element);
  root.render(<Live dataUrl={props.dataUrl} intervalMs={props.intervalMs ?? DEFAULT_INTERVAL_MS} seenKey={props.seenKey ?? DEFAULT_SEEN_KEY} choices={props.choices} ask={props.ask ?? fetchText} />);
  return () => root.unmount();
}
