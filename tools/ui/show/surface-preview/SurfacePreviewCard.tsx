// packages/ui/show/surface-preview/SurfacePreviewCard.tsx
//
// PURPOSE
// A hover preview of any screen. Resting the pointer on a trigger (a navigation
// row, a rail icon, a project row) opens one card with
//   - a heading that opens the screen, exactly like clicking the trigger;
//   - a live look at it: either another screen mounted small (`preview`), or a
//     glance read from DATA (`glance`: count, last change, in progress, recent);
//   - its most useful actions as buttons.
// The card stays open while the pointer travels into it and while it is inside.
//
// NON-NEGOTIABLE INVARIANTS
// 1. Blind: which screen is previewed, what its glance reads and which actions
//    it offers are DATA handed in. This file never names a screen.
// 2. Hover intent and the safe triangle come from Base UI PreviewCard (its
//    trigger uses floating-ui `safePolygon`), so a diagonal move from the
//    trigger to the card never closes it and a quick pass never opens it.
// 3. The glance loads when the card opens, never before and never on a timer.
// 4. Desktop pointer hover previews the screen; phone touch opens the same
//    preview in the shared sheet. Keyboard keeps the trigger's own click.
// 5. Appearance lives in screen-look/show/navigation-preview.css.
// 6. Every listed thing is a row of the shared listing shape. A row its DATA
//    declares is worked from the card: pressing it opens the thing, its
//    buttons act on it, and its arrow looks inside it in this same card, with
//    Back, to any depth. Closing the card forgets how deep it went.
//
// References: 21st.dev #11873 "Hover Card" by jshguo (open/close delay,
// side/align placement, fade + zoom-in from the trigger side) and #221 shadcn
// "Hover Card"; Mobbin Tana sidebar flyout (sections of recent items with
// times), Basecamp project summary (counts and latest activity), Mintlify
// project card (status line plus one primary action). Original code over Base
// UI PreviewCard.

import React from 'react';
import {PreviewCard} from '@base-ui/react/preview-card';
import {ArrowLeft, ArrowUpRight, ChevronRight, X} from 'lucide-react';
import {NamedIcon} from '../icon/NamedIcon';
import {Button} from '../coss/ui/button';
import {Skeleton} from '../shadcn/skeleton';
import {PlaceableSurfaceHost} from '../placeable-surface-host/PlaceableSurfaceHost';
import {LAYER_ORDER} from '../layer-order/layer-order';
import {safeEdgePadding} from '../visible-viewport/safe-area-insets';
import {loadGlance, runSurfaceAction, type Glance, type GlanceDeclaration, type GlanceItem} from './surface-glance';
import type {Listing} from '../listing-card';
// A glance's cards (with every provider's mark) are fetched the first time a preview is asked to open, and the card
// opens once they are here, so it is drawn whole and never grows under the resting pointer.
let ListingCard: typeof import('../listing-card').ListingCard | null = null;
const loadListingCard = () => import('../listing-card').then(module => { ListingCard = module.ListingCard; });
import {relativeWhen} from '../relative-time/relative-time';
import {PhoneSheetGrip, phoneSheetPositioner, phoneSheetSurface, usePhoneSheet} from '../phone-sheet/phone-sheet';
import {cardShown} from '../hover-preview/card-shown';
import {useShowChange} from '../show-rules/show-of';

/** Another screen mounted small inside the card. */
export interface SurfacePreview {
  label: string;
  icon?: string;
  packageEntry: {packageName: string; entryName: string};
  materialTarget?: string | null;
  target?: string | null;
  surfaceInput?: Record<string, unknown>;
}

/** One button in the card. */
export interface SurfacePreviewAction {
  id: string;
  label: string;
  icon: string;
  onAction: () => void;
}

export interface SurfacePreviewCardProps {
  /** The trigger's own name and icon, shown in the heading. */
  label: string;
  icon?: string;
  /** The element that opens the card on hover; rendered as the trigger. */
  trigger: React.ReactElement<Record<string, unknown>>;
  /** Opens the item (the same thing clicking the trigger does). */
  onOpen: () => void;
  /** A screen to mount small; wins over `glance`. */
  preview?: SurfacePreview;
  /** What to read for the live look, from the item's DATA. */
  glance?: GlanceDeclaration;
  /** Values for `{name}` placeholders in the glance source. */
  glanceParams?: Record<string, string>;
  /** Shown when there is no glance, or it has nothing to say. */
  description?: string;
  /** When the person last opened this item (ms), for the fallback line. */
  lastOpenedAt?: number;
  actions?: readonly SurfacePreviewAction[];
  /** A note left on the item (what someone, such as the person's AI, wants done there), shown above the look at it. */
  note?: {message: string; by?: string};
  side?: 'top' | 'right' | 'bottom' | 'left';
  align?: 'start' | 'center' | 'end';
  /** Milliseconds the pointer rests before the card opens. */
  delay?: number;
  closeDelay?: number;
  /** The card's control, `cards.hover.<surface>` (hover-preview/card-shown.ts); a show rule hiding it leaves the trigger alone. */
  control?: string;
}

