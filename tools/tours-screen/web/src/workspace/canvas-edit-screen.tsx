// src/workspace/canvas-edit-screen.tsx
//
// NO PRIOR: the parts this composes were each found first: the canvas of frames (parts/ui/show/frames-canvas, which
// now also holds live content), the card a tour step is drawn in (parts/guided-overlay/show/step-card.ts, the same body
// the running tour draws), the controls a setting is tuned with (parts/ui/show/tuning-panel) and the one rule seam every
// surface asks (parts/ui/show/show-rules). Anatomy from MagicPath's visual edit mode (Mobbin 60b61239: frames on a
// canvas, the picked element ringed, its fields in a side panel) and Klaviyo's editor (3849c671: the panel beside the
// canvas, the controls drawn as what they set).
//
// PURPOSE
//   Edit on canvas: a thing (a tour, and any kind canvas-edit.json names) laid out as all its parts side by side, each
//   drawn as itself. Pressing a part's words, a button or its card picks it (Shift or Cmd adds more); its fields show in
//   place beside the canvas (a Shift-drag lassos every part it touches), and the person chooses who the change is for: this one, every part of this thing, every
//   one of its kind, or the parts they picked together. Each change is one show rule (effect `change`) kept in the
//   person's own rules, so it reaches the running tour and every other place the part is drawn at once, an AI can make
//   or read the same rule (set_show_rule, read_show_rules), and Undo is taking the rule away.
//   A kind that has a canvas of its own (a site: the site editor, desktop, tablet and phone side by side, editing its
//   draft in place) opens in that screen from the same address (canvas-edit.json `mounts`), so /edit/<kind>:<id> is
//   the one way into editing anything.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Nothing here names a part, a field, a scope or a kind's vocabulary: they are canvas-edit.json DATA; how a kind's
//      parts are read is one entry of READERS.
//   2. A change is a rule over the part's facts (the scope's facts, matched to the picked parts' values), never a copy
//      of the thing: the thing's own row stays as it was, and the rule decides where the change holds.
//   3. A part is drawn by the same code that draws it everywhere else, from the same changed row.
//   4. What the person types shows on the canvas at once; it is kept a moment later (KEEP_AFTER_MS), once per pause.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { Button, Card, Container, NamedIcon, SegmentedControl, Text, Textarea, TuningPanel, type TuningSetting, type TuningValue } from '../../parts/ui';
import { FramesCanvas, type CanvasFrame } from '../../parts/ui/show/frames-canvas/FramesCanvas';
import { QueueJobButton } from '../../parts/ui/show/queue-job/QueueJobButton';
import { ScreenState, mountScreenState, useScreenLoad, type ScreenStateValue } from '../../parts/ui/show/screen-state';
import { notify } from '../../parts/ui/show/coss/notifications';
import { errorWords } from '../../../../ui/show/safe-error-card/sanitize-error-text.ts';
import { removeShowRule, saveShowRule, showOf, useShowChange } from '../../parts/ui/show/show-rules/show-of';
import {
  StepCardBody, buttonLooksOf, defaultStepRegistries, exitControlOf, paperOf, paperStyle, stepAsChanged,
  stepButtonsOf, stepFacts, type Paper,
} from '../../parts/guided-overlay/show/step-card';
import { emitWalkthroughEvent } from '../../parts/guided-overlay/show/walkthroughs';
import { OWN_WALKTHROUGHS_INPUT } from '../../../read-data/tour-library.ts';
import type { WalkthroughDefinition, WalkthroughStep } from '../../parts/guided-overlay/read-data/walkthrough-eeaf';
import { NavItem, type NavItemData } from '../../parts/sidebar/show/SidebarContent';
import { useBitfieldData } from './records';
import { screens } from './screen-mounts';
import surfaces from './screens.mjs';
import { queueJobProps } from './queue-job';
import { refusal } from './failure';
import { withChanges } from './show-rules.mjs';
import data from './canvas-edit.json';
import showRules from '../../../../set-up-my-account/read-data/show-rules.json';
import '../../parts/screen-look/show/canvas-edit.css';

