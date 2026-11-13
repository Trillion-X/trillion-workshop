// src/workspace/tray-screen.tsx
//
// PROVENANCE (anatomy only, no code copied)
//   The tray reads like the message boxes people already use: the things going with the message above, the note and
//   Send at the foot, where it goes chosen in one place. Taken from 21st.dev "Attachment Composer Tray" (component
//   28500: removable chips above the words, attach and send on one row), 21st.dev "Input Bar" (12400: staged
//   attachments, slot toolbars) and "File Attachment" (12351: the kind's icon, a remove that shows on hover); Mobbin
//   Microsoft Copilot (mobbin.com/screens/2ff3d94d-adb2-4937-818d-de633b9757c3: attachment cards over the box),
//   Cofounder (mobbin.com/screens/b4d7cc47-3326-4b98-9ed4-e8963f1a7e8c: a list in a side panel with the box pinned at
//   its foot) and Patreon (mobbin.com/screens/dcb01c00-d1eb-489e-a1fb-b3c675672d0b: a picture waiting in the box).
//
// PURPOSE
//   Your tray (entry `tray`, in the sidebar's Your tray row): everything the person picked anywhere in Trillion, each a
//   row they can open where it was picked or take out, and the shared message box under it for a note, a picture of
//   the screen or anything else, sent with the picked things. By default no place is named and Trillion routes the share
//   itself; Choose where opens Send to for one place. Every send is kept on this device before it is posted and sent
//   again, with the same request_key, if the account cannot be reached (src/workspace/share-outbox.ts). Pick things turns
//   picking on (tray.ts): clicks then add what is clicked, a dragged box adds several, Esc stops. Where it can go is
//   read from the account: each place they share to (GET /work/api/share-destinations): their own Trillion, which
//   hands it to their AI, each space, and each tool place (every tool whose input takes the picked things, Tell the
//   people who make Trillion among them), all sent through the one delivery (POST /work/api/share-destinations/deliver).
//   A new place to send to is a new tool row.
//   Sent to a place, Your AI will offers every one of the person's own saved actions, in their folders (the message
//   box's own picker, src/workspace/send-choices.ts actionPicker), so the AI does what that action says with it.
//   A thing picked inside a shared space carries that space (tray.json `contexts`): the space comes first in Send to
//   and a note to the people who make Trillion says which space it came from; with nothing picked in a space, their own Trillion
//   comes first.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Nothing here names a place, a tool or a kind of thing: places and tools come from the account, kinds from the
//      page (tray.json rules), every word and icon from tray.json.
//   2. Nothing leaves the page until the person presses Send; a refused send keeps the tray, the note and everything
//      attached, and says what the Worker said (the shared Composer keeps its draft until onSend resolves).
//   3. A picture or file is kept in the person's own Files first (upload.ts) and travels by its identity.
//   4. Every control is a shared part (parts/ui: listing rows, the screen states, the Composer, the action menu); this
//      file writes no markup of its own.
//   6. A default send names no place (`to` is left out); a share the account could not be reached for clears the tray
//      and says it is kept, never that it failed.
//   5. Where the tray can go is read through the shared screen-state lifecycle: loading rows, then the tray, or why
//      it could not load with Try again.

import * as React from 'react';
import { Button, Container, NamedIcon, Text } from '../../parts/ui';
import { mountReactSurface } from '../../parts/ui/show/react-surface-mount';
import { notify } from '../../parts/ui/show/coss/notifications';
import { useTray, hasSelectedRecordDragData, readSelectedRecordDragData, type TrayThing } from '../../parts/ui/show/selection';
import { ListingGrid, type Listing } from '../../parts/ui/show/listing-card';
import { ScreenState, useScreenLoad } from '../../parts/ui/show/screen-state';
import { Composer, type ComposerDraft, type ComposerPicker, type ComposerProps } from '../../parts/ui/show/composer';
import { ActionMenu } from '../../parts/ui/show/action-menu';
import { relativeWhen } from '../../parts/ui/show/relative-time/relative-time';
import { readJson } from './api';
import type { Delivered as OutboxResult } from './share-outbox';
import { routedWords } from './send-routed';
import { reasonOf, refusal } from './failure';
import { uploadFiles } from './upload';
import { actionPicker, deviceOutbox, pickersBehind, useDeadShares, useWaitingToSend, type Action, type Folder } from './send-choices';
import { openSharing } from './sharing-sheet';
import { openScreen } from './open-screen';
import { addDraggedRecordsToTray, screenRowOf, tray } from './tray';
import settings from './tray.json';

