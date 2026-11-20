// tools/show-any-file-as-itself/web/row-media-screen-mount.tsx
//
// PURPOSE
//   One row's media as a screen module: the row named by the screen's input is read through the records door, and the media
//   field it names is shown. A sound or video plays in the shared player with its captions, and the transcript reader beside
//   it follows the playback word by word and seeks on a word click, when the row holds timed text in the field the input names.
//   Anything else (a PDF, a text file, any other file) opens in the shared file preview. The row's body field shows beneath.
//   A file the input gives directly is shown the same way, with no row read. The single export, `mount(element, props)`, is
//   the contract of the module kind (web/src/workspace/tool-screen.tsx). The fields are the input's, never a fixed name here.
//   The screen fills its pane and draws no frame of its own, as the other workspace screens do (file-screen.tsx): the pane's
//   surface is the only card. The player column scrolls inside the pane, and the transcript scrolls in its own column.
//
// NON-NEGOTIABLE INVARIANTS
//   1. The row is read by the id and type the input names, through the records door; nothing here holds row text.
//   2. Every field name (media, timed text, files, body, title) comes from the input; none is assumed here.
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
import { readRecord } from '#workspace/records-door';
import { bodyOf, filesOf, mediaOf, sourceOf } from './row-media.mjs';

type RowMediaInput = {
  /** The row to read: its id and type, through the records door. */
  record_id?: string;
  record_type?: string;
  /** The row's field holding the media (an address, or an object naming one with its type). */
  media_field?: string;
  /** The row's field holding timed text: passages of { text, start, end } in seconds, with words when the row has them. */
  timed_text_field?: string;
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

function RowMedia({ input }: { input: RowMediaInput }) {
  const [value, setValue] = React.useState<RowValue | undefined>(undefined);
  const [failed, setFailed] = React.useState(false);
  const [now, setNow] = React.useState(0);
  const [seek, setSeek] = React.useState<MediaPlaybackSeekRequest | null>(null);
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
  const body = value ? bodyOf(value, input.body_field) : '';
  const files = value ? filesOf(value, input.files_field) : [];
  const title = value && input.title_field ? value[input.title_field] : undefined;
  const loading = !input.file && value === undefined && !failed && Boolean(rowId);
  const withTranscript = source?.kind === 'media' && timed.length > 0;
  return (
    <ErrorBoundary zoneName="row media">
      <Container layout="horizontal" gap="none" width="full" alignItems="stretch" className="h-full min-h-0 w-full">
        <Container layout="vertical" gap="lg" minWidth="0" className="min-h-0 min-w-0 flex-1 overflow-y-auto p-4">
          {typeof title === 'string' && title ? <Text variant="heading-xl" color="strong">{title}</Text> : null}
          {failed ? <Text variant="body" color="secondary">This could not be read. Try again.</Text> : null}
          {loading ? (
            <Container layout="horizontal" justifyContent="center" className="py-12">
              <Spinner size="lg" aria-label="Opening" />
            </Container>
          ) : null}
          {source?.kind === 'media' ? (
            <MediaPlaybackSurface
              media={source.media}
              allowEmbeddedDocument
              showFrameChrome={false}
              captionsStartOn={timed.length > 0}
              captionStyle="subtitle"
              timedTextSegments={timed.length ? timed : undefined}
              captionPlacement="below-picture"
              transcriptPlacement="beside-media"
              onTimeChange={currentTime => setNow(currentTime)}
              seekRequest={seek}
            />
          ) : null}
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
          {body ? <Text variant="body" color="secondary">{body}</Text> : null}
          {!loading && !failed && !source && !body ? <Text variant="body" color="secondary">Nothing to show yet.</Text> : null}
        </Container>
        {withTranscript ? (
          <Container layout="vertical" minWidth="0" className="h-full min-h-0 w-[22rem] shrink-0 p-4 pl-0">
            <TranscriptReaderSurface
              framed={false}
              title="Transcript"
              segments={timed}
              currentTimeSeconds={now}
              onSelectTime={seconds => setSeek(prev => ({ requestId: (prev?.requestId ?? 0) + 1, seconds }))}
            />
          </Container>
        ) : null}
      </Container>
    </ErrorBoundary>
  );
}

export function mount(element: HTMLElement, props: RowMediaInput = {}) {
  return mountReactSurface(element, <RowMedia input={props} />);
}