const sentence = (text: string) => text.charAt(0).toLocaleUpperCase() + text.slice(1);

type GlanceState = {state: 'loading'} | {state: 'ready'; glance: Glance} | {state: 'failed'};
// A sidebar glance should answer quickly; the full screen remains available if
// its summary source is slow. Four seconds leaves room for a local cold read
// without keeping a small hover card in a loading state for an entire minute.
const GLANCE_DEADLINE_MS = 4000;

function useGlance(glance: GlanceDeclaration | undefined, params: Record<string, string> | undefined, retry: number): GlanceState | null {
  const [state, setState] = React.useState<GlanceState | null>(glance ? {state: 'loading'} : null);
  const key = glance ? JSON.stringify([glance, params ?? {}]) : '';
  React.useEffect(() => {
    if (!glance) { setState(null); return undefined; }
    const controller = new AbortController();
    const deadline = window.setTimeout(() => { controller.abort(); setState({state: 'failed'}); }, GLANCE_DEADLINE_MS);
    setState({state: 'loading'});
    loadGlance(glance, params ?? {}, fetch, controller.signal)
      .then((value) => { window.clearTimeout(deadline); if (!controller.signal.aborted) setState({state: 'ready', glance: value}); })
      .catch(() => { window.clearTimeout(deadline); if (!controller.signal.aborted) setState({state: 'failed'}); });
    return () => { window.clearTimeout(deadline); controller.abort(); };
    // The key captures both inputs by value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, retry]);
  return state;
}

/** Looking inside a listed thing: its name and the glance read for it, filled from its values. */
interface Inside {title: string; glance: GlanceDeclaration; params: Record<string, string>}

// The listing fields a row's DATA may fill; each is words or a name, never a structure.
const ROW_FIELDS = ['icon', 'picture', 'tone', 'byline', 'text', 'value', 'unit'] as const;

/** One listed thing as a row of the shared listing shape. With DATA it opens on press, acts through its buttons and
 *  looks inside through its arrow; without, it is a row to read. */
function GlanceItemRow({title, detail, time, progress, item, slot, onWorked, onDrill}: {
  title: string; detail?: string; time?: number; progress?: number | null; item?: GlanceItem; slot: string;
  onWorked: () => void; onDrill: (inside: Inside) => void;
}) {
  const fields = item?.fields ?? {};
  const listing: Listing = {id: title, title, form: 'row'};
  for (const field of ROW_FIELDS) if (fields[field]) (listing as Record<string, unknown>)[field] = fields[field];
  if (time !== undefined) listing.when = relativeWhen(time);
  if (detail && !listing.text) listing[time !== undefined ? 'text' : 'when'] = detail;
  if (progress !== undefined) listing.progress = progress;
  const open = item?.open;
  const controls = item && (item.actions.length || item.drill) ? (
    <span className="surface-glance-item-controls">
      {item.actions.map((action) => (
        <Button key={action.id} type="button" variant="ghost" size="icon-xs" data-action-id={action.id} aria-label={action.label} title={action.label}
          onClick={() => { if (runSurfaceAction(action)) onWorked(); }}>
          <NamedIcon name={action.icon} size="sm" />
        </Button>
      ))}
      {item.drill ? (
        <Button type="button" variant="ghost" size="icon-xs" data-glance-drill="" aria-label={`Look inside ${title}`} title="Look inside"
          onClick={() => onDrill({title, glance: item.drill!, params: item.values})}>
          <ChevronRight aria-hidden="true" />
        </Button>
      ) : null}
    </span>
  ) : undefined;
  return (
    <div className="surface-glance-item" data-slot={slot} data-glance-item={item ? '' : undefined}>
      {ListingCard ? (
        <ListingCard listing={listing} controls={controls}
          onOpen={open ? () => { if (runSurfaceAction({event: open})) onWorked(); } : undefined} />
      ) : null}
    </div>
  );
}

function GlanceBody({glance, params, description, lastOpenedAt, nested = false, onWorked, onDrill}: {
  glance?: GlanceDeclaration; params?: Record<string, string>; description?: string; lastOpenedAt?: number; nested?: boolean;
  onWorked: () => void; onDrill: (inside: Inside) => void;
}) {
  const [retry, setRetry] = React.useState(0);
  const state = useGlance(glance, params, retry);
  const facts: string[] = [];
  const ready = state?.state === 'ready' ? state.glance : null;
  if (ready?.count) facts.push(ready.count.label);
  if (ready?.updatedAt !== undefined) facts.push(`changed ${relativeWhen(ready.updatedAt, Date.now(), {inSentence: true})}`);
  if (!nested && !ready?.count && ready?.updatedAt === undefined) facts.push(lastOpenedAt ? `opened ${relativeWhen(lastOpenedAt, Date.now(), {inSentence: true})}` : 'not opened yet');
  return (
    <div className="surface-glance" data-slot="surface-glance" data-state={state?.state ?? 'none'}>
      {state?.state === 'loading' ? (
        <div className="surface-glance-loading" role="status" aria-label="Loading summary" aria-busy="true">
          <Skeleton className="surface-glance-skeleton-title" />
          <Skeleton className="surface-glance-skeleton-detail" />
        </div>
      ) : null}
      {state?.state === 'failed' ? <div className="surface-glance-retry"><p className="surface-glance-summary" role="status">Summary unavailable.</p><Button type="button" variant="ghost" size="xs" onClick={() => setRetry(value => value + 1)}>Try again</Button></div> : null}
      {state?.state !== 'loading' && state?.state !== 'failed' && facts.length ? <p className="surface-glance-summary" data-slot="surface-glance-summary">{sentence(facts.join(' · '))}</p> : null}
      {description && !ready?.recent.length && !ready?.inProgress.length ? <p className="surface-glance-description">{description}</p> : null}
      {ready?.inProgress.length ? (
        <section className="surface-glance-group" aria-label="In progress">
          <h3 className="surface-glance-label"><span className="surface-glance-live" aria-hidden="true" />In progress</h3>
          <div className="surface-glance-list">
            {ready.inProgress.slice(0, 3).map((work, index) => (
              <GlanceItemRow key={`${work.title}-${index}`} title={work.title} progress={work.progress} item={work.item} slot="surface-glance-work" onWorked={onWorked} onDrill={onDrill} />
            ))}
          </div>
        </section>
      ) : null}
      {ready?.recent.length ? (
        <section className="surface-glance-group" aria-label="Recent">
          <h3 className="surface-glance-label">Recent</h3>
          <div className="surface-glance-list">
            {ready.recent.map((row, index) => (
              <GlanceItemRow key={`${row.title}-${index}`} title={row.title} detail={row.detail} time={row.time} item={row.item} slot="surface-glance-recent" onWorked={onWorked} onDrill={onDrill} />
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

export function SurfacePreviewCard({
  label, icon, trigger, onOpen, preview, glance, glanceParams, description, lastOpenedAt, actions = [], note,
  side = 'right', align = 'start', delay = 350, closeDelay = 180, control,
}: SurfacePreviewCardProps) {
  useShowChange();
  return cardShown(control) ? <ShownSurfacePreviewCard {...{label, icon, trigger, onOpen, preview, glance, glanceParams, description, lastOpenedAt, actions, note, side, align, delay, closeDelay}} /> : trigger;
}

function ShownSurfacePreviewCard({
  label, icon, trigger, onOpen, preview, glance, glanceParams, description, lastOpenedAt, actions = [], note,
  side = 'right', align = 'start', delay = 350, closeDelay = 180,
}: SurfacePreviewCardProps) {
  const [open, setOpen] = React.useState(false);
  const [inside, setInside] = React.useState<Inside[]>([]);
  const phoneSheet = usePhoneSheet();
  const touchOpenedAt = React.useRef(0);
  // Asked to open, the card waits for its rows' code (once per page), then opens unless the pointer left meanwhile.
  const wanted = React.useRef(false);
  const onOpenChange = React.useCallback((next: boolean) => {
    wanted.current = next;
    if (!next) { setOpen(false); setInside([]); return; }
    if (ListingCard) { setOpen(true); return; }
    void loadListingCard().finally(() => { if (wanted.current) setOpen(true); });
  }, []);
  // Something done from a row (opening it, or one of its buttons taken by the app) closes the card, as clicking the
  // trigger would.
  const onWorked = React.useCallback(() => onOpenChange(false), [onOpenChange]);
  const onDrill = React.useCallback((next: Inside) => setInside((stack) => [...stack, next]), []);
  const deepest = inside[inside.length - 1];
  return (
    <PreviewCard.Root open={open} onOpenChange={onOpenChange}>
      <span
        style={{display: 'contents'}}
        onPointerDownCapture={(event) => {
          if (!phoneSheet || event.pointerType !== 'touch') return;
          touchOpenedAt.current = Date.now();
          onOpenChange(!wanted.current);
        }}
        onClickCapture={(event) => {
          if (!touchOpenedAt.current || Date.now() - touchOpenedAt.current > 1000) return;
          touchOpenedAt.current = 0;
          event.preventDefault();
          event.stopPropagation();
        }}
      >
        <PreviewCard.Trigger render={trigger} delay={delay} closeDelay={closeDelay} />
      </span>
      <PreviewCard.Portal>
        {phoneSheet ? <PreviewCard.Backdrop className="phone-sheet-backdrop" style={{zIndex: LAYER_ORDER.menu}} /> : null}
        <PreviewCard.Positioner side={side} align={align} sideOffset={10} collisionPadding={safeEdgePadding(12)}
          className="surface-preview-positioner" style={{zIndex: LAYER_ORDER.menu}} {...phoneSheetPositioner(phoneSheet)}>
          <PreviewCard.Popup className="coss-ui surface-preview" data-slot="surface-preview" data-mode={preview ? 'screen' : 'glance'} {...phoneSheetSurface(phoneSheet)}>
            {phoneSheet ? <PhoneSheetGrip /> : null}
            <div className="surface-preview-heading" data-slot="surface-preview-heading">
              <Button type="button" variant="ghost" size="sm" className="surface-preview-open" data-slot="surface-preview-open" onClick={() => { onOpen(); onWorked(); }}
                aria-label={`Open ${label}`}>
                {icon ? <NamedIcon name={icon} size="sm" /> : null}
                <span className="surface-preview-label">{label}</span>
                <ArrowUpRight aria-hidden="true" className="surface-preview-open-mark" />
              </Button>
              {phoneSheet ? <Button type="button" variant="ghost" size="icon-xs" className="surface-preview-dismiss" aria-label="Close preview" onClick={() => onOpenChange(false)}><X /></Button> : null}
            </div>
            {note ? (
              <div className="surface-preview-note" data-slot="surface-preview-note" role="note">
                {note.by ? <span className="surface-preview-note-by">{note.by}</span> : null}
                <p className="surface-preview-note-message">{note.message}</p>
              </div>
            ) : null}
            <div className="surface-preview-body" data-slot="surface-preview-body">
              {preview ? (
                <PlaceableSurfaceHost
                  packageName={preview.packageEntry.packageName}
                  entryName={preview.packageEntry.entryName}
                  materialTarget={preview.materialTarget ?? null}
                  target={preview.target ?? null}
                  surfaceInput={preview.surfaceInput}
                  fill
                />
              ) : deepest ? (
                <div className="surface-glance-inside" data-slot="surface-glance-inside">
                  <div className="surface-glance-inside-heading">
                    <Button type="button" variant="ghost" size="xs" data-glance-back="" onClick={() => setInside((stack) => stack.slice(0, -1))}>
                      <ArrowLeft aria-hidden="true" />Back
                    </Button>
                    <span className="surface-glance-inside-title">{deepest.title}</span>
                  </div>
                  <GlanceBody key={inside.length} nested glance={deepest.glance} params={deepest.params} onWorked={onWorked} onDrill={onDrill} />
                </div>
              ) : (
                <GlanceBody glance={glance} params={glanceParams} description={description} lastOpenedAt={lastOpenedAt} onWorked={onWorked} onDrill={onDrill} />
              )}
            </div>
            {actions.length ? (
              <div className="surface-preview-actions" data-slot="surface-preview-actions">
                {actions.map((action) => (
                  <Button key={action.id} type="button" variant="ghost" size="xs" data-action-id={action.id} onClick={() => { action.onAction(); onWorked(); }}>
                    <NamedIcon name={action.icon} size="sm" />{action.label}
                  </Button>
                ))}
              </div>
            ) : null}
          </PreviewCard.Popup>
        </PreviewCard.Positioner>
      </PreviewCard.Portal>
    </PreviewCard.Root>
  );
}
