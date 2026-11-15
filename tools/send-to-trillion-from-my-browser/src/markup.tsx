// extension/src/markup.tsx
//
// PURPOSE
//   Mark up the picture of the page before it is sent: the popup's picture opens here, in its own window, with the
//   pen, line, rectangle, ellipse and eraser and the colours every drawing in Trillion starts with
//   (parts/addressed-marks/starting-marks.json). Done draws the marks into the picture itself and puts it back in
//   the popup's draft for that tab (session `draft:<tab>`), so the next Send carries the marked picture; the popup
//   opens again showing it.
//
// NON-NEGOTIABLE INVARIANTS
//   1. The ink is the shared ink (parts/addressed-marks AddressedMarkLayer): the same tools, colours and shapes as a
//      board or a pane in the workspace; nothing here draws a stroke of its own.
//   2. The marks are drawn into the picture at the picture's own size, in the colours the person saw.
//   3. Nothing leaves this browser here: the marked picture is kept only when the person sends.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import React from 'react';
import { createRoot } from 'react-dom/client';
import { Button } from 'trillion-workshop/tools/ui/show/button/index.ts';
import { ColorDot } from 'trillion-workshop/tools/ui/show/color-dot/index.ts';
import { Container } from 'trillion-workshop/tools/ui/show/container/index.ts';
import { ImageBlock } from 'trillion-workshop/tools/ui/show/image-block/ImageBlock.tsx';
import { NamedIcon } from 'trillion-workshop/tools/ui/show/icon/index.ts';
import { Text } from 'trillion-workshop/tools/ui/show/text/index.ts';
import { paintWithWornLook } from './worn-look-page';
import { AddressedMarkLayer } from 'trillion-workshop/tools/addressed-marks/show/AddressedMarkLayer.tsx';
import { materializeMarkRecords, readMarkOperationRecords, readMarkStyles, readMarkTools, type MarkStyleRecord } from 'trillion-workshop/tools/addressed-marks/read-data/addressed-marks.ts';
import type { MarkOperationWrite } from 'trillion-workshop/tools/addressed-marks/do-work/record-mark-operation.ts';
import starting from 'trillion-workshop/tools/addressed-marks/starting-marks.json' with { type: 'json' };
import words from '../words.json' with { type: 'json' };

const said = words.markup;
const tab = new URL(location.href).searchParams.get('tab');
const draftKey = `draft:${tab}`;
const target = { address: 'extension:picture-of-the-page' };
const styles = readMarkStyles(starting.styles);
const tools = readMarkTools(starting.tools);

/** The ink as mark operation records, the shape the shared reader and renderer take. */
const recordsOf = (writes: MarkOperationWrite[]) => writes.map(write => ({ id: write.id, target: write.target, tool_ref: write.toolRef, style_ref: write.styleRef, created_at: write.createdAt, body: write.body }));

/** A style's colour as the person saw it: a concrete colour, or the look's value of its token. */
const colourOf = (style: MarkStyleRecord | null | undefined) => {
  const look = getComputedStyle(document.documentElement);
  if (style?.stroke) return style.stroke;
  return (style?.strokeToken ? look.getPropertyValue(style.strokeToken).trim() : '') || look.getPropertyValue('--color-info').trim() || look.getPropertyValue('--white-pure').trim();
};

/** The picture with the marks drawn into it, at the picture's own size, as a JPEG data address. */
async function drawInto(picture: string, writes: MarkOperationWrite[], shownWidth: number): Promise<string> {
  const image = new Image();
  image.src = picture;
  await image.decode();
  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext('2d')!;
  context.drawImage(image, 0, 0);
  const material = materializeMarkRecords({ operations: recordsOf(writes), styles, target });
  // Widths are screen pixels on the picture as shown; the picture itself is usually larger.
  const scale = canvas.width / Math.max(1, shownWidth);
  context.lineCap = 'round';
  context.lineJoin = 'round';
  for (const path of material.paths) {
    const points = path.coordinateSet.points;
    if (points.length < 2) continue;
    context.beginPath();
    points.forEach((point, index) => {
      const x = (point.values[0] ?? 0) * canvas.width;
      const y = (point.values[1] ?? 0) * canvas.height;
      if (index === 0) context.moveTo(x, y); else context.lineTo(x, y);
    });
    if (path.coordinateSet.closed) context.closePath();
    context.globalAlpha = path.style?.strokeOpacity ?? 1;
    context.strokeStyle = colourOf(path.style);
    context.lineWidth = (path.style?.strokeWidth ?? 3) * scale;
    context.stroke();
  }
  context.globalAlpha = 1;
  return canvas.toDataURL('image/jpeg', 0.9);
}

