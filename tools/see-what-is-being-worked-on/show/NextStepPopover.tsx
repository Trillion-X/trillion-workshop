// packages/workflow-canvas/show/NextStepPopover.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Lindy's "Select next step" anatomy, grounded in this engine's REAL step
// kinds: a small in-canvas popover anchored under the + affordance of the
// selected node. One search box, a list of real actions to run next, and the
// quick shapes (repeat / ask outside work / wait). Choosing appends a REAL
// step to the source action through the owner save path — the edge appears
// because edges are derived from steps, not drawn separately.
//
// Reference anatomy (Mobbin, opened this pass):
// - Lindy "Select next step" popover: rows with leading icon + label + a
//   trailing +, anchored at the flow's growth point
//   (https://mobbin.com/screens/3ef9e6f4-ae87-488d-a614-d1f242e8d6f6)
// - n8n "What happens next?" rail: searchable action list
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. ui primitives + tokens only; inline style limited to geometry.
// 2. Plain visible copy. The engine's step kinds surface as human shapes:
//    "Run …", "Repeat for each item", "Ask outside work", "Wait".
// 3. Choosing emits ONE intent: `onPick(step)` — the canvas owns the save.
//    The popover never talks to do-work directly.
// 4. Search is label-substring over REAL actions on the canvas — no fakes.
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Plus as PlusIcon,
  Send as SendIcon,
  Zap as ActionIcon,
} from 'lucide-react';
import { Button, Card, Container, Icon, Input, Text } from '../../ui';
import {
  stepKindCatalog,
  emptyStepOfKind,
} from '../read-data/describe-step-fields';
import { iconForName } from './node-icon';

export interface NextStepActionOption {
  id: string;
  label: string;
}

/** One outside-work capability row (mined from live usage). */
export interface NextStepWorkCapability {
  target: string;
  usageCount: number;
  examplePayload: unknown;
  payloadKeys: string[];
}

export interface NextStepPopoverProps {
  /** Screen-space anchor (the + affordance), relative to the canvas element. */
  anchorX: number;
  anchorY: number;
  /** Real, runnable actions available to chain (excluding the source). */
  actionOptions: readonly NextStepActionOption[];
  /** Outside-work targets the system already uses (names only — legacy). */
  workTargets?: readonly string[];
  /** Full capability surface with real example payloads (preferred). */
  workCapabilities?: readonly NextStepWorkCapability[];
  onPick: (step: unknown) => void;
  onClose: () => void;
}

