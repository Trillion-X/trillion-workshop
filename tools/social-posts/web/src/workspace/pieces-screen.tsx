// src/workspace/pieces-screen.tsx
//
// PURPOSE
//   Posts (the screen of tool:check-a-post): what each of the person's pursuits is making, read straight from that
//   pursuit's own database. The pursuits are the databases the person's vault holds a connection for under
//   pieces.json `database_suffix` (secrets:names, names only); each one's pieces are its `table` rows, read by the SQL
//   tool as the page opens. A switch picks the pursuit; each piece shows its title, its stage, what it waits on and why,
//   where it goes, its words, its slides and its pictures.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Nothing here names a pursuit, a database, a stage or a column: all are pieces.json DATA or the person's own names.
//   2. Only real rows: every piece is a row its pursuit's database answered. A read still going, a read that failed and
//      a pursuit with nothing in it are three different states; a failed read can be tried again.
//   3. Reading only: no row is written from this screen.
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

type Piece = Record<string, string | null>;
type Slide = { head: string; body: string };
type Read<T> = { state: 'reading' } | { state: 'failed'; why: string } | { state: 'read'; value: T };
const words = pieces.words;

/** The pursuits: each database connection the vault names with the suffix, labelled by its own name. */
async function readPursuits(): Promise<{ id: string; label: string }[]> {
  const answer = await postJson<{ names?: unknown }>(pieces.names_method, {});
  if (!Array.isArray(answer?.names)) throw new Error('');
  return (answer.names as string[]).filter(name => name.endsWith(pieces.database_suffix)).sort().map(name => {
    const plain = name.slice(0, -pieces.database_suffix.length).replace(/_/g, ' ');
    return { id: name, label: plain.charAt(0).toUpperCase() + plain.slice(1) };
  });
}

const NO_TABLE = /relation .* does not exist/i;
/** One pursuit's pieces, in the stages' order; null when its database has no such table (it makes no posts). */
async function readPieces(credential: string): Promise<Piece[] | null> {
  const sql = `select ${pieces.columns.join(', ')} from ${pieces.table} order by coalesce(array_position($1::text[], state), 1000), id`;
  try {
    const ran = await runWorkshopTool<{ rows?: Piece[] }>(pieces.tool, { credential_name: credential, sql, params: [pieces.order] });
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

function Failed({ why, retry }: { why?: string; retry: () => void }) {
  return (
    <Container layout="vertical" gap="sm">
      <Text as="p" variant="body" color="secondary">{words.failed}{why ? ` ${why}` : ''}</Text>
      <Container layout="horizontal"><Button variant="ghost" onClick={retry}>{words.retry}</Button></Container>
    </Container>
  );
}

function Pieces() {
  const [made, retry] = useRead(readAll, 'pursuits');
  const [chosen, setChosen] = React.useState<string | null>(null);
  const list = made.state === 'read' ? made.value : [];
  const current = list.find(one => one.id === chosen) ?? list[0] ?? null;
  return (
    <Container layout="vertical" gap="md" padding="lg" className="h-full min-h-0 overflow-y-auto" data-screen="pieces">
      <Text as="h1" variant="heading-lg" className="page-title m-0">{words.title}</Text>
      <Text as="p" variant="body" color="secondary">{words.body}</Text>
      {made.state === 'reading' ? <Text as="p" variant="body" color="secondary">{words.reading}</Text>
        : made.state === 'failed' ? <Failed retry={retry} />
          : !current ? <Text as="p" variant="body" color="secondary">{words.none}</Text> : (
            <>
              <SegmentedControl ariaLabel={words.pursuits} value={current.id} onValueChange={setChosen}
                items={list.map(one => ({ id: one.id, label: one.label, note: one.read.state === 'read' ? String(one.read.value.length) : undefined }))} />
              {current.read.state === 'failed' ? <Failed why={current.read.why} retry={retry} />
                : current.read.state === 'read' && current.read.value.length
                  ? <Container layout="vertical" gap="sm">{current.read.value.map(piece => <PieceCard key={piece.id} piece={piece} />)}</Container>
                  : <Text as="p" variant="body" color="secondary">{words.empty}</Text>}
            </>
          )}
    </Container>
  );
}

export function mountPiecesScreen(element: HTMLElement) {
  return mountReactSurface(element, <Pieces />);
}
