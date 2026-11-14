import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { StepRow } from './StepRow';

const roots = new WeakMap<HTMLElement, Root>();
type Item = { id: string; label: string; detail?: string; status: 'pending' | 'active' | 'complete'; statusLabel: string };
export function mountActivity(host: HTMLElement, items: Item[], options: { compact?: boolean; error?: string } = {}) {
  if (!host) return;
  let root = roots.get(host);
  if (!root) { root = createRoot(host); roots.set(host, root); }
  host.classList.add('beui-activity', 'coss-ui');
  root.render(options.error ? <p role="alert">{options.error}</p> : items.length ? <ul aria-label="Current work">{items.map((item, index) => <li key={`${item.id}:${index}`}>
    <StepRow item={{ id: item.id, type: 'step', status: item.status, label: <><span>{item.label}</span>{!options.compact && item.detail ? <span className="beui-activity-detail">{item.detail}</span> : null}</>, meta: item.statusLabel }} />
  </li>)}</ul> : <p>No work is running right now.</p>);
  return () => { root?.unmount(); roots.delete(host); };
}