function humanizeTarget(target: string): string {
  return target
    .replace(/^slot::/, '')
    .split(/[-_.]/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

/** Props for the reusable catalog body (popover-independent). */
export interface NextStepCatalogProps {
  actionOptions: readonly NextStepActionOption[];
  workTargets?: readonly string[];
  workCapabilities?: readonly NextStepWorkCapability[];
  onPick: (step: unknown) => void;
  /** Autofocus the search box (popovers want it; inline forms may not). */
  autoFocus?: boolean;
}

/**
 * The catalog body: one search box over every real capability, grouped rows.
 * Used by the in-canvas popover AND the inspector's "Add a step" — one
 * catalog, every entry point (SSOT for "what can run next").
 */
export const NextStepCatalog: React.FC<NextStepCatalogProps> = ({
  actionOptions,
  workTargets = [],
  workCapabilities,
  onPick,
  autoFocus = true,
}) => {
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
  }, [autoFocus]);

  const trimmed = query.trim().toLowerCase();
  // Perf guard ONLY: each section renders at most ROW_CAP rows, but any overflow
  // is ALWAYS surfaced as a "+N more" row below — never silently dropped (L118).
  // Search narrows the matches; the list never lies about what it hides.
  const ROW_CAP = 8;
  const matchedActions = useMemo(
    () => (trimmed
      ? actionOptions.filter((option) => option.label.toLowerCase().includes(trimmed))
      : actionOptions),
    [actionOptions, trimmed],
  );
  const visibleActions = matchedActions.slice(0, ROW_CAP);
  // Capability rows: the full mined surface when supplied (preferred);
  // bare target names otherwise. Real example payloads ride each row so a
  // picked step starts from a shape that demonstrably works.
  const capabilities = useMemo<readonly NextStepWorkCapability[]>(
    () => workCapabilities
      ?? workTargets.map((target) => ({
        target,
        usageCount: 0,
        examplePayload: {},
        payloadKeys: [],
      })),
    [workCapabilities, workTargets],
  );
  const matchedTargets = useMemo(
    () => (trimmed
      ? capabilities.filter((capability) =>
        humanizeTarget(capability.target).toLowerCase().includes(trimmed)
        || capability.payloadKeys.some((key) => key.toLowerCase().includes(trimmed)))
      : capabilities),
    [capabilities, trimmed],
  );
  const visibleTargets = matchedTargets.slice(0, ROW_CAP);
  // Canonical step kinds come from the ONE catalog SSOT (describe-step-fields),
  // never a duplicate factory list here. `action`/`ask` are omitted because the
  // concrete "Run {action}" and "Ask {capability}" rows above already cover them.
  const firstActionId = actionOptions[0]?.id ?? '';
  const stepKinds = useMemo(
    () => stepKindCatalog().filter((shape) => shape.value !== 'action' && shape.value !== 'ask'),
    [],
  );
  const visibleShapes = trimmed
    ? stepKinds.filter((shape) => shape.label.toLowerCase().includes(trimmed))
    : stepKinds;

  return (
    // Headerless body: the title ("Select next step" / "Add a step" / …) is the
    // CONSUMER's job — this catalog is reused by the popover, the inspector, and
    // the create overlay, each owning its own one-time heading. Owning a title
    // here double-rendered it under every consumer's heading.
    <Container layout="vertical" gap="sm" data-workflow-next-step-catalog="true">
      <Input
        ref={inputRef}
        aria-label="Search next steps"
        placeholder="Search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <Container layout="vertical" gap="xs" overflow="auto" style={{ maxHeight: '40vh' }}>
        {visibleActions.map((option) => (
              <Button
                key={option.id}
                variant="ghost"
                size="sm"
                onClick={() => onPick({
                  kind: 'action',
                  config: { definition_id: option.id, inputs: {} },
                })}
              >
                <Container layout="horizontal" gap="sm" alignItems="center" width="full">
                  <Icon icon={ActionIcon} size="xs" color="secondary" />
                  <Container flex={1} style={{ minWidth: 0, textAlign: 'left' }}>
                    <Text variant="body-xs" truncate title={option.label}>
                      Run {option.label}
                    </Text>
                  </Container>
                  <Icon icon={PlusIcon} size="xs" color="muted" />
                </Container>
              </Button>
            ))}
            {matchedActions.length > visibleActions.length && (
              <Text variant="caption" color="muted">
                +{matchedActions.length - visibleActions.length} more — type to filter
              </Text>
            )}

            {visibleTargets.map((capability) => (
              <Button
                key={capability.target}
                variant="ghost"
                size="sm"
                onClick={() => onPick({
                  kind: 'ask',
                  config: {
                    name: capability.target,
                    // Start from a payload that demonstrably works — the
                    // most common live usage — instead of an empty object.
                    input: capability.examplePayload ?? {},
                  },
                })}
              >
                <Container layout="horizontal" gap="sm" alignItems="center" width="full">
                  <Icon icon={SendIcon} size="xs" color="secondary" />
                  <Container layout="vertical" flex={1} style={{ minWidth: 0, textAlign: 'left' }}>
                    <Text variant="body-xs" truncate title={humanizeTarget(capability.target)}>
                      Ask {humanizeTarget(capability.target)}
                    </Text>
                    {capability.payloadKeys.length > 0 && (
                      <Text variant="caption" color="muted" truncate>
                        {capability.payloadKeys.slice(0, 4).map((key) =>
                          key.replace(/[_-]+/g, ' ')).join(', ')}
                      </Text>
                    )}
                  </Container>
                  {capability.usageCount > 0 && (
                    <Text variant="caption" color="muted">{capability.usageCount}</Text>
                  )}
                  <Icon icon={PlusIcon} size="xs" color="muted" />
                </Container>
              </Button>
            ))}
            {matchedTargets.length > visibleTargets.length && (
              <Text variant="caption" color="muted">
                +{matchedTargets.length - visibleTargets.length} more — type to filter
              </Text>
            )}

            {visibleShapes.map((shape) => (
              <Button
                key={shape.value}
                variant="ghost"
                size="sm"
                onClick={() => onPick(emptyStepOfKind(shape.value, firstActionId))}
              >
                <Container layout="horizontal" gap="sm" alignItems="center" width="full">
                  <Icon icon={iconForName(shape.iconName)} size="xs" color="secondary" />
                  <Container flex={1} style={{ minWidth: 0, textAlign: 'left' }}>
                    <Text variant="body-xs" truncate>{shape.label}</Text>
                  </Container>
                  <Icon icon={PlusIcon} size="xs" color="muted" />
                </Container>
              </Button>
            ))}

            {visibleActions.length === 0
              && visibleTargets.length === 0
              && visibleShapes.length === 0 && (
              <Text variant="caption" color="muted">Nothing matches</Text>
            )}
      </Container>
    </Container>
  );
};

