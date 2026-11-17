// tools/ui/show/password-field/PasswordField.tsx
//
// =============================================================================
// PURPOSE — a password input with a show/hide toggle and an optional
// "Forgot password?" link slot. Blind to its words: label, toggle names and
// link text all come in as props.
// =============================================================================
//
// The toggle is a real button with an accessible name that says what pressing
// it does, and `aria-pressed` that says whether the password is visible. React
// is the only import, so it prerenders standalone with react-dom/server.

import React from 'react';

export interface PasswordFieldProps {
  label: string;
  /** Accessible name of the toggle while the password is hidden, e.g. "Show password". */
  showLabel: string;
  /** Accessible name of the toggle while the password is visible, e.g. "Hide password". */
  hideLabel: string;
  id?: string;
  name?: string;
  value?: string;
  /** "current-password" to sign in, "new-password" to choose one. Default "current-password". */
  autoComplete?: 'current-password' | 'new-password';
  required?: boolean;
  disabled?: boolean;
  /** Error line under the field; marks the input invalid. */
  error?: string;
  onChange?: (value: string) => void;
  /** Optional "Forgot password?" link shown beside the label. */
  forgot?: { readonly label: string; readonly href: string };
}

export function PasswordField({
  label,
  showLabel,
  hideLabel,
  id,
  name,
  value,
  autoComplete = 'current-password',
  required,
  disabled,
  error,
  onChange,
  forgot,
}: PasswordFieldProps) {
  const generatedId = React.useId();
  const inputId = id ?? generatedId;
  const errorId = `${inputId}-error`;
  const [visible, setVisible] = React.useState(false);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
        <label htmlFor={inputId} style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>
          {label}
        </label>
        {forgot ? (
          <a href={forgot.href} style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
            {forgot.label}
          </a>
        ) : null}
      </div>
      <div style={{ position: 'relative' }}>
        <input
          id={inputId}
          name={name}
          type={visible ? 'text' : 'password'}
          autoComplete={autoComplete}
          required={required}
          disabled={disabled}
          value={value}
          onChange={onChange ? (event) => onChange(event.target.value) : undefined}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          style={{
            width: '100%',
            boxSizing: 'border-box',
            height: 40,
            padding: '0 44px 0 12px',
            fontSize: 14,
            color: 'var(--text-primary)',
            background: 'var(--glass-bg, transparent)',
            border: `1px solid ${error ? 'var(--status-error, var(--accent-red, #ef4444))' : 'var(--border-primary)'}`,
            borderRadius: 10,
          }}
        />
        <button
          type="button"
          aria-label={visible ? hideLabel : showLabel}
          aria-pressed={visible}
          onClick={() => setVisible((shown) => !shown)}
          style={{
            position: 'absolute',
            top: 0,
            right: 0,
            width: 40,
            height: 40,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            color: 'var(--text-secondary)',
          }}
        >
          <svg
            aria-hidden="true"
            focusable="false"
            width={18}
            height={18}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
            <circle cx={12} cy={12} r={3} />
            {visible ? <line x1={3} y1={3} x2={21} y2={21} /> : null}
          </svg>
        </button>
      </div>
      {error ? (
        <span id={errorId} style={{ fontSize: 13, color: 'var(--status-error, var(--accent-red, #ef4444))' }}>
          {error}
        </span>
      ) : null}
    </div>
  );
}

PasswordField.displayName = 'PasswordField';