const words = settings.words;
type Place = { id: string; label: string; depth?: number; others_count?: number; to?: { private?: boolean; pursuit_id?: string; space_id?: string; tool_id?: string } };
type Choices = { places: Place[]; actions: Action[]; folders: Folder[] };
type Kept = { identity: string; name: string; picture: boolean };
type Sending = { things: readonly TrayThing[]; note: string; kept: Kept[]; links: string[]; action: string | null };
type Destination = { key: string; label: string; icon: string; depth: number; takesAction: boolean; run: (sent: Sending) => Promise<string> };
export type TrayShareItem = { record?: string; code?: string; url?: string; text?: string; title: string };

const fill = (template: string, values: Record<string, string>) => template.replace(/\{(\w+)\}/g, (whole, key) => values[key] ?? whole);
/** Preserve the selected thing's own share reference/value; a screen pathname is not a shareable item. */
export function shareItemOf(thing: TrayThing): TrayShareItem | null {
  const title = thing.label.trim().slice(0, 300) || thing.kind;
  if (thing.share_record) return { record: thing.share_record, title };
  if (thing.share_url) {
    let url: URL;
    try { url = new URL(thing.share_url, globalThis.location?.href); }
    catch { return null; }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    const shareRoot = url.origin === globalThis.location?.origin && !url.search && !url.hash
      ? /^\/share\/([A-Za-z0-9_-]+)\/?$/.exec(url.pathname)
      : null;
    return shareRoot ? { code: shareRoot[1], title } : { url: url.href, title };
  }
  if (thing.share_text?.trim()) return { text: thing.share_text, title };
  return null;
}

/** Deduplicate one mixed selection by its source value while retaining the first visible title. */
export function shareItemsOf(things: readonly TrayThing[]): TrayShareItem[] {
  const unique = new Map<string, TrayShareItem>();
  for (const thing of things) {
    const item = shareItemOf(thing);
    if (!item) continue;
    const key = item.record ? `record:${item.record}` : item.code ? `share:${item.code}` : item.url ? `link:${item.url}` : `text:${item.text}`;
    if (!unique.has(key)) unique.set(key, item);
  }
  return [...unique.values()];
}

const lineOf = (thing: TrayThing, placeOf: (thing: TrayThing) => string | null) => {
  const where = [thing.screen_label ? fill(words.on_screen, { screen: thing.screen_label }) : null, placeOf(thing) ? fill(words.in_place, { place: placeOf(thing) as string }) : null].filter(Boolean).join(', ');
  return `${thing.kind}: ${thing.label}${where ? ` (${where})` : ''}`;
};

const canTakePicture = () => typeof navigator.mediaDevices?.getDisplayMedia === 'function' && 'ImageCapture' in globalThis;

/** A picture of the screen: the browser asks which tab to show, and one frame of it becomes a file in the box. */
async function takePicture(): Promise<File> {
  const media = navigator.mediaDevices as MediaDevices & { getDisplayMedia(options: Record<string, unknown>): Promise<MediaStream> };
  const stream = await media.getDisplayMedia({ video: { displaySurface: 'browser' }, audio: false, preferCurrentTab: true, selfBrowserSurface: 'include' });
  try {
    const [track] = stream.getVideoTracks();
    const Capture = (globalThis as unknown as { ImageCapture: new (track: MediaStreamTrack) => { grabFrame(): Promise<ImageBitmap> } }).ImageCapture;
    const frame = await new Capture(track).grabFrame();
    const canvas = new OffscreenCanvas(frame.width, frame.height);
    canvas.getContext('2d')?.drawImage(frame, 0, 0);
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    return new File([blob], `Screen ${new Date().toISOString().replace(/[:.]/g, '-')}.png`, { type: 'image/png' });
  } finally {
    stream.getTracks().forEach(track => track.stop());
  }
}

