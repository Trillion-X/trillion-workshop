// src/workspace/shared-with-me-screen.tsx
//
// PURPOSE
//   Shared with me: everything other people shared with this person one by one, newest first, each with who shared
//   it, what kind of thing it is and when. Opening one reads it from its owner at that moment and shows the copy they
//   share beside the page, the same way the sharing sheet shows the copy others will see (SharedCopy). It is the
//   screen of the account tool tool:shared-with-me (records/workshop-sharing-tool-records.json) and reads the same
//   answers any AI reads with shared_with_me and read_shared (src/record-sharing.mjs through /work/api/shared-with-me).
//   Anatomy from Descript's Shared with me (Mobbin 6549c54d-76f9-4287-89af-7f21ebbdf1bd: name, owner, when, list or
//   cards) and MagicPath's (80ffdce9-2741-4a46-bb4d-0c9b2df25229: "By <name>" under each).
//
// NON-NEGOTIABLE INVARIANTS
//   1. Only what the store answered: a list nobody has shared anything into says so plainly.
//   2. Every read of one thing asks its owner again (their choice decides at the moment of reading), so a thing they
//      stopped sharing says so instead of showing an old copy.
//   3. Fields are DATA below, drawn by the shared record views; kinds are named from record-sharing.json `kinds`.
//   4. Every control is shared: record views, screen states, the work panel, SharedCopy; this file writes no markup.

import React, { useEffect, useState } from 'react';
import { mountRecordViews, type FieldDescriptor } from '../../parts/ui/show/record-views/record-views';
import { loadScreen, ScreenState } from '../../parts/ui/show/screen-state';
import { relativeWhen } from '../../parts/ui/show/relative-time/relative-time';
import { SharedCopy, type SharingPreview } from '../../parts/ui/show/sharing-sheet/SharingSheet';
import { mountSharedContent } from '../../parts/ui/show/coss/shared-content';
import { openWorkPanel } from '../../parts/screen-arrangement/show/mount-floating-panel';
import sharing from '../record-sharing.json';
import { postJson, readJson } from './api';
import { failedState, refusal, reasonOf } from './failure';
import { recordFilter } from './record-filter';
import { onStoreChange } from './store-changes';

type Offer = { offer_id: string; from: string; kind: string; title: string | null; offered_at: string };
type Copy = { kind: string; title: string | null; preview: SharingPreview; provenance: { from?: string; shared_at?: string } };

const MINUTE = 60_000;
const KINDS: Record<string, string> = sharing.kinds;
const kindOf = (offer: Offer) => KINDS[offer.kind] ?? offer.kind;
const titleOf = (offer: Offer) => offer.title ?? kindOf(offer);

const fields = (now: number): FieldDescriptor[] => [
  { id: 'title', label: 'Name', icon: 'FileText', ruleKind: 'text', filterable: true, sortable: true, width: 300, read: titleOf },
  { id: 'from', label: 'From', icon: 'User', ruleKind: 'choice', filterable: true, groupable: true, sortable: true, width: 200 },
  { id: 'kind', label: 'Kind', icon: 'Shapes', kind: 'tag', ruleKind: 'choice', filterable: true, groupable: true, sortable: true, width: 140, read: kindOf },
  { id: 'when', label: 'Shared', icon: 'Clock', ruleKind: 'date', filterable: true, sortable: true, width: 170,
    read: (offer: Offer) => relativeWhen(offer.offered_at, now, { clock: true }), factValue: (offer: Offer) => Date.parse(offer.offered_at), sortValue: (offer: Offer) => Date.parse(offer.offered_at) },
];

/** One shared thing, read from its owner now (invariant 2). */
function SharedThing({ offer }: { offer: Offer }) {
  const [copy, setCopy] = useState<Copy | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [asked, setAsked] = useState(0);
  useEffect(() => {
    setFailed(null);
    postJson<Copy>('/work/api/shared-with-me/read', { offer_id: offer.offer_id }).then(setCopy, error => setFailed(reasonOf(error)));
  }, [offer.offer_id, asked]);
  if (failed) return <ScreenState state={failedState(failed, () => setAsked(asked + 1), 'This could not be opened')} />;
  if (!copy) return <ScreenState state={{ status: 'loading', label: 'Opening what they shared', layout: 'rows' }} />;
  return <SharedCopy heading={`${kindOf(offer)} from ${copy.provenance.from ?? offer.from}`} preview={{ ...copy.preview, title: copy.preview.title ?? titleOf(offer) }} />;
}

/** Opens one shared thing beside the page. */
function openShared(offer: Offer) {
  const panel = openWorkPanel(titleOf(offer), { anchor: document.activeElement, kind: 'shared-with-me' });
  const body = panel.querySelector<HTMLElement>('[data-panel-body]');
  if (body) mountSharedContent(body, <SharedThing offer={offer} />);
}

export function mountSharedWithMeScreen(element: HTMLElement): () => void {
  let views: ReturnType<typeof mountRecordViews> | null = null;
  let shown: Offer[] | null = null;
  const list = document.createElement('div');
  list.className = 'trillion-shared-with-me';
  element.replaceChildren(list);

  function draw(offers: Offer[]) {
    shown = offers;
    const open = (ids: string[]) => ids.forEach(id => { const offer = offers.find(item => item.offer_id === id); if (offer) openShared(offer); });
    const options = {
      label: 'Shared with me',
      fields: fields(Date.now()),
      records: offers,
      identify: (offer: Offer) => offer.offer_id,
      preferenceKey: 'trillion-shared-with-me',
      views: [{ id: 'table', label: 'List', icon: 'List' }, { id: 'gallery', label: 'Cards', icon: 'LayoutGrid' }],
      ...recordFilter,
      onOpen: (id: string) => open([id]),
      rowActions: [{ id: 'open', label: 'Open', icon: 'SquareArrowOutUpRight', lead: true, run: open }],
      emptyMessage: 'Nothing matches.',
    };
    if (views) views.update(options as never); else views = mountRecordViews(list, options as never);
  }

  const screen = loadScreen(list, {
    loading: { label: 'Loading what people shared with you', layout: 'rows' },
    read: () => readJson<{ shared_with_you: Offer[] }>('/work/api/shared-with-me').then(answer => answer.shared_with_you),
    empty: offers => (offers.length ? null : {
      status: 'empty', icon: 'Inbox', title: 'Nothing shared with you yet',
      description: 'When someone in a pursuit you share picks you for one of their things, it shows here.',
    }),
    failed: refusal('What people shared with you could not load'),
    clear: () => { views?.destroy(); views = null; shown = null; },
    draw,
  });
  const stopListening = onStoreChange(() => screen.reload());
  // "3 min ago" keeps counting while the tab is open.
  const ticking = window.setInterval(() => { if (shown) draw(shown); }, MINUTE);
  return () => {
    window.clearInterval(ticking);
    stopListening();
    screen.dispose();
    element.replaceChildren();
  };
}
