// packages/guided-overlay/show/default-content-renderers.tsx
//
// The DEFAULT content renderers guided-overlay ships for the common `content_kind`
// values (text | interactive-gate | outcome | composition-scene | placeable-surface | glance | picture).
// They are registered INTO the blind `StepContentRegistry` — the surface never
// branches on `content_kind`. Heavier kinds (media → media-playback, quiz → forms
// inputs) are registered by whoever wires those packages at the composition site;
// the registry stays open (L069), so adding one is one `register()` + zero surface
// change.
//
// Each renderer owns its `payload` shape and reads it defensively (opaque DATA).
// Composed only from shared `ui` primitives (Text/Container) — no raw HTML (L065).

import { useEffect, useRef, type ReactElement } from 'react';
import { watchScrollFade } from '../../ui/show/scrollable-surface/scroll-fade';
import { useBitfieldData } from '#workspace-records';
import { PlaceableSurfaceHost } from '../../ui/show/placeable-surface-host/PlaceableSurfaceHost';
import { Text } from '../../ui/show/text/Text';
import { Container } from '../../ui/show/container/container';
import { Button } from '../../ui/show/button/Button';
import { ImageBlock } from '../../ui/show/image-block/ImageBlock';
import defaults from 'trillion-workshop/tools/tours-screen/guided-overlay-defaults.json';
import { GlanceContent } from './glance-content';
import {
  registerStepContentRenderers,
  type StepContentRegistry,
} from '../../ui/show/step-content-renderer/step-content-renderer';
import type {
  StepContentComponent,
  StepContentProps,
} from '../../ui/show/step-content-renderer/StepContent';

/** Read a string field from an opaque payload (empty string when absent). */
function str(payload: Readonly<Record<string, unknown>>, key: string): string {
  const v = payload[key];
  return typeof v === 'string' ? v : '';
}

/** Title + body — the plain coachmark. */
function TextContent({ payload }: StepContentProps): ReactElement {
  return (
    <Container layout="vertical" gap="xs">
      {str(payload, 'title') && (
        <Text variant="heading" data-walkthrough-copy="title">{str(payload, 'title')}</Text>
      )}
      {str(payload, 'body') && (
        <Text variant="body" data-walkthrough-copy="body">{str(payload, 'body')}</Text>
      )}
    </Container>
  );
}

/** One picture of the step above its title and words (payload.picture: { src, alt }), such as a screenshot of what to tap. */
function PictureContent({ payload }: StepContentProps): ReactElement {
  const picture = plain(payload.picture) ? payload.picture : {};
  const src = typeof picture.src === 'string' ? picture.src : '';
  return (
    <Container layout="vertical" gap="sm">
      {src && (
        <ImageBlock src={src} alt={typeof picture.alt === 'string' ? picture.alt : ''} maxHeight={`${defaults.picture.max_height_px}px`} data-walkthrough-picture="" />
      )}
      {str(payload, 'title') && (
        <Text variant="heading" data-walkthrough-copy="title">{str(payload, 'title')}</Text>
      )}
      {str(payload, 'body') && (
        <Text variant="body" data-walkthrough-copy="body">{str(payload, 'body')}</Text>
      )}
    </Container>
  );
}

/** Title + body + an optional gesture hint (e.g. "tap"). Pairs with a live cutout. */
function InteractiveGateContent({ payload }: StepContentProps): ReactElement {
  const hint = str(payload, 'gesture_hint');
  return (
    <Container layout="vertical" gap="xs">
      {str(payload, 'title') && (
        <Text variant="heading" data-walkthrough-copy="title">{str(payload, 'title')}</Text>
      )}
      {str(payload, 'body') && (
        <Text variant="body" data-walkthrough-copy="body">{str(payload, 'body')}</Text>
      )}
      {hint && (
        <Text variant="label" color="accent">
          {hint}
        </Text>
      )}
    </Container>
  );
}

export const WALKTHROUGH_ANSWER_EVENT = 'bitfield:walkthrough-answer';
/** An option's `act` ({ do, text, within? }, do-work/act-on-target.ts), run by the surface on the step's target. */
export const WALKTHROUGH_ACT_EVENT = 'bitfield:walkthrough-act';