/** The places the person shares to (tool places among them) with their saved actions. */
async function readChoices(): Promise<Choices> {
  const places = await readJson<{ destinations: Place[]; actions: Action[]; folders?: Folder[] }>('/work/api/share-destinations');
  return { places: places.destinations, actions: places.actions, folders: places.folders ?? [] };
}

/** What goes in a share: each picked thing as it was picked, the kept files and the pasted links. */
function itemsOf({ things, kept, links }: Pick<Sending, 'things' | 'kept' | 'links'>, placeOf: (thing: TrayThing) => string | null) {
  return [
    ...things.map(thing => ({ kind: 'selection', title: thing.label, text: lineOf(thing, placeOf), ...(thing.share_record ? { record: thing.share_record } : thing.share_url ? { url: thing.share_url } : thing.share_text ? { text: thing.share_text } : thing.address ? { url: new URL(thing.address, location.origin).href } : {}) })),
    ...kept.map(file => ({ kind: file.picture ? 'image' : 'file', name: file.name, file: file.identity })),
    ...links.map(url => ({ kind: 'link', url })),
  ];
}

/** The default: no place named, so Trillion routes the share itself. */
function routeItself(placeOf: (thing: TrayThing) => string | null): Destination {
  return {
    key: 'route', label: '', icon: words.send_to_icon, depth: 0, takesAction: false,
    run: async ({ things, note, kept, links }) => {
      const items = itemsOf({ things, kept, links }, placeOf);
      const result: OutboxResult = await (await deviceOutbox()).deliver({
        items: items.length ? items : [{ kind: 'selection', text: note }], request_key: crypto.randomUUID(),
        from: 'Web', from_agent: 'trillion-web', ...(note && items.length ? { own_words: note } : {}),
      });
      if (result.state === 'sent' && result.answer.stopped_at) throw new Error(result.answer.stopped_at.error);
      return routedWords(result);
    },
  };
}

/**
 * Where the tray can go: the place the person is working in first (the pursuit whose room or own page the newest
 * thing was picked in, else their own Trillion), then each other place in the one order the sidebar shows, tool places
 * last; a tool place is told the things picked,
 * the screen and where they came from.
 */
function destinationsOf({ places }: Choices, placeOf: (thing: TrayThing) => string | null, current: TrayThing['context'] | null): Destination[] {
  const here = (place: Place) => (current ? place.to?.space_id === current.id || place.to?.pursuit_id === current.id : Boolean(place.to?.private));
  const ordered = [...places.filter(here), ...places.filter(place => !here(place))];
  return ordered.map((place): Destination => {
    const tool = Boolean(place.to?.tool_id);
    return {
      key: `place:${place.id}`,
      label: place.label,
      icon: tool ? words.tool_icon : place.to?.private ? words.private_icon : place.others_count ? words.space_icon : words.pursuit_icon,
      // The place moved first stands at the top; the rest keep the sidebar's nesting.
      depth: here(place) ? 0 : place.depth ?? 0,
      takesAction: !tool,
      run: async ({ things, note, kept, links, action }) => {
        const items = itemsOf({ things, kept, links }, placeOf);
        // What a tool place is told beside the share: each thing as it was picked, the screen and where it came from.
        const told = tool ? {
          things: things.map(thing => ({
            key: thing.key, kind: thing.kind, label: thing.label,
            ...(thing.screen_label ? { screen_label: thing.screen_label } : {}),
            ...(thing.address ? { address: thing.address } : {}),
            ...(thing.id ? { id: thing.id } : {}),
            ...(placeOf(thing) ? { place: placeOf(thing) as string } : {}),
          })),
          screen: location.href, browser: navigator.userAgent,
          where: current ? placeOf({ context: current } as TrayThing) ?? current.id : words.your_work,
        } : null;
        const result = await (await deviceOutbox()).deliver({
          to: [place.id], items: items.length ? items : [{ kind: 'selection', text: note }], request_key: crypto.randomUUID(),
          from: 'Web', from_agent: 'trillion-web', ...(action ? { action } : {}), ...(note && items.length ? { own_words: note } : {}),
          ...(told ? { input: told } : {}),
        });
        if (result.state === 'kept' || result.answer.queued) return routedWords(result);
        if (result.answer.stopped_at) throw new Error(result.answer.stopped_at.error);
        return tool ? result.answer.delivered?.[0]?.said ?? words.sent_tool : fill(words.sent_place, { place: place.label });
      },
    };
  });
}

