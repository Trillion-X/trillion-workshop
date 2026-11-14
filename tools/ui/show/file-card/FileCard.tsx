// parts/ui/show/file-card/FileCard.tsx
// PORTED FROM: media-workspace/media-workspace.js mountPreviewSurface (lines 2346-2464: the open recording's
// "About this recording" chips, Edit video / Publish / Organize and the "More actions" menu, related media) and its
// Library hover card (lines 633-719), recorded in scripts/port-sources.json. Rebuilt as one blind part whose every
// section is DATA from the page, so the actions are whatever tools the person can run on the file, never a fixed row.
//
// PURPOSE
//   Everything about one file, under its preview wherever the file shows (every hover card through HoverPreview, and
//   the file's own tab): what can be done with it now (the first few as buttons, every one in the ⋯ menu) and the next
//   step suggested for it, always shown; and behind one info button beside the ⋯ (the card's one disclosure, the same
//   in a hover card and the full view) its facts as chips, the people in it, what was said in it and by whom, and files
//   beside it. A hover card opens with the disclosure closed; the file's own view opens with it open.
//   Anatomy after Dropbox Dash's file hover card (picture, name, facts, actions; Mobbin 45d0683f) and Frame.io's
//   asset panel (comments by person beside the player), checked against 21st.dev "File Preview Card".
//
// NON-NEGOTIABLE INVARIANTS
//   1. Blind: this part names no file kind, tool, section word or address. The page installs one source
//      (provideFileCards) that reads a file's card and does its actions; with none installed nothing is drawn, so
//      a preview outside the signed-in page stays as it was.
//   2. Every word the card says (headings, the ⋯ label) arrives in the view; every action is one the source offered
//      for this file, so no button can name something the person cannot do.
//   3. A pressed action says its work in itself (the shared Button's pending, done and failed faces, ../button/
//      press-work.tsx); an action's own result words come back from the source and replace "Done".
//   4. One source per page through globalThis, because each mounted screen and every hover popup is its own React
//      root and shares no context.
//   5. One disclosure holds every extra section, in every mode: a new section goes inside it, never beside it.
//   6. Appearance lives in screen-look/show/file-card.css; chips are FactChips, faces PersonTag, the menu ActionMenu,
//      every press the shared Button.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import * as React from 'react';
import { Button } from '../coss/ui/button';
import { NamedIcon } from '../icon/NamedIcon';
import { ActionMenu } from '../action-menu/ActionMenu';
import type { MenuThing } from '../action-menu/menu-rows';
import { FactChips, type FactField } from '../fact-chips/FactChips';
import { PersonTag } from '../person-tag/PersonTag';

/** The file a card is about, as the preview that shows it knows it. */
export type FileCardSubject = { id: string; title: string; url?: string; type?: string; poster?: string };
export type FileCardAction = { id: string; label: string; icon: string; about?: string };
/** One stretch of words, with who said it when that is known (`unsure`: it could be more than one person). */
export type FileCardTurn = { id: string; text: string; who?: string; unsure?: boolean; me?: boolean; start?: number };
export type FileCardPerson = { id: string; name: string; unsure?: boolean; detail?: string };
export type FileCardRelated = { id: string; title: string; detail?: string; poster?: string };
export type FileCardSuggestion = { id: string; label: string; icon: string; action: string };
export type FileCardView = {
  facts: { fields: FactField[]; values: Record<string, unknown>; label: string };
  actions: FileCardAction[];
  /** How many actions are buttons; the ⋯ menu offers every row the page has for this file (`about`). */
  lead: number;
  /** The file as the page's menus know it: the ⋯ menu offers every row the page has for it (action-menu/menu-rows.ts). */
  about: MenuThing;
  people: FileCardPerson[];
  words: FileCardTurn[];
  related: FileCardRelated[];
  suggestions: FileCardSuggestion[];
  /** Every word the card's frame says; `facts` also names the info button that shows everything about the file. */
  said: { more: string; facts: string; people: string; words: string; related: string; next: string; all_words: string };
};
export interface FileCardSource {
  /** The card for a file, or null when the page has nothing to say about it. */
  read(subject: FileCardSubject): Promise<FileCardView | null>;
  /** Does one of the card's actions; its answer is the words the button shows when it is done. */
  act(subject: FileCardSubject, actionId: string): Promise<string | void>;
  /** Opens a related file, or the file at a second of what was said. */
  open(subject: FileCardSubject, target: { related?: string; at?: number }): void;
  /** Keeps the person's own order of the actions (the ⋯ menu's rows are dragged). */
  reorder?(subject: FileCardSubject, ids: string[]): void;
  /** Tells every card drawn to read again (an action changed what is known). */
  subscribe?(listener: () => void): () => void;
}

