// src/workspace/point-at-anything.tsx
//
// PURPOSE
//   Point at anything on a Trillion screen and change it: the page's one pointing host. While pointing (started from any
//   pane's ⋯ menu, `startPointing`), a ring follows what is under the pointer and a press picks it
//   (parts/ui/show/point-at-anything). A card beside what was picked then offers two roads:
//   - Every one like it: the look tokens that element wears (parts/screen-look/read-data/tokens-on-element.ts), changed
//     on the spot and kept in the person's own look, so every element wearing that token changes with it.
//   - Ask my AI: the person's words and the picked element (its VisualSelectionRef) handed to their own AIs
//     (src/queued-work.json `change-what-i-pointed-at`), for anything a look cannot change. The card shows the steps
//     the person took just before (parts/ui/show/recent-steps), which every press carries, so they see what the AI sees.
//
// NON-NEGOTIABLE INVARIANTS
//   1. One selection shape (VisualSelectionRef) and one road to the AIs (sendQueuedJob); nothing here names a screen.
//   2. A token change is kept at once in the person's own look and is taken back by Undo to the look as it was.
//   3. The card and the hint are the picker's own controls (`POINT_AT_ANYTHING_UI`), so they are never picked.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import * as React from 'react';
import { Button, ColorDot, LAYER_ORDER, ColorPickerPopover, Container, ErrorBoundary, NamedIcon, Slider, Text, Textarea } from '../../parts/ui';
import { mountReactSurface } from '../../parts/ui/show/react-surface-mount';
import { QueueJobButton } from '../../parts/ui/show/queue-job/QueueJobButton';
import { keepPick, PointAtAnything, POINT_AT_ANYTHING_UI, stopPointing, usePointing } from '../../parts/ui/show/point-at-anything';
import { noteStep, recentSteps, RecentSteps } from '../../parts/ui/show/recent-steps';
import { useScreenLooks } from '../../parts/screen-look/show/use-screen-looks';
import { resolveScreenLookCssVariables } from '../../parts/screen-look/show/ApplyCurrentScreenLook';
import { saveOwnScreenLook } from '../../parts/screen-look/do-work/screen-look-records';
import { replaceEditableScreenLookToken } from '../../parts/screen-look/do-work/update-editable-screen-look-theme';
import { propertiesToRead, tokensOnElement, variablesInClasses, type WornToken } from '../../parts/screen-look/read-data/tokens-on-element';
import type { EditableScreenLookTheme, EditableScreenLookToken } from '../../parts/screen-look/read-data/read-editable-screen-look-themes';
import type { VisualSelectionRef } from '../../parts/ui/show/public-app-editor/selection-ref';
import { ElementResponses } from '../../parts/ui/show/responses/ElementResponses';
import { queueJobProps } from './queue-job';
import { targetOf } from './responses';
import reactions from '../reactions.json';
import words from './point-at-anything.json';

const ui = { [POINT_AT_ANYTHING_UI]: '' };
const CARD_WIDTH = 352;
const SAVE_AFTER_MS = 250;

/** For one element: which of its counted properties change when each token changes. Each token is set to another
 *  value in the look, the page variables that change with it (`resolveScreenLookCssVariables`, the same ones saving the
 *  look sets) are set, the element is read with its transitions held (a transition would report the old value), and
 *  the variables are put back, all before the page paints. */
function changesOn(element: Element, theme: EditableScreenLookTheme): Map<string, string[]> {
  const root = document.documentElement;
  const names = propertiesToRead();
  const own = element instanceof HTMLElement || element instanceof SVGElement ? element.style : null;
  const heldTransition = own?.getPropertyValue('transition') ?? '';
  own?.setProperty('transition', 'none', 'important');
  const read = () => { const computed = getComputedStyle(element); return names.map(name => computed.getPropertyValue(name)); };
  const before = read();
  const resting = resolveScreenLookCssVariables(theme);
  const changes = new Map(theme.tokens.map(token => {
    const other = token.kind === 'number' ? Number(token.value) + 7 : token.kind === 'color' ? '#010203' : null;
    if (other === null) return [token.key, []] as const;
    const moved = Object.entries(resolveScreenLookCssVariables(replaceEditableScreenLookToken(theme, token.key, other)))
      .filter(([variable, value]) => resting[variable] !== value);
    const kept = moved.map(([variable]) => [variable, root.style.getPropertyValue(variable), root.style.getPropertyPriority(variable)] as const);
    for (const [variable, value] of moved) root.style.setProperty(variable, value, 'important');
    const after = read();
    for (const [variable, value, priority] of kept) if (value) root.style.setProperty(variable, value, priority); else root.style.removeProperty(variable);
    return [token.key, names.filter((_, at) => after[at] !== before[at])] as const;
  }));
  if (heldTransition) own?.setProperty('transition', heldTransition); else own?.removeProperty('transition');
  return changes;
}

