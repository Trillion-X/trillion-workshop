// parts/ui/show/version-history/VersionHistory.tsx
//
// NO PRIOR: searched ~/dev/bitfield-packages/packages/*/show for "version history", "earlier versions" and "restore this
// version" and the Mobbin MCP for version-history panels (Framer, Magnific, Notion, Descript). The nearest prior,
// bitfield-packages record-history/show/mount-record-history.tsx, is a slider scrub over a record's fields bound to the
// Bitfield runtime, with no pictures; this list of pictured versions is a different anatomy and keeps none of it.
//
// PURPOSE
//   The history of any record that keeps versions (a site, a document, a list, a look, a workflow), drawn so a person
//   can choose one by looking at it: each version shows a picture of itself, when it was made, who made it (a person
//   or an AI), what changed in words, and whether it is the current one. Any version opens large (Preview), sits side by
//   side with the current one (Compare), and is put back with one press that shows its own pending, done and failed
//   state (Restore). Framer's and Figma's version panels, the anatomy the owner asked for on 2026-10-04: "if i dont even
//   know what prior version look like how can i know which i want to restore".
//
// NON-NEGOTIABLE INVARIANTS
//   1. Blind to what the record is: rows are DATA ({ id, number, at, by, words, current }); a picture is asked for
//      through `picture(id)`, so the caller decides how a version is drawn (a page screenshot, a document's first
//      page, a chart) and where it is kept. Nothing here names sites, pages or files.
//   2. A picture is asked for only when its row is on screen, once per version, and kept for the life of the list;
//      a version never changes, so neither does its picture. A version with no picture shows its words, never a blank.
//   3. The current version cannot be restored and says so in place ("Current"); restore is offered only when the
//      caller passes `onRestore`, and its press reports its own outcome (the shared Button work states). Restore as the
//      draft exists only when the caller passes `onRestoreAsDraft`, beside it, with its own outcome.
//   4. Lays out by its own width (container queries in screen-look version-history.css): picture beside the words when
//      there is room, stacked in a narrow pane, and Compare stacks its two pictures the same way.

import * as React from 'react';
import { Button } from '../button';
import { NamedIcon } from '../icon/NamedIcon';
import { relativeWhen } from '../relative-time/relative-time';
import '../../../screen-look/show/version-history.css';

export type VersionRow = {
  /** The version's own id, handed back to `picture` and `onRestore`. */
  id: string;
  /** Its place in the history, 1 for the first. */
  number: number;
  /** An unnumbered basis such as a reviewed draft, when it is not a persisted revision. */
  label?: string;
  /** When it was made (ISO time), or null when unknown. */
  at: string | null;
  /** Who made it: a person's or an AI's name, or null when unknown. */
  by: string | null;
  /** What changed from the version before it, in words, or null when not worked out. */
  words: string | null;
  /** This is the version in use now. */
  current: boolean;
  /** Opens the exact saved version when a picture cannot show the whole record. */
  address?: string | null;
};

/** A drawn version: any image address the browser can show (a data: URL, a kept file's address). */
export type VersionPicture = { src: string } | null;

export type VersionHistoryProps = {
  rows: readonly VersionRow[];
  /** Draws one version; called once per version, only when it is on screen or opened. */
  picture?: (id: string) => Promise<VersionPicture>;
  /** An actual read-only rendering of this saved version, when it is structured content rather than a picture. */
  renderPreview?: (id: string) => React.ReactNode;
  /** Puts a version back as the current one. Omit to show history without restore. */
  onRestore?: (id: string) => Promise<void>;
  /** Puts a version back as the draft, leaving what is current as it is (publishing is the caller's own step). */
  onRestoreAsDraft?: (id: string) => Promise<void>;
  /** Words for an empty history. */
  emptyWords?: string;
  /** What one thing in the history is called, in the person's words ("Version"). */
  noun?: string;
};

type Shown = { mode: 'preview' | 'compare'; id: string } | null;
type Drawn = VersionPicture | 'failed' | undefined;

