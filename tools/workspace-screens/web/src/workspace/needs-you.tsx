// src/workspace/needs-you.tsx
//
// PURPOSE
//   What only the person can do, drawn first on Home above their board and kept there until it is done: every section of
//   their Waiting on you answer (src/waiting-on-you.json, read by src/card-sections.mjs) that has something in it, in the
//   DATA's order, as the shared attention stack (parts/ui/show/attention-stack): the count, each kind with its own count
//   and icon, and on each thing one button that does it. A voice nobody named plays beside its Name button; naming it
//   runs the section's `form.runs` (tool:name-a-voice, and with their agreement tool:enroll-someone). The
//   stack's Go through them press opens the one-at-a-time queue (waiting-screen.tsx, the screen at /waiting).
//   This file is also the one place a waiting thing is finished, for the stack and the queue alike: its validated
//   card response, its legacy finish from the answer's `finishes`, its section's form, or opening it.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Nothing here names a kind of waiting thing: sections, icons, actions, finishes, forms and the tools they run are
//      DATA (read through waiting-queue.ts).
//   2. A card opens where its DATA says (its screen beside Home, else its address); a card whose source is done when
//      opened (`done_by_opening`) is marked done (POST /work/api/waiting-on-you/done) so it leaves the stack.
//   3. The stack is drawn above the board, never as a piece of it, so a board the person rearranged can never drop it;
//      the person's show rules (subject waiting-on-you.json presentation.words.needs_you.subject, facts kind and count)
//      can still hide a kind.
//   4. With nothing waiting nothing is drawn.
//   5. A form run is the same run a tool's own screen starts (workshop-tool-api.ts, POST /work/api/door/tools:run), under
//      a fresh key, and a run that failed is refused with its own words.
//   6. A finish's press, or its form once every run completed, marks the card done (POST /work/api/waiting-on-you/done);
//      a finish that is `checked` has no press: Trillion takes the thing off itself.
//   7. A batch (many voices in one pass) includes only rows with playable audio (`clip`), because naming without hearing
//      the voice asks for a guess. Each box starts with the row's first existing suggestion for the person to check,
//      change or clear; only a chosen person is named. The row's `why` explains its suggestion, and a row's `also` members
//      are named together once; section runs execute once for each selected voice.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import * as React from 'react';
import { AttentionStack, type AttentionGroup, type AttentionThing } from '../../parts/ui/show/attention-stack';
import type { HoverForm } from '../../parts/ui/show/record-views/hover-form';
import { relativeWhen } from '../../parts/ui/show/relative-time/relative-time';
import { showOf, useShowChange } from '../../parts/ui/show/show-rules/show-of';
import { postJson, readJson } from './api';
import { newRunKey, runWorkshopTool } from './workshop-tool-api';
import { bytesAddress } from './file-picture';
import { openAddress } from './open-screen';
import { recordSource } from './record-source';
import { yourFiles } from './your-files';
import { encodeRecord } from 'trillion-workshop/tools/ui/show/record-picker/record-value.ts';
import { batchRows } from 'trillion-workshop/tools/hold-one-thing-until-done/read-data/needs-you-hold.mjs';
import { batchCardOf, clipRangeOf, eligibleBatchCards, fieldsFor, filledWords, loadSupplementalPages, runsOf, startOf, unavailableBatchCount, wayOf, type FormField, type NeedsAnswer, type NeedsCard, type NeedsSection, type Run } from './waiting-queue';
import { announceWaitingItemsCompleted } from './linked-ask';
import { effectReads, type ResolvedEffect } from 'trillion-workshop/tools/ai-tool-catalog/read-data/declared-effects.ts';
import { readTheseAgain } from './store-changes';
import waitingOnYou from '../waiting-on-you.json';
import { ScreenState } from '../../parts/ui/show/screen-state';
import { refusal } from './failure';

export type { NeedsAnswer, NeedsCard, NeedsSection } from './waiting-queue';
export type Open = (screen: string, title?: string, input?: Record<string, unknown>) => void;

