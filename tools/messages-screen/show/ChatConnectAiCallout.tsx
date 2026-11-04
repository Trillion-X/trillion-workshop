// PORTED FROM: bitfield-packages/packages/chat/show/ChatConnectAiCallout.tsx @ e99ac5976
// bitfield-studio/frontends/web/src/packages/chat/show/ChatConnectAiCallout.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The discoverable participant-catalog affordance shown beneath the chat
// composer. A fresh catalog offers the first AI connection; an established
// catalog offers profile/person selection without pretending raw transports are
// still the visible identity.
//
// Reference anatomy (Package UI Reference Lock, Task #79):
//   1. Grok web "Connect your X account, Unlock early features" + Connect button
//      (a leading glyph, a two-line title/subtitle, a trailing accent CTA, sitting
//      just under the composer). Mobbin screen f53f0654-607c-45e6-8533-1babfb09a1e3.
//   2. LangChain/Fleet "Ask anything" GET STARTED entry (connect a provider is a
//      first-class, labeled call-to-action, not a hidden icon).
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Zero provider/model vocabulary here (L090). It never names a CLI, a cloud
//    vendor, or a model. It only offers the generic "connect an AI" action. The
//    first-run transport fallback lives in ParticipantBrowser / cli-registry DATA.
// 2. Composed from @/packages/ui primitives only. No raw markup, no className,
//    no inline styles (the L065/L066 firewall).
// 3. Two presentation intents from ONE component (L063): `prominent` when no
//    provider is connected yet (accent CTA that invites the first connection),
//    `quiet` when at least one exists (a low-key participant chooser). The
//    caller decides the intent from the presented participant count; this file has no
//    count logic of its own.
// 4. Copy is user language and answers "what can I do here?", never an internal
//    status the user cannot act on (L114/L169).
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React from 'react';
import { Plug, Sparkles, Users } from 'lucide-react';
import { Card, Container, Text, Icon, ActionControl } from '../../ui';

// ---------------------------------------------------------------------------
// PROPS
// ---------------------------------------------------------------------------

export interface ChatConnectAiCalloutProps {
  /**
   * `prominent`: no AI is connected yet, so an inviting accent card is the
   * obvious next step. `quiet`: at least one participant exists, so a subdued
   * chooser stays out of the way. The caller derives this from the live
   * presentation count (this component owns no count logic).
   */
  intent: 'prominent' | 'quiet';
  /** Opens the current profile, people, or first-run transport catalog. */
  onConnect: () => void;
}

// ---------------------------------------------------------------------------
// COMPONENT
// ---------------------------------------------------------------------------

export function ChatConnectAiCallout({ intent, onConnect }: ChatConnectAiCalloutProps) {
  if (intent === 'quiet') {
    // A single low-key control, no card chrome, so an established user gets a
    // truthful participant chooser rather than a repeated onboarding banner.
    return (
      <Container layout="horizontal" gap="xs" alignItems="center" justifyContent="center" padding="none">
        <ActionControl variant="ghost" size="sm" onClick={onConnect} aria-label="Choose participants">
          <Icon icon={Users} size="xs" color="muted" />
          Choose participants
        </ActionControl>
      </Container>
    );
  }

  // Prominent: the Grok-style connect card that is the obvious first move when no
  // AI is connected. Leading glyph, title + one-line subtitle, trailing CTA.
  return (
    <Card variant="nested" padding="sm" layout="row">
      <Icon icon={Sparkles} size="md" color="accent" />
      <Container layout="vertical" flex={1} gap="none" overflow="hidden">
        <Text variant="label" color="strong" truncate>
          Connect your AI
        </Text>
        <Text variant="body-xs" color="muted" truncate>
          Bring your CLI, a cloud key, or a local model to start getting work done.
        </Text>
      </Container>
      <ActionControl variant="accent" size="sm" onClick={onConnect} aria-label="Connect your AI">
        <Icon icon={Plug} size="xs" />
        Connect
      </ActionControl>
    </Card>
  );
}
