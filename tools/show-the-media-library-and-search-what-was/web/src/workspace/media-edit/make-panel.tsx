// src/workspace/media-edit/make-panel.tsx
//
// PURPOSE
//   The editor's Make panel: new pictures and sounds for this video. The person picks a style (a thumbnail about the
//   video, a striking picture of themselves from the selected clip, the frame under the playhead enhanced, a pencil
//   portrait, a cut-out, a cut-out on a new background, a sound effect, music), says what it is about when the style
//   needs words, and presses Make. Each style is its own Workshop tool (tool:make-<style>) that any AI can run too;
//   this panel runs the same tool through the one run owner (../workshop-tool-api.ts) and shows the files it kept.
//
// NON-NEGOTIABLE INVARIANTS
//   1. The styles are DATA: parts/media-composition/do-work/make-pictures-and-sounds.json, the same rows the tools are
//      listed from. What a style needs (a frame of the recording, words) is read from its input_schema; nothing here
//      names a style.
//   2. The recording is never changed. Every result is a new file kept in the person's files under Made by tools,
//      where the Layers panel's "Made with tools" shelf offers it to drop into the video.
//   3. What was made is remembered under `edit.panels.make`, so the results are still here when the edit reopens.
//   4. Every control is a shared part (Container, Card, Button, Input, Text, ScreenState, MediaPreview, FilePreview).

import React from 'react';
import { Button, Card, Container, Input, NamedIcon } from '../../../parts/ui';
import { FilePreview } from '../../../parts/ui/show/file-preview/FilePreview';
import { Text } from '../../../parts/ui/show/text';
import { ScreenState } from '../../../parts/ui/show/screen-state';
import { MediaPreview } from '../../../parts/ui/show/media-preview';
import makeRows from '../../../parts/media-composition/do-work/make-pictures-and-sounds.json';
import { runWorkshopTool } from '../workshop-tool-api';
import { failedState } from '../failure';
import { baseName, bytesAddress } from '../file-picture';
import { definePanel, type MediaEditPanelProps } from './panel-types';
import { PLACEABLE_SURFACE_MIME } from '../../../parts/ui/show/placeable-surface-intent/placeable-surface-intent';

// Opens Connections in its own tab, where the person connects the account a style uses.
const openConnections = () => { window.dispatchEvent(new CustomEvent(PLACEABLE_SURFACE_MIME, { cancelable: true, detail: { id: 'trillion.connections', title: 'Connections' } })); };

type Field = { type?: string; format?: string; description?: string };
type Style = { id: string; label: string; icon: string; makes: string; media_type: string; count: number; input_schema: { properties: Record<string, Field>; required?: string[] } };
type Made = { identity: string; name: string; media_type: string; style: string };
export type MakeState = { made: Made[] };
type Kept = { identity?: string; name?: string; media_type?: string | null };
type Making = { state: 'idle' } | { state: 'working'; label: string } | { state: 'failed'; error: unknown } | { state: 'needs-connection' };

const TOOL_PREFIX = 'tool:make-';
const STYLES: Style[] = (makeRows.things as { address: string; payload: Record<string, unknown> }[])
  .filter(thing => thing.payload.kind === 'media-generation-style')
  .map(thing => ({ ...(thing.payload as Omit<Style, 'id'>), id: thing.address.split('::').pop() as string }));
