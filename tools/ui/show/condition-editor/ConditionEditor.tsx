// packages/ui/show/condition-editor/ConditionEditor.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The blind condition row: [field/path] [operator] [value], used by the
// "Show when …" affordance to author a node's conditional visibility. It knows
// NOTHING about visibility, bindings, or the engine — it edits a {path, op, value}
// triple and emits it. The operator list is DATA passed in (from the package's
// operator catalog), so a new operator is a data change, ZERO component code
// (L090). Reusable for any condition UI (visibility today; filters later).
//
// Reference anatomy (Mobbin MCP 2026-06-20): beehiiv subscriber-condition row
// (field · operator · "Set a value"), PandaDoc / HubSpot "Then: Show fields when
// <condition>", Vercel firewall rule, n8n IF operators. See CS-065 reference.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Generic / blind: no visibility/binding/engine knowledge; operators are data.
// 2. The value input is hidden when the chosen operator needs no value
//    (presence checks like "is empty"), driven by the passed operator metadata.
// 3. Emits the raw {path, op, value} on change; the consumer turns it into a
//    binding. Apply / Always-show (clear) are explicit callbacks.
//
// =============================================================================
// AI ASSISTANT DIRECTIVE
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

'use client';

import * as React from 'react';

import { Button } from '../button';
import { cn } from '../cn';

export type ConditionOperatorOption = {
  op: string;
  label: string;
  needsValue: boolean;
};

export type ConditionDraft = {
  path: string;
  op: string;
  value: string;
};

export type ConditionEditorProps = {
  /** The current draft (controlled). */
  draft: ConditionDraft;
  /** Operator options (data — the package's catalog). */
  operators: ReadonlyArray<ConditionOperatorOption>;
  /** Field label shown before the row (e.g. "Show when"). */
  prompt?: string;
  onChange: (next: ConditionDraft) => void;
  /** Commit the condition (bind visibility). */
  onApply: () => void;
  /** Remove the condition (always visible). */
  onClear: () => void;
  onClose?: () => void;
  /** Positioning style applied to the root (the consumer anchors the popover). */
  style?: React.CSSProperties;
};

function needsValue(operators: ReadonlyArray<ConditionOperatorOption>, op: string): boolean {
  const entry = operators.find((o) => o.op === op);
  return entry ? entry.needsValue : true;
}

export function ConditionEditor({ draft, operators, prompt = 'Show when', onChange, onApply, onClear, onClose, style }: ConditionEditorProps) {
  const showValue = needsValue(operators, draft.op);
  const canApply = draft.path.trim().length > 0 && draft.op.length > 0 && (!showValue || draft.value.length > 0);

  return (
    <div
      data-condition-editor
      style={style}
      className={cn(
        'flex w-[320px] flex-col gap-2 rounded-lg border p-3',
        'border-[var(--border-primary)] bg-[var(--surface-primary)] shadow-md',
      )}
    >
      <div className="flex items-center justify-between">
        <span className="text-[length:var(--font-size-caption)] font-medium text-[var(--text-secondary,var(--text-primary))]">{prompt}</span>
        {onClose ? (
          <button data-condition-close aria-label="Close" onClick={onClose} className="text-[var(--text-secondary,var(--text-primary))] hover:text-[var(--text-primary)]">
            ×
          </button>
        ) : null}
      </div>

      <input
        data-condition-path
        aria-label="Field"
        placeholder="field (e.g. cart.count)"
        value={draft.path}
        onChange={(event) => onChange({ ...draft, path: event.target.value })}
        className="w-full rounded-md border border-[var(--border-primary)] bg-[var(--surface-secondary,transparent)] px-2 py-1 text-[13px] text-[var(--text-primary)] outline-none focus:border-[var(--border-focus,var(--border-primary))]"
      />

      <div className="flex items-center gap-2">
        <select
          data-condition-op
          aria-label="Operator"
          value={draft.op}
          onChange={(event) => onChange({ ...draft, op: event.target.value })}
          className="flex-1 rounded-md border border-[var(--border-primary)] bg-[var(--surface-secondary,transparent)] px-2 py-1 text-[13px] text-[var(--text-primary)] outline-none"
        >
          {operators.map((option) => (
            <option key={option.op} value={option.op}>
              {option.label}
            </option>
          ))}
        </select>
        {showValue ? (
          <input
            data-condition-value
            aria-label="Value"
            placeholder="value"
            value={draft.value}
            onChange={(event) => onChange({ ...draft, value: event.target.value })}
            className="w-[110px] rounded-md border border-[var(--border-primary)] bg-[var(--surface-secondary,transparent)] px-2 py-1 text-[13px] text-[var(--text-primary)] outline-none focus:border-[var(--border-focus,var(--border-primary))]"
          />
        ) : null}
      </div>

      <div className="mt-1 flex items-center justify-between">
        <button data-condition-clear onClick={onClear} className="text-[12px] text-[var(--text-secondary,var(--text-primary))] hover:text-[var(--text-primary)]">
          Always show
        </button>
        <Button data-condition-apply variant="primary" size="sm" onClick={onApply} disabled={!canApply}>
          Apply
        </Button>
      </div>
    </div>
  );
}
