// src/workspace/media-edit/layers-panel.tsx
//
// PURPOSE
//   The editor's Layers panel: sounds under the video (music, voice-over, sound effects) and pictures over it
//   (picture in picture, a logo, b-roll), each from the person's own files, placed at a second of the cut, trimmed,
//   with its volume, fades and ducking, or its position, size and opacity. A shelf shows what the person made with
//   tools, ready to drop in. What kinds of layer can be added is DATA (layer-presets.json).
//
// NON-NEGOTIABLE INVARIANTS
//   1. A layer becomes the rendered video through parts/media-composition/read-data/layers-to-edit.mjs, the same
//      translation the Workshop tools `tool:mix-sound-layers` and `tool:layer-pictures-over-video` use.
//   2. The panel's choices are saved under `edit.panels.layers`; an edit saved before layers existed opens with its
//      single music bed as the first sound layer (`fromSavedEdit`).
//   3. A layer with unusable numbers is named on screen with the reason and left out of the video until fixed; it is
//      never dropped quietly.
//   4. The person's files are read only when this panel is opened, so the editor still paints without a request.
//   5. Every control is a shared part (Button, Input, Slider, Toggle, PositionGrid, Card, Container, MediaPreview,
//      ScreenState); this file authors no markup of its own.

import React from 'react';
import { Button, Card, Container, Input, PositionGrid, Slider, Toggle } from '../../../parts/ui';
import { Text } from '../../../parts/ui/show/text';
import { ScreenState } from '../../../parts/ui/show/screen-state';
import { MediaPreview } from '../../../parts/ui/show/media-preview';
import { layerProblems, layersToEdit, soundFromMusicBed } from '../../../../../media-composition/read-data/layers-to-edit.mjs';
import { readJson } from '../api';
import { askSearch, type SearchAnswer } from '../search-results';
import { failedState } from '../failure';
import presets from './layer-presets.json';
import { definePanel, type MediaEditLayer, type MediaEditLayerChange, type MediaEditPanelContext, type MediaEditPanelProps } from './panel-types';

type SoundLayer = { id: string; label: string; name: string; file: string; start: number; from: number; to: number | null; volume: number; fade_in: number; fade_out: number; duck: boolean };
type PictureLayer = { id: string; label: string; name: string; file: string; bytes: string; kind: 'image' | 'video'; start: number; from: number; to: number; x: number; y: number; size: number; opacity: number };
export type LayersState = { sounds: SoundLayer[]; pictures: PictureLayer[]; loudness?: number };
type SoundPreset = (typeof presets.sounds)[number];
type PicturePreset = (typeof presets.pictures)[number];
type Preset = SoundPreset | PicturePreset;
type LibraryRow = { identity: string; origin: string; name: string; media_kind: string | null; file: string | null; bytes: string | null; duration?: number | null };
type Library = { revision: string; rows: LibraryRow[]; next_after?: string | null; reset?: boolean };
type Files = { state: 'reading' } | { state: 'failed'; error: unknown }
  | { state: 'ready'; library: Library; loadingMore: boolean; moreError?: unknown };

const EMPTY: LayersState = { sounds: [], pictures: [] };
const MADE = 'made';
const BYTES = '/work/api/namespace/bytes/';
const DRAG_TYPE = 'application/x-trillion-layer-file';
const newId = () => globalThis.crypto?.randomUUID?.() ?? `layer-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const clock = (seconds: number) => { const whole = Math.floor(Math.max(0, seconds)); return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`; };
const percent = (value: number) => `${Math.round(value * 100)}%`;
const round2 = (value: number) => Math.round(value * 100) / 100;
const isSoundPreset = (preset: Preset): preset is SoundPreset => presets.sounds.some(row => row.id === preset.id);
/** Which of three cells across (or down) a centre at `share` of the frame sits in. */
const cell = (share: number) => Math.max(0, Math.min(2, Math.floor(share * 3)));
const previewRenderer = (kind: string | null) => (kind === 'image' ? 'image' : kind === 'video' ? 'video-frame' : 'type-icon');
const libraryAddress = (origin: string | null, after?: string | null, revision?: string) => {
  const query = new URLSearchParams({ limit: '60', stored: 'true', previews: 'false' });
  if (origin) query.set('origin', origin);
  if (after) query.set('after', after);
  if (revision) query.set('revision', revision);
  return `/work/api/media/library?${query}`;
};

