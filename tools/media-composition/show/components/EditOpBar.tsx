// packages/media-composition/show/components/EditOpBar.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The timeline's action bar — ONE button per available editing operation,
// rendered entirely from `edit-op` DATA descriptors. This is the surface-level
// deletion test: the bar names no operation. Add a `contract::edit-op` DATA row
// (mirrored in edit-capabilities) and a labeled button appears here with ZERO
// change to this file. Remove every op and drop in a foreign set — the bar
// still renders them.
//
// NON-NEGOTIABLE INVARIANTS
//   1. NO OP NAMES / NO `if(action===)`. It maps `ops` (DATA) → buttons and
//      calls back with the op's `action` string.
//   2. LABELS COME FROM DATA (`descriptor.label`) — never a literal here, so no
//      package vocabulary leaks (`edl` / `remove-span` never shown).
//   3. UI VIA SHARED PRIMITIVES ONLY (Container / Button / Text).
//
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import * as React from 'react';

import type { EditOpDescriptor } from '../../read-data/edit-capabilities';
import { Button } from '../../../ui/show/button';
import { Container } from '../../../ui/show/container';
import { Text } from '../../../ui/show/text';

export type EditOpBarProps = {
  /** The ops actionable from the current editor state (already filtered DATA). */
  ops: readonly EditOpDescriptor[];
  disabled?: boolean;
  /** Fired with the chosen op's `action` string. The panel resolves params. */
  onRunOp: (action: string) => void;
};

/**
 * Data-driven op action bar. Renders one button per descriptor; empty when no
 * op is actionable (e.g. no clip selected) — an honest hint, not a dead button.
 */
export function EditOpBar({ ops, disabled, onRunOp }: EditOpBarProps) {
  if (ops.length === 0) {
    return (
      <Container layout="horizontal" alignItems="center">
        <Text variant="caption" color="faint">Select a clip to edit it.</Text>
      </Container>
    );
  }

  return (
    <Container layout="horizontal" gap="sm" wrap alignItems="center">
      {ops.map((op) => (
        <Button
          key={op.action}
          variant="secondary"
          size="sm"
          disabled={disabled}
          onClick={() => onRunOp(op.action)}
        >
          {op.label}
        </Button>
      ))}
    </Container>
  );
}
