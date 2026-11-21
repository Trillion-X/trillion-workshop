// src/workspace/pieces-screen.tsx
//
// PURPOSE
//   Posts (the screen of tool:check-a-post): what each of the person's pursuits is making, read straight from that
//   pursuit's own database. The pursuits are the databases the person's vault holds a connection for under
//   pieces.json `database_suffix` (secrets:names, names only); each one's pieces are its `table` rows, read by the SQL
//   tool as the page opens. A switch picks the pursuit; each piece shows its title, its stage, what it waits on and why,
//   where it goes, its words, its slides and its pictures.
//   Above them, "Waiting on your yes": the rows of every decision source in pieces.json (an email draft, a post) that
//   wait on the person, each with Approve and Skip. One owner answers for every kind of row; decisions.ts makes the SQL.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Nothing here names a pursuit, a database, a table, a stage, a status or a column: all are pieces.json DATA or the
//      person's own names.
//   2. Only real rows: every piece and every waiting row is a row its database answered. A read still going, a read that
//      failed and a source with nothing in it are three different states; a failed read can be tried again.
//   3. A row is written only by the decision the person presses on it (Approve or Skip), as decideStatement makes it: the
//      row must still wait, and only its status and decided_at change. No other row is written from this screen.
//   4. A picture is read through the files owner (api.ts files); a path that names one computer's disk is said to be
//      there, never drawn as a broken picture.
//   5. Every element is a shared part (Container, Text, Badge, Card, Button, SegmentedControl, ImageBlock).
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import * as React from 'react';
import { Badge, Button, Card, Container, ImageBlock, SegmentedControl, Text } from '../../../../ui';
import { mountReactSurface } from '../../../../ui/show/react-surface-mount';
import { postJson, readFileBytes } from '../../../../workspace-screens/web/src/workspace/api';
import { runWorkshopTool } from '../../../../workspace-screens/web/src/workspace/workshop-tool-api';
import pieces from './pieces.json';
import { decideStatement, say, shownWords, waitingCountStatement, approvable, waitingPageStatement, type Cursor, type DecisionSource, type Verb } from './decisions';

type Piece = Record<string, string | null>;
type Row = Record<string, string | null>;
/** The rows one decision source read from one of the person's databases, with the connection they came from. */
/** One source's waiting rows from one database: the first page (or every page shown so far), how many wait in all, and
 *  whether a page past the last one shown may still hold more. */
type WaitingGroup = { source: DecisionSource; credential: string; rows: Row[]; left: number; more: boolean };
type Slide = { head: string; body: string };
type Read<T> = { state: 'reading' } | { state: 'failed'; why: string } | { state: 'read'; value: T };
const words = pieces.words;

/** The names of the connections the vault holds (names only, never values). */
async function readNames(): Promise<string[]> {
  const answer = await postJson<{ names?: unknown }>(pieces.names_method, {});
  if (!Array.isArray(answer?.names)) throw new Error('');
  return answer.names as string[];
}

/** The pursuits: each database connection the vault names with the suffix, labelled by its own name. */
async function readPursuits(): Promise<{ id: string; label: string }[]> {
  return (await readNames()).filter(name => name.endsWith(pieces.database_suffix)).sort().map(name => {
    const plain = name.slice(0, -pieces.database_suffix.length).replace(/_/g, ' ');
    return { id: name, label: plain.charAt(0).toUpperCase() + plain.slice(1) };
  });
}

const NO_TABLE = /relation .* does not exist/i;
/** One pursuit's pieces, in the stages' order; null when its database has no such table (it makes no posts). */
async function readPieces(credential: string): Promise<Piece[] | null> {
  const sql = `select ${pieces.columns.join(', ')} from ${pieces.table} order by coalesce(array_position($1::text[], state), 1000), id`;
  try {
    const ran = await runWorkshopTool<{ rows?: Piece[] }>(pieces.tool, { credential_name: credential, sql, params: [pieces.order], statement_timeout_ms: pieces.statement_timeout_ms });
    if (!Array.isArray(ran.result?.rows)) throw new Error('');
    return ran.result.rows;
  } catch (error) {
    if (error instanceof Error && NO_TABLE.test(error.message)) return null;
    throw error;
  }
}

