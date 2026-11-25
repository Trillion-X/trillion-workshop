// tools/show-any-file-as-itself/web/row-media-screen-mount.tsx
//
// PURPOSE
//   One row's media as a screen module: the row named by the screen's input is read through the records door, and the media
//   field it names is shown. A sound or video plays in the shared player with its captions, and the transcript reader follows
//   the playback word by word and seeks on a word click, when the row holds timed text in the field the input names. The
//   reader shows from the start (the player's transcript button closes and opens it): beside the picture in a pane at least
//   56rem wide, and directly under the picture in a narrower one, before the row's body. The row's chapters, when the input
//   names a field holding them, are the reader's Chapters list.
//   Anything else (a PDF, a text file, any other file) opens in the shared file preview. The row's body field shows beneath, read as markdown by the shared MarkdownWords.
//   A file the input gives directly is shown the same way, with no row read. The single export, `mount(element, props)`, is
//   the contract of the module kind (web/src/workspace/tool-screen.tsx). The fields are the input's, never a fixed name here.
//   The screen fills its pane and draws no frame of its own, as the other workspace screens do (file-screen.tsx): the pane's
//   surface is the only card. The player column scrolls inside the pane, and the transcript scrolls in its own column.
//
// NON-NEGOTIABLE INVARIANTS
//   1. The row is read by the id and type the input names, through the records door; nothing here holds row text.
//   2. Every field name (media, timed text, chapters, files, body, title) comes from the input; none is assumed here.
//   6. The reader is given no editing tools here: a row read through this screen is read, followed and sought, never changed.
//   3. Nothing here writes a row. A row the door does not answer shows the words for it, and never a guess.
//   4. The timed text is the shared converter's (media-playback/read-data/kept-timed-text.ts): the same words the note's
//      transcript shows, with the same seconds.
//   5. The player shows no frame of its own and no title of its own: the screen's title is the one title.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import React from 'react';
import { Container, ErrorBoundary, Text, mountReactSurface } from '../../ui';
import { FilePreview } from '../../ui/show/file-preview/FilePreview';
import { MediaPlaybackSurface, type MediaPlaybackSeekRequest } from '../../media-playback/show/MediaPlaybackSurface';
import { timedTextOf } from '../../media-playback/read-data/kept-timed-text';
import { TranscriptReaderSurface } from '../../transcript-reader/show/TranscriptReaderSurface';
import { Spinner } from '../../ui/show/spinner';
import { MarkdownWords } from '../../ui/show/markdown-block/MarkdownWords';
import { readRecord } from '#workspace/records-door';
import { bodyOf, chaptersOf, filesOf, mediaOf, sourceOf } from './row-media.mjs';

type RowMediaInput = {
  /** The row to read: its id and type, through the records door. */
  record_id?: string;
  record_type?: string;
  /** The row's field holding the media (an address, or an object naming one with its type). */
  media_field?: string;
  /** The row's field holding timed text: passages of { text, start, end } in seconds, with words when the row has them. */
  timed_text_field?: string;
  /** The row's field holding the recording's chapters: { start, end, title, summary? } in seconds. */
  chapters_field?: string;
  /** The row's field holding a list of files (resources), each opened in the file viewer beneath the media. */
  files_field?: string;
  /** The row's field holding text shown beneath the media. */
  body_field?: string;
  /** The row's field holding the title shown above the media. */
  title_field?: string;
  /** A file given directly, shown in place of a row's field. */
  file?: { url: string; content_type?: string; label?: string };
};

type RowValue = Record<string, unknown> | null;

// The pane width (in rem) from which the transcript sits beside the picture rather than under it.
const BESIDE_FROM_REM = 56;

