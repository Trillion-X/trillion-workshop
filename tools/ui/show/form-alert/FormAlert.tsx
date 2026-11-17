// tools/ui/show/form-alert/FormAlert.tsx
//
// =============================================================================
// PURPOSE — an inline error block for a form: an icon, a title, one line, and
// an optional next action. Blind to its words: the caller passes every string.
// =============================================================================
//
// Renders standalone with react-dom/server (React is its only import), so a
// page prerendered outside the app shell shows it unchanged. Colours are Screen
// Look tokens at body size; the action is a real button that takes focus when
// the alert appears, so the person who just failed lands on the way forward.

import React from 'react';

export interface FormAlertAction {
  readonly label: string;
  readonly onAction: () => void;
}

export interface FormAlertProps {
  /** What went wrong, in a few words. */
  title: string;
  /** One line that says what to do or why. */
  message?: string;
  /** The next step. Rendered as a button that receives focus on mount. */
  action?: FormAlertAction;
}

const DANGER = 'var(--status-error, var(--accent-red, #ef4444))';

export function FormAlert({ title, message, action }: FormAlertProps) {
  const actionRef = React.useRef<HTMLButtonElement>(null);
  React.useEffect(() => {
    actionRef.current?.focus();
  }, []);
  return (
    <div
      role="alert"
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 10,
        padding: '12px 14px',
        borderRadius: 10,
        border: `1px solid ${DANGER}`,
        background: 'color-mix(in srgb, var(--status-error, var(--accent-red, #ef4444)) 10%, transparent)',
        fontSize: 14,
        lineHeight: 1.45,
        color: 'var(--text-primary)',
      }}
    >
      <svg
        aria-hidden="true"
        focusable="false"
        width={18}
        height={18}
        viewBox="0 0 24 24"
        fill="none"
        stroke={DANGER}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{ flexShrink: 0, marginTop: 1 }}
      >
        <circle cx={12} cy={12} r={10} />
        <line x1={12} y1={8} x2={12} y2={12} />
        <line x1={12} y1={16} x2={12.01} y2={16} />
      </svg>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
        <strong style={{ fontWeight: 600 }}>{title}</strong>
        {message ? <span style={{ color: 'var(--text-secondary)' }}>{message}</span> : null}
        {action ? (
          <button
            ref={actionRef}
            type="button"
            onClick={action.onAction}
            style={{
              alignSelf: 'flex-start',
              marginTop: 4,
              padding: 0,
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              font: 'inherit',
              fontWeight: 600,
              color: 'var(--text-primary)',
              textDecoration: 'underline',
              textUnderlineOffset: 2,
            }}
          >
            {action.label}
          </button>
        ) : null}
      </div>
    </div>
  );
}

FormAlert.displayName = 'FormAlert';
