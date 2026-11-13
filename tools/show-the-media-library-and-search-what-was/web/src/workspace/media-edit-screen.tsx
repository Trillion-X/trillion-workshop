// src/workspace/media-edit-screen.tsx
//
// Media edits open from the clip data already on the tab. The shared player
// previews a selected stretch; the same ordered clip list is saved and rendered.

import { openFile } from './open-screen';
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { Button, Container, ExpandableTabs, Input, NamedIcon, SegmentedControl } from '../../parts/ui';
import { loadScreen } from '../../parts/ui/show/screen-state';
import { PlanNeeded, files, postJson, readFileJson, readJson } from './api';
import { planNeededTitle, refusal } from './failure';
import { PLACEABLE_SURFACE_MIME } from '../../parts/ui/show/placeable-surface-intent/placeable-surface-intent';
import { HoverPreview } from '../../parts/ui/show/hover-preview';
import { MediaPreview } from '../../parts/ui/show/media-preview';
import { PANELS } from './media-edit/panels';
import type { MediaEditClip, MediaEditLayerChange, MediaEditPanelContext } from './media-edit/panel-types';
import { CutPlayer, type CutPlayerScope } from './media-edit/cut-player';
import { CutTimeline, type TimelineAction } from './media-edit/cut-timeline';
import { clipAt, cutComposition, cutOffsets, laneClipId, moveTo, readLaneClipId, removeRange, splitAt } from './media-edit/cut-list';
import { useMeasuredLengths } from './media-edit/use-measured-lengths';
import { readRecordAt, subscribeRecordLabel } from './records';

import { errorWords } from '../../../../ui/show/safe-error-card/sanitize-error-text.ts';
type ClipInput = {
  identity?: unknown;
  file?: unknown;
  name?: unknown;
  title?: unknown;
  in?: unknown;
  out?: unknown;
  start?: unknown;
  end?: unknown;
  duration?: unknown;
  bytes?: unknown;
  media_type?: unknown;
  media_kind?: unknown;
  look_stack?: unknown;
  shared_item_id?: unknown;
};

type Clip = MediaEditClip & { sharedItemId?: string };

type Caption = { id: string; text: string; start: number; end: number };
type TextOverlay = { id: string; text: string; start: number; end: number };
type SavedEdl = { spine?: { segments?: Array<{ look_stack?: string }> }; text_overlays?: Array<{ text?: string; start?: number; end?: number }>; subtitles?: { ass?: string };
  audio_graph?: Record<string, unknown> };

type Props = { surfaceInput?: Record<string, unknown> };
type EditValue = { clips: ClipInput[]; panels?: Record<string, unknown>; ratio?: string; file?: string; captions?: Caption[]; textOverlays?: TextOverlay[]; edl?: SavedEdl; title?: string; shared_files?: Record<string, string> };
type SavedEditAnswer = { edit?: EditValue | null; found?: boolean; revision?: number | null; value?: EditValue | null };
/** A saved edit and the edit description it was saved as. */
type SavedEdit = { edit: EditValue; edl: SavedEdl | undefined; revision?: number | null; deleted?: boolean };

/** The saved edit `id` names, or null when there is none; 'failed' when it could not be read, since the clips in the
 *  tab can still be edited without it. */
async function readSavedEdit(id: string, spaceId?: string, fallbackClips: Clip[] = []): Promise<SavedEdit | 'failed' | null> {
  try {
    const result = await readJson<SavedEditAnswer>(`/work/api/media/edit?id=${encodeURIComponent(id)}${spaceId ? `&space_id=${encodeURIComponent(spaceId)}` : ''}`);
    const edit = spaceId ? (result.found ? result.value : null) : result.edit;
    if (!edit) {
      if (spaceId && result.revision !== null && result.revision !== undefined) return {
        edit: { clips: fallbackClips.map(clip => ({ identity: clip.identity, name: clip.name, start: clip.start, end: clip.end, bytes: clip.bytes,
          media_type: clip.mediaType, media_kind: clip.mediaKind, ...(clip.sharedItemId ? { shared_item_id: clip.sharedItemId } : {}) })) },
        edl: undefined, revision: result.revision, deleted: true,
      };
      return null;
    }
    const clips = spaceId ? await Promise.all(edit.clips.map(async clip => {
      if (typeof clip.shared_item_id !== 'string') return clip;
      const bytes = `/work/api/spaces/${encodeURIComponent(spaceId)}/items/${encodeURIComponent(clip.shared_item_id)}/bytes`;
      return { ...clip, bytes };
    })) : edit.clips;
    const restored = { ...edit, clips };
    const edl = restored.edl ?? (restored.file ? await readFileJson<SavedEdl>(restored.file) : undefined);
    return { edit: restored, edl, ...(spaceId ? { revision: result.revision ?? null } : {}) };
  } catch {
    return 'failed';
  }
}

