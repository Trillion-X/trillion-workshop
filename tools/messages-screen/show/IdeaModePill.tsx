// PORTED FROM: bitfield-packages/packages/chat/show/IdeaModePill.tsx @ e99ac5976
// frontends/web/src/packages/chat/IdeaModePill.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Pill toggle UI for switching between Chat, AI Work, and Idea input modes.
// Chat starts a live provider turn. AI Work saves an objective. Idea stores a
// project idea. This component only reports the selected mode; the owner that
// receives each mode is the caller's, and is never named here.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Uses only ui/ components (Button, Container, Icon)
// 2. Icons from lucide-react only
// 3. Pill styling via inline radius overrides (no className)
// 4. Active state driven by mode prop
// 5. Click handlers call onModeChange immediately
// 6. No raw HTML elements — no divs, spans, etc.
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React from 'react';
import { Bot, MessageSquare, Lightbulb, type LucideIcon } from 'lucide-react';
import { Button, Container, Icon } from '../../ui';

export type InputMode = 'chat' | 'ai-work' | 'idea';

export const INPUT_MODE_OPTIONS: readonly {
  mode: InputMode;
  label: string;
  icon: LucideIcon;
}[] = [
  { mode: 'chat', label: 'Chat', icon: MessageSquare },
  { mode: 'ai-work', label: 'AI Work', icon: Bot },
  { mode: 'idea', label: 'Idea', icon: Lightbulb },
];

export interface IdeaModePillProps {
  mode: InputMode;
  onModeChange: (mode: InputMode) => void;
}

export function IdeaModePill({ mode, onModeChange }: IdeaModePillProps) {
  return (
    <Container layout="horizontal" gap="none" alignItems="center">
      {INPUT_MODE_OPTIONS.map((option, index) => {
        const isFirst = index === 0;
        const isLast = index === INPUT_MODE_OPTIONS.length - 1;
        return (
          <Button
            key={option.mode}
            variant="ghost"
            size="sm"
            active={mode === option.mode}
            onClick={() => onModeChange(option.mode)}
            style={{
              borderTopLeftRadius: isFirst ? undefined : 0,
              borderBottomLeftRadius: isFirst ? undefined : 0,
              borderTopRightRadius: isLast ? undefined : 0,
              borderBottomRightRadius: isLast ? undefined : 0,
            }}
          >
            <Icon icon={option.icon} size="xs" />
            {option.label}
          </Button>
        );
      })}
    </Container>
  );
}