/** One picture of a version, asked for once and kept for every place this list shows it. */
function usePictures(picture: VersionHistoryProps['picture']) {
  const asked = React.useRef(new Set<string>());
  const [drawn, setDrawn] = React.useState<Record<string, Drawn>>({});
  const want = React.useCallback((id: string, retry = false) => {
    if (retry) {
      asked.current.delete(id);
      setDrawn(current => ({ ...current, [id]: undefined }));
    }
    if (!picture || asked.current.has(id)) return;
    asked.current.add(id);
    void Promise.resolve().then(() => picture(id)).catch(() => null).then(found => setDrawn(current => ({ ...current, [id]: found ?? 'failed' })));
  }, [picture]);
  return { drawn, want };
}

const stateOf = (drawn: Drawn) => drawn === undefined ? 'loading' : drawn === 'failed' ? 'missing' : 'ready';

function Thumbnail({ id, label, drawn, want, onOpen }: { id: string; label: string; drawn: Drawn; want: (id: string) => void; onOpen: () => void }) {
  const frame = React.useRef<HTMLButtonElement>(null);
  React.useEffect(() => {
    const element = frame.current;
    if (!element || drawn !== undefined) return;
    if (typeof IntersectionObserver === 'undefined') { want(id); return; }
    const seen = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) { want(id); seen.disconnect(); } }, { rootMargin: '240px' });
    seen.observe(element);
    return () => seen.disconnect();
  }, [id, drawn, want]);
  return <button ref={frame} type="button" className="version-history__thumb" aria-label={`Preview ${label}`} onClick={onOpen} data-state={stateOf(drawn)}>
    {drawn && drawn !== 'failed' ? <img src={drawn.src} alt="" decoding="async" /> : drawn === 'failed' ? <NamedIcon name="ImageOff" size="md" aria-hidden="true" /> : null}
  </button>;
}

function Picture({ label, drawn, onRetry }: { label: string; drawn: Drawn; onRetry: () => void }) {
  return <figure className="version-history__picture">
    <figcaption>{label}</figcaption>
    <div className="version-history__picture-body" data-state={stateOf(drawn)}>
      {drawn && drawn !== 'failed' ? <img src={drawn.src} alt={label} /> : drawn === 'failed' ? <div><p>This version could not be drawn. Its words are above.</p><Button size="sm" variant="secondary" onClick={onRetry}>Try drawing again</Button></div> : null}
    </div>
  </figure>;
}