function useRead<T>(read: () => Promise<T>, key: string): [Read<T>, () => void] {
  const [held, setHeld] = React.useState<Read<T>>({ state: 'reading' });
  const [attempt, setAttempt] = React.useState(0);
  React.useEffect(() => {
    let live = true;
    setHeld({ state: 'reading' });
    read().then(value => { if (live) setHeld({ state: 'read', value }); }, (error: unknown) => { if (live) setHeld({ state: 'failed', why: error instanceof Error ? error.message : '' }); });
    return () => { live = false; };
  }, [key, attempt]);
  return [held, () => setAttempt(count => count + 1)];
}

const parsed = (text: string | null): unknown => { try { return text ? JSON.parse(text) : null; } catch { return null; } };
const listOf = (text: string | null): string[] => { const value = parsed(text); return Array.isArray(value) ? value.map(String) : text && !value ? [text] : []; };

/** A piece's slides, from its script when the script is a list of slides or of pages; null when it is plain words. */
function slidesOf(script: string | null): Slide[] | null {
  const value = parsed(script) as { pages?: { sections?: { h?: string; b?: string[] }[] }[] } | Slide[] | null;
  if (Array.isArray(value)) return value.map(slide => ({ head: String(slide?.head ?? ''), body: String(slide?.body ?? '') }));
  if (value && Array.isArray(value.pages)) return value.pages.map(page => {
    const sections = page.sections ?? [];
    return { head: sections.map(section => section.h ?? '').filter(Boolean).join(' / '), body: sections.flatMap(section => section.b ?? []).join('\n') };
  });
  return null;
}

function Picture({ file }: { file: string }) {
  const [held] = useRead(async () => URL.createObjectURL(new Blob([await readFileBytes(file)])), file);
  if (held.state === 'failed') return <Text as="p" variant="caption" color="secondary">{words.picture_failed}</Text>;
  return held.state === 'read' ? <ImageBlock src={held.value} alt="" loading="lazy" maxHeight="16rem" /> : null;
}