const KEY = '__trillionFileCards';
type Shared = { source: FileCardSource | null; listeners: Set<() => void> };
const shared = (): Shared => ((globalThis as unknown as Record<string, Shared | undefined>)[KEY] ??= { source: null, listeners: new Set() });

/** Installs the page's file cards (or takes them away with null). */
export function provideFileCards(source: FileCardSource | null): void {
  shared().source = source;
  for (const listener of shared().listeners) listener();
}

function useFileCardSource(): FileCardSource | null {
  const [source, setSource] = React.useState(() => shared().source);
  React.useEffect(() => {
    const listener = () => setSource(shared().source);
    shared().listeners.add(listener);
    return () => { shared().listeners.delete(listener); };
  }, []);
  return source;
}

const clock = (seconds: number) => {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
};

function ActionButton({ action, run, variant = 'outline' }: { action: FileCardAction; run: () => Promise<string | void>; variant?: 'outline' | 'ghost' }) {
  const [doneLabel, setDoneLabel] = React.useState<string | undefined>(undefined);
  return (
    <Button variant={variant} size="xs" title={action.about} doneLabel={doneLabel}
      onClick={() => run().then(said => { if (said) setDoneLabel(said); })}>
      <NamedIcon name={action.icon} aria-hidden="true" />
      {action.label}
    </Button>
  );
}

/** What was said, a transcript line per turn: its time as a small chip at the left (it opens the file at that second),
 *  then who said it, when that is known, and the words on the same line. */