/**
 * The in-canvas anchored popover shell around the shared catalog body.
 * Positioning + dismissal live here; the catalog content is `NextStepCatalog`.
 */
const POPOVER_WIDTH = 280;
const POPOVER_EDGE_GAP = 8;

export const NextStepPopover: React.FC<NextStepPopoverProps> = ({
  anchorX,
  anchorY,
  actionOptions,
  workTargets = [],
  workCapabilities,
  onPick,
  onClose,
}) => {
  const popoverRef = useRef<HTMLDivElement>(null);
  // Post-mount clamp within the canvas pane: flip above the anchor when the
  // popover would clip the bottom edge, slide it horizontally when it would
  // clip a side. Re-runs when the anchor moves.
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  useEffect(() => {
    const element = popoverRef.current;
    const pane = element?.offsetParent as HTMLElement | null;
    if (!element || !pane) return;
    const height = element.offsetHeight;
    const next = { x: 0, y: 0 };
    const left = anchorX - POPOVER_WIDTH / 2;
    const right = anchorX + POPOVER_WIDTH / 2;
    if (left < POPOVER_EDGE_GAP) next.x = POPOVER_EDGE_GAP - left;
    else if (right > pane.clientWidth - POPOVER_EDGE_GAP) {
      next.x = pane.clientWidth - POPOVER_EDGE_GAP - right;
    }
    if (anchorY + height > pane.clientHeight - POPOVER_EDGE_GAP) {
      // Flip above: the anchor sits under a + circle ~28px below the node.
      next.y = -(height + 44);
    }
    setOffset((current) => (current.x === next.x && current.y === next.y ? current : next));
  }, [anchorX, anchorY, actionOptions.length, workCapabilities?.length]);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose]);

  return (
    <Container
      ref={popoverRef}
      data-workflow-next-step-popover="true"
      position="absolute"
      zIndex="30"
      style={{
        left: `${Math.round(anchorX + offset.x)}px`,
        top: `${Math.round(anchorY + offset.y)}px`,
        transform: 'translateX(-50%)',
        width: `${POPOVER_WIDTH}px`,
      }}
      onPointerDown={(event: React.PointerEvent) => event.stopPropagation()}
      onClick={(event: React.MouseEvent) => event.stopPropagation()}
    >
      <Card variant="popover" padding="sm">
        <Container layout="vertical" gap="sm">
          <Text variant="caption" color="muted">Select next step</Text>
          <NextStepCatalog
            actionOptions={actionOptions}
            workTargets={workTargets}
            workCapabilities={workCapabilities}
            onPick={onPick}
          />
        </Container>
      </Card>
    </Container>
  );
};
