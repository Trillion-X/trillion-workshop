// packages/workflow-canvas/show/CanvasCommandOverlay.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The guided create flow (the screen contract's create overlay): Name the
// workflow → choose what it does first from the FULL capability catalog →
// create. Created workflows are REAL definitions — written to the workflow
// definition store through the owner action, immediately executable,
// immediately selected on the canvas for further authoring (steps, branches,
// data injection all continue in the inspector).
//
// Reference anatomy (Mobbin, opened this pass):
// - Lindy create-agent flow: one centered prompt per decision, big label-only
//   choices, no form-grid (https://mobbin.com/flows/776b52fd-8612-4c4f-aa0e-dd0ef9985dd8)
// - Lindy "Select next step": the capability catalog IS the picker
// - Zapier: plain human language ("What should it do first?")
//
// The first-step catalog is `NextStepCatalog` — the SAME catalog used by the
// node + affordance and the inspector's "Add a step" (SSOT for "what can run").
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. ui primitives + tokens only; inline style limited to geometry.
// 2. Plain visible copy. One decision per screen (L115 — label-only choices,
//    no explanatory subcopy).
// 3. Creation goes through do-work → owner action. Nothing is created
//    client-side only.
// 4. The catalog lists only REAL actions and live-mined capabilities — no
//    fake rows (L117).
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft as BackIcon, Plus as PlusIcon, X as CloseIcon } from 'lucide-react';
import { Button, Card, Container, Icon, Input, Text } from '../../ui';
import {
  createActionId,
  saveWorkflowCanvasActions,
  type WorkflowCanvasActionEdit,
} from '../do-work/save-workflow-canvas-actions';
import {
  NextStepCatalog,
  type NextStepWorkCapability,
} from './NextStepPopover';
import type { CanvasNode } from './workflow-canvas-types';

export interface CanvasCommandOverlayProps {
  workflowId?: string;
  nodes: CanvasNode[];
  selectedNodeId: string | null;
  /** Outside-work targets the system already uses — click to choose, never type. */
  workTargets?: readonly string[];
  /** Full mined capability surface with real example payloads (preferred). */
  workCapabilities?: readonly NextStepWorkCapability[];
  /** Where to drop the new node (world-space); the canvas supplies a clear spot. */
  nextPosition: { x: number; y: number };
  /** Called after the owner accepts the creation — the canvas shows it instantly. */
  onCreated?: (edit: WorkflowCanvasActionEdit) => void;
  /** Monotonic open signal: when it increments, the create flow opens straight
   *  to the name screen (the empty-state CTA bumps it). 0 = never auto-opened. */
  openSignal?: number;
}

/** The create flow's screens, in contract order. */
type CreateScreen = 'closed' | 'name' | 'first-step' | 'saving';