const KEEP_AFTER_MS = 400;
type Path = (string | number)[];
type Field = { key: string; label: string; path: string[]; widget: string; options_from?: string };
type PartRow = { id: string; label: string; pick: string; name_from?: string; fields: Field[] };
type Scope = { id: string; label: string; facts: string[] };
type Subject = { parts: PartRow[]; scopes: Scope[] };
type Kind = { label: string; subject: string; part_label: string; part_width: number; part_height: number; all?: string; all_title?: string };
/** A kind with a canvas of its own: the screen entry it opens in, and that screen's input (`{id}` is the thing's id). */
type Mounted = { label: string; mounts: { entry: string; input: Record<string, string> } };
/** One drawn part of the thing: its id, the row its fields are read from, the facts a rule matches it by, and how it is
 *  drawn (the same drawing it has everywhere else). */
type Piece = { id: string; label: string; facts: Record<string, unknown>; row: unknown; draw: (row: unknown) => React.ReactNode };
type Thing = { title: string; pieces: Piece[]; play?: () => void };
/** One picked part of one piece: which part row, the name it was picked under (a button's role, used only in the
 *  path, never shown) and the words it shows, which name it to the person. */
type Picked = { piece: string; part: string; name: string; said: string };
type Draft = { scope: Scope; picked: Picked[]; path: Path; value: TuningValue };

const words = data.words;
const subjects = data.subjects as Record<string, Subject>;
const kinds = data.kinds as unknown as Record<string, Kind>;
const mounted = data.kinds as unknown as Record<string, Partial<Mounted>>;
const options = data.options as Record<string, { value: string; label: string }[]>;
const fill = (template: string, values: Record<string, string | number>) => template.replace(/\{(\w+)\}/g, (_, name: string) => String(values[name] ?? ''));
const at = (value: unknown, path: Path) => path.reduce<unknown>((here, key) => (here && typeof here === 'object' ? (here as Record<string | number, unknown>)[key] : undefined), value);
const pathFor = (field: Field, name: string): Path => field.path.map(key => (key === '{name}' ? name : key));
const readableId = (text: string) => text.replace(/[^A-Za-z0-9_.:-]+/g, '-').slice(0, 160);

// ---------------------------------------------------------------------------------------------------------------------
// How each kind's parts are read and drawn. A new kind is one entry here and one row in canvas-edit.json.

function useTour(id: string, kind: Kind): Thing | ScreenStateValue | null {
  const own = useBitfieldData<unknown>(OWN_WALKTHROUGHS_INPUT);
  useShowChange();
  // The shipped tours are the file the page fetches once it has painted (main.tsx), so this reuses it; until it is
  // here the canvas shows it opening, never that the tour could not be found.
  const shipped = useScreenLoad('canvas-edit:shipped-tours', {
    loading: { label: words.opening, layout: 'editor' },
    read: () => import('trillion-walkthroughs').then(module => module.default as readonly WalkthroughDefinition[]),
    failed: refusal(words.could_not_open),
  });
  const walkthroughs = shipped.value;
  const definition = React.useMemo(() => {
    const all = [...(walkthroughs ?? []), ...(Array.isArray(own) ? own as WalkthroughDefinition[] : [])];
    return all.find(tour => tour.id === id) ?? null;
  }, [id, own, walkthroughs]);
  const registries = React.useMemo(defaultStepRegistries, []);
  if (!definition && shipped.state) return shipped.state;
  if (!definition) return null;
  const title = typeof definition.title === 'string' && definition.title ? definition.title : id;
  const pieces = definition.steps.map((step, index): Piece => {
    const changed = stepAsChanged(definition, step);
    // The row a field reads: the step as the rules leave it, with each button's look filled in, so a field shows the
    // look the card wears even where no rule set it.
    const row = { ...changed, look: { ...((changed.look as object) ?? {}), buttons: buttonLooksOf(definition, changed) } };
    const heading = (step.content as { payload?: { title?: unknown } } | undefined)?.payload?.title;
    return {
      id: step.id,
      label: `${index + 1} · ${typeof heading === 'string' && heading ? heading : step.id}`,
      facts: stepFacts(definition, step),
      row,
      draw: drawn => <StepOnCanvas definition={definition} step={drawn as WalkthroughStep} index={index} width={kind.part_width} registries={registries} />,
    };
  });
  return { title, pieces, play: () => emitWalkthroughEvent({ event_kind: 'walkthrough-requested', walkthrough_id: definition.id }) };
}