function Words({ turns, open }: { turns: FileCardTurn[]; open: (at: number) => void }) {
  return (
    <ol className="file-card-words">
      {turns.map(turn => (
        <li key={turn.id} className="file-card-turn" data-unsure={turn.unsure ? '' : undefined} data-me={turn.me ? '' : undefined}>
          {turn.start !== undefined ? (
            <Button variant="ghost" size="xs" className="file-card-at" onClick={() => open(turn.start!)}>{clock(turn.start)}</Button>
          ) : <span className="file-card-at" aria-hidden="true" />}
          <span className="file-card-line">
            {turn.who ? <span className="file-card-who"><PersonTag name={turn.who} size="xs" showName /></span> : null}
            <span className="file-card-said">{turn.text}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}

/** One file's card drawn from its view. */
export function FileCard({ subject, view, source, full = false }: { subject: FileCardSubject; view: FileCardView; source: FileCardSource; full?: boolean }) {
  const [order, setOrder] = React.useState<string[] | null>(null);
  const actions = order ? order.map(id => view.actions.find(action => action.id === id)).filter((action): action is FileCardAction => Boolean(action)) : view.actions;
  const lead = actions.slice(0, view.lead);
  const run = (id: string) => source.act(subject, id);
  const [showAll, setShowAll] = React.useState(full);
  const turns = showAll ? view.words : view.words.slice(0, 4);
  const [infoOpen, setInfoOpen] = React.useState(full);
  const infoId = React.useId();
  const hasInfo = Boolean(view.facts.fields.length || view.people.length || view.words.length || view.related.length);
  const infoButton = hasInfo ? (
    <Button variant="ghost" size="icon-xs" className="file-card-info-toggle" aria-label={view.said.facts} title={view.said.facts}
      aria-expanded={infoOpen} aria-controls={infoId} data-pressed={infoOpen ? '' : undefined} onClick={() => setInfoOpen(open => !open)}>
      <NamedIcon name="Info" aria-hidden="true" />
    </Button>
  ) : null;
  return (
    <div className="file-card" data-file-card={full ? 'full' : 'glance'}>
      {actions.length || infoButton ? (
        <div className="file-card-actions">
          {lead.map(action => <ActionButton key={action.id} action={action} run={() => run(action.id)} />)}
          {infoButton}
          {actions.length ? <ActionMenu label={view.said.more} iconTrigger triggerProps={{ openOnHover: true, delay: 120 }}
            items={[]} about={view.about}
            onAction={id => { void run(id); }}
            onReorder={ids => {
              // Dragging the ⋯ menu's rows orders the buttons too: a row that is one of the card's actions keeps its place.
              const mine = ids.map(id => actions.find(action => id.endsWith(`:${action.id}`))?.id).filter((id): id is string => Boolean(id));
              const ordered = [...mine, ...actions.map(action => action.id).filter(id => !mine.includes(id))];
              setOrder(ordered); source.reorder?.(subject, ordered);
            }} /> : null}
        </div>
      ) : null}
      {view.suggestions.length ? (
        <section className="file-card-section file-card-next" aria-label={view.said.next}>
          {view.suggestions.map(suggestion => (
            <ActionButton key={suggestion.id} variant="ghost" action={{ id: suggestion.id, label: suggestion.label, icon: suggestion.icon }} run={() => run(suggestion.action)} />
          ))}
        </section>
      ) : null}
      {hasInfo ? (
        <div id={infoId} className="file-card-info" role="region" aria-label={view.said.facts} hidden={!infoOpen}>
          {view.facts.fields.length ? <FactChips fields={view.facts.fields} facts={view.facts.values} label={view.facts.label} /> : null}
          {view.people.length ? (
            <section className="file-card-section">
              <h4 className="file-card-heading">{view.said.people}</h4>
              <ul className="file-card-people">
                {view.people.map(person => (
                  <li key={person.id} className="file-card-person" data-unsure={person.unsure ? '' : undefined} title={person.detail}>
                    <PersonTag name={person.name} size="sm" showName />
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {view.words.length ? (
            <section className="file-card-section">
              <h4 className="file-card-heading">{view.said.words}</h4>
              <Words turns={turns} open={at => source.open(subject, { at })} />
              {!showAll && view.words.length > turns.length ? (
                <Button variant="link" size="xs" className="file-card-all" onClick={() => setShowAll(true)}>{view.said.all_words}</Button>
              ) : null}
            </section>
          ) : null}
          {view.related.length ? (
            <section className="file-card-section">
              <h4 className="file-card-heading">{view.said.related}</h4>
              <ul className="file-card-related">
                {view.related.map(item => (
                  <li key={item.id}>
                    <Button variant="ghost" size="xs" className="file-card-related-item" title={item.detail ?? item.title} onClick={() => source.open(subject, { related: item.id })}>
                      {item.poster ? <img src={item.poster} alt="" loading="lazy" decoding="async" /> : <NamedIcon name="File" aria-hidden="true" />}
                      <span className="file-card-related-title">{item.title}</span>
                    </Button>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** The card for whatever file a preview shows, read from the page's source; nothing while it reads or when it has
 *  nothing to say, so the preview above it never waits. */
export function FileCardFor({ subject, full = false }: { subject: FileCardSubject; full?: boolean }) {
  const source = useFileCardSource();
  const [view, setView] = React.useState<FileCardView | null>(null);
  const [round, setRound] = React.useState(0);
  React.useEffect(() => source?.subscribe?.(() => setRound(value => value + 1)), [source]);
  React.useEffect(() => {
    if (!source) return;
    let live = true;
    source.read(subject).then(next => { if (live) setView(next); }, () => { if (live) setView(null); });
    return () => { live = false; };
  }, [source, subject.id, subject.url, subject.type, round]);
  if (!source || !view) return null;
  return <FileCard subject={subject} view={view} source={source} full={full} />;
}