type SingleChoiceOption = {
  readonly value: string;
  readonly label: string;
  readonly detail?: string;
  /** Done on the step's control when chosen, in place of answering (do-work/act-on-target.ts StepAct). */
  readonly act?: Record<string, unknown>;
};

/**
 * Generic one-of-many answer capture. Values and routes remain walkthrough DATA;
 * this renderer only emits the selected opaque value to the active surface.
 */
function SingleChoiceContent({ payload }: StepContentProps): ReactElement {
  const options = Array.isArray(payload.options)
    ? payload.options.filter((value): value is SingleChoiceOption => {
        if (!plain(value)) return false;
        return typeof value.value === 'string' && typeof value.label === 'string';
      })
    : [];
  // An option carrying an `act` does it on the step's own control (puts its words into the box the step points at) and
  // leaves the step where it is, so the person can try each; any other option answers the step's question.
  const choose = (option: SingleChoiceOption) => {
    if (plain(option.act)) window.dispatchEvent(new CustomEvent(WALKTHROUGH_ACT_EVENT, { detail: { act: option.act } }));
    else window.dispatchEvent(new CustomEvent(WALKTHROUGH_ANSWER_EVENT, { detail: { answer: option.value } }));
  };
  return (
    <Container layout="vertical" gap="md">
      {str(payload, 'title') && (
        <Text variant="heading" data-walkthrough-copy="title">{str(payload, 'title')}</Text>
      )}
      {str(payload, 'body') && (
        <Text variant="body" data-walkthrough-copy="body">{str(payload, 'body')}</Text>
      )}
      <Container layout="vertical" gap="sm">
        {options.map((option) => (
          <Container key={option.value} layout="vertical" gap="xs">
            <Button variant="secondary" size="sm" data-walkthrough-option={option.value} onClick={() => choose(option)}>
              {option.label}
            </Button>
            {option.detail ? <Text variant="body" color="muted">{option.detail}</Text> : null}
          </Container>
        ))}
      </Container>
    </Container>
  );
}

/** Affirmation / completion step — no target. */
function OutcomeContent({ payload }: StepContentProps): ReactElement {
  return (
    <Container layout="vertical" gap="xs">
      {str(payload, 'title') && (
        <Text variant="heading" data-walkthrough-copy="title">{str(payload, 'title')}</Text>
      )}
      {str(payload, 'body') && (
        <Text variant="body" data-walkthrough-copy="body">{str(payload, 'body')}</Text>
      )}
    </Container>
  );
}

type PlaceableSurfaceContentRef = {
  readonly packageName: string;
  readonly entryName: string;
};

type CompositionSceneContentRef = {
  readonly packageName: string;
  readonly sceneId: string;
};

export const CONTENT_MOUNT_REQUEST_SCHEMA = 'guided-overlay.content-mount-request/v1';
export const CONTENT_MOUNT_STATE_SCHEMA = 'guided-overlay.content-mount-state/v1';
export const COMPOSITION_SCENE_MOUNT_STATE_SCHEMA = 'guided-overlay.composition-scene-mount-state/v1';

export interface PlaceableSurfaceContentMountState {
  readonly schema: typeof CONTENT_MOUNT_STATE_SCHEMA;
  readonly status: 'ready' | 'missing';
  readonly content_ref: unknown;
  readonly package_name?: string;
  readonly entry_name?: string;
  readonly surface_input?: Readonly<Record<string, unknown>>;
}

