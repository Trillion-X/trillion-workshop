// src/workspace/shared-list-views.tsx
//
// PURPOSE
//   Draws the saved views a public list page carries (once written by src/record-share-pages.mjs, now the Workshop tool tools/write-public-share-files): each host element
//   holds the list's fields, the rows that view keeps and the view's settings; this picks the view the host names from
//   the views offered to every list (parts/ui/show/record-views/every-list-views.ts) and draws it, read-only.
//
// NON-NEGOTIABLE INVARIANTS
//   1. No kind of view is named: the host's `data-list-view` is looked up in the offer, so any view registered for every
//      list can be shown on a public page, and a view the page does not know is left as the server wrote it.
//   2. Read-only: the view receives `readOnly` and no write, so it offers no control that would change the list.
//   3. The page never reaches the records store: shared views receive only the copy's carried data, no writes,
//      preferences or remote expression transport. The share script bundles no account store.
//   4. A view is drawn when it nears the screen, the way a media player is, so a long page does not draw every view at once.

import React from 'react';
import { createRoot } from 'react-dom/client';
import '../../parts/ui/show/chart/offer-chart-view';
import '../../parts/ui/show/record-views/designs/offer-designed-views';
import '../../parts/keep-lists-of-rows/show/offer-views-to-every-list.tsx';
import { viewsOfferedToEveryList } from '../../parts/ui/show/record-views/every-list-views';
import type { FieldDescriptor } from '../../parts/ui/show/record-views/record-views';
import lists from '../lists.json';

type CopyField = { id: string; label: string; kind: string; choices?: string[]; media?: boolean };
type CopyRow = { id: string; title?: string; values: Record<string, unknown> };
type CopyFile = { identity: string; media_type?: string; url: string; poster_url?: string };
type Carried = { settings?: Record<string, unknown>; fields?: CopyField[]; rows?: CopyRow[]; files?: CopyFile[] };

const kindOf = new Map((lists.field_kinds as { id: string; icon?: string; kind?: string; ruleKind?: string; document?: boolean }[]).map(kind => [kind.id, kind]));

/** The fields of a list copy as every view reads them: the value a row holds, and the kind it draws and filters as. */
export function fieldsOfCopy(fields: CopyField[], files: CopyFile[] = []): FieldDescriptor[] {
  const pictures = new Map<string, { url: string; source: 'image' | 'poster' }>();
  for (const file of files) {
    if (file.media_type?.startsWith('image/')) pictures.set(file.identity, { url: file.url, source: 'image' });
    else if (file.poster_url) pictures.set(file.identity, { url: file.poster_url, source: 'poster' });
  }
  return fields.map((field, index) => {
    const kind = kindOf.get(field.kind);
    const picture = (row: CopyRow) => {
      const found = [row.values[field.id]].flat().map(identity => pictures.get(String(identity))).filter(Boolean);
      return found.find(value => value?.source === 'image') ?? found[0] ?? null;
    };
    return {
      id: field.id, label: field.label, icon: kind?.icon, kind: field.media ? 'thumbnail' : kind?.kind ?? 'text', ruleKind: kind?.ruleKind ?? 'text',
      filterable: true, sortable: true, groupable: kind?.kind === 'tag', width: index === 0 ? 260 : 180,
      read: (row: CopyRow) => field.media ? picture(row)?.url ?? '' : row.values[field.id] ?? '',
      ...(field.media ? { pictureUrl: (row: CopyRow) => picture(row)?.url ?? null, pictureSource: (row: CopyRow) => picture(row)?.source ?? null } : {}),
      ...(kind?.document ? { document: true } : {}),
      ...(field.choices ? { values: Object.fromEntries(field.choices.map(choice => [choice, {}])) } : {}),
    };
  });
}

const carriedBy = (host: HTMLElement): Carried | null => {
  const script = host.querySelector<HTMLScriptElement>(':scope > script.page-view-data');
  if (!script) return null;
  try { return JSON.parse(script.textContent ?? '') as Carried; } catch { return null; }
};

const mounted = new WeakSet<HTMLElement>();
function mount(host: HTMLElement) {
  if (mounted.has(host)) return;
  const carried = carriedBy(host);
  if (!carried) return;
  const fields = fieldsOfCopy(carried.fields ?? [], carried.files ?? []);
  const view = viewsOfferedToEveryList(fields).find(offered => offered.id === host.dataset.listView);
  if (!view?.render) return;
  mounted.add(host);
  const label = host.getAttribute('aria-label') ?? view.label;
  const records = carried.rows ?? [];
  createRoot(host).render(view.render({
    records, fields, label, identify: (row: CopyRow) => row.id, settings: carried.settings, readOnly: true,
  }));
}

/** Draws every shown view on the page as it nears the screen. */
export function drawSharedListViews() {
  const hosts = [...document.querySelectorAll<HTMLElement>('[data-list-view]')];
  if (!hosts.length) return;
  if (!('IntersectionObserver' in window)) { for (const host of hosts) mount(host); return; }
  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) if (entry.isIntersecting) {
      mount(entry.target as HTMLElement);
      observer.unobserve(entry.target);
    }
  }, { rootMargin: '240px 0px' });
  for (const host of hosts) observer.observe(host);
}
