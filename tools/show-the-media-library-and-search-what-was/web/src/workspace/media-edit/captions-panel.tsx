// src/workspace/media-edit/captions-panel.tsx
//
// PURPOSE
//   The media editor's Captions panel: make captions from the words said in the clips, edit each caption's words,
//   times and place, pick the caption style the video is rendered in (each style shown as a sample of itself), then
//   change any detail of it in the shared inspector (parts/ui TuningPanel): font, size, colours, outline, shadow, place,
//   how words light up and how many go in each caption. The player shows the captions in the style as it changes.
//   What it adds to the rendered video is the burned-in subtitle in that style.
//
// NON-NEGOTIABLE INVARIANTS
//   1. The editor's caption list is the one list of captions (`captions` / `setCaptions`); this panel keeps only the
//      chosen style (`panelState.style`: a style id, or the style's own row naming the style it started from as `id`
//      with the details changed), saved with the edit.
//   2. Styles are the catalog's rows (parts/media-composition/read-data/caption-styles.json) and the subtitle comes
//      from the one style builder (caption-styles.mjs); nothing here names a style or builds subtitle text.
//   3. Captions made from words come from each clip's own kept transcript (kind `transcript` beside the file); a clip
//      with no transcript adds no captions and is named, never guessed at.
//   4. Timed text is edited with the shared timed text editor (parts/ui/show/selection/timed-text-editor.mjs).
//   5. The inspector's rows are the catalog's `settings`; each row's `path` is the style field it changes, so a new
//      detail to change is one DATA row and no code here.

import React from 'react';
import { Button, CaptionSample, Container, Text, TuningPanel, captionShadowCss, type CaptionLook, type TuningSection, type TuningValue } from '../../../parts/ui';
import { StyleChoices, type SampleRun, type StyleChoice } from '../../../parts/ui/show/style-choices';
import { mountTimedTextEditor } from '../../../parts/ui/show/selection/timed-text-editor.mjs';
import { CAPTION_MEASURED_AT, CAPTION_STYLES, CAPTION_STYLE_SETTINGS, DEFAULT_CAPTION_STYLE, captionAss, resolveCaptionStyle } from '../../../../../media-composition/read-data/caption-styles.mjs';
import { captionLinesForEdit, groupWordsIntoCaptionLines, wordsOf } from '../../../parts/media-composition/read-data/caption-lines';
import { fileResults } from '../api';
import { definePanel, type MediaEditCaption, type MediaEditPanelProps } from './panel-types';

import { errorWords } from '../../../../../ui/show/safe-error-card/sanitize-error-text.ts';
/** A style's own row: the catalog style it starts from (`id`) and the details changed. */
type OwnStyle = { id: string } & Record<string, unknown>;
type CaptionsState = { style?: string | OwnStyle };
type Style = ReturnType<typeof resolveCaptionStyle>;
type Path = readonly string[];
type TimedTextEditor = ReturnType<typeof mountTimedTextEditor>;