const said = waitingOnYou.presentation.words.needs_you;
const audioWords = waitingOnYou.presentation.words.waiting_queue;

/** Runs a form's runs in order for one card; a run that did not complete stops it with its own words. The screens drawn
 *  from what a completed run declares it changed (its `changes`) read themselves again. */
export async function runAll(runs: Run[], card: NeedsCard, values: Record<string, string>, fields: FormField[] = []) {
  for (const run of runsOf(runs, card, values, fields)) {
    const ran = await runWorkshopTool<{ changes?: ResolvedEffect[] }>(run.tool_id, run.input, newRunKey('needs-you'));
    readTheseAgain(effectReads(ran.result?.changes));
  }
}

/** Opens a card where its DATA says: its screen beside Home, its own link, or its address. */
export function openCard(card: NeedsCard, open: Open) {
  const opens = card.opens;
  if (opens && 'link' in opens) { window.open(opens.link, '_blank', 'noopener'); return; }
  if (opens?.screen) { open(opens.screen, card.title, opens.input ?? {}); return; }
  if (card.address && !openAddress(card.address)) window.open(card.address, '_blank', 'noopener');
}

export const markDone = async (ids: string[]) => {
  const result = await postJson<{ completed?: string[] }>('/work/api/waiting-on-you/done', { ids });
  announceWaitingItemsCompleted(Array.isArray(result.completed) ? result.completed : []);
  return result;
};

/** A sound to play beside a card. Only a positive, finite interval becomes a media fragment; otherwise play the full recording. */
export const clipOf = (card: NeedsCard) => {
  if (!card.clip) return undefined;
  const range = clipRangeOf(card.clip_at);
  return `${bytesAddress(card.clip)}${range ? `#t=${range[0]},${range[1]}` : ''}`;
};

/** How one card is finished, as the shared stack and the queue draw it: the press (its words and what it does), and the
 *  form when finishing needs something from the person. `done` runs after a finish succeeded (the caller reads again,
 *  or moves on). Null `press` with `checked` words: Trillion takes it off itself. */
