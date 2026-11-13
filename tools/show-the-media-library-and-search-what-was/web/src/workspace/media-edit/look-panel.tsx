// src/workspace/media-edit/look-panel.tsx
//
// The editor's Colour panel: looks, colour adjustments, framing and colour matching for the selected clip, plus
// timed colour changes over the whole video. Every choice is a row in
// parts/media-composition/read-data/looks.json; parts/media-composition/read-data/looks.mjs is the one mapping from
// those choices to the render fields, shared with the grade-a-video tool.
//
// Invariants
//   1. Choices belong to the source clip (its file), so every part of a split clip keeps the same colour.
//   2. What is saved is ids and bounded numbers; the render fields are derived from them at save and render time.
//   3. A clip whose older edit named a look directly keeps it until the person changes that clip's looks here.
//   4. Composed only from shared parts (parts/ui); no markup of its own.

import React from 'react';
import { Button, Container, Input, Slider, Select, SelectItem, SelectPopup, SelectTrigger, SelectValue, Text } from '../../../parts/ui';
import { FrameWindow } from '../../../parts/ui/show/frame-window';
import { LOOKS, adjustmentPreviewFilter, clipColourFields, lookCanBeTimed, timedLayers } from '../../../parts/media-composition/read-data/looks.mjs';
import { definePanel, type MediaEditClip, type MediaEditPanelProps } from './panel-types';

type Flip = 'h' | 'v' | 'hv';
type Framing = { fit?: string; zoom?: number; x?: number; y?: number; flip?: Flip };
type ClipChoice = { looks?: string[]; adjust?: Record<string, number>; framing?: Framing; match?: { reference: string; at?: number } };
type TimedAdjustment = { id: string; start: number; end: number; [field: string]: number | string };
type TimedLook = { id: string; look: string; start: number; end: number };
export type LookPanelState = { clips?: Record<string, ClipChoice>; timed?: { adjustments?: TimedAdjustment[]; looks?: TimedLook[] } };