/** One bounded shelf. A changed library resets at its newest page; older rows remain reachable with Show more. */
function useLibraryPages(origin: string | null, enabled: boolean) {
  const [files, setFiles] = React.useState<Files>({ state: 'reading' });
  const [attempt, retry] = React.useReducer((count: number) => count + 1, 0);
  const generation = React.useRef(0);
  const loading = React.useRef(false);
  React.useEffect(() => {
    if (!enabled) return;
    const current = ++generation.current;
    loading.current = false;
    setFiles({ state: 'reading' });
    void readJson<Library>(libraryAddress(origin)).then(library => {
      if (generation.current === current) setFiles({ state: 'ready', library, loadingMore: false });
    }, error => { if (generation.current === current) setFiles({ state: 'failed', error }); });
    return () => { generation.current += 1; };
  }, [origin, enabled, attempt]);
  const showMore = () => {
    if (files.state !== 'ready' || !files.library.next_after || loading.current) return;
    const before = files.library;
    const current = generation.current;
    loading.current = true;
    setFiles({ state: 'ready', library: before, loadingMore: true });
    void readJson<Library>(libraryAddress(origin, before.next_after, before.revision)).then(page => {
      if (generation.current !== current) return;
      setFiles(previous => {
        if (previous.state !== 'ready' || previous.library !== before) return previous;
        if (page.reset) return { state: 'ready', library: page, loadingMore: false };
        const seen = new Set(before.rows.map(row => row.identity));
        return { state: 'ready', library: { ...page, rows: [...before.rows, ...page.rows.filter(row => !seen.has(row.identity))] }, loadingMore: false };
      });
    }, error => {
      if (generation.current === current) setFiles(previous => previous.state === 'ready' && previous.library === before
        ? { state: 'ready', library: before, loadingMore: false, moreError: error } : previous);
    }).finally(() => { if (generation.current === current) loading.current = false; });
  };
  return { files, retry, showMore };
}

/** A layer's problems, in plain words (the shared check, run on this one layer). */
const soundProblems = (layer: SoundLayer): string[] => layerProblems({ sounds: [layer] }).map((text: string) => text.replace(/^Sound 1 /, 'It '));
const pictureProblems = (layer: PictureLayer): string[] => layerProblems({ pictures: [layer] }).map((text: string) => text.replace(/^Picture 1 /, 'It '));

/** The rendered edit's sound and picture fields for the usable layers, merged over what the edit already has. */
function layersEdit(state: LayersState | undefined, context: MediaEditPanelContext, edit: Record<string, unknown> = {}) {
  if (!state) return undefined;
  const sounds = state.sounds.filter(layer => !soundProblems(layer).length);
  const pictures = state.pictures.filter(layer => !pictureProblems(layer).length);
  const fields = layersToEdit({ sounds, pictures, loudness: state.loudness }, { frameWidth: context.dimensions[0], edl: edit });
  return Object.keys(fields).length ? fields : undefined;
}

/** A saved edit from before layers: its single music bed plays on as the first sound layer. */
function fromSavedEdit(edl: Record<string, unknown>): LayersState | undefined {
  const sound = soundFromMusicBed((edl.audio_graph as { music_bed?: unknown } | undefined)?.music_bed);
  return sound ? { sounds: [{ ...sound, id: newId(), name: 'Saved music' }], pictures: [] } : undefined;
}

/** The layers as the preview plays them and the timeline shows them: sounds on the sounds lane, pictures on theirs. */
function layersShown(state: LayersState | undefined): MediaEditLayer[] {
  if (!state) return [];
  return [
    ...state.sounds.filter(layer => !soundProblems(layer).length).map(layer => ({ id: layer.id, lane: 'sounds', label: `${layer.label} · ${layer.name}`, identity: layer.file,
      bytes: `${BYTES}${encodeURIComponent(layer.file)}`, mediaKind: 'audio', plays: 'sound' as const, start: layer.start, in: layer.from, out: layer.to, volume: layer.volume })),
    ...state.pictures.filter(layer => !pictureProblems(layer).length).map(layer => ({ id: layer.id, lane: 'overlays', label: `${layer.label} · ${layer.name}`, identity: layer.file,
      bytes: layer.bytes, mediaKind: layer.kind, plays: 'picture' as const, start: layer.start, in: layer.from, out: layer.to, x: layer.x, y: layer.y, scale: layer.size, opacity: layer.opacity })),
  ];
}