export type Finishing = {
  /** `finishes`: whether pressing it finishes the thing (false when it only opens it). */
  press: { label: string; run: () => Promise<void>; finishes: boolean } | null;
  form: HoverForm | null;
  checked: string | null;
  said: string | null;
};
/** The other voices a card stands for (`also`): naming the card names each of them too. */
const membersOf = (one: NeedsCard) => (Array.isArray(one.also) ? one.also as NeedsCard[] : []);
export function finishingOf(answer: NeedsAnswer | null | undefined, section: NeedsSection, card: NeedsCard, open: Open, done: () => void): Finishing {
  const way = wayOf(answer, section, card);
  const openingFinishes = way.kind === 'open' && way.finishes !== undefined ? way.finishes : Boolean(card.done_by_opening);
  const opening = { label: (way.kind === 'open' && way.label) || card.action || section.action || said.do, finishes: openingFinishes, run: async () => { openCard(card, open); if (openingFinishes) { await markDone([card.id]); done(); } } };
  const details = [{ label: section.title, text: card.title }, { label: said.said, text: card.detail }];
  switch (way.kind) {
    case 'batch': {
      // Only rows with playable material can be named. A suggested name alone is not a reason to ask the person.
      const lead = way.form.fields[0];
      const first = lead?.name ?? 'value';
      const rows = batchRows(way.batch, way.cards);
      const start: Record<string, string> = {};
      return {
        press: { label: way.batch.action ?? section.action ?? said.do, finishes: false, run: async () => {} },
        form: { title: card.title ?? section.title, submit: way.batch.submit, files: yourFiles, records: recordSource, details: [], start,
          fields: rows.map(one => {
            const clip = clipOf(one);
            const range = clipRangeOf(one.clip_at);
            const audioContext = clip ? (range ? audioWords.short_clip : audioWords.full_recording)
              : one.clip_status === 'not_found' ? audioWords.clip_not_found
                : one.clip_status === 'not_checked' ? audioWords.clip_not_checked : null;
            const reason = typeof one.why === 'string' && one.why.trim() && way.batch.why ? filledWords(way.batch.why, { ...one, why: one.why }, {}) : null;
            const together = membersOf(one).length && way.batch.also ? filledWords(way.batch.also, { ...one, count: membersOf(one).length }, {}) : null;
            const detail = [one.detail, audioContext, reason, together].filter((part): part is string => typeof part === 'string' && part.trim()).join(' · ');
            const box = lead ? fieldsFor([lead], one)[0] : undefined;
            // Only a sure guess is chosen for the person (src/voice-guesses.mjs invariant 9); an unsure one is still offered first.
            const pick = lead?.kind === 'record' ? box?.suggestions?.find(item => item.id && item.list_id && item.sure) : undefined;
            if (pick?.id && pick.list_id) start[one.id] = encodeRecord({ id: pick.id, list_id: pick.list_id, title: pick.title });
            return { ...(box ?? {}), name: one.id, label: one.title ?? section.title, kind: lead?.kind === 'record' ? 'record' : 'text', optional: true, ...(way.batch.placeholder ? { placeholder: way.batch.placeholder } : {}), ...(detail ? { detail } : {}), ...(clip ? { clip } : {}) };
          }),
          run: async values => {
            const named = rows.filter(one => (values[one.id] ?? '').trim());
            if (!named.length) throw new Error(way.batch.none ?? way.batch.submit);
            for (const one of named) for (const member of [one, ...membersOf(one)]) await runAll(way.form.runs, { ...one, ...member, also: undefined }, { [first]: values[one.id].trim() }, way.form.fields);
            done();
          } },
        checked: null, said: null,
      };
    }
    case 'checked': return { press: null, form: null, checked: way.finish.checked ?? null, said: null };
    case 'press': return { press: { label: way.finish.press ?? way.finish.choice, finishes: true, run: async () => { await markDone([card.id]); done(); } }, form: null, checked: null, said: way.finish.said ?? null };
    case 'form': return {
      press: { label: way.finish.choice, finishes: false, run: async () => {} },
      // A call an AI proposed starts with its proposed values in the boxes the person may change (waiting-queue.ts invariant 9).
      form: { title: card.title ?? section.title, submit: way.submit, fields: fieldsFor(way.fields, card), files: yourFiles, records: recordSource, details, start: startOf(way.fields),
        run: async values => { await runAll(way.runs, card, values, way.fields); await markDone([card.id]); done(); } },
      checked: null, said: way.finish.said ?? null,
    };
    case 'section-form': return {
      press: { label: card.action ?? section.action ?? said.do, finishes: false, run: async () => {} },
      form: { title: way.form.title, submit: way.form.submit, fields: fieldsFor(way.form.fields, card), files: yourFiles, records: recordSource, details,
        run: async values => { for (const member of [card, ...membersOf(card)]) await runAll(way.form.runs, { ...card, ...member, also: undefined }, values, way.form.fields); done(); } },
      checked: null, said: null,
    };
    default: return { press: opening, form: null, checked: null, said: null };
  }
}

function thingOf(answer: NeedsAnswer, section: NeedsSection, card: NeedsCard, open: Open, reload: () => void): AttentionThing {
  const finishing = finishingOf(answer, section, card, open, reload);
  const detail = card.detail ?? finishing.checked ?? undefined;
  return {
    id: card.id, title: card.title ?? section.title, ...(detail ? { detail } : {}),
    ...(card.at ? { meta: relativeWhen(card.at) } : {}),
    ...(clipOf(card) ? { clip: clipOf(card) } : {}),
    // A thing Trillion takes off itself still opens, so the person can see it.
    action: finishing.press ?? { label: card.action ?? section.action ?? said.do, run: () => openCard(card, open) },
    ...(finishing.form ? { form: finishing.form } : {}),
  };
}