/** The colour a token holds, as a hex the colour wheel takes ('' when it is not a colour). */
function hexOf(value: string | number): string {
  if (typeof value !== 'string') return '';
  if (/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(value)) return value;
  const match = value.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/i);
  if (!match) return '';
  const byte = (n: number) => Math.round(n).toString(16).padStart(2, '0');
  const alpha = match[4] === undefined ? '' : byte(Number(match[4]) * 255);
  return `#${byte(Number(match[1]))}${byte(Number(match[2]))}${byte(Number(match[3]))}${alpha}`;
}

/** What was picked, in a few words: its words as the page shows them, else its label, else its kind. */
function nameOf(selection: VisualSelectionRef, element: Element): string {
  const shown = element instanceof HTMLElement ? element.innerText.replace(/\s+/g, ' ').trim() : '';
  const said = shown || selection.text || selection.attributes['aria-label'] || selection.attributes.title || selection.attributes.placeholder || '';
  return said ? `${said.slice(0, 60)}${said.length > 60 ? '…' : ''}` : (words.kinds as Record<string, string>)[selection.tag] ?? words.kinds.other;
}

function ColourToken({ word, token, onChange }: { word: string; token: EditableScreenLookToken; onChange: (value: string) => void }) {
  const anchor = React.useRef<HTMLButtonElement>(null);
  const [open, setOpen] = React.useState(false);
  const hex = hexOf(token.value);
  return (
    <>
      <Button ref={anchor} type="button" variant="ghost" size="menu" data-point-token={token.key} onClick={() => setOpen(true)}>
        <ColorDot color={String(token.value)} size="sm" label={word} className="ring-1 ring-[var(--border-primary)]" />
        {word}
      </Button>
      <ColorPickerPopover anchorRef={anchor as React.RefObject<HTMLElement>} open={open} value={hex || '#000000'} onChange={onChange} onDismiss={() => setOpen(false)} title={word} placement="below" />
    </>
  );
}

function TokenRow({ word, token, onChange }: { word: string; token: EditableScreenLookToken; onChange: (value: string | number) => void }) {
  if (token.kind === 'number') {
    return (
      <Container layout="vertical" gap="xs" data-point-token={token.key}>
        <Text variant="label">{word}</Text>
        <Slider aria-label={word} value={Number(token.value)} min={token.min ?? 0} max={token.max ?? 32} step={token.step ?? 1} onValueChange={onChange} />
      </Container>
    );
  }
  if (hexOf(token.value)) return <ColourToken word={word} token={token} onChange={onChange} />;
  return null;
}