/** The choices after one layer was retimed on the timeline (start, in, out) or moved in the preview (x, y, scale). */
function changeLayer(state: LayersState | undefined, id: string, change: MediaEditLayerChange): LayersState | undefined {
  if (!state) return state;
  const times = { ...(change.start !== undefined ? { start: round2(change.start) } : {}), ...(change.in !== undefined ? { from: round2(change.in) } : {}), ...(change.out !== undefined ? { to: round2(change.out) } : {}) };
  const place = { ...(change.x !== undefined ? { x: round2(change.x) } : {}), ...(change.y !== undefined ? { y: round2(change.y) } : {}), ...(change.scale !== undefined ? { size: round2(change.scale) } : {}) };
  return {
    ...state,
    sounds: state.sounds.map(layer => layer.id === id ? { ...layer, ...times } : layer),
    pictures: state.pictures.map(layer => layer.id === id ? { ...layer, ...times, ...place } : layer),
  };
}

/** A seconds field that keeps what the person types and hands on each usable number. */
function SecondsField({ label, value, onValue, optional = false }: { label: string; value: number | null; onValue: (value: number | null) => void; optional?: boolean }) {
  return <Input label={label} aria-label={label} type="number" min="0" step="0.1" defaultValue={value === null ? '' : String(value)} placeholder={optional ? 'To the end' : undefined}
    onChange={event => { const text = event.target.value.trim(); if (optional && text === '') onValue(null); else if (text !== '' && Number.isFinite(Number(text))) onValue(Number(text)); }} />;
}

function Problems({ problems }: { problems: string[] }) {
  return problems.length ? <Text variant="caption" color="error" role="alert">{`${problems.join(' ')} It is left out of the video until this is fixed.`}</Text> : null;
}