/** The Needs you stack for one Waiting on you answer; nothing when nothing waits. */
export function NeedsYou({ answer, open, reload, showEmpty = false }: { answer: NeedsAnswer | null | undefined; open: Open; reload: () => void; showEmpty?: boolean }) {
  useShowChange();
  const [supplement, setSupplement] = React.useState<{ source: NeedsAnswer; page: NeedsAnswer } | null>(null);
  const [supplementSettled, setSupplementSettled] = React.useState<NeedsAnswer | null>(null);
  const [supplementFailure, setSupplementFailure] = React.useState<{ source: NeedsAnswer; error: unknown } | null>(null);
  const supplementNeeded = Boolean(answer?.sections.some(section => section.supplemental && section.batch?.requires && !eligibleBatchCards(section).length && section.has_more === true));
  React.useEffect(() => {
    if (!answer) return;
    const controller = new AbortController();
    const needed = answer.sections.some(section => section.supplemental && section.batch?.requires && !eligibleBatchCards(section).length && section.has_more === true);
    if (!needed) setSupplementSettled(answer);
    setSupplementFailure(null);
    void loadSupplementalPages(answer, (query, cursor, signal) => readJson<NeedsAnswer>(`/work/api/waiting-on-you?${encodeURIComponent(query)}=${encodeURIComponent(cursor)}&settle=no`, { signal }), controller.signal)
      .then(page => { if (!controller.signal.aborted) { setSupplement({ source: answer, page }); setSupplementSettled(answer); } })
      .catch(error => { if (!controller.signal.aborted) { setSupplementFailure({ source: answer, error }); setSupplementSettled(answer); } });
    return () => controller.abort();
  }, [answer]);
  if (!answer) return null;
  const shownAnswer = supplement?.source === answer ? supplement.page : answer;
  const groups: AttentionGroup[] = shownAnswer.sections
    .map(section => ({ section, cards: section.batch ? eligibleBatchCards(section) : section.cards, unavailable: unavailableBatchCount(section) }))
    .filter(({ section, cards, unavailable }) => section.on_home !== false && (cards.length || unavailable))
    .filter(({ section, cards }) => !showOf(said.subject, { kind: section.id, count: cards.length }).hidden)
    .map(({ section, cards, unavailable }) => ({
      id: section.id, title: section.title, count: section.batch ? Math.min(1, cards.length) : Math.max(section.total ?? 0, cards.length), ...(section.icon ? { icon: section.icon } : {}),
      ...(!cards.length && unavailable && section.batch?.unavailable ? { notice: section.batch.unavailable.replace(/\{count\}/g, String(unavailable)) } : {}),
      // A batch section is one thing done in one pass (waiting-queue.ts invariant 5).
      things: (section.batch ? (cards.length ? [batchCardOf(section)] : []) : cards).map(card => thingOf(answer, section, card, open, reload)),
      ...(section.all_done ? { all: { label: section.all_done, run: async () => { await markDone(section.cards.map(card => card.id)); reload(); } } } : {}),
    }));
  if (!groups.length) {
    if (!showEmpty) return null;
    if (supplementNeeded && supplementSettled !== answer) return <ScreenState state={{ status: 'loading', label: audioWords.loading, layout: 'rows' }} />;
    if (supplementFailure?.source === answer) return <ScreenState state={refusal(audioWords.failed)(supplementFailure.error, reload)} />;
    const hasRows = shownAnswer.sections.some(section => section.on_home !== false && (section.batch ? eligibleBatchCards(section).length || unavailableBatchCount(section) : section.cards.length));
    return <ScreenState state={hasRows
      ? { status: 'empty', icon: 'Inbox', title: said.no_items_to_show }
      : { status: 'empty', icon: 'Inbox', title: audioWords.all_done, description: audioWords.all_done_detail }} />;
  }
  const count = groups.reduce((sum, group) => sum + group.count, 0);
  return (
    <AttentionStack
      title={count === 1 ? said.title_one : said.title} count={count} groups={groups}
      go={{ label: said.go, run: () => open(said.queue_screen) }}
      words={{ working: said.working, done: said.done, more: said.more, fewer: said.fewer }}
    />
  );
}
