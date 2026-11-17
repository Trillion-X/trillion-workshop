// tools/ui/show/divider/LabeledDivider.tsx
//
// =============================================================================
// PURPOSE — a horizontal rule with optional centred text ("or"), for splitting
// one way of signing in from another. The text comes in as a prop. React is the
// only import, so it prerenders standalone with react-dom/server.
// =============================================================================

import React from 'react';

export interface LabeledDividerProps {
  /** Text centred on the rule. Absent: a plain rule. */
  text?: string;
}

const RULE: React.CSSProperties = { flex: 1, height: 1, background: 'var(--border-primary)' };

export function LabeledDivider({ text }: LabeledDividerProps) {
  if (!text) return <div role="separator" style={{ ...RULE, flex: 'none', width: '100%' }} />;
  return (
    <div role="separator" style={{ display: 'flex', alignItems: 'center', gap: 12, width: '100%' }}>
      <span aria-hidden="true" style={RULE} />
      <span style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>{text}</span>
      <span aria-hidden="true" style={RULE} />
    </div>
  );
}

LabeledDivider.displayName = 'LabeledDivider';