function LayersPanel({ panelState, setPanelState, timelineStart, total, setStatus }: MediaEditPanelProps<LayersState>) {
  const state = panelState ?? EMPTY;
  const [adding, setAdding] = React.useState<Preset | null>(null);
  const [needOthers, setNeedOthers] = React.useState(false);
  const madeFiles = useLibraryPages(MADE, true);
  const otherFiles = useLibraryPages(null, needOthers);
  const [searchText, setSearchText] = React.useState('');
  const [searched, setSearched] = React.useState('');
  const [searchAttempt, retrySearch] = React.useReducer((count: number) => count + 1, 0);
  const [searchAnswer, setSearchAnswer] = React.useState<SearchAnswer | null>(null);
  const [searchFailed, setSearchFailed] = React.useState(false);
  React.useEffect(() => { if (adding) setNeedOthers(true); }, [adding]);
  React.useEffect(() => {
    if (!searched) return;
    setSearchAnswer(null);
    setSearchFailed(false);
    return askSearch(searched, setSearchAnswer, () => setSearchFailed(true), { sources: ['files'] });
  }, [searched, searchAttempt]);

  const save = (next: LayersState) => setPanelState(next);
  const madeRows = madeFiles.files.state === 'ready' ? madeFiles.files.library.rows.filter(row => Boolean(row.file && row.bytes)) : [];
  const otherRows = otherFiles.files.state === 'ready' ? otherFiles.files.library.rows.filter(row => Boolean(row.file && row.bytes) && row.origin !== MADE) : [];
  const searchRows: LibraryRow[] = searchAnswer?.question === searched ? searchAnswer.results.filter(row => Boolean(row.identity && row.file && row.bytes)).map(row => ({
    identity: row.identity!, origin: 'search', name: row.name, media_kind: row.media_kind, file: row.file, bytes: row.bytes, duration: row.duration,
  })) : [];
  const rows = [...madeRows, ...otherRows, ...searchRows];
  const fits = (preset: Preset | null) => (row: LibraryRow) => !preset || preset.families.includes(row.media_kind ?? '');
  const presetFor = (row: LibraryRow) => [...presets.sounds, ...presets.pictures].find(preset => preset.families.includes(row.media_kind ?? '')) ?? null;
  const room = Math.max(0, total - timelineStart);

  const add = (preset: Preset, row: LibraryRow) => {
    const start = round2(timelineStart);
    const length = typeof row.duration === 'number' && row.duration > 0 ? row.duration : null;
    if (isSoundPreset(preset)) {
      save({ ...state, sounds: [...state.sounds, { id: newId(), label: preset.label, name: row.name, file: row.file as string, start, from: 0, to: length, ...preset.defaults }] });
    } else {
      const kind = row.media_kind === 'image' ? 'image' : 'video';
      const { seconds, ...place } = preset.defaults;
      const shows = Math.max(0.5, Math.min(seconds ?? room, kind === 'video' && length ? length : Infinity, room || Infinity));
      save({ ...state, pictures: [...state.pictures, { id: newId(), label: preset.label, name: row.name, file: row.file as string, bytes: row.bytes as string, kind, start, from: 0, to: round2(shows), ...place }] });
    }
    setAdding(null);
    setStatus(`${preset.label} added at ${clock(start)}.`);
  };
  const drop = (event: React.DragEvent) => {
    const row = rows.find(item => item.identity === event.dataTransfer.getData(DRAG_TYPE));
    const preset = row && adding && fits(adding)(row) ? adding : row ? presetFor(row) : null;
    if (!row || !preset) return;
    event.preventDefault();
    add(preset, row);
  };
  const patchSound = (id: string, patch: Partial<SoundLayer>) => save({ ...state, sounds: state.sounds.map(layer => layer.id === id ? { ...layer, ...patch } : layer) });
  const patchPicture = (id: string, patch: Partial<PictureLayer>) => save({ ...state, pictures: state.pictures.map(layer => layer.id === id ? { ...layer, ...patch } : layer) });
  const movePicture = (index: number, delta: number) => {
    const to = index + delta; if (to < 0 || to >= state.pictures.length) return;
    const pictures = [...state.pictures]; [pictures[index], pictures[to]] = [pictures[to], pictures[index]];
    save({ ...state, pictures });
  };

  const fileButton = (row: LibraryRow) => <Button key={row.identity} size="sm" variant="secondary" draggable
    className="h-auto w-32 shrink-0 flex-col items-stretch gap-1 py-2"
    aria-label={adding ? `Add ${row.name} as ${adding.label}` : `Add ${row.name}`}
    onDragStart={event => { event.dataTransfer.setData(DRAG_TYPE, row.identity); event.dataTransfer.effectAllowed = 'copy'; }}
    onClick={() => { const preset = adding ?? presetFor(row); if (preset) add(preset, row); }}>
    <Container layout="vertical" gap="none" className="h-16 w-full overflow-hidden"><MediaPreview renderer={previewRenderer(row.media_kind)} source={row.bytes ?? undefined} at={0} title={row.name} typeLabel={row.media_kind ?? 'File'} /></Container>
    <Text variant="caption" className="w-full truncate text-left">{row.name}</Text>
  </Button>;
  const shelf = (label: string, hint: string, items: LibraryRow[], empty: string, pages?: ReturnType<typeof useLibraryPages>) => <Container as="section" aria-label={label} layout="vertical" gap="xs">
    <Text variant="caption" color="muted">{`${label} · ${hint}`}</Text>
    {items.length ? <Container layout="horizontal" gap="sm" className="overflow-x-auto pb-1">{items.map(fileButton)}</Container>
      : <Text variant="caption" color="faint">{pages?.files.state === 'ready' && pages.files.library.next_after ? 'Nothing on these pages fits yet. Show more to keep looking.' : empty}</Text>}
    {pages?.files.state === 'ready' && pages.files.library.next_after ? <Button size="xs" variant="ghost" disabled={pages.files.loadingMore} onClick={pages.showMore}>{pages.files.loadingMore ? 'Loading more' : `Show more ${label.toLowerCase()}`}</Button> : null}
    {pages?.files.state === 'ready' && pages.files.moreError ? <Text variant="caption" color="error">More files could not load. Try again.</Text> : null}
  </Container>;
  const presetButtons = (label: string, rowsOf: Preset[]) => <Container layout="horizontal" gap="xs" wrap aria-label={label}>
    {rowsOf.map(preset => <Button key={preset.id} size="xs" variant={adding?.id === preset.id ? 'accent' : 'secondary'} aria-pressed={adding?.id === preset.id} onClick={() => setAdding(adding?.id === preset.id ? null : preset)}>{preset.label}</Button>)}
  </Container>;

  const made = madeRows.filter(fits(adding));
  const others = otherRows.filter(fits(adding));
  const found = searchRows.filter(fits(adding));
  const choose = adding ? `choose one for ${adding.label}` : 'click one, or drag it onto the layers';

  return (
    <Container data-media-edit-panel="layers" layout="vertical" gap="md" minHeight="0"
      onDragOver={(event: React.DragEvent) => { if (event.dataTransfer.types.includes(DRAG_TYPE)) event.preventDefault(); }} onDrop={drop}>
      <Container layout="vertical" gap="sm">
        <Text variant="body-xs" weight="semibold">{`Add at ${clock(timelineStart)}, where the selected clip starts`}</Text>
        {presetButtons('Add a sound', presets.sounds)}
        {presetButtons('Add a picture', presets.pictures)}
      </Container>

      <Container layout="horizontal" gap="xs" alignItems="end" wrap>
        <Input label="Find a file" value={searchText} onChange={event => setSearchText(event.currentTarget.value)} placeholder="Search your files" />
        <Button size="sm" variant="secondary" disabled={!searchText.trim()} onClick={() => { setSearched(searchText.trim()); retrySearch(); }}>Find files</Button>
        {searched ? <Button size="sm" variant="ghost" onClick={() => { setSearched(''); setSearchText(''); setSearchAnswer(null); }}>Clear search</Button> : null}
      </Container>
      {searched && !searchAnswer && !searchFailed ? <ScreenState state={{ status: 'loading', label: 'Searching your files' }} /> : null}
      {searched && searchFailed ? <Text variant="caption" color="error">Search could not finish. Press Find files to try again.</Text> : null}
      {searched && searchAnswer?.pending.length ? <Text variant="caption" color="muted">Still searching your files.</Text> : null}
      {searched && searchAnswer ? shelf('Search results', choose, found, searchAnswer.pending.length ? 'Still searching your files.' : 'No stored file matches this search.') : null}
      {madeFiles.files.state === 'reading' ? <ScreenState state={{ status: 'loading', label: 'Reading media made with tools' }} /> : null}
      {madeFiles.files.state === 'failed' ? <ScreenState state={failedState(madeFiles.files.error, madeFiles.retry, 'Media made with tools could not load')} /> : null}
      {madeFiles.files.state === 'ready' ? shelf('Made with tools', choose, made, 'Nothing made with tools fits here yet.', madeFiles) : null}
      {adding && otherFiles.files.state === 'reading' ? <ScreenState state={{ status: 'loading', label: 'Reading your files' }} /> : null}
      {adding && otherFiles.files.state === 'failed' ? <ScreenState state={failedState(otherFiles.files.error, otherFiles.retry, 'Your files could not load')} /> : null}
      {adding && otherFiles.files.state === 'ready' ? shelf('Your files', choose, others, 'No uploaded file fits here yet. Upload one in Files.', otherFiles) : null}

      <Container as="section" aria-label="Sounds" layout="vertical" gap="sm">
        <Text variant="body-xs" weight="semibold">Sounds</Text>
        {state.sounds.length ? null : <Text variant="caption" color="faint">No sounds yet. Choose Music, Voice-over or Sound effect above.</Text>}
        {state.sounds.map(layer => <Card key={layer.id} variant="nested" padding="sm" aria-label={`${layer.label}: ${layer.name}`}>
          <Container layout="vertical" gap="sm">
            <Container layout="horizontal" gap="sm" alignItems="center" justifyContent="between">
              <Text variant="body-xs" weight="semibold">{`${layer.label} · ${layer.name}`}</Text>
              <Button size="xs" variant="ghost" aria-label={`Remove ${layer.label} ${layer.name}`} onClick={() => save({ ...state, sounds: state.sounds.filter(row => row.id !== layer.id) })}>Remove</Button>
            </Container>
            <Container layout="grid" gridCols={2} gap="sm">
              <SecondsField label="Starts in the video at" value={layer.start} onValue={value => patchSound(layer.id, { start: value ?? 0 })} />
              <SecondsField label="Play from (in the file)" value={layer.from} onValue={value => patchSound(layer.id, { from: value ?? 0 })} />
              <SecondsField label="Play until (in the file)" value={layer.to} optional onValue={value => patchSound(layer.id, { to: value })} />
              <SecondsField label="Fade in (seconds)" value={layer.fade_in} onValue={value => patchSound(layer.id, { fade_in: value ?? 0 })} />
              <SecondsField label="Fade out (seconds)" value={layer.fade_out} onValue={value => patchSound(layer.id, { fade_out: value ?? 0 })} />
            </Container>
            <Slider label="Volume" min={0} max={2} step={0.05} value={layer.volume} valueLabel={percent(layer.volume)} onValueChange={value => patchSound(layer.id, { volume: value })} />
            <Toggle label="Duck under speech" description="Gets quieter while someone speaks" checked={layer.duck} onCheckedChange={duck => patchSound(layer.id, { duck })} />
            <Problems problems={soundProblems(layer)} />
          </Container>
        </Card>)}
      </Container>

      <Container as="section" aria-label="Pictures" layout="vertical" gap="sm">
        <Text variant="body-xs" weight="semibold">Pictures, back to front</Text>
        {state.pictures.length ? null : <Text variant="caption" color="faint">No pictures yet. Choose Picture in picture, Logo or B-roll above.</Text>}
        {state.pictures.map((layer, index) => <Card key={layer.id} variant="nested" padding="sm" aria-label={`${layer.label}: ${layer.name}`}>
          <Container layout="vertical" gap="sm">
            <Container layout="horizontal" gap="sm" alignItems="center" justifyContent="between" wrap>
              <Container layout="horizontal" gap="sm" alignItems="center">
                <Container layout="vertical" gap="none" className="h-10 w-16 shrink-0 overflow-hidden rounded"><MediaPreview renderer={previewRenderer(layer.kind)} source={layer.bytes} at={layer.from} title={layer.name} typeLabel={layer.kind === 'image' ? 'Picture' : 'Video'} /></Container>
                <Text variant="body-xs" weight="semibold">{`${layer.label} · ${layer.name}`}</Text>
              </Container>
              <Container layout="horizontal" gap="xs" wrap>
                <Button size="xs" variant="ghost" disabled={index === 0} onClick={() => movePicture(index, -1)}>Send backward</Button>
                <Button size="xs" variant="ghost" disabled={index === state.pictures.length - 1} onClick={() => movePicture(index, 1)}>Bring forward</Button>
                <Button size="xs" variant="ghost" aria-label={`Remove ${layer.label} ${layer.name}`} onClick={() => save({ ...state, pictures: state.pictures.filter(row => row.id !== layer.id) })}>Remove</Button>
              </Container>
            </Container>
            <Container layout="grid" gridCols={2} gap="sm">
              <SecondsField label="Shows in the video at" value={layer.start} onValue={value => patchPicture(layer.id, { start: value ?? 0 })} />
              {layer.kind === 'video' ? <SecondsField label="Play from (in the file)" value={layer.from} onValue={value => patchPicture(layer.id, { from: value ?? 0, to: (value ?? 0) + (layer.to - layer.from) })} /> : null}
              <SecondsField label="Shows for (seconds)" value={round2(layer.to - layer.from)} onValue={value => patchPicture(layer.id, { to: layer.from + (value ?? 0) })} />
            </Container>
            <Container layout="vertical" gap="sm">
              <PositionGrid label="Where" rows={3} columns={3} value={`${cell(layer.y)}:${cell(layer.x)}`} valueLabel={`${percent(layer.x)} across, ${percent(layer.y)} down`}
                onValueChange={value => { const [row, column] = value.split(':').map(Number); patchPicture(layer.id, { x: (column + 0.5) / 3, y: (row + 0.5) / 3 }); }} />
              <Container layout="vertical" gap="sm">
                <Slider label="Across" min={0} max={1} step={0.01} value={layer.x} valueLabel={percent(layer.x)} onValueChange={x => patchPicture(layer.id, { x })} />
                <Slider label="Down" min={0} max={1} step={0.01} value={layer.y} valueLabel={percent(layer.y)} onValueChange={y => patchPicture(layer.id, { y })} />
                <Slider label="Size" min={0.05} max={1} step={0.01} value={layer.size} valueLabel={`${percent(layer.size)} of the width`} onValueChange={size => patchPicture(layer.id, { size })} />
                <Slider label="Opacity" min={0} max={1} step={0.01} value={layer.opacity} valueLabel={percent(layer.opacity)} onValueChange={opacity => patchPicture(layer.id, { opacity })} />
              </Container>
            </Container>
            <Problems problems={pictureProblems(layer)} />
          </Container>
        </Card>)}
      </Container>

      <Toggle label="Even out the loudness" description="The finished video plays at one steady level, as video sites expect" checked={state.loudness !== undefined}
        onCheckedChange={on => { const { loudness: _loudness, ...rest } = state; save(on ? { ...rest, loudness: presets.loudness_lufs } : rest); }} />
      <Text variant="caption" color="faint">Playing the whole cut plays these sounds and shows these pictures; drag a picture there to move it, or its corner to resize it. Fades, ducking and even loudness are heard in the rendered video.</Text>
    </Container>
  );
}

export const layersPanel = definePanel<LayersState>({ id: 'layers', label: 'Layers', icon: 'PictureInPicture2', Panel: LayersPanel, edl: layersEdit, fromSavedEdit, layers: layersShown, changeLayer });