/** One step drawn as its card: the body the running tour draws, on the card or the paper the step wears. */
function StepOnCanvas({ definition, step, index, width, registries }: { definition: WalkthroughDefinition; step: WalkthroughStep; index: number; width: number; registries: ReturnType<typeof defaultStepRegistries> }) {
  const steps = definition.steps.map(one => (one.id === step.id ? step : one));
  const shown = { ...definition, steps };
  const { navButtons } = stepButtonsOf(shown, step, index);
  const exit = exitControlOf(shown, step);
  const paper: Paper | null = paperOf(shown, step);
  const closeButton = exit === 'close'
    ? <Button size="icon-xs" variant="ghost" aria-label="Close" tabIndex={-1}><NamedIcon name="X" size="xs" aria-hidden="true" /></Button>
    : null;
  const buttons = exit === 'end' ? [{ role: 'end', label: 'End tour' }, ...navButtons] : navButtons;
  const body = (
    <StepCardBody
      tourTitle={typeof definition.title === 'string' ? definition.title : ''}
      stepIndex={index}
      stepCount={definition.steps.length}
      progressStyle={(definition.progress_style as { style?: string } | undefined)?.style ?? 'counter'}
      progressReg={registries.progress}
      contentReg={registries.content}
      content={step.content as never}
      buttons={buttons}
      onAction={() => {}}
      looks={buttonLooksOf(shown, step)}
      closeButton={closeButton}
    />
  );
  const cardWidth = (step.look as { card_width_px?: unknown } | undefined)?.card_width_px;
  const shownWidth = typeof cardWidth === 'number' && cardWidth > 0 ? cardWidth : width;
  return paper
    ? <Container layout="vertical" data-canvas-part-surface="" data-walkthrough-paper="" style={{ ...paperStyle(paper), width: shownWidth }}>{body}</Container>
    : <Card variant="popover" padding="md" data-canvas-part-surface="" style={{ width: shownWidth }}>{body}</Card>;
}

type ScreenRow = Record<string, unknown> & { id: string; label?: string; icon?: string; listed?: boolean };
/** How a screen row is drawn: the same row the sidebar draws for it (parts/sidebar NavItem), in its list look or as
 *  the pane tab (`look`). */
const SCREEN_LOOKS = [{ id: 'list', label: 'In the sidebar', look: undefined }, { id: 'tab', label: 'As a tab', look: 'tab' }] as const;
const screenItem = (row: ScreenRow, look?: string): NavItemData => ({
  id: row.id, label: String(row.label ?? row.id), icon: typeof row.icon === 'string' ? row.icon : undefined,
  ...(typeof row.sidebar_colour === 'string' && row.sidebar_colour ? { colour: row.sidebar_colour } : {}),
  ...(typeof row.description === 'string' ? { description: row.description } : {}),
  ...(look ? { look } : {}),
});

/** A screen, drawn as its sidebar row and its tab; or, under the kind's `all` id, every screen the sidebar lists. The
 *  rows are the ones every place reads, with the person's changes already laid over them (sidebar-looks.ts). */