/** The time words, read again every minute so "2 min ago" keeps up. */
function useMinute(): number {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

const listingOf = (thing: TrayThing, place: string | null, now: number): Listing => ({
  id: thing.key,
  form: 'row',
  title: thing.label,
  // The icon says what kind of thing it is (design-references/visual-hierarchy rule 10), so the line keeps its room
  // for the name and when it was picked.
  icon: thing.icon ?? words.picked_on_icon,
  ...(thing.picked_at ? { when: relativeWhen(thing.picked_at, now) } : {}),
  ...(thing.screen_label ? { facts: [{ label: words.picked_on, value: thing.screen_label, icon: words.picked_on_icon }] } : {}),
  // The space it was picked in is a name, so it is a chip (design-references/visual-hierarchy rule 2).
  ...(place ? { chips: [{ label: place }] } : {}),
});

function Tray({ choices }: { choices: Choices }) {
  const { things, picking } = useTray(tray);
  const [visibleOffset, setVisibleOffset] = React.useState(0);
  const [dropActive, setDropActive] = React.useState(false);
  const dragDepth = React.useRef(0);
  const now = useMinute();
  // A space's name, from the places the person shares to; a thing picked in a space they cannot share to has none.
  const placeOf = React.useCallback((thing: TrayThing) => (thing.context ? choices.places.find(place => place.to?.space_id === thing.context?.id || place.to?.pursuit_id === thing.context?.id)?.label ?? null : null), [choices.places]);
  const current = [...things].reverse().find(thing => thing.context)?.context ?? null;
  const destinations = React.useMemo(() => destinationsOf(choices, placeOf, current), [choices, placeOf, current?.id]);
  const [chosen, setChosen] = React.useState<string | null>(null);
  const [choosing, setChoosing] = React.useState(false);
  const waiting = useWaitingToSend();
  const dead = useDeadShares();
  const route = React.useMemo(() => routeItself(placeOf), [placeOf]);
  const [action, setAction] = React.useState<string | null>(null);
  const destination = choosing ? destinations.find(one => one.key === chosen) ?? destinations[0] : route;
  const [incoming, setIncoming] = React.useState<ComposerProps['incoming']>(null);
  const pageSize = settings.page_size;
  const shownFrom = Math.min(visibleOffset, Math.floor(Math.max(0, things.length - 1) / pageSize) * pageSize);
  const shownThings = React.useMemo(() => things.slice(shownFrom, shownFrom + pageSize), [things, shownFrom, pageSize]);
  const byKey = React.useMemo(() => new Map(shownThings.map(thing => [thing.key, thing])), [shownThings]);
  const listings = React.useMemo(() => shownThings.map(thing => listingOf(thing, placeOf(thing), now)), [shownThings, placeOf, now]);
  React.useEffect(() => { if (!things.length) setVisibleOffset(0); }, [things.length]);

  const shareByLink = () => {
    const overlong = things.find(thing => (shareItemOf(thing)?.text?.length ?? 0) > 20000);
    if (overlong) { notify(fill(words.link_text_too_long, { name: overlong.label }), { kind: 'error' }); return; }
    const unsupported = things.find(thing => !shareItemOf(thing));
    if (unsupported) { notify(fill(words.link_needs_share_value, { name: unsupported.label }), { kind: 'error' }); return; }
    const unique = shareItemsOf(things);
    if (!unique.length) { notify(words.link_nothing, { kind: 'error' }); return; }
    const first = unique[0];
    openSharing(first.record ?? first.code ?? first.url ?? first.text ?? 'selection', { title: unique.length === 1 ? first.title : fill(words.link_title_many, { count: String(unique.length) }), items: unique, anchor: document.activeElement });
  };

  const send = async (draft: ComposerDraft): Promise<string> => {
    if (!destination) throw new Error(words.load_failed);
    try {
      const files = draft.files.filter(file => file.size > 0);
      const kept = files.length ? (await uploadFiles(files, settings.picture_folder)).map((file, index) => ({ identity: file.identity, name: files[index].name, picture: files[index].type.startsWith('image/') })) : [];
      const said = await destination.run({ things, note: draft.text, kept, links: draft.links, action: destination.takesAction ? action : null });
      tray.clear(); setVisibleOffset(0);
      return said;
    } catch (error) {
      throw new Error(reasonOf(error));
    }
  };

  const picker: ComposerPicker = {
    id: 'send-to', label: words.send_to, icon: words.send_to_icon, many: false,
    options: destinations.map(one => ({ value: one.key, label: one.label, icon: one.icon, depth: one.depth })),
    chosen: destination ? [destination.key] : [],
    onChange: ([key]) => setChosen(key ?? null),
  };

  const dragEnter = (event: React.DragEvent) => {
    if (!hasSelectedRecordDragData(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    dragDepth.current += 1;
    setDropActive(true);
  };
  const dragLeave = (event: React.DragEvent) => {
    if (!hasSelectedRecordDragData(event.dataTransfer)) return;
    event.stopPropagation();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (!dragDepth.current) setDropActive(false);
  };
  const dragOver = (event: React.DragEvent) => {
    if (!hasSelectedRecordDragData(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'copy';
  };
  const drop = (event: React.DragEvent) => {
    if (!hasSelectedRecordDragData(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    dragDepth.current = 0;
    setDropActive(false);
    const picked = readSelectedRecordDragData(event.dataTransfer);
    if (!picked) return;
    const added = addDraggedRecordsToTray(picked);
    notify(added ? words.added : words.already_added);
  };

  return (
    <Container layout="vertical" height="full" minHeight="0" data-tray-screen="" data-accepts-selected-records="" data-tray-drop-active={dropActive ? '' : undefined}
      onDragEnter={dragEnter} onDragLeave={dragLeave} onDragOver={dragOver} onDrop={drop}>
      <Container layout="vertical" gap="md" padding="lg" flex="1" minHeight="0" overflow="y-auto">
        <Container layout="horizontal" gap="sm" alignItems="center" justifyContent="between" wrap>
          <Container layout="vertical" gap="xs" minWidth="0">
            <Text variant="title">{words.title}</Text>
            <Text variant="caption" color="muted" role="status">
              {dropActive ? words.drop_hint : picking ? words.picking_hint : things.length ? fill(words.count, { count: String(things.length) }) : words.lead}
            </Text>
          </Container>
          <Container layout="horizontal" gap="xs" alignItems="center">
            <Button variant={picking ? 'primary' : 'secondary'} size="sm" aria-pressed={picking} onClick={() => tray.setPicking(!picking)} data-tray-pick="">
              <NamedIcon name={picking ? 'Check' : 'MousePointerClick'} size="sm" />
              {picking ? words.picking : words.pick}
            </Button>
            {things.length ? (
              <ActionMenu
                label={words.more}
                items={[
                  { id: 'share-link', label: words.share_link, icon: words.share_link_icon },
                  { id: 'clear', label: words.clear, icon: words.clear_icon, tone: 'destructive' },
                ]}
                onAction={id => { if (id === 'share-link') shareByLink(); else { tray.clear(); setVisibleOffset(0); } }}
              />
            ) : null}
          </Container>
        </Container>
        {listings.length ? <Text variant="label" color="muted">{words.sending}</Text> : null}
        {listings.length ? (
          <ListingGrid
            label={words.things}
            listings={listings}
            onOpen={key => { const row = screenRowOf(byKey.get(key)?.screen); if (row) openScreen(row); }}
            controls={listing => (
              <Button variant="ghost" size="icon" aria-label={fill(words.remove, { name: listing.title })} onClick={() => tray.remove(listing.id)} data-tray-remove="">
                <NamedIcon name="X" size="sm" />
              </Button>
            )}
          />
        ) : (
          <ScreenState state={{
            status: 'empty', icon: words.empty_icon, title: words.empty_title, description: words.empty_body,
            ...(picking ? {} : { action: { label: words.pick, run: () => tray.setPicking(true) } }),
          }} />
        )}
        {things.length > pageSize ? (
          <Container layout="horizontal" gap="sm" alignItems="center" justifyContent="between" wrap data-tray-pages="">
            <Button variant="ghost" size="sm" disabled={shownFrom === 0} onClick={() => setVisibleOffset(Math.max(0, shownFrom - pageSize))}>{words.previous}</Button>
            <Text variant="caption" color="muted">{fill(words.showing, { first: String(shownFrom + 1), last: String(shownFrom + shownThings.length), count: String(things.length) })}</Text>
            <Button variant="ghost" size="sm" disabled={shownFrom + shownThings.length >= things.length} onClick={() => setVisibleOffset(shownFrom + pageSize)}>{words.next}</Button>
          </Container>
        ) : null}
        {dead.letters.length ? (
          <Container layout="vertical" gap="xs" data-tray-dead="">
            <Text variant="caption" color="muted">{words.dead_title}</Text>
            {dead.letters.map(letter => (
              <Container key={letter.request_key} layout="horizontal" gap="sm" alignItems="center" justifyContent="between" data-tray-dead-letter={letter.request_key}>
                <Text variant="caption">{fill(words.dead_one, { said: letter.said })}</Text>
                <Container layout="horizontal" gap="xs" alignItems="center">
                  <Button variant="secondary" size="sm" onClick={() => { return dead.sendAgain(letter.request_key).then(() => notify(words.dead_sent, { kind: 'done' }), error => { notify(reasonOf(error), { kind: 'error' }); throw error; }); }}>{words.dead_again}</Button>
                  <Button variant="ghost" size="sm" onClick={() => { return dead.discard(letter.request_key); }}>{words.dead_discard}</Button>
                </Container>
              </Container>
            ))}
          </Container>
        ) : null}
        {/* The same sections, in the same order, as the Send to Trillion popup and the iPhone sheet: what is being sent,
            Add to it, Send to, what the AI should do, the note and Send. */}
        <Composer
          onSend={send}
          waysShown
          words={settings.composer}
          pickers={pickersBehind([picker, ...(destination?.takesAction ? [actionPicker(choices, action, setAction)] : [])], choosing, () => setChoosing(open => !open), waiting)}
          carries={things.length > 0}
          incoming={incoming}
          actions={canTakePicture() ? [{ id: 'picture', label: words.picture, icon: words.picture_icon }] : []}
          onAction={id => {
            if (id !== 'picture') return;
            takePicture().then(file => setIncoming({ id: crypto.randomUUID(), files: [file] }), error => notify(fill(words.picture_failed, { reason: reasonOf(error) }), { kind: 'error' }));
          }}
        />
      </Container>
    </Container>
  );
}

/** Your tray, once where it can go has been read. */
function TrayLoad() {
  const loaded = useScreenLoad('tray', { loading: { label: words.loading, layout: 'rows' }, read: readChoices, failed: refusal(words.load_failed) });
  if (loaded.state) return <ScreenState state={loaded.state} />;
  return <Tray choices={loaded.value} />;
}

export function mountTrayScreen(element: HTMLElement): () => void {
  return mountReactSurface(element, <TrayLoad />);
}
