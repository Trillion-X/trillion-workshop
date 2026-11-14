// packages/ui/show/disclosure-section/DisclosureSection.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// A lightweight titled SECTION for grouping settings rows inside panels and
// popovers (the Figma/Notion "labelled group with a chevron" pattern). Optionally
// collapsible: a title row that toggles a body open/closed. This is the shared
// molecule for "give this panel sections instead of one flat wall of controls" —
// feature packages compose it; they never hand-roll a header+divider+chevron.
//
// It is NOT the heavy resizable side-panel (that is CollapsiblePanel). This owns
// only: a title row + an optional chevron toggle + a body. Collapse state is
// local (self-contained) with a `defaultOpen`; callers that need durable state
// pass `open` + `onOpenChange` (controlled).
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Blind to CONTENT — it renders a title + children; it never knows what the
//    rows mean (no domain vocabulary).
// 2. Token-driven chrome (Text label + Divider + Icon); zero raw color.
// 3. `collapsible={false}` (default) → a plain titled group, always open, no
//    chevron. `collapsible` → the title row is a button that toggles the body.
// 4. Uncontrolled by default (local state seeded by `defaultOpen`); controlled
//    when `open` + `onOpenChange` are supplied.
//
// =============================================================================
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import * as React from 'react';
import { ChevronRight } from 'lucide-react';
import { Text } from '../text';
import { Icon } from '../icon';
import { Divider } from '../divider/Divider';

export interface DisclosureSectionProps {
  /** Section title (rendered as a real heading with label presentation). */
  readonly title: string;
  /** Semantic heading depth for this section. Default 2. */
  readonly headingLevel?: 1 | 2 | 3 | 4 | 5 | 6;
  /** Whether the section can collapse. Default false → always-open titled group. */
  readonly collapsible?: boolean;
  /** Uncontrolled initial open state (collapsible only). Default true. */
  readonly defaultOpen?: boolean;
  /** Controlled open state (collapsible only) — supply with `onOpenChange`. */
  readonly open?: boolean;
  /** Controlled open change (collapsible only). */
  readonly onOpenChange?: (open: boolean) => void;
  /** A thin rule above the title (to separate stacked sections). Default true. */
  readonly divider?: boolean;
  /** How the title reads: `label` (the settings-group look, the default) or `caption`
   *  (for a label among form fields and captions that read the same way). Both keep the title's own case. */
  readonly titleLook?: 'label' | 'caption';
  /** A quiet control at the end of the title row (for example a Manage button); never inside the toggle. */
  readonly action?: React.ReactNode;
  readonly children: React.ReactNode;
}

/** A titled (optionally collapsible) group of settings rows. */
export function DisclosureSection({
  title,
  headingLevel = 2,
  collapsible = false,
  defaultOpen = true,
  open,
  onOpenChange,
  divider = true,
  titleLook = 'label',
  action,
  children,
}: DisclosureSectionProps): JSX.Element {
  const [localOpen, setLocalOpen] = React.useState(defaultOpen);
  const isControlled = open !== undefined;
  const isOpen = collapsible ? (isControlled ? (open as boolean) : localOpen) : true;
  const Heading = `h${headingLevel}` as React.ElementType;

  const toggle = () => {
    if (!collapsible) return;
    const next = !isOpen;
    if (!isControlled) setLocalOpen(next);
    onOpenChange?.(next);
  };

  const header = collapsible ? (
    <Heading style={{ margin: 0 }}>
      <button
        type="button"
        onClick={toggle}
        aria-expanded={isOpen}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          width: '100%',
          padding: '2px 0',
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
        }}
      >
        <span
          style={{
            display: 'inline-flex',
            transition: 'transform 0.15s ease',
            transform: isOpen ? 'rotate(90deg)' : 'rotate(0deg)',
          }}
        >
          <Icon icon={ChevronRight} size="xs" />
        </span>
        <Text as="span" variant={titleLook}>{title}</Text>
      </button>
    </Heading>
  ) : (
    <Text as={Heading} variant={titleLook}>{title}</Text>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {divider ? <Divider orientation="horizontal" /> : null}
      {action ? (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <div style={{ minWidth: 0, flex: 1 }}>{header}</div>
          {action}
        </div>
      ) : header}
      {isOpen ? children : null}
    </div>
  );
}