function Markup() {
  const [picture, setPicture] = React.useState<string | null | undefined>(undefined);
  const [writes, setWrites] = React.useState<MarkOperationWrite[]>([]);
  const [toolRef, setToolRef] = React.useState(tools[0]?.id ?? '');
  const [styleRef, setStyleRef] = React.useState(styles.find(style => style.label === said.first_colour)?.id ?? styles[0]?.id ?? '');
  const [problem, setProblem] = React.useState<string | null>(null);
  const shown = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    chrome.storage.session.get(draftKey).then(stored => setPicture(stored[draftKey]?.found?.picture ?? null));
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') window.close(); };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, []);

  async function done() {
    if (!picture) return;
    try {
      const marked = writes.length ? await drawInto(picture, writes, shown.current?.getBoundingClientRect().width ?? 1) : picture;
      const stored = await chrome.storage.session.get(draftKey);
      const draft = stored[draftKey];
      await chrome.storage.session.set({ [draftKey]: { ...draft, keepPicture: true, found: { ...draft.found, picture: marked, picture_marked: writes.length > 0 || draft.found.picture_marked === true } } });
      // The popup opens again on the tab it came from, showing the marked picture.
      await chrome.action.openPopup().catch(() => {});
      window.close();
    } catch (error) {
      setProblem((error as Error).message || said.could_not);
    }
  }

  if (picture === undefined) return null;
  if (picture === null) return <Container padding="md"><Text variant="body-sm" color="muted">{said.no_picture}</Text></Container>;

  return (
    <Container layout="vertical" gap="sm" padding="md" width="full">
      <Container layout="horizontal" gap="xs" alignItems="center" justifyContent="between" width="full" wrap>
        <Container layout="horizontal" gap="xs" alignItems="center" wrap>
          {tools.map(tool => (
            <Button key={tool.id} variant={tool.id === toolRef ? 'secondary' : 'ghost'} size="icon" aria-label={tool.label ?? tool.id} title={tool.label ?? tool.id}
              aria-pressed={tool.id === toolRef} onClick={() => setToolRef(tool.id)}>
              <NamedIcon name={tool.icon ?? 'Pencil'} size="sm" aria-hidden="true" />
            </Button>
          ))}
          {styles.map(style => (
            <Button key={style.id} variant={style.id === styleRef ? 'secondary' : 'ghost'} size="icon" aria-label={style.label ?? style.id} title={style.label ?? style.id}
              aria-pressed={style.id === styleRef} onClick={() => setStyleRef(style.id)}>
              <ColorDot color={colourOf(style)} size="lg" label={style.label ?? style.id} />
            </Button>
          ))}
        </Container>
        <Container layout="horizontal" gap="xs" alignItems="center">
          <Button variant="ghost" size="sm" disabled={!writes.length} onClick={() => setWrites(current => current.slice(0, -1))}>{said.undo}</Button>
          <Button variant="ghost" size="sm" onClick={() => window.close()}>{said.cancel}</Button>
          <Button variant="primary" size="sm" onClick={done} pendingLabel={said.saving} errorLabel={said.try_again}>{said.done}</Button>
        </Container>
      </Container>
      <Container ref={shown} position="relative" rounded="md" overflow="hidden" width="full">
        <ImageBlock src={picture} alt={said.picture} objectFit="contain" className="block h-auto w-full select-none" />
        <AddressedMarkLayer target={target} operations={readMarkOperationRecords(recordsOf(writes))} styles={styles} tools={tools} selectedToolRef={toolRef} selectedStyleRef={styleRef}
          onRecordOperation={write => setWrites(current => [...current, write])} ariaLabel={said.draw} className="absolute inset-0 h-full w-full touch-none cursor-crosshair" />
      </Container>
      {problem ? <Text variant="caption" color="error" role="alert">{problem}</Text> : null}
    </Container>
  );
}

// The look the person wears in Trillion (extension/src/worn-look-page.ts).
paintWithWornLook();
createRoot(document.body.appendChild(document.createElement('main'))).render(<Markup />);