const clock = (seconds: number) => { const whole = Math.floor(Math.max(0, seconds)); return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`; };
// One key per press of Make, so pressing again makes new results instead of returning the last ones.
const once = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;

/** The field that names the recording, and the fields that take words, read from the style's own schema. */
function needsOf(style: Style) {
  const properties = style.input_schema.properties;
  const recording = Object.keys(properties).find(name => properties[name].format === 'namespace-file') ?? null;
  const words = Object.keys(properties).filter(name => name !== recording && properties[name].type === 'string');
  return { recording, words };
}

/** The files a finished run kept, one per output the tool declares. */
const keptFiles = (files: Record<string, Kept> | undefined, style: Style): Made[] => Object.values(files ?? {})
  .filter(file => typeof file.identity === 'string')
  .map(file => ({ identity: file.identity as string, name: file.name ? baseName(file.name) : style.label, media_type: file.media_type ?? style.media_type, style: style.id }));

function MakePanel({ active, playhead, timelineStart, activeTimelineEnd, editId, panelState, setPanelState, setStatus }: MediaEditPanelProps<MakeState>) {
  const made = panelState?.made ?? [];
  // What is kept when a run finishes: the results as they are then, not as they were when it started.
  const latest = React.useRef(made);
  latest.current = made;
  const [chosen, setChosen] = React.useState<Style>(STYLES[0]);
  const [words, setWords] = React.useState<Record<string, string>>({});
  const [making, setMaking] = React.useState<Making>({ state: 'idle' });
  const { recording, words: wordFields } = needsOf(chosen);
  // The second of the selected clip's recording under the playhead (its first frame when the playhead is elsewhere).
  const inside = active ? Math.min(Math.max(playhead, timelineStart), activeTimelineEnd) - timelineStart : 0;
  const at = active ? Math.round((active.start + Math.max(0, inside)) * 100) / 100 : 0;
  const missing = [...(recording && !active ? [recording] : []), ...wordFields.filter(name => (chosen.input_schema.required ?? []).includes(name) && !(words[name] ?? '').trim())];

  const make = async () => {
    const style = chosen;
    const input: Record<string, unknown> = {};
    if (recording && active) Object.assign(input, { [recording]: active.identity, at });
    for (const name of wordFields) if ((words[name] ?? '').trim()) input[name] = words[name].trim();
    setMaking({ state: 'working', label: style.label });
    setStatus(`Making ${style.label.toLowerCase()}.`);
    try {
      const ran = await runWorkshopTool(`${TOOL_PREFIX}${style.id}`, input, `media-edit-make:${editId}:${style.id}:${once()}`);
      const fresh = keptFiles(ran.files as Record<string, Kept> | undefined, style);
      if (!fresh.length) throw new Error('Nothing came back. Try again.');
      setPanelState({ made: [...fresh, ...latest.current] });
      setMaking({ state: 'idle' });
      setStatus(`${fresh.length} made and kept in your files. Open Layers to put ${fresh.length === 1 ? 'it' : 'them'} in the video.`);
    } catch (failure) {
      const connect = (failure as { missing_connection?: string }).missing_connection;
      setMaking(connect ? { state: 'needs-connection' } : { state: 'failed', error: failure });
    }
  };

  return (
    <Container data-media-edit-panel="make" layout="vertical" gap="md" minHeight="0">
      <Container layout="grid" gridCols={2} gap="xs" aria-label="What to make">
        {STYLES.map(style => <Button key={style.id} size="sm" variant={chosen.id === style.id ? 'accent' : 'secondary'} aria-pressed={chosen.id === style.id}
          className="h-auto min-h-14 flex-col items-start justify-start gap-1 whitespace-normal py-2 text-left"
          onClick={() => { setChosen(style); setMaking(now => (now.state === 'failed' || now.state === 'needs-connection' ? { state: 'idle' } : now)); }}>
          <NamedIcon name={style.icon} aria-hidden="true" />{style.label}
        </Button>)}
      </Container>

      <Card variant="nested" padding="sm" aria-label={chosen.label}>
        <Container layout="vertical" gap="sm">
          {recording ? <Text variant="caption" color="muted">{active ? `From ${active.name} at ${clock(at)}. Move the playhead to choose another moment.` : 'Select a clip to take the picture from.'}</Text> : null}
          {wordFields.map(name => <Input key={`${chosen.id}:${name}`} label={chosen.input_schema.properties[name].description ?? name} aria-label={chosen.input_schema.properties[name].description ?? name}
            value={words[name] ?? ''} onChange={event => setWords(rows => ({ ...rows, [name]: event.target.value }))} />)}
          <Button size="sm" variant="accent" fullWidth disabled={making.state === 'working' || missing.length > 0} onClick={() => make()}>
            {making.state === 'working' ? 'Making' : `Make ${chosen.count === 1 ? 'one' : chosen.count}`}
          </Button>
        </Container>
      </Card>

      {making.state === 'working' ? <ScreenState state={{ status: 'loading', label: `Making ${making.label.toLowerCase()}` }} /> : null}
      {making.state === 'failed' ? <ScreenState state={failedState(making.error, () => { void make(); }, 'It was not made')} /> : null}
      {making.state === 'needs-connection' ? <ScreenState state={{ status: 'empty', icon: 'Plug', title: 'Connect your account first', description: 'This style uses your own connected account. Connect it, then make it again.', action: { label: 'Connect your account', run: openConnections } }} /> : null}

      <Container as="section" aria-label="Made for this video" layout="vertical" gap="sm">
        <Text variant="body-xs" weight="semibold">Made for this video</Text>
        {made.length ? <Text variant="caption" color="muted">Each one is kept in your files. Open Layers to put it in the video: it is under Made with tools.</Text>
          : <Text variant="caption" color="faint">Nothing made yet. Choose a style above and press Make.</Text>}
        <Container layout="vertical" gap="sm">
          {made.map(item => <Card key={item.identity} variant="nested" padding="sm" aria-label={item.name}>
            <Container layout="vertical" gap="xs">
              {item.media_type.startsWith('image/')
                ? <Container layout="vertical" gap="none" className="aspect-video w-full overflow-hidden rounded"><MediaPreview renderer="image" source={bytesAddress(item.identity)} title={item.name} typeLabel="Picture" /></Container>
                : <FilePreview url={bytesAddress(item.identity)} contentType={item.media_type} label={item.name} autoPlay={false} />}
              <Text variant="caption" className="truncate">{item.name}</Text>
            </Container>
          </Card>)}
        </Container>
      </Container>
    </Container>
  );
}

export const makePanel = definePanel<MakeState>({
  id: 'make',
  label: 'Make',
  icon: 'ImagePlus',
  Panel: MakePanel,
});