/** Whether the element is at least `rem` wide, followed as it resizes (the pane's own width, not the window's). */
function useAtLeastRem(rem: number): [React.RefCallback<HTMLElement>, boolean] {
  const [element, setElement] = React.useState<HTMLElement | null>(null);
  const [wide, setWide] = React.useState(false);
  React.useLayoutEffect(() => {
    if (!element) return undefined;
    const measure = () => {
      const root = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      setWide(element.getBoundingClientRect().width >= rem * root);
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(element);
    return () => observer?.disconnect();
  }, [element, rem]);
  return [setElement, wide];
}

function RowMedia({ input }: { input: RowMediaInput }) {
  const [value, setValue] = React.useState<RowValue | undefined>(undefined);
  const [failed, setFailed] = React.useState(false);
  const [now, setNow] = React.useState(0);
  const [seek, setSeek] = React.useState<MediaPlaybackSeekRequest | null>(null);
  const [transcriptChoice, setTranscriptChoice] = React.useState<boolean | null>(null);
  const [paneRef, beside] = useAtLeastRem(BESIDE_FROM_REM);
  const rowId = input.record_id ?? '';
  const rowType = input.record_type ?? '';
  React.useEffect(() => {
    let gone = false;
    setFailed(false);
    if (input.file || !rowId || !rowType) return undefined;
    setValue(undefined);
    readRecord(rowId, rowType).then(
      row => { if (!gone) setValue((row ?? null) as RowValue); },
      () => { if (!gone) setFailed(true); },
    );
    return () => { gone = true; };
  }, [rowId, rowType, input.file]);
  const identity = rowId || input.file?.url || '';
  const source = input.file ? sourceOf(input.file, identity, input.file.label ?? '') : value ? mediaOf(value, input.media_field, identity) : null;
  const timed = React.useMemo(
    () => timedTextOf(identity, value?.[input.timed_text_field ?? '']).map(segment => ({ ...segment, transcript_ref: identity, words: segment.words && [...segment.words] })),
    [identity, value, input.timed_text_field],
  );
  const chapters = React.useMemo(() => chaptersOf(value, input.chapters_field), [value, input.chapters_field]);
  const body = value ? bodyOf(value, input.body_field) : '';
  const files = value ? filesOf(value, input.files_field) : [];
  const title = value && input.title_field ? value[input.title_field] : undefined;
  const loading = !input.file && value === undefined && !failed && Boolean(rowId);
  const withTranscript = source?.kind === 'media' && timed.length > 0;
  // The transcript shows from the start, for a sound and a video alike; the viewer closes and opens it with the player's
  // transcript button.
  const transcriptOpen = transcriptChoice ?? true;
  const reader = withTranscript && transcriptOpen ? (
    <TranscriptReaderSurface
      framed={false}
      title="Transcript"
      segments={timed}
      chapters={chapters}
      currentTimeSeconds={now}
      onSelectTime={seconds => setSeek(prev => ({ requestId: (prev?.requestId ?? 0) + 1, seconds }))}
    />
  ) : null;
  return (
    <ErrorBoundary zoneName="row media">
      {/* A pane at least 56rem wide holds the transcript beside the picture; a narrower one puts it directly under the
          picture, so the picture keeps the width (the pane's own width, measured, not the window's). */}
      <Container layout="vertical" gap="none" width="full" className="@container h-full min-h-0 w-full overflow-y-auto" ref={paneRef}>
        <Container layout="vertical" gap="none" width="full" alignItems="stretch" className="min-h-full @[56rem]:h-full @[56rem]:flex-row">
          <Container layout="vertical" gap="lg" minWidth="0" className="min-w-0 flex-1 p-4 @[56rem]:min-h-0 @[56rem]:overflow-y-auto">
            {typeof title === 'string' && title ? <Text variant="heading-xl" color="strong">{title}</Text> : null}
            {failed ? <Text variant="body" color="secondary">This could not be read. Try again.</Text> : null}
            {loading ? (
              <Container layout="horizontal" justifyContent="center" className="py-12">
                <Spinner size="lg" aria-label="Opening" />
              </Container>
            ) : null}
            {source?.kind === 'media' ? (
              <MediaPlaybackSurface
                media={{ ...source.media, transcript_ref: identity }}
                allowEmbeddedDocument
                showFrameChrome={false}
                captionsStartOn={timed.length > 0}
                timedTextSegments={timed.length ? timed : undefined}
                captionPlacement="over-picture"
                transcriptPlacement="beside-media"
                transcriptVisible={transcriptOpen}
                onSelectTranscript={visible => setTranscriptChoice(Boolean(visible))}
                onTimeChange={currentTime => setNow(currentTime)}
                seekRequest={seek}
              />
            ) : null}
            {reader && !beside ? <Container layout="vertical" minWidth="0" className="h-[28rem] w-full shrink-0">{reader}</Container> : null}
            {source?.kind === 'file' ? (
              <Container className="h-[min(78vh,60rem)] min-h-[36rem] overflow-hidden">
                <FilePreview url={source.file.url} contentType={source.file.contentType} label={source.file.label} autoPlay={false} />
              </Container>
            ) : null}
            {files.map((item, index) => (
              <Container key={`${item.kind}-${index}`} layout="vertical" gap="sm">
                {item.kind === 'media' ? (
                  <MediaPlaybackSurface media={item.media} allowEmbeddedDocument showFrameChrome={false} captionPlacement="below-picture" />
                ) : (
                  <>
                    {item.file.label ? <Text variant="body" color="strong" weight="semibold">{item.file.label}</Text> : null}
                    <Container className="h-[min(78vh,60rem)] min-h-[36rem] overflow-hidden">
                      <FilePreview url={item.file.url} contentType={item.file.contentType} label={item.file.label} autoPlay={false} />
                    </Container>
                  </>
                )}
              </Container>
            ))}
            {body ? <Container maxWidth="prose"><MarkdownWords words={body} /></Container> : null}
            {!loading && !failed && !source && !files.length && !body ? <Text variant="body" color="secondary">Nothing to show yet.</Text> : null}
          </Container>
          {reader && beside ? (
            <Container layout="vertical" minWidth="0" className="h-full min-h-0 w-[22rem] shrink-0 p-4 pl-0">{reader}</Container>
          ) : null}
        </Container>
      </Container>
    </ErrorBoundary>
  );
}

export function mount(element: HTMLElement, props: RowMediaInput = {}) {
  return mountReactSurface(element, <RowMedia input={props} />);
}