function PieceCard({ piece }: { piece: Piece }) {
  const slides = slidesOf(piece.script);
  const caption = piece.draft || (slides ? '' : piece.script) || '';
  const files = ((parsed(piece.extra) as { files?: unknown } | null)?.files ?? []) as string[];
  const elsewhere = files.some(file => file.startsWith('/'));
  const goesTo = listOf(piece.goes_to);
  const asks = pieces.ask_first.includes(piece.state ?? '');
  return (
    <Card variant="nested" padding="md" data-piece={piece.id}>
      <Container layout="vertical" gap="sm">
        <Container layout="horizontal" gap="sm" alignItems="center">
          <Text as="h2" variant="heading" className="m-0">{piece.title && piece.title !== 'needs title' ? piece.title : words.untitled}</Text>
          {piece.state ? <Badge variant={asks ? 'warning' : 'muted'}>{piece.state}</Badge> : null}
          {piece.kind ? <Badge variant="muted">{piece.kind}</Badge> : null}
        </Container>
        {piece.next_step ? <Container layout="vertical" gap="xs"><Text variant="label" color="secondary">{words.next}</Text><Text as="p" variant="body">{piece.next_step}</Text></Container> : null}
        {piece.why ? <Container layout="vertical" gap="xs"><Text variant="label" color="secondary">{words.why}</Text><Text as="p" variant="body" color="secondary">{piece.why}</Text></Container> : null}
        {goesTo.length ? <Container layout="horizontal" gap="xs" alignItems="center"><Text as="span" variant="caption" color="secondary">{words.goes_to}</Text>{goesTo.map(place => <Badge key={place} variant="muted">{place}</Badge>)}</Container> : null}
        {piece.goes_out && /^https?:\/\//.test(piece.goes_out) ? <Text as="p" variant="caption" color="secondary">{words.posted_at}: {piece.goes_out}</Text> : null}
        {caption ? <Container layout="vertical" gap="xs"><Text variant="label" color="secondary">{words.caption}</Text><Text as="p" variant="body" className="whitespace-pre-wrap">{caption}</Text></Container> : null}
        {slides?.length ? (
          <Container layout="vertical" gap="xs">
            <Text variant="label" color="secondary">{words.slides}</Text>
            {slides.map((slide, at) => (
              <Card key={at} variant="nested" padding="sm" data-slide={at + 1}>
                <Text as="p" variant="caption" color="secondary">{words.slide} {at + 1}</Text>
                {slide.head ? <Text as="p" variant="heading">{slide.head}</Text> : null}
                {slide.body ? <Text as="p" variant="body" className="whitespace-pre-wrap">{slide.body}</Text> : null}
              </Card>
            ))}
          </Container>
        ) : null}
        {files.length ? (
          <Container layout="vertical" gap="xs">
            <Text variant="label" color="secondary">{words.pictures}</Text>
            {elsewhere ? <Text as="p" variant="caption" color="secondary">{words.picture_elsewhere}</Text>
              : <Container layout="horizontal" gap="sm" className="flex-wrap">{files.map(file => <Picture key={file} file={file} />)}</Container>}
          </Container>
        ) : null}
      </Container>
    </Card>
  );
}

type Made = { id: string; label: string; read: Read<Piece[]> };
/** Every pursuit's pieces, read side by side; a pursuit whose database makes no posts is left out, one whose read
 *  failed stays, with its failure. */
async function readAll(): Promise<Made[]> {
  const pursuits = await readPursuits();
  const reads = await Promise.allSettled(pursuits.map(pursuit => readPieces(pursuit.id)));
  return pursuits.flatMap((pursuit, at) => {
    const read = reads[at]!;
    if (read.status === 'rejected') return [{ ...pursuit, read: { state: 'failed', why: read.reason instanceof Error ? read.reason.message : '' } as Read<Piece[]> }];
    return read.value ? [{ ...pursuit, read: { state: 'read', value: read.value } as Read<Piece[]> }] : [];
  });
}

function Failed({ message, why, retry }: { message: string; why?: string; retry: () => void }) {
  return (
    <Container layout="vertical" gap="sm">
      <Text as="p" variant="body" color="secondary">{message}{why ? ` ${why}` : ''}</Text>
      <Container layout="horizontal"><Button variant="ghost" onClick={retry}>{words.retry}</Button></Container>
    </Container>
  );
}

const sources = pieces.decisions.sources as DecisionSource[];
/** One page of a source's waiting rows from one database, after the cursor (none for the first page). A page of the
 *  page size means more may follow. */
async function readWaitingPage(source: DecisionSource, credential: string, after: Cursor | null): Promise<{ rows: Row[]; more: boolean }> {
  const { sql, params } = waitingPageStatement(source, pieces.waiting_page_size, after);
  const ran = await runWorkshopTool<{ rows?: Row[] }>(pieces.tool, { credential_name: credential, sql, params, statement_timeout_ms: pieces.statement_timeout_ms });
  if (!Array.isArray(ran.result?.rows)) throw new Error('');
  return { rows: ran.result.rows, more: ran.result.rows.length === pieces.waiting_page_size };
}

/** How many rows of a source wait, from one database: a count of the same rows the pages read. */
async function readWaitingCount(source: DecisionSource, credential: string): Promise<number> {
  const { sql, params } = waitingCountStatement(source);
  const ran = await runWorkshopTool<{ rows?: { waiting?: string }[] }>(pieces.tool, { credential_name: credential, sql, params, statement_timeout_ms: pieces.statement_timeout_ms });
  const count = Number(ran.result?.rows?.[0]?.waiting);
  if (!Number.isInteger(count)) throw new Error('');
  return count;
}

/** The first page and the count of each decision source's waiting rows, read from every database the vault names with its
 *  suffix that has its table (one without it makes no such rows and is left out). decisions.ts makes the SQL. */
async function readWaiting(): Promise<WaitingGroup[]> {
  const names = await readNames();
  const reads = sources.flatMap(source => names.filter(name => name.endsWith(source.database_suffix)).map(async (credential): Promise<WaitingGroup | null> => {
    try {
      const [page, left] = await Promise.all([readWaitingPage(source, credential, null), readWaitingCount(source, credential)]);
      return { source, credential, rows: page.rows, left, more: page.more };
    } catch (error) {
      if (error instanceof Error && NO_TABLE.test(error.message)) return null;
      throw error;
    }
  }));
  return (await Promise.all(reads)).filter((group): group is WaitingGroup => group !== null);
}

/** The next page of one source's waiting rows, after the last row the group shows. */
async function readMoreWaiting(group: WaitingGroup): Promise<WaitingGroup> {
  const last = group.rows[group.rows.length - 1];
  if (!last) return group;
  const page = await readWaitingPage(group.source, group.credential, { order: last[group.source.order] ?? '', id: last[group.source.id] ?? '' });
  return { ...group, rows: [...group.rows, ...page.rows], more: page.more };
}

/** Sets one row's decision in the database it was read from. The answer is read again either way: a row decided elsewhere
 *  no longer waits and leaves. */
async function decide(group: WaitingGroup, rowId: string, verb: Verb): Promise<void> {
  const { sql, params } = decideStatement(group.source, verb, rowId);
  const ran = await runWorkshopTool<{ rows?: Row[] }>(pieces.tool, { credential_name: group.credential, sql, params, statement_timeout_ms: pieces.statement_timeout_ms });
  if (!Array.isArray(ran.result?.rows)) throw new Error('');
}

/** The waiting rows, read as the screen opens and again after each decision. A refresh keeps the rows on screen until
 *  its answer comes, so a decision never blanks the list. */
function useWaiting(): { held: Read<WaitingGroup[]>; again: () => void; more: (group: WaitingGroup) => void } {
  const [held, setHeld] = React.useState<Read<WaitingGroup[]>>({ state: 'reading' });
  const [attempt, setAttempt] = React.useState(0);
  React.useEffect(() => {
    let live = true;
    readWaiting().then(value => { if (live) setHeld({ state: 'read', value }); }, (error: unknown) => { if (live) setHeld({ state: 'failed', why: error instanceof Error ? error.message : '' }); });
    return () => { live = false; };
  }, [attempt]);
  // The next page of one source's rows is added under the rows already shown; a page that fails fails the whole read.
  const more = (group: WaitingGroup) => {
    readMoreWaiting(group).then(
      next => setHeld(current => current.state === 'read' ? { state: 'read', value: current.value.map(one => (one.credential === group.credential && one.source.table === group.source.table ? next : one)) } : current),
      (error: unknown) => setHeld({ state: 'failed', why: error instanceof Error ? error.message : '' }),
    );
  };
  return { held, again: () => setAttempt(count => count + 1), more };
}

/** One row's decision: busy while it is saved, failed when it is not, and the waiting rows read again after it. */
function useDecision(group: WaitingGroup, row: Row, again: () => void) {
  const [busy, setBusy] = React.useState<Verb | null>(null);
  const [failed, setFailed] = React.useState(false);
  const press = (verb: Verb) => {
    if (busy) return;
    setBusy(verb);
    setFailed(false);
    decide(group, row[group.source.id] ?? '', verb).then(again, () => { setBusy(null); setFailed(true); });
  };
  return { busy, failed, press };
}

/** The rows of one source, each with its Approve and Skip. */
function WaitingCard({ group, row, again }: { group: WaitingGroup; row: Row; again: () => void }) {
  const { source } = group;
  const { busy, failed, press } = useDecision(group, row, again);
  const title = row[source.title] || words.untitled;
  return (
    <Card variant="nested" padding="md" data-waiting={row[source.id]} aria-busy={busy ? true : undefined}>
      <Container layout="vertical" gap="sm">
        <Text as="h2" variant="heading" className="m-0">{title}</Text>
        <WaitingFields source={source} row={row} />
        <Container layout="horizontal" gap="sm" alignItems="center">
          {approvable(source, row) ? <Button variant="primary" size="sm" disabled={busy !== null} aria-label={`${source.yes.label}: ${title}`} onClick={() => press(source.yes)}>{source.yes.label}</Button> : null}
          <Button variant="ghost" size="sm" disabled={busy !== null} aria-label={`${source.skip.label}: ${title}`} onClick={() => press(source.skip)}>{source.skip.label}</Button>
          {busy ? <Text as="span" variant="caption" color="secondary" role="status">{words.waiting_saving}</Text> : null}
          {failed ? <Text as="span" variant="caption" color="secondary" role="alert">{words.waiting_save_failed}</Text> : null}
        </Container>
      </Container>
    </Card>
  );
}

/** The fields a source shows for one row, in the order DATA names them. */
function WaitingFields({ source, row }: { source: DecisionSource; row: Row }) {
  return (
    <>
      {source.shows.map(shown => {
        const value = shownWords(row[shown.field] ?? null, shown.as);
        // A field a row holds nothing in shows its own empty words, when DATA names them (no address found).
        if (!value && shown.empty) return <Container key={shown.field} layout="vertical" gap="xs"><Text variant="label" color="secondary">{shown.label}</Text><Text as="p" variant="body" color="secondary">{(words as Record<string, string>)[shown.empty]}</Text></Container>;
        return value ? <Container key={shown.field} layout="vertical" gap="xs"><Text variant="label" color="secondary">{shown.label}</Text><Text as="p" variant="body" className="whitespace-pre-wrap">{value}</Text></Container> : null;
      })}
    </>
  );
}



/** A key press is not a decision while the person types in a field. */
const typing = (target: EventTarget | null) => target instanceof HTMLElement
  && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));

