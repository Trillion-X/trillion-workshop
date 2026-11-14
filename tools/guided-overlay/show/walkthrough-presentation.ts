import defaults from 'trillion-workshop/tools/tours-screen/guided-overlay-defaults.json';
import { pointerPolicy, type CutoutGeometry, type PointerPolicy } from '../../ui/show/overlay-spotlight/overlay-spotlight';
import type { WalkthroughStep } from '../read-data/walkthrough-eeaf';

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as UnknownRecord : {};
}

function finite(value: unknown, fallback: number, minimum = 0): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum ? value : fallback;
}

function text(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value : fallback;
}

/** Presentation references are owner identities. Shared code passes them through unchanged. */
export function walkthroughPresentationRef(step: Pick<WalkthroughStep, 'presentation_ref'>): unknown {
  return step.presentation_ref;
}

export interface TargetingOptions {
  readonly retryTimeoutMs: number;
  readonly retryIntervalMs: number;
  /** While a step's target stays hidden, how often the step asks again for the screen it opens. */
  readonly reopenEveryMs: number;
  readonly scrollBehavior: ScrollBehavior;
  readonly scrollBlock: ScrollLogicalPosition;
  readonly scrollInline: ScrollLogicalPosition;
}

export interface SpotlightAppearance {
  readonly scrimColor: string;
  /** How much the page outside the spotlight is blurred, in px (0 dims only). */
  readonly blurPx: number;
  readonly ringColor: string;
  readonly ringWidthPx: number;
  readonly ringGlow: string;
  readonly transitionMs: number;
  /** Which page controls take clicks while this spotlight is visible. */
  readonly pointerPolicy: PointerPolicy;
}

export interface CenteredBackdropAppearance {
  readonly enabled: boolean;
  readonly blurPx: number;
  readonly scrimColor: string;
}

/**
 * A targetless card dims and blurs the page behind it, so its words never sit on top of the screen's own words.
 * Step DATA chooses how much (`look.backdrop`); a step that says nothing gets the defaults' `centered_backdrop`, and a
 * step that wants the page left clear says opacity 0 and blur_px 0.
 */
export function resolveCenteredBackdropAppearance(look: unknown): CenteredBackdropAppearance {
  const own = record(look).backdrop;
  const backdrop = own === undefined ? defaults.centered_backdrop : record(own);
  const opacity = Math.min(1, finite(backdrop.opacity, 0));
  const blurPx = Math.min(48, finite(backdrop.blur_px, 0));
  return {
    enabled: opacity > 0 || blurPx > 0,
    blurPx,
    scrimColor: `rgba(0, 0, 0, ${opacity})`,
  };
}

export function resolveTargetingOptions(look: unknown): TargetingOptions {
  const override = record(record(look).targeting);
  const base = defaults.targeting;
  return {
    retryTimeoutMs: finite(override.retry_timeout_ms, base.retry_timeout_ms),
    retryIntervalMs: finite(override.retry_interval_ms, base.retry_interval_ms, 16),
    reopenEveryMs: finite(override.reopen_every_ms, base.reopen_every_ms, 100),
    scrollBehavior: text(override.scroll_behavior, base.scroll_behavior) as ScrollBehavior,
    scrollBlock: text(override.scroll_block, base.scroll_block) as ScrollLogicalPosition,
    scrollInline: text(override.scroll_inline, base.scroll_inline) as ScrollLogicalPosition,
  };
}

export function resolveSpotlightAppearance(look: unknown): SpotlightAppearance {
  const root = record(look);
  const override = record(root.spotlight);
  const base = defaults.spotlight;
  return {
    scrimColor: text(override.scrim_color, base.scrim_color),
    blurPx: Math.min(48, Math.max(0, finite(override.blur_px, base.blur_px))),
    ringColor: text(override.ring_color, base.ring_color),
    ringWidthPx: finite(override.ring_width_px, base.ring_width_px),
    ringGlow: text(override.ring_glow, base.ring_glow),
    transitionMs: finite(override.transition_ms, base.transition_ms),
    pointerPolicy: pointerPolicy(text(override.click_behavior ?? override.pointer_policy, base.click_behavior)),
  };
}

/** Keep a padded hole and its ring visible for targets touching viewport edges. */
export function fitCutoutToViewport(
  cutout: CutoutGeometry,
  viewport: { readonly width: number; readonly height: number },
): CutoutGeometry {
  const x = Math.max(0, cutout.x);
  const y = Math.max(0, cutout.y);
  const right = Math.min(viewport.width, cutout.x + cutout.width);
  const bottom = Math.min(viewport.height, cutout.y + cutout.height);
  const width = Math.max(0, right - x);
  const height = Math.max(0, bottom - y);
  return {
    x,
    y,
    width,
    height,
    rx: Math.min(cutout.rx, width / 2),
    ry: Math.min(cutout.ry, height / 2),
  };
}