function useScreen(id: string, kind: Kind): Thing | ScreenStateValue | null {
  const rows = useBitfieldData<ScreenRow[] | null>({ input: 'placeable-surface-list-by-address-label', params: { addressLabel: surfaces.address_label } });
  useShowChange();
  // The rows are not here yet: the canvas is opening, not missing what it was asked for.
  if (rows === null || rows === undefined) return { status: 'loading', label: words.opening, layout: 'editor' };
  const all = Array.isArray(rows) ? rows : [];
  const draw = (look?: string) => (drawn: unknown) => (
    <Container layout="vertical" data-canvas-part-surface="" className="canvas-edit__screen-row">
      <NavItem item={screenItem(drawn as ScreenRow, look)} isActive={false} showLabel onClick={() => {}} />
    </Container>
  );
  if (kind.all && id === kind.all) {
    const listed = all.filter(row => row.listed !== false && typeof row.label === 'string');
    return { title: kind.all_title ?? kind.label, pieces: listed.map((row): Piece => ({ id: row.id, label: String(row.label), facts: row, row, draw: draw() })) };
  }
  const row = all.find(one => one.id === id);
  if (!row) return null;
  return { title: String(row.label ?? id), pieces: SCREEN_LOOKS.map((look): Piece => ({ id: `${row.id}#${look.id}`, label: look.label, facts: row, row, draw: draw(look.look) })) };
}

const READERS: Record<string, (id: string, kind: Kind) => Thing | ScreenStateValue | null> = { tour: useTour, screen: useScreen };

// ---------------------------------------------------------------------------------------------------------------------

/** The rule tree a scope makes for the picked parts: every one of its kind when the scope names no fact, else any picked
 *  part's values for the scope's facts. */
export function scopeWhen(scope: Scope, facts: Record<string, unknown>[], subject: string): unknown {
  if (!scope.facts.length) return null;
  const declared = (showFactPaths[subject] ?? {});
  const valueOf = (thing: Record<string, unknown>, fact: string) => String(at(thing, declared[fact] ?? [fact]) ?? '');
  const rows = [...new Map(facts.map(thing => [scope.facts.map(fact => valueOf(thing, fact)).join('\u0000'), thing])).values()];
  const and = (thing: Record<string, unknown>) => ({ kind: 'group', combinator: 'and', negate: false, rules: scope.facts.map(fact => ({ kind: 'rule', field: fact, operator: 'is_any_of', params: { values: [valueOf(thing, fact)] } })) });
  return rows.length === 1 ? and(rows[0]) : { kind: 'group', combinator: 'or', negate: false, rules: rows.map(and) };
}

const showFactPaths: Record<string, Record<string, string[]>> = Object.fromEntries(Object.entries(showRules.subjects as Record<string, { facts: { id: string; path?: string[] }[] }>)
  .map(([id, subject]) => [id, Object.fromEntries(subject.facts.filter(fact => fact.path).map(fact => [fact.id, fact.path!]))]));

/** Whether one piece is among the parts a scope reaches from the picked ones. */
function inScope(scope: Scope, picked: Piece[], piece: Piece, subject: string): boolean {
  const declared = showFactPaths[subject] ?? {};
  const valueOf = (thing: Record<string, unknown>, fact: string) => String(at(thing, declared[fact] ?? [fact]) ?? '');
  return picked.some(one => scope.facts.every(fact => valueOf(one.facts, fact) === valueOf(piece.facts, fact)));
}