const finite = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : null;
const clock = (seconds: number) => {
  const whole = Math.floor(Math.max(0, seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
};

const FRAME_SIZES: Record<string, [number, number]> = { '16:9': [1920, 1080], '9:16': [1080, 1920], '4:5': [1080, 1350], '1:1': [1080, 1080] };

// Captions are burned in by the Captions panel (media-edit/captions-panel.tsx) in the chosen caption style.
function assSeconds(value: string): number {
  const match = /^(\d+):(\d{2}):(\d{2})\.(\d{2})$/.exec(value);
  if (!match) return 0;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4]) / 100;
}

function captionsFromAss(value: unknown): Caption[] {
  if (typeof value !== 'string') return [];
  const rows = value.split(/\r?\n/).flatMap((row, index) => {
    if (!row.startsWith('Dialogue: ')) return [];
    const fields = row.slice('Dialogue: '.length).split(',');
    if (fields.length < 10) return [];
    const start = assSeconds(fields[1]);
    const end = assSeconds(fields[2]);
    // A saved caption's own words, without the style's override blocks ({\an2\pos(…)}, {\k50}) or spacers.
    const text = fields.slice(9).join(',').replace(/\{[^}]*\}/g, '').replace(/\u200b/g, '').replace(/\\N/g, '\n').replace(/∖/g, '\\').trim();
    return text && end > start ? [{ layer: Number(fields[0]) || 0, caption: { id: `caption-${index}`, text, start, end } }] : [];
  });
  // The words are the top layer; a style's shadow is the same words once more on a layer beneath them.
  const top = Math.max(0, ...rows.map(row => row.layer));
  return rows.filter(row => row.layer === top).map(row => row.caption);
}

function textOverlaysFromEdl(value: unknown): TextOverlay[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item, index) => {
    if (!item || typeof item !== 'object') return [];
    const row = item as { text?: unknown; start?: unknown; end?: unknown };
    if (typeof row.text !== 'string' || !Number.isFinite(row.start) || !Number.isFinite(row.end) || (row.end as number) <= (row.start as number)) return [];
    return [{ id: `text-${index}`, text: row.text, start: row.start as number, end: row.end as number }];
  });
}

function readClips(value: unknown): Clip[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((row: ClipInput) => {
    if (!row || typeof row !== 'object') return [];
    const identity = typeof row.identity === 'string' ? row.identity : typeof row.file === 'string' ? row.file : '';
    const bytes = typeof row.bytes === 'string' ? row.bytes : '';
    const start = finite(row.in) ?? finite(row.start) ?? 0;
    const end = finite(row.out) ?? finite(row.end) ?? finite(row.duration);
    if (!identity || !bytes || (end !== null && end <= start)) return [];
    return [{
      identity,
      name: typeof row.title === 'string' ? row.title : typeof row.name === 'string' ? row.name : identity,
      start,
      end,
      bytes,
      mediaType: typeof row.media_type === 'string' ? row.media_type : '',
      mediaKind: typeof row.media_kind === 'string' ? row.media_kind : '',
      lookStack: typeof row.look_stack === 'string' ? row.look_stack : undefined,
      sharedItemId: typeof row.shared_item_id === 'string' ? row.shared_item_id : undefined,
    }];
  });
}

function fileIdentitiesIn(value: unknown): string[] {
  if (typeof value === 'string') return /^1f:[0-9a-f]{64}$/.test(value) ? [value] : [];
  if (Array.isArray(value)) return value.flatMap(fileIdentitiesIn);
  if (value && typeof value === 'object') return Object.values(value).flatMap(fileIdentitiesIn);
  return [];
}

function playableUrl(clip: Clip): string {
  const fragment = clip.end === null
    ? `#t=${clip.start}`
    : `#t=${clip.start},${clip.end}`;
  return `${clip.bytes}${fragment}`;
}

