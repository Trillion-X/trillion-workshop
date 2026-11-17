// tools/ui/show/code-boxes/CodeBoxes.tsx
//
// =============================================================================
// PURPOSE — a one-time code entered in one box per digit.
// =============================================================================
//
// Every box has its own label (the caller words it), the first box carries
// autocomplete="one-time-code" so a phone offers the code from a message, and a
// paste (or an autofill that lands many digits in one box) fills all boxes. A
// hidden input named `name` carries the joined code in a form post. React is
// the only import, so it prerenders standalone with react-dom/server.

import React from 'react';

export interface CodeBoxesProps {
  /** Label for the whole group. */
  label: string;
  /** Label for one box, e.g. (1, 6) => "Digit 1 of 6". */
  digitLabel: (position: number, length: number) => string;
  /** Number of boxes. Default 6. */
  length?: number;
  /** Name of the hidden input that carries the joined code in a form post. */
  name?: string;
  disabled?: boolean;
  invalid?: boolean;
  /** Called on every change with the digits so far. */
  onChange?: (code: string) => void;
  /** Called once when every box is filled. */
  onComplete?: (code: string) => void;
}

function digitsOf(text: string, length: number): string {
  return text.replace(/\D/g, '').slice(0, length);
}

export function CodeBoxes({
  label,
  digitLabel,
  length = 6,
  name,
  disabled,
  invalid,
  onChange,
  onComplete,
}: CodeBoxesProps) {
  const [digits, setDigits] = React.useState<string>('');
  const refs = React.useRef<Array<HTMLInputElement | null>>([]);
  const groupId = React.useId();

  const commit = (next: string, focusAt: number) => {
    setDigits(next);
    onChange?.(next);
    if (next.length === length) onComplete?.(next);
    refs.current[Math.min(focusAt, length - 1)]?.focus();
  };

  const enter = (index: number, text: string) => {
    const typed = digitsOf(text, length - index);
    if (!typed) return;
    const next = (digits.slice(0, index) + typed + digits.slice(index + typed.length)).slice(0, length);
    commit(next, index + typed.length);
  };

  return (
    <div role="group" aria-labelledby={`${groupId}-label`} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <span id={`${groupId}-label`} style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>
        {label}
      </span>
      <div style={{ display: 'flex', gap: 8 }}>
        {Array.from({ length }, (_, index) => (
          <input
            key={index}
            ref={(element) => {
              refs.current[index] = element;
            }}
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            autoComplete={index === 0 ? 'one-time-code' : 'off'}
            aria-label={digitLabel(index + 1, length)}
            aria-invalid={invalid ? true : undefined}
            disabled={disabled}
            value={digits[index] ?? ''}
            onChange={(event) => enter(index, event.target.value)}
            onPaste={(event) => {
              event.preventDefault();
              enter(0, event.clipboardData.getData('text'));
            }}
            onFocus={(event) => event.target.select()}
            onKeyDown={(event) => {
              if (event.key === 'Backspace' && !digits[index] && index > 0) {
                event.preventDefault();
                commit(digits.slice(0, index - 1), index - 1);
              } else if (event.key === 'ArrowLeft' && index > 0) {
                refs.current[index - 1]?.focus();
              } else if (event.key === 'ArrowRight' && index < length - 1) {
                refs.current[index + 1]?.focus();
              }
            }}
            style={{
              width: 44,
              height: 52,
              textAlign: 'center',
              fontSize: 22,
              fontVariantNumeric: 'tabular-nums',
              color: 'var(--text-primary)',
              background: 'var(--glass-bg, transparent)',
              border: `1px solid ${invalid ? 'var(--status-error, var(--accent-red, #ef4444))' : 'var(--border-primary)'}`,
              borderRadius: 10,
            }}
          />
        ))}
      </div>
      {name ? <input type="hidden" name={name} value={digits} /> : null}
    </div>
  );
}

CodeBoxes.displayName = 'CodeBoxes';