function CanvasEdit({ address }: { address: string }) {
  const split = address.indexOf(':');
  const kindId = split > 0 ? address.slice(0, split) : '';
  const id = split > 0 ? address.slice(split + 1) : '';
  const kind = kinds[kindId];
  const read = READERS[kindId];
  const found = read && kind ? read(id, kind) : null;
  const opening = found && 'status' in found ? found : null;
  const thing = opening ? null : found as Thing | null;
  const subject = kind ? subjects[kind.subject] : null;
  const [picked, setPicked] = React.useState<Picked[]>([]);
  const [scopeId, setScopeId] = React.useState(subject?.scopes[0]?.id ?? '');
  const [draft, setDraft] = React.useState<Draft | null>(null);
  const [request, setRequest] = React.useState('');
  const timer = React.useRef<number>(0);
  const stage = React.useRef<HTMLElement | null>(null);
  // A Shift-drag on the canvas draws a lasso (in the stage's own pixels); every part it touches is picked on release.
  const [lasso, setLasso] = React.useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  useShowChange();

  // The picked parts are ringed on the canvas (data-canvas-picked), wherever their piece is drawn.
  React.useEffect(() => {
    const root = stage.current;
    if (!root || !subject) return;
    for (const element of root.querySelectorAll('[data-canvas-picked]')) element.removeAttribute('data-canvas-picked');
    for (const one of picked) {
      const part = subject.parts.find(row => row.id === one.part);
      const frame = root.querySelector(`[data-frame="${CSS.escape(one.piece)}"]`);
      if (!part || !frame) continue;
      const matches = [...frame.querySelectorAll(part.pick)].filter(element => !part.name_from || element.getAttribute(part.name_from) === one.name);
      for (const element of matches) element.setAttribute('data-canvas-picked', '');
    }
  });

  if (!address || !kind || !subject) return <Missing title={words.nothing_named} />;
  if (opening) return <ScreenState state={opening} />;
  if (!thing) return <Missing title={words.not_found} detail={words.not_found_detail} />;
  const scope = subject.scopes.find(row => row.id === scopeId) ?? subject.scopes[0];

  // A press inside a piece picks the innermost part the DATA names there; Shift or Cmd adds it to what is picked.
  const pick = (pieceId: string, event: React.MouseEvent) => {
    const target = event.target as Element;
    const found = subject.parts
      .map(part => ({ part, element: target.closest(part.pick) }))
      .filter((hit): hit is { part: PartRow; element: Element } => Boolean(hit.element))
      .sort((left, right) => (left.element.contains(right.element) ? 1 : right.element.contains(left.element) ? -1 : 0))[0];
    event.preventDefault();
    event.stopPropagation();
    if (!found) return;
    const shownWords = found.element instanceof HTMLElement ? found.element.innerText.replace(/\s+/g, ' ').trim().slice(0, 40) : '';
    const one: Picked = { piece: pieceId, part: found.part.id, name: found.part.name_from ? found.element.getAttribute(found.part.name_from) ?? '' : '', said: found.part.name_from ? shownWords : '' };
    const same = (left: Picked) => left.piece === one.piece && left.part === one.part && left.name === one.name;
    setDraft(null);
    setPicked(current => (event.shiftKey || event.metaKey || event.ctrlKey
      ? (current.some(same) ? current.filter(left => !same(left)) : [...current.filter(left => left.part === one.part && left.name === one.name), one])
      : [one]));
  };

  // Every part the lasso touches, of one kind: the kind already picked when it touches any, else the kind it touches
  // most (the first in DATA on a tie); a part named by an attribute (a button's role) keeps the one name it touches most.
  const pickInside = (area: { left: number; top: number; right: number; bottom: number }) => {
    const root = stage.current;
    if (!root) return;
    const touches = (element: Element) => { const box = element.getBoundingClientRect(); return box.right >= area.left && box.left <= area.right && box.bottom >= area.top && box.top <= area.bottom; };
    const hits = subject.parts.map(row => ({ row, found: [...root.querySelectorAll('[data-frame]')].flatMap(frame => [...frame.querySelectorAll(row.pick)].filter(touches).map(element => ({ piece: frame.getAttribute('data-frame') ?? '', element }))) }));
    const chosen = hits.find(hit => hit.row.id === picked[0]?.part && hit.found.length) ?? [...hits].sort((left, right) => right.found.length - left.found.length)[0];
    if (!chosen?.found.length) return;
    const nameOf = (element: Element) => (chosen.row.name_from ? element.getAttribute(chosen.row.name_from) ?? '' : '');
    const counts = new Map<string, number>();
    for (const hit of chosen.found) counts.set(nameOf(hit.element), (counts.get(nameOf(hit.element)) ?? 0) + 1);
    const name = picked[0]?.part === chosen.row.id && counts.has(picked[0].name) ? picked[0].name : [...counts.entries()].sort((left, right) => right[1] - left[1])[0][0];
    const kept = new Map<string, Picked>();
    for (const hit of chosen.found) {
      if (nameOf(hit.element) !== name || kept.has(hit.piece)) continue;
      const shown = hit.element instanceof HTMLElement ? hit.element.innerText.replace(/\s+/g, ' ').trim().slice(0, 40) : '';
      kept.set(hit.piece, { piece: hit.piece, part: chosen.row.id, name, said: chosen.row.name_from ? shown : '' });
    }
    setDraft(null);
    setPicked([...kept.values()]);
  };
  const stagePoint = (event: React.PointerEvent) => { const box = stage.current!.getBoundingClientRect(); return { x: event.clientX - box.left, y: event.clientY - box.top }; };
  const lassoStart = (event: React.PointerEvent) => {
    if (!event.shiftKey || (event.target as Element).closest('[data-canvas-piece], [data-canvas-edit-panel]')) return;
    event.preventDefault();
    event.stopPropagation();
    (event.currentTarget as Element).setPointerCapture?.(event.pointerId);
    const { x, y } = stagePoint(event);
    setLasso({ x0: x, y0: y, x1: x, y1: y });
  };
  const lassoMove = (event: React.PointerEvent) => {
    if (!lasso) return;
    event.stopPropagation();
    const { x, y } = stagePoint(event);
    setLasso({ ...lasso, x1: x, y1: y });
  };
  const lassoEnd = (event: React.PointerEvent) => {
    if (!lasso) return;
    event.stopPropagation();
    const box = stage.current!.getBoundingClientRect();
    setLasso(null);
    pickInside({ left: box.left + Math.min(lasso.x0, lasso.x1), top: box.top + Math.min(lasso.y0, lasso.y1), right: box.left + Math.max(lasso.x0, lasso.x1), bottom: box.top + Math.max(lasso.y0, lasso.y1) });
  };

  const pickedPieces = thing.pieces.filter(piece => picked.some(one => one.piece === piece.id));
  const part = subject.parts.find(row => row.id === picked[0]?.part) ?? null;
  const name = picked[0]?.name ?? '';
  const said = picked[0]?.said ?? '';

  // What the person is typing shows at once on every piece the chosen scope reaches.
  const rowOf = (piece: Piece) => (draft && inScope(draft.scope, thing.pieces.filter(one => draft.picked.some(p => p.piece === one.id)), piece, kind.subject)
    ? withChanges(piece.row, [{ path: draft.path, value: draft.value }])
    : piece.row);

  const keep = (field: Field, value: TuningValue) => {
    if (!part) return;
    const path = pathFor(field, name);
    const next: Draft = { scope, picked, path, value };
    setDraft(next);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      const when = scopeWhen(scope, pickedPieces.map(piece => piece.facts), kind.subject);
      const values = scope.facts.map(fact => pickedPieces.map(piece => String(at(piece.facts, showFactPaths[kind.subject]?.[fact] ?? [fact]) ?? '')).join('+')).join('/');
      const rule = {
        id: readableId(`edit:${kind.subject}:${scope.id}:${values}:${path.join('.')}`),
        label: `${part.label}${said ? ` “${said}”` : ''} · ${field.label} · ${scope.label}${scope.facts.length ? `: ${thing.title}` : ''}`,
        subject: kind.subject, effect: 'change', when, set: [{ path, value }], by: 'person',
      };
      saveShowRule(rule)
        .then(() => setDraft(current => (current === next ? null : current)))
        .catch(error => notify(errorWords(error), { kind: 'error' }));
    }, KEEP_AFTER_MS);
  };

  const frames: CanvasFrame[] = thing.pieces.map(piece => ({
    id: piece.id, label: piece.label, width: kind.part_width, height: kind.part_height,
    content: <Container layout="vertical" data-canvas-piece={piece.id} onClickCapture={(event: React.MouseEvent) => pick(piece.id, event)}>{piece.draw(rowOf(piece))}</Container>,
  }));

  // The fields of what is picked, read from the first picked piece as it is drawn now.
  const firstPiece = pickedPieces[0];
  const settings: TuningSetting[] = part ? part.fields.map(field => ({
    key: field.key, label: field.label, widget: field.widget,
    ...(field.options_from ? { options: options[field.options_from] ?? [] } : {}),
  })) : [];
  const valueFor = (field: Field): TuningValue => {
    const path = pathFor(field, name);
    if (draft && draft.path.join('\u0000') === path.join('\u0000')) return draft.value;
    const kept = firstPiece ? at(rowOf(firstPiece), path) : undefined;
    if (kept !== undefined && kept !== null) return kept as TuningValue;
    // Words no rule or row set yet read as the card shows them.
    if (field.widget !== 'words' || !firstPiece) return undefined;
    const shown = stage.current?.querySelector(`[data-frame="${CSS.escape(firstPiece.id)}"] [data-canvas-picked]`);
    return shown instanceof HTMLElement ? shown.innerText.trim() : undefined;
  };
  const values = Object.fromEntries((part?.fields ?? []).map(field => [field.key, valueFor(field)]));
  const paths = new Set((part?.fields ?? []).map(field => pathFor(field, name).join('\u0000')));
  const here = firstPiece ? (showOf(kind.subject, firstPiece.facts).changes ?? []).filter(change => paths.has(change.path.join('\u0000'))) : [];
  const job = picked.length ? queueJobProps('change-what-i-pointed-at', {
    page: `${location.pathname}${location.hash}`,
    selection: JSON.stringify({ kind: kindId, id, parts: picked, facts: pickedPieces.map(piece => piece.facts) }),
    request: request.trim(),
  }) : null;

  return (
    <Container layout="vertical" className="canvas-edit" data-canvas-edit={address}>
      <Container layout="horizontal" gap="sm" alignItems="center" justifyContent="between" className="canvas-edit__head">
        <Container layout="vertical" gap="none" className="min-w-0">
          <Text variant="label">{kind.label}</Text>
          <Text variant="heading" truncate>{thing.title}</Text>
        </Container>
        {thing.play ? <Button type="button" variant="secondary" size="sm" onClick={thing.play}><NamedIcon name="Play" size="xs" />Play</Button> : null}
      </Container>
      <Text variant="caption" color="muted" className="canvas-edit__hint">{picked.length > 1 ? fill(words.picked_count, { count: picked.length }) : words.pick_hint}</Text>
      <Container layout="horizontal" className="canvas-edit__body">
        <Container ref={stage as React.Ref<HTMLDivElement>} layout="vertical" className="canvas-edit__stage" onPointerDownCapture={lassoStart} onPointerMoveCapture={lassoMove} onPointerUpCapture={lassoEnd}>
          <FramesCanvas label={thing.title} frames={frames} gap={56} />
          {lasso ? <Container aria-hidden className="canvas-edit__lasso" data-canvas-lasso="" style={{ left: Math.min(lasso.x0, lasso.x1), top: Math.min(lasso.y0, lasso.y1), width: Math.abs(lasso.x1 - lasso.x0), height: Math.abs(lasso.y1 - lasso.y0) }} /> : null}
        </Container>
        {part ? (
          <Container layout="vertical" gap="md" padding="md" className="canvas-edit__panel" data-canvas-edit-panel="">
            <Container layout="horizontal" gap="sm" alignItems="center" justifyContent="between">
              <Container layout="vertical" gap="none" className="min-w-0">
                <Text variant="label">{firstPiece?.label}</Text>
                <Text variant="heading" truncate>{part.label}{said ? ` · ${said}` : ''}</Text>
              </Container>
              <Button type="button" variant="ghost" size="icon" aria-label={words.close} title={words.close} onClick={() => { setPicked([]); setDraft(null); }}><NamedIcon name="X" size="sm" /></Button>
            </Container>
            <Container layout="vertical" gap="xs">
              <Text variant="label">{words.applies_to}</Text>
              <SegmentedControl ariaLabel={words.applies_to} value={scope.id} onValueChange={next => { setScopeId(next); setDraft(null); }} items={subject.scopes.map(row => ({ id: row.id, label: row.label }))} />
            </Container>
            <TuningPanel sections={[{ id: part.id, title: part.label, settings }]} values={values} onChange={(key, value) => { const field = part.fields.find(row => row.key === key); if (field) keep(field, value); }} />
            {here.length ? (
              <Container layout="vertical" gap="xs" data-canvas-edit-changes="">
                <Text variant="label">{words.changes_here}</Text>
                {here.map(change => (
                  <Container key={`${change.rule}:${change.path.join('.')}`} layout="horizontal" gap="sm" alignItems="center" justifyContent="between">
                    <Text variant="caption" truncate>{change.label}</Text>
                    <Button type="button" variant="ghost" size="sm" onClick={() => removeShowRule(change.rule).catch(error => notify(errorWords(error), { kind: 'error' }))}><NamedIcon name="Undo2" size="xs" />{words.undo}</Button>
                  </Container>
                ))}
              </Container>
            ) : null}
            <Container layout="vertical" gap="xs">
              <Text variant="label">{words.ask_label}</Text>
              <Textarea aria-label={words.ask_label} placeholder={words.ask_placeholder} rows={2} value={request} onChange={event => setRequest(event.target.value)} />
              {job && request.trim() ? <QueueJobButton {...job} /> : null}
            </Container>
          </Container>
        ) : null}
      </Container>
    </Container>
  );
}

