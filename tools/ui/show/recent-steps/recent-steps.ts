// parts/ui/show/recent-steps/recent-steps.ts
//
// PURPOSE
//   What a person did just before they asked for help, kept on their own device: each step is
//   { at, kind, label, where } (when, what kind, the control's own name, which page), noted by the page events
//   recent-steps.json names under `watch` (a press, a field taking focus), by a page change, or by any surface itself
//   (`noteStep`, such as a pick). Whoever sends a request to an AI attaches `recentSteps()`, so the AI sees the path that
//   led to the request without the person explaining it.
//
// NON-NEGOTIABLE INVARIANTS
//   1. What was typed is never kept: a step names a control by its label, placeholder or own words, never its value.
//   2. Steps stay on the device (localStorage) until the person sends something; how many and how far back are DATA
//      (recent-steps.json `keep`), so nothing grows without bound and no store is written per step.
//   3. No kind of step is named in code: page events map to kinds through `watch` rows, and words and icons come from
//      `kinds`; an unknown kind shows as `other_kind`.
//   4. The same step noted twice within `same_step_within_ms` (a focus then a press on one control) is kept once.
//   5. Steps are kept under the signed-in account (accountKey): another account on this browser never reads or sends
//      them, and with no account on the page nothing is kept. The fixed key an older page kept them under cannot be
//      attributed to an account, so it is removed where it is found.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import settings from './recent-steps.json';
import { pageStorage, accountKey } from '../page-storage/page-storage';

export type RecentStep = { at: string; kind: string; label: string; where: string };

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

const storage = (): Store | null => pageStorage();
const here = () => (typeof location === 'undefined' ? '' : `${location.pathname}${location.hash}`);
const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();
const cut = (text: string) => (text.length > settings.label_max ? `${text.slice(0, settings.label_max - 1)}…` : text);

/** The key this account's steps are kept under, or null where no account is signed in on the page. */
function stepsKey(store: Store | null): string | null {
  if (!store) return null;
  try { store.removeItem(settings.keep.storage_key); } catch { /* a refused storage keeps nothing to remove */ }
  return accountKey(settings.keep.storage_key);
}

/** The steps still within `keep`, oldest first. */
function kept(now = Date.now(), store = storage()): RecentStep[] {
  const key = stepsKey(store);
  let steps: unknown = [];
  try { steps = JSON.parse(store && key ? store.getItem(key) ?? '[]' : '[]'); } catch { steps = []; }
  if (!Array.isArray(steps)) return [];
  const since = now - settings.keep.minutes * 60_000;
  return steps
    .filter((step): step is RecentStep => Boolean(step) && typeof step.at === 'string' && typeof step.kind === 'string' && typeof step.label === 'string' && typeof step.where === 'string')
    .filter(step => Date.parse(step.at) >= since)
    .slice(-settings.keep.steps);
}

/** Note one step. `label` is the control's own name; it is cut to `label_max` and kept on one line. */
export function noteStep(kind: string, label: string, where = here(), now = Date.now()): void {
  const store = storage();
  const key = stepsKey(store);
  if (!store || !key) return;
  const step: RecentStep = { at: new Date(now).toISOString(), kind, label: cut(oneLine(label)), where };
  if (!step.label) return;
  const steps = kept(now, store);
  const last = steps.at(-1);
  if (last && last.kind === step.kind && last.label === step.label && last.where === step.where && now - Date.parse(last.at) < settings.same_step_within_ms) return;
  try { store.setItem(key, JSON.stringify([...steps, step].slice(-settings.keep.steps))); } catch { /* a full or refused storage keeps nothing more */ }
}

/** The steps to send with a request, oldest first. */
export const recentSteps = (now = Date.now()): RecentStep[] => kept(now);

/** What a control is called on the page: its label, its own words, its placeholder, never what was typed into it. */
export function nameOfControl(element: Element): string {
  const attribute = (name: string) => element.getAttribute(name)?.trim() ?? '';
  const labelledBy = attribute('aria-labelledby').split(/\s+/).map(id => (id ? element.ownerDocument.getElementById(id)?.textContent ?? '' : '')).join(' ').trim();
  const field = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement;
  const labels = field ? Array.from((element as HTMLInputElement).labels ?? []).map(label => label.textContent ?? '').join(' ').trim() : '';
  const own = field || element.getAttribute('contenteditable') !== null ? '' : (element instanceof HTMLElement ? element.innerText : element.textContent) ?? '';
  return oneLine(attribute('aria-label') || labelledBy || labels || attribute('title') || own || attribute('placeholder') || attribute('alt') || attribute('name'));
}

let watching = false;

/** Start noting steps on a page (once): the `watch` rows' events and page changes. */
export function watchSteps(doc: Document = document): void {
  if (watching) return;
  watching = true;
  for (const row of settings.watch) {
    doc.addEventListener(row.event, event => {
      const target = event.target instanceof Element ? event.target.closest(row.on) : null;
      if (!target || target.closest(settings.ignore)) return;
      noteStep(row.kind, nameOfControl(target));
    }, true);
  }
  const view = doc.defaultView;
  if (!view) return;
  let page = '';
  const check = () => {
    const now = `${view.location.pathname}${view.location.hash}|${doc.title}`;
    if (now === page) return;
    page = now;
    noteStep(settings.page_kind, doc.title || view.location.pathname);
  };
  check();
  view.addEventListener('popstate', check);
  view.addEventListener('hashchange', check);
  view.setInterval(check, settings.page_check_ms);
}