function MediaEdit({ id, saved, title, initialClips, spaceId }: { id: string; saved: SavedEdit | 'failed' | null; title: string; initialClips: Clip[]; spaceId?: string }) {
  const [clips, setClips] = React.useState(initialClips);
  const [selected, setSelected] = React.useState(0);
  const [past, setPast] = React.useState<Clip[][]>([]);
  const [future, setFuture] = React.useState<Clip[][]>([]);
  const [panel, setPanel] = React.useState('frame');
  const [ratio, setRatio] = React.useState('16:9');
  const [captions, setCaptions] = React.useState<Caption[]>([]);
  const [textOverlays, setTextOverlays] = React.useState<TextOverlay[]>([]);
  const [captionDraft, setCaptionDraft] = React.useState('');
  const [textDraft, setTextDraft] = React.useState('');
  const [startText, setStartText] = React.useState('');
  const [endText, setEndText] = React.useState('');
  const [status, setStatus] = React.useState('');
  const [savedFile, setSavedFile] = React.useState<string | null>(null);
  const [revision, setRevision] = React.useState<number | null>(saved && saved !== 'failed' ? saved.revision ?? null : null);
  const [hasSharedEdit, setHasSharedEdit] = React.useState(Boolean(spaceId && saved && saved !== 'failed' && saved.revision !== null && !saved.deleted));
  const [sharedFiles, setSharedFiles] = React.useState<Record<string, string>>(saved && saved !== 'failed' ? saved.edit.shared_files ?? {} : {});
  const [remoteEdit, setRemoteEdit] = React.useState<SavedEdit | null>(null);
  const [needsPlan, setNeedsPlan] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [panelStates, setPanelStates] = React.useState<Record<string, unknown>>({});
  const [playhead, setPlayhead] = React.useState(0);
  const [seekRequest, setSeekRequest] = React.useState<{ seconds: number; requestId: number } | null>(null);
  const [scope, setScope] = React.useState<CutPlayerScope>('cut');
  const [marked, setMarked] = React.useState<{ start: number | null; end: number | null }>({ start: null, end: null });
  const [laneChoice, setLaneChoice] = React.useState<string | null>(null);
  const active = clips[Math.min(selected, clips.length - 1)];
  const { offsets, total } = cutOffsets(clips);
  const measuring = useMeasuredLengths(clips, (identity, seconds) => setClips(rows => rows.map(row => row.identity === identity && row.end === null ? { ...row, end: seconds } : row)), setStatus);

  // The saved edit came with the screen's read (mountMediaEditScreen); it is put in place once, as the editor opens.
  React.useEffect(() => {
    if (saved === 'failed') { setStatus('The saved edit could not load. The clips in this tab are still here.'); return; }
    if (!saved) return;
    const restored = readClips(saved.edit.clips);
    if (!restored.length) return;
        const segments = saved.edl?.spine?.segments ?? [];
        setClips(restored.map((clip, index) => ({ ...clip, lookStack: segments[index]?.look_stack ?? clip.lookStack })));
        setSelected(0);
        if (saved.edit.ratio) setRatio(saved.edit.ratio);
        // A panel with nothing saved yet reads its choices from the saved edit itself (an edit from before it existed).
        const savedPanels = saved.edit.panels && typeof saved.edit.panels === 'object' ? saved.edit.panels : {};
        setPanelStates(Object.fromEntries(PANELS.flatMap(item => { const kept = savedPanels[item.id] ?? (saved.edl ? item.fromSavedEdit?.(saved.edl as Record<string, unknown>) : undefined); return kept === undefined ? [] : [[item.id, kept]]; })));
        if (saved.edit.file) setSavedFile(saved.edit.file);
        if (saved.revision !== undefined) setRevision(saved.revision);
        setSharedFiles(saved.edit.shared_files ?? {});
        if (saved.deleted) setHasSharedEdit(false);
        else if (saved.revision !== undefined) setHasSharedEdit(saved.revision !== null);
        setCaptions(Array.isArray(saved.edit.captions) ? saved.edit.captions : captionsFromAss(saved.edl?.subtitles?.ass));
        setTextOverlays(Array.isArray(saved.edit.textOverlays) ? saved.edit.textOverlays : textOverlaysFromEdl(saved.edl?.text_overlays));
    setStatus(saved.deleted ? 'This project edit was removed. Save to add it again.' : 'Saved edit restored.');
  }, [saved]);
  React.useEffect(() => {
    if (!spaceId) return;
    const label = `space-room:${spaceId}/shared:media-edit:${id}`;
    const applyNewer = () => {
      const current = readRecordAt<{ kind?: string; revision?: number; deleted?: boolean; value?: EditValue }>(label);
      if (current?.kind !== 'shared-record' || typeof current.revision !== 'number' || current.revision <= (revision ?? 0)) return;
      if (current.deleted) {
        setRemoteEdit({ edit: { clips: [] }, edl: undefined, revision: current.revision, deleted: true });
        setStatus('A teammate removed this project edit. Your current clips are still here.');
        return;
      }
      const edit = current.value;
      if (!edit) return;
      setRemoteEdit({ edit, edl: edit.edl, revision: current.revision });
      setStatus('A teammate saved a newer version. Your unsaved changes are still here.');
    };
    const stop = subscribeRecordLabel(label, applyNewer);
    applyNewer();
    return stop;
  }, [spaceId, id, revision]);
  React.useEffect(() => { if (active) { setStartText(String(active.start)); setEndText(String(active.end ?? '')); } }, [selected, active?.start, active?.end]);

  const change = (next: Clip[], choice = selected) => {
    if (!next.length) return;
    setPast(rows => [...rows.slice(-49), clips]); setFuture([]); setClips(next);
    setSelected(Math.max(0, Math.min(choice, next.length - 1))); setStatus('Unsaved changes.');
  };
  const trim = () => {
    const start = Number(startText), end = Number(endText);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) { setStatus('End must be later than start.'); return; }
    change(clips.map((clip, index) => index === selected ? { ...clip, start, end } : clip));
  };
  const attempt = (work: () => void) => { try { work(); } catch (error) { setStatus(errorWords(error)); } };
  const seek = (seconds: number) => { const at = Math.max(0, Math.min(total, seconds)); setPlayhead(at); setSeekRequest(prior => ({ seconds: at, requestId: (prior?.requestId ?? 0) + 1 })); const found = clipAt(clips, at); if (found && scope === 'cut') setSelected(found.index); };
  const split = () => attempt(() => { const result = splitAt(clips, playhead); change(result.clips, result.selected); });
  const takeOutMarked = () => attempt(() => {
    if (marked.start === null || marked.end === null) throw new Error('Mark where the stretch starts and ends first.');
    change(removeRange(clips, marked.start, marked.end), clipAt(clips, Math.min(marked.start, marked.end))?.index ?? selected);
    setMarked({ start: null, end: null });
    seek(Math.min(marked.start, marked.end));
  });
  const selectClip = (index: number) => { setSelected(index); setLaneChoice(null); seek(offsets[index] ?? 0); };
  const selectLaneClip = (clipId: string) => {
    setLaneChoice(clipId);
    const lane = readLaneClipId(clipId);
    if (lane?.lane === 'picture') setSelected(lane.index);
  };
  const trimLaneClip = (clipId: string, inPoint: number, outPoint: number) => {
    const lane = readLaneClipId(clipId);
    if (!lane || !(outPoint > inPoint)) return;
    if (lane.lane === 'picture') { change(clips.map((clip, index) => index === lane.index ? { ...clip, start: Math.round(inPoint * 1000) / 1000, end: Math.round(outPoint * 1000) / 1000 } : clip), lane.index); return; }
    if (lane.lane === 'layer') { changePanelLayer(lane.panel, lane.id, { in: inPoint, out: outPoint }); return; }
    const retime = <Row extends { id: string; start: number; end: number }>(rows: Row[]) => rows.map(row => row.id === lane.id ? { ...row, start: inPoint, end: outPoint } : row);
    setCaptions(retime); setTextOverlays(retime); markChanged();
  };
  const moveLaneClip = (clipId: string, laneStart: number) => {
    const lane = readLaneClipId(clipId);
    if (!lane) return;
    if (lane.lane === 'picture') { attempt(() => { const clip = clips[lane.index]; const result = moveTo(clips, lane.index, laneStart + ((clip.end ?? clip.start) - clip.start) / 2); change(result.clips, result.selected); setLaneChoice(laneClipId.picture(result.selected)); }); return; }
    if (lane.lane === 'layer') { changePanelLayer(lane.panel, lane.id, { start: Math.max(0, laneStart) }); return; }
    if (lane.lane === 'words') {
      const shift = <Row extends { id: string; start: number; end: number }>(rows: Row[]) => rows.map(row => row.id === lane.id ? { ...row, start: laneStart, end: laneStart + row.end - row.start } : row);
      setCaptions(shift); setTextOverlays(shift); markChanged();
    }
  };
  const move = (delta: number) => {
    const to = selected + delta; if (to < 0 || to >= clips.length) return;
    const next = [...clips]; [next[selected], next[to]] = [next[to], next[selected]]; change(next, to);
  };
  const timelineActions: TimelineAction[] = [
    { id: 'undo', label: 'Undo', icon: 'Undo2', group: 'history', run: () => undo(), disabled: !past.length },
    { id: 'redo', label: 'Redo', icon: 'Redo2', group: 'history', run: () => redo(), disabled: !future.length },
    { id: 'split', label: 'Split at playhead', icon: 'Scissors', group: 'cut', run: () => split(), disabled: measuring, emphasis: true },
    { id: 'mark-start', label: 'Mark start', icon: 'ArrowRightToLine', group: 'cut', run: () => setMarked(current => ({ ...current, start: playhead })) },
    { id: 'mark-end', label: 'Mark end', icon: 'ArrowLeftToLine', group: 'cut', run: () => setMarked(current => ({ ...current, end: playhead })) },
    { id: 'take-out', label: 'Take out marked', icon: 'ScissorsLineDashed', group: 'cut', run: () => takeOutMarked(), disabled: marked.start === null || marked.end === null || measuring, emphasis: true },
    { id: 'earlier', label: 'Move earlier', icon: 'ChevronsLeft', group: 'order', run: () => move(-1), disabled: selected === 0 },
    { id: 'later', label: 'Move later', icon: 'ChevronsRight', group: 'order', run: () => move(1), disabled: selected >= clips.length - 1 },
    { id: 'remove', label: 'Remove clip', icon: 'Trash2', group: 'order', run: () => { if (clips.length > 1) change(clips.filter((_, index) => index !== selected)); }, disabled: clips.length < 2 },
  ];
  const undo = () => { const prior = past.at(-1); if (!prior) return; setFuture(rows => [clips, ...rows]); setPast(rows => rows.slice(0, -1)); setClips(prior); setSelected(index => Math.min(index, prior.length - 1)); setStatus('Unsaved changes.'); };
  const redo = () => { const next = future[0]; if (!next) return; setPast(rows => [...rows, clips]); setFuture(rows => rows.slice(1)); setClips(next); setSelected(index => Math.min(index, next.length - 1)); setStatus('Unsaved changes.'); };
  const timelineStart = offsets[Math.min(selected, clips.length - 1)] ?? 0;
  const activeTimelineEnd = timelineStart + ((active?.end ?? active?.start ?? 0) - (active?.start ?? 0));
  const markChanged = () => setStatus('Unsaved changes.');
  const addCaption = () => {
    const text = captionDraft.trim();
    if (!active || !text || activeTimelineEnd <= timelineStart) return;
    setCaptions(rows => [...rows, { id: globalThis.crypto?.randomUUID?.() ?? `caption-${Date.now()}`, text, start: timelineStart, end: activeTimelineEnd }]);
    setCaptionDraft(''); markChanged();
  };
  const addText = () => {
    const text = textDraft.trim();
    if (!active || !text || activeTimelineEnd <= timelineStart) return;
    setTextOverlays(rows => [...rows, { id: globalThis.crypto?.randomUUID?.() ?? `text-${Date.now()}`, text, start: timelineStart, end: activeTimelineEnd }]);
    setTextDraft(''); markChanged();
  };
  const dimensions = FRAME_SIZES[ratio] ?? FRAME_SIZES['16:9'];
  const panelContext: MediaEditPanelContext = { editId: id, title, clips, selected, active, timelineStart, activeTimelineEnd, total, playhead, ratio, dimensions, captions };
  // What every panel lays over the cut, with the panel that owns it, for the preview and the timeline.
  const playerAdditions = React.useMemo(() => PANELS.reduce<Record<string, unknown>>((all, item) => ({ ...all, ...(item.preview?.(panelStates[item.id], panelContext) ?? {}) }), {}), [panelStates, captions, dimensions[0], dimensions[1]]);
  const panelLayers = PANELS.flatMap(item => (item.layers?.(panelStates[item.id], panelContext) ?? []).map(layer => ({ ...layer, panel: item.id })));
  const changePanelLayer = (panelId: string, layerId: string, change: MediaEditLayerChange) => {
    const owner = PANELS.find(item => item.id === panelId);
    if (!owner?.changeLayer) return;
    setPanelStates(rows => ({ ...rows, [panelId]: owner.changeLayer?.(rows[panelId], layerId, change) }));
    markChanged();
  };
  // Each panel adds to the edit so far, in panel order, so one panel's sounds or pictures never replace another's.
  const edl = () => PANELS.reduce<Record<string, unknown>>((edit, item) => ({ ...edit, ...(item.edl?.(panelStates[item.id], panelContext, edit) ?? {}) }), {
    title,
    encode: { width: dimensions[0], height: dimensions[1] },
    spine: { segments: clips.map((clip, index) => Object.assign({ kind: 'clip', id: `clip-${index}`, source: clip.identity, in: clip.start, out: clip.end, ...(clip.lookStack ? { look_stack: clip.lookStack } : {}) }, ...PANELS.map(item => item.segment?.(panelStates[item.id], clip, index, panelContext) ?? {}))) },
    ...(textOverlays.length ? { text_overlays: textOverlays.map(item => ({ text: item.text, x: 0.5, y: 0.14, size: Math.round(dimensions[1] * 0.055), color: '#FFFFFF', box: true, box_color: 'black@0.65', start: item.start, end: item.end })) } : {}),
  });
  const edit = () => ({ id, title, ratio, clips: clips.map(clip => ({ identity: clip.identity, name: clip.name, start: clip.start, end: clip.end, bytes: clip.bytes, media_type: clip.mediaType, media_kind: clip.mediaKind, ...(clip.lookStack ? { look_stack: clip.lookStack } : {}), ...(clip.sharedItemId ? { shared_item_id: clip.sharedItemId } : {}) })), captions, textOverlays, panels: panelStates, edl: edl(), ...(spaceId ? { shared_files: sharedFiles } : {}) });
  const save = async () => {
    if (spaceId) {
      const current = edit();
      const nextSharedFiles = { ...sharedFiles, ...(current.shared_files ?? {}) };
      for (const clip of clips) if (clip.sharedItemId) nextSharedFiles[clip.identity] = clip.sharedItemId;
      for (const identity of new Set(fileIdentitiesIn(current.edl))) {
        if (!nextSharedFiles[identity]) {
          const shared = await postJson<{ item_id?: string }>(`/work/api/spaces/${encodeURIComponent(spaceId)}/share`, { file: identity });
          const itemId = shared.item_id;
          if (!itemId) throw new Error(`Could not share ${identity} with this project.`);
          nextSharedFiles[identity] = itemId;
        }
      }
      const sharedClips = current.clips.map(clip => {
        const itemId = nextSharedFiles[clip.identity];
        if (!itemId) throw new Error(`Could not share ${clip.name} with this project.`);
        const sharedBytes = `/work/api/spaces/${encodeURIComponent(spaceId)}/items/${encodeURIComponent(itemId)}/bytes`;
        return { ...clip, bytes: sharedBytes, shared_item_id: itemId };
      });
      const nextEdl = { ...current.edl, spine: { segments: sharedClips.map((clip, index) => ({ ...(current.edl.spine as { segments?: unknown[] } | undefined)?.segments?.[index] as object, source: clip.identity })) } };
      const result = await postJson<{ revision?: number }>('/work/api/media/edit', { ...current, clips: sharedClips, edl: nextEdl, shared_files: nextSharedFiles, space_id: spaceId, expected_revision: revision });
      setRevision(result.revision ?? revision);
      setSharedFiles(nextSharedFiles);
      setHasSharedEdit(true);
      setRemoteEdit(null);
      setStatus('Edit saved with this project.');
      return nextSharedFiles;
    }
    const file = await files.change('write_file', { name: `/edits/${id}.json`, text: JSON.stringify(edl(), null, 2), media_type: 'application/json' }) as { identity: string };
    await postJson('/work/api/media/edit', { ...edit(), file: file.identity });
    setSavedFile(file.identity);
    setStatus('Edit saved in Files.');
  };
  const loadRemoteEdit = () => {
    if (!remoteEdit) return;
    if (remoteEdit.deleted) {
      setRevision(remoteEdit.revision ?? null);
      setHasSharedEdit(false);
      setRemoteEdit(null);
      setStatus('The project edit was removed. Save to add your current edit again.');
      return;
    }
    const restored = readClips(remoteEdit.edit.clips);
    if (restored.length) setClips(restored);
    if (remoteEdit.edit.ratio) setRatio(remoteEdit.edit.ratio);
    setCaptions(remoteEdit.edit.captions ?? []);
    setTextOverlays(remoteEdit.edit.textOverlays ?? []);
    setPanelStates(remoteEdit.edit.panels ?? {});
    setSharedFiles(remoteEdit.edit.shared_files ?? {});
    setRevision(remoteEdit.revision ?? null);
    setRemoteEdit(null);
    setStatus('Teammate’s edit loaded.');
  };
  const deleteSharedEdit = async () => {
    if (!spaceId) return;
    const response = await fetch(`/work/api/media/edit?id=${encodeURIComponent(id)}&space_id=${encodeURIComponent(spaceId)}&expected_revision=${encodeURIComponent(String(revision))}`, { method: 'DELETE', headers: { 'content-type': 'application/json' } });
    const answer = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(typeof answer.error === 'string' ? answer.error : 'The shared edit could not be removed.');
    setRevision(answer.revision ?? revision);
    setHasSharedEdit(false);
    setRemoteEdit(null);
    setStatus('Edit removed from this project.');
  };
  const perform = async (action: 'save' | 'render') => {
    if (busy) return; setBusy(true);
    setNeedsPlan(false);
    try {
      const savedSharedFiles = await save();
      if (action === 'render') {
        const renderEdit = edit();
        const run = await postJson<{ task_id?: string; state?: string; error?: string }>('/work/api/media/render', spaceId
          ? { ...renderEdit, shared_files: savedSharedFiles ?? sharedFiles, space_id: spaceId }
          : renderEdit);
        if (run.error) throw new Error(run.error);
        setStatus(run.state === 'completed' ? 'Video rendered. Find it in Files.' : 'Rendering started. Open the run to follow it.');
        if (run.task_id) window.dispatchEvent(new CustomEvent(PLACEABLE_SURFACE_MIME, { cancelable: true, detail: { id: 'trillion.workshop-run', title: 'Render video', surfaceInput: { id: run.task_id } } }));
      }
    } catch (error) { if (error instanceof PlanNeeded) { setNeedsPlan(true); setStatus(planNeededTitle(error.upgrade_needed)); } else setStatus(errorWords(error)); }
    finally { setBusy(false); }
  };

  // One layout for every pane width, read from the editor's own width (container queries), never the window's:
  // narrow, the player, the clips as a sideways strip and the tools stack; from 640px the tools sit beside the player;
  // from 1040px the clips are a column on the left, the player in the middle and the tools on the right.
  return <main className="@container mx-auto flex h-full w-full max-w-[1600px] flex-col gap-3 overflow-auto p-3 @min-[720px]:p-4" data-trillion-media-edit="">
    <header className="flex min-w-0 items-center gap-3" data-media-edit-header="">
      <div className="min-w-0 flex-1"><h1 className="truncate text-base font-semibold text-[var(--text-primary)] @min-[720px]:text-lg">{title || 'Media edit'}</h1>
      <p className="truncate text-xs text-[var(--text-muted)]">{clips.length} {clips.length === 1 ? 'clip' : 'clips'} · {clock(total)}</p></div>
      <div className="flex shrink-0 items-center gap-2" data-media-edit-actions=""><Button size="sm" variant="secondary" disabled={busy || measuring} onClick={() => perform('save')}>Save edit</Button>{spaceId && hasSharedEdit ? <Button size="sm" variant="ghost" disabled={busy} onClick={() => { return deleteSharedEdit().catch(error => { setStatus(errorWords(error)); throw error; }); }}>Remove from project</Button> : null}<Button size="sm" variant="primary" disabled={busy || measuring} onClick={() => perform('render')}>Render video</Button></div>
    </header>
    <div className="grid shrink-0 gap-3 [grid-template-areas:'player'_'bin'_'tools'] @min-[640px]:grid-cols-[minmax(0,1fr)_minmax(232px,288px)] @min-[640px]:[grid-template-areas:'player_tools'_'bin_tools'] @min-[1040px]:grid-cols-[minmax(150px,184px)_minmax(0,1fr)_minmax(260px,300px)] @min-[1040px]:[grid-template-areas:'bin_player_tools']" data-media-edit-stage="">
    <section aria-label="Source clips" data-media-edit-panel="sources" className="min-w-0 [grid-area:bin]">
      <h2 className="mb-2 flex items-center gap-1.5 text-xs font-medium text-[var(--text-muted)]"><NamedIcon name="Film" size="sm" aria-hidden="true" />Clips</h2>
      <div className="flex max-w-full gap-2 overflow-x-auto pb-1 @min-[1040px]:flex-col @min-[1040px]:overflow-visible">{clips.map((clip, index) => <HoverPreview key={`${clip.identity}:${index}`} label="Clip preview" items={[clip]} preview={item => ({ id: item.identity, title: item.name, url: playableUrl(item), type: item.mediaType || 'video/mp4' })} trigger={<Button aria-label={`Select clip ${index + 1}, ${clip.name}`} aria-pressed={index === selected} size="sm" variant={index === selected ? 'secondary' : 'ghost'} className={`h-auto w-36 shrink-0 flex-col items-stretch gap-1 p-1 @min-[1040px]:w-full ${index === selected ? 'outline outline-2 outline-[var(--text-primary)]' : ''}`} onClick={() => selectClip(index)}><span className="relative block aspect-video w-full overflow-hidden rounded-md bg-[var(--bg-secondary)]"><MediaPreview renderer="video-frame" source={clip.bytes} at={clip.start} title={clip.name} typeLabel="Video" /><span className="absolute bottom-1 right-1 rounded bg-black/70 px-1 text-[11px] tabular-nums text-white">{clock((clip.end ?? 0) - clip.start)}</span></span><span className="flex w-full min-w-0 items-center gap-1.5 text-left text-xs"><span className="tabular-nums text-[var(--text-muted)]">{index + 1}</span><span className="truncate">{clip.name}</span></span></Button>} />)}</div>
    </section>
    <div className="min-w-0 [grid-area:player]">
    <CutPlayer clips={clips} selected={selected} selectedStart={timelineStart} dimensions={dimensions} scope={scope} onScope={setScope} onTime={setPlayhead} seek={seekRequest} additions={playerAdditions}
      layers={panelLayers} onLayerChange={(layer, change) => changePanelLayer(layer.panel, layer.id, change)} />
    </div>
    <Container as="aside" aria-label="Edit tools" data-media-edit-panel="tools" layout="vertical" minWidth="0" overflow="auto" border="all" rounded="lg" background="secondary" className="@container min-h-0 overflow-x-hidden [grid-area:tools]">
      <div className="min-w-0 max-w-full overflow-x-auto border-b border-[var(--border-primary)] p-2"><ExpandableTabs ariaLabel="Editor tools" size="sm" value={panel} onChange={setPanel} items={[{ id: 'frame', label: 'Frame', icon: 'Square' }, { id: 'text', label: 'Text', icon: 'TextCursorInput' }, ...PANELS.map(item => ({ id: item.id, label: item.label, icon: item.icon }))]} /></div>
      {panel === 'frame' ? <section aria-label="Frame" data-media-edit-panel="frame" className="grid gap-2 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[var(--border-primary)] px-3 py-2"><span className="flex items-center gap-2 text-sm text-[var(--text-secondary)]"><NamedIcon name="RectangleHorizontal" size="sm" aria-hidden="true" />Shape</span><SegmentedControl ariaLabel="Frame shape" value={ratio} onValueChange={setRatio} items={Object.keys(FRAME_SIZES).map(value => ({ id: value, label: value }))} /></div>
        <div className="flex items-center justify-between gap-2 rounded-lg border border-[var(--border-primary)] px-3 py-2"><span className="flex items-center gap-2 text-sm text-[var(--text-secondary)]"><NamedIcon name="Scan" size="sm" aria-hidden="true" />Size</span><span className="text-sm tabular-nums text-[var(--text-primary)]">{dimensions[0]} × {dimensions[1]}</span></div>
      </section> : null}
      {panel === 'text' ? <section aria-label="Text and captions" data-media-edit-panel="text" className="grid gap-3 p-3 @min-[520px]:grid-cols-2">
        <div className="grid content-start gap-2">
          <h2 className="text-sm font-medium">Captions</h2>
          <label className="text-xs text-[var(--text-muted)]">Caption for selected clip<Input aria-label="Caption for selected clip" value={captionDraft} onChange={event => setCaptionDraft(event.target.value)} maxLength={300} placeholder="Type the words to show" className="mt-1" /></label>
          <Button size="sm" variant="secondary" onClick={addCaption} disabled={!captionDraft.trim()}>Add caption · {clock(timelineStart)}–{clock(activeTimelineEnd)}</Button>
          {captions.map(line => <div key={line.id} className="flex min-w-0 items-center gap-2 text-xs"><span className="min-w-0 flex-1 truncate">{clock(line.start)} · {line.text}</span><Button size="xs" variant="ghost" aria-label={`Remove caption ${line.text}`} onClick={() => { setCaptions(rows => rows.filter(row => row.id !== line.id)); markChanged(); }}>Remove</Button></div>)}
        </div>
        <div className="grid content-start gap-2">
          <h2 className="text-sm font-medium">Text on screen</h2>
          <label className="text-xs text-[var(--text-muted)]">Text for selected clip<Input aria-label="Text for selected clip" value={textDraft} onChange={event => setTextDraft(event.target.value)} maxLength={160} placeholder="Add a title or callout" className="mt-1" /></label>
          <Button size="sm" variant="secondary" onClick={addText} disabled={!textDraft.trim()}>Add text · {clock(timelineStart)}–{clock(activeTimelineEnd)}</Button>
          {textOverlays.map(line => <div key={line.id} className="flex min-w-0 items-center gap-2 text-xs"><span className="min-w-0 flex-1 truncate">{clock(line.start)} · {line.text}</span><Button size="xs" variant="ghost" aria-label={`Remove text ${line.text}`} onClick={() => { setTextOverlays(rows => rows.filter(row => row.id !== line.id)); markChanged(); }}>Remove</Button></div>)}
        </div>
        <p className="text-xs text-[var(--text-muted)] @min-[520px]:col-span-2">Captions show in the player in their style. Text on screen appears in the rendered video.</p>
      </section> : null}
      {PANELS.filter(item => item.id === panel).map(item => <section key={item.id} aria-label={item.label} className="border-t border-[var(--border-primary)] p-3"><item.Panel {...panelContext} change={change} select={selectClip} seek={seek} setCaptions={next => { setCaptions(next); markChanged(); }} setStatus={setStatus} panelState={panelStates[item.id]} setPanelState={next => { setPanelStates(rows => ({ ...rows, [item.id]: next })); markChanged(); }} /></section>)}
    </Container>
    </div>

    <CutTimeline composition={cutComposition(clips, [...captions, ...textOverlays], panelLayers)}
      playhead={playhead} selectedClipId={laneChoice && readLaneClipId(laneChoice)?.lane !== 'picture' ? laneChoice : laneClipId.picture(selected)} actions={timelineActions} marked={marked}
      onSeek={seek} onSelect={selectLaneClip} onTrim={trimLaneClip} onMove={moveLaneClip}>
      <div className="flex flex-wrap items-end gap-2"><label className="text-xs text-[var(--text-muted)]">Start (seconds)<Input type="number" min="0" step="0.001" value={startText} onChange={event => setStartText(event.target.value)} className="mt-1 w-24" /></label><label className="text-xs text-[var(--text-muted)]">End (seconds)<Input type="number" min="0" step="0.001" value={endText} onChange={event => setEndText(event.target.value)} className="mt-1 w-24" /></label><Button size="sm" variant="secondary" onClick={trim}>Trim selected clip</Button></div>
      <div className="flex items-center gap-2"><p className="min-h-4 text-xs text-[var(--text-muted)]" role="status">{status}</p>{remoteEdit ? <Button size="xs" variant="secondary" onClick={loadRemoteEdit}>{remoteEdit.deleted ? 'Use my current edit' : 'Load teammate’s version'}</Button> : null}{needsPlan ? <Button size="xs" variant="secondary" onClick={() => window.dispatchEvent(new CustomEvent(PLACEABLE_SURFACE_MIME, { cancelable: true, detail: { id: 'trillion.plan' } }))}>See plans</Button> : null}{savedFile ? <Button size="xs" variant="ghost" onClick={() => openFile({ id: savedFile, name: `${title || 'Media edit'}.json`, type: 'application/json' })}>Open saved edit</Button> : null}</div>
    </CutTimeline>
  </main>;
}

