// src/workspace/inspiration-screen.tsx
//
// PORTED FROM: Trillion Media: inspiration-ui.js (Trillion Media's Inspiration screen).
//
// PURPOSE
//   Inspiration: everything worth making from, drawn by the shared card layouts (parts/ui/show/card-layouts) as named
//   rows, a shuffled wall or a grid. What the rows are, where each reads its cards, which ways of seeing exist and
//   which actions a card offers are DATA (src/inspiration.json), answered by tool:inspiration (src/inspiration.mjs)
//   in the person's store, the same answer any AI gets. This file only turns cards into pictures and runs the actions
//   the rows name.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Real records only: every card is an item tool:inspiration answered. A row with nothing in it is not drawn.
//   2. A card reads the same way as on Files and Media: a file's picture is the Files screen's (file-picture.ts), words
//      show as words, and it
//      opens through the arrangement as the screen its DATA names (a file opens in its own tab, a link in a new one).
//   3. The way of seeing it (rows, wall, grid) is kept for this person (workspace preference), not this device.
//   4. Every control is a shared component; nothing here draws a control of its own.

import { mountCardLayouts, type CardAction, type LayoutCard } from '../../parts/ui/show/card-layouts';
import { mediaPreviewContent } from '../../parts/ui/show/media-preview';
import { notify } from '../../parts/ui/show/coss/notifications';
import { PLACEABLE_SURFACE_MIME } from '../../parts/ui/show/placeable-surface-intent/placeable-surface-intent';
import { filePicture } from './file-picture';
import { readJson } from './api';
import { loadScreen } from '../../parts/ui/show/screen-state';
import { refusal } from './failure';
import { readWorkspacePreference, writeWorkspacePreference } from './records';
import { runWorkshopTool } from './workshop-tool-api';

import { errorWords } from '../../../../ui/show/safe-error-card/sanitize-error-text.ts';
type Card = { id: string; source: string; title?: string; detail?: string; summary?: string; file?: string; bytes?: string; media_type?: string; media_kind?: string; duration?: number; at?: number | string; picture?: string; opens: { screen?: string; input?: Record<string, unknown>; link?: string }; edit?: boolean };
type Section = { id: string; title: string; subtitle?: string; cards: Card[]; failed?: string };
type Action = CardAction & { run: string; when?: Record<string, unknown>[] };
type Answer = { sections: Section[]; layouts: { id: string; label: string; icon: string; grouped: boolean; shuffle: boolean; flow: string }[]; default_layout: string; view_all_layout: string; card_actions: Action[]; pick_actions: Action[]; aspects: Record<string, number>; empty: { title: string; description?: string } };

const LAYOUT_PREFERENCE = 'inspiration-layout';
const open = (surface: Record<string, unknown>) => { const request = new CustomEvent(PLACEABLE_SURFACE_MIME, { cancelable: true, detail: surface }); window.dispatchEvent(request); return request.defaultPrevented; };
const dateLabel = (value: unknown) => { const time = typeof value === 'number' ? value : Date.parse(String(value ?? '')); return Number.isFinite(time) && time > 0 ? new Date(time).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : ''; };
const lengthLabel = (seconds: unknown) => { const value = Number(seconds); return Number.isFinite(value) && value > 0 ? (value >= 60 ? `${Math.floor(value / 60)} min ${Math.round(value % 60)} s` : `${Math.round(value)} s`) : ''; };
const matches = (card: Card, when: Record<string, unknown>[] = []) => !when.length || when.some(row => Object.entries(row).every(([key, value]) => (card as Record<string, unknown>)[key] === value));

