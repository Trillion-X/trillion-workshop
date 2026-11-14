// PORTED FROM: bitfield-packages/packages/chat/show/PlanSidebar.tsx @ e99ac5976
// frontends/web/src/packages/chat/show/PlanSidebar.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Sliding panel that displays plan steps extracted from chat messages.
// Renders a checklist of plan steps with status indicators and title text.
// Slides in from the right with framer-motion animations.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Overlays chat content absolutely at right-0
// 2. Width is exactly 320px (fixed)
// 3. StatusDot icons match plan step status (pending → idle, in_progress → warning, completed → success)
// 4. Slide animation uses framer-motion AnimatePresence + motion.div
// 5. All step titles are rendered via Text component variant="body-sm"
// 6. Close button is rendered in header with clear affordance
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React from 'react';
import {AnimatePresence} from 'framer-motion';
import { motion } from 'trillion-workshop/tools/ui/motion/lazy-motion.tsx';
import { X } from 'lucide-react';
import { Button, Card, Container, Icon, StatusDot, Text } from '../../ui';
import type { PlanStep } from './plan-parser';
import MarkdownContent from './MarkdownContent';

// ---------------------------------------------------------------------------
// MOTION WRAPPER STYLE
// ---------------------------------------------------------------------------

/**
 * Physics-level positioning for the framer-motion animation wrapper.
 * Absolute overlay at inset-y-2 right-2, 320px wide, column flex.
 * style= on motion.div is the established pattern — not className.
 */
const SIDEBAR_STYLE: React.CSSProperties = {
  position: 'absolute',
  top: '0.5rem',
  bottom: '0.5rem',
  right: '0.5rem',
  width: '320px',
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
};

/**
 * Dynamic maxHeight for the plan content scroll region (~46vh).
 * Applied via style= on a Container because it's a dynamic physics value
 * with no CVA equivalent.
 */
const PLAN_CONTENT_SCROLL_STYLE: React.CSSProperties = {
  maxHeight: '46vh',
};

// ---------------------------------------------------------------------------
// PROPS
// ---------------------------------------------------------------------------

/**
 * Props for the PlanSidebar component.
 */
export interface PlanSidebarProps {
  /** Array of plan steps to display */
  steps: PlanStep[];
  /** Whether the sidebar is currently open/visible */
  isOpen: boolean;
  /** Callback fired when close button is clicked */
  onClose: () => void;
  /** Final plan markdown from ExitPlanMode payload */
  planContent?: string | null;
  /** Optional preamble text emitted before ExitPlanMode */
  planPreamble?: string | null;
}

// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------

/**
 * Maps PlanStep status to StatusDot status variant name.
 *
 * pending → idle (grey, waiting)
 * in_progress → warning (amber, active)
 * completed → success (green, finished)
 */
function getStatusDotVariant(
  status: 'pending' | 'in_progress' | 'completed',
): 'idle' | 'warning' | 'success' {
  switch (status) {
    case 'pending':
      return 'idle';
    case 'in_progress':
      return 'warning';
    case 'completed':
      return 'success';
  }
}

// ---------------------------------------------------------------------------
// STEP ROW
// ---------------------------------------------------------------------------

interface StepRowProps {
  step: PlanStep;
  showDescription?: boolean;
  key?: React.Key;
}

/**
 * Single plan step row — status dot + title + optional description.
 * Card ghost variant provides the hover-interactive affordance.
 */
function StepRow({ step, showDescription = false }: StepRowProps) {
  return (
    <Card variant="ghost" padding="sm" layout="row" interactive key={step.id}>
      <StatusDot status={getStatusDotVariant(step.status)} size="sm" />
      <Container layout="vertical" gap="none" flex={1}>
        <Text variant="body-xs" color="white" wrap="preserve">
          {step.title}
        </Text>
        {showDescription && step.description && (
          <Text variant="body-xs" color="subtle">
            {step.description}
          </Text>
        )}
      </Container>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// COMPONENT
// ---------------------------------------------------------------------------

/**
 * Sliding panel sidebar displaying plan steps.
 *
 * Renders a glassmorphic panel that slides in from the right when isOpen=true.
 * Each step is displayed as a row with a status dot and title text.
 * Panel can be closed via the close button, which triggers the onClose callback.
 *
 * The sidebar is positioned absolutely on the right, overlaying the chat panel.
 */
export function PlanSidebar({
  steps,
  isOpen,
  onClose,
  planContent = null,
  planPreamble = null,
}: PlanSidebarProps) {
  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          style={SIDEBAR_STYLE}
          initial={{ x: 320 }}
          animate={{ x: 0 }}
          exit={{ x: 320 }}
          transition={{ duration: 0.2, ease: 'easeInOut' }}
        >
          <Card variant="popover" padding="none" layout="column" flex={1} minHeight="0">

            {/* Header */}
            <Container
              layout="horizontal"
              alignItems="center"
              justifyContent="between"
              padding="lg"
              border="bottom"
            >
              <Text variant="label" weight="semibold" color="white">
                {planContent ? 'Plan Ready' : 'Plan Steps'}
              </Text>
              <Container layout="horizontal" gap="sm" alignItems="center">
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={onClose}
                  aria-label="Close plan sidebar"
                >
                  <Icon icon={X} size="xs" />
                </Button>
              </Container>
            </Container>

            {/* Body */}
            <Container layout="vertical" flex={1} overflow="y-auto" minHeight="0">
              {planContent ? (
                <Container layout="vertical" gap="md" padding="lg">
                  {planPreamble && (
                    <Card variant="nested" padding="sm">
                      <MarkdownContent content={planPreamble} />
                    </Card>
                  )}

                  <Card
                    variant="popover"
                    padding="sm"
                    layout="column"
                    style={{ border: '1px solid rgba(52, 211, 153, 0.35)' }}
                  >
                    <Text variant="label" color="white" weight="semibold">
                      Ready to code?
                    </Text>
                    <Container overflow="y-auto" style={PLAN_CONTENT_SCROLL_STYLE}>
                      <MarkdownContent content={planContent} />
                    </Container>
                  </Card>

                  {steps.length > 0 && (
                    <Container layout="vertical" gap="sm">
                      <Text variant="label" color="subtle">
                        Extracted Steps
                      </Text>
                      {steps.map((step) => (
                        <StepRow key={step.id} step={step} showDescription={false} />
                      ))}
                    </Container>
                  )}
                </Container>
              ) : steps.length === 0 ? (
                <Container
                  layout="vertical"
                  alignItems="center"
                  justifyContent="center"
                  height="full"
                  padding="lg"
                >
                  <Text variant="body-xs" color="subtle" align="center">
                    No plan steps yet
                  </Text>
                </Container>
              ) : (
                <Container layout="vertical" gap="sm" padding="lg">
                  {steps.map((step) => (
                    <StepRow key={step.id} step={step} showDescription={true} />
                  ))}
                </Container>
              )}
            </Container>

          </Card>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