type LookRow = { id: string; label: string; group: string; note?: string };
type NumberRow = { id: string; label: string; min: number; max: number; step: number; neutral: number };
const looks = LOOKS.looks as LookRow[];
const lookById = new Map(looks.map(look => [look.id, look]));
const timedLooks = looks.filter(look => lookCanBeTimed(look.id));
const newId = () => globalThis.crypto?.randomUUID?.() ?? `change-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
const isPicture = (clip: MediaEditClip) => clip.mediaKind !== 'audio' && !clip.mediaType.startsWith('audio/');
// Mirroring toggles one direction and keeps the other.
const toggleFlip = (current: Flip | undefined, axis: 'h' | 'v'): Flip | undefined => {
  const across = (current === 'h' || current === 'hv') !== (axis === 'h');
  const down = (current === 'v' || current === 'hv') !== (axis === 'v');
  return across && down ? 'hv' : across ? 'h' : down ? 'v' : undefined;
};

/** The looks a clip shows: its own choice, or the look an older edit named directly on it. */
function clipLooks(choice: ClipChoice | undefined, clip: MediaEditClip | undefined): string[] {
  if (choice?.looks) return choice.looks;
  return clip?.lookStack && lookById.has(clip.lookStack) ? [clip.lookStack] : [];
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return <Container layout="vertical" gap="sm" role="group" aria-label={title}>
    <Text variant="heading-xs" as="h3">{title}</Text>
    {children}
  </Container>;
}

function LookPanel(props: MediaEditPanelProps<LookPanelState>) {
  const { active, clips, dimensions, panelState, setPanelState, change, timelineStart, activeTimelineEnd, total } = props;
  const state = panelState ?? {};
  const choice = active ? state.clips?.[active.identity] : undefined;
  const chosen = clipLooks(choice, active);
  const adjust = choice?.adjust ?? {};
  const framing = choice?.framing ?? {};
  const timed = { adjustments: state.timed?.adjustments ?? [], looks: state.timed?.looks ?? [] };
  const others = [...new Map(clips.filter(clip => clip.identity !== active?.identity && isPicture(clip)).map(clip => [clip.identity, clip])).values()];
  const range = { start: Math.round(timelineStart * 1000) / 1000, end: Math.round(Math.max(timelineStart + 0.1, activeTimelineEnd) * 1000) / 1000 };

  const setChoice = (next: ClipChoice) => {
    if (active) setPanelState({ ...state, clips: { ...state.clips, [active.identity]: next } });
  };
  const setLooks = (ids: string[]) => {
    setChoice({ ...choice, looks: ids });
    // An older edit's look on this clip is owned here from now on.
    if (active && clips.some(clip => clip.identity === active.identity && clip.lookStack)) {
      change(clips.map(clip => clip.identity === active.identity ? { ...clip, lookStack: undefined } : clip));
    }
  };
  const toggleLook = (id: string) => {
    if (chosen.includes(id)) { setLooks(chosen.filter(item => item !== id)); return; }
    const group = LOOKS.groups.find(item => item.id === lookById.get(id)?.group);
    setLooks([...chosen.filter(item => !group?.one_at_a_time || lookById.get(item)?.group !== group.id), id]);
  };
  const setAdjust = (id: string, value: number | undefined) => {
    const next = { ...adjust };
    if (value === undefined) delete next[id]; else next[id] = value;
    setChoice({ ...choice, adjust: next });
  };
  const setFraming = (next: Framing) => setChoice({ ...choice, framing: { ...framing, ...next } });
  const setTimed = (next: typeof timed) => setPanelState({ ...state, timed: next });

  if (!active) return <Text variant="caption" data-media-edit-panel="look">Choose a clip to change its colour.</Text>;
  return <Container layout="grid" gridCols="auto-fill-xs" gap="xl" data-media-edit-panel="look">
    <Group title="Looks">
      <Text variant="caption">For {active.name}. Every part of this clip gets the same looks, applied in the order you pick them.</Text>
      {LOOKS.groups.map(group => <Container key={group.id} layout="vertical" gap="xs" role="group" aria-label={group.label}>
        <Text variant="label">{group.label}</Text>
        <Container layout="horizontal" wrap gap="xs">{looks.filter(look => look.group === group.id).map(look => <Button key={look.id} size="xs" variant={chosen.includes(look.id) ? 'accent' : 'secondary'} aria-pressed={chosen.includes(look.id)} title={look.note} onClick={() => toggleLook(look.id)}>{look.label}</Button>)}</Container>
      </Container>)}
      <Text variant="caption" role="status">{chosen.length ? `In order: ${chosen.map(id => lookById.get(id)?.label ?? id).join(' → ')}` : 'No look on this clip.'}</Text>
    </Group>

    <Group title="Adjust">
      {(LOOKS.adjustments as NumberRow[]).map(row => <Slider key={row.id} label={row.label} min={row.min} max={row.max} step={row.step} value={adjust[row.id] ?? row.neutral}
        resetLabel={`Reset ${row.label.toLowerCase()}`} onReset={adjust[row.id] === undefined ? undefined : () => setAdjust(row.id, undefined)}
        onValueChange={value => setAdjust(row.id, value === row.neutral ? undefined : value)} />)}
    </Group>

    {isPicture(active) ? <Group title="Frame">
      <FrameWindow source={active.bytes} at={active.start} frameAspect={dimensions[0] / dimensions[1]} zoom={framing.zoom ?? 1} center={{ x: framing.x ?? 0.5, y: framing.y ?? 0.5 }}
        filter={adjustmentPreviewFilter(adjust) || undefined} mirror={framing.flip} label="What stays in the frame" onChange={center => setFraming(center)} />
      <Text variant="caption">Drag the box, or use the arrow keys, to choose what stays in the {dimensions[0]}×{dimensions[1]} frame. The picture shows brightness, contrast, saturation and exposure; looks, warmth and vibrance show in the rendered video.</Text>
      <Select value={framing.fit ?? LOOKS.fits[0].id} onValueChange={value => setFraming({ fit: value ?? LOOKS.fits[0].id })}>
        <SelectTrigger aria-label="How the clip fills the frame"><SelectValue>{LOOKS.fits.find(fit => fit.id === (framing.fit ?? LOOKS.fits[0].id))?.label}</SelectValue></SelectTrigger>
        <SelectPopup>{LOOKS.fits.map(fit => <SelectItem key={fit.id} value={fit.id}>{fit.label}</SelectItem>)}</SelectPopup>
      </Select>
      <Slider label="Zoom" min={1} max={4} step={0.05} value={framing.zoom ?? 1} valueLabel={`${Math.round((framing.zoom ?? 1) * 100)}%`} onValueChange={zoom => setFraming({ zoom })} />
      <Container layout="horizontal" wrap gap="xs">
        <Button size="xs" variant={framing.flip === 'h' || framing.flip === 'hv' ? 'accent' : 'secondary'} aria-pressed={framing.flip === 'h' || framing.flip === 'hv'} onClick={() => setFraming({ flip: toggleFlip(framing.flip, 'h') })}>Mirror across</Button>
        <Button size="xs" variant={framing.flip === 'v' || framing.flip === 'hv' ? 'accent' : 'secondary'} aria-pressed={framing.flip === 'v' || framing.flip === 'hv'} onClick={() => setFraming({ flip: toggleFlip(framing.flip, 'v') })}>Mirror up and down</Button>
        <Button size="xs" variant="ghost" disabled={!choice?.framing} onClick={() => setChoice({ ...choice, framing: undefined })}>Reset frame</Button>
      </Container>
    </Group> : null}

    <Group title="Match colour">
      <Select value={choice?.match?.reference ?? 'none'} onValueChange={value => {
        const reference = others.find(clip => clip.identity === value);
        setChoice({ ...choice, match: reference ? { reference: reference.identity, at: reference.start } : undefined });
      }}>
        <SelectTrigger aria-label="Match colour to another clip"><SelectValue>{others.find(clip => clip.identity === choice?.match?.reference)?.name ?? 'Keep this clip\'s colours'}</SelectValue></SelectTrigger>
        <SelectPopup><SelectItem value="none">Keep this clip's colours</SelectItem>{others.map(clip => <SelectItem key={clip.identity} value={clip.identity}>{clip.name}</SelectItem>)}</SelectPopup>
      </Select>
      <Text variant="caption">{others.length ? 'Shifts this clip\'s colours to match the other clip, before any look, so shots from different cameras or light look like one shoot.' : 'Add another clip to this edit to match colours between them.'}</Text>
    </Group>

    <Group title="Timed changes">
      <Text variant="caption">Change the colour of the whole video for a stretch of time. New changes start on the selected clip ({clock(range.start)}–{clock(range.end)}).</Text>
      <Container layout="horizontal" wrap gap="xs">
        <Button size="xs" variant="secondary" onClick={() => setTimed({ ...timed, adjustments: [...timed.adjustments, { id: newId(), ...range }] })}>Add adjustment</Button>
        <Button size="xs" variant="secondary" disabled={!timedLooks.length} onClick={() => setTimed({ ...timed, looks: [...timed.looks, { id: newId(), look: timedLooks[0].id, ...range }] })}>Add look</Button>
      </Container>
      {timed.adjustments.map((row, index) => <TimedRow key={row.id} title={`Adjustment ${index + 1}`} row={row} total={total}
        onChange={next => setTimed({ ...timed, adjustments: timed.adjustments.map(item => item.id === row.id ? { ...item, ...next } : item) })}
        onRemove={() => setTimed({ ...timed, adjustments: timed.adjustments.filter(item => item.id !== row.id) })}>
        {(LOOKS.timed_adjustments as NumberRow[]).map(field => <Slider key={field.id} label={field.label} min={field.min} max={field.max} step={field.step}
          value={typeof row[field.id] === 'number' ? row[field.id] as number : field.neutral}
          onValueChange={value => setTimed({ ...timed, adjustments: timed.adjustments.map(item => item.id === row.id ? { ...item, [field.id]: value } : item) })} />)}
      </TimedRow>)}
      {timed.looks.map((row, index) => <TimedRow key={row.id} title={`Look ${index + 1}`} row={row} total={total}
        onChange={next => setTimed({ ...timed, looks: timed.looks.map(item => item.id === row.id ? { ...item, ...next } : item) })}
        onRemove={() => setTimed({ ...timed, looks: timed.looks.filter(item => item.id !== row.id) })}>
        <Select value={row.look} onValueChange={value => setTimed({ ...timed, looks: timed.looks.map(item => item.id === row.id ? { ...item, look: value ?? item.look } : item) })}>
          <SelectTrigger aria-label={`Look ${index + 1}`}><SelectValue>{lookById.get(row.look)?.label}</SelectValue></SelectTrigger>
          <SelectPopup>{timedLooks.map(look => <SelectItem key={look.id} value={look.id}>{look.label}</SelectItem>)}</SelectPopup>
        </Select>
      </TimedRow>)}
    </Group>
  </Container>;
}

function TimedRow({ title, row, total, onChange, onRemove, children }: { title: string; row: { start: number; end: number }; total: number; onChange: (next: { start?: number; end?: number }) => void; onRemove: () => void; children: React.ReactNode }) {
  const time = (field: 'start' | 'end', text: string) => {
    const value = Number(text);
    if (Number.isFinite(value) && value >= 0 && value <= total) onChange({ [field]: value });
  };
  return <Container layout="vertical" gap="sm" padding="sm" border="all" rounded="lg" role="group" aria-label={title}>
    <Container layout="horizontal" wrap gap="sm" alignItems="end">
      <Text variant="label">{title}</Text>
      <Input label="From (seconds)" aria-label={`${title} from`} type="number" min="0" step="0.1" value={String(row.start)} onChange={event => time('start', event.target.value)} />
      <Input label="Until (seconds)" aria-label={`${title} until`} type="number" min="0" step="0.1" value={String(row.end)} onChange={event => time('end', event.target.value)} />
      <Button size="xs" variant="ghost" onClick={onRemove}>Remove</Button>
    </Container>
    {row.end <= row.start ? <Text variant="caption" color="error" role="alert">End must be later than start.</Text> : null}
    {children}
  </Container>;
}

/** Timed rows the render can take: a row whose end is not after its start is left out until it is fixed. */
function renderableTimed(state: LookPanelState | undefined, total: number) {
  const valid = <Row extends { start: number; end: number }>(rows: Row[] | undefined) => (rows ?? []).filter(row => row.end > row.start && row.end <= total + 0.05);
  return { adjustments: valid(state?.timed?.adjustments), looks: valid(state?.timed?.looks) };
}

export const lookPanel = definePanel<LookPanelState>({
  id: 'look',
  label: 'Colour',
  icon: 'Palette',
  Panel: LookPanel,
  // Every picture clip is placed in the chosen frame (filled and centred unless the person moved it), so a clip of
  // another shape is never stretched. A clip with no looks here keeps any look an older edit named on it.
  segment: (state, clip, _index, context) => {
    const choice = state?.clips?.[clip.identity] ?? {};
    // A look saved earlier and since removed from the list is dropped rather than failing the whole save.
    return clipColourFields({ ...choice, looks: (choice.looks ?? []).filter(id => lookById.has(id)), framing: isPicture(clip) ? choice.framing ?? {} : undefined }, context.dimensions);
  },
  edl: (state, context) => {
    const layers = timedLayers(renderableTimed(state, context.total), context.total);
    return layers.length ? { adjustment_layers: layers } : undefined;
  },
});
