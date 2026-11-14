// packages/notifications/show/blind-setting-renderer.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The complete setting screen as a single PURE, BLIND component. It consumes
// exactly one HumanSettingView (human strings + opaque option ids) plus three
// callbacks, and renders the whole reference anatomy: header, a radiogroup of
// option cards, and the persistent save/revert bar. It owns no state, performs
// no I/O, and — by construction of HumanSettingView — cannot name a mode, key,
// address, or route.
//
// This is the L063 category fix made visible: every notification mode, and
// every FUTURE setting that adopts this renderer, flows through the same
// projection → same renderer. Adding a mode is a descriptor data row; this file
// never changes. Adding a different single-select setting reuses this file
// verbatim with a different descriptor.
//
// Render-state matrix (all handled here from the single `status` field):
//   loading  → skeleton rows preserve the option-list shape
//   ready/default → option list + "Active now" on the current card
//   dirty    → option list with a new selection + enabled Save
//   saving   → option list locked, Save shows a spinner, choice preserved
//   saved    → transient "Saved" confirmation in the bar
//   error    → choice unchanged, error sentence in the bar
//   invalid  → no current card; warning sentence prompts a fresh pick
//   offline  → Save disabled with a reconnect reason
//   sparse/dense → driven purely by options.length (no special cases)
//   mobile/desktop → layout reflows via responsive primitive classes only
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Zero domain literals. Every visible word comes from the view; source
//    contains no mode key, property id, target, or action name.
// 2. Composes only shared ui primitives and the package's own option-card /
//    save-bar molecules — no raw div/span/p, no inline styling (L065).
// 3. Pure: same view → same DOM. No useState/useEffect, no window/DOM access,
//    safe to run identically in the browser and iOS JSCore envelopes.
// 4. Selection, save, and revert are reported through callbacks carrying only
//    the opaque option id — the renderer never resolves it.
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React from 'react';
import { Card, Container, Text } from '../../ui';
import { SettingOptionCard } from './setting-option-card';
import { SettingSaveBar } from './setting-save-bar';
import type { HumanSettingView } from '../read-data/project-setting-view';

/** Number of placeholder rows shown while the current choice loads. */
const SKELETON_ROWS = 3;

export interface BlindSettingRendererProps {
  view: HumanSettingView;
  onSelect: (optionId: string) => void;
  onSave: () => void;
  onRevert: () => void;
}

/**
 * Skeleton placeholder that mirrors one option card's footprint so the layout
 * does not jump when real options arrive. Generic — no domain content.
 */
function SkeletonRow() {
  return (
    <Card variant="nested" layout="row" padding="md" aria-hidden className="items-center gap-4">
      <Container
        padding="none"
        className="h-8 w-8 shrink-0 animate-pulse rounded-full bg-[var(--glass-bg-subtle)]"
      />
      <Container layout="vertical" gap="xs" padding="none" className="min-w-0 flex-1">
        <Container
          padding="none"
          className="h-3 w-1/3 animate-pulse rounded bg-[var(--glass-bg-subtle)]"
        />
        <Container
          padding="none"
          className="h-2.5 w-2/3 animate-pulse rounded bg-[var(--glass-bg-subtle)]"
        />
      </Container>
    </Card>
  );
}

export function BlindSettingRenderer({ view, onSelect, onSave, onRevert }: BlindSettingRendererProps) {
  const loading = view.status === 'loading';
  // While a write is in flight the choice is preserved but locked (L: pending
  // state that preserves the selected choice while the write is in flight).
  const optionsDisabled = view.status === 'saving';

  return (
    <Container
      layout="vertical"
      gap="lg"
      padding="lg"
      data-setting-screen
      data-status={view.status}
      className="mx-auto w-full max-w-2xl"
    >
      <Container layout="vertical" gap="xs" padding="none">
        <Text variant="heading-lg">{view.heading}</Text>
        {view.explanation ? (
          <Text variant="body-xs" color="faint">
            {view.explanation}
          </Text>
        ) : null}
      </Container>

      {loading ? (
        <Container layout="vertical" gap="sm" padding="none" data-setting-skeleton aria-busy>
          {Array.from({ length: SKELETON_ROWS }).map((_, index) => (
            <SkeletonRow key={index} />
          ))}
        </Container>
      ) : (
        <Container
          layout="vertical"
          gap="sm"
          padding="none"
          role="radiogroup"
          aria-label={view.heading}
          data-setting-options
        >
          {view.options.map((option) => (
            <SettingOptionCard
              key={option.id}
              option={option}
              disabled={optionsDisabled}
              onSelect={onSelect}
            />
          ))}
        </Container>
      )}

      {loading ? null : <SettingSaveBar view={view} onSave={onSave} onRevert={onRevert} />}
    </Container>
  );
}
