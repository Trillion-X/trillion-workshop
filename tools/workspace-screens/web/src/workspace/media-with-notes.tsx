// src/workspace/media-with-notes.tsx
//
// PURPOSE
//   One opened file, wherever it opens (a space, anything else that shows a kept file in place): the file itself
//   drawn by the one file preview, and beside it on a wide pane, under it on a narrow one, what the person said about
//   it and a box to say more (SayAboutThis). On a recording, a note is kept at the moment the player is on and pressing
//   that moment plays from there. The file tab (file-screen.tsx) composes the same two parts around its own path and
//   card, and an opened post keeps its notes on the post itself (posts-screen.tsx); every other host uses this.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Nothing here names a screen or a kind of file: the host hands the file's identity, its address, its type and its
//      name. Whether it is a recording is read from its type (say-about-this.tsx isRecording), as the file tab reads it.
//   2. The player loads only when a file is opened, so a host's screen opens without it.
//   3. Private notes are the person's kept messages about `file:<identity>`, the same ones the file tab lists and
//      every AI reads. A shared room host supplies its item identity and audience, so critiques stay with that room.
//   4. Saved words arrive after the player shows. A room reads only its currently admitted recording's transcript,
//      never the contributor's private results route; late answers cannot follow a different file or audience.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import React from 'react';
import { lazyPart } from '../../parts/ui/show/load-later/later';
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { Button, Container } from '../../parts/ui';
import { SayAboutThis, isRecording, usePlayClock, type NoteSpace } from './say-about-this';
import { readItemJson, readJson, fileResultsPath } from './api';
import { onStoreChange } from './store-changes';
import { timedTextOf } from '../../parts/media-playback/read-data/kept-timed-text';
import type { TimedTextSegment } from '../../parts/media-playback/show/MediaPlaybackSurface';
import { PLACEABLE_SURFACE_MIME } from '../../parts/ui/show/placeable-surface-intent/placeable-surface-intent';

const FilePreview = lazyPart(() => import('../../parts/ui/show/file-preview/FilePreview'), module => module.FilePreview);

export function MediaWithNotes({ identity, url, contentType, label, poster, space }: {
  identity: string;
  url: string;
  contentType: string;
  label: string;
  poster?: string;
  space?: NoteSpace & { itemId: string; fileItemId?: string };
}) {
  const recording = isRecording(contentType);
  const sharedFileItemId = space?.fileItemId ?? space?.itemId;
  const editId = space && sharedFileItemId
      ? `media-${bytesToHex(blake3(new TextEncoder().encode(JSON.stringify([space.id, sharedFileItemId]))))}`
    : null;
  const openSharedEdit = () => {
    if (!space || !sharedFileItemId || !editId) return;
    window.dispatchEvent(new CustomEvent(PLACEABLE_SURFACE_MIME, { cancelable: true, detail: {
      id: 'trillion.media-edit', title: label,
      surfaceInput: { editId, title: label, space_id: space.id, clips: [{
        identity, name: label, start: 0, end: null, bytes: `/work/api/spaces/${encodeURIComponent(space.id)}/items/${encodeURIComponent(sharedFileItemId)}/bytes`,
        media_type: contentType, media_kind: 'video', shared_item_id: sharedFileItemId,
      }] },
    } }));
  };
  const playing = usePlayClock();
  const shared = Boolean(space);
  const transcriptPath = space
    ? `/work/api/spaces/${encodeURIComponent(space.id)}/items/${encodeURIComponent(space.fileItemId ?? space.itemId)}/transcript`
    : fileResultsPath(identity, 'transcript');
  const scope = JSON.stringify([identity, transcriptPath, recording]);
  const [words, setWords] = React.useState<{ scope: string; timedText: TimedTextSegment[] } | null>(null);
  const currentScope = React.useRef(scope);
  currentScope.current = scope;
  React.useEffect(() => {
    if (!recording) return;
    let active = true;
    let reading = 0;
    const read = async () => {
      const request = ++reading;
      const applies = () => active && currentScope.current === scope && reading === request;
      try {
        const kept = shared
          ? await readItemJson<{ segments?: unknown }>(transcriptPath)
          : await readJson<{ results: { value?: { segments?: unknown } }[] }>(transcriptPath);
        const passages = 'results' in kept ? kept.results?.[0]?.value?.segments : kept.segments;
        if (applies()) setWords({ scope, timedText: timedTextOf(identity, passages) });
      } catch {
        // A refused or changed grant clears the words while leaving playback's
        // independently checked byte reader to report its own availability.
        if (applies()) setWords(null);
      }
    };
    void read();
    const stop = onStoreChange(read);
    return () => { active = false; stop(); };
  }, [identity, transcriptPath, scope, recording, shared]);
  const timedText = words?.scope === scope ? words.timedText : undefined;
  return (
    <Container className="trillion-media-notes" data-media-with-notes="">
      <Container className="trillion-media-notes__row">
      <Container className="trillion-media-notes__stage">
        {space && contentType.toLowerCase().startsWith('video/') ? <Button size="sm" variant="secondary" onClick={openSharedEdit}>Edit with this project</Button> : null}
        <React.Suspense fallback={null}>
          <FilePreview url={url} contentType={contentType} label={label} poster={poster} autoPlay={false}
            timedText={timedText}
            onTimeChange={recording ? playing.heard : undefined} seekRequest={recording ? playing.seekRequest ?? undefined : undefined} />
        </React.Suspense>
      </Container>
      <Container className="trillion-media-notes__say">
        <SayAboutThis record={space?.itemId ?? `file:${identity}`} files={[{ identity }]} title={label} space={space}
          clock={recording ? playing.clock : null} onSeek={recording ? playing.seek : undefined} />
      </Container>
      </Container>
    </Container>
  );
}