export function mountMediaEditScreen(element: HTMLElement, props: Props): () => void {
  const input = props.surfaceInput ?? {};
  const clips = readClips(input.clips);
  const title = typeof input.title === 'string' ? input.title : '';
  const restore = typeof input.editId === 'string';
  const spaceId = typeof input.space_id === 'string' ? input.space_id : undefined;
  const id = restore ? input.editId as string : (globalThis.crypto?.randomUUID?.() ?? `edit-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  let root: Root | null = null;
  const screen = loadScreen(element, {
    loading: { label: 'Opening your edit', layout: 'editor' },
    read: () => (restore && (clips.length || spaceId) ? readSavedEdit(id, spaceId, clips) : Promise.resolve(null)),
    empty: saved => (clips.length || (saved && saved !== 'failed' && saved.edit.clips.length) ? null : { status: 'empty', icon: 'Clapperboard', title: 'No clips to edit', description: 'Open the editor from Media after choosing clips with playable files.' }),
    failed: refusal('Your edit could not open'),
    clear: () => { root?.unmount(); root = null; },
    draw: saved => {
      if (root) return;
      root = createRoot(element);
      flushSync(() => root!.render(<MediaEdit id={id} saved={saved} title={title} initialClips={clips} spaceId={spaceId}/>));
    },
  });
  return () => { screen.dispose(); root?.unmount(); root = null; };
}