function PickedCard({ selection, element }: { selection: VisualSelectionRef; element: Element }) {
  const responseTarget = React.useMemo(() => targetOf(element), [element]);
  const responsePart = React.useMemo(() => ({ kind: 'element' as const, page_path: selection.page_path,
    ...(selection.element ? { element: selection.element } : { selector: selection.selector }) }), [selection]);
  const { chosen } = useScreenLooks();
  const [request, setRequest] = React.useState('');
  const [steps] = React.useState(() => recentSteps());
  const [before] = React.useState<EditableScreenLookTheme>(chosen);
  const [draft, setDraft] = React.useState<EditableScreenLookTheme>(chosen);
  const [changed, setChanged] = React.useState(false);
  const timer = React.useRef<number>(0);
  const tokens = React.useMemo(() => {
    const changes = changesOn(element, before);
    return tokensOnElement(before, token => changes.get(token.key) ?? [], variablesInClasses(element.getAttribute('class') ?? ''))
      .filter(({ token }) => token.kind === 'number' || hexOf(token.value));
  }, [element, before]);
  const keep = React.useCallback((next: EditableScreenLookTheme) => {
    setDraft(next);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => { void saveOwnScreenLook(next); }, SAVE_AFTER_MS);
  }, []);
  const change = (key: string, value: string | number) => { setChanged(true); keep(replaceEditableScreenLookToken(draft, key, value)); };
  const undo = () => { setChanged(false); keep(before); };
  const job = queueJobProps('change-what-i-pointed-at', {
    page: `${location.pathname}${location.hash}`,
    selection: JSON.stringify(selection),
    request: request.trim() || words.no_words,
  });
  const narrow = window.innerWidth < CARD_WIDTH + 32;
  const below = selection.bounds.y + selection.bounds.height + 8;
  const left = narrow ? 8 : Math.max(8, Math.min(selection.bounds.x, window.innerWidth - CARD_WIDTH - 8));
  const top = narrow ? undefined : below + 360 < window.innerHeight ? below : Math.max(8, selection.bounds.y - 368);
  const shown = new Map(draft.tokens.map(token => [token.key, token]));
  return (
    <Container
      {...ui}
      data-point-card
      data-recent-steps-ignore
      position="fixed"
      left={`${left}px`}
      {...(top === undefined ? {} : { top: `${top}px` })}
      width={narrow ? 'calc(100vw - 16px)' : `${CARD_WIDTH}px`}
      maxHeight="70vh"
      overflow="auto"
      layout="vertical"
      gap="sm"
      padding="md"
      rounded="lg"
      border="all"
      style={{ zIndex: LAYER_ORDER.dialog }}
      className={`bg-[var(--glass-bg-popover)] shadow-[var(--surface-shadow-raised)] ${narrow ? 'bottom-2' : ''}`}
    >
      <Container layout="horizontal" gap="sm" alignItems="center" justifyContent="between">
        <Container layout="vertical" gap="none">
          <Text variant="label">{words.picked}</Text>
          <Text variant="heading">{nameOf(selection, element)}</Text>
        </Container>
        <Button type="button" variant="ghost" size="icon" aria-label={words.close} title={words.close} onClick={stopPointing}><NamedIcon name="X" size="sm" /></Button>
      </Container>
      <Container layout="vertical" gap="xs" data-point-ask>
        <Text variant="label">{words.ask_label}</Text>
        <Textarea aria-label={words.ask_label} placeholder={words.ask_placeholder} value={request} rows={3} onChange={event => setRequest(event.target.value)} />
        {job ? <QueueJobButton {...job} /> : null}
        <RecentSteps steps={steps} />
      </Container>
      {responseTarget ? <ElementResponses target={responseTarget} part={responsePart} palette={reactions.palette} /> : null}
      {tokens.length ? (
        <Container layout="vertical" gap="xs" data-point-every-one>
          <Text variant="label">{words.every_one_like_it}</Text>
          {tokens.map(({ word, token }: WornToken) => <TokenRow key={token.key} word={word} token={shown.get(token.key) ?? token} onChange={value => change(token.key, value)} />)}
          {changed ? <Button type="button" variant="ghost" size="menu" onClick={undo}><NamedIcon name="Undo2" size="xs" />{words.undo}</Button> : null}
        </Container>
      ) : null}
    </Container>
  );
}

/** A pick is a step the person took (parts/ui/show/recent-steps), named as the card names it. */
function pick(selection: VisualSelectionRef, element: Element) {
  noteStep('picked', nameOf(selection, element));
  keepPick(selection, element);
}

function PointingHost() {
  const { active, picked } = usePointing();
  return (
    <>
      <PointAtAnything active={active} pagePath={location.pathname} revision={words.revision} onSelect={pick} onCancel={stopPointing} />
      {active ? (
        <Container {...ui} data-point-hint position="fixed" top="12px" left="50%" transform="translateX(-50%)" layout="horizontal" gap="sm" alignItems="center" padding="sm" rounded="lg" border="all" style={{ zIndex: LAYER_ORDER.dialog }} className="bg-[var(--glass-bg-popover)] shadow-[var(--surface-shadow-raised)]">
          <NamedIcon name="MousePointerClick" size="sm" />
          <Text variant="body">{words.hint}</Text>
          <Button type="button" variant="ghost" size="sm" onClick={stopPointing}>{words.stop}</Button>
        </Container>
      ) : null}
      {picked ? <PickedCard key={picked.selection.selector} selection={picked.selection} element={picked.element} /> : null}
    </>
  );
}

let mounted = false;

/** Mount the page's one pointing host (once). */
export function mountPointAtAnything(): void {
  if (mounted) return;
  mounted = true;
  const host = document.createElement('div');
  document.body.append(host);
  mountReactSurface(host, <ErrorBoundary surfaceName={words.surface}><PointingHost /></ErrorBoundary>);
}