export function mountInspirationScreen(element: HTMLElement, _props: { surfaceInput?: Record<string, unknown> }): () => void {
  let answer: Answer | null = null;
  let layout: string | null = readWorkspacePreference<string>(LAYOUT_PREFERENCE);
  let focus: string | null = null;
  const host = document.createElement('div');
  host.className = 'trillion-inspiration';
  element.replaceChildren(host);
  let release = () => {};

  const cardsById = () => new Map((answer?.sections ?? []).flatMap(section => section.cards.map(card => [card.id, card] as const)));
  // A card with a picture shows it, a file shows the Files screen's picture, and words (a format, a saved example)
  // show their opening words, as Trillion Media drew them.
  const pictureOf = (card: Card) => (card.picture
    ? mediaPreviewContent({ renderer: 'image', source: card.picture, title: card.title ?? '' })
    : !card.file ? mediaPreviewContent({ renderer: 'text-snippet', text: card.summary ?? card.title ?? '', title: card.title ?? '' })
    : filePicture({ name: card.title ?? card.id, kind: card.media_kind ?? null, mediaType: card.media_type ?? null, identity: card.file ?? null, bytes: card.bytes ?? null, title: card.title }));
  const openCard = (card: Card) => {
    if (card.opens.link) { window.open(card.opens.link, '_blank', 'noopener'); return; }
    if (card.opens.screen && open({ id: card.opens.screen, title: card.title, surfaceInput: card.opens.input ?? {} })) return;
    notify('This cannot be opened', { kind: 'error', detail: 'It is no longer kept or has nothing to show yet.' });
  };
  const editClips = (cards: Card[], title: string) => open({ id: 'trillion.media-edit', title, surfaceInput: {
    editId: crypto.randomUUID(), title,
    clips: cards.filter(card => card.edit).map(card => ({ identity: card.id.slice(card.source.length + 1), file: card.file ?? null, name: card.title ?? '', in: 0, out: card.duration, duration: card.duration, bytes: card.bytes ?? null, media_type: card.media_type ?? null })),
  } });
  const nextEdit = (action: string) => readJson('/work/api/media/next-edit', { method: 'POST', body: JSON.stringify({ action }) }).then(() => screen.reload());
  // What each `run` in src/inspiration.json does.
  const RUNS: Record<string, (card?: Card) => unknown> = {
    open: card => card && openCard(card),
    edit: card => card && (editClips([card], card.title ?? 'New edit') || notify('The editor could not open', { kind: 'error' })),
    'edit-pick': () => {
      const pick = answer?.sections.find(section => section.cards.some(card => card.source === 'pick'));
      if (!pick || !editClips(pick.cards, pick.title)) return;
      return nextEdit('started');
    },
    another: () => nextEdit('another'),
    'not-now': () => nextEdit('not-now'),
  };
  const run = (name: string, card?: Card) => Promise.resolve().then(() => RUNS[name]?.(card)).catch(error => notify('That did not work', { kind: 'error', detail: errorWords(error) }));

  function paint() {
    if (!answer) return;
    release();
    const data = answer;
    const shown = layout && data.layouts.some(row => row.id === layout) ? layout : data.default_layout;
    const groups = new Map<string, string[]>();
    for (const section of data.sections) for (const card of section.cards) groups.set(card.id, [...(groups.get(card.id) ?? []), section.id]);
    const byId = cardsById();
    const cards: LayoutCard[] = [...groups].map(([id, sections]) => {
      const card = byId.get(id)!;
      const actions: CardAction[] = [];
      for (const row of data.card_actions) {
        if (!matches(card, row.when) || (row.lead && actions.some(action => action.lead))) continue;
        actions.push({ id: row.id, label: row.label, icon: row.icon, ...(row.lead ? { lead: true } : {}) });
      }
      return {
        id, groups: sections, actions,
        title: card.title || 'Untitled',
        detail: [card.detail, lengthLabel(card.duration), dateLabel(card.at)].filter(Boolean).join(' · ') || undefined,
        summary: card.summary,
        picture: pictureOf(card),
        aspect: data.aspects[card.media_kind ?? ''],
      };
    });
    release = mountCardLayouts(host, {
      cards,
      sections: data.sections.map(section => ({
        id: section.id, title: section.title, ...(section.subtitle ? { subtitle: section.subtitle } : {}), ...(section.failed ? { error: 'Could not read this row.' } : {}),
        ...(section.cards.some(card => card.source === 'pick') ? { actions: data.pick_actions.map(({ id, label, icon, lead }) => ({ id, label, icon, ...(lead ? { lead } : {}) })) } : {}),
      })),
      layouts: data.layouts, layout: shown, focus, focusLayout: data.view_all_layout,
      seed: new Date().toDateString(), label: 'Inspiration', empty: data.empty,
      onLayout: id => { layout = id; focus = null; void writeWorkspacePreference(LAYOUT_PREFERENCE, id); paint(); },
      onFocus: id => { focus = id; paint(); },
      onOpen: id => { const card = byId.get(id); if (card) void run('open', card); },
      onCardAction: (id, actionId) => { const row = data.card_actions.find(action => action.id === actionId); if (row) void run(row.run, byId.get(id)); },
      onSectionAction: (_section, actionId) => { const row = data.pick_actions.find(action => action.id === actionId); if (row) void run(row.run); },
      onRetry: () => { void screen.reload(); },
    });
  }

  // Loading, refused and empty are the shared screen states; the answer is drawn by the card layouts.
  const screen = loadScreen(host, {
    loading: { label: 'Reading what you can make from', layout: 'gallery' },
    read: async () => {
      const ran = await runWorkshopTool<Answer>('tool:inspiration', {});
      if (!ran.result) throw new Error('Inspiration could not be read.');
      return ran.result;
    },
    empty: value => (value.sections.some(section => section.cards.length || section.failed) ? null : { status: 'empty', title: value.empty.title, ...(value.empty.description ? { description: value.empty.description } : {}), icon: 'Images' }),
    draw: value => { answer = value; paint(); },
    clear: () => { release(); release = () => {}; answer = null; },
    failed: refusal('Inspiration could not be read'),
  });
  return () => { screen.dispose(); element.replaceChildren(); };
}
