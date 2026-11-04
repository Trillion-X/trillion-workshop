import { Fragment, createElement, type ComponentType, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { createBlindRegistry } from '../../ui/show/blind-registry/blind-registry';
import type { Rect } from '../../ui/show/anchor-resolver/anchor-resolver';
import type { WalkthroughDefinition, WalkthroughStep } from '../read-data/walkthrough-eeaf';
import { LAYER_ORDER } from '../../ui/show/layer-order/layer-order';
import { resolveCenteredBackdropAppearance } from './walkthrough-presentation';

export interface WalkthroughPresentationProps {
  readonly presentationRef: unknown;
  readonly definition: WalkthroughDefinition;
  readonly step: WalkthroughStep;
  readonly targetRect: Rect | null;
  readonly children: ReactNode;
}

export type WalkthroughPresentationComponent = ComponentType<WalkthroughPresentationProps>;

export interface WalkthroughPresentationRegistry {
  register(ref: string, presenter: WalkthroughPresentationComponent): void;
  resolve(ref: unknown): WalkthroughPresentationComponent;
  has(ref: string): boolean;
  refs(): string[];
}

/** Existing spotlight and coachmark rendering remains the default byte-compatible path. */
export const DefaultWalkthroughPresentation: WalkthroughPresentationComponent = ({ children, step, targetRect }) => {
  const backdrop = resolveCenteredBackdropAppearance(step.look);
  const cover = !targetRect && backdrop.enabled && typeof document !== 'undefined'
    ? createPortal(createElement('div', {
      'aria-hidden': true,
      'data-guided-centered-backdrop': '',
      style: {
        position: 'fixed',
        inset: 0,
        zIndex: LAYER_ORDER.dialog - 1,
        backgroundColor: backdrop.scrimColor,
        backdropFilter: `blur(${backdrop.blurPx}px)`,
        WebkitBackdropFilter: `blur(${backdrop.blurPx}px)`,
        pointerEvents: 'none',
      },
    }), document.body)
    : null;
  return createElement(Fragment, null, cover, children);
};

/**
 * Open registry for package-owned presentations. The reference is treated as an
 * opaque identity string. Unknown, absent, and non-string refs use the fallback.
 */
export function createWalkthroughPresentationRegistry(
  fallback: WalkthroughPresentationComponent = DefaultWalkthroughPresentation,
): WalkthroughPresentationRegistry {
  const registry = createBlindRegistry<WalkthroughPresentationComponent>({ fallback });
  return {
    register: (ref, presenter) => registry.register(ref, presenter),
    resolve: (ref) => registry.resolve(typeof ref === 'string' ? ref : ''),
    has: (ref) => registry.has(ref),
    refs: () => registry.keys(),
  };
}

export function registerWalkthroughPresentations(
  registry: WalkthroughPresentationRegistry,
  presentations: Readonly<Record<string, WalkthroughPresentationComponent>>,
): WalkthroughPresentationRegistry {
  for (const [ref, presenter] of Object.entries(presentations)) registry.register(ref, presenter);
  return registry;
}
