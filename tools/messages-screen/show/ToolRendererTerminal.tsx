// PORTED FROM: bitfield-packages/packages/chat/show/ToolRendererTerminal.tsx @ e99ac5976
// frontends/web/src/packages/chat/show/ToolRendererTerminal.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Renders Bash tool results with terminal-style styling. Shows the command
// from params as a header, then displays the result output in a green-tinted
// pre block to evoke terminal output appearance.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Command extracted from params.command shown in header
// 2. Result output in green-tinted block (emerald palette)
// 3. Scrollable for long outputs — max-h-48 with overflow-y-auto
// 4. Terminal aesthetic via color scheme
// 5. No command execution — pure display of previous result
// 6. ZERO raw HTML (div/span/p) — all through ui/ components
// 7. ZERO className strings — all through component props
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React from 'react';
import type { ToolUseInfo } from '../read-data/chat-message-types';
import { Card, Text, Container } from '../../ui';

// ---------------------------------------------------------------------------
// TYPES
// ---------------------------------------------------------------------------

export interface ToolRendererTerminalProps {
  toolUse: ToolUseInfo;
}

// ---------------------------------------------------------------------------
// COMPONENT
// ---------------------------------------------------------------------------

export function ToolRendererTerminal({ toolUse }: ToolRendererTerminalProps) {
  const command = String(toolUse.params.command ?? '');
  const result = String(toolUse.result ?? '');

  return (
    <Container layout="vertical" gap="xs">
      {/* Command header */}
      {command && (
        <Text variant="label" color="success">
          $ {command}
        </Text>
      )}

      {/* Terminal output block — green-tinted for terminal aesthetic */}
      <Card variant="nested" padding="sm">
        <Text
          variant="body-xs"
          color="success"
          mono
          as="pre"
          wrap="preserve"
        >
          {result}
        </Text>
      </Card>
    </Container>
  );
}
