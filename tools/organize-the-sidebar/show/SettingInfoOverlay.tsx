// packages/group/show/SettingInfoOverlay.tsx
//
// Generic setting information overlay (L069 primitive): displays plain-language
// explanation + optional visual demo for a board-default setting. Anchors to an
// (i) icon button. Used by BoardDefaultControl to surface per-setting help.
//
// The overlay is DATA-driven: a SettingInfoDescriptor (title, description, visual)
// is passed in; the component renders it blindly. Adding a new setting info is one
// DATA row, ZERO code change here.

import React, { useRef } from 'react';
import { AnchoredOverlay, Button, Container, Text, Icon } from '../../ui';
import { HelpCircle, X } from 'lucide-react';

export interface SettingInfoDescriptor {
  key: string;
  title: string;
  description: string;
  /** Optional visual: URL to before/after screenshot or animated demo. */
  visualUrl?: string;
  /** Optional label for the visual (e.g., "Before and after"). */
  visualLabel?: string;
}

export interface SettingInfoOverlayProps {
  descriptor: SettingInfoDescriptor;
}

/**
 * Generic setting info overlay: icon button → anchored popover with title + description + visual.
 * Stateful (manages its own open/close via internal state).
 */
export function SettingInfoOverlay({ descriptor }: SettingInfoOverlayProps) {
  const [open, setOpen] = React.useState(false);
  const anchorRef = useRef<HTMLButtonElement | null>(null);

  return (
    <>
      <Button
        ref={anchorRef}
        variant="ghost"
        size="icon"
        aria-label={`Help for ${descriptor.title}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <Icon icon={HelpCircle} size="sm" />
      </Button>
      <AnchoredOverlay
        anchorRef={anchorRef}
        open={open}
        onDismiss={() => setOpen(false)}
      >
        <Container
          layout="vertical"
          gap="md"
          padding="md"
          style={{ maxWidth: '320px' }}
          aria-label={`Help: ${descriptor.title}`}
        >
          {/* Header */}
          <Container layout="horizontal" justifyContent="between" alignItems="start" gap="sm">
            <Text variant="label">{descriptor.title}</Text>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Close"
              onClick={() => setOpen(false)}
            >
              <Icon icon={X} size="sm" />
            </Button>
          </Container>

          {/* Description */}
          <Text variant="body-sm" style={{ lineHeight: 1.5 }}>
            {descriptor.description}
          </Text>

          {/* Visual (optional before/after or demo) */}
          {descriptor.visualUrl ? (
            <Container layout="vertical" gap="xs">
              {descriptor.visualLabel ? (
                <Text variant="caption" style={{ color: 'var(--color-text-muted)' }}>
                  {descriptor.visualLabel}
                </Text>
              ) : null}
              <img
                src={descriptor.visualUrl}
                alt={`Visual demo for ${descriptor.title}`}
                style={{
                  width: '100%',
                  borderRadius: 'var(--radius-card)',
                  maxHeight: '200px',
                  objectFit: 'contain',
                }}
              />
            </Container>
          ) : null}
        </Container>
      </AnchoredOverlay>
    </>
  );
}