/** One waiting row at a time, large Approve and Skip, the rows left counted, and the keys DATA names pressing them. Only
 *  the one listening takes keys, so two sources never answer one press. */
function OneWaiting({ group, row, left, again, listening }: { group: WaitingGroup; row: Row; left: number; again: () => void; listening: boolean }) {
  const { source } = group;
  const { busy, failed, press } = useDecision(group, row, again);
  const title = row[source.title] || words.untitled;
  React.useEffect(() => {
    if (!listening) return;
    const onKey = (event: KeyboardEvent) => {
      if (busy || event.metaKey || event.ctrlKey || event.altKey || typing(event.target)) return;
      const verb = [...(approvable(source, row) ? [source.yes] : []), source.skip].find(one => one.key === event.key.toLowerCase());
      if (!verb) return;
      event.preventDefault();
      press(verb);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  return (
    <Card variant="nested" padding="md" data-waiting={row[source.id]} aria-busy={busy ? true : undefined}>
      <Container layout="vertical" gap="md">
        <Container layout="horizontal" gap="sm" alignItems="center" justifyContent="between">
          <Text as="h2" variant="heading-lg" className="m-0">{title}</Text>
          <Text as="span" variant="caption" color="secondary">{say(words.waiting_left, { count: left })}</Text>
        </Container>
        <WaitingFields source={source} row={row} />
        <Container layout="horizontal" gap="sm" alignItems="center">
          {approvable(source, row) ? <Button variant="primary" size="lg" disabled={busy !== null} aria-label={`${source.yes.label}: ${title}`} onClick={() => press(source.yes)}>{source.yes.label}</Button> : null}
          <Button variant="ghost" size="lg" disabled={busy !== null} aria-label={`${source.skip.label}: ${title}`} onClick={() => press(source.skip)}>{source.skip.label}</Button>
          {busy ? <Text as="span" variant="caption" color="secondary" role="status">{words.waiting_saving}</Text> : null}
          {failed ? <Text as="span" variant="caption" color="secondary" role="alert">{words.waiting_save_failed}</Text> : null}
        </Container>
        {listening ? <Text as="p" variant="caption" color="secondary">{say(words.waiting_keys, { yes: source.yes.key.toUpperCase(), skip: source.skip.key.toUpperCase() })}</Text> : null}
      </Container>
    </Card>
  );
}

function WaitingSection({ held, again, more }: { held: Read<WaitingGroup[]>; again: () => void; more: (group: WaitingGroup) => void }) {
  const groups = held.state === 'read' ? held.value.filter(group => group.left > 0 && group.rows.length > 0) : [];
  const listening = groups.find(group => group.source.one_at_a_time);
  return (
    <Container layout="vertical" gap="sm" data-section="waiting">
      <Text as="h2" variant="heading-lg" className="m-0">{words.waiting_title}</Text>
      {held.state === 'reading' ? <Text as="p" variant="body" color="secondary">{words.waiting_reading}</Text>
        : held.state === 'failed' ? <Failed message={words.waiting_failed} why={held.why} retry={again} />
          : groups.length === 0 ? <Text as="p" variant="body" color="secondary">{words.waiting_none}</Text>
            : groups.map(group => (
              group.source.one_at_a_time
                ? <OneWaiting key={`${group.credential}:${group.source.table}`} group={group} row={group.rows[0]!} left={group.left} again={again} listening={group === listening} />
                : (
                  <Container key={`${group.credential}:${group.source.table}`} layout="vertical" gap="sm">
                    <Text as="h3" variant="label" color="secondary">{group.source.label}</Text>
                    <Text as="p" variant="caption" color="secondary">{say(words.waiting_left, { count: group.left })}</Text>
                    {group.rows.map(row => <WaitingCard key={row[group.source.id] ?? ''} group={group} row={row} again={again} />)}
                    {group.more ? <Container layout="horizontal"><Button variant="ghost" onClick={() => more(group)}>{words.waiting_more}</Button></Container> : null}
                  </Container>
                )
            ))}
    </Container>
  );
}

/** The waiting view alone (its address, pieces.json `waiting_view`): the rows that wait on the person's yes, no pursuits. */
function WaitingOnly() {
  const waiting = useWaiting();
  return (
    <Container layout="vertical" gap="md" padding="lg" className="h-full min-h-0 overflow-y-auto" data-screen="waiting">
      <WaitingSection held={waiting.held} again={waiting.again} more={waiting.more} />
    </Container>
  );
}

function Pieces() {
  const [made, retry] = useRead(readAll, 'pursuits');
  const waiting = useWaiting();
  const [chosen, setChosen] = React.useState<string | null>(null);
  const list = made.state === 'read' ? made.value : [];
  const current = list.find(one => one.id === chosen) ?? list[0] ?? null;
  return (
    <Container layout="vertical" gap="md" padding="lg" className="h-full min-h-0 overflow-y-auto" data-screen="pieces">
      <Text as="h1" variant="heading-lg" className="page-title m-0">{words.title}</Text>
      <Text as="p" variant="body" color="secondary">{words.body}</Text>
      {sources.length ? <WaitingSection held={waiting.held} again={waiting.again} more={waiting.more} /> : null}
      {made.state === 'reading' ? <Text as="p" variant="body" color="secondary">{words.reading}</Text>
        : made.state === 'failed' ? <Failed message={words.failed} retry={retry} />
          : !current ? <Text as="p" variant="body" color="secondary">{words.none}</Text> : (
            <>
              <SegmentedControl ariaLabel={words.pursuits} value={current.id} onValueChange={setChosen}
                items={list.map(one => ({ id: one.id, label: one.label, note: one.read.state === 'read' ? String(one.read.value.length) : undefined }))} />
              {current.read.state === 'failed' ? <Failed message={words.failed} why={current.read.why} retry={retry} />
                : current.read.state === 'read' && current.read.value.length
                  ? <Container layout="vertical" gap="sm">{current.read.value.map(piece => <PieceCard key={piece.id} piece={piece} />)}</Container>
                  : <Text as="p" variant="body" color="secondary">{words.empty}</Text>}
            </>
          )}
    </Container>
  );
}

/** The Posts screen: its surface input `view` (pieces.json `waiting_view`) picks the waiting view alone. */
export function mountPiecesScreen(element: HTMLElement, props: { surfaceInput?: Record<string, unknown> } = {}) {
  return mountReactSurface(element, props.surfaceInput?.view === pieces.waiting_view ? <WaitingOnly /> : <Pieces />);
}