function Missing({ title, detail }: { title: string; detail?: string }) {
  return (
    <Container layout="vertical" gap="sm" padding="lg" alignItems="center" justifyContent="center" className="canvas-edit">
      <NamedIcon name="Frame" size="md" />
      <Text variant="heading">{title}</Text>
      {detail ? <Text variant="body" color="muted">{detail}</Text> : null}
    </Container>
  );
}

/** Mounts Edit on canvas on the thing its address names (`id`: <kind>:<id>, as /edit/<kind>:<id> opens it). */
export function mountCanvasEditScreen(element: HTMLElement, props: { surfaceInput?: Record<string, unknown> }): () => void {
  const address = typeof props.surfaceInput?.id === 'string' ? decodeURIComponent(props.surfaceInput.id) : '';
  if (!address) {
    mountScreenState(element, { status: 'empty', icon: 'Frame', title: words.nothing_named, description: words.not_found_detail });
    return () => element.replaceChildren();
  }
  // A kind with its own canvas (a site's editor) opens there, on this thing.
  const split = address.indexOf(':');
  const own = split > 0 ? mounted[address.slice(0, split)]?.mounts : undefined;
  const mountOwn = own ? screens[own.entry] : undefined;
  if (own && mountOwn) {
    const id = address.slice(split + 1);
    return mountOwn(element, { surfaceInput: Object.fromEntries(Object.entries(own.input).map(([key, value]) => [key, value.replace('{id}', id)])) });
  }
  const host = document.createElement('div');
  host.className = 'trillion-canvas-edit';
  element.replaceChildren(host);
  const root = createRoot(host);
  root.render(<CanvasEdit address={address} />);
  return () => { root.unmount(); element.replaceChildren(); };
}