export function VersionHistory({ rows, picture, renderPreview, onRestore, onRestoreAsDraft, emptyWords = 'Nothing has been saved yet.', noun = 'Version' }: VersionHistoryProps) {
  const { drawn, want } = usePictures(picture);
  const [shown, setShown] = React.useState<Shown>(null);
  const current = rows.find(row => row.current) ?? null;
  const label = (row: VersionRow) => row.label ?? `${noun} ${row.number}`;
  const restore = (row: VersionRow) => async () => { await onRestore?.(row.id); setShown(null); };
  const restoreAsDraft = (row: VersionRow) => async () => { await onRestoreAsDraft?.(row.id); setShown(null); };
  React.useEffect(() => { if (shown) { want(shown.id); if (shown.mode === 'compare' && current) want(current.id); } }, [shown, current, want]);
  if (!rows.length) return <p className="version-history__empty">{emptyWords}</p>;
  const open = shown ? rows.find(row => row.id === shown.id) ?? null : null;
  const comparing = Boolean(open && current && !open.current && shown?.mode === 'compare');
  return <div className="version-history" data-preview={renderPreview ? 'content' : 'picture'}>
    {open ? <section className="version-history__open" aria-label={comparing && current ? `${label(open)} beside ${label(current)}` : label(open)}>
      <header className="version-history__open-bar">
        <Button size="sm" variant="ghost" onClick={() => setShown(null)}><NamedIcon name="ArrowLeft" size="sm" aria-hidden="true" />Every version</Button>
        <span className="version-history__open-actions">
          {current && !open.current ? <Button size="sm" variant="secondary" active={comparing} onClick={() => setShown({ mode: comparing ? 'preview' : 'compare', id: open.id })}>{comparing ? 'Show alone' : 'Compare with current'}</Button> : null}
          {open.address ? <a className="version-history__open-link" href={open.address} target="_blank" rel="noopener noreferrer">Open full version</a> : null}
          {onRestoreAsDraft && !open.current ? <Button size="sm" variant="secondary" pendingLabel="Putting it in the draft" doneLabel="In the draft" errorLabel="Not put in the draft, try again" onClick={restoreAsDraft(open)}>Put {label(open)} in the draft</Button> : null}
          {onRestore && !open.current ? <Button size="sm" variant="primary" pendingLabel="Restoring" doneLabel="Restored" errorLabel="Not restored, try again" onClick={restore(open)}>Restore {label(open)}</Button> : null}
        </span>
      </header>
      <p className="version-history__open-meta"><strong>{label(open)}</strong>{open.current ? ' · current' : ''}{[open.by ?? 'Author not recorded', open.at ? relativeWhen(open.at, Date.now(), { clock: true }) : null].filter(Boolean).map(part => ` · ${part}`).join('')}</p>
      {open.words ? <p className="version-history__open-words">{open.words}</p> : null}
      <div className="version-history__pictures" data-compare={comparing ? '' : undefined}>
        {renderPreview ? <figure className="version-history__picture"><figcaption>{label(open)}</figcaption><div className="version-history__picture-body">{renderPreview(open.id)}</div></figure>
          : <Picture label={label(open)} drawn={drawn[open.id]} onRetry={() => want(open.id, true)} />}
        {comparing && current ? renderPreview
          ? <figure className="version-history__picture"><figcaption>{label(current)} · current</figcaption><div className="version-history__picture-body">{renderPreview(current.id)}</div></figure>
          : <Picture label={`${label(current)} · current`} drawn={drawn[current.id]} onRetry={() => want(current.id, true)} /> : null}
      </div>
    </section> : <ol className="version-history__list" aria-label={`${noun}s, newest first`}>
      {rows.map(row => <li key={row.id} className="version-history__row" data-current={row.current ? '' : undefined}>
        {renderPreview ? <Button variant="ghost" onClick={() => setShown({ mode: 'preview', id: row.id })} aria-label={`Preview ${label(row)}`}><NamedIcon name="FileText" size="md" aria-hidden="true" /></Button>
          : <Thumbnail id={row.id} label={label(row)} drawn={drawn[row.id]} want={want} onOpen={() => setShown({ mode: 'preview', id: row.id })} />}
        <div className="version-history__about">
          <p className="version-history__title"><strong>{label(row)}</strong>{row.current ? <span className="version-history__current">Current</span> : null}</p>
          <p className="version-history__meta">{[row.by ?? 'Author not recorded', row.at ? relativeWhen(row.at, Date.now(), { clock: true }) : null].filter(Boolean).join(' · ')}</p>
          {row.words ? <p className="version-history__words">{row.words}</p> : null}
          <div className="version-history__actions">
            <Button size="xs" variant="ghost" onClick={() => setShown({ mode: 'preview', id: row.id })}>Preview</Button>
            {!row.current && current ? <Button size="xs" variant="ghost" onClick={() => setShown({ mode: 'compare', id: row.id })}>Compare</Button> : null}
            {!row.current && onRestoreAsDraft ? <Button size="xs" variant="ghost" pendingLabel="Putting it in the draft" doneLabel="In the draft" errorLabel="Not put in the draft, try again" onClick={restoreAsDraft(row)}>As draft</Button> : null}
            {!row.current && onRestore ? <Button size="xs" variant="secondary" pendingLabel="Restoring" doneLabel="Restored" errorLabel="Not restored, try again" onClick={restore(row)}>Restore</Button> : null}
          </div>
        </div>
      </li>)}
    </ol>}
  </div>;
}