const SAMPLE = 'The next point changes everything';
// A style card's sample is drawn at about a quarter of the style's own size, so its shadow is drawn at that scale too.
const SAMPLE_SCALE = 0.25;
const round = (seconds: number) => Math.round(seconds * 1000) / 1000;
const clock = (seconds: number) => {
  const whole = Math.floor(Math.max(0, seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
};
const newId = () => globalThis.crypto?.randomUUID?.() ?? `caption-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const chosenStyle = (state: CaptionsState | undefined): string | OwnStyle => state?.style ?? DEFAULT_CAPTION_STYLE;
const baseId = (choice: string | OwnStyle): string => (typeof choice === 'string' ? choice : choice.id);

/** The inspector's sections, and every row (a row of side-by-side rows counts each) by key. */
const SECTIONS = CAPTION_STYLE_SETTINGS as TuningSection[];
const ROWS = new Map(SECTIONS.flatMap(section => section.settings.flatMap(row => [row, ...(row.settings ?? [])])).filter(row => row.path).map(row => [row.key, row] as const));

const valueAt = (record: unknown, path: Path): unknown => path.reduce<unknown>((node, key) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[key] : undefined), record);
const withValue = (record: Record<string, unknown>, path: Path, value: unknown): Record<string, unknown> => {
  const [key, ...rest] = path;
  if (!rest.length) return { ...record, [key]: value };
  const inner = record[key];
  return { ...record, [key]: withValue(inner && typeof inner === 'object' ? inner as Record<string, unknown> : {}, rest, value) };
};

/** A style's card: the sample words in its own font and colours; a word-by-word style shows its first words lit. */
function styleCard(style: Style, text: string): StyleChoice {
  const words = text.split(/\s+/).filter(Boolean).slice(0, 4);
  const lit = style.reveal === 'karaoke' ? Math.max(1, Math.ceil(words.length / 2)) : words.length;
  const edge = [
    style.outline > 0 ? `0 0 ${Math.max(1, Math.round(style.outline / 2))}px ${style.colours.outline}, 0 0 1px ${style.colours.outline}` : '',
    captionShadowCss(style.shadow, px => `${Math.round(px * SAMPLE_SCALE * 10) / 10}px`),
  ].filter(text => text && text !== 'none').join(', ') || undefined;
  const sample: SampleRun[] = words.map((word, index) => ({ text: word, style: { color: index < lit ? style.colours.spoken : style.colours.upcoming } }));
  return {
    id: style.id,
    label: style.name,
    sample,
    sampleStyle: {
      fontFamily: style.preview.fonts.map((font: string) => (/\s/.test(font) ? `"${font}"` : font)).join(', '),
      fontWeight: style.bold ? 700 : 500,
      fontStyle: style.italic ? 'italic' : 'normal',
      background: style.preview.background,
      textShadow: edge,
    },
  };
}

function CaptionsPanel(props: MediaEditPanelProps<CaptionsState>) {
  const { clips, captions, total, playhead, dimensions, panelState, setPanelState, setCaptions, setStatus, seek } = props;
  const choice = chosenStyle(panelState);
  const style = React.useMemo(() => { try { return resolveCaptionStyle(choice); } catch { return null; } }, [choice]);
  const [busy, setBusy] = React.useState(false);
  const host = React.useRef<HTMLDivElement>(null);
  const editor = React.useRef<TimedTextEditor | null>(null);
  const shown = React.useRef('');
  const at = React.useRef(playhead);
  at.current = playhead;
  const callbacks = React.useRef({ seek, setCaptions });
  callbacks.current = { seek, setCaptions };
  const context = JSON.stringify([props.editId, clips, captions, choice, total]);
  const revision = React.useRef({ context, value: 0 });
  if (revision.current.context !== context) revision.current = { context, value: revision.current.value + 1 };
  const generation = React.useRef(false);
  const mounted = React.useRef(true);
  const placed = React.useMemo(() => captions.map(row => ({ ...row, x: Number.isFinite(row.x) ? row.x : style?.position.x ?? 0.5, y: Number.isFinite(row.y) ? row.y : style?.position.y ?? 0.9 })), [captions, style]);

  // The shared timed text editor keeps its rows while the person types; it is drawn again only when the captions
  // change from outside it (made from the words, a new style's place, a restored edit).
  React.useEffect(() => {
    const signature = JSON.stringify(placed);
    if (!host.current) return;
    if (total <= 0) { editor.current?.destroy(); editor.current = null; return; }
    if (editor.current && signature === shown.current) { editor.current.updateDuration(total); return; }
    editor.current?.destroy();
    shown.current = signature;
    editor.current = placed.length && total > 0 ? mountTimedTextEditor(host.current, {
      layers: placed,
      duration: total,
      timelineDriven: true,
      getTime: () => at.current,
      onSeek: (time: number) => callbacks.current.seek(time),
      onEdit: () => { revision.current.value += 1; },
      onChange: (next: MediaEditCaption[]) => { shown.current = JSON.stringify(next); callbacks.current.setCaptions(next); },
    }) : null;
  }, [placed, total, seek, setCaptions]);
  React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; editor.current?.destroy(); editor.current = null; }; }, []);

  // Captions still at the old style's place move to the new style's place; ones the person placed stay put.
  const followPlace = (next: Style) => {
    if (style && captions.length) setCaptions(captions.map(row => (row.x === style.position.x && row.y === style.position.y ? { ...row, x: next.position.x, y: next.position.y } : row)));
  };
  const chooseStyle = (id: string) => {
    followPlace(resolveCaptionStyle(id));
    setPanelState({ ...panelState, style: id });
  };
  /** One detail of the style changed in the inspector: kept on the style's own row. */
  const changeDetail = (key: string, value: TuningValue) => {
    const row = ROWS.get(key);
    if (!row?.path || !style) return;
    const own: OwnStyle = typeof choice === 'string' ? { id: choice } : choice;
    const nextOwn = withValue(own, row.path, value ?? null) as OwnStyle;
    let next: Style;
    try { next = resolveCaptionStyle(nextOwn); } catch (error) { setStatus(errorWords(error)); return; }
    followPlace(next);
    // Captions made from the words are gathered again by the new rule; captions whose words were edited stay as they are.
    if (row.path[0] === 'grouping' && captions.length && captions.every(line => line.words?.length)) {
      const words = captions.flatMap(line => line.words ?? []).sort((a, b) => a.start - b.start);
      setCaptions(groupWordsIntoCaptionLines(words, next.grouping).map(line => ({ id: newId(), text: line.text, start: round(line.start), end: round(line.end), x: next.position.x, y: next.position.y, words: line.words })));
    }
    setPanelState({ ...panelState, style: nextOwn });
  };
  const values = React.useMemo(() => Object.fromEntries([...ROWS.values()].map(row => [row.key, valueAt(style, row.path as Path) as TuningValue])), [style]);

  const makeFromWords = async () => {
    if (!style || generation.current) return;
    generation.current = true;
    const requestedRevision = revision.current.value;
    const isCurrent = () => mounted.current && revision.current.value === requestedRevision;
    setBusy(true);
    try {
      const identities = [...new Set(clips.map(clip => clip.identity))];
      const heard = new Map(await Promise.all(identities.map(async identity => {
        const answer = await fileResults.read<{ results: { value: unknown }[] }>(identity, 'transcript');
        return [identity, wordsOf(answer.results[0]?.value)] as const;
      })));
      // A delayed transcript belongs to the edit that requested it. Cuts, caption edits, style changes and
      // undo/redo invalidate it even when the panel remains mounted or the edit later returns to its old values.
      if (!isCurrent()) return;
      const silent = [...new Set(clips.filter(clip => !heard.get(clip.identity)?.length).map(clip => clip.name))];
      const lines = captionLinesForEdit(clips.map(clip => ({ words: heard.get(clip.identity) ?? [], from: clip.start, to: clip.end ?? clip.start })), style.grouping);
      if (!lines.length) { setStatus(silent.length ? `No words are kept for ${silent.join(', ')} yet. Transcribe it from Media, then make captions again.` : 'No words are said in these clips.'); return; }
      setCaptions(lines.map(line => ({ id: newId(), text: line.text, start: round(line.start), end: round(line.end), x: style.position.x, y: style.position.y, words: line.words })));
      setStatus(`${lines.length} ${lines.length === 1 ? 'caption' : 'captions'} made from the words${silent.length ? `. No words yet for ${silent.join(', ')}.` : '.'}`);
    } catch (error) {
      if (isCurrent()) setStatus(`The words could not be read. ${errorWords(error, 'Try again.')}`);
    } finally { generation.current = false; if (mounted.current) setBusy(false); }
  };

  const sampleText = captions.find(row => row.text.trim())?.text ?? SAMPLE;
  return <Container data-media-edit-panel="captions" layout="vertical" gap="md">
    <Container layout="horizontal" gap="sm" wrap alignItems="center">
      <Button size="sm" variant="primary" disabled={busy || !style} onClick={() => makeFromWords()}>{busy ? 'Reading the words…' : 'Make captions from the words'}</Button>
      {captions.length ? <Button size="sm" variant="ghost" onClick={() => setCaptions([])}>Remove all captions</Button> : null}
    </Container>
    <Container layout="vertical" gap="sm">
      <Text variant="heading-xs">Caption style</Text>
      <StyleChoices label="Caption style" value={baseId(choice)} items={CAPTION_STYLES.map(row => styleCard(resolveCaptionStyle(row.id), sampleText))} onChange={chooseStyle} />
      {!style ? <Text variant="caption">This edit's caption style is no longer offered. Choose one above.</Text> : null}
    </Container>
    {style ? <TuningPanel
      sections={SECTIONS}
      values={values}
      onChange={changeDetail}
      preview={<CaptionSample look={style as unknown as CaptionLook} text={sampleText} frame={{ width: dimensions[0], height: dimensions[1] }} measuredAt={CAPTION_MEASURED_AT} background={style.preview.background} />}
    /> : null}
    {captions.length ? <Container layout="vertical" gap="sm">
      <Text variant="heading-xs">{captions.length} {captions.length === 1 ? 'caption' : 'captions'}</Text>
      <Container layout="vertical" gap="xs" maxHeight="12rem" className="overflow-y-auto" aria-label="Captions in order">
        {captions.map(row => <Button key={row.id} size="xs" variant="ghost" className="justify-start truncate" onClick={() => { editor.current?.select(row.id); seek(row.start); }}>{`${clock(row.start)}–${clock(row.end)} · ${row.text}`}</Button>)}
      </Container>
    </Container> : <Text variant="caption">No captions yet. Make them from the words said in the clips, or type one in Text.</Text>}
    <Container ref={host} layout="vertical" gap="sm" aria-label="Edit the chosen caption" />
    <Text variant="caption">Captions appear in the player and in the rendered video in this style.</Text>
  </Container>;
}

export const captionsPanel = definePanel<CaptionsState>({
  id: 'captions',
  label: 'Captions',
  icon: 'Captions',
  Panel: CaptionsPanel,
  edl: (state, context) => {
    const ass = captionAss(context.captions, chosenStyle(state), { width: context.dimensions[0], height: context.dimensions[1] });
    return ass ? { subtitles: { ass } } : undefined;
  },
  // The player draws the captions in the style, the same style row the subtitle is built from.
  preview: (state, context) => {
    let look: Style;
    try { look = resolveCaptionStyle(chosenStyle(state)); } catch { return undefined; }
    return context.captions.length ? { captions: { look, lines: context.captions, measuredAt: CAPTION_MEASURED_AT } } : undefined;
  },
});