export function CanvasCommandOverlay({
  workflowId,
  nodes,
  workTargets = [],
  workCapabilities,
  nextPosition,
  onCreated,
  openSignal,
}: CanvasCommandOverlayProps) {
  const [screen, setScreen] = useState<CreateScreen>('closed');
  const [name, setName] = useState('');
  const [lastError, setLastError] = useState('');
  const nameInputRef = useRef<HTMLInputElement>(null);

  // The name screen owns focus the moment it opens (Lindy's create overlay
  // is keyboard-first: type, Enter, pick).
  useEffect(() => {
    if (screen === 'name') nameInputRef.current?.focus();
  }, [screen]);

  // Declared before the effects that reference it in their dependency arrays —
  // a `const` in a dep array is evaluated when the effect call runs during
  // render, so it must be initialized first (else a TDZ ReferenceError throws
  // on mount). Deps are empty (setters are stable), so hoisting is behavior-safe.
  const close = useCallback(() => {
    setScreen('closed');
    setName('');
    setLastError('');
  }, []);

  // Escape walks the flow backwards: first-step → name, anything else → closed.
  // The close path goes through close() so the draft name and any error are
  // cleared — otherwise reopening the overlay would show last time's stale name
  // and a dead error message (round-17 fix).
  useEffect(() => {
    if (screen === 'closed') return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (screen === 'first-step') {
        setScreen('name');
      } else {
        close();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [screen, close]);

  // The empty-state CTA opens the flow by bumping `openSignal` (the
  // renameRequestId idiom) — a new value jumps straight to the name screen.
  useEffect(() => {
    if (openSignal && openSignal > 0) setScreen('name');
  }, [openSignal]);

  /** Catalog rows: every existing runnable action (real, no fakes). */
  const actionOptions = nodes
    .filter((node) => node.data.runnable)
    .map((node) => ({ id: node.id, label: node.label }))
    .sort((left, right) => left.label.localeCompare(right.label));

  const uniqueId = useCallback((label: string): string => {
    // Built inside the callback so `nodes` is the only dependency — no stale
    // closure and no lint suppression (the exhaustive-deps disable is gone).
    const existingIds = new Set(nodes.map((node) => node.id));
    const base = createActionId(label);
    let candidate = base;
    let suffix = 2;
    while (existingIds.has(candidate)) {
      candidate = `${base}-${suffix}`;
      suffix += 1;
    }
    return candidate;
  }, [nodes]);

  /** Picking the first step IS creating the workflow — one decision, done. */
  const handlePickFirstStep = useCallback(async (step: unknown) => {
    const label = name.trim();
    if (!label) return;
    setScreen('saving');
    setLastError('');
    try {
      const edit: WorkflowCanvasActionEdit = {
        id: uniqueId(label),
        description: null,
        steps: [step],
        enabled: true,
        x: nextPosition.x,
        y: nextPosition.y,
      };
      await saveWorkflowCanvasActions({
        workflowId: workflowId ?? 'workflow:default',
        actions: [edit],
      });
      onCreated?.(edit);
      close();
    } catch (error) {
      setScreen('first-step');
      console.error("[workflow-canvas] command failed:", error); setLastError("Command failed");
    }
  }, [close, name, nextPosition, onCreated, uniqueId, workflowId]);

  // ---- closed: the single launch affordance ----
  if (screen === 'closed') {
    return (
      <Container
        data-workflow-create-overlay="true"
        position="absolute"
        zIndex="10"
        style={{ bottom: '1rem', left: '50%', transform: 'translateX(-50%)' }}
        onPointerDown={(event: React.PointerEvent) => event.stopPropagation()}
        onClick={(event: React.MouseEvent) => event.stopPropagation()}
      >
        <Card variant="popover" padding="xs">
          <Button
            variant="primary"
            size="sm"
            data-workflow-create-open="true"
            onClick={() => setScreen('name')}
          >
            <Icon icon={PlusIcon} size="sm" />
            New workflow
          </Button>
        </Card>
      </Container>
    );
  }

  // ---- open: one centered prompt per decision (Lindy create overlay) ----
  return (
    <Container
      data-workflow-create-overlay="true"
      position="absolute"
      zIndex="30"
      style={{
        top: '50%',
        left: '50%',
        transform: 'translate(-50%, -50%)',
        width: 'min(440px, calc(100% - 2rem))',
      }}
      onPointerDown={(event: React.PointerEvent) => event.stopPropagation()}
      onClick={(event: React.MouseEvent) => event.stopPropagation()}
    >
      <Card variant="popover" padding="lg">
        <Container layout="vertical" gap="md">
          {/* Flow header: back (when deep), title, close. */}
          <Container layout="horizontal" gap="sm" alignItems="center">
            {screen === 'first-step' && (
              <Button
                variant="ghost"
                size="sm"
                aria-label="Back"
                onClick={() => setScreen('name')}
              >
                <Icon icon={BackIcon} size="xs" />
              </Button>
            )}
            <Container flex={1} style={{ minWidth: 0 }}>
              <Text variant="heading-sm">
                {screen === 'name' ? 'Name your workflow' : screen === 'saving' ? 'Creating…' : 'What should it do first?'}
              </Text>
            </Container>
            <Button variant="ghost" size="sm" aria-label="Close" onClick={close}>
              <Icon icon={CloseIcon} size="xs" />
            </Button>
          </Container>

          {screen === 'name' && (
            <Container layout="vertical" gap="md" data-workflow-create-name="true">
              <Input
                ref={nameInputRef}
                aria-label="Workflow name"
                placeholder="Summarize new recordings"
                value={name}
                onChange={(event) => setName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && name.trim()) setScreen('first-step');
                }}
              />
              <Container layout="horizontal" justifyContent="end">
                <Button
                  variant="primary"
                  size="sm"
                  disabled={!name.trim()}
                  onClick={() => setScreen('first-step')}
                >
                  Next
                </Button>
              </Container>
            </Container>
          )}

          {(screen === 'first-step' || screen === 'saving') && (
            <Container layout="vertical" gap="sm" data-workflow-create-first-step="true">
              {/* This screen owns the heading — the catalog body is headerless. */}
              <Text variant="caption" color="muted">Select next step</Text>
              {/* The full capability catalog: real actions, live-mined
                  outside-work targets with honest prefills, quick shapes.
                  Picking creates the workflow — one decision, done. */}
              <NextStepCatalog
                actionOptions={actionOptions}
                workTargets={workTargets}
                workCapabilities={workCapabilities}
                onPick={(step) => { if (screen === 'first-step') void handlePickFirstStep(step); }}
              />
            </Container>
          )}

          {lastError && (
            <Text variant="caption" color="error">{lastError}</Text>
          )}
        </Container>
      </Card>
    </Container>
  );
}
