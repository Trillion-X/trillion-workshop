// PORTED FROM: bitfield-packages/packages/chat/show/ChatHeroState.tsx @ e99ac5976
// bitfield-studio/frontends/web/src/packages/chat/ChatHeroState.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Hero welcome screen shown before any messages in a chat session. Centers a
// heading, the ChatInput, a config bar, and optional preset action buttons.
// Disappears once the first message is sent.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. configBar is passed as ReactNode; this component does not own config state
// 2. ChatInput is composed inline with glassmorphism container
// 3. The empty heading does not require a goal or claim work has started.
// 4. presetButtons is optional; renders below the input card when provided
// 5. The composer column matches the docked-conversation composer width
//    (max 768px), so the empty state is roomy and NOT narrower than the
//    transcript it becomes (the "squeezed card" the product owner flagged).
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React from 'react';
import type { ReactNode } from 'react';
import { ChatInput } from './ChatInput';
import { Card, Text, Container } from '../../ui';

// ---------------------------------------------------------------------------
// TYPES
// ---------------------------------------------------------------------------

export interface ChatHeroStateProps {
  /** Configuration bar rendered below the input (participant/model/account selectors). */
  configBar: ReactNode;
  draftScope?: string;
  /** Called when the user sends a message from the hero input */
  onSend: (content: string) => boolean | void | Promise<boolean | void>;
  /** Optional content rendered below the hero input card */
  belowInput?: ReactNode;
  /** A connect-your-AI affordance rendered directly under the composer card. */
  connectCallout?: ReactNode;
  /** Preset action buttons rendered below the card when provided */
  presetButtons?: ReactNode;
  /** External value to prefill into the chat input */
  prefillValue?: string;
  /** Called after prefill has been consumed */
  onPrefillConsumed?: () => void;
  /** Active preset that will augment the message */
  activePreset?: { label: string; prompt: string; description?: string } | null;
  /** Called when the user dismisses the active preset */
  onPresetDismiss?: () => void;
  /** Read-only chip for context attached to the next message (selected text). */
  selectedContext?: { label: string; excerpt?: string } | null;
}

// ---------------------------------------------------------------------------
// COMPONENT
// ---------------------------------------------------------------------------

export function ChatHeroState({ configBar, draftScope, onSend, belowInput, connectCallout, presetButtons, prefillValue, onPrefillConsumed, activePreset, onPresetDismiss, selectedContext }: ChatHeroStateProps) {
  return (
    <Container
      layout="vertical"
      flex={1}
      alignItems="center"
      justifyContent="center"
      padding="lg"
      data-reach-role="empty-state"
    >
      <Container layout="vertical" gap="lg" maxWidth="3xl" width="100%" alignItems="center">
        <Text variant="heading-xl">
          Your conversation
        </Text>
        <Container layout="vertical" gap="sm" width="100%">
          <Card variant="surface" padding="none">
            <ChatInput
              draftScope={draftScope}
              onSend={onSend}
              placeholder="Ask anything"
              footer={configBar}
              prefillValue={prefillValue}
              onPrefillConsumed={onPrefillConsumed}
              activePreset={activePreset}
              onPresetDismiss={onPresetDismiss}
              selectedContext={selectedContext}
            />
          </Card>
          {connectCallout}
        </Container>
        {belowInput}
        {presetButtons && <Container layout="horizontal" alignItems="center" justifyContent="center">{presetButtons}</Container>}
      </Container>
    </Container>
  );
}