function plain(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function readPlaceableSurfaceById(records: unknown, surfaceId: unknown): PlaceableSurfaceContentMountState | null {
  if (!Array.isArray(records) || typeof surfaceId !== 'string' || surfaceId.length === 0) return null;
  for (const row of records) {
    const payload = plain(row) && plain(row.payload) ? row.payload : row;
    if (!plain(payload) || payload.kind !== 'placeable-surface') continue;
    const id = typeof payload.id === 'string' ? payload.id : payload.surface_id;
    if (id !== surfaceId) continue;
    const entry = plain(payload.package_entry) ? payload.package_entry : payload.packageEntry;
    if (!plain(entry)) return null;
    const packageName = typeof entry.package_name === 'string' ? entry.package_name : entry.packageName;
    const entryName = typeof entry.entry_name === 'string' ? entry.entry_name : entry.entryName;
    if (typeof packageName !== 'string' || typeof entryName !== 'string') return null;
    const surfaceInput = plain(payload.surface_input) ? payload.surface_input : payload.surfaceInput;
    return {
      schema: CONTENT_MOUNT_STATE_SCHEMA,
      status: 'ready',
      content_ref: surfaceId,
      package_name: packageName,
      entry_name: entryName,
      ...(plain(surfaceInput) ? { surface_input: surfaceInput } : {}),
    };
  }
  return null;
}

export interface CompositionSceneContentMountState {
  readonly schema: typeof COMPOSITION_SCENE_MOUNT_STATE_SCHEMA;
  readonly status: 'ready' | 'missing';
  readonly content_ref: unknown;
  readonly package_name?: string;
  readonly scene_id?: string;
  readonly partition_label?: string;
}

/** Decode only the generic address grammar. The referenced package and entry remain opaque. */
export function readPlaceableSurfaceContentRef(value: unknown): PlaceableSurfaceContentRef | null {
  if (typeof value !== 'string') return null;
  const parts = value.split('::');
  if (parts.length !== 4 || parts[0] !== 'package' || parts[2] !== 'placeable-surface') return null;
  const packageName = parts[1]?.trim();
  const entryName = parts[3]?.trim();
  return packageName && entryName ? { packageName, entryName } : null;
}

export function readCompositionSceneContentRef(value: unknown): CompositionSceneContentRef | null {
  if (typeof value !== 'string') return null;
  const parts = value.split('::');
  if (parts.length !== 4 || parts[0] !== 'package' || parts[2] !== 'composition-scene') return null;
  const packageName = parts[1]?.trim();
  const sceneId = parts[3]?.trim();
  return packageName && sceneId ? { packageName, sceneId } : null;
}

export function placeableSurfaceContentMountState(
  payload: Readonly<Record<string, unknown>>,
): PlaceableSurfaceContentMountState {
  // Legacy content bytes omitted `schema`; both forms intentionally share the
  // same opaque content_ref field so old walkthroughs remain byte-compatible.
  const contentRef = payload.content_ref;
  const ref = readPlaceableSurfaceContentRef(contentRef);
  return ref
    ? {
        schema: CONTENT_MOUNT_STATE_SCHEMA,
        status: 'ready',
        content_ref: contentRef,
        package_name: ref.packageName,
        entry_name: ref.entryName,
      }
    : { schema: CONTENT_MOUNT_STATE_SCHEMA, status: 'missing', content_ref: contentRef };
}

export function compositionSceneContentMountState(
  payload: Readonly<Record<string, unknown>>,
): CompositionSceneContentMountState {
  const contentRef = payload.content_ref;
  const ref = readCompositionSceneContentRef(contentRef);
  const partitionLabel = str(payload, 'partition_label');
  return ref && partitionLabel
    ? {
        schema: COMPOSITION_SCENE_MOUNT_STATE_SCHEMA,
        status: 'ready',
        content_ref: contentRef,
        package_name: ref.packageName,
        scene_id: ref.sceneId,
        partition_label: partitionLabel,
      }
    : { schema: COMPOSITION_SCENE_MOUNT_STATE_SCHEMA, status: 'missing', content_ref: contentRef };
}

/** A screen shown inside a tour card gets a bounded height, so the screen scrolls inside its own frame and the card's
 *  progress and buttons stay in view under it. Unbounded, the screen's own scroll containers (overscroll contained)
 *  never overflowed, so a wheel or a finger over the card scrolled nothing and Next sat below the window. */
function SurfaceFrame({ children }: { children: ReactElement }): ReactElement {
  const frame = useRef<HTMLDivElement | null>(null);
  useScrollEdgesWithin(frame);
  return (
    <Container ref={frame} layout="vertical" className="h-[min(44rem,calc(100dvh-12rem))] min-h-0 w-full" data-walkthrough-surface="">{children}</Container>
  );
}

/** The screen a card hosts scrolls inside its own frame; where its words run past the frame they fade out with the
 *  shared scroll edge (ui/show/scrollable-surface, appearance in screen-look scroll-edge-style), never a hard cut and
 *  never a band of its own (2026-10-11: the connect step's words were sliced off above Next). The frame does not know
 *  the screen: it fades whichever container inside it scrolls, found again when the screen redraws. */
function useScrollEdgesWithin(frame: { current: HTMLElement | null }): void {
  useEffect(() => {
    const root = frame.current;
    if (!root) return undefined;
    let watched: HTMLElement | null = null;
    let stop = () => {};
    const scroller = () => [...root.querySelectorAll<HTMLElement>('*')].find(el => el.scrollHeight > el.clientHeight + 1
      && /(auto|scroll)/.test(getComputedStyle(el).overflowY)) ?? null;
    const follow = () => {
      const found = scroller();
      if (found === watched) return;
      stop();
      watched?.classList.remove('bf-scroll-fade');
      watched = found;
      if (!found) { stop = () => {}; return; }
      found.classList.add('bf-scroll-fade');
      stop = watchScrollFade(found, ['top', 'bottom']);
    };
    follow();
    const redraws = new MutationObserver(follow);
    redraws.observe(root, { childList: true, subtree: true });
    const sizes = new ResizeObserver(follow);
    sizes.observe(root);
    return () => { redraws.disconnect(); sizes.disconnect(); stop(); watched?.classList.remove('bf-scroll-fade'); };
  }, [frame]);
}

/** Generic delegated surface content. No package identity or product vocabulary is absorbed here. */
export function PlaceableSurfaceContent({ payload }: StepContentProps): ReactElement {
  const publishedSurfaces = useBitfieldData('placeable-surface-feed');
  const state = readPlaceableSurfaceById(publishedSurfaces, payload.surface_id)
    ?? placeableSurfaceContentMountState(payload);
  if (publishedSurfaces == null && typeof payload.surface_id === 'string'
    && payload.surface_id.trim() && state.status !== 'ready') {
    return <Text variant="body" role="status">Loading…</Text>;
  }
  if (state.status !== 'ready' || !state.package_name || !state.entry_name) {
    return <Text variant="body">This content is not available right now.</Text>;
  }
  const requestedInput = plain(payload.surface_input) ? payload.surface_input : undefined;
  const surfaceInput = state.surface_input || requestedInput
    ? { ...(state.surface_input ?? {}), ...(requestedInput ?? {}) }
    : undefined;
  return (
    <SurfaceFrame>
      <PlaceableSurfaceHost
        packageName={state.package_name}
        entryName={state.entry_name}
        surfaceInput={surfaceInput}
        fill
      />
    </SurfaceFrame>
  );
}

/** Generic addressed composition-scene content. The renderer delegates scene hydration to documents. */
export function CompositionSceneContent({ payload }: StepContentProps): ReactElement {
  const state = compositionSceneContentMountState(payload);
  if (state.status !== 'ready' || !state.partition_label) {
    return <Text variant="body">This content is not available right now.</Text>;
  }
  return (
    <SurfaceFrame>
      <PlaceableSurfaceHost
        packageName="documents"
        entryName="composition-scene"
        surfaceInput={{
          schema: 'composition-scene-input/v1',
          scene_address: String(state.content_ref),
          partition_label: state.partition_label,
          ...(str(payload, 'loading_label') ? { loading_label: str(payload, 'loading_label') } : {}),
          ...(str(payload, 'empty_label') ? { empty_label: str(payload, 'empty_label') } : {}),
          ...(str(payload, 'error_label') ? { error_label: str(payload, 'error_label') } : {}),
        }}
        fill
      />
    </SurfaceFrame>
  );
}

/** A safe fallback for a `content_kind` nobody registered (L083): show whatever copy it carries. */
export const FallbackContent: StepContentComponent = TextContent;

/** Register the default content renderers into a registry. Returns the registry. */
export function registerDefaultContentRenderers(
  registry: StepContentRegistry<StepContentComponent>,
): StepContentRegistry<StepContentComponent> {
  return registerStepContentRenderers(registry, {
    text: TextContent,
    'interactive-gate': InteractiveGateContent,
    outcome: OutcomeContent,
    'single-choice': SingleChoiceContent,
    'composition-scene': CompositionSceneContent,
    'placeable-surface': PlaceableSurfaceContent,
    glance: GlanceContent,
    picture: PictureContent,
  });
}
